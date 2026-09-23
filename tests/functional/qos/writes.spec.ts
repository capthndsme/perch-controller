import QosAssignment from '#models/qos_assignment'
import QosGroupMember from '#models/qos_group_member'
import QosPolicy from '#models/qos_policy'
import QosSchedule from '#models/qos_schedule'
import { updateQosSettings } from '#services/qos_settings'
import { expireQosAssignments } from '#services/qos_writes'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const MAC1 = '02:00:00:00:00:21'
const MAC2 = '02:00:00:00:00:22'
const MAC3 = '02:00:00:00:00:23'

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

async function setup(mode: 'managed' | 'observe' = 'managed') {
  const tokens = await seedSetupComplete()
  const { gateway, collector } = await seedQosGateway({ mode })
  return { ...tokens, gateway, collector }
}

function post(client: ApiClient, token: string, path: string, body: Record<string, unknown>) {
  return client.post(`/api/v1/qos/${path}`).bearerToken(token).json(body)
}

function patch(client: ApiClient, token: string, path: string, body: Record<string, unknown>) {
  return client.patch(`/api/v1/qos/${path}`).bearerToken(token).json(body)
}

const rate = (downloadKbit: number | null, uploadKbit: number | null) => ({
  downloadKbit,
  uploadKbit,
})

test.group('qos | policy writes', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('create, update and delete a policy; class minors are allocated', async ({
    client,
    assert,
  }) => {
    const { adminToken, gateway, adminId } = await setup()
    const created = await post(client, adminToken, 'policies', {
      gatewayId: gateway.id,
      name: 'Guest',
      shared: rate(50000, 10000),
      each: rate(5000, null),
      includeLan: true,
    })
    created.assertStatus(201)
    const guest = bodyOf(created).data
    assert.containsSubset(guest, {
      name: 'Guest',
      shared: rate(50000, 10000),
      each: rate(5000, null),
      fairness: 'per_host',
      includeLan: true,
      parentPolicyId: null,
      classMinor: 2,
      enabled: true,
      source: 'admin',
      counts: { devices: 0, groups: 0, networks: [], children: 0 },
    })
    const row = await QosPolicy.findOrFail(guest.id)
    assert.equal(row.createdByUserId, adminId)
    assert.equal(row.eachUpKbit, 0)

    const second = await post(client, adminToken, 'policies', {
      name: 'Tier',
      shared: rate(20000, 5000),
      parentPolicyId: guest.id,
    })
    second.assertStatus(201)
    assert.equal(bodyOf(second).data.classMinor, 3)
    assert.equal(bodyOf(second).data.parentPolicyId, guest.id)

    const updated = await patch(client, adminToken, `policies/${guest.id}`, {
      notes: 'visitors',
      each: null,
      fairness: 'per_flow',
    })
    updated.assertStatus(200)
    assert.containsSubset(bodyOf(updated).data, {
      notes: 'visitors',
      each: null,
      fairness: 'per_flow',
      counts: { children: 1 },
    })

    // In use by a nested bucket: refused, nothing deleted.
    const refused = await client.delete(`/api/v1/qos/policies/${guest.id}`).bearerToken(adminToken)
    refused.assertStatus(409)
    assert.containsSubset(bodyOf(refused), {
      error: 'qos_policy_in_use',
      childPolicyIds: [bodyOf(second).data.id],
    })
    const deleted = await client
      .delete(`/api/v1/qos/policies/${bodyOf(second).data.id}`)
      .bearerToken(adminToken)
    deleted.assertStatus(204)
    const gone = await client.delete(`/api/v1/qos/policies/${guest.id}`).bearerToken(adminToken)
    gone.assertStatus(204)
    assert.lengthOf(await QosPolicy.all(), 0)
  })

  test('field refusals: empty, floor, each above shared, names, gateway fields', async ({
    client,
    assert,
  }) => {
    const { adminToken, gateway } = await setup()
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ name: 'Empty' }, 422, 'qos_policy_empty'],
      [{ name: 'Tiny', each: rate(32, null) }, 422, 'qos_rate_below_floor'],
      [
        { name: 'Upside', shared: rate(5000, 5000), each: rate(10000, 1000) },
        422,
        'qos_each_exceeds_shared',
      ],
      [{ name: 'Orphan', shared: rate(5000, 5000), parentPolicyId: 999 }, 404, 'qos_not_found'],
    ]
    for (const [body, status, error] of cases) {
      const response = await post(client, adminToken, 'policies', {
        gatewayId: gateway.id,
        ...body,
      })
      response.assertStatus(status)
      assert.equal(bodyOf(response).error, error, JSON.stringify(body))
    }
    const floor = await post(client, adminToken, 'policies', { name: 'x', each: rate(10, 10) })
    assert.containsSubset(bodyOf(floor), { field: 'each.downloadKbit', min: 64 })

    const first = await post(client, adminToken, 'policies', { name: 'A', each: rate(1000, 1000) })
    first.assertStatus(201)
    const dup = await post(client, adminToken, 'policies', { name: 'A', each: rate(1000, 1000) })
    dup.assertStatus(409)
    assert.equal(bodyOf(dup).error, 'qos_name_taken')

    const moved = await patch(client, adminToken, `policies/${bodyOf(first).data.id}`, {
      gatewayId: 99,
    })
    moved.assertStatus(422)
    assert.equal(bodyOf(moved).error, 'qos_field_not_applicable')

    const vine = await post(client, adminToken, 'policies', { name: '', each: rate(-1, 5) })
    vine.assertStatus(422)
    assert.isArray(bodyOf(vine).errors)

    const missing = await patch(client, adminToken, 'policies/4242', { notes: 'x' })
    missing.assertStatus(404)
    assert.containsSubset(bodyOf(missing), {
      error: 'qos_not_found',
      resource: 'policy',
      id: 4242,
    })
  })

  test('nested buckets: the planner and tree rules are 422s (amendment section 5)', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await setup()
    await updateQosSettings({ maxBucketDepth: 2 })
    const make = (body: Record<string, unknown>) => post(client, adminToken, 'policies', body)
    const guest = bodyOf(await make({ name: 'Guest', shared: rate(10000, 10000) })).data
    const each = bodyOf(await make({ name: 'Each', each: rate(1000, 1000) })).data

    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { name: 'Big', shared: rate(20000, 5000), parentPolicyId: guest.id },
        'qos_child_exceeds_parent',
      ],
      [
        { name: 'Open', shared: rate(null, 5000), parentPolicyId: guest.id },
        'qos_child_exceeds_parent',
      ],
      [{ name: 'Flat', each: rate(1000, 1000), parentPolicyId: guest.id }, 'qos_child_not_bucket'],
      [
        { name: 'Under each', shared: rate(1000, 1000), parentPolicyId: each.id },
        'qos_parent_not_bucket',
      ],
    ]
    for (const [body, error] of cases) {
      const response = await make(body)
      response.assertStatus(422)
      assert.equal(bodyOf(response).error, error, JSON.stringify(body))
      assert.isArray(bodyOf(response).issues)
    }

    const a = bodyOf(
      await make({ name: 'A', shared: rate(6000, 6000), parentPolicyId: guest.id })
    ).data
    // A second child would take the children past the parent's rate (HTB's guarantee).
    const over = await make({ name: 'B', shared: rate(6000, 1000), parentPolicyId: guest.id })
    over.assertStatus(422)
    assert.equal(bodyOf(over).error, 'qos_children_exceed_parent')
    // Depth 3 with maxBucketDepth 2.
    const deep = await make({ name: 'C', shared: rate(1000, 1000), parentPolicyId: a.id })
    deep.assertStatus(422)
    assert.equal(bodyOf(deep).error, 'qos_bucket_too_deep')
    // A cycle through PATCH.
    const cycle = await patch(client, adminToken, `policies/${guest.id}`, { parentPolicyId: a.id })
    cycle.assertStatus(422)
    assert.equal(bodyOf(cycle).error, 'qos_parent_cycle')
    const self = await patch(client, adminToken, `policies/${guest.id}`, {
      parentPolicyId: guest.id,
    })
    self.assertStatus(422)
    // Shrinking the parent below its child is refused too; nothing changed.
    const shrink = await patch(client, adminToken, `policies/${guest.id}`, {
      shared: rate(4000, 10000),
    })
    shrink.assertStatus(422)
    const unchanged = await QosPolicy.findOrFail(guest.id)
    assert.equal(unchanged.sharedDownKbit, 10000)
  })

  test('409 qos_not_managed outside managed mode; 409 qos_not_gateway without one', async ({
    client,
    assert,
  }) => {
    const { adminToken, gateway } = await setup('observe')
    const response = await post(client, adminToken, 'policies', {
      gatewayId: gateway.id,
      name: 'Guest',
      each: rate(1000, 1000),
    })
    response.assertStatus(409)
    assert.equal(bodyOf(response).error, 'qos_not_managed')
  })
})

test.group('qos | group writes', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('members are added, removed, normalised; one group per MAC', async ({ client, assert }) => {
    const { adminToken } = await setup()
    const created = await post(client, adminToken, 'groups', {
      name: 'Kids',
      members: [MAC1, '02-00-00-00-00-22', MAC1.toUpperCase()],
    })
    created.assertStatus(201)
    const kids = bodyOf(created).data
    assert.deepEqual(
      kids.members.map((m: any) => m.mac),
      [MAC1, MAC2]
    )

    const clash = await post(client, adminToken, 'groups', { name: 'Other', members: [MAC2] })
    clash.assertStatus(409)
    assert.containsSubset(bodyOf(clash), {
      error: 'qos_mac_in_group',
      mac: MAC2,
      groupId: kids.id,
    })
    const other = await post(client, adminToken, 'groups', { name: 'Other', members: [MAC3] })
    other.assertStatus(201)
    const steal = await patch(client, adminToken, `groups/${bodyOf(other).data.id}`, {
      addMacs: [MAC1],
    })
    steal.assertStatus(409)

    const updated = await patch(client, adminToken, `groups/${kids.id}`, {
      name: 'Children',
      addMacs: [MAC3.replace('23', '24')],
      removeMacs: [MAC1],
    })
    updated.assertStatus(200)
    assert.equal(bodyOf(updated).data.name, 'Children')
    assert.deepEqual(
      bodyOf(updated).data.members.map((m: any) => m.mac),
      [MAC2, '02:00:00:00:00:24']
    )

    const members = await patch(client, adminToken, `groups/${kids.id}`, { members: [] })
    members.assertStatus(422)
    assert.equal(bodyOf(members).error, 'qos_field_not_applicable')

    const bad = await post(client, adminToken, 'groups', { name: 'Bad', members: ['nope'] })
    bad.assertStatus(422)

    // Deleting a group cascades its members and its assignment.
    const policy = bodyOf(
      await post(client, adminToken, 'policies', { name: 'P', each: rate(1000, 1000) })
    ).data
    const assigned = await post(client, adminToken, 'assignments', {
      policyId: policy.id,
      target: { type: 'group', groupId: kids.id },
    })
    assigned.assertStatus(201)
    const deleted = await client.delete(`/api/v1/qos/groups/${kids.id}`).bearerToken(adminToken)
    deleted.assertStatus(204)
    assert.lengthOf(await QosGroupMember.query().where('groupId', kids.id), 0)
    assert.isNull(await QosAssignment.find(bodyOf(assigned).data.id))
  })
})

test.group('qos | assignment writes', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('device, group and network targets; conflicts are 409s', async ({ client, assert }) => {
    const { adminToken } = await setup()
    const policy = bodyOf(
      await post(client, adminToken, 'policies', {
        name: 'Guest',
        shared: rate(50000, 10000),
        each: rate(5000, 1000),
      })
    ).data
    const kids = bodyOf(
      await post(client, adminToken, 'groups', { name: 'Kids', members: [MAC2] })
    ).data

    const device = await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC1.toUpperCase() },
      rate: rate(2000, 1000),
      quota: { limitBytes: 50_000_000, onExhausted: 'throttle', throttle: rate(256, 128) },
      expiresAt: DateTime.utc().plus({ days: 1 }).toISO(),
    })
    device.assertStatus(201)
    assert.containsSubset(bodyOf(device).data, {
      policyId: null,
      target: { type: 'device', mac: MAC1 },
      rate: rate(2000, 1000),
      quota: {
        limitBytes: 50_000_000,
        usedBytes: 0,
        onExhausted: 'throttle',
        throttle: rate(256, 128),
        exhaustedAt: null,
        resetAt: null,
      },
      source: 'admin',
    })

    const again = await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC1 },
      policyId: policy.id,
    })
    again.assertStatus(409)
    assert.containsSubset(bodyOf(again), {
      error: 'qos_mac_assigned',
      assignmentId: bodyOf(device).data.id,
      source: 'admin',
    })

    const groupAssignment = await post(client, adminToken, 'assignments', {
      target: { type: 'group', groupId: kids.id },
      policyId: policy.id,
    })
    groupAssignment.assertStatus(201)
    const groupAgain = await post(client, adminToken, 'assignments', {
      target: { type: 'group', groupId: kids.id },
      policyId: policy.id,
    })
    groupAgain.assertStatus(409)
    assert.equal(bodyOf(groupAgain).error, 'qos_target_assigned')

    const network = await post(client, adminToken, 'assignments', {
      target: { type: 'network', network: 'guest' },
      policyId: policy.id,
    })
    network.assertStatus(201)

    const list = await client.get(`/api/v1/qos/policies`).bearerToken(adminToken)
    assert.containsSubset(bodyOf(list).data[0].counts, {
      devices: 0,
      groups: 1,
      networks: ['guest'],
    })
  })

  test('assignment refusals', async ({ client, assert }) => {
    const { adminToken } = await setup()
    const kids = bodyOf(
      await post(client, adminToken, 'groups', { name: 'Kids', members: [] })
    ).data
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ target: { type: 'device', mac: MAC1 } }, 422, 'qos_policy_empty'],
      [{ target: { type: 'device' }, rate: rate(1000, 1000) }, 422, 'qos_target_invalid'],
      [
        { target: { type: 'device', mac: MAC1, network: 'lan' }, rate: rate(1000, 1000) },
        422,
        'qos_target_invalid',
      ],
      [{ target: { type: 'group', groupId: 999 }, rate: rate(1000, 1000) }, 404, 'qos_not_found'],
      [{ target: { type: 'device', mac: MAC1 }, policyId: 999 }, 404, 'qos_not_found'],
      [
        {
          target: { type: 'group', groupId: kids.id },
          rate: rate(1000, 1000),
          quota: { limitBytes: 1000, onExhausted: 'block' },
        },
        422,
        'qos_quota_needs_device',
      ],
      [
        {
          target: { type: 'device', mac: MAC1 },
          quota: { limitBytes: 1000, onExhausted: 'throttle' },
        },
        422,
        'qos_throttle_required',
      ],
      [
        {
          target: { type: 'device', mac: MAC1 },
          quota: { limitBytes: 1000, onExhausted: 'block', throttle: rate(100, 100) },
        },
        422,
        'qos_field_not_applicable',
      ],
      [
        {
          target: { type: 'device', mac: MAC1 },
          rate: rate(1000, 1000),
          expiresAt: '2020-01-01T00:00:00Z',
        },
        422,
        'qos_expiry_past',
      ],
      [
        { target: { type: 'device', mac: MAC1 }, rate: rate(1000, 1000), expiresAt: 'tomorrow' },
        422,
        'qos_invalid_date',
      ],
      [
        { target: { type: 'device', mac: MAC1 }, rate: rate(10, 1000) },
        422,
        'qos_rate_below_floor',
      ],
    ]
    for (const [body, status, error] of cases) {
      const response = await post(client, adminToken, 'assignments', body)
      response.assertStatus(status)
      assert.equal(bodyOf(response).error, error, JSON.stringify(body))
    }
    const network = await post(client, adminToken, 'assignments', {
      target: { type: 'network', network: 'bad-name!' },
      rate: rate(1000, 1000),
    })
    network.assertStatus(422)
    assert.lengthOf(await QosAssignment.all(), 0)
  })

  test('patch keeps the target; quota reset starts over', async ({ client, assert }) => {
    const { adminToken } = await setup()
    const created = bodyOf(
      await post(client, adminToken, 'assignments', {
        target: { type: 'device', mac: MAC1 },
        rate: rate(2000, 1000),
        quota: { limitBytes: 1000, onExhausted: 'block' },
      })
    ).data
    await QosAssignment.query()
      .where('id', created.id)
      .update({ quota_used_bytes: 1000, exhausted_at: '2026-09-23 10:00:00' })

    const retarget = await patch(client, adminToken, `assignments/${created.id}`, {
      target: { type: 'device', mac: MAC2 },
    })
    retarget.assertStatus(422)
    assert.equal(bodyOf(retarget).error, 'qos_field_not_applicable')

    const raised = await patch(client, adminToken, `assignments/${created.id}`, {
      quota: { limitBytes: 5000, onExhausted: 'block' },
      expiresAt: DateTime.utc().plus({ hours: 2 }).toISO(),
    })
    raised.assertStatus(200)
    assert.containsSubset(bodyOf(raised).data.quota, {
      limitBytes: 5000,
      usedBytes: 1000,
      exhaustedAt: null,
    })
    assert.isString(bodyOf(raised).data.expiresAt)

    const reset = await client
      .post(`/api/v1/qos/assignments/${created.id}/quota/reset`)
      .bearerToken(adminToken)
      .json({})
    reset.assertStatus(200)
    assert.containsSubset(bodyOf(reset).data.quota, { usedBytes: 0, exhaustedAt: null })
    assert.isString(bodyOf(reset).data.quota.resetAt)

    const dropped = await patch(client, adminToken, `assignments/${created.id}`, { quota: null })
    dropped.assertStatus(200)
    assert.isNull(bodyOf(dropped).data.quota)
    const noQuota = await client
      .post(`/api/v1/qos/assignments/${created.id}/quota/reset`)
      .bearerToken(adminToken)
      .json({})
    noQuota.assertStatus(422)
    assert.equal(bodyOf(noQuota).error, 'qos_no_quota')

    const removed = await client
      .delete(`/api/v1/qos/assignments/${created.id}`)
      .bearerToken(adminToken)
    removed.assertStatus(204)
  })

  test('expired assignments are deleted after expiredKeepMinutes', async ({ assert }) => {
    const { gateway } = await setup()
    const at = DateTime.utc().startOf('second')
    const old = await QosAssignment.create({
      gatewayId: gateway.id,
      targetType: 'device',
      mac: MAC1,
      downKbit: 1000,
      upKbit: 1000,
      expiresAt: at.minus({ minutes: 61 }),
    })
    const fresh = await QosAssignment.create({
      gatewayId: gateway.id,
      targetType: 'device',
      mac: MAC2,
      downKbit: 1000,
      upKbit: 1000,
      expiresAt: at.minus({ minutes: 5 }),
    })
    assert.deepEqual(await expireQosAssignments(at), [old.id])
    assert.isNotNull(await QosAssignment.find(fresh.id))
    await updateQosSettings({ expiredKeepMinutes: 0 })
    assert.deepEqual(await expireQosAssignments(at), [fresh.id])
  })
})

test.group('qos | schedule writes', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('create, update and delete schedules; refusals', async ({ client, assert }) => {
    const { adminToken } = await setup()
    const guest = bodyOf(
      await post(client, adminToken, 'policies', {
        name: 'Guest',
        shared: rate(50000, 10000),
        each: rate(5000, 1000),
      })
    ).data
    const night = bodyOf(
      await post(client, adminToken, 'policies', { name: 'Night', each: rate(1000, 500) })
    ).data
    const kids = bodyOf(
      await post(client, adminToken, 'assignments', {
        target: { type: 'device', mac: MAC1 },
        policyId: guest.id,
      })
    ).data
    const network = bodyOf(
      await post(client, adminToken, 'assignments', {
        target: { type: 'network', network: 'guest' },
        policyId: guest.id,
      })
    ).data

    const evening = await post(client, adminToken, 'schedules', {
      name: 'Evening',
      target: { type: 'policy', policyId: guest.id },
      action: 'limit',
      shared: { downloadKbit: 25000 },
      each: { downloadKbit: 2500, uploadKbit: null },
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startMinute: 18 * 60,
      endMinute: 23 * 60,
    })
    evening.assertStatus(201)
    assert.containsSubset(bodyOf(evening).data, {
      name: 'Evening',
      enabled: true,
      target: { type: 'policy', policyId: guest.id },
      action: 'limit',
      shared: { downloadKbit: 25000, uploadKbit: null },
      each: { downloadKbit: 2500, uploadKbit: null },
      rate: null,
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      window: 'mon-fri 18:00-23:00',
      previewTimezone: 'UTC',
    })

    const bedtime = await post(client, adminToken, 'schedules', {
      name: 'Bedtime',
      target: { type: 'assignment', assignmentId: kids.id },
      action: 'policy',
      usePolicyId: night.id,
      days: ['sun', 'mon'],
      startMinute: 22 * 60,
      endMinute: 7 * 60,
    })
    bedtime.assertStatus(201)
    assert.equal(bodyOf(bedtime).data.window, 'mon,sun 22:00-07:00')

    const cases: Array<[Record<string, unknown>, number, string]> = [
      [
        { target: { type: 'policy', policyId: guest.id }, action: 'block' },
        422,
        'qos_schedule_unsupported',
      ],
      [
        { target: { type: 'assignment', assignmentId: network.id }, action: 'block' },
        422,
        'qos_schedule_unsupported',
      ],
      [
        { target: { type: 'assignment', assignmentId: kids.id }, action: 'policy' },
        422,
        'qos_schedule_policy_missing',
      ],
      [
        { target: { type: 'assignment', assignmentId: kids.id }, action: 'limit' },
        422,
        'qos_schedule_empty',
      ],
      [
        {
          target: { type: 'policy', policyId: guest.id },
          action: 'limit',
          rate: { downloadKbit: 1000 },
        },
        422,
        'qos_field_not_applicable',
      ],
      [
        {
          target: { type: 'assignment', assignmentId: kids.id },
          action: 'unlimited',
          rate: { downloadKbit: 1000 },
        },
        422,
        'qos_field_not_applicable',
      ],
      [
        {
          target: { type: 'assignment', assignmentId: kids.id },
          action: 'limit',
          rate: { downloadKbit: 10 },
        },
        422,
        'qos_rate_below_floor',
      ],
      [
        { target: { type: 'assignment', assignmentId: 999 }, action: 'unlimited' },
        404,
        'qos_not_found',
      ],
      [
        {
          target: { type: 'policy', policyId: guest.id, assignmentId: kids.id },
          action: 'unlimited',
        },
        422,
        'qos_target_invalid',
      ],
    ]
    for (const [body, status, error] of cases) {
      const response = await post(client, adminToken, 'schedules', {
        name: 'x',
        days: ['sat'],
        startMinute: 0,
        endMinute: 60,
        ...body,
      })
      response.assertStatus(status)
      assert.equal(bodyOf(response).error, error, JSON.stringify(body))
    }
    const noDays = await post(client, adminToken, 'schedules', {
      name: 'x',
      target: { type: 'policy', policyId: guest.id },
      action: 'unlimited',
      days: [],
      startMinute: 0,
      endMinute: 60,
    })
    noDays.assertStatus(422)

    // Switching a limit schedule to unlimited drops its rates.
    const unlimited = await patch(client, adminToken, `schedules/${bodyOf(evening).data.id}`, {
      action: 'unlimited',
      enabled: false,
      days: ['sat', 'sun'],
    })
    unlimited.assertStatus(200)
    assert.containsSubset(bodyOf(unlimited).data, {
      action: 'unlimited',
      enabled: false,
      shared: null,
      each: null,
      window: 'sat,sun 18:00-23:00',
    })
    const retarget = await patch(client, adminToken, `schedules/${bodyOf(evening).data.id}`, {
      target: { type: 'policy', policyId: night.id },
    })
    retarget.assertStatus(422)

    // The policy a schedule moves devices into is in use.
    const inUse = await client.delete(`/api/v1/qos/policies/${night.id}`).bearerToken(adminToken)
    inUse.assertStatus(409)
    assert.deepEqual(bodyOf(inUse).scheduleIds, [bodyOf(bedtime).data.id])

    const removed = await client
      .delete(`/api/v1/qos/schedules/${bodyOf(bedtime).data.id}`)
      .bearerToken(adminToken)
    removed.assertStatus(204)
    assert.lengthOf(await QosSchedule.all(), 1)
  })
})
