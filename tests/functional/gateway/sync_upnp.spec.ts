import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
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
 * Gateway sync B5 (docs/design/gateway-sync/rest.md 8, domains.md 8, D10):
 * miniupnpd's settings and ordered ACL against the scripted gateway;
 * turning UPnP on turns secure mode on; rules by device (its reservation);
 * the order; deleting live mappings (runtime `gateway.upnp.delete`); and the
 * per-device block, whose mappings go once its deny rule is live.
 */

let gateways: FakeGateway[] = []

const NAS_MAC = '02:00:00:00:00:20'
const PS5_MAC = '02:00:00:00:00:21'

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
      {
        name: 'guest',
        type: 'interface',
        options: {
          device: 'br-guest',
          proto: 'static',
          ipaddr: '192.168.2.1',
          netmask: '255.255.255.0',
        },
      },
      { name: 'wan', type: 'interface', options: { device: 'eth1', proto: 'dhcp' } },
    ],
    dhcp: [
      { name: 'lan', type: 'dhcp', options: { interface: 'lan', start: '100', limit: '150' } },
      { name: 'nas', type: 'host', options: { mac: NAS_MAC, ip: '192.168.1.20', name: 'nas' } },
      { name: 'ps5', type: 'host', options: { mac: PS5_MAC, ip: '192.168.1.30', name: 'ps5' } },
    ],
    upnpd: [
      {
        name: 'config',
        type: 'upnpd',
        options: {
          enabled: '0',
          enable_upnp: '1',
          enable_natpmp: '1',
          secure_mode: '0',
          internal_iface: 'lan',
          upnp_lease_file: '/var/run/miniupnpd.leases',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
      },
      {
        name: 'cfg04a0b1',
        type: 'perm_rule',
        anonymous: true,
        options: {
          action: 'allow',
          ext_ports: '1024-65535',
          int_addr: '0.0.0.0/0',
          int_ports: '1024-65535',
          comment: 'Allow high ports',
        },
      },
      {
        name: 'cfg05a0b1',
        type: 'perm_rule',
        anonymous: true,
        options: {
          action: 'deny',
          ext_ports: '0-65535',
          int_addr: '0.0.0.0/0',
          int_ports: '0-65535',
          comment: 'Default deny',
        },
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
  if (!installed) delete configs.upnpd
  const gw = new FakeGateway({
    configs,
    secure: opts.secure ?? true,
    capabilities: ['gateway_stats', 'gateway_config'],
    features: opts.features ?? ['upnp.delete'],
  })
  if (installed) gw.packages.miniupnpd = '2.3.3-r1'
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
    .get(`/api/v1/gateways/${env.gatewayId}/upnp/config`)
    .bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

function observeMappings(env: Env) {
  return recordGatewayObservation(env.collectorId, {
    upnp: {
      installed: true,
      enabled: true,
      running: true,
      secureMode: true,
      mappings: [
        {
          proto: 'UDP',
          extPort: 3074,
          intIp: '192.168.1.30',
          intPort: 3074,
          expires: 0,
          description: 'console',
        },
        {
          proto: 'TCP',
          extPort: 51413,
          intIp: '192.168.1.20',
          intPort: 51413,
          expires: 0,
          description: 'torrent',
        },
      ],
    },
  })
}

function rulesOf(gw: FakeGateway) {
  return gw.configs.upnpd.filter((s) => s.type === 'perm_rule')
}

test.group('gateway sync | UPnP (B5)', (group) => {
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

  test('overview: settings, the ordered ACL, live mappings', async ({ client, assert }) => {
    const env = await setup()
    await toManaged(client, env)
    await observeMappings(env)
    const v = await view(client, env)
    assert.deepInclude(v, {
      installed: true,
      available: true,
      running: true,
      canDeleteMappings: true,
    })
    assert.deepInclude(v.settings, {
      enabled: false,
      upnp: true,
      natpmp: true,
      secureMode: false,
      externalInterface: null,
    })
    assert.deepEqual(v.settings.internalInterfaces, ['lan'])
    assert.deepEqual(Object.keys(v.settings.extra).sort(), ['upnp_lease_file', 'uuid'])
    assert.deepEqual(
      v.acl.map((r: any) => [r.position, r.action, r.intAddr, r.shadowedBy]),
      [
        [0, 'allow', '0.0.0.0/0', null],
        [1, 'deny', '0.0.0.0/0', null],
      ]
    )
    assert.equal(v.aclOrder.status, 'in_sync')
    assert.sameMembers(
      v.mappings.map((m: any) => `${m.proto}:${m.externalPort}`),
      ['UDP:3074', 'TCP:51413']
    )
  })

  test('turning UPnP on turns secure mode on (D10); unknown interfaces refused', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const bad = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/upnp/config`)
      .bearerToken(env.adminToken)
      .json({ internalInterfaces: ['lan', 'nope'] })
    bad.assertStatus(422)
    bad.assertBodyContains({ error: 'upnp_interface_unknown' })
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/upnp/config`)
      .bearerToken(env.adminToken)
      .json({ enabled: true, internalInterfaces: ['lan', 'guest'] })
    r.assertStatus(200)
    assert.isTrue(r.body().data.object.settings.enabled)
    assert.isTrue(r.body().data.object.settings.secureMode)
    await allConfirmed(env)
    const settings = env.gw.configs.upnpd.find((s) => s.type === 'upnpd')!
    assert.equal(settings.options.enabled, '1')
    assert.equal(settings.options.secure_mode, '1')
    assert.deepEqual(settings.options.internal_iface, ['lan', 'guest'])
    assert.equal(settings.options.upnp_lease_file, '/var/run/miniupnpd.leases')
  })

  test('ACL: a device rule on top by its reservation, reorder, shadow warning, delete', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/upnp/acl`)
      .bearerToken(env.adminToken)
      .json({
        action: 'allow',
        extPorts: '3074',
        deviceMac: PS5_MAC,
        intPorts: '3074',
        comment: 'console',
        placement: 'top',
      })
    r.assertStatus(201)
    const rule = r.body().data.object
    assert.deepInclude(rule, {
      position: 0,
      action: 'allow',
      intAddr: '192.168.1.30',
      extPorts: '3074',
    })
    assert.deepEqual(rule.device, { mac: PS5_MAC, name: 'ps5' })
    await allConfirmed(env)
    assert.deepEqual(
      rulesOf(env.gw).map((s) => s.options.comment),
      ['console', 'Allow high ports', 'Default deny']
    )

    // A deny for everyone above it shadows it.
    const deny = await client
      .post(`/api/v1/gateways/${env.gatewayId}/upnp/acl`)
      .bearerToken(env.adminToken)
      .json({
        action: 'deny',
        extPorts: '0-65535',
        intAddr: '192.168.1.0/24',
        intPorts: '0-65535',
        placement: 'top',
      })
    deny.assertStatus(201)
    assert.include(
      deny.body().data.issues.map((i: any) => i.code),
      'upnp_acl_shadowed'
    )
    await allConfirmed(env)
    let v = await view(client, env)
    assert.equal(v.acl[1].shadowedBy, deny.body().data.object.id)

    const ids = v.acl.map((x: any) => x.id)
    const incomplete = await client
      .put(`/api/v1/gateways/${env.gatewayId}/upnp/acl/order`)
      .bearerToken(env.adminToken)
      .json({ ids: ids.slice(1) })
    incomplete.assertStatus(422)
    incomplete.assertBodyContains({ error: 'upnp_order_incomplete' })
    const reordered = await client
      .put(`/api/v1/gateways/${env.gatewayId}/upnp/acl/order`)
      .bearerToken(env.adminToken)
      .json({ ids: [ids[1], ids[0], ids[2], ids[3]] })
    reordered.assertStatus(200)
    await allConfirmed(env)
    v = await view(client, env)
    assert.isNull(v.acl[0].shadowedBy)
    assert.equal(rulesOf(env.gw)[0].options.comment, 'console')

    const del = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/upnp/acl/${deny.body().data.object.id}`)
      .bearerToken(env.adminToken)
    del.assertStatus(200)
    await allConfirmed(env)
    assert.lengthOf(rulesOf(env.gw), 3)
    const invalid = await client
      .post(`/api/v1/gateways/${env.gatewayId}/upnp/acl`)
      .bearerToken(env.adminToken)
      .json({ action: 'allow', extPorts: '70000', intAddr: '192.168.1.5', intPorts: '1' })
    invalid.assertStatus(422)
    invalid.assertBodyContains({ error: 'upnp_ports_invalid' })
  })

  test('mappings delete: runtime, gated by the agent feature', async ({ client, assert }) => {
    const env = await setup()
    await toManaged(client, env)
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/upnp/mappings/delete`)
      .bearerToken(env.adminToken)
      .json({ mappings: [{ proto: 'UDP', externalPort: 3074 }] })
    r.assertStatus(200)
    assert.deepEqual(r.body().data, { deleted: 1, notFound: 0, restarted: true })
    assert.deepEqual(env.gw.upnpDeletes, [{ proto: 'UDP', extPort: 3074 }])

    await env.gw.destroy()
    await resetAll()
    const old = await setup({ features: [] })
    await toManaged(client, old)
    const refused = await client
      .post(`/api/v1/gateways/${old.gatewayId}/upnp/mappings/delete`)
      .bearerToken(old.adminToken)
      .json({ mappings: [{ proto: 'UDP', externalPort: 3074 }] })
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'gateway_capability_missing', capability: 'upnp.delete' })
  })

  test('block a device: a deny on top, its mappings deleted once the rule is live; unblock', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await observeMappings(env)
    const r = await client
      .put(`/api/v1/gateways/${env.gatewayId}/upnp/devices/${PS5_MAC}`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    r.assertStatus(200)
    assert.deepInclude(r.body().data.object, {
      action: 'deny',
      intAddr: '192.168.1.30',
      position: 0,
    })
    assert.equal(r.body().data.deletedMappings, 1)
    await allConfirmed(env)
    assert.equal(rulesOf(env.gw)[0].options.action, 'deny')
    assert.equal(rulesOf(env.gw)[0].options.int_addr, '192.168.1.30')
    await eventually(
      async () => env.gw.upnpDeletes.length,
      (n) => n > 0
    )
    assert.deepEqual(env.gw.upnpDeletes, [{ proto: 'UDP', extPort: 3074 }])

    const again = await client
      .put(`/api/v1/gateways/${env.gatewayId}/upnp/devices/${PS5_MAC}`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    again.assertStatus(200)
    assert.isNull(again.body().data.apply)

    const un = await client
      .put(`/api/v1/gateways/${env.gatewayId}/upnp/devices/${PS5_MAC}`)
      .bearerToken(env.adminToken)
      .json({ blocked: false })
    un.assertStatus(200)
    await allConfirmed(env)
    assert.lengthOf(rulesOf(env.gw), 2)
    const badMac = await client
      .put(`/api/v1/gateways/${env.gatewayId}/upnp/devices/nope`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    badMac.assertStatus(400)
  })

  test('not installed: offered for install, writes refused', async ({ client, assert }) => {
    const env = await setup({ installed: false })
    await toManaged(client, env)
    const v = await view(client, env)
    assert.deepInclude(v, {
      installed: false,
      available: false,
      unavailableReason: 'not_installed',
      settings: null,
    })
    assert.deepEqual(v.installPackages, ['miniupnpd'])
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/upnp/config`)
      .bearerToken(env.adminToken)
      .json({ enabled: true })
    r.assertStatus(409)
    r.assertBodyContains({ error: 'upnp_not_installed' })
  })
})
