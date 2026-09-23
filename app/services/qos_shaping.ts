import Gateway from '#models/gateway'
import QosAssignment from '#models/qos_assignment'
import QosPolicy from '#models/qos_policy'
import { qosRefusal, resolveGateway, type GatewayRef } from '#services/qos_gateway'
import { onQuotaExhausted as subscribeQuotaExhausted } from '#services/qos_live'
import type { QosRate } from '#services/qos_reads'
import { pickShaping, shapingByMac, type DeviceShaping } from '#services/qos_views'
import {
  assignmentView,
  createAssignment,
  createPolicy,
  deleteAssignment,
  updateAssignment,
  updatePolicy,
} from '#services/qos_writes'
import type { DateTime } from 'luxon'

/**
 * The portal-facing shaping API (docs/gateway/qos.md section 8; plan 3
 * section 7), in-process: the captive portal's agents call it to cap a
 * device for a grant (a voucher, a paid session) and lift the cap again.
 *
 * - A tier is a `source: 'portal'` policy (`ensureTierPolicy`, keyed by
 *   `sourceRef 'tier:<key>'`).
 * - A grant is a device assignment with `source: 'portal'` and the portal's
 *   `sourceRef` (e.g. `voucher:<id>`), a rate or tier, an optional quota and
 *   `expiresAt`. `shapeDevice` is idempotent per `sourceRef`: calling it
 *   again updates the grant, and a new `mac` moves it (owner decision 23:
 *   reusing a voucher on a new MAC moves it there).
 * - The portal never overrides an admin assignment: 409 `qos_mac_assigned`
 *   (+`assignmentId`, `source`), the REST endpoints' refusals otherwise
 *   (`QosError` with `status` and `body`).
 * - A gateway is named by `collectorId` (the contract) or `gatewayId`.
 */

export interface ShapeDeviceInput extends GatewayRef {
  mac: string
  policyId?: number
  rate?: QosRate
  quota?: { limitBytes: number; onExhausted: 'block' | 'throttle'; throttle?: QosRate }
  expiresAt?: DateTime
  source: 'portal'
  sourceRef: string
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/
const SOURCE_REF = /^[A-Za-z0-9_.:-]{1,64}$/

function normalizeMac(raw: string): string {
  const mac = raw.trim().toLowerCase().replace(/-/g, ':')
  if (!MAC.test(mac)) {
    throw qosRefusal(422, 'qos_invalid_mac', `"${raw}" is not a MAC address.`, { field: 'mac' })
  }
  return mac
}

function requireSourceRef(sourceRef: string) {
  if (!SOURCE_REF.test(sourceRef)) {
    throw qosRefusal(422, 'qos_invalid_source_ref', 'sourceRef: 1-64 of A-Z a-z 0-9 _ . : -', {
      field: 'sourceRef',
    })
  }
}

/** Caps a device for a portal grant (create or update by `sourceRef`). */
export async function shapeDevice(input: ShapeDeviceInput) {
  requireSourceRef(input.sourceRef)
  const mac = normalizeMac(input.mac)
  const { gateway } = await resolveGateway(input)
  const context = { userId: null, source: 'portal' as const, sourceRef: input.sourceRef }
  const fields = {
    policyId: input.policyId ?? null,
    rate: input.rate ?? null,
    quota: input.quota
      ? {
          limitBytes: input.quota.limitBytes,
          onExhausted: input.quota.onExhausted,
          throttle: input.quota.throttle ?? null,
        }
      : null,
    expiresAt: input.expiresAt ? input.expiresAt.toUTC().toISO() : null,
  }

  const existing = await QosAssignment.query()
    .where('source', 'portal')
    .where('sourceRef', input.sourceRef)
    .first()
  if (existing && existing.gatewayId !== gateway.id) {
    // The grant moved to another gateway: start over there.
    await deleteAssignment(existing.id, context)
  } else if (existing) {
    const held = await QosAssignment.query()
      .where('gatewayId', gateway.id)
      .where('mac', mac)
      .whereNot('id', existing.id)
      .first()
    if (held) throw macAssigned(held)
    return updateAssignment(existing.id, fields, {
      ...context,
      target: { type: 'device', mac },
    })
  }
  const held = await QosAssignment.query().where('gatewayId', gateway.id).where('mac', mac).first()
  if (held) throw macAssigned(held)
  return createAssignment(
    { gatewayId: gateway.id },
    { ...fields, target: { type: 'device', mac } },
    context
  )
}

function macAssigned(held: QosAssignment) {
  return qosRefusal(
    409,
    'qos_mac_assigned',
    held.source === 'admin'
      ? 'An administrator already set a cap for this device.'
      : 'Another portal grant already caps this device.',
    { assignmentId: held.id, source: held.source, sourceRef: held.sourceRef }
  )
}

/** Lifts a portal grant's cap (no-op when there is none). */
export async function releaseDevice(sourceRef: string): Promise<void> {
  const existing = await QosAssignment.query()
    .where('source', 'portal')
    .where('sourceRef', sourceRef)
    .first()
  if (!existing) return
  await deleteAssignment(existing.id, { userId: null, source: 'portal', sourceRef })
}

/** A grant's assignment view, or null. */
export async function portalAssignment(sourceRef: string) {
  const existing = await QosAssignment.query()
    .where('source', 'portal')
    .where('sourceRef', sourceRef)
    .first()
  return existing ? assignmentView(existing.gatewayId, existing.id) : null
}

/** How a device is shaped on a gateway (plan 3 `DeviceShaping`), null when it is not. */
export async function getDeviceShaping(
  collectorId: number,
  mac: string
): Promise<DeviceShaping | null> {
  const address = normalizeMac(mac)
  const gateway = await Gateway.findBy('collectorId', collectorId)
  if (!gateway) return null
  const byMac = await shapingByMac([address])
  const views = byMac.get(address)
  return pickShaping(
    views?.filter((v) => v.gatewayId === gateway.id),
    collectorId
  )
}

/**
 * Called when a device's quota runs out on the router (a push or a
 * `qos.event`), once per exhaustion. Returns the unsubscribe.
 */
export function onQuotaExhausted(
  callback: (event: {
    collectorId: number
    mac: string
    sourceRef: string | null
    at: string
  }) => void
): () => void {
  return subscribeQuotaExhausted((event) =>
    callback({
      collectorId: event.collectorId,
      mac: event.mac,
      sourceRef: event.sourceRef,
      at: event.at,
    })
  )
}

/**
 * The portal's tier policy for `key` (`sourceRef 'tier:<key>'`), created or
 * updated to the given name and rates. An admin-made policy with the same
 * name is a 409 `qos_name_taken`.
 */
export async function ensureTierPolicy(i: {
  collectorId?: number
  gatewayId?: number
  key: string
  name: string
  shared?: QosRate
  each?: QosRate
}) {
  const sourceRef = `tier:${i.key}`
  requireSourceRef(sourceRef)
  const { gateway } = await resolveGateway(i)
  const context = { userId: null, source: 'portal' as const, sourceRef }
  const existing = await QosPolicy.query()
    .where('gatewayId', gateway.id)
    .where('source', 'portal')
    .where('sourceRef', sourceRef)
    .first()
  const fields = { name: i.name, shared: i.shared ?? null, each: i.each ?? null }
  if (existing) return updatePolicy(existing.id, fields, context)
  return createPolicy({ gatewayId: gateway.id }, fields, context)
}
