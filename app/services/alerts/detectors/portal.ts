import type { ConditionInput, DetectorContext } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import {
  ISO_FORMAT,
  liveAlerts,
  liveCollectorIds,
  loadCollectorLiveness,
  parseJsonObject,
  rawRows,
  toNumberOrNull,
} from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'

/**
 * Detector `portal` (WP-A5b, events.md sections 3.6 and 3.7), every 15 s,
 * for portals and coin terminals on a gateway whose collector is not silent
 * (a silent gateway says nothing; its live alerts are left as they are).
 *
 * - `portal.not_enforcing` (critical): the router reports the portal
 *   `error` or `waiting_device` (docs/gateway/portal.md section 13.3), or
 *   the gateway's portal deliveries failed 3 times in a row. `active` and
 *   `disabled` clear; `unknown` (no answer yet) leaves it as it is.
 * - `hotspot.terminal_offline`: an enabled terminal that reported before
 *   has been silent for more than 90 s (the view's online bound, section 14.3).
 * - `hotspot.terminal_error`: the terminal's last report (≤ 90 s old) names
 *   an error.
 *
 * Guest privacy: no payload carries a guest's MAC, IP or host name.
 */

export const NOT_ENFORCING_TYPE = 'portal.not_enforcing'
export const TERMINAL_OFFLINE_TYPE = 'hotspot.terminal_offline'
export const TERMINAL_ERROR_TYPE = 'hotspot.terminal_error'

/** The portal view's online bound for a terminal (docs/gateway/portal.md section 14.3). */
export const TERMINAL_ONLINE_SECONDS = 90
export const DELIVERY_FAILURES_LIMIT = 3
const SOURCE = 'detector:portal'

/**
 * Whether `portal.not_enforcing` holds: true, false (clears), or null
 * (unknown: leave the alert as it is).
 */
export function portalNotEnforcing(state: string | null, deliveryFailures: number): boolean | null {
  if (state === 'disabled') return false
  if (deliveryFailures >= DELIVERY_FAILURES_LIMIT) return true
  if (state === 'error' || state === 'waiting_device') return true
  if (state === 'active') return false
  return null
}

/** Terminal conditions from its last report's age and status. */
export function terminalConditions(input: {
  silentSeconds: number | null
  statusAgeSeconds: number | null
  error: string | null
}): { offline: boolean; error: boolean } {
  const offline = input.silentSeconds !== null && input.silentSeconds > TERMINAL_ONLINE_SECONDS
  const fresh = input.statusAgeSeconds !== null && input.statusAgeSeconds <= TERMINAL_ONLINE_SECONDS
  return { offline, error: !offline && fresh && !!input.error && input.error.trim().length > 0 }
}

type GatewayLive = Map<number, boolean>

/** gateways.id → whether its collector is adopted, enabled and not silent. */
async function gatewaysLive(): Promise<GatewayLive> {
  const [gateways, collectors] = await Promise.all([
    db.from('gateways').select('id', 'collector_id') as Promise<
      Array<{ id: number; collector_id: number | null }>
    >,
    loadCollectorLiveness(),
  ])
  const live = liveCollectorIds(collectors)
  return new Map(
    gateways.map((g) => [Number(g.id), g.collector_id !== null && live.has(Number(g.collector_id))])
  )
}

async function portalConditions(
  gatewayLive: GatewayLive,
  live: ReadonlyMap<string, unknown>
): Promise<ConditionInput[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT p.id, p.name, p.gateway_id AS gatewayId, p.status,
              COALESCE(s.delivery_failures, 0) AS deliveryFailures,
              s.delivery_error AS deliveryError
         FROM portals p
         LEFT JOIN portal_gateway_states s ON s.gateway_id = p.gateway_id
        WHERE p.deleted_at IS NULL`
    )
  )
  const out: ConditionInput[] = []
  for (const row of rows) {
    const id = Number(row.id)
    const gatewayId = Number(row.gatewayId)
    const key = `${NOT_ENFORCING_TYPE}:portal:${id}`
    const status = parseJsonObject(row.status)
    const state = typeof status?.state === 'string' ? status.state : null
    const failures = Number(row.deliveryFailures) || 0
    const holds = gatewayLive.get(gatewayId) ? portalNotEnforcing(state, failures) : null
    if (holds === false || (holds === null && !live.has(key))) continue
    const issues = Array.isArray(status?.issues)
      ? (status.issues as unknown[]).map(String).slice(0, 5)
      : []
    out.push({
      type: NOT_ENFORCING_TYPE,
      subject: { kind: 'portal', id },
      dedupeKey: key,
      source: SOURCE,
      ...(holds === true && {
        payload: {
          portalId: id,
          name: row.name,
          gatewayId,
          state:
            failures >= DELIVERY_FAILURES_LIMIT && state === 'active' ? 'delivery_failed' : state,
          issues,
          deliveryError: (row.deliveryError as string | null) ?? null,
        },
      }),
    })
  }
  return out
}

async function terminalConditionsAll(
  gatewayLive: GatewayLive,
  live: ReadonlyMap<string, unknown>
): Promise<{ offline: ConditionInput[]; error: ConditionInput[] }> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT t.id, t.name, t.portal_id AS portalId, p.gateway_id AS gatewayId, t.status,
              DATE_FORMAT(t.last_seen_at, ${ISO_FORMAT}) AS lastSeenAt,
              TIMESTAMPDIFF(SECOND, t.last_seen_at, UTC_TIMESTAMP()) AS silentSeconds
         FROM hotspot_terminals t
         JOIN portals p ON p.id = t.portal_id
        WHERE t.enabled = 1 AND t.last_seen_at IS NOT NULL AND p.deleted_at IS NULL`
    )
  )
  const offline: ConditionInput[] = []
  const error: ConditionInput[] = []
  const nowMs = Date.now()
  for (const row of rows) {
    const id = Number(row.id)
    const subject = { kind: 'terminal', id } as const
    const offlineKey = `${TERMINAL_OFFLINE_TYPE}:terminal:${id}`
    const errorKey = `${TERMINAL_ERROR_TYPE}:terminal:${id}`
    if (!gatewayLive.get(Number(row.gatewayId))) {
      if (live.has(offlineKey)) {
        offline.push({
          type: TERMINAL_OFFLINE_TYPE,
          subject,
          dedupeKey: offlineKey,
          source: SOURCE,
        })
      }
      if (live.has(errorKey)) {
        error.push({ type: TERMINAL_ERROR_TYPE, subject, dedupeKey: errorKey, source: SOURCE })
      }
      continue
    }
    const status = parseJsonObject(row.status)
    const statusAt = typeof status?.at === 'string' ? Date.parse(status.at) : Number.NaN
    // `status.at` is written by the controller (ISO, UTC), so the process clock compares with it.
    const statusAgeSeconds = Number.isFinite(statusAt)
      ? Math.max(0, (nowMs - statusAt) / 1000)
      : null
    const errorText = typeof status?.error === 'string' ? status.error : null
    const verdict = terminalConditions({
      silentSeconds: toNumberOrNull(row.silentSeconds),
      statusAgeSeconds,
      error: errorText,
    })
    if (verdict.offline) {
      offline.push({
        type: TERMINAL_OFFLINE_TYPE,
        subject,
        dedupeKey: offlineKey,
        source: SOURCE,
        payload: {
          terminalId: id,
          name: row.name,
          portalId: Number(row.portalId),
          lastSeenAt: row.lastSeenAt ?? null,
        },
      })
    }
    if (verdict.error) {
      error.push({
        type: TERMINAL_ERROR_TYPE,
        subject,
        dedupeKey: errorKey,
        source: SOURCE,
        payload: {
          terminalId: id,
          name: row.name,
          error: errorText!.slice(0, 200),
          acceptor: typeof status?.acceptor === 'string' ? status.acceptor : null,
          firmware: typeof status?.firmware === 'string' ? status.firmware : null,
        },
      })
    }
  }
  return { offline, error }
}

export async function runPortalDetector(ctx: DetectorContext): Promise<void> {
  const [gatewayLive, live] = await Promise.all([
    gatewaysLive(),
    liveAlerts([NOT_ENFORCING_TYPE, TERMINAL_OFFLINE_TYPE, TERMINAL_ERROR_TYPE]),
  ])
  const portals = await portalConditions(gatewayLive, live)
  const terminals = await terminalConditionsAll(gatewayLive, live)
  await ctx.reconcile([NOT_ENFORCING_TYPE], portals)
  await ctx.reconcile([TERMINAL_OFFLINE_TYPE], terminals.offline)
  await ctx.reconcile([TERMINAL_ERROR_TYPE], terminals.error)
}

registerDetector({
  id: 'portal',
  everySeconds: 15,
  types: [NOT_ENFORCING_TYPE, TERMINAL_OFFLINE_TYPE, TERMINAL_ERROR_TYPE],
  run: runPortalDetector,
})
