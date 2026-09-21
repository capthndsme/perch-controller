import type { CollectorStatus } from '#models/collector'

/**
 * Default upper bound on the probe. 5 s is plenty for a healthy localhost
 * collector (typical RTT is sub-10 ms) and short enough that a slow remote
 * doesn't lock the wizard UI for too long.
 */
const DEFAULT_TIMEOUT_MS = 5000

export type ProbeOptions = {
  apiKey?: string | null
  timeoutMs?: number
  /**
   * Injection seam for tests: pass a stub `fetch` to avoid hitting the
   * network. Defaults to the global `fetch`.
   */
  fetcher?: typeof fetch
}

/**
 * Calls `GET ${baseUrl}/api/v1/summary` on the collector and translates
 * the response into a `CollectorStatus` row. Never throws — failures are
 * reported as `{ ok: false, error }` so the caller can persist them as the
 * last-known status without extra try/catch ceremony.
 */
export async function probeCollector(
  baseUrl: string,
  options: ProbeOptions = {}
): Promise<CollectorStatus> {
  const { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetcher = fetch } = options
  const checkedAt = new Date().toISOString()
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/summary`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()

  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const res = await fetcher(url, { headers, signal: controller.signal })
    const latencyMs = Math.round(performance.now() - start)

    if (!res.ok) {
      return {
        ok: false,
        checkedAt,
        latencyMs,
        error: `HTTP ${res.status} ${res.statusText}`.trim(),
      }
    }

    const body = (await res.json()) as {
      summary?: { total_devices?: number }
      meta?: { capture_interface?: string; version?: string }
    }

    return {
      ok: true,
      checkedAt,
      latencyMs,
      totalDevices: body.summary?.total_devices,
      captureInterface: body.meta?.capture_interface,
      // Present on collectors built after the announce release; lets
      // create/adopt fill `collectors.version` without an announce.
      version: body.meta?.version,
    }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start)
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : err.message
        : String(err)
    return { ok: false, checkedAt, latencyMs, error: message }
  } finally {
    clearTimeout(timer)
  }
}
