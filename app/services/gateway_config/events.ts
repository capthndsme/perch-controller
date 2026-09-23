import GatewayConfigEvent from '#models/gateway_config_event'
import type { GatewayEventName } from '#services/gateway_config/types'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The config plane's audit log (`gateway_config_events`, section 9): who
 * did what to which gateway, and what the router did. Every admin write
 * carries its user; router-side events carry the router author in `detail`.
 */
export async function recordGatewayEvent(
  gatewayId: number,
  event: GatewayEventName,
  options: {
    userId?: number | null
    applyId?: number | null
    revision?: number | null
    detail?: Record<string, unknown> | null
    trx?: TransactionClientContract
  } = {}
): Promise<GatewayConfigEvent> {
  const row = new GatewayConfigEvent()
  row.gatewayId = gatewayId
  row.event = event
  row.userId = options.userId ?? null
  row.applyId = options.applyId ?? null
  row.revisionNumber = options.revision ?? null
  row.detail = options.detail ?? null
  row.createdAt = DateTime.utc()
  if (options.trx) row.useTransaction(options.trx)
  await row.save()
  return row
}
