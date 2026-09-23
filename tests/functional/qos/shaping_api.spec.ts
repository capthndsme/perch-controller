import QosAssignment from '#models/qos_assignment'
import QosPolicy from '#models/qos_policy'
import { QosError } from '#services/qos_gateway'
import {
  ensureTierPolicy,
  getDeviceShaping,
  portalAssignment,
  releaseDevice,
  shapeDevice,
} from '#services/qos_shaping'
import { flushQosSync } from '#services/qos_sync'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const PHONE = '02:00:00:00:0a:01'
const LAPTOP = '02:00:00:00:0a:02'
const ADMIN_CAPPED = '02:00:00:00:0a:03'

async function refusal(run: () => Promise<unknown>): Promise<QosError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof QosError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

test.group('qos | portal shaping API (plan 3 section 7)', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('tiers, idempotent grants, moving a voucher, release', async ({ assert }) => {
    await seedSetupComplete()
    const { collector, gateway } = await seedQosGateway()

    const tier = await ensureTierPolicy({
      collectorId: collector.id,
      key: '5m',
      name: 'Voucher 5 Mbit/s',
      each: { downloadKbit: 5000, uploadKbit: 1000 },
    })
    assert.containsSubset(tier, { source: 'portal', sourceRef: 'tier:5m', classMinor: 2 })
    const again = await ensureTierPolicy({
      collectorId: collector.id,
      key: '5m',
      name: 'Voucher 5M',
      each: { downloadKbit: 6000, uploadKbit: 1000 },
    })
    assert.equal(again.id, tier.id)
    assert.containsSubset(again, { name: 'Voucher 5M', each: { downloadKbit: 6000 } })
    const tiers = await QosPolicy.query().where('gatewayId', gateway.id)
    assert.lengthOf(tiers, 1)

    const expiresAt = DateTime.utc().plus({ hours: 3 }).startOf('second')
    const grant = await shapeDevice({
      collectorId: collector.id,
      mac: PHONE.toUpperCase(),
      policyId: tier.id,
      quota: { limitBytes: 1_000_000_000, onExhausted: 'block' },
      expiresAt,
      source: 'portal',
      sourceRef: 'voucher:17',
    })
    assert.containsSubset(grant, {
      policyId: tier.id,
      target: { type: 'device', mac: PHONE },
      quota: { limitBytes: 1_000_000_000, usedBytes: 0, onExhausted: 'block' },
      expiresAt: expiresAt.toISO(),
      source: 'portal',
      sourceRef: 'voucher:17',
    })
    // Same sourceRef again: an update, not a second row.
    const same = await shapeDevice({
      collectorId: collector.id,
      mac: PHONE,
      policyId: tier.id,
      rate: { downloadKbit: 3000, uploadKbit: 500 },
      source: 'portal',
      sourceRef: 'voucher:17',
    })
    assert.equal(same.id, grant.id)
    assert.containsSubset(same, { rate: { downloadKbit: 3000, uploadKbit: 500 }, quota: null })

    // Decision 23: the voucher on a new MAC moves there.
    const moved = await shapeDevice({
      collectorId: collector.id,
      mac: LAPTOP,
      policyId: tier.id,
      source: 'portal',
      sourceRef: 'voucher:17',
    })
    assert.equal(moved.id, grant.id)
    assert.deepEqual(moved.target, { type: 'device', mac: LAPTOP })
    assert.lengthOf(await QosAssignment.all(), 1)

    const shaping = await getDeviceShaping(collector.id, LAPTOP)
    assert.containsSubset(shaping, {
      mac: LAPTOP,
      via: 'device',
      policy: { id: tier.id, name: 'Voucher 5M' },
      cap: { downloadKbit: 6000, uploadKbit: 1000 },
      state: 'pending',
    })
    assert.isNull(await getDeviceShaping(collector.id, PHONE))
    assert.isNotNull(await portalAssignment('voucher:17'))

    await releaseDevice('voucher:17')
    await releaseDevice('voucher:17')
    assert.lengthOf(await QosAssignment.all(), 0)
    assert.isNull(await portalAssignment('voucher:17'))
    await flushQosSync()
  })

  test('the portal never overrides an admin assignment', async ({ assert }) => {
    await seedSetupComplete()
    const { collector, gateway } = await seedQosGateway()
    const admin = await QosAssignment.create({
      gatewayId: gateway.id,
      targetType: 'device',
      mac: ADMIN_CAPPED,
      downKbit: 1000,
      upKbit: 1000,
    })
    const error = await refusal(() =>
      shapeDevice({
        collectorId: collector.id,
        mac: ADMIN_CAPPED,
        rate: { downloadKbit: 5000, uploadKbit: 1000 },
        source: 'portal',
        sourceRef: 'voucher:1',
      })
    )
    assert.equal(error.status, 409)
    assert.containsSubset(error.body, {
      error: 'qos_mac_assigned',
      assignmentId: admin.id,
      source: 'admin',
    })
    // Moving a grant onto an admin-capped MAC is refused the same way.
    await shapeDevice({
      collectorId: collector.id,
      mac: PHONE,
      rate: { downloadKbit: 5000, uploadKbit: 1000 },
      source: 'portal',
      sourceRef: 'voucher:2',
    })
    const move = await refusal(() =>
      shapeDevice({
        collectorId: collector.id,
        mac: ADMIN_CAPPED,
        rate: { downloadKbit: 5000, uploadKbit: 1000 },
        source: 'portal',
        sourceRef: 'voucher:2',
      })
    )
    assert.equal(move.status, 409)
    const bad = await refusal(() =>
      shapeDevice({
        collectorId: collector.id,
        mac: 'nope',
        rate: { downloadKbit: 5000, uploadKbit: 1000 },
        source: 'portal',
        sourceRef: 'voucher:3',
      })
    )
    assert.equal(bad.status, 422)
    const empty = await refusal(() =>
      shapeDevice({ collectorId: collector.id, mac: LAPTOP, source: 'portal', sourceRef: 'v:4' })
    )
    assert.equal(empty.body.error, 'qos_policy_empty')
    await flushQosSync()
  })
})
