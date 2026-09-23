import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayNetwork from '#models/gateway_network'
import SystemSetting from '#models/system_setting'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetPollerState, ingestCollectorSnapshot } from '#services/collector_poller'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { _resetNetworkAccountingState } from '#services/gateway_network_accounting'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { device, reading, TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type FakeGatewayOptions, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * Networks end to end (docs/gateway/networks.md): the networks REST over
 * the config plane against a scripted gateway agent (a VLAN on an existing
 * VLAN bridge with its DHCP pool in one apply; converting the management
 * bridge in a protected apply with the longer window; edits, deletes and
 * refusals), the per-network capture toggle (agent.configure and the
 * ingest guard), and the accounting fed by the collector's reports
 * (30 s samples and rates, the scope-change marker, device networks on
 * change only, the history endpoints, device rows' `network`).
 */

const PASSWORD = 'admin-pass-123'
const LAN_MAC = '02:00:00:00:00:51'
const GUEST_MAC = '02:00:00:00:00:52'

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
        options: { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3'] },
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
        name: 'guest_dev',
        type: 'device',
        options: { name: 'br-guest', type: 'bridge', ports: ['lan4'] },
      },
      {
        name: 'guest',
        type: 'interface',
        options: { device: 'br-guest', proto: 'static', ipaddr: ['192.168.3.1/24'] },
      },
      {
        name: 'trunk_dev',
        type: 'device',
        options: { name: 'br-trunk', type: 'bridge', ports: ['trunk'] },
      },
      {
        name: 'trunk_v110',
        type: 'bridge-vlan',
        options: { device: 'br-trunk', vlan: '110', ports: ['trunk:t'] },
      },
      {
        name: 'vlan110',
        type: 'interface',
        options: {
          device: 'br-trunk.110',
          proto: 'static',
          ipaddr: '192.168.110.1',
          netmask: '255.255.255.0',
        },
      },
      { name: 'wan', type: 'interface', options: { device: 'wan', proto: 'dhcp' } },
    ],
    dhcp: [
      {
        name: 'cfg01411c',
        type: 'dnsmasq',
        anonymous: true,
        options: { domainneeded: '1', local: '/lan/' },
      },
      {
        name: 'lan',
        type: 'dhcp',
        options: { interface: 'lan', start: '100', limit: '150', leasetime: '12h' },
      },
      {
        name: 'guest',
        type: 'dhcp',
        options: { interface: 'guest', start: '50', limit: '100', leasetime: '1h' },
      },
      { name: 'wan', type: 'dhcp', options: { interface: 'wan', ignore: '1' } },
    ],
    firewall: [
      {
        name: 'cfg02dc81',
        type: 'zone',
        anonymous: true,
        options: { name: 'lan', network: ['lan', 'vlan110'], input: 'ACCEPT' },
      },
      {
        name: 'cfg03dc81',
        type: 'zone',
        anonymous: true,
        options: { name: 'guest', network: ['guest'], input: 'REJECT' },
      },
      {
        name: 'cfg04dc81',
        type: 'zone',
        anonymous: true,
        options: { name: 'wan', network: ['wan'], masq: '1', input: 'REJECT' },
      },
    ],
  }
}

function netReport(overrides: Record<string, Record<string, unknown>> = {}, scope = 'routed') {
  const base = (name: string, dev: string, cidr: string, rx: number, tx: number) => ({
    name,
    device: dev,
    proto: 'static',
    up: true,
    ipv4: [cidr],
    ipv6: [],
    rxBytes: rx,
    txBytes: tx,
    rxRate: rx / 100,
    txRate: tx / 100,
    captured: true,
    devices: 1,
    activeDevices: 1,
    capture: {
      bytesInWan: 10,
      bytesOutWan: 20,
      bytesInLan: 30,
      bytesOutLan: 40,
      packetsInWan: 1,
      packetsOutWan: 2,
      packetsInLan: 3,
      packetsOutLan: 4,
      scope,
      kernelDrops: 0,
    },
    ...(overrides[name] ?? {}),
  })
  return [
    base('lan', 'br-lan', '192.168.1.1/24', 1_000_000, 4_000_000),
    base('guest', 'br-guest', '192.168.3.1/24', 100_000, 200_000),
    base('vlan110', 'br-trunk.110', '192.168.110.1/24', 5000, 6000),
    {
      name: 'office',
      device: '',
      proto: 'static',
      up: false,
      ipv4: [],
      ipv6: [],
      captured: false,
      devices: 0,
      activeDevices: 0,
    },
  ]
}

let gateways: FakeGateway[] = []

async function resetAll() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetAnnounceState()
  _resetApAgentRateLimits()
  _resetCollectorAgentState()
  _resetPollerState()
  _resetRouterState()
  _resetGatewaySessions()
  _resetNetworkAccountingState()
  resetDeviceLabelCacheForTesting()
}

type Env = {
  adminToken: string
  operatorToken: string
  collector: Collector
  gw: FakeGateway
  gatewayId: number
}

async function setup(options: FakeGatewayOptions = {}): Promise<Env> {
  const { adminToken, operatorToken } = await seedSetupComplete()
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
  const gw = new FakeGateway({ configs: routerConfigs(), ...options })
  gateways.push(gw)
  await gw.connect()
  const gateway = await eventually(
    () => Gateway.findBy('collector_id', collector.id),
    (g) => g !== null
  )
  return { adminToken, operatorToken, collector, gw, gatewayId: gateway!.id }
}

async function toManaged(client: any, env: Env) {
  const r = await client
    .patch(`/api/v1/gateways/${env.gatewayId}`)
    .bearerToken(env.adminToken)
    .json({ mode: 'managed', currentPassword: PASSWORD })
  r.assertStatus(200)
  await gatewayQueue.drain(env.gatewayId)
}

async function listData(client: any, env: Env): Promise<any[]> {
  const r = await client
    .get(`/api/v1/gateways/${env.gatewayId}/networks`)
    .bearerToken(env.operatorToken)
  return r.body().data
}

/** One push with the networks report (and devices tagged with their network). */
function pushNetworks(env: Env, networks: unknown[], devices = [] as ReturnType<typeof device>[]) {
  env.gw.collector!.notifyServer(
    'collector.push',
    reading(devices, { seq: env.gw.seq++, gateway: { networks, wan: [] } })
  )
}

async function waitApply(key: string, states: string[], timeout = 6000) {
  return eventually(
    () => GatewayApply.findByOrFail('apply_key', key),
    (a) => states.includes(a.state),
    timeout
  )
}

test.group('gateway networks: REST over the config plane', (group) => {
  group.each.setup(async () => {
    await resetAll()
  })
  group.each.teardown(async () => {
    for (const gw of gateways) await gw.destroy()
    gateways = []
    await new Promise((r) => setTimeout(r, 100))
    await gatewayQueue.drainAll()
    await new Promise((r) => setTimeout(r, 50))
  })

  test('list: config ∪ report with live counters and metadata rows; writes admin-only', async ({
    client,
    assert,
  }) => {
    const env = await setup({ secure: true })
    await toManaged(client, env)
    pushNetworks(env, netReport())
    await eventually(
      () => listData(client, env),
      (data: any[]) => data?.some((n) => n.key === 'office' && n.live !== null)
    )
    const list = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.operatorToken)
    list.assertStatus(200)
    const byKey = new Map<string, any>(list.body().data.map((n: any) => [n.key, n]))
    assert.deepEqual([...byKey.keys()], ['lan', 'guest', 'vlan110', 'office'])
    const lan = byKey.get('lan')
    assert.equal(lan.l2Mode, 'bridge')
    assert.equal(lan.owner, 'perch')
    assert.isTrue(lan.management)
    assert.equal(lan.purpose, 'lan')
    assert.equal(lan.dhcp.start, 100)
    assert.equal(lan.firewallZone, 'lan')
    assert.equal(lan.live.rxBps, 80_000)
    assert.equal(lan.live.downloadBps, 320_000)
    assert.equal(lan.live.capture.scope, 'routed')
    const v110 = byKey.get('vlan110')
    assert.equal(v110.l2Mode, 'bridge_vlan')
    assert.equal(v110.vlanId, 110)
    assert.deepEqual(v110.ports, [{ port: 'trunk', tagged: true, pvid: false }])
    const office = byKey.get('office')
    assert.isNull(office.owner, 'known from the report alone')
    assert.isFalse(office.live.up)
    assert.equal(byKey.get('guest').purpose, 'guest')
    assert.lengthOf(await GatewayNetwork.query().where('gateway_id', env.gatewayId), 4)

    const one = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks/${lan.id}`)
      .bearerToken(env.operatorToken)
    one.assertStatus(200)
    assert.equal(one.body().data.key, 'lan')
    const missing = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks/99999`)
      .bearerToken(env.operatorToken)
    missing.assertStatus(404)
    missing.assertBodyContains({ error: 'network_not_found' })

    const forbidden = await client
      .post(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.operatorToken)
      .json({ key: 'x', l2Mode: 'device', parentDevice: 'eth9' })
    forbidden.assertStatus(403)

    const all = await client.get('/api/v1/networks').bearerToken(env.operatorToken)
    all.assertStatus(200)
    const guest = all.body().data.find((n: any) => n.key === 'guest')
    assert.deepInclude(guest, {
      gatewayId: env.gatewayId,
      purpose: 'guest',
      ipv4: '192.168.3.1/24',
    })
  })

  test('a VLAN on an existing VLAN bridge with its DHCP pool: one apply, confirmed', async ({
    client,
    assert,
  }) => {
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.adminToken)
      .json({
        key: 'cams',
        label: 'Cameras',
        purpose: 'iot',
        l2Mode: 'bridge_vlan',
        bridge: 'br-trunk',
        vlanId: 130,
        ports: [{ port: 'trunk', tagged: true, pvid: false }],
        ipv4: '192.168.130.1/24',
        dhcp: { start: 100, limit: 50, leaseTime: '12h' },
        capture: false,
      })
    created.assertStatus(201)
    const body = created.body().data
    assert.isNull(body.applyError)
    assert.isNull(body.converted)
    assert.equal(body.object.label, 'Cameras')
    assert.equal(body.object.purpose, 'iot')
    assert.isFalse(body.object.capture)
    assert.equal(body.object.vlanId, 130)
    assert.oneOf(body.object.status, ['pending', 'ahead'])
    assert.isFalse(body.apply.protected)
    assert.sameMembers(body.apply.configs, ['network', 'dhcp'])

    await waitApply(body.apply.id, ['pending_confirm'])
    await eventually(
      () => GatewayApply.findByOrFail('apply_key', body.apply.id),
      (a) => a.agentConfirmedAt !== null,
      5000
    )
    const keep = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies/${body.apply.id}/confirm`)
      .bearerToken(env.adminToken)
    keep.assertStatus(200)
    await waitApply(body.apply.id, ['confirmed'])

    const bv = env.gw.configs.network.find(
      (s) => s.type === 'bridge-vlan' && s.options.vlan === '130'
    )!
    assert.deepEqual(bv.options, { device: 'br-trunk', vlan: '130', ports: ['trunk:t'] })
    const iface = env.gw.configs.network.find((s) => s.name === 'cams')!
    assert.deepEqual(iface.options, {
      device: 'br-trunk.130',
      proto: 'static',
      ipaddr: '192.168.130.1',
      netmask: '255.255.255.0',
    })
    const pool = env.gw.configs.dhcp.find((s) => s.name === 'cams')!
    assert.deepEqual(pool.options, {
      interface: 'cams',
      start: '100',
      limit: '50',
      leasetime: '12h',
    })
    assert.includeMembers(
      env.gw.ledger.map((e) => e.section),
      ['cams', bv.name]
    )
    assert.equal(env.gw.ledger.find((e) => e.section === 'cams')!.domain, 'networks')
    // The capture flag went out at once: agent.configure carries it.
    const configure = env.gw.collector!.lastConfigure() as any
    assert.deepEqual(configure.capture, { exclude: ['cams'] })

    const after = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks/${body.object.id}`)
      .bearerToken(env.operatorToken)
    assert.equal(after.body().data.status, 'in_sync')
    assert.equal(after.body().data.dhcp.owner, 'perch')
  })

  test('firewall zones: a new network, its pool and its own zone in one apply; move; delete', async ({
    client,
    assert,
  }) => {
    await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const fw = () => env.gw.configs.firewall
    const zoneNamed = (name: string) =>
      fw().find((s) => s.type === 'zone' && s.options.name === name)
    const wordsIn = (v: unknown) =>
      Array.isArray(v) ? v : typeof v === 'string' ? v.split(' ') : []
    /** Every job of the gateway confirmed (an adopted router section rides in a job of its own). */
    const settled = async (routerHas: () => boolean) => {
      await eventually(async () => routerHas(), Boolean, 10_000)
      await eventually(
        () => GatewayApply.query().where('gateway_id', env.gatewayId),
        (rows) => rows.every((a) => a.state === 'confirmed'),
        10_000
      )
    }
    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.adminToken)
      .json({
        key: 'iot',
        purpose: 'iot',
        l2Mode: 'bridge_vlan',
        bridge: 'br-trunk',
        vlanId: 140,
        ports: [{ port: 'trunk', tagged: true, pvid: false }],
        ipv4: '192.168.140.1/24',
        dhcp: { start: 100, limit: 50, leaseTime: '12h' },
        firewallZone: 'iot',
        createZone: true,
      })
    created.assertStatus(201)
    const body = created.body().data
    assert.isNull(body.applyError)
    assert.sameMembers(body.apply.configs, ['network', 'dhcp', 'firewall'])
    await settled(() => zoneNamed('iot') !== undefined)
    const applies = await GatewayApply.query().where('gateway_id', env.gatewayId)
    assert.lengthOf(applies, 1, 'network, pool and zone went in one apply')

    assert.deepEqual(zoneNamed('iot')!.options, {
      name: 'iot',
      network: ['iot'],
      input: 'REJECT',
      output: 'ACCEPT',
      forward: 'REJECT',
    })
    assert.isTrue(
      fw().some(
        (s) => s.type === 'forwarding' && s.options.src === 'iot' && s.options.dest === 'wan'
      ),
      'a forwarding to the WAN zone'
    )
    assert.sameMembers(
      fw()
        .filter((s) => s.type === 'rule' && s.options.src === 'iot')
        .map((s) => s.options.name),
      ['Iot-DHCP', 'Iot-DNS']
    )
    assert.equal(body.object.firewallZone, 'iot')

    // Move it into the lan zone: out of iot, into lan, one apply.
    const moved = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/networks/${body.object.id}`)
      .bearerToken(env.adminToken)
      .json({ firewallZone: 'lan' })
    moved.assertStatus(200)
    const movedBody = moved.body().data
    // The iot zone's change, then the router's lan zone adopted and extended.
    assert.deepEqual(
      movedBody.apply.changes.map((c: any) => c.type),
      ['zone']
    )
    await settled(() => wordsIn(zoneNamed('lan')?.options.network).includes('iot'))
    assert.deepEqual(zoneNamed('lan')!.options.network, ['lan', 'vlan110', 'iot'])
    assert.isUndefined(zoneNamed('iot')!.options.network, 'the emptied list goes')
    const view = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks/${body.object.id}`)
      .bearerToken(env.operatorToken)
    assert.equal(view.body().data.firewallZone, 'lan')

    // Nothing to change: no apply.
    const same = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/networks/${body.object.id}`)
      .bearerToken(env.adminToken)
      .json({ firewallZone: 'lan' })
    same.assertStatus(200)
    assert.isNull(same.body().data.apply)

    // Delete: the network leaves the lan zone in the same apply.
    const removed = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/networks/${body.object.id}`)
      .bearerToken(env.adminToken)
    removed.assertStatus(200)
    const removedBody = removed.body().data
    assert.include(removedBody.apply.configs, 'network')
    await settled(() => !wordsIn(zoneNamed('lan')?.options.network).includes('iot'))
    assert.deepEqual(zoneNamed('lan')!.options.network, ['lan', 'vlan110'])
    assert.isUndefined(env.gw.configs.network.find((s) => s.name === 'iot'))
  })

  test('converting the management bridge goes in its own protected apply, longer window', async ({
    client,
    assert,
  }) => {
    await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.adminToken)
      .json({
        key: 'iot2',
        l2Mode: 'bridge_vlan',
        bridge: 'br-lan',
        vlanId: 40,
        ports: [
          { port: 'lan3', tagged: false, pvid: true },
          { port: 'lan1', tagged: true, pvid: false },
        ],
        ipv4: '192.168.40.1/24',
      })
    created.assertStatus(201)
    const body = created.body().data
    assert.deepEqual(body.converted, { bridge: 'br-lan', untaggedVlan: 1, moved: ['lan'] })
    // First the ordinary job (the new interface), then the protected one.
    assert.isFalse(body.apply.protected)
    await waitApply(body.apply.id, ['confirmed'])
    const guarded = await eventually(
      () =>
        GatewayApply.query().where('gateway_id', env.gatewayId).where('protected', true).first(),
      (a) => a !== null && a.state === 'confirmed',
      10_000
    )
    const sent = env.gw.calls.filter((c) => c.method === 'gateway.config.apply')
    const firstCall = sent.find((c) => c.params.applyId === body.apply.id)!
    assert.equal(firstCall.params.confirmTimeoutSeconds, 90)
    assert.isUndefined(firstCall.params.protected)
    const protectedCall = sent.find((c) => c.params.applyId === guarded!.applyKey)!
    assert.isTrue(protectedCall.params.protected as boolean)
    assert.equal(protectedCall.params.confirmTimeoutSeconds, 300)
    const ops = protectedCall.params.ops as Array<Record<string, any>>
    assert.isTrue(ops.some((op) => op.op === 'put' && op.section === 'lan'))
    assert.isFalse(ops.some((op) => op.section === 'iot2'))

    const lan = env.gw.configs.network.find((s) => s.name === 'lan')!
    assert.equal(lan.options.device, 'br-lan.1')
    const vlans = env.gw.configs.network
      .filter((s) => s.type === 'bridge-vlan' && s.options.device === 'br-lan')
      .map((s) => s.options)
    assert.sameDeepMembers(vlans, [
      { device: 'br-lan', vlan: '1', ports: ['lan1:u*', 'lan2:u*'] },
      { device: 'br-lan', vlan: '40', ports: ['lan3:u*', 'lan1:t'] },
    ])
    const list = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.operatorToken)
    const lanView = list.body().data.find((n: any) => n.key === 'lan')
    assert.equal(lanView.l2Mode, 'bridge_vlan')
    assert.equal(lanView.vlanId, 1)
    assert.equal(lanView.status, 'in_sync')
  })

  test('edit and delete; refusals', async ({ client, assert }) => {
    const env = await setup({ secure: true })
    const observeOnly = await client
      .post(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.adminToken)
      .json({ key: 'x', l2Mode: 'device', parentDevice: 'eth9' })
    observeOnly.assertStatus(409)
    observeOnly.assertBodyContains({ error: 'not_managed' })
    await toManaged(client, env)
    const list = await client
      .get(`/api/v1/gateways/${env.gatewayId}/networks`)
      .bearerToken(env.adminToken)
    const byKey = new Map<string, any>(list.body().data.map((n: any) => [n.key, n]))

    const post = (json: Record<string, unknown>) =>
      client
        .post(`/api/v1/gateways/${env.gatewayId}/networks?apply=0`)
        .bearerToken(env.adminToken)
        .json({
          l2Mode: 'bridge_vlan',
          bridge: 'br-trunk',
          ports: [{ port: 'trunk', tagged: true, pvid: false }],
          ...json,
        })
    const inUse = await post({ key: 'x', vlanId: 110 })
    inUse.assertStatus(422)
    inUse.assertBodyContains({ error: 'vlan_in_use' })
    const overlap = await post({ key: 'x', vlanId: 111, ipv4: '192.168.1.200/24' })
    overlap.assertStatus(422)
    overlap.assertBodyContains({ error: 'subnet_overlap', network: 'lan' })
    const zone = await post({ key: 'x', vlanId: 111, firewallZone: 'nope' })
    zone.assertStatus(422)
    zone.assertBodyContains({ error: 'firewall_zone_unknown' })
    const taken = await post({ key: 'x', vlanId: 111, firewallZone: 'guest', createZone: true })
    taken.assertStatus(409)
    taken.assertBodyContains({ error: 'firewall_zone_exists' })
    const pvid = await post({
      key: 'x',
      vlanId: 111,
      ports: [{ port: 'trunk', tagged: false, pvid: true }],
    })
    pvid.assertStatus(201)
    assert.deepEqual(pvid.body().data.issues, [], 'no ports reported yet: nothing to check')
    // Ports the gateway reports (infrastructure view): an unknown one is a warning.
    const [nodeId] = await db.table('infra_nodes').insert({
      kind: 'gateway',
      origin: 'agent',
      collector_id: env.collector.id,
      created_at: DateTime.utc().toSQL({ includeOffset: false }),
      updated_at: DateTime.utc().toSQL({ includeOffset: false }),
    })
    await db.table('infra_ports').insert({
      node_id: nodeId,
      port_key: 'trunk',
      origin: 'agent',
      created_at: DateTime.utc().toSQL({ includeOffset: false }),
      updated_at: DateTime.utc().toSQL({ includeOffset: false }),
    })
    const warned = await post({
      key: 'z',
      vlanId: 114,
      ports: [
        { port: 'trunk', tagged: true, pvid: false },
        { port: 'trunk9', tagged: true, pvid: false },
      ],
    })
    warned.assertStatus(201)
    assert.deepEqual(
      warned.body().data.issues.map((i: any) => [i.code, i.severity]),
      [['port_unknown', 'warning']]
    )
    const clash = await post({
      key: 'y',
      vlanId: 112,
      ports: [{ port: 'trunk', tagged: false, pvid: true }],
    })
    clash.assertStatus(422)
    clash.assertBodyContains({ error: 'port_pvid_conflict', port: 'trunk' })
    const bad = await post({ key: 'Nope', vlanId: 113 })
    bad.assertStatus(422)
    bad.assertBodyContains({ error: 'network_key_invalid' })

    const mgmt = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/networks/${byKey.get('lan').id}`)
      .bearerToken(env.adminToken)
    mgmt.assertStatus(409)
    mgmt.assertBodyContains({ error: 'management_network' })

    // Edit: address and pool of vlan110 (a new pool), then drop guest.
    const edit = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/networks/${byKey.get('vlan110').id}?apply=0`)
      .bearerToken(env.adminToken)
      .json({
        ipv4: '192.168.111.1/24',
        dhcp: { start: 20, limit: 30, leaseTime: '4h' },
        label: 'Trunk 110',
      })
    edit.assertStatus(200)
    const edited = edit.body().data
    assert.isNull(edited.apply)
    assert.equal(edited.object.ipv4, '192.168.111.1/24')
    assert.equal(edited.object.label, 'Trunk 110')
    assert.equal(edited.object.dhcp.start, 20)
    assert.equal(edited.object.status, 'ahead')

    const drop = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/networks/${byKey.get('guest').id}?apply=0`)
      .bearerToken(env.adminToken)
    drop.assertStatus(200)
    assert.isTrue(drop.body().data.object.deleting)
    const draft = await client
      .get(`/api/v1/gateways/${env.gatewayId}/draft`)
      .bearerToken(env.adminToken)
    const deleted = draft
      .body()
      .data.changes.filter((c: any) => c.action === 'delete')
      .map((c: any) => c.section)
    assert.sameMembers(deleted, ['guest', 'guest_dev', 'guest'])
    const events = await client
      .get(`/api/v1/gateways/${env.gatewayId}/events`)
      .bearerToken(env.adminToken)
    assert.include(
      events.body().data.items.map((e: any) => e.event),
      'network_labelled'
    )
  })

  test('capture toggle in mode off: configure carries it, devices on it are not stored', async ({
    client,
    assert,
  }) => {
    const env = await setup({ secure: true })
    pushNetworks(env, netReport())
    const list = await eventually(
      () => listData(client, env),
      (data) => data?.some((n) => n.key === 'guest')
    )
    const guest = list.find((n) => n.key === 'guest')
    assert.isNull(guest.owner, 'mode off: known from the report')
    assert.isTrue(guest.capture)

    const toggle = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/networks/${guest.id}`)
      .bearerToken(env.adminToken)
      .json({ capture: false })
    toggle.assertStatus(200)
    assert.isFalse(toggle.body().data.object.capture)
    assert.isNotNull(toggle.body().data.object.captureChangedAt)
    const configure = await eventually(
      () => env.gw.collector!.lastConfigure() as any,
      (c) => c?.capture?.exclude?.length === 1
    )
    assert.deepEqual(configure.capture, { exclude: ['guest'] })
    const refused = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/networks/${guest.id}`)
      .bearerToken(env.adminToken)
      .json({ ipv4: '192.168.9.1/24' })
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'not_managed' })

    const tagged = (mac: string, network: string, bytes: number) => ({
      ...device(mac, { bytesIn: bytes, bytesOut: bytes }),
      network,
      networks: [network],
    })
    for (let i = 1; i <= 3; i++) {
      pushNetworks(env, netReport(), [
        tagged(LAN_MAC, 'lan', i * 1000),
        tagged(GUEST_MAC, 'guest', i * 1000),
      ])
      await new Promise((r) => setTimeout(r, 150))
    }
    await eventually(
      () => db.from('device_network_latest').where('mac', LAN_MAC).first(),
      (row) => Boolean(row)
    )
    assert.notExists(await db.from('device_network_latest').where('mac', GUEST_MAC).first())
    assert.notExists(await db.from('device_identities').where('mac', GUEST_MAC).first())
    assert.exists(await db.from('device_identities').where('mac', LAN_MAC).first())
  })
})

test.group('gateway networks: accounting', (group) => {
  group.each.setup(async () => {
    await resetAll()
  })

  async function gatewayCollector() {
    const tokens = await seedSetupComplete()
    const collector = await Collector.create({
      name: 'gateway',
      baseUrl: 'http://192.168.1.1:9800',
      transport: 'poll',
      source: 'manual',
      lifecycle: 'adopted',
      enabled: true,
      pollIntervalSeconds: 5,
      apiKey: null,
      lastStatus: null,
    })
    const gateway = await Gateway.create({
      collectorId: collector.id,
      mode: 'off',
      authoritative: false,
      enforcement: 'active',
      headRevision: 0,
      syncState: 'unknown',
    })
    return { ...tokens, collector, gateway }
  }

  test('30 s samples with rates, scope changes once, device networks on change only', async ({
    client,
    assert,
  }) => {
    const { collector, gateway, operatorToken } = await gatewayCollector()
    const t0 = DateTime.utc().minus({ minutes: 10 }).startOf('minute')
    const snap = (rx: number, scope: string, network: string, bytes: number) => ({
      summary: { started_at: '2026-09-21T10:00:00Z', total_devices: 1 },
      meta: { capture_interface: 'br-lan,br-guest' },
      devices: [
        { ...device(LAN_MAC, { bytesIn: bytes, bytesOut: bytes }), network, networks: [network] },
      ],
      gateway: {
        wan: [],
        networks: netReport({ lan: { rxBytes: rx, txBytes: rx * 2 } }, scope),
      },
    })
    const ingest = async (
      seconds: number,
      rx: number,
      scope: string,
      network: string,
      bytes: number
    ) => {
      const s = snap(rx, scope, network, bytes)
      const outcome = await ingestCollectorSnapshot(collector, s, { now: t0.plus({ seconds }) })
      assert.notEqual(outcome.status, 'failed', JSON.stringify(outcome))
    }
    await ingest(0, 1_000_000, 'legacy', 'lan', 1000)
    await ingest(5, 1_100_000, 'legacy', 'lan', 2000) // inside 30 s: no sample
    await ingest(30, 1_375_000, 'routed', 'lan', 3000) // +375 kB in 30 s = 100 kbit/s
    await ingest(60, 500, 'routed', 'guest', 4000) // counter reset: no rate
    await ingest(90, 375_500, 'routed', 'guest', 5000)

    const samples = await db
      .from('gateway_network_samples')
      .where('gateway_id', gateway.id)
      .where('network', 'lan')
      .orderBy('recorded_at')
    assert.deepEqual(
      samples.map((s: any) => [Number(s.rx_bytes), s.rx_bps === null ? null : Number(s.rx_bps)]),
      [
        [1_000_000, null],
        [1_375_000, 100_000],
        [500, null],
        [375_500, 100_000],
      ]
    )
    assert.equal(Number(samples[1].tx_bps), 200_000)
    const changes = await db
      .from('gateway_scope_changes')
      .where('gateway_id', gateway.id)
      .orderBy('id')
    assert.deepEqual(
      changes.map((c: any) => c.scope),
      ['legacy', 'routed']
    )
    const history = await db.from('device_network_history').where('mac', LAN_MAC).orderBy('id')
    assert.deepEqual(
      history.map((h: any) => [h.network, h.ended_at === null]),
      [
        ['lan', false],
        ['guest', true],
      ]
    )
    const latest = await db.from('device_network_latest').where('mac', LAN_MAC)
    assert.lengthOf(latest, 1)
    assert.equal(latest[0].network, 'guest')

    const hist = await client
      .get(`/api/v1/gateways/${gateway.id}/networks/history`)
      .qs({
        from: t0.minus({ minutes: 1 }).toISO(),
        to: t0.plus({ minutes: 5 }).toISO(),
        resolution: '1m',
        network: 'lan',
      })
      .bearerToken(operatorToken)
    hist.assertStatus(200)
    const data = hist.body().data
    assert.equal(data.resolutionSeconds, 60)
    assert.lengthOf(data.networks, 1)
    assert.equal(data.networks[0].network, 'lan')
    const points = data.networks[0].points
    assert.isAbove(points.length, 1)
    assert.equal(Math.max(...points.map((p: any) => p.rxPeakBps ?? 0)), 100_000)
    assert.deepEqual(
      data.scopeChanges.map((c: any) => c.scope),
      ['legacy', 'routed']
    )
    assert.isNull(data.scopeAtStart)
    const marks = await client.get('/api/v1/networks/scope-changes').bearerToken(operatorToken)
    assert.equal(marks.body().data[1].scope, 'routed')
    assert.equal(marks.body().data[1].gatewayId, gateway.id)
    assert.equal(
      DateTime.fromISO(marks.body().data[1].changedAt).toMillis(),
      t0.plus({ seconds: 30 }).toMillis()
    )

    const devices = await client
      .get('/api/v1/devices')
      .qs({ range: '1h' })
      .bearerToken(operatorToken)
    devices.assertStatus(200)
    const row = devices.body().data.find((d: any) => d.mac === LAN_MAC)
    assert.deepInclude(row!.network, { gatewayId: gateway.id, name: 'guest' })
    const mine = await client.get(`/api/v1/devices/${LAN_MAC}/networks`).bearerToken(operatorToken)
    mine.assertStatus(200)
    assert.equal(mine.body().data.latest.network, 'guest')
    assert.deepEqual(
      mine.body().data.history.map((h: any) => h.network),
      ['guest', 'lan']
    )

    // A report without `networks` touches nothing.
    await ingestCollectorSnapshot(
      collector,
      { summary: { started_at: '2026-09-21T10:00:00Z' }, devices: [], gateway: { wan: [] } },
      { now: t0.plus({ seconds: 150 }) }
    )
    assert.lengthOf(await db.from('gateway_network_samples').where('network', 'lan'), 4)
  })
})
