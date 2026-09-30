import Collector from '#models/collector'
import DeviceGroup from '#models/device_group'
import DeviceGroupMember from '#models/device_group_member'
import Gateway from '#models/gateway'
import QosAssignment from '#models/qos_assignment'
import QosPolicy from '#models/qos_policy'
import SystemSetting from '#models/system_setting'
import {
  _resetApGroupsState,
  _setApGroupsTimings,
  requestApGroupsSync,
  syncAllApGroups,
} from '#services/ap_groups'
import { _resetDeviceGroupsState } from '#services/device_groups'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetPollerState } from '#services/collector_poller'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { _resetNetworkAccountingState } from '#services/gateway_network_accounting'
import { setQosPlaneWriter, StubQosPlaneWriter } from '#services/qos_plane'
import { _resetQosSync, setQosSyncTiming } from '#services/qos_sync'
import { setSqmPlaneWriter, StubSqmPlaneWriter } from '#services/sqm_plane'
import {
  DEFAULT_SYSTEM_INFO,
  eventually,
  FakeAgent,
  RpcFailure,
  seedAgentAp,
  seedSetupComplete,
} from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

/**
 * Device groups (docs/gateway/device-groups.md) over the REST API against a
 * scripted managed gateway: a VLAN network owned by a group (its speed
 * limit is the network default), a group without a network (members by
 * MAC, a group QoS assignment, the internet block as an ipset and rules),
 * Wi-Fi keys, membership moves, the QoS groups view, and cleanup on delete.
 */

const PASSWORD = 'admin-pass-123'
const KID = '02:00:00:00:0d:01'
const KID2 = '02:00:00:00:0d:02'

function routerConfigs(): Record<string, Section[]> {
  return {
    network: [
      {
        name: 'loopback',
        type: 'interface',
        options: { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' },
      },
      {
        name: 'cfg030f15',
        type: 'device',
        anonymous: true,
        options: { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2'] },
      },
      {
        name: 'lan',
        type: 'interface',
        options: {
          device: 'br-lan',
          proto: 'static',
          ipaddr: '192.168.1.1',
          netmask: '255.255.255.0',
        },
      },
      {
        name: 'trunk_dev',
        type: 'device',
        options: { name: 'br-trunk', type: 'bridge', ports: ['trunk'] },
      },
      {
        name: 'trunk_v101',
        type: 'bridge-vlan',
        options: { device: 'br-trunk', vlan: '101', ports: ['trunk:t'] },
      },
      {
        name: 'unit101',
        type: 'interface',
        options: {
          device: 'br-trunk.101',
          proto: 'static',
          ipaddr: '192.168.101.1',
          netmask: '255.255.255.0',
        },
      },
      { name: 'wan', type: 'interface', options: { device: 'wan', proto: 'dhcp' } },
    ],
    dhcp: [
      {
        name: 'lan',
        type: 'dhcp',
        options: { interface: 'lan', start: '100', limit: '150', leasetime: '12h' },
      },
      { name: 'wan', type: 'dhcp', options: { interface: 'wan', ignore: '1' } },
    ],
    firewall: [
      {
        name: 'cfg02dc81',
        type: 'zone',
        anonymous: true,
        options: { name: 'lan', network: ['lan'], input: 'ACCEPT', forward: 'ACCEPT' },
      },
      {
        name: 'cfg03dc81',
        type: 'zone',
        anonymous: true,
        options: { name: 'unit101', network: ['unit101'], input: 'REJECT' },
      },
      {
        name: 'cfg04dc81',
        type: 'zone',
        anonymous: true,
        options: { name: 'wan', network: ['wan'], masq: '1', input: 'REJECT' },
      },
      {
        name: 'cfg05dc81',
        type: 'forwarding',
        anonymous: true,
        options: { src: 'lan', dest: 'wan' },
      },
    ],
  }
}

let gateways: FakeGateway[] = []
let agents: FakeAgent[] = []

async function resetAll() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetAnnounceState()
  _resetCollectorAgentState()
  _resetPollerState()
  _resetGatewaySessions()
  _resetNetworkAccountingState()
  _resetQosSync()
  setQosSyncTiming({ deviceDebounceMs: 0, configDebounceMs: 0 })
  setQosPlaneWriter(new StubQosPlaneWriter())
  setSqmPlaneWriter(new StubSqmPlaneWriter())
  resetDeviceLabelCacheForTesting()
  _resetDeviceGroupsState()
  _resetApGroupsState()
  _setApGroupsTimings({ debounceMs: 10, confirmDelayMs: 50 })
}

async function setup(client: any) {
  const { adminToken, operatorToken } = await seedSetupComplete()
  // The agent confirms applies itself (no admin "keep" round trip here).
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent' })
  const collector = await Collector.create({
    name: 'gateway',
    baseUrl: null,
    transport: 'agent',
    instanceId: TEST_INSTANCE_ID,
    source: 'announced',
    lifecycle: 'adopted',
    enabled: true,
    pollIntervalSeconds: 1,
    apiKey: TEST_API_KEY,
    apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    lastStatus: null,
  })
  const gw = new FakeGateway({ configs: routerConfigs(), secure: true })
  gateways.push(gw)
  await gw.connect()
  const gateway = await eventually(
    () => Gateway.findBy('collector_id', collector.id),
    (g) => g !== null
  )
  const r = await client
    .patch(`/api/v1/gateways/${gateway!.id}`)
    .bearerToken(adminToken)
    .json({ mode: 'managed', currentPassword: PASSWORD })
  r.assertStatus(200)
  await gatewayQueue.drain(gateway!.id)
  const nets = await client.get(`/api/v1/gateways/${gateway!.id}/networks`).bearerToken(adminToken)
  const unit = nets.body().data.find((n: any) => n.key === 'unit101')
  return { adminToken, operatorToken, gatewayId: gateway!.id, unitPerchId: unit.perchId as string }
}

async function groupSections(gatewayId: number) {
  const { states } = await loadSections(gatewayId)
  return states
    .filter((s) => s.config === 'firewall' && /^perch_g\d+/.test(s.name))
    .map((s) => ({ name: s.name, desired: s.desired?.options ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

test.group('device groups: REST', (group) => {
  group.each.setup(async () => {
    await resetAll()
  })
  group.each.teardown(async () => {
    _resetDeviceGroupsState()
    _resetApGroupsState()
    for (const a of agents) await a.close()
    agents = []
    for (const gw of gateways) await gw.destroy()
    gateways = []
    await new Promise((r) => setTimeout(r, 100))
    await gatewayQueue.drainAll()
    await new Promise((r) => setTimeout(r, 50))
  })

  test('a unit on its own VLAN: its speed limit is the network default; keys; one group per network', async ({
    client,
    assert,
  }) => {
    const env = await setup(client)
    // Operators read, never write.
    const denied = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.operatorToken)
      .json({ gatewayId: env.gatewayId, name: 'Unit 101' })
    denied.assertStatus(403)

    const created = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.adminToken)
      .json({
        gatewayId: env.gatewayId,
        name: 'Unit 101',
        networkPerchId: env.unitPerchId,
        qos: { rate: { downloadKbit: 20000, uploadKbit: 5000 } },
      })
    created.assertStatus(201)
    const unit = bodyOf(created).data
    assert.equal(unit.network.name, 'unit101')
    assert.equal(unit.network.vlanId, 101)
    assert.equal(unit.qos.via, 'network')
    assert.deepEqual(unit.qos.rate, { downloadKbit: 20000, uploadKbit: 5000 })
    const assignment = await QosAssignment.findOrFail(unit.qos.assignmentId)
    assert.equal(assignment.targetType, 'network')
    assert.equal(assignment.network, 'unit101')
    assert.equal(assignment.source, 'group')
    assert.equal(assignment.sourceRef, `device-group:${unit.id}`)

    // The network is this group's alone.
    const clash = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, name: 'Unit 102', networkPerchId: env.unitPerchId })
    clash.assertStatus(422)
    assert.equal(bodyOf(clash).error, 'group_network_taken')
    // A group with its own network has no portal to pass.
    const bypass = await client
      .patch(`/api/v1/device-groups/${unit.id}`)
      .bearerToken(env.adminToken)
      .json({ portalBypass: true })
    bypass.assertStatus(422)
    assert.equal(bodyOf(bypass).error, 'group_bypass_with_network')

    // Wi-Fi keys: generated, shown again to admins, unique per gateway.
    const key = await client
      .post(`/api/v1/device-groups/${unit.id}/keys`)
      .bearerToken(env.adminToken)
      .json({ label: 'Tenant' })
    key.assertStatus(201)
    const passphrase = bodyOf(key).data.passphrase
    assert.match(passphrase, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    const reveal = await client
      .get(`/api/v1/device-groups/${unit.id}/keys/${bodyOf(key).data.key.id}/passphrase`)
      .bearerToken(env.adminToken)
    assert.equal(bodyOf(reveal).data.passphrase, passphrase)
    const noReveal = await client
      .get(`/api/v1/device-groups/${unit.id}/keys/${bodyOf(key).data.key.id}/passphrase`)
      .bearerToken(env.operatorToken)
    noReveal.assertStatus(403)
    const again = await client
      .post(`/api/v1/device-groups/${unit.id}/keys`)
      .bearerToken(env.adminToken)
      .json({ label: 'Copy', passphrase })
    again.assertStatus(409)
    assert.equal(bodyOf(again).error, 'group_passphrase_taken')
    const stored = await db.from('device_group_keys').first()
    assert.notInclude(stored.passphrase_encrypted, passphrase, 'encrypted at rest')

    // Dropping the network while keys exist is refused.
    const drop = await client
      .patch(`/api/v1/device-groups/${unit.id}`)
      .bearerToken(env.adminToken)
      .json({ networkPerchId: null })
    drop.assertStatus(422)
    assert.equal(bodyOf(drop).error, 'group_keys_need_vlan')

    // No internet for the unit: its zone holds its network alone, so the
    // rule names the zone (IPv4 and IPv6 alike).

    const r1 = await client
      .patch(`/api/v1/device-groups/${unit.id}`)
      .bearerToken(env.adminToken)
      .json({ internet: false })
    r1.assertStatus(200)
    const unitRules = await eventually(
      () => groupSections(env.gatewayId),
      (s) => s.length === 1,
      15_000
    )
    assert.equal(unitRules[0].name, `perch_g${unit.id}_wan`)
    assert.deepInclude(unitRules[0].desired, { src: 'unit101', dest: 'wan', target: 'REJECT' })
    const applied = await eventually(
      async () => {
        const res = await client
          .get(`/api/v1/device-groups/${unit.id}`)
          .bearerToken(env.operatorToken)
        return bodyOf(res).data
      },
      (d: any) => d.firewall.state === 'applied',
      15_000
    )
    assert.isFalse(applied.internet)

    const detail = await client
      .get(`/api/v1/device-groups/${unit.id}`)
      .bearerToken(env.operatorToken)
    detail.assertStatus(200)
    assert.lengthOf(bodyOf(detail).data.keys, 1)
    assert.notProperty(bodyOf(detail).data.keys[0], 'passphrase')

    // Delete: the group's QoS assignment goes with it.
    const del = await client.delete(`/api/v1/device-groups/${unit.id}`).bearerToken(env.adminToken)
    del.assertStatus(204)
    assert.isNull(await QosAssignment.find(unit.qos.assignmentId))
    const [keysLeft] = await db.from('device_group_keys').count('* as n')
    assert.equal(Number(keysLeft.n), 0)
  })

  test('a group by MAC: members, moves, a group QoS assignment, the internet block', async ({
    client,
    assert,
  }) => {
    const env = await setup(client)
    const policy = await QosPolicy.create({
      gatewayId: env.gatewayId,
      name: 'Slow',
      eachDownKbit: 2000,
      eachUpKbit: 1000,
      fairness: 'per_host',
      includeLan: false,
      enabled: true,
      classMinor: 0x20,
      source: 'admin',
    } as Partial<QosPolicy>)
    const kidsRes = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, name: 'Kids', qos: { policyId: policy.id } })
    const kids = bodyOf(kidsRes).data
    assert.equal(kids.qos.via, 'group')
    assert.equal(kids.qos.policyId, policy.id)
    const otherRes = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, name: 'Guests' })
    const other = bodyOf(otherRes).data

    const r2 = await client
      .post(`/api/v1/device-groups/${kids.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID.toUpperCase() })
    r2.assertStatus(201)
    const taken = await client
      .post(`/api/v1/device-groups/${other.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID })
    taken.assertStatus(409)
    assert.equal(bodyOf(taken).error, 'group_mac_taken')
    assert.equal(bodyOf(taken).groupId, kids.id)
    const moved = await client
      .post(`/api/v1/device-groups/${other.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID, move: true })
    moved.assertStatus(201)
    assert.isTrue(bodyOf(moved).data.moved)
    assert.equal(bodyOf(moved).data.fromGroupId, kids.id)
    await client
      .post(`/api/v1/device-groups/${kids.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID, move: true })
    await client
      .post(`/api/v1/device-groups/${kids.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID2 })

    // The group's device.
    const of = await client.get(`/api/v1/devices/${KID}/group`).bearerToken(env.operatorToken)
    assert.equal(of.body().data.group.id, kids.id)
    assert.equal(of.body().data.via, 'bound')

    // QoS's own view of groups is the device groups.
    const qosGroups = await client
      .get(`/api/v1/qos/groups?gatewayId=${env.gatewayId}`)
      .bearerToken(env.operatorToken)
    const view = qosGroups.body().data.find((g: any) => g.id === kids.id)
    assert.deepEqual(
      view.members.map((m: any) => m.mac),
      [KID, KID2]
    )

    // No internet: an ipset of the members and a REJECT rule per WAN zone.
    const blocked = await client
      .patch(`/api/v1/device-groups/${kids.id}`)
      .bearerToken(env.adminToken)
      .json({ internet: false })
    blocked.assertStatus(200)
    assert.isFalse(bodyOf(blocked).data.internet)
    await gatewayQueue.drain(env.gatewayId)
    const sections = await eventually(
      () => groupSections(env.gatewayId),
      (s) => s.length === 2,
      15_000
    )
    assert.deepEqual(
      sections.map((s) => s.name),
      [`perch_g${kids.id}`, `perch_g${kids.id}_wan`]
    )
    assert.deepInclude(sections[0].desired, { match: 'src_mac', entry: [KID, KID2] })
    assert.deepInclude(sections[1].desired, {
      ipset: `perch_g${kids.id}`,
      dest: 'wan',
      target: 'REJECT',
    })
    // A member leaves: the set follows.

    const r3 = await client
      .delete(`/api/v1/device-groups/${kids.id}/members/${KID2}`)
      .bearerToken(env.adminToken)
    r3.assertStatus(204)
    await gatewayQueue.drain(env.gatewayId)
    const after = await eventually(
      () => groupSections(env.gatewayId),
      (s) => JSON.stringify(s[0]?.desired?.entry) === JSON.stringify([KID]),
      15_000
    )
    assert.deepEqual(after[0].desired!.entry, [KID])
    // Internet back: the sections go.
    await client
      .patch(`/api/v1/device-groups/${kids.id}`)
      .bearerToken(env.adminToken)
      .json({ internet: true })
    await gatewayQueue.drain(env.gatewayId)
    await eventually(
      () => groupSections(env.gatewayId),
      (s) => s.every((x) => x.desired === null),
      15_000
    )
    // Delete: members and the assignment go.
    const assignmentId = kids.qos.assignmentId

    const r4 = await client.delete(`/api/v1/device-groups/${kids.id}`).bearerToken(env.adminToken)
    r4.assertStatus(204)
    assert.isNull(await DeviceGroup.find(kids.id))
    assert.lengthOf(await DeviceGroupMember.query().where('groupId', kids.id), 0)
    assert.isNull(await QosAssignment.find(assignmentId))
  })

  test('settings: group SSIDs and the AP confirm window', async ({ client, assert }) => {
    const env = await setup(client)
    const get = await client.get('/api/v1/settings/device-groups').bearerToken(env.adminToken)
    assert.deepEqual(get.body().data.settings, { ssids: [], confirmSeconds: 120 })
    const bad = await client
      .patch('/api/v1/settings/device-groups')
      .bearerToken(env.adminToken)
      .json({ ssids: ['ok', 'bad\u0001'] })
    bad.assertStatus(422)
    const put = await client
      .patch('/api/v1/settings/device-groups')
      .bearerToken(env.adminToken)
      .json({ ssids: ['Apartment', 'Apartment'], confirmSeconds: 90 })
    assert.deepEqual(put.body().data.settings, { ssids: ['Apartment'], confirmSeconds: 90 })
  })

  test("access points: the groups' keys, bindings and VLANs; confirm; kicks after a binding", async ({
    client,
    assert,
  }) => {
    const env = await setup(client)
    await client
      .patch('/api/v1/settings/device-groups')
      .bearerToken(env.adminToken)
      .json({ ssids: ['Apartment'], confirmSeconds: 60 })
    const unitRes = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, name: 'Unit 101', networkPerchId: env.unitPerchId })
    const unit = bodyOf(unitRes).data
    const keyRes = await client
      .post(`/api/v1/device-groups/${unit.id}/keys`)
      .bearerToken(env.adminToken)
      .json({ label: 'Tenant', passphrase: 'unit-101-passphrase' })
    keyRes.assertStatus(201)
    const bindRes = await client
      .post(`/api/v1/device-groups/${unit.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID })
    bindRes.assertStatus(201)

    let applied = 0
    const { ap, agentId, agentSecret } = await seedAgentAp({ name: 'ap-hall' })
    const agent = await FakeAgent.connect({
      agentId,
      agentSecret,
      handlers: {
        'system.info': () => ({
          ...DEFAULT_SYSTEM_INFO,
          capabilities: [...DEFAULT_SYSTEM_INFO.capabilities, 'wifi_groups'],
        }),
        'groups.state': () => ({
          appliedRevision: applied,
          pending: null,
          trunkPort: 'wan',
          stations: [],
        }),
        'groups.apply': (p) => ({
          revision: p.revision,
          state: 'pending_confirm',
          deadline: '2026-09-24T12:02:00Z',
          trunkPort: 'wan',
          converted: false,
          managed: ['default_radio0'],
          issues: [],
        }),
        'groups.confirm': (p) => {
          applied = Number(p.revision)
          return { revision: p.revision, state: 'applied' }
        },
        'client.kick': (p) => ({ mac: p.mac, ifname: 'phy0-ap0', banTimeMs: 0 }),
      },
    })
    agents.push(agent)
    const apply = await agent.waitFor('groups.apply', 5000)
    assert.deepEqual(apply.params, {
      confirmSeconds: 60,
      ssids: ['Apartment'],
      vlans: [{ vid: 101 }],
      stations: [
        { key: 'unit-101-passphrase', vid: 101 },
        { vid: 101, macs: [KID] },
      ],
      trunk: 'auto',
      revision: 1,
    })
    await agent.waitFor('groups.confirm', 5000)
    const states = await eventually(
      async () => {
        const res = await client.get('/api/v1/device-groups/aps').bearerToken(env.operatorToken)
        return res.body().data
      },
      (list: any[]) => list[0]?.state === 'applied',
      5000
    )
    assert.include(states[0], {
      apId: ap.id,
      supported: true,
      revision: 1,
      appliedRevision: 1,
      trunkPort: 'wan',
    })

    // A portal binding: the AP is already in line, the device is kicked.
    requestApGroupsSync('portal binding', { kick: [KID] })
    const kicked = await agent.waitFor('client.kick', 5000)
    assert.deepEqual(kicked.params, { mac: KID, banTimeMs: 0 })
    // Nothing changed: no second apply.
    assert.lengthOf(
      agent.calls.filter((c) => c.method === 'groups.apply'),
      1
    )

    // A trunk chosen by hand is a new state.
    const trunk = await client
      .patch(`/api/v1/device-groups/aps/${ap.id}`)
      .bearerToken(env.adminToken)
      .json({ trunk: 'lan4' })
    trunk.assertStatus(200)
    const second = await agent.waitForCount('groups.apply', 2, 5000)
    assert.equal(second[1].params.trunk, 'lan4')
    assert.equal(second[1].params.revision, 2)
  })
  test('an AP that refuses a binding is not sent it again; a new daemon version is', async ({
    client,
    assert,
  }) => {
    const env = await setup(client)
    await client
      .patch('/api/v1/settings/device-groups')
      .bearerToken(env.adminToken)
      .json({ ssids: ['Apartment'], confirmSeconds: 60 })
    const unitRes = await client
      .post('/api/v1/device-groups')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, name: 'Unit 101', networkPerchId: env.unitPerchId })
    const unit = bodyOf(unitRes).data
    const bound = await client
      .post(`/api/v1/device-groups/${unit.id}/members`)
      .bearerToken(env.adminToken)
      .json({ mac: KID })
    bound.assertStatus(201)

    const { ap, agentId, agentSecret } = await seedAgentAp({ name: 'ap-hall' })
    let version = '1.1.0-pre.1'
    const handlers = {
      'system.info': () => ({
        ...DEFAULT_SYSTEM_INFO,
        agentVersion: version,
        capabilities: [...DEFAULT_SYSTEM_INFO.capabilities, 'wifi_groups'],
      }),
      'groups.state': () => ({ appliedRevision: 0, pending: null, trunkPort: 'wan', stations: [] }),
      'groups.apply': (p: Record<string, unknown>) => ({
        revision: p.revision,
        state: 'pending_confirm',
        trunkPort: 'wan',
        converted: false,
      }),
      'groups.confirm': () => {
        throw new RpcFailure(
          -32002,
          'rolled back: hostapd-phy0-ap0.psk gives the passphrase to every client',
          {
            error: 'unsafe_binding',
          }
        )
      },
    }
    const first = await FakeAgent.connect({ agentId, agentSecret, handlers })
    agents.push(first)
    await first.waitFor('groups.confirm', 5000)
    const failed = await eventually(
      async () => {
        const res = await client.get('/api/v1/device-groups/aps').bearerToken(env.adminToken)
        return res.body().data
      },
      (list: any[]) => list[0]?.state === 'failed',
      5000
    )
    assert.match(String(failed[0].error), /^unsafe_binding/)

    // The two-minute sweep: the same state and daemon, nothing is sent.
    await syncAllApGroups()
    assert.lengthOf(
      first.calls.filter((c) => c.method === 'groups.apply'),
      1
    )

    // The daemon is upgraded: the same groups are sent again.
    await first.close()
    version = '1.1.0-pre.2'
    const second = await FakeAgent.connect({ agentId, agentSecret, handlers })
    agents.push(second)
    const again = await second.waitFor('groups.apply', 5000)
    assert.equal(again.params.revision, 2)
    assert.deepEqual(again.params.stations, [{ vid: 101, macs: [KID] }])
    await ap.refresh()
    assert.equal(ap.agentVersion, '1.1.0-pre.2')
  })
})

/** Response bodies as untyped JSON (the registry types some of these routes as `void | …`). */
function bodyOf(response: { body(): unknown }): any {
  return response.body()
}
