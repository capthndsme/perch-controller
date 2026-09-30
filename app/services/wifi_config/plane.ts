import ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import { sendAgentConfigure } from '#services/ap_agent_metrics'
import type { RouterAuthor } from '#services/gateway_config/types'
import {
  ApOfflineError,
  fetchApCapabilities,
  parseHealth,
  readAndReconcileAp,
} from '#services/wifi_config/agent'
import { emitWifiAlert, recordApEvent } from '#services/wifi_config/events'
import {
  applyApResult,
  onApAgentReconnected,
  onApPushAccepted as confirmOnPush,
} from '#services/wifi_config/lifecycle'
import {
  apSession,
  clearConfigureBlock,
  ensureApConfig,
  forgetApSession,
  normalizeApMode,
  parseApResult,
  parseWifiConfigBlock,
  rememberApSession,
  setConfigureBlock,
  WIFI_CONFIG_CAPABILITY,
} from '#services/wifi_config/registry'
import { fleetKey } from '#services/wifi_config/secrets'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import { apConfigQueue, scheduleFleetWork } from '#services/wifi_config/store'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The Wi-Fi plane's hooks into the AP socket (docs/design/wifi
 * controller.md section 4.1), one line each in `ap_agent_gateway.ts` and
 * `ap_agent_metrics.ts`:
 *
 * - `onSystemInfo` after every `system.info` (the plane's hello): the
 *   session context, the row, `agent.configure` with the plane's block;
 *   then, in the AP's queue, unacked results, the fresh session of a
 *   pending job, capabilities, a read when the hashes moved, and a catch-up
 *   of missed changes;
 * - the notifications `wifi.config.changed`, `wifi.config.result`,
 *   `wifi.health.changed`;
 * - every accepted `metrics.push` (the agent half of a confirm).
 *
 * Nothing here throws into the socket code: failures are logged.
 */

/** `system.info` answered: the plane's hello (before device groups' sync). */
export async function onSystemInfo(apId: number, info: Record<string, unknown>): Promise<void> {
  try {
    const live = hub.session(apId)
    if (!live) return
    const capabilities = Array.isArray(info.capabilities)
      ? info.capabilities.filter((c): c is string => typeof c === 'string')
      : []
    const block = capabilities.includes(WIFI_CONFIG_CAPABILITY)
      ? parseWifiConfigBlock(info.wifiConfig)
      : null
    rememberApSession(apId, block, {
      connectedAt: live.connectedAt,
      secure: live.secure,
      capabilities,
      agentVersion: typeof info.agentVersion === 'string' ? info.agentVersion.slice(0, 32) : null,
    })
    if (!block) {
      // An agent without the plane: nothing to configure (its row, if any, stays).
      clearConfigureBlock(apId)
      return
    }
    const ap = await ensureApConfig(apId, block)
    await fleetKey()
    setConfigureBlock(ap, await getWifiConfigSettings())
    const row = await WifiAccessPoint.find(apId)
    if (row) sendAgentConfigure(row)
    await afterHello(apId)
  } catch (error) {
    logger.error({ apId, err: error }, 'wifi_config: hello failed')
  }
}

async function afterHello(apId: number): Promise<void> {
  let catchUp = false
  try {
    await apConfigQueue.run(apId, async () => {
      const ap = await ApConfig.findOrFail(apId)
      const session = apSession(apId)
      if (!session?.block) return
      for (const result of session.block.results) await applyApResult(ap, result)
      await onApAgentReconnected(ap)
      try {
        await fetchApCapabilities(ap)
      } catch (error) {
        logger.debug(
          { apId, error: (error as Error).message },
          'wifi_config: capabilities unavailable'
        )
      }
      if (normalizeApMode(ap.mode) === 'off') return
      const observed = ap.observedHashes ?? {}
      const moved =
        !ap.observedAt ||
        Object.entries(session.block.hashes).some(([config, hash]) => observed[config] !== hash)
      if (moved) await readAndReconcileAp(apId, { reason: 'hello' })
      catchUp = normalizeApMode(ap.mode) === 'managed'
    })
  } catch (error) {
    if (!(error instanceof ApOfflineError)) {
      logger.warn({ apId, error: (error as Error).message }, 'wifi_config: after-hello work failed')
    }
  }
  if (catchUp) {
    // Decision D7: an AP that missed a change while offline gets it now.
    scheduleFleetWork('catch up', async () => {
      const { catchUpAp } = await import('#services/wifi_config/rollouts')
      await catchUpAp(apId)
    })
  }
}

function authorOf(value: unknown): RouterAuthor | null {
  if (typeof value !== 'object' || value === null) return null
  const a = value as Record<string, unknown>
  if (typeof a.kind !== 'string' || !['luci', 'cli', 'perch', 'unknown'].includes(a.kind)) {
    return null
  }
  return {
    kind: a.kind as RouterAuthor['kind'],
    ...(typeof a.user === 'string' ? { user: a.user.slice(0, 64) } : {}),
    ...(a.via === 'trigger' || a.via === 'poll' ? { via: a.via } : {}),
    ...(typeof a.applyId === 'string' ? { applyId: a.applyId.slice(0, 64) } : {}),
  }
}

/** Is an `origin: "perch"` change what the named job wrote? */
async function ownEcho(apId: number, p: Record<string, unknown>): Promise<boolean> {
  if (typeof p.applyId !== 'string') return false
  const apply = await ApConfigApply.query()
    .where('ap_id', apId)
    .where('apply_key', p.applyId)
    .first()
  if (!apply) return false
  if (apply.state === 'sending' || apply.state === 'pending_confirm') return true
  const recorded = (apply.outcome?.hashes ?? {}) as Record<string, string>
  const hashes = (p.hashes ?? {}) as Record<string, unknown>
  const changed = Array.isArray(p.changed)
    ? p.changed.filter((c): c is string => typeof c === 'string')
    : Object.keys(hashes)
  return (
    changed.length > 0 &&
    changed.every((c) => recorded[c] !== undefined && recorded[c] === hashes[c])
  )
}

/**
 * `wifi.config.changed` (protocol.md 7): a router edit is read and merged
 * with its author; the agent's own echo only moves the observed hashes. The
 * device groups' writes (`applyId: "groups-<n>"`) are read like router
 * edits: their sections are the groups engine's and stay unmodeled.
 */
export async function onWifiConfigChanged(apId: number, params: unknown): Promise<void> {
  const ap = await ApConfig.find(apId)
  if (!ap || normalizeApMode(ap.mode) === 'off') return
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  try {
    if (p.origin === 'perch' && typeof p.applyId === 'string' && !p.applyId.startsWith('groups-')) {
      const echo = await apConfigQueue.run(apId, async () => {
        await ap.refresh()
        const trusted = await ownEcho(apId, p)
        const hashes = p.hashes as Record<string, unknown> | undefined
        if (trusted && hashes && typeof hashes === 'object') {
          const next: Record<string, string> = { ...(ap.observedHashes ?? {}) }
          for (const [k, v] of Object.entries(hashes)) if (typeof v === 'string') next[k] = v
          ap.observedHashes = next
          await ap.save()
        }
        return trusted
      })
      if (!echo) await readAndReconcileAp(apId, { reason: 'changed' })
      return
    }
    const author = authorOf(p.author) ?? { kind: 'unknown' as const }
    await readAndReconcileAp(apId, { author, reason: 'changed' })
  } catch (error) {
    logger.warn(
      { apId, error: (error as Error).message },
      'wifi_config: change notification not merged'
    )
  }
}

/** `wifi.config.result`: a job's outcome (a rollback), acked, then a read. */
export async function onWifiConfigResult(apId: number, params: unknown): Promise<void> {
  const result = parseApResult(params)
  if (!result) return
  const ap = await ApConfig.find(apId)
  if (!ap) return
  try {
    await apConfigQueue.run(apId, async () => {
      await ap.refresh()
      await applyApResult(ap, result)
    })
    if (normalizeApMode(ap.mode) !== 'off') {
      await readAndReconcileAp(apId, { reason: 'result' }).catch(() => undefined)
    }
  } catch (error) {
    logger.warn({ apId, error: (error as Error).message }, 'wifi_config: result not handled')
  }
}

/**
 * `wifi.health.changed` (outside a window): the AP's Wi-Fi went up or down.
 * Stored on the row; the alerts area hears about radios and BSSes down.
 */
export async function onWifiHealthChanged(apId: number, params: unknown): Promise<void> {
  const ap = await ApConfig.find(apId)
  if (!ap) return
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const health = parseHealth({
    ...(ap.health ?? {}),
    checkedAt: typeof p.at === 'string' ? p.at : new Date().toISOString(),
    ok: p.ok === true,
    pending: false,
    problems: Array.isArray(p.problems) ? p.problems : [],
  })
  if (!health) return
  const wasOk = ap.health?.ok ?? true
  ap.health = health
  ap.healthAt = DateTime.utc()
  await ap.save()
  await recordApEvent(apId, 'health_changed', {
    detail: { ok: health.ok, problems: health.problems.slice(0, 16) },
  })
  if (health.ok && !wasOk) {
    emitWifiAlert({
      name: 'wifi.health.recovered',
      severity: 'info',
      source: { kind: 'ap', id: apId },
      dedupeKey: `wifi.health:${apId}`,
      payload: { apId },
    })
  }
  for (const problem of health.problems) {
    const radioDown = problem.code === 'radio_down' || problem.code === 'radio_setup_failed'
    const bssDown = problem.code === 'bss_missing' || problem.code === 'bss_disabled'
    if (!radioDown && !bssDown) continue
    emitWifiAlert({
      name: radioDown ? 'wifi.radio.down' : 'wifi.bss.down',
      severity: 'warning',
      source: { kind: 'ap', id: apId },
      dedupeKey: `${radioDown ? 'wifi.radio.down' : 'wifi.bss.down'}:${apId}:${problem.section ?? ''}`,
      payload: radioDown
        ? { apId, radio: problem.section, problem: problem.code }
        : { apId, section: problem.section, status: problem.code },
    })
  }
}

/**
 * Every accepted `metrics.push`: the agent half of a confirm. Cheap when no
 * job waits (one indexed query); a confirmed job's AP is read afterwards.
 */
export async function onPushAccepted(apId: number): Promise<void> {
  const pending = await ApConfigApply.query()
    .where('ap_id', apId)
    .where('state', 'pending_confirm')
    .whereNotNull('agent_reconnected_at')
    .whereNull('agent_confirmed_at')
    .first()
  if (!pending) return
  try {
    const confirmed = await apConfigQueue.run(apId, async () => {
      const ap = await ApConfig.findOrFail(apId)
      return confirmOnPush(ap)
    })
    if (confirmed) await readAndReconcileAp(apId, { reason: 'confirmed' }).catch(() => undefined)
  } catch (error) {
    logger.warn({ apId, error: (error as Error).message }, 'wifi_config: push hook failed')
  }
}

/** The session ended (the hub also drops it; kept for symmetry and tests). */
export function onSessionClosed(apId: number): void {
  forgetApSession(apId)
}

/** Registers the plane's notifications on the AP hub (`attach()` of the endpoint). */
export function attachWifiNotifications(): void {
  hub.onNotification('wifi.config.changed', (apId, params) => onWifiConfigChanged(apId, params))
  hub.onNotification('wifi.config.result', (apId, params) => onWifiConfigResult(apId, params))
  hub.onNotification('wifi.health.changed', (apId, params) => onWifiHealthChanged(apId, params))
}
