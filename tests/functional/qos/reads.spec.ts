import QosAssignment from '#models/qos_assignment'
import DeviceGroup from '#models/device_group'
import DeviceGroupMember from '#models/device_group_member'
import QosPolicy from '#models/qos_policy'
import QosSchedule from '#models/qos_schedule'
import { loadPlanInput } from '#services/qos_reads'
import { planQos } from '#services/qos_plan'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

const MAC1 = '02:00:00:00:00:21'
const MAC2 = '02:00:00:00:00:22'

/**
 * A guest bucket with a voucher tier nested inside (decision 16), a kids'
 * group blocked at night by a schedule, a network default and a portal
 * voucher with a quota.
 */
async function seedShaping(gatewayId: number, adminId: number) {
  const guest = await QosPolicy.create({
    gatewayId,
    name: 'Guest',
    sharedDownKbit: 50000,
    sharedUpKbit: 10000,
    fairness: 'per_host',
    classMinor: 0x12,
    createdByUserId: adminId,
  })
  const tier = await QosPolicy.create({
    gatewayId,
    name: 'Voucher 5M',
    sharedDownKbit: 20000,
    sharedUpKbit: 5000,
    eachDownKbit: 5000,
    eachUpKbit: 1000,
    parentPolicyId: guest.id,
    source: 'portal',
    sourceRef: 'tier:5m',
    classMinor: 0x13,
  })
  const kids = await QosPolicy.create({
    gatewayId,
    name: 'Kids',
    eachDownKbit: 10000,
    eachUpKbit: 2000,
    includeLan: true,
    classMinor: 0x14,
  })
  const group = await DeviceGroup.create({ gatewayId, name: 'Kids', notes: 'tablets' })
  await DeviceGroupMember.createMany([
    { gatewayId, groupId: group.id, mac: MAC1 },
    { gatewayId, groupId: group.id, mac: MAC2 },
  ])
  await db.table('device_labels').insert({
    mac: MAC1,
    name: 'Tablet',
    created_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
  })
  const groupAssignment = await QosAssignment.create({
    gatewayId,
    policyId: kids.id,
    targetType: 'group',
    groupId: group.id,
  })
  const networkAssignment = await QosAssignment.create({
    gatewayId,
    policyId: guest.id,
    targetType: 'network',
    network: 'guest',
  })
  const voucher = await QosAssignment.create({
    gatewayId,
    policyId: tier.id,
    targetType: 'device',
    mac: '02:00:00:00:0a:07',
    quotaBytes: 5_368_709_120,
    quotaUsedBytes: 1_048_576,
    quotaOnExhausted: 'throttle',
    throttleDownKbit: 256,
    throttleUpKbit: 128,
    expiresAt: DateTime.fromISO('2030-01-01T00:00:00Z'),
    source: 'portal',
    sourceRef: 'voucher:17',
  })
  const night = await QosSchedule.create({
    gatewayId,
    name: 'Bedtime',
    targetType: 'assignment',
    assignmentId: groupAssignment.id,
    action: 'block',
    days: 0b0011111,
    startMinute: 22 * 60,
    endMinute: 7 * 60,
  })
  const allDay = await QosSchedule.create({
    gatewayId,
    name: 'Always slower',
    targetType: 'policy',
    policyId: guest.id,
    action: 'limit',
    sharedDownKbit: 25000,
    days: 0b1111111,
    startMinute: 0,
    endMinute: 0,
  })
  return { guest, tier, kids, group, groupAssignment, networkAssignment, voucher, night, allDay }
}

test.group('qos | reads (decision 16: operators see every cap)', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('policies with nesting, the LAN toggle and counts', async ({ client, assert }) => {
    const { operatorToken, adminId } = await seedSetupComplete()
    const { gateway, collector } = await seedQosGateway()
    const seeded = await seedShaping(gateway.id, adminId)
    const response = await client
      .get(`/api/v1/qos/policies?collectorId=${collector.id}`)
      .bearerToken(operatorToken)
    response.assertStatus(200)
    const byName = Object.fromEntries(bodyOf(response).data.map((p: any) => [p.name, p]))
    assert.containsSubset(byName.Guest, {
      gatewayId: gateway.id,
      collectorId: collector.id,
      shared: { downloadKbit: 50000, uploadKbit: 10000 },
      each: null,
      fairness: 'per_host',
      includeLan: false,
      parentPolicyId: null,
      classMinor: 0x12,
      enabled: true,
      source: 'admin',
      counts: { devices: 0, groups: 0, networks: ['guest'], children: 1 },
      live: null,
    })
    assert.containsSubset(byName['Voucher 5M'], {
      shared: { downloadKbit: 20000, uploadKbit: 5000 },
      each: { downloadKbit: 5000, uploadKbit: 1000 },
      parentPolicyId: seeded.guest.id,
      source: 'portal',
      sourceRef: 'tier:5m',
      counts: { devices: 1, groups: 0, networks: [], children: 0 },
    })
    assert.containsSubset(byName.Kids, { includeLan: true, counts: { groups: 1 } })
  })

  test('groups with member names, assignments with filters', async ({ client, assert }) => {
    const { operatorToken, adminId } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const seeded = await seedShaping(gateway.id, adminId)

    const groups = await client
      .get(`/api/v1/qos/groups?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    assert.containsSubset(bodyOf(groups).data, [
      {
        name: 'Kids',
        notes: 'tablets',
        members: [
          { mac: MAC1, name: 'Tablet' },
          { mac: MAC2, name: null },
        ],
      },
    ])

    const all = await client
      .get(`/api/v1/qos/assignments?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    const targets = bodyOf(all).data.map((a: any) => a.target)
    assert.deepEqual(targets, [
      { type: 'group', groupId: seeded.group.id },
      { type: 'network', network: 'guest' },
      { type: 'device', mac: '02:00:00:00:0a:07' },
    ])
    const voucher = bodyOf(all).data[2]
    assert.containsSubset(voucher, {
      policyId: seeded.tier.id,
      rate: null,
      quota: {
        limitBytes: 5_368_709_120,
        usedBytes: 1_048_576,
        onExhausted: 'throttle',
        throttle: { downloadKbit: 256, uploadKbit: 128 },
        exhaustedAt: null,
      },
      source: 'portal',
      sourceRef: 'voucher:17',
    })
    assert.equal(voucher.expiresAt, seeded.voucher.expiresAt!.toUTC().toISO())

    const bySource = await client
      .get(`/api/v1/qos/assignments?gatewayId=${gateway.id}&source=portal`)
      .bearerToken(operatorToken)
    assert.lengthOf(bodyOf(bySource).data, 1)
    const byMac = await client
      .get(`/api/v1/qos/assignments?gatewayId=${gateway.id}&mac=02-00-00-00-0A-07`)
      .bearerToken(operatorToken)
    assert.lengthOf(bodyOf(byMac).data, 1)
    const byPolicy = await client
      .get(`/api/v1/qos/assignments?gatewayId=${gateway.id}&policyId=${seeded.guest.id}`)
      .bearerToken(operatorToken)
    assert.lengthOf(bodyOf(byPolicy).data, 1)
    const badMac = await client
      .get(`/api/v1/qos/assignments?gatewayId=${gateway.id}&mac=nope`)
      .bearerToken(operatorToken)
    badMac.assertStatus(422)
  })

  test('schedules with their day names and whether they are in force', async ({
    client,
    assert,
  }) => {
    const { operatorToken, adminId } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const seeded = await seedShaping(gateway.id, adminId)
    const response = await client
      .get(`/api/v1/qos/schedules?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    const [night, allDay] = bodyOf(response).data
    assert.containsSubset(night, {
      name: 'Bedtime',
      target: { type: 'assignment', assignmentId: seeded.groupAssignment.id },
      action: 'block',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startMinute: 1320,
      endMinute: 420,
      window: 'mon-fri 22:00-07:00',
      previewTimezone: 'UTC',
    })
    assert.isBoolean(night.active)
    assert.containsSubset(allDay, {
      target: { type: 'policy', policyId: seeded.guest.id },
      action: 'limit',
      shared: { downloadKbit: 25000, uploadKbit: null },
      each: null,
      rate: null,
      window: 'mon-sun 00:00-00:00',
      // seedSetupComplete stores the controller zone UTC.
      previewTimezone: 'UTC',
      active: true,
    })
  })

  test('the tables feed the planner', async ({ assert }) => {
    const { adminId } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const seeded = await seedShaping(gateway.id, adminId)
    // Wednesday 23:30 in the controller's zone (UTC here): bedtime, for the preview.
    const at = new Date('2026-09-23T23:30:00Z')
    const plan = planQos(await loadPlanInput(gateway.id, at))
    const night = `s${seeded.night.id}`
    const allDay = `s${seeded.allDay.id}`
    assert.deepEqual(plan.activeSchedules, [seeded.night.id, seeded.allDay.id])
    assert.deepEqual(
      plan.sections.map((s) => [s.type, s.name, s.options.parent, s.options.schedule]),
      [
        ['globals', 'globals', undefined, undefined],
        ['bucket', 'b12', '', [allDay]],
        ['bucket', 'b13', 'b12', undefined],
        ['network', 'guest', undefined, undefined],
        ['schedule', night, undefined, undefined],
        ['schedule', allDay, undefined, undefined],
      ]
    )
    assert.deepEqual(plan.sections[4].options, {
      window: ['mon-fri 22:00-07:00'],
      assignment: String(seeded.groupAssignment.id),
      action: 'block',
    })
    assert.equal(plan.sections[5].options.down_kbit, '25000')
    assert.deepEqual(
      plan.devices.map((d) => [d.mac, d.bucket, d.downKbit, d.schedules, Boolean(d.quota)]),
      [
        [MAC1, null, 10000, [night], false],
        [MAC2, null, 10000, [night], false],
        ['02:00:00:00:0a:07', 'b13', 5000, undefined, true],
      ]
    )
    assert.isTrue(plan.devices[0].includeLan)
    assert.deepEqual(plan.issues, [])
  })

  test('cascades: a gateway takes its QoS rows; a parent policy leaves its child', async ({
    assert,
  }) => {
    const { adminId } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const seeded = await seedShaping(gateway.id, adminId)
    await seeded.guest.delete()
    const tier = await QosPolicy.findOrFail(seeded.tier.id)
    assert.isNull(tier.parentPolicyId)
    // The guest network assignment and the policy schedule went with it.
    assert.isNull(await QosAssignment.find(seeded.networkAssignment.id))
    assert.isNull(await QosSchedule.find(seeded.allDay.id))

    await seeded.group.delete()
    assert.isNull(await QosAssignment.find(seeded.groupAssignment.id))
    assert.isNull(await QosSchedule.find(seeded.night.id))
    assert.lengthOf(await DeviceGroupMember.all(), 0)

    await gateway.delete()
    assert.lengthOf(await QosPolicy.all(), 0)
    assert.lengthOf(await QosAssignment.all(), 0)
  })

  test('one assignment per MAC, group and network; one group per MAC', async ({ assert }) => {
    const { adminId } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const seeded = await seedShaping(gateway.id, adminId)
    await assert.rejects(() =>
      QosAssignment.create({
        gatewayId: gateway.id,
        targetType: 'device',
        mac: '02:00:00:00:0a:07',
        downKbit: 1000,
      })
    )
    await assert.rejects(() =>
      QosAssignment.create({ gatewayId: gateway.id, targetType: 'network', network: 'guest' })
    )
    await assert.rejects(() =>
      DeviceGroupMember.create({ gatewayId: gateway.id, groupId: seeded.group.id, mac: MAC1 })
    )
    await assert.rejects(() =>
      QosPolicy.create({ gatewayId: gateway.id, name: 'Other', classMinor: 0x12 })
    )
  })
})
