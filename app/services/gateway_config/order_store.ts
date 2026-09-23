import type Gateway from '#models/gateway'
import GatewaySectionOrder from '#models/gateway_section_order'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import {
  orderKeys,
  reconcileOrder,
  sameOrder,
  type OrderKey,
  type OrderState,
} from '#services/gateway_config/section_order'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * Persistence of section orders (`gateway_section_orders`,
 * docs/gateway/firewall.md section 3). Callers hold the gateway's serial
 * queue.
 */

export function toOrderState(row: GatewaySectionOrder): OrderState {
  return {
    config: row.config,
    type: row.sectionType,
    base: row.baseOrder ?? [],
    desired: row.desiredOrder ?? [],
    status: (row.status as OrderState['status']) ?? 'in_sync',
    conflict: row.conflict ?? null,
    driftSince: row.driftSince ? row.driftSince.toUTC().toISO() : null,
  }
}

export async function loadOrderRows(
  gatewayId: number,
  trx?: TransactionClientContract
): Promise<GatewaySectionOrder[]> {
  return GatewaySectionOrder.query({ client: trx }).where('gateway_id', gatewayId)
}

export async function loadOrders(
  gatewayId: number,
  trx?: TransactionClientContract
): Promise<OrderState[]> {
  const rows = await loadOrderRows(gatewayId, trx)
  return rows.map(toOrderState)
}

function sameState(a: OrderState, b: OrderState): boolean {
  return (
    sameOrder(a.base, b.base) &&
    sameOrder(a.desired, b.desired) &&
    a.status === b.status &&
    a.driftSince === b.driftSince &&
    JSON.stringify(a.conflict) === JSON.stringify(b.conflict)
  )
}

/** Writes one order state (insert or update); a no-op when nothing changed. */
export async function saveOrder(
  gatewayId: number,
  state: OrderState,
  options: {
    userId?: number | null
    row?: GatewaySectionOrder | null
    trx?: TransactionClientContract
  } = {}
): Promise<void> {
  let row =
    options.row ??
    (await GatewaySectionOrder.query({ client: options.trx })
      .where('gateway_id', gatewayId)
      .where('config', state.config)
      .where('section_type', state.type)
      .first())
  const now = DateTime.utc()
  if (row && sameState(toOrderState(row), state)) return
  if (!row) {
    row = new GatewaySectionOrder()
    row.gatewayId = gatewayId
    row.config = state.config
    row.sectionType = state.type
    row.createdAt = now
  }
  if (options.trx) row.useTransaction(options.trx)
  row.baseOrder = state.base
  row.desiredOrder = state.desired
  row.status = state.status
  row.conflict = state.conflict
  row.driftSince = state.driftSince ? DateTime.fromISO(state.driftSince, { zone: 'utc' }) : null
  if (options.userId !== undefined && options.userId !== null) row.updatedByUserId = options.userId
  row.updatedAt = now
  await row.save()
}

/**
 * Brings every order of the gateway up to date with its rows (after a read,
 * a draft edit, a confirm): membership, imports, conflicts, drift. Orders of
 * `frozen` configs (an apply in flight touches them) are left alone: the
 * router's order is in motion there. Returns the states after.
 */
export async function refreshOrders(
  gateway: Gateway,
  states: SectionState[],
  options: { frozen?: Iterable<string>; trx?: TransactionClientContract } = {}
): Promise<OrderState[]> {
  const frozen = new Set(options.frozen ?? [])
  const rows = await loadOrderRows(gateway.id, options.trx)
  const mode = normalizeMode(gateway.mode)
  const out: OrderState[] = []
  if (mode === 'off') return rows.map(toOrderState)
  const now = DateTime.utc().toISO()!
  for (const key of orderKeys(domainRegistry())) {
    const row = rows.find((r) => r.config === key.config && r.sectionType === key.type) ?? null
    const prev = row ? toOrderState(row) : null
    if (frozen.has(key.config)) {
      if (prev) out.push(prev)
      continue
    }
    const result = reconcileOrder({
      prev,
      states,
      key,
      mode,
      authoritative: mode === 'managed' && Boolean(gateway.authoritative),
      now,
    })
    if (!result) continue
    await saveOrder(gateway.id, result.next, { row, trx: options.trx })
    if (result.event) {
      await recordGatewayEvent(gateway.id, result.event.event, {
        detail: { config: key.config, type: key.type, ...result.event.detail },
        trx: options.trx,
      })
    }
    out.push(result.next)
  }
  return out
}

/** One order (null when the gateway has none for the key yet). */
export async function findOrder(gatewayId: number, key: OrderKey): Promise<OrderState | null> {
  const row = await GatewaySectionOrder.query()
    .where('gateway_id', gatewayId)
    .where('config', key.config)
    .where('section_type', key.type)
    .first()
  return row ? toOrderState(row) : null
}
