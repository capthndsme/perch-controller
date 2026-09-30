import { alertNow } from '#services/alerts/clock'
import { getAlertsSettings, heartbeatUrl } from '#services/alerts/settings'
import logger from '@adonisjs/core/services/logger'

/**
 * The heartbeat URL (README section 0.9, events.md section 3.10): with
 * `heartbeat.url` set the controller GETs it every `intervalSeconds` (10 s
 * timeout, no redirects followed) so an outside watcher (an Uptime Kuma push
 * monitor, healthchecks) notices when the pings stop. Not an event type; the
 * settings page shows the last result (`heartbeatStatus()`). The URL is a
 * secret (it carries the watcher's token): it is never logged.
 */

export const PING_TIMEOUT_MS = 10_000
const RETRY_WITHOUT_SETTINGS_MS = 60_000

export type HeartbeatStatus = {
  configured: boolean
  lastPingAt: string | null
  lastOkAt: string | null
  lastStatus: number | null
  lastError: string | null
}

let status: HeartbeatStatus = {
  configured: false,
  lastPingAt: null,
  lastOkAt: null,
  lastStatus: null,
  lastError: null,
}
let timer: NodeJS.Timeout | null = null
let stopped = true

export function heartbeatStatus(): HeartbeatStatus {
  return { ...status }
}

type FetchFn = typeof fetch

/** One ping. Never throws: the outcome is returned and kept for the settings page. */
export async function pingHeartbeat(
  url: string,
  fetchImpl: FetchFn = fetch
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const at = alertNow().toISO()
  let outcome: { ok: boolean; status: number | null; error: string | null }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      headers: { 'user-agent': 'Perch-Controller heartbeat' },
    })
    await response.body?.cancel().catch(() => {})
    const ok = response.status >= 200 && response.status < 300
    outcome = { ok, status: response.status, error: ok ? null : `HTTP ${response.status}` }
  } catch (err) {
    const name = (err as Error)?.name
    outcome = {
      ok: false,
      status: null,
      error:
        name === 'TimeoutError' ? 'timeout' : ((err as Error)?.message ?? 'error').slice(0, 200),
    }
  }
  status = {
    configured: true,
    lastPingAt: at,
    lastOkAt: outcome.ok ? at : status.lastOkAt,
    lastStatus: outcome.status,
    lastError: outcome.error,
  }
  return outcome
}

async function loop(): Promise<void> {
  if (stopped) return
  let delay = RETRY_WITHOUT_SETTINGS_MS
  try {
    const settings = await getAlertsSettings()
    delay = settings.heartbeat.intervalSeconds * 1000
    const url = heartbeatUrl(settings)
    if (url) {
      const outcome = await pingHeartbeat(url)
      if (!outcome.ok) logger.warn({ error: outcome.error }, 'alerts heartbeat: ping failed')
    } else {
      status = { ...status, configured: false }
    }
  } catch (err) {
    logger.warn({ err }, 'alerts heartbeat: settings unreadable')
  }
  if (stopped) return
  timer = setTimeout(() => void loop(), delay)
  timer.unref()
}

export function startHeartbeatPinger(): void {
  if (!stopped) return
  stopped = false
  void loop()
}

export function stopHeartbeatPinger(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}

/** Tests only. */
export function _resetHeartbeat(): void {
  stopHeartbeatPinger()
  status = {
    configured: false,
    lastPingAt: null,
    lastOkAt: null,
    lastStatus: null,
    lastError: null,
  }
}
