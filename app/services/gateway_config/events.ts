import GatewayConfigEvent from '#models/gateway_config_event'
import {
  actorColumns,
  type GatewayEventName,
  type PlaneActor,
} from '#services/gateway_config/types'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The config plane's audit log (`gateway_config_events`, section 9): who
 * did what to which gateway, and what the router did. Every admin write
 * carries its user; router-side events carry the router author in `detail`.
 * Writes Perch made by itself name their `actor` (`{ system: 'qos' }`),
 * shown as "Perch (system)".
 */
export async function recordGatewayEvent(
  gatewayId: number,
  event: GatewayEventName,
  options: {
    userId?: number | null
    /** Instead of `userId`: who made the change, a user or Perch itself. */
    actor?: PlaneActor | null
    applyId?: number | null
    revision?: number | null
    detail?: Record<string, unknown> | null
    trx?: TransactionClientContract
  } = {}
): Promise<GatewayConfigEvent> {
  const row = new GatewayConfigEvent()
  row.gatewayId = gatewayId
  row.event = event
  const actor = options.actor !== undefined ? actorColumns(options.actor) : null
  row.userId = actor ? actor.userId : (options.userId ?? null)
  row.systemActor = actor ? actor.systemActor : null
  row.applyId = options.applyId ?? null
  row.revisionNumber = options.revision ?? null
  row.detail = options.detail ?? null
  row.createdAt = DateTime.utc()
  if (options.trx) row.useTransaction(options.trx)
  await row.save()
  return row
}
