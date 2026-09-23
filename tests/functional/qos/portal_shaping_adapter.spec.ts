import QosAssignment from '#models/qos_assignment'
import { QosPortalShaping, watchPortalQuotaExhaustion } from '#services/portal_qos_shaping'
import { portalShaping, type PortalShapingEntry } from '#services/portal_shaping'
import { handleQosEvent } from '#services/qos_live'
import { shapeDevice } from '#services/qos_shaping'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

const GUEST_A = '02:00:00:00:0b:01'
const GUEST_B = '02:00:00:00:0b:02'
const ADMIN_CAPPED = '02:00:00:00:0b:03'

function entry(fields: Partial<PortalShapingEntry> & { sourceRef: string; mac: string }) {
  return {
    portalId: 1,
    downKbps: 5000,
    upKbps: 1000,
    quotaBytes: null,
    expiresAt: Date.now() + 3_600_000,
    ...fields,
  } satisfies PortalShapingEntry
}

async function portalRows(gatewayId: number) {
  return QosAssignment.query()
    .where('gatewayId', gatewayId)
    .where('source', 'portal')
    .orderBy('sourceRef')
}

test.group('qos | portal shaping adapter (portal.md 13.7)', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('the portal seam defaults to the QoS adapter', ({ assert }) => {
    assert.instanceOf(portalShaping(), QosPortalShaping)
  })

  test('sync shapes, updates and releases by sourceRef; the quota is set once', async ({
    assert,
  }) => {
    await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const shaping = new QosPortalShaping()

    await shaping.sync(gateway.id, [
      entry({ sourceRef: 'portal-grant:1', mac: GUEST_A, quotaBytes: 500_000_000 }),
      entry({ sourceRef: 'portal-local:1:abc', mac: GUEST_B, downKbps: 2000, upKbps: null }),
    ])
    let rows = await portalRows(gateway.id)
    // No upload cap is stored as 0 (unlimited).
    assert.deepEqual(
      rows.map((r) => [
        r.sourceRef,
        r.mac,
        r.downKbit,
        r.upKbit,
        r.quotaBytes && Number(r.quotaBytes),
      ]),
      [
        ['portal-grant:1', GUEST_A, 5000, 1000, 500_000_000],
        ['portal-local:1:abc', GUEST_B, 2000, 0, null],
      ]
    )
    assert.equal(rows[0].quotaOnExhausted, 'block')

    // The portal's "bytes left" shrinks; the assignment keeps counting against
    // the first limit. A new rate is applied.
    await shaping.apply(
      gateway.id,
      [
        entry({
          sourceRef: 'portal-grant:1',
          mac: GUEST_A,
          downKbps: 8000,
          quotaBytes: 300_000_000,
        }),
      ],
      []
    )
    rows = await portalRows(gateway.id)
    assert.equal(rows[0].downKbit, 8000)
    assert.equal(Number(rows[0].quotaBytes), 500_000_000)

    // A full sync without the local grant releases it; an admin cap is untouched.
    await shapeDevice({
      gatewayId: gateway.id,
      mac: '02:00:00:00:0b:09',
      rate: { downloadKbit: 3000, uploadKbit: null },
      source: 'portal',
      sourceRef: 'voucher:other-integration',
    })
    await shaping.sync(gateway.id, [entry({ sourceRef: 'portal-grant:1', mac: GUEST_A })])
    rows = await portalRows(gateway.id)
    assert.deepEqual(
      rows.map((r) => r.sourceRef),
      ['portal-grant:1', 'voucher:other-integration']
    )

    // An entry with nothing left to shape, or past its expiry, is released.
    await shaping.apply(
      gateway.id,
      [entry({ sourceRef: 'portal-grant:1', mac: GUEST_A, expiresAt: Date.now() - 1000 })],
      []
    )
    rows = await portalRows(gateway.id)
    assert.deepEqual(
      rows.map((r) => r.sourceRef),
      ['voucher:other-integration']
    )
  })

  test('an admin cap wins; refusals never throw', async ({ assert }) => {
    await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const admin = await QosAssignment.create({
      gatewayId: gateway.id,
      targetType: 'device',
      mac: ADMIN_CAPPED,
      downKbit: 1000,
      quotaUsedBytes: 0,
      source: 'admin',
    } as Partial<QosAssignment>)
    const shaping = new QosPortalShaping()
    await shaping.sync(gateway.id, [
      entry({ sourceRef: 'portal-grant:7', mac: ADMIN_CAPPED }),
      // Below the device floor: refused by QoS, logged.
      entry({ sourceRef: 'portal-grant:8', mac: GUEST_A, downKbps: 1, upKbps: 1 }),
      entry({ sourceRef: 'portal-grant:9', mac: GUEST_B }),
    ])
    const rows = await QosAssignment.query().where('gatewayId', gateway.id).orderBy('id')
    assert.deepEqual(
      rows.map((r) => [r.source, r.mac]),
      [
        ['admin', ADMIN_CAPPED],
        ['portal', GUEST_B],
      ]
    )
    assert.equal(rows[0].id, admin.id)
  })

  test('a gateway not in managed mode is left alone', async ({ assert }) => {
    await seedSetupComplete()
    const { gateway } = await seedQosGateway({ mode: 'observe' })
    const shaping = new QosPortalShaping()
    await shaping.sync(gateway.id, [entry({ sourceRef: 'portal-grant:1', mac: GUEST_A })])
    await shaping.apply(gateway.id, [entry({ sourceRef: 'portal-grant:2', mac: GUEST_B })], [])
    assert.lengthOf(await portalRows(gateway.id), 0)
  })

  test('quota exhaustion of a portal device goes to the portal event log', async ({ assert }) => {
    await seedSetupComplete()
    const { gateway, collector } = await seedQosGateway()
    const stop = watchPortalQuotaExhaustion()
    try {
      await new QosPortalShaping().sync(gateway.id, [
        entry({ sourceRef: 'portal-local:1:q1', mac: GUEST_A, quotaBytes: 10_000_000 }),
      ])
      await handleQosEvent(collector.id, {
        type: 'quota_exhausted',
        at: '2026-09-23T12:00:05Z',
        mac: GUEST_A,
        detail: { usedBytes: 10_000_000 },
      })
      const events = await eventually(
        () => db.from('portal_events').where('type', 'shaping_quota_exhausted'),
        (rows) => rows.length === 1
      )
      assert.equal(events[0].gateway_id, gateway.id)
      assert.equal(events[0].mac, GUEST_A)
      assert.include(JSON.parse(events[0].detail), { sourceRef: 'portal-local:1:q1' })
    } finally {
      stop()
    }
  })
})
