import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewaySection from '#models/gateway_section'
import SystemSetting from '#models/system_setting'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetPollerState } from '#services/collector_poller'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { writeObservationRow } from '#services/gateway_observation_common'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type FakeGatewayOptions, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * The rest of native OpenWrt sync (docs/gateway/native-sync.md; plan 2
 * phase 4) against the scripted gateway agent: DHCP pool options and tags,
 * DNS settings with item ownership and the controller-name pin, static
 * routes with the management-path guard, the system section, two-way
 * imports (T-S1, T-R1) and the per-feature "in sync" checks that gate
 * Authoritative Mode (plan 2 section 4.6).
 */

const PASSWORD = 'admin-pass-123'
const TABLET_MAC = '02:00:00:00:10:21'
const anon = { anonymous: true }

function routerConfigs(): Record<string, Section[]> {
  return {
    system: [
      {
        name: 'cfg01e48a',
        type: 'system',
        ...anon,
        options: { hostname: 'gateway', timezone: 'UTC', zonename: 'UTC', log_size: '128' },
      },
      {
        name: 'ntp',
        type: 'timeserver',
        options: { enabled: '1', enable_server: '0', server: ['0.openwrt.pool.ntp.org'] },
      },
      { name: 'led_wan', type: 'led', options: { name: 'WAN', sysfs: 'green:wan' } },
    ],
    network: [
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
        name: 'guest',
        type: 'interface',
        options: {
          device: 'br-guest',
          proto: 'static',
          ipaddr: '192.168.30.1',
          netmask: '255.255.255.0',
        },
      },
      { name: 'wan', type: 'interface', options: { device: 'eth1', proto: 'dhcp' } },
      {
        name: 'cfg0a1b2c',
        type: 'route',
        ...anon,
        options: {
          interface: 'lan',
          target: '192.168.50.0',
          netmask: '255.255.255.0',
          gateway: '192.168.1.254',
        },
      },
      {
        name: 'cfg0b1b2c',
        type: 'rule',
        ...anon,
        options: { src: '192.168.30.0/24', lookup: '100', priority: '1000' },
      },
    ],
    dhcp: [
      {
        name: 'cfg01411c',
        type: 'dnsmasq',
        ...anon,
        options: {
          domainneeded: '1',
          rebind_protection: '1',
          local: '/lan/',
          domain: 'lan',
          port: '54',
          server: ['203.0.113.53'],
          leasefile: '/tmp/dhcp.leases',
        },
      },
      {
        name: 'lan',
        type: 'dhcp',
        options: {
          interface: 'lan',
          start: '100',
          limit: '150',
          leasetime: '1200d',
          dhcpv6: 'server',
          ra: 'server',
          dhcp_option: ['6,192.168.1.1', 'option:domain-search,lan'],
        },
      },
      {
        name: 'guest',
        type: 'dhcp',
        options: { interface: 'guest', start: '100', limit: '100', leasetime: '1h' },
      },
      {
        name: 'cfg05fe63',
        type: 'host',
        ...anon,
        options: { name: 'tablet', mac: TABLET_MAC, ip: '192.168.1.21' },
      },
    ],
  }
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
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent' })
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
  const gw = new FakeGateway({ configs: routerConfigs(), secure: true, ...options })
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

/** Waits until every job of the gateway is finished and confirmed. */
async function allConfirmed(env: Env) {
  await eventually(
    async () => {
      const applies = await GatewayApply.query().where('gateway_id', env.gatewayId)
      await new Promise((r) => setTimeout(r, 150))
      const again = await GatewayApply.query().where('gateway_id', env.gatewayId)
      return { applies, stable: again.length === applies.length }
    },
    ({ applies, stable }) =>
      stable && applies.length > 0 && applies.every((a) => a.state === 'confirmed'),
    15000
  )
  await gatewayQueue.drain(env.gatewayId)
}

/** Seeds an observation part as the agent would report it. */
async function observe(env: Env, kind: string, payload: unknown) {
  await writeObservationRow(
    db,
    env.collector.id,
    kind,
    payload,
    `fp-${kind}-${Date.now()}`,
    DateTime.utc()
  )
}

async function observeResolver(env: Env, addresses = ['192.168.1.5']) {
  await observe(env, 'resolver', {
    dnsmasqPort: 54,
    port53Process: 'AdGuardHome',
    port53Processes: ['AdGuardHome'],
    controllerHost: { name: 'ctl.example.com', addresses, error: null },
  })
}

/** GET `/api/v1/gateways/:id/<path>` as the admin, the `data` of the answer. */
async function getData(client: any, env: Env, path: string) {
  const r = await client
    .get(`/api/v1/gateways/${env.gatewayId}/${path}`)
    .bearerToken(env.adminToken)
  return r.body().data
}

function section(env: Env, config: string, predicate: (s: Section) => boolean) {
  const found = env.gw.configs[config].find(predicate)
  if (!found) throw new Error(`no ${config} section`)
  return found
}

test.group('gateway native sync', (group) => {
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

  test('authz: admin only for reads and writes; anonymous 401', async ({ client }) => {
    const env = await setup()
    await toManaged(client, env)
    for (const path of ['dhcp', 'routing']) {
      const anonymous = await client.get(`/api/v1/gateways/${env.gatewayId}/${path}`)
      anonymous.assertStatus(401)
      const operator = await client
        .get(`/api/v1/gateways/${env.gatewayId}/${path}`)
        .bearerToken(env.operatorToken)
      operator.assertStatus(403)
    }
    const writes: Array<[string, string, object]> = [
      ['patch', 'system', { hostname: 'x' }],
      ['patch', 'dhcp/pools/lan', { leaseTime: '12h' }],
      ['post', 'dhcp/tags', { name: 'kids' }],
      ['post', 'routing/routes', { interface: 'lan', target: '192.168.60.0/24' }],
      ['patch', 'dns', { upstreams: [] }],
    ]
    for (const [method, path, body] of writes) {
      const r = await (client as any)
        [method](`/api/v1/gateways/${env.gatewayId}/${path}`)
        .bearerToken(env.operatorToken)
        .json(body)
      r.assertStatus(403)
    }
  })

  test('the new domains import as synced sections; rules and LEDs stay unmodeled', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const rows = await GatewaySection.query().where('gateway_id', env.gatewayId)
    const scope = (name: string) => rows.find((r) => r.sectionName === name)
    assert.equal(scope('cfg01e48a')?.domain, 'system')
    assert.equal(scope('ntp')?.domain, 'system')
    assert.equal(scope('cfg0a1b2c')?.domain, 'routes')
    assert.equal(scope('cfg01411c')?.domain, 'dns_settings')
    assert.equal(scope('led_wan')?.scope, 'unmodeled')
    assert.equal(scope('cfg0b1b2c')?.scope, 'unmodeled')
    assert.deepEqual(scope('cfg01411c')?.ownership, {
      kind: 'options',
      options: ['domain', 'local', 'rebind_protection', 'noresolv'],
      items: { server: [], rebind_domain: [], address: [] },
    })
  })

  test('DHCP: pool options pushed to clients; the gateway and disable guards', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const overview = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dhcp`)
      .bearerToken(env.adminToken)
    overview.assertStatus(200)
    const lan = overview.body().data.pools.find((p: any) => p.network === 'lan')
    assert.deepEqual(lan.options.dnsServers, ['192.168.1.1'])
    assert.equal(lan.subnet, '192.168.1.1/24')
    assert.equal(lan.leaseTime, '1200d')
    assert.isTrue(lan.management)
    assert.equal(lan.ipv6.ra, 'server')
    assert.equal(lan.sync.owner, 'perch')

    const foreign = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/pools/lan`)
      .bearerToken(env.adminToken)
      .json({ options: { gateway: '192.168.1.254' } })
    foreign.assertStatus(422)
    foreign.assertBodyContains({ error: 'dhcp_gateway_not_router' })

    const off = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/pools/lan`)
      .bearerToken(env.adminToken)
      .json({ enabled: false })
    off.assertStatus(409)
    off.assertBodyContains({ error: 'dhcp_confirm_required' })

    const write = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/pools/lan`)
      .bearerToken(env.adminToken)
      .json({
        options: { dnsServers: ['192.168.1.2', '203.0.113.53'], ntpServers: ['192.168.1.1'] },
      })
    write.assertStatus(200)
    assert.isNotNull(write.body().data.apply, JSON.stringify(write.body().data.applyError))
    await allConfirmed(env)
    assert.deepEqual(section(env, 'dhcp', (s) => s.name === 'lan').options.dhcp_option, [
      '6,192.168.1.2,203.0.113.53',
      'option:domain-search,lan',
      '42,192.168.1.1',
    ])
    // Router-owned IPv6 options are carried, 1200-day leases untouched.
    assert.equal(section(env, 'dhcp', (s) => s.name === 'lan').options.ra, 'server')
    assert.equal(section(env, 'dhcp', (s) => s.name === 'lan').options.leasetime, '1200d')

    const staged = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/pools/guest?apply=0`)
      .bearerToken(env.adminToken)
      .json({ enabled: false, confirm: 'guest', options: { gateway: '192.168.30.1' } })
    staged.assertStatus(200)
    assert.isNull(staged.body().data.apply)
    assert.isFalse(staged.body().data.object.enabled)
    assert.equal(staged.body().data.object.sync.status, 'ahead')

    const missing = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/pools/nope`)
      .bearerToken(env.adminToken)
      .json({ leaseTime: '12h' })
    missing.assertStatus(404)
  })

  test('DHCP tags and reservation tags: one job each, refused while in use', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dhcp/tags`)
      .bearerToken(env.adminToken)
      .json({ name: 'kids', options: { dnsServers: ['192.168.1.2'] }, force: true })
    created.assertStatus(201)
    const tagId = created.body().data.object.perchId
    await allConfirmed(env)
    const tag = section(env, 'dhcp', (s) => s.type === 'tag')
    assert.equal(tag.name, 'kids')
    assert.deepEqual(tag.options, { dhcp_option: ['6,192.168.1.2'], force: '1' })

    const dup = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dhcp/tags`)
      .bearerToken(env.adminToken)
      .json({ name: 'kids' })
    dup.assertStatus(409)

    const overview = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dhcp`)
      .bearerToken(env.adminToken)
    const tablet = overview.body().data.reservations.find((r: any) => r.macs.includes(TABLET_MAC))
    assert.equal(tablet.network, 'lan')
    const tagged = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/reservations/${tablet.perchId}`)
      .bearerToken(env.adminToken)
      .json({ tags: ['kids'] })
    tagged.assertStatus(200)
    assert.deepEqual(tagged.body().data.object.tags, ['kids'])
    await allConfirmed(env)
    assert.deepEqual(
      section(env, 'dhcp', (s) => s.type === 'host').options.tag,
      ['kids'],
      'the tag is written (ownership widened for the host row)'
    )

    const inUse = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/dhcp/tags/${tagId}`)
      .bearerToken(env.adminToken)
    inUse.assertStatus(409)
    inUse.assertBodyContains({ error: 'dhcp_tag_in_use' })

    await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dhcp/reservations/${tablet.perchId}`)
      .bearerToken(env.adminToken)
      .json({ tags: [] })
    await allConfirmed(env)
    const gone = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/dhcp/tags/${tagId}`)
      .bearerToken(env.adminToken)
    gone.assertStatus(200)
    await allConfirmed(env)
    assert.isUndefined(env.gw.configs.dhcp.find((s) => s.type === 'tag'))
  })

  test('DNS: Perch owns the items it adds; the router’s items and port stay the router’s', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await observeResolver(env)
    const before = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
    before.assertStatus(200)
    const settings = before.body().data.settings
    assert.equal(settings.frontResolver, 'AdGuardHome')
    assert.isTrue(settings.adguard)
    assert.equal(settings.dnsmasqPort, 54)
    assert.equal(settings.controllerHost.name, 'ctl.example.com')
    assert.isTrue(settings.instances[0].suggestRebindDomain)
    assert.deepEqual(settings.instances[0].settings.upstreams, [
      { value: '203.0.113.53', owner: 'router' },
    ])
    assert.isArray(before.body().data.records, 'the records overview is still there')

    const write = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({
        upstreams: ['198.51.100.53'],
        rebindDomains: ['ctl.example.com'],
        forwards: [{ domain: 'lab.example.com', server: '192.168.1.60' }],
      })
    write.assertStatus(200)
    assert.isNotNull(write.body().data.apply, JSON.stringify(write.body().data.applyError))
    await allConfirmed(env)
    const dnsmasq = section(env, 'dhcp', (s) => s.type === 'dnsmasq')
    assert.deepEqual(dnsmasq.options.server, [
      '203.0.113.53',
      '198.51.100.53',
      '/lab.example.com/192.168.1.60',
    ])
    assert.deepEqual(dnsmasq.options.rebind_domain, ['ctl.example.com'])
    assert.equal(dnsmasq.options.port, '54', 'the port is the router’s')

    // A router edit adds its own upstream and moves the port: imported, two-way, no conflict.
    env.gw.routerEdit('dhcp', (s) => {
      const d = s.find((x) => x.type === 'dnsmasq')!
      d.options.server = [...(d.options.server as string[]), '203.0.113.54']
      d.options.port = '5353'
    })
    const imported = await eventually(
      () => getData(client, env, 'dns').then((d) => d.settings.instances[0].settings),
      (s: any) => s.port === 5353
    )
    assert.deepEqual(
      imported.upstreams.map((u: any) => [u.value, u.owner]),
      [
        ['203.0.113.53', 'router'],
        ['198.51.100.53', 'perch'],
        ['203.0.113.54', 'router'],
      ]
    )

    // Removing Perch's upstreams leaves the router's.
    const cleared = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ upstreams: [] })
    cleared.assertStatus(200)
    await allConfirmed(env)
    // The router's items in its order, then Perch's (controller wins on owned items only).
    assert.deepEqual(section(env, 'dhcp', (s) => s.type === 'dnsmasq').options.server, [
      '203.0.113.53',
      '203.0.113.54',
      '/lab.example.com/192.168.1.60',
    ])
  })

  test('DNS: the controller name pin and name resolution guards (T-N2)', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await observeResolver(env)
    const allow = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ rebindDomains: ['ctl.example.com'] })
    allow.assertStatus(200)
    await allConfirmed(env)

    const drop = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ rebindDomains: [] })
    drop.assertStatus(409)
    drop.assertBodyContains({ error: 'dns_controller_name_pinned' })

    const hijack = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ addresses: [{ domain: 'ctl.example.com', address: '192.168.1.99' }] })
    hijack.assertStatus(409)
    hijack.assertBodyContains({ error: 'dns_controller_name_pinned' })

    const record = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dns/records`)
      .bearerToken(env.adminToken)
      .json({ type: 'a', name: 'ctl.example.com', value: '192.168.1.99' })
    record.assertStatus(409)
    record.assertBodyContains({ error: 'dns_controller_name_pinned' })

    // The router drops its own upstream: ignoring the resolv file now would leave none.
    env.gw.routerEdit('dhcp', (s) => {
      delete s.find((x) => x.type === 'dnsmasq')!.options.server
    })
    await eventually(
      () =>
        GatewaySection.query()
          .where('gateway_id', env.gatewayId)
          .where('domain', 'dns_settings')
          .firstOrFail(),
      (r) => r.desiredContent?.options.server === undefined
    )
    const noUpstream = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ noresolv: true })
    noUpstream.assertStatus(422)
    noUpstream.assertBodyContains({ error: 'dns_no_upstream' })

    const bad = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ upstreams: ['not-an-ip'] })
    bad.assertStatus(422)

    const policy = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ labelNames: 'off' })
    policy.assertStatus(200)
    assert.equal(policy.body().data.labelNames, 'off')
  })

  test('routes: create, edit, delete; the management path and unknown interfaces are refused (T-R1, T-R2)', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await client
      .get(`/api/v1/gateways/${env.gatewayId}/routing`)
      .bearerToken(env.adminToken)
    view.assertStatus(200)
    const data = view.body().data
    assert.deepEqual(
      data.routes.map((r: any) => [r.target, r.interface, r.sync.owner]),
      [['192.168.50.0/24', 'lan', 'perch']]
    )
    assert.equal(data.policyRules[0].lookup, '100')
    assert.deepEqual(data.management, { network: 'lan', controllerAddress: '192.168.1.5' })
    assert.isNull(data.mwan3.config)

    const steal = await client
      .post(`/api/v1/gateways/${env.gatewayId}/routing/routes`)
      .bearerToken(env.adminToken)
      .json({ interface: 'wan', target: '192.168.1.0/28', gateway: '203.0.113.1' })
    steal.assertStatus(422)
    steal.assertBodyContains({ error: 'routing_controller_path' })

    const blackhole = await client
      .post(`/api/v1/gateways/${env.gatewayId}/routing/routes`)
      .bearerToken(env.adminToken)
      .json({ target: '192.168.1.5/32', type: 'blackhole' })
    blackhole.assertStatus(422)

    const unknown = await client
      .post(`/api/v1/gateways/${env.gatewayId}/routing/routes`)
      .bearerToken(env.adminToken)
      .json({ interface: 'wan9', target: '198.51.100.0/24' })
    unknown.assertStatus(422)
    unknown.assertBodyContains({ error: 'routing_interface_unknown' })

    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/routing/routes`)
      .bearerToken(env.adminToken)
      .json({ interface: 'wan', target: '198.51.100.0/24', gateway: '203.0.113.1', metric: 10 })
    created.assertStatus(201)
    const id = created.body().data.object.id
    await allConfirmed(env)
    const route = section(env, 'network', (s) => s.options.target === '198.51.100.0/24')
    assert.deepEqual(route.options, {
      interface: 'wan',
      target: '198.51.100.0/24',
      gateway: '203.0.113.1',
      metric: '10',
    })
    assert.equal(route.type, 'route')

    const edited = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/routing/routes/${id}`)
      .bearerToken(env.adminToken)
      .json({ metric: 20, enabled: false })
    edited.assertStatus(200)
    await allConfirmed(env)
    assert.equal(
      section(env, 'network', (s) => s.options.target === '198.51.100.0/24').options.disabled,
      '1'
    )

    const deleted = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/routing/routes/${id}`)
      .bearerToken(env.adminToken)
    deleted.assertStatus(200)
    await allConfirmed(env)
    assert.isUndefined(env.gw.configs.network.find((s) => s.options.target === '198.51.100.0/24'))

    // A route added on the router is imported (two-way).
    env.gw.routerEdit('network', (s) => {
      s.push({
        name: 'cfg0c1b2c',
        type: 'route6',
        anonymous: true,
        options: { interface: 'lan', target: 'fd00:50::/64', gateway: 'fd00::254' },
      })
    })
    const again = await eventually(
      () => getData(client, env, 'routing').then((d) => d.routes),
      (routes: any[]) => routes.length === 2
    )
    assert.equal(again[1].family, 6)
  })

  test('system: host name, zone and NTP; LuCI edits flow back (T-S1)', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const bad = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/system`)
      .bearerToken(env.adminToken)
      .json({ timezone: 'Mars/Olympus' })
    bad.assertStatus(422)
    bad.assertBodyContains({ error: 'system_timezone_invalid' })
    const badHost = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/system`)
      .bearerToken(env.adminToken)
      .json({ hostname: 'not a host' })
    badHost.assertStatus(422)

    const write = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/system`)
      .bearerToken(env.adminToken)
      .json({
        hostname: 'edge',
        timezone: 'Asia/Manila',
        ntpServe: true,
        ntpServers: ['192.168.1.1', 'time.example.com'],
      })
    write.assertStatus(200)
    assert.equal(write.body().data.object.zonename, 'Asia/Manila')
    await allConfirmed(env)
    const main = section(env, 'system', (s) => s.type === 'system')
    assert.deepEqual(main.options, {
      hostname: 'edge',
      timezone: 'PST-8',
      zonename: 'Asia/Manila',
      log_size: '128',
    })
    assert.deepEqual(section(env, 'system', (s) => s.name === 'ntp').options, {
      enabled: '1',
      enable_server: '1',
      server: ['192.168.1.1', 'time.example.com'],
    })

    // LuCI changes the zone: imported two-way.
    env.gw.routerEdit('system', (s) => {
      const m = s.find((x) => x.type === 'system')!
      m.options.zonename = 'UTC'
      m.options.timezone = 'UTC0'
    })
    await observe(env, 'system', { hostname: 'edge', release: 'OpenWrt 24.10.2' })
    const system = await eventually(
      async () => await getData(client, env, 'system'),
      (d: any) => d.zonename === 'UTC'
    )
    assert.equal(system.timezone, 'UTC0')
    assert.equal(system.hostname, 'edge')
    assert.deepEqual(system.ntp, {
      enabled: true,
      server: true,
      servers: ['192.168.1.1', 'time.example.com'],
    })
    assert.equal(system.config.sync.owner, 'perch')
    assert.include(system.config.zoneNames, 'Asia/Manila')
  })

  test('Authoritative Mode: each feature’s own check blocks until verified (4.6)', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const adopt = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({})
    adopt.assertStatus(202)
    await allConfirmed(env)
    await observe(env, 'system', { hostname: 'OpenWrt' })
    await observeResolver(env)

    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    status.assertStatus(200)
    const blockers = status.body().data.blockers
    assert.isFalse(status.body().data.inSync)
    assert.deepEqual(
      blockers.map((b: any) => [b.kind, b.feature, b.code]),
      [['feature', 'system', 'system_hostname_not_live']]
    )
    const refused = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({
        authoritative: true,
        expectRevision: status.body().data.headRevision,
        currentPassword: PASSWORD,
      })
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'not_in_sync' })

    await observe(env, 'system', { hostname: 'gateway' })
    const ok = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    assert.isTrue(ok.body().data.inSync, JSON.stringify(ok.body().data.blockers))
    const on = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({
        authoritative: true,
        expectRevision: ok.body().data.headRevision,
        currentPassword: PASSWORD,
      })
    on.assertStatus(200)

    // Under Authoritative Mode a router edit of the zone is drift, the port never is.
    env.gw.routerEdit('dhcp', (s) => {
      s.find((x) => x.type === 'dnsmasq')!.options.port = '5353'
    })
    env.gw.routerEdit('system', (s) => {
      s.find((x) => x.type === 'system')!.options.hostname = 'rogue'
    })
    const main = await eventually(
      () =>
        GatewaySection.query()
          .where('gateway_id', env.gatewayId)
          .where('domain', 'system')
          .where('section_type', 'system')
          .firstOrFail(),
      (r) => r.status === 'drift'
    )
    assert.equal(main.routerContent?.options.hostname, 'rogue')
    const dns = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('domain', 'dns_settings')
      .firstOrFail()
    assert.notEqual(dns.status, 'drift')
  })
  test('T-A1: an ambiguous host blocks Authoritative Mode until fixed on the router', async ({
    client,
    assert,
  }) => {
    const configs = routerConfigs()
    configs.dhcp.push({
      name: 'cfg06fe63',
      type: 'host',
      anonymous: true,
      options: { name: 'tablet-2', mac: TABLET_MAC, ip: '192.168.1.22' },
    })
    const env = await setup({ configs })
    await toManaged(client, env)
    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status`)
      .bearerToken(env.adminToken)
    const reasons = status
      .body()
      .data.blockers.filter((b: any) => b.kind === 'feature')
      .map((b: any) => [b.feature, b.code])
    assert.deepEqual(reasons, [
      ['dhcp_hosts', 'section_ambiguous'],
      ['dhcp_hosts', 'section_ambiguous'],
    ])
    env.gw.routerEdit('dhcp', (s) => {
      s.splice(
        s.findIndex((x) => x.name === 'cfg06fe63'),
        1
      )
    })
    await eventually(
      () => getData(client, env, 'sync-status').then((d) => d.blockers),
      (blockers: any[]) => !blockers.some((b) => b.kind === 'feature')
    )
  })
})
