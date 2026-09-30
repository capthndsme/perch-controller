import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewaySecret from '#models/gateway_secret'
import GatewaySection from '#models/gateway_section'
import db from '@adonisjs/lucid/services/db'
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
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * Gateway sync B2 (docs/design/gateway-sync/rest.md 4, domains.md 4, README
 * 5.2): WireGuard against the scripted gateway. A new interface's key is
 * generated on the router (`$generate`) and only its fingerprint comes back;
 * the next read adopts it without generating again; peers with a one-time
 * client config whose private key is never stored; the password step-up;
 * rotate and delete with the network's name.
 */

let gateways: FakeGateway[] = []

const PASSWORD = 'admin-pass-123'
const PROVIDER_PEER_KEY = 'x'.repeat(42) + 'E='

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
      {
        name: 'wgfix',
        type: 'interface',
        options: { proto: 'wireguard', addresses: ['10.64.0.2/32'] },
        secrets: { private_key: 'hmac:00112233445566778899aabbccddeeff' },
      },
      {
        name: 'cfg0a1b2c',
        type: 'wireguard_wgfix',
        options: {
          public_key: PROVIDER_PEER_KEY,
          description: 'provider',
          allowed_ips: ['0.0.0.0/0'],
          endpoint_host: 'vpn.example.com',
          endpoint_port: '51820',
          persistent_keepalive: '25',
        },
      },
    ],
    firewall: [
      {
        name: 'defaults',
        type: 'defaults',
        options: { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' },
      },
      {
        name: 'lanzone',
        type: 'zone',
        options: {
          name: 'lan',
          network: ['lan'],
          input: 'ACCEPT',
          output: 'ACCEPT',
          forward: 'ACCEPT',
        },
      },
      {
        name: 'wanzone',
        type: 'zone',
        options: {
          name: 'wan',
          network: ['wan', 'wgfix'],
          input: 'REJECT',
          output: 'ACCEPT',
          forward: 'REJECT',
          masq: '1',
        },
      },
      { name: 'fwd', type: 'forwarding', options: { src: 'lan', dest: 'wan' } },
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
  const gw = new FakeGateway({
    configs,
    secure: opts.secure ?? true,
    capabilities: ['gateway_stats', 'gateway_config'],
    features: opts.features ?? ['config.plain_public_key', 'config.generate.wg_key'],
  })
  if (installed) gw.packages['wireguard-tools'] = '1.0.20210914-r4'
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
  const r = await client
    .get(`/api/v1/gateways/${env.gatewayId}/wireguard/config`)
    .bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

function createWg0(client: any, env: Env, extra: Record<string, unknown> = {}) {
  return client
    .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces`)
    .bearerToken(env.adminToken)
    .json({
      network: 'wg0',
      role: 'server',
      addresses: ['10.7.0.1/24'],
      createZone: true,
      openPort: true,
      currentPassword: PASSWORD,
      ...extra,
    })
}

/** Every text the controller stored about gateways (sections, events, applies, secrets). */
async function storedText(): Promise<string> {
  const parts: unknown[] = []
  for (const table of [
    'gateway_sections',
    'gateway_config_events',
    'gateway_applies',
    'gateway_secrets',
    'gateway_wireguard_peers',
    'gateway_config_revisions',
  ]) {
    const rows = await db
      .from(table)
      .select('*')
      .catch(() => [])
    parts.push(rows)
  }
  return JSON.stringify(parts)
}

test.group('gateway sync | WireGuard (B2)', (group) => {
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

  test('overview: an imported client tunnel, the router’s key, its peer', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const v = await view(client, env)
    assert.deepInclude(v, {
      available: true,
      unavailableReason: null,
      canGenerateKeys: true,
      secureTransport: true,
    })
    assert.lengthOf(v.interfaces, 1)
    const wg = v.interfaces[0]
    assert.deepInclude(wg, {
      network: 'wgfix',
      role: 'client',
      enabled: true,
      listenPort: null,
      zone: 'wan',
      management: false,
    })
    assert.deepEqual(wg.privateKey, { set: true, owner: 'router', generatedOnRouter: null })
    assert.deepEqual(wg.addresses, ['10.64.0.2/32'])
    assert.lengthOf(wg.peers, 1)
    assert.deepInclude(wg.peers[0], {
      interface: 'wgfix',
      label: 'provider',
      publicKey: PROVIDER_PEER_KEY,
      routeAllowedIps: false,
      keepalive: 25,
    })
    assert.deepEqual(wg.peers[0].endpoint, { host: 'vpn.example.com', port: 51820 })
    assert.notInclude(JSON.stringify(v), 'hmac:')
  })

  test('an older agent: capability missing, writes refused', async ({ client, assert }) => {
    const env = await setup({ features: [] })
    await toManaged(client, env)
    const v = await view(client, env)
    assert.equal(v.unavailableReason, 'capability_missing')
    const r = await createWg0(client, env)
    r.assertStatus(409)
    r.assertBodyContains({ error: 'gateway_capability_missing' })
  })

  test('create a server: step-up, key generated on the router, adopted without generating again', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const noPassword = await createWg0(client, env, { currentPassword: undefined })
    noPassword.assertStatus(403)
    noPassword.assertBodyContains({ error: 'invalid_password' })

    const r = await createWg0(client, env)
    r.assertStatus(201)
    const created = r.body().data
    assert.isNull(created.applyError)
    assert.deepInclude(created.object, {
      network: 'wg0',
      role: 'server',
      listenPort: 51820,
      zone: 'vpn',
    })
    assert.deepEqual(created.object.privateKey, {
      set: true,
      owner: 'router',
      generatedOnRouter: true,
    })
    await allConfirmed(env)

    const wg0 = env.gw.configs.network.find((s) => s.name === 'wg0')!
    assert.equal(wg0.options.proto, 'wireguard')
    assert.equal(wg0.options.listen_port, '51820')
    assert.notProperty(wg0.options, 'private_key')
    assert.match(wg0.secrets!.private_key, /^hmac:/)
    const apply = env.gw.calls.find((c) => c.method === 'gateway.config.apply')!
    const op = (apply.params.ops as any[]).find((o) => o.section === 'wg0' && o.options)
    assert.deepEqual(op.options.private_key, { $generate: 'wg_private_key' })
    const vpn = env.gw.configs.firewall.find((s) => s.type === 'zone' && s.options.name === 'vpn')
    assert.isDefined(vpn)
    assert.include(vpn!.options.network as any, 'wg0')
    assert.isDefined(
      env.gw.configs.firewall.find(
        (s) => s.type === 'forwarding' && s.options.src === 'vpn' && s.options.dest === 'lan'
      )
    )
    const rule = env.gw.configs.firewall.find(
      (s) => s.type === 'rule' && s.options.dest_port === '51820'
    )
    assert.equal(rule?.options.target, 'ACCEPT')

    // The router's fingerprint replaces the placeholder: in sync, and no second generate.
    const v = await eventually(
      () => view(client, env),
      (x: any) => x.interfaces.find((i: any) => i.network === 'wg0')?.sync.status === 'in_sync',
      10000
    )
    const iface = v.interfaces.find((i: any) => i.network === 'wg0')
    assert.match(iface.publicKey, /^[A-Za-z0-9+/]{43}=$/)
    assert.equal(iface.portOpen.zones[0], 'wan')
    const row = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('section_name', 'wg0')
      .firstOrFail()
    assert.match(JSON.stringify(row.desiredContent), /hmac:/)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const generates = env.gw.calls.filter(
      (c) => c.method === 'gateway.config.apply' && JSON.stringify(c.params).includes('$generate')
    )
    assert.lengthOf(generates, 1)
  })

  test('a peer with generated keys: one-time client config, never stored; refusals', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const made = await createWg0(client, env)
    made.assertStatus(201)
    await allConfirmed(env)
    const v = await view(client, env)
    const wg0 = v.interfaces.find((i: any) => i.network === 'wg0')

    const both = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}/peers`)
      .bearerToken(env.adminToken)
      .json({
        label: 'phone',
        publicKey: PROVIDER_PEER_KEY,
        generateKeys: true,
        currentPassword: PASSWORD,
      })
    both.assertStatus(422)
    both.assertBodyContains({ error: 'wg_keys_choice' })

    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}/peers`)
      .bearerToken(env.adminToken)
      .json({ label: 'phone', generateKeys: true, currentPassword: PASSWORD })
    r.assertStatus(201)
    assert.equal(r.header('cache-control'), 'no-store')
    const data = r.body().data
    assert.deepInclude(data.object, { label: 'phone', routeAllowedIps: true })
    assert.deepEqual(data.object.allowedIps, ['10.7.0.2/32'])
    assert.deepEqual(data.object.presharedKey, { set: true, owner: 'controller' })
    assert.isNotNull(data.object.clientConfigIssuedAt)
    const text: string = data.clientConfig.text
    assert.equal(data.clientConfig.filename, 'wg0-phone.conf')
    const clientPrivate = /PrivateKey = (\S+)/.exec(text)![1]
    assert.include(text, `PublicKey = ${wg0.publicKey}`)
    assert.include(text, 'Address = 10.7.0.2/32')
    assert.include(text, 'AllowedIPs = 192.168.1.0/24, 10.7.0.1/24')
    assert.include(text, 'Endpoint = ')
    assert.match(text, /PresharedKey = \S+/)
    await allConfirmed(env)
    assert.notInclude(await storedText(), clientPrivate)
    const peer = env.gw.configs.network.find((s) => s.type === 'wireguard_wg0')!
    assert.equal(peer.options.public_key, data.object.publicKey)
    assert.notInclude(JSON.stringify(env.gw.configs), clientPrivate)
    assert.lengthOf(await GatewaySecret.all(), 1)

    const dup = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}/peers`)
      .bearerToken(env.adminToken)
      .json({ label: 'again', publicKey: data.object.publicKey, currentPassword: PASSWORD })
    dup.assertStatus(409)
    dup.assertBodyContains({ error: 'wg_peer_exists' })
    const badKey = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}/peers`)
      .bearerToken(env.adminToken)
      .json({ label: 'bad', publicKey: 'nope', currentPassword: PASSWORD })
    badKey.assertStatus(422)
    badKey.assertBodyContains({ error: 'wg_public_key_invalid' })

    const patched = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wireguard/peers/${data.object.id}`)
      .bearerToken(env.adminToken)
      .json({ label: 'phone (work)', keepalive: 25 })
    patched.assertStatus(200)
    assert.equal(patched.body().data.object.label, 'phone (work)')
    await allConfirmed(env)
    const del = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/wireguard/peers/${data.object.id}`)
      .bearerToken(env.adminToken)
    del.assertStatus(200)
    await allConfirmed(env)
    assert.isUndefined(env.gw.configs.network.find((s) => s.type === 'wireguard_wg0'))
  })

  test('rotate and delete need the network’s name', async ({ client, assert }) => {
    const env = await setup()
    await toManaged(client, env)
    const made = await createWg0(client, env)
    made.assertStatus(201)
    await allConfirmed(env)
    const v = await view(client, env)
    const wg0 = v.interfaces.find((i: any) => i.network === 'wg0')
    const bad = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}/rotate-key`)
      .bearerToken(env.adminToken)
      .json({ confirm: 'wg1', currentPassword: PASSWORD })
    bad.assertStatus(422)
    bad.assertBodyContains({ error: 'confirm_mismatch' })
    const before = env.gw.configs.network.find((s) => s.name === 'wg0')!.secrets!.private_key
    const rot = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}/rotate-key`)
      .bearerToken(env.adminToken)
      .json({ confirm: 'wg0', currentPassword: PASSWORD })
    rot.assertStatus(200)
    await allConfirmed(env)
    assert.notEqual(
      env.gw.configs.network.find((s) => s.name === 'wg0')!.secrets!.private_key,
      before
    )

    const noName = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}`)
      .bearerToken(env.adminToken)
      .json({ confirm: 'nope' })
    noName.assertStatus(422)
    const del = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/wireguard/interfaces/${wg0.id}`)
      .bearerToken(env.adminToken)
      .json({ confirm: 'wg0' })
    del.assertStatus(200)
    await allConfirmed(env)
    assert.isUndefined(env.gw.configs.network.find((s) => s.name === 'wg0'))
    assert.isUndefined(
      env.gw.configs.firewall.find((s) => s.type === 'rule' && s.options.dest_port === '51820')
    )
    const vpn = env.gw.configs.firewall.find((s) => s.type === 'zone' && s.options.name === 'vpn')
    assert.notInclude((vpn?.options.network as any) ?? [], 'wg0')
  })
})
