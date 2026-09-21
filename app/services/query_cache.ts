/**
 * In-memory query cache with in-flight request deduplication.
 *
 * Short TTLs keyed off chart resolution — see `cacheTtlForResolution`.
 * State is lost on process restart, which is fine: this is a load shedder
 * for duplicate dashboard refreshes, not a source of truth.
 */

type CacheEntry = {
  value: unknown
  expiresAt: number
}

/** Resolved entries and promises for keys still being fetched. */
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<unknown>>()

/**
 * TTL for cached query results, scaled to the requested chart resolution.
 * Finer resolutions get shorter TTLs so live charts stay fresh.
 */
export function cacheTtlForResolution(resolution?: string | null): number {
  switch (resolution) {
    case '15s':
      return 10_000
    case '1m':
      return 15_000
    case '5m':
      return 20_000
    default:
      return 30_000
  }
}

/**
 * Stable cache-key segment from a colon-delimited list of parts.
 * `null`/`undefined` become empty strings so callers can skip guards.
 */
export function cacheKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => String(part ?? '')).join(':')
}

/**
 * Time-window segment for cache keys. Relative windows bucket `until`
 * to the TTL so concurrent dashboard polls share one entry; absolute
 * windows with the same duration and bucket coalesce the same way.
 */
export function windowSegment(
  since: { toMillis(): number; toSeconds(): number },
  until: { toMillis(): number; toSeconds(): number },
  ttlMs: number
): string {
  const rangeSec = Math.round(until.toSeconds() - since.toSeconds())
  const bucket = Math.floor(until.toMillis() / ttlMs)
  return `${bucket}:${rangeSec}`
}

/**
 * A window whose `until` is more than this far in the past is treated as
 * immutable: every bucket inside it has already closed, so no future poll
 * can change the result. The grace covers the still-filling trailing bucket
 * and minor clock skew between the API and DB.
 */
const IMMUTABLE_GRACE_MS = 2 * 60_000

/** Long TTL granted to immutable (historical) windows — they never change. */
const IMMUTABLE_TTL_MS = 6 * 60 * 60_000

/**
 * Resolve both the cache TTL and the window cache-key segment together,
 * because the two are coupled and get subtly wrong if set independently.
 *
 *   - Live windows (relative `range`, `until` ≈ now): short, resolution-scaled
 *     TTL with `until` bucketed to that TTL so polls a few seconds apart
 *     coalesce onto one entry — exactly the `windowSegment` behaviour.
 *   - Immutable windows (`until` well in the past, e.g. a Grafana drag-zoom):
 *     a 6 h TTL so repeated views are free, but the segment buckets `until`
 *     at a fixed 1 s grain instead of the TTL — otherwise two distinct
 *     historical windows less than a TTL apart would collide on one key.
 */
export function windowCache(
  resolution: string | null | undefined,
  since: { toMillis(): number; toSeconds(): number },
  until: { toMillis(): number; toSeconds(): number },
  nowMs: number
): { ttlMs: number; segment: string } {
  if (nowMs - until.toMillis() > IMMUTABLE_GRACE_MS) {
    const rangeSec = Math.round(until.toSeconds() - since.toSeconds())
    return {
      ttlMs: IMMUTABLE_TTL_MS,
      segment: `${Math.floor(until.toMillis() / 1000)}:${rangeSec}`,
    }
  }
  const ttlMs = cacheTtlForResolution(resolution)
  return { ttlMs, segment: windowSegment(since, until, ttlMs) }
}

/**
 * Return a cached value or run `fn`, deduplicating concurrent callers
 * for the same key. Errors are not cached.
 */
export async function cachedQuery<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) {
    return hit.value as T
  }

  if (hit && hit.expiresAt <= now) {
    cache.delete(key)
  }

  const pending = inFlight.get(key)
  if (pending) {
    return pending as Promise<T>
  }

  const promise = fn()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs })
      inFlight.delete(key)
      return value
    })
    .catch((err) => {
      inFlight.delete(key)
      throw err
    })

  inFlight.set(key, promise)
  return promise
}

/** Test-only: wipe cache and in-flight dedupe map between specs. */
export function _resetQueryCache() {
  cache.clear()
  inFlight.clear()
}
