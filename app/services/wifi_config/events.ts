import ApConfigEvent from '#models/ap_config_event'
import { actorColumns, type GATEWAY_EVENTS, type PlaneActor } from '#services/gateway_config/types'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The Wi-Fi plane's audit log (`ap_config_events`, docs/design/wifi
 * controller.md section 2) and the seam towards the alerts area
 * (operations.md section 7).
 *
 * Event names: the gateway's (`GATEWAY_EVENTS`, the per-AP plane is the
 * gateway's model) plus the Wi-Fi ones below. Fleet-level events (a
 * rollout, a passphrase) are recorded on every AP they concern, since the
 * log hangs off `ap_configs`.
 */
export const WIFI_EVENTS = [
  'health_failed',
  'health_changed',
  'capabilities_changed',
  'divergence_opened',
  'divergence_resolved',
  'passphrase_set',
  'passphrase_revealed',
  'passphrase_changed',
  'country_changed',
  'rollout_started',
  'rollout_stopped',
  'rollout_completed',
  'caught_up',
  'adopted',
  'network_created',
  'network_changed',
  'network_deleted',
] as const

export type ApEventName = (typeof GATEWAY_EVENTS)[number] | (typeof WIFI_EVENTS)[number]

export async function recordApEvent(
  apId: number,
  event: ApEventName,
  options: {
    userId?: number | null
    /** Instead of `userId`: a user or Perch itself. */
    actor?: PlaneActor | null
    applyId?: number | bigint | null
    revision?: number | null
    detail?: Record<string, unknown> | null
    trx?: TransactionClientContract
  } = {}
): Promise<ApConfigEvent> {
  const row = new ApConfigEvent()
  row.apId = apId
  row.event = event
  const actor = options.actor !== undefined ? actorColumns(options.actor) : null
  row.userId = actor ? actor.userId : (options.userId ?? null)
  row.systemActor = actor ? actor.systemActor : null
  row.applyId = options.applyId === undefined || options.applyId === null ? null : options.applyId
  row.revisionNumber = options.revision ?? null
  row.detail = options.detail ?? null
  row.createdAt = DateTime.utc()
  if (options.trx) row.useTransaction(options.trx)
  await row.save()
  return row
}

// ── alerts seam (S9 wires it to the alerts area's `emitAlertEvent`) ───────

/** operations.md section 7: the envelope the alerts area receives. */
export type WifiAlertEvent = {
  name: string
  severity: 'info' | 'warning' | 'critical'
  source: { kind: 'ap' | 'wifi_network' | 'wifi_rollout'; id: number }
  at: string
  dedupeKey: string
  payload: Record<string, unknown>
}

type AlertSink = (event: WifiAlertEvent) => void | Promise<void>

let sink: AlertSink | null = null

/** S9 (`alerts.ts`) installs the forwarder; until then events go nowhere. */
export function setWifiAlertSink(next: AlertSink | null): void {
  sink = next
}

/** Hands an event to the alerts area; never throws into the plane. */
export function emitWifiAlert(event: Omit<WifiAlertEvent, 'at'> & { at?: string }): void {
  if (!sink) return
  const full: WifiAlertEvent = { ...event, at: event.at ?? new Date().toISOString() }
  try {
    const result = sink(full)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch((err) =>
        logger.warn({ err, name: event.name }, 'wifi_config: alert sink failed')
      )
    }
  } catch (err) {
    logger.warn({ err, name: event.name }, 'wifi_config: alert sink failed')
  }
}
