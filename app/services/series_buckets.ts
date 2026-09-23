import { FIVE_MIN_ROLLUP_SECONDS, HOURLY_ROLLUP_SECONDS } from '#services/rollup_tiers'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Dense, rate-accurate time series for one name's traffic chart (services on
 * the Servers page, destinations). Shared by `service_history.ts` and
 * `destination_history.ts`.
 *
 * The bucket tables only hold rows for polls / slots / hours that moved
 * bytes. Charting those rows directly bridged every quiet period with a line
 * and squeezed the time axis. Here the read picks one bucket width, reads the
 * sums per bucket, and returns **every** bucket of the window, empty ones as
 * zero, each with the seconds it really covers so a rate is
 * bytes × 8 ÷ seconds even for the partial first and last bucket.
 *
 * Width: the smallest step of `SERIES_WIDTH_LADDER` that is at least the
 * admin floor (Settings → Charts, default 15 s), keeps the series within the
 * point cap (default 1500), and is a whole multiple of the grain of a stored
 * tier that covers the window. The floor therefore only bites where per-poll
 * rows exist (native, `BUCKET_RETENTION_DAYS`); older windows fall to the
 * 5-minute or hourly tier at their own grain. Among the tiers that can serve
 * the width the coarsest is read (fewest rows), like `pickSeriesTier`.
 */

/** Which stored table a series was read from. */
export type SeriesSource = 'native' | '5m' | '1h'

export type SeriesTier = {
  source: SeriesSource
  /** Seconds one stored row covers (native: the poll interval). */
  grainSeconds: number
  table: string
  timeColumn: string
  /**
   * Widest bucket this tier serves. The per-poll table only serves buckets
   * finer than 5 minutes (windows up to ~2 days at the default cap); from
   * 5 minutes up the rollups answer, as `pickSeriesTier` does for devices.
   */
  maxBucketSeconds?: number
}

/** A tier and whether it holds rows back to the window's start. */
export type SeriesTierCandidate = SeriesTier & { covers: boolean }

/** Bucket widths a chart may use, finest first (the floor is added to it). */
export const SERIES_WIDTH_LADDER: readonly number[] = [
  5,
  10,
  15,
  20,
  30,
  60,
  120,
  FIVE_MIN_ROLLUP_SECONDS,
  600,
  900,
  1800,
  HOURLY_ROLLUP_SECONDS,
  7200,
  10_800,
  21_600,
  43_200,
  86_400,
  2 * 86_400,
  7 * 86_400,
]

export type SeriesPlan = {
  tier: SeriesTier
  bucketSeconds: number
  /** First second with data in the window (window start, up to the tier grain). */
  effSinceSec: number
  /** End of the data: the window end up to the tier grain, never past now. */
  effUntilSec: number
  firstIndex: number
  /** Inclusive; `lastIndex < firstIndex` = empty series (window in the future). */
  lastIndex: number
}

export type DenseBucket = {
  bucketStart: string
  bucketEnd: string
  /** Seconds of this bucket inside the window and not in the future. */
  seconds: number
  a: number
  b: number
}

function ceilTo(sec: number, grain: number): number {
  return Math.ceil(sec / grain) * grain
}

/** Buckets of width `w` between `sinceSec` (inclusive) and `untilSec` (exclusive). */
function bucketCount(sinceSec: number, untilSec: number, w: number): number {
  if (untilSec <= sinceSec) return 0
  return Math.floor((untilSec - 1) / w) - Math.floor(sinceSec / w) + 1
}

function planFor(
  tier: SeriesTier,
  w: number,
  sinceSec: number,
  untilSec: number,
  nowSec: number
): SeriesPlan {
  const effSinceSec = ceilTo(sinceSec, tier.grainSeconds)
  const effUntilSec = Math.min(ceilTo(untilSec, tier.grainSeconds), nowSec)
  const firstIndex = Math.floor(effSinceSec / w)
  const lastIndex = effUntilSec > effSinceSec ? Math.floor((effUntilSec - 1) / w) : firstIndex - 1
  return { tier, bucketSeconds: w, effSinceSec, effUntilSec, firstIndex, lastIndex }
}

/**
 * Choose the tier and bucket width for a window. `tiers` are finest first;
 * the last one is the fallback that always serves (the long-lived hourly
 * table). Pure, for tests.
 */
export function planSeries(opts: {
  sinceSec: number
  untilSec: number
  nowSec: number
  floorSeconds: number
  maxPoints: number
  /** The caller's finest acceptable width (`resolution=`), if any. */
  requestedSeconds?: number
  tiers: readonly SeriesTierCandidate[]
}): SeriesPlan {
  const { sinceSec, untilSec, nowSec, maxPoints, tiers } = opts
  const fallback = tiers[tiers.length - 1]
  const minWidth = Math.max(1, opts.floorSeconds, opts.requestedSeconds ?? 0)
  const widths = [...new Set([...SERIES_WIDTH_LADDER, minWidth])]
    .filter((w) => w >= minWidth)
    .sort((a, b) => a - b)

  for (const w of widths) {
    if (bucketCount(sinceSec, untilSec, w) > maxPoints) continue
    // Coarsest covering tier whose rows fit whole into a bucket of width w;
    // the fallback (last) tier always counts as covering.
    for (let i = tiers.length - 1; i >= 0; i -= 1) {
      const tier = tiers[i]
      if (w % tier.grainSeconds !== 0) continue
      if (tier.maxBucketSeconds !== undefined && w > tier.maxBucketSeconds) continue
      if (!tier.covers && i !== tiers.length - 1) continue
      return planFor(tier, w, sinceSec, untilSec, nowSec)
    }
  }

  // Nothing fits (an absurd window): the fallback tier at the widest step,
  // or wider still so the cap holds.
  let w = Math.max(minWidth, SERIES_WIDTH_LADDER[SERIES_WIDTH_LADDER.length - 1])
  w = ceilTo(w, fallback.grainSeconds)
  while (bucketCount(sinceSec, untilSec, w) > maxPoints) w *= 2
  return planFor(fallback, w, sinceSec, untilSec, nowSec)
}

/**
 * Every bucket of the plan, the rows' sums where the query found any and zero
 * elsewhere. Rows are keyed by bucket index (`epoch seconds DIV width`).
 */
export function denseBuckets(
  plan: SeriesPlan,
  rows: ReadonlyMap<number, readonly [number, number]>
): DenseBucket[] {
  const w = plan.bucketSeconds
  const out: DenseBucket[] = []
  for (let i = plan.firstIndex; i <= plan.lastIndex; i += 1) {
    const start = i * w
    const end = start + w
    const seconds = Math.min(end, plan.effUntilSec) - Math.max(start, plan.effSinceSec)
    const sums = rows.get(i)
    out.push({
      bucketStart: DateTime.fromSeconds(start, { zone: 'utc' }).toISO()!,
      bucketEnd: DateTime.fromSeconds(end, { zone: 'utc' }).toISO()!,
      seconds: Math.max(1, seconds),
      a: sums?.[0] ?? 0,
      b: sums?.[1] ?? 0,
    })
  }
  return out
}

/** `15s`, `1m`, `5m`, `1h`, `1d`, `7d`: the label of a bucket width. */
export function bucketLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** `15s` → 15. Labels come from the validator, so a bad one is a programming error. */
export function parseBucketLabel(label: string): number {
  const m = /^(\d+)([smhd])$/.exec(label)
  if (!m) throw new Error(`series_buckets: bad bucket label "${label}"`)
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 }
  return Number(m[1]) * unit[m[2]]
}

/** Resolution label for `windowCache`'s TTL: finer charts refresh sooner. */
export function cacheResolutionFor(bucketSeconds: number): string | null {
  if (bucketSeconds < 60) return '15s'
  if (bucketSeconds < FIVE_MIN_ROLLUP_SECONDS) return '1m'
  if (bucketSeconds < HOURLY_ROLLUP_SECONDS) return '5m'
  return null
}

/** A guess of the width before the plan exists, for the cache TTL only. */
export function estimateBucketSeconds(
  spanSeconds: number,
  floorSeconds: number,
  maxPoints: number
): number {
  return Math.max(floorSeconds, spanSeconds / Math.max(1, maxPoints))
}

// ── coverage ─────────────────────────────────────────────────────────────

/** How long an oldest-row lookup is reused; the answer only moves with retention. */
const COVERAGE_TTL_MS = 60_000
/** One entry per tier table: a handful, bounded by the callers' fixed table lists. */
const coverageCache = new Map<string, { oldestSec: number | null; expiresAt: number }>()
const COVERAGE_MAX_ENTRIES = 16

/** Test hook. */
export function _resetSeriesCoverage(): void {
  coverageCache.clear()
}

async function oldestRowSec(table: string, timeColumn: string): Promise<number | null> {
  const now = Date.now()
  const key = `${table}.${timeColumn}`
  const hit = coverageCache.get(key)
  if (hit && hit.expiresAt > now) return hit.oldestSec
  // Tables and columns are code constants, never request input. The
  // TIMESTAMPDIFF keeps it free of the session / process time zone.
  const result = await db.rawQuery(
    `SELECT TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', MIN(${timeColumn})) AS oldest FROM ${table}`
  )
  const row = rawRows<{ oldest: number | string | null }>(result)[0]
  const oldestSec = row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest)
  if (coverageCache.size >= COVERAGE_MAX_ENTRIES) coverageCache.clear()
  coverageCache.set(key, { oldestSec, expiresAt: now + COVERAGE_TTL_MS })
  return oldestSec
}

/**
 * Whether each tier holds rows back to the start of the window, judged by
 * its oldest row (retention and a table's first write both show there). A
 * tier covers when its oldest row is at or before the window start, or when
 * it started together with all history (within one grain of the fallback's
 * oldest row: a fresh install, where every tier begins at once). So after
 * the release that added the per-poll table, that table only serves windows
 * that start after its first row, and an older window falls to the 5-minute
 * or hourly detail. An empty tier covers only while the fallback is empty too.
 */
export async function tierCoverage(
  tiers: readonly SeriesTier[],
  sinceSec: number
): Promise<SeriesTierCandidate[]> {
  const oldest = await Promise.all(tiers.map((t) => oldestRowSec(t.table, t.timeColumn)))
  const fallback = tiers[tiers.length - 1]
  const historyStart = oldest[oldest.length - 1]
  return tiers.map((tier, i) => {
    const own = oldest[i]
    let covers: boolean
    if (own === null) covers = historyStart === null
    else if (own <= sinceSec + Math.max(tier.grainSeconds, 60)) covers = true
    else covers = historyStart !== null && own <= historyStart + fallback.grainSeconds
    return { ...tier, covers }
  })
}

// ── query ────────────────────────────────────────────────────────────────

/**
 * Sums of two columns per bucket of the plan, keyed by bucket index. `where`
 * holds extra predicates on alias `t` (name, collector) with their bindings;
 * the time range is added here. Group key is `epoch seconds DIV width`
 * computed with TIMESTAMPDIFF, which does not depend on any time zone.
 */
export async function querySeriesSums(opts: {
  plan: SeriesPlan
  sinceSql: string
  untilSql: string
  columns: readonly [string, string]
  where: readonly string[]
  bindings: ReadonlyArray<string | number>
}): Promise<Map<number, [number, number]>> {
  const { plan } = opts
  const col = `t.${plan.tier.timeColumn}`
  const rows = rawRows<{
    idx: number | string
    a: bigint | number | string | null
    b: bigint | number | string | null
  }>(
    await db.rawQuery(
      `
      SELECT
        TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', ${col}) DIV ? AS idx,
        SUM(t.${opts.columns[0]}) AS a,
        SUM(t.${opts.columns[1]}) AS b
      FROM ${plan.tier.table} t
      WHERE ${[...opts.where, `${col} >= ?`, `${col} < ?`].join(' AND ')}
      GROUP BY idx
    `,
      [plan.bucketSeconds, ...opts.bindings, opts.sinceSql, opts.untilSql]
    )
  )
  const out = new Map<number, [number, number]>()
  for (const row of rows) out.set(Number(row.idx), [num(row.a), num(row.b)])
  return out
}

/** Megabits per second over a bucket's real seconds. */
export function mbps(bytes: number, seconds: number): number {
  return seconds > 0 ? (bytes * 8) / seconds / 1_000_000 : 0
}

function num(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}
