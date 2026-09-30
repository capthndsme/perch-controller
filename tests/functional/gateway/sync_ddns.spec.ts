import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewaySecret from '#models/gateway_secret'
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
 * Gateway sync B6 (docs/design/gateway-sync/rest.md 9, domains.md 9): DDNS
 * services against the scripted gateway. The router's own password stays
 * the router's (never read, never sent back); a password set here travels
 * only inside an apply over verified TLS; update-now is the runtime
 * `gateway.ddns.update`; refusals when ddns-scripts is missing.
 */

let gateways: FakeGateway[] = []

function routerConfigs(): Record<string, Section[]> {
  return {
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
      { name: 'wan', type: 'interface', options: { device: 'eth1', proto: 'dhcp' } },
    ],
    ddns: [
      {
        name: 'global',
        type: 'ddns',
        options: { ddns_dateformat: '%F %R', ddns_loglines: '250', upd_privateip: '0' },
      },
      {
        name: 'home',
        type: 'service',
        options: {
          enabled: '1',
          service_name: 'duckdns.org',
          domain: 'home.example.com',
          lookup_host: 'home.example.com',
          username: 'NA',
          ip_source: 'network',
          ip_network: 'wan',
          interface: 'wan',
          use_ipv6: '0',
          check_interval: '10',
          check_unit: 'minutes',
          force_interval: '72',
          force_unit: 'hours',
          dns_server: '1.1.1.1',
        },
        secrets: { password: 'hmac:0123456789abcdef' },
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
  const installed = opts.installed ?? true
  const configs = routerConfigs()
  if (!installed) delete configs.ddns
  const gw = new FakeGateway({
    configs,
    secure: opts.secure ?? true,
    capabilities: ['gateway_stats', 'gateway_config'],
    features: opts.features ?? ['ddns.update'],
  })
  if (installed) gw.packages['ddns-scripts'] = '2.8.2-r64'
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

async function overview(client: any, env: Env) {
  const r = await client.get(`/api/v1/gateways/${env.gatewayId}/ddns`).bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

test.group('gateway sync | DDNS (B6)', (group) => {
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

  test('overview: the router’s service, its password the router’s, live state from the observation', async ({
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
      ],
      ddns: {
        installed: true,
        serviceEnabled: true,
        providers: ['duckdns.org', 'cloudflare.com-v4'],
        services: [
          {
            name: 'home',
            enabled: true,
            domain: 'home.example.com',
            registeredIp: '203.0.113.10',
            lastUpdate: 1790000000,
            running: true,
            lastError: null,
          },
        ],
      },
    })
    const view = await overview(client, env)
    assert.deepInclude(view, {
      installed: true,
      available: true,
      unavailableReason: null,
      secureTransport: true,
      canUpdateNow: true,
    })
    assert.deepEqual(view.installPackages, [])
    assert.deepEqual(view.providers, ['cloudflare.com-v4', 'duckdns.org'])
    assert.lengthOf(view.services, 1)
    const home = view.services[0]
    assert.deepInclude(home, {
      name: 'home',
      enabled: true,
      provider: 'duckdns.org',
      domain: 'home.example.com',
      ipSource: 'network',
      ipNetwork: 'wan',
      checkIntervalMinutes: 10,
      forceIntervalHours: 72,
    })
    assert.deepEqual(home.password, { set: true, owner: 'router' })
    assert.deepEqual(home.extra, { dns_server: '1.1.1.1' })
    assert.deepInclude(home.live, {
      registeredIp: '203.0.113.10',
      wanIp: '203.0.113.10',
      matches: true,
      running: true,
      lastUpdateAt: '2026-09-21T14:13:20Z',
    })
    assert.equal(home.sync.scope, 'synced')
    assert.notInclude(JSON.stringify(view), 'hmac:')
  })

  test('create: a password set here travels once inside the apply, never back out', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services`)
      .bearerToken(env.adminToken)
      .json({
        name: 'office',
        provider: 'cloudflare.com-v4',
        domain: 'office@example.com',
        username: 'Bearer',
        password: 'cf-token-value',
        useHttps: true,
      })
    r.assertStatus(201)
    const data = r.body().data
    assert.isNull(data.applyError)
    assert.deepInclude(data.object, {
      name: 'office',
      provider: 'cloudflare.com-v4',
      domain: 'office@example.com',
      lookupHost: 'example.com',
      ipNetwork: 'wan',
      interface: 'wan',
      useHttps: true,
      checkIntervalMinutes: 10,
      forceIntervalHours: 72,
    })
    assert.deepEqual(data.object.password, { set: true, owner: 'controller' })
    assert.notInclude(JSON.stringify(r.body()), 'cf-token-value')
    await allConfirmed(env)

    const office = env.gw.configs.ddns.find((s) => s.name === 'office')!
    assert.equal(office.options.password, 'cf-token-value')
    assert.equal(office.options.cacert, '/etc/ssl/certs')
    assert.equal(office.options.enabled, '1')
    const apply = env.gw.calls.find((c) => c.method === 'gateway.config.apply')!
    assert.isFalse(apply.signed)
    assert.lengthOf(await GatewaySecret.all(), 1)

    const list = await overview(client, env)
    assert.notInclude(JSON.stringify(list), 'cf-token-value')
  })

  test('patch keeps the router’s password; delete removes the service; refusals', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const { services } = await overview(client, env)
    const home = services[0]
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ddns/services/${home.id}`)
      .bearerToken(env.adminToken)
      .json({ domain: 'house.example.com', checkIntervalMinutes: 5 })
    r.assertStatus(200)
    assert.equal(r.body().data.object.domain, 'house.example.com')
    assert.equal(r.body().data.object.lookupHost, 'house.example.com')
    assert.deepEqual(r.body().data.object.password, { set: true, owner: 'router' })
    await allConfirmed(env)
    const routerHome = env.gw.configs.ddns.find((s) => s.name === 'home')!
    assert.equal(routerHome.options.domain, 'house.example.com')
    assert.equal(routerHome.options.check_interval, '5')
    assert.equal(routerHome.options.dns_server, '1.1.1.1')
    const apply = env.gw.calls.find((c) => c.method === 'gateway.config.apply')!
    const op = (apply.params.ops as any[]).find((o) => o.section === 'home' && o.options)
    assert.deepEqual(op.options.password, { $keep: true })

    const exists = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services`)
      .bearerToken(env.adminToken)
      .json({ name: 'home', provider: 'duckdns.org', domain: 'x.example.com' })
    exists.assertStatus(409)
    exists.assertBodyContains({ error: 'ddns_service_exists' })
    const noProvider = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services`)
      .bearerToken(env.adminToken)
      .json({ name: 'bare', domain: 'x.example.com' })
    noProvider.assertStatus(422)
    noProvider.assertBodyContains({ error: 'ddns_provider_required' })
    const badDomain = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services`)
      .bearerToken(env.adminToken)
      .json({ name: 'bad', provider: 'duckdns.org', domain: 'not a host' })
    badDomain.assertStatus(422)
    badDomain.assertBodyContains({ error: 'invalid_config' })
    const badNet = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services`)
      .bearerToken(env.adminToken)
      .json({ name: 'bad2', provider: 'duckdns.org', domain: 'y.example.com', ipNetwork: 'nope' })
    badNet.assertStatus(422)
    assert.equal(badNet.body().issues[0].code, 'ddns_interface_unknown')

    const del = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/ddns/services/${home.id}`)
      .bearerToken(env.adminToken)
    del.assertStatus(200)
    await allConfirmed(env)
    assert.isUndefined(env.gw.configs.ddns.find((s) => s.name === 'home'))
    const missing = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/ddns/services/nope`)
      .bearerToken(env.adminToken)
      .json({ enabled: false })
    missing.assertStatus(404)
  })

  test('update now: the runtime request, gated by the agent feature', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const { services } = await overview(client, env)
    const home = services[0]
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services/${home.id}/update-now`)
      .bearerToken(env.adminToken)
    r.assertStatus(202)
    assert.deepEqual(r.body().data, { started: true })
    assert.deepEqual(env.gw.ddnsUpdates, ['home'])

    await env.gw.destroy()
    await resetAll()
    const old = await setup({ features: [] })
    await toManaged(client, old)
    const oldView = await overview(client, old)
    const oldHome = oldView.services[0]
    const refused = await client
      .post(`/api/v1/gateways/${old.gatewayId}/ddns/services/${oldHome.id}/update-now`)
      .bearerToken(old.adminToken)
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'gateway_capability_missing' })
    assert.equal(refused.body().capability, 'ddns.update')
  })

  test('not installed: offered for install, writes refused', async ({ client, assert }) => {
    const env = await setup({ installed: false })
    await toManaged(client, env)
    const view = await overview(client, env)
    assert.deepInclude(view, {
      installed: false,
      available: false,
      unavailableReason: 'not_installed',
    })
    assert.deepEqual(view.installPackages, ['ddns-scripts'])
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/ddns/services`)
      .bearerToken(env.adminToken)
      .json({ name: 'home', provider: 'duckdns.org', domain: 'home.example.com' })
    r.assertStatus(409)
    r.assertBodyContains({ error: 'ddns_not_installed' })
    assert.deepEqual(r.body().packages, ['ddns-scripts'])
  })
})
