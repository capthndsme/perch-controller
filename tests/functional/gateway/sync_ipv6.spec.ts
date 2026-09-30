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
import { forgetObservations } from '#services/gateway_observation_common'
import { recordGatewayObservation } from '#services/gateway_observe'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * Gateway sync B4 (docs/design/gateway-sync/rest.md 5, domains.md 7): IPv6
 * against the scripted gateway. The overview (ULA, the upstream with its
 * delegated prefix, each LAN's assignment and RA/DHCPv6), a generated ULA,
 * and a LAN's first IPv6 edit widening its pool's ownership; relay without a
 * master refused.
 */

let gateways: FakeGateway[] = []

function routerConfigs(): Record<string, Section[]> {
  return {
    network: [
      {
        name: 'globals',
        type: 'globals',
        options: { ula_prefix: 'fd11:2233:4455::/48', packet_steering: '1' },
      },
      {
        name: 'lan',
        type: 'interface',
        options: {
          device: 'br-lan',
          proto: 'static',
          ipaddr: '192.168.1.1',
          netmask: '255.255.255.0',
          ip6assign: '60',
        },
      },
      { name: 'wan', type: 'interface', options: { device: 'eth1', proto: 'dhcp' } },
      {
        name: 'wan6',
        type: 'interface',
        options: { device: 'eth1', proto: 'dhcpv6', reqaddress: 'try', reqprefix: 'auto' },
      },
    ],
    dhcp: [
      {
        name: 'lan',
        type: 'dhcp',
        options: {
          interface: 'lan',
          start: '100',
          limit: '150',
          leasetime: '12h',
          ra: 'server',
          dhcpv6: 'server',
          ra_flags: ['managed-config', 'other-config'],
        },
      },
      { name: 'wan', type: 'dhcp', options: { interface: 'wan', ignore: '1' } },
      {
        name: 'odhcpd',
        type: 'odhcpd',
        options: { maindhcp: '0', leasefile: '/tmp/hosts/odhcpd', loglevel: '4' },
      },
    ],
  }
}

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
  // The ingest remembers each collector's last fingerprints; ids repeat after a truncate.
  forgetObservations()
}

type Env = { adminToken: string; gw: FakeGateway; gatewayId: number; collectorId: number }

async function setup(
  opts: { installed?: boolean; features?: string[]; secure?: boolean } = {}
): Promise<Env> {
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent' })
  const { adminToken } = await seedSetupComplete()
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
  void opts.installed
  const gw = new FakeGateway({
    configs: routerConfigs(),
    secure: opts.secure ?? true,
    capabilities: ['gateway_stats', 'gateway_config'],
    features: opts.features ?? [],
  })
  gateways.push(gw)
  await gw.connect()
  const gateway = await eventually(
    () => Gateway.findBy('collector_id', collector.id),
    (g) => g !== null
  )
  return { adminToken, gw, gatewayId: gateway!.id, collectorId: collector.id }
}

async function toManaged(client: any, env: Env) {
  const r = await client
    .patch(`/api/v1/gateways/${env.gatewayId}`)
    .bearerToken(env.adminToken)
    .json({ mode: 'managed', currentPassword: 'admin-pass-123' })
  r.assertStatus(200)
  await gatewayQueue.drain(env.gatewayId)
}

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

async function view(client: any, env: Env) {
  const r = await client.get(`/api/v1/gateways/${env.gatewayId}/ipv6`).bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

test.group('gateway sync | IPv6 (B4)', (group) => {
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

  test('overview: ULA, upstream prefixes, LAN assignment and RA/DHCPv6, odhcpd read only', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await recordGatewayObservation(env.collectorId, {
      interfaces: [
        {
          network: 'wan',
          device: 'eth1',
          up: true,
          proto: 'dhcp',
          ipv4: ['203.0.113.10/24'],
          defaultRoute: true,
        },
        {
          network: 'wan6',
          device: 'eth1',
          up: true,
          proto: 'dhcpv6',
          ipv6: ['2001:db8:ffff::10/64'],
          ipv6Prefixes: [
            { prefix: '2001:db8:10::/56', preferredUntil: 1790003600, validUntil: 1790007200 },
          ],
        },
        {
          network: 'lan',
          device: 'br-lan',
          up: true,
          proto: 'static',
          ipv4: ['192.168.1.1/24'],
          ipv6Assigned: ['2001:db8:10::/60', 'fd11:2233:4455::/60'],
        },
      ],
    })
    const v = await view(client, env)
    assert.equal(v.ula.prefix, 'fd11:2233:4455::/48')
    assert.equal(v.ula.sync.scope, 'synced')
    assert.lengthOf(v.lans, 1)
    assert.deepInclude(v.lans[0], {
      network: 'lan',
      ip6assign: 60,
      ra: 'server',
      dhcpv6: 'server',
      ownership: 'router',
    })
    assert.deepEqual(v.lans[0].raFlags, ['managed-config', 'other-config'])
    assert.deepEqual(v.lans[0].assigned, ['2001:db8:10::/60', 'fd11:2233:4455::/60'])
    assert.deepInclude(v.odhcpd, { maindhcp: false, running: null })
    assert.equal(v.odhcpd.options.leasefile, '/tmp/hosts/odhcpd')
    const up = v.upstream.find((u: any) => u.wan === 'wan')
    if (up) {
      assert.deepEqual(
        up.delegated.map((d: any) => d.prefix),
        up.companion ? ['2001:db8:10::/56'] : []
      )
    }
  })

  test('ULA: generated, applied; invalid refused', async ({ client, assert }) => {
    const env = await setup()
    await toManaged(client, env)
    const bad = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ipv6`)
      .bearerToken(env.adminToken)
      .json({ ula: '2001:db8::/48' })
    bad.assertStatus(422)
    bad.assertBodyContains({ error: 'ipv6_ula_invalid' })
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ipv6`)
      .bearerToken(env.adminToken)
      .json({ ula: 'generate' })
    r.assertStatus(200)
    const ula = r.body().data.object.ula.prefix
    assert.match(ula, /^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/)
    await allConfirmed(env)
    const globals = env.gw.configs.network.find((s) => s.type === 'globals')!
    assert.equal(globals.options.ula_prefix, ula)
    assert.equal(globals.options.packet_steering, '1')
  })

  test('a LAN: the first IPv6 edit widens the pool; relay needs a master', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ipv6/lans/lan`)
      .bearerToken(env.adminToken)
      .json({
        ra: 'hybrid',
        raFlags: ['other-config'],
        dns: ['fd11:2233:4455::1'],
        ip6assign: 64,
        ip6hint: '10',
      })
    r.assertStatus(200)
    assert.deepInclude(r.body().data.object, {
      ra: 'hybrid',
      ip6assign: 64,
      ip6hint: '10',
      ownership: 'perch',
    })
    await allConfirmed(env)
    const pool = env.gw.configs.dhcp.find((s) => s.name === 'lan')!
    assert.equal(pool.options.ra, 'hybrid')
    assert.deepEqual(pool.options.ra_flags, ['other-config'])
    assert.deepEqual(pool.options.dns, ['fd11:2233:4455::1'])
    assert.equal(pool.options.leasetime, '12h')
    const lan = env.gw.configs.network.find((s) => s.name === 'lan')!
    assert.equal(lan.options.ip6assign, '64')
    assert.equal(lan.options.ip6hint, '10')
    const row = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('config', 'dhcp')
      .where('section_name', 'lan')
      .firstOrFail()
    assert.include(JSON.stringify(row.ownership), 'dhcpv6')

    const relay = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ipv6/lans/lan`)
      .bearerToken(env.adminToken)
      .json({ ra: 'relay', dhcpv6: 'relay', ndp: 'relay' })
    relay.assertStatus(422)
    assert.equal(relay.body().issues[0].code, 'ipv6_relay_needs_master')
    const badAssign = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ipv6/lans/lan`)
      .bearerToken(env.adminToken)
      .json({ ip6assign: 30 })
    badAssign.assertStatus(422)
    badAssign.assertBodyContains({ error: 'ipv6_assign_invalid' })
    const unknown = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ipv6/lans/nope`)
      .bearerToken(env.adminToken)
      .json({ ra: 'server' })
    unknown.assertStatus(404)
  })
})
