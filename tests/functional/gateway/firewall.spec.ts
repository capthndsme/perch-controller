import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayHost from '#models/gateway_host'
import GatewaySectionOrder from '#models/gateway_section_order'
import GatewayWanBlock from '#models/gateway_wan_block'
import SystemSetting from '#models/system_setting'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetPollerState } from '#services/collector_poller'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { gatewayConfigTick } from '#services/gateway_config/apply_lifecycle'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type FakeGatewayOptions, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * The firewall on the managed gateway (docs/gateway/firewall.md) against the
 * scripted gateway agent: the overview and its authz, port forwards (the
 * reservation made in the same job, overlaps refused), Perch rules and the
 * management-path guard (T-F3), the persisted rule order two-way and under
 * Authoritative Mode (T-F4), the per-device WAN block with its conntrack
 * flush (T-F1), a port forward deleted on the router (T-F2) and operator
 * sections left byte-identical by a Perch apply (T-F5).
 */

const PASSWORD = 'admin-pass-123'
const NAS_MAC = '02:00:00:00:00:41'
const PHONE_MAC = '02:00:00:00:00:60'
const CAMERA_MAC = '02:00:00:00:00:61'
const CONTROLLER_MAC = '02:00:00:00:00:05'

const anon = { anonymous: true }

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
    dhcp: [
      { name: 'lan', type: 'dhcp', options: { interface: 'lan', start: '100', limit: '150' } },
      { name: 'nas', type: 'host', options: { mac: NAS_MAC, ip: '192.168.1.50', name: 'nas' } },
    ],
    firewall: [
      {
        name: 'cfg01e63d',
        type: 'defaults',
        ...anon,
        options: { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', syn_flood: '1' },
      },
      {
        name: 'cfg02dc81',
        type: 'zone',
        ...anon,
        options: {
          name: 'lan',
          network: ['lan'],
          input: 'ACCEPT',
          output: 'ACCEPT',
          forward: 'ACCEPT',
        },
      },
      {
        name: 'cfg03dc81',
        type: 'zone',
        ...anon,
        options: {
          name: 'wan',
          network: ['wan', 'wan6'],
          input: 'REJECT',
          output: 'ACCEPT',
          forward: 'REJECT',
          masq: '1',
          mtu_fix: '1',
        },
      },
      { name: 'cfg04ad58', type: 'forwarding', ...anon, options: { src: 'lan', dest: 'wan' } },
      {
        name: 'cfg0592bd',
        type: 'rule',
        ...anon,
        options: {
          name: 'Allow-Ping',
          src: 'wan',
          proto: 'icmp',
          icmp_type: 'echo-request',
          family: 'ipv4',
          target: 'ACCEPT',
        },
      },
      {
        name: 'lan_to_wan',
        type: 'rule',
        options: { name: 'LAN-to-WAN', src: 'lan', dest: 'wan', target: 'ACCEPT' },
      },
      {
        name: 'cfg0792bd',
        type: 'rule',
        ...anon,
        options: {
          name: 'Allow-ISAKMP',
          src: 'wan',
          dest: 'lan',
          dest_port: '500',
          proto: 'udp',
          target: 'ACCEPT',
        },
      },
      {
        name: 'nas_https',
        type: 'redirect',
        options: {
          name: 'NAS-HTTPS',
          src: 'wan',
          src_dport: '5001',
          dest: 'lan',
          dest_ip: '192.168.1.50',
          proto: 'tcp',
          target: 'DNAT',
        },
      },
      {
        name: 'miniupnpd',
        type: 'include',
        options: { type: 'script', path: '/usr/share/miniupnpd/firewall.include' },
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

async function setup(
  options: FakeGatewayOptions = {},
  settings: Record<string, unknown> = {}
): Promise<Env> {
  // Confirm on the agent's fresh session, without the admin's "Keep changes".
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent', ...settings })
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
  const gw = new FakeGateway({
    configs: routerConfigs(),
    secure: true,
    capabilities: ['gateway_stats', 'gateway_config', 'net.conntrack_flush'],
    ...options,
  })
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

async function lease(env: Env, mac: string, ipv4: string) {
  await GatewayHost.create({
    collectorId: env.collector.id,
    mac,
    hostname: null,
    staticName: null,
    ipv4,
    ipv6: null,
    leaseExpiresAt: null,
    leaseInfinite: false,
    firstSeenAt: DateTime.utc(),
  })
}

async function confirmed(applyId: string) {
  return eventually(
    () => GatewayApply.findByOrFail('apply_key', applyId),
    (a) => a.state === 'confirmed',
    8000
  )
}

/** Waits until every job of the gateway (a whole chain) is finished and confirmed. */
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
  const r = await client
    .get(`/api/v1/gateways/${env.gatewayId}/firewall`)
    .bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

function names(gw: FakeGateway, type: string): string[] {
  return gw.configs.firewall.filter((s) => s.type === type).map((s) => s.options.name as string)
}

test.group('gateway firewall', (group) => {
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

  test('overview: admin only; zones, rules, forwards, observed include and defaults', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const anonymous = await client.get(`/api/v1/gateways/${env.gatewayId}/firewall`)
    anonymous.assertStatus(401)
    const operator = await client
      .get(`/api/v1/gateways/${env.gatewayId}/firewall`)
      .bearerToken(env.operatorToken)
    operator.assertStatus(403)
    const operatorWrite = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/rules`)
      .bearerToken(env.operatorToken)
      .json({ name: 'x', src: 'lan', dest: 'wan', target: 'DROP' })
    operatorWrite.assertStatus(403)

    const view = await overview(client, env)
    assert.deepEqual(
      view.zones.map((z: any) => [z.name, z.wan, z.management]),
      [
        ['lan', false, true],
        ['wan', true, false],
      ]
    )
    assert.deepEqual(view.wanZones, ['wan'])
    assert.equal(view.managementZone, 'lan')
    assert.deepEqual(
      view.rules.map((r: any) => r.name),
      ['Allow-Ping', 'LAN-to-WAN', 'Allow-ISAKMP']
    )
    assert.equal(view.rules[0].sync.owner, 'perch')
    assert.equal(view.portForwards[0].name, 'NAS-HTTPS')
    assert.deepEqual(view.portForwards[0].device, { mac: NAS_MAC, name: 'nas' })
    assert.deepEqual(view.includes, [
      {
        perchId: view.includes[0].perchId,
        section: 'miniupnpd',
        type: 'script',
        path: '/usr/share/miniupnpd/firewall.include',
        position: null,
        owner: 'package',
        sha256: null,
      },
    ])
    assert.equal(view.defaults.input, 'REJECT')
    assert.equal(view.orders.rule.status, 'in_sync')
    assert.lengthOf(view.orders.rule.desired, 3)
  })

  test('port forward to a device without a reservation: reservation first, one job', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await lease(env, CAMERA_MAC, '192.168.1.61')
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards`)
      .bearerToken(env.adminToken)
      .json({
        name: 'Camera-RTSP',
        proto: ['tcp'],
        externalPort: '8554',
        deviceMac: CAMERA_MAC,
        destPort: '554',
      })
    r.assertStatus(201)
    const body = r.body().data
    assert.isNull(body.applyError)
    assert.equal(body.object.destIp, '192.168.1.61')
    assert.equal(body.object.destZone, 'lan')
    const ops = body.apply.changes.map((c: any) => `${c.config}:${c.action}`)
    assert.deepEqual(ops, ['dhcp:create', 'firewall:create'])
    await confirmed(body.apply.id)
    const redirect = env.gw.configs.firewall.find((s) => s.options.name === 'Camera-RTSP')!
    assert.deepInclude(redirect.options, {
      src: 'wan',
      src_dport: '8554',
      dest: 'lan',
      dest_ip: '192.168.1.61',
      dest_port: '554',
      proto: 'tcp',
      target: 'DNAT',
      family: 'ipv4',
    })
    const host = env.gw.configs.dhcp.find((s) => s.options.mac === CAMERA_MAC)!
    assert.equal(host.options.ip, '192.168.1.61')

    // The same port again is refused; an unreserved address too.
    const taken = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards`)
      .bearerToken(env.adminToken)
      .json({
        name: 'Dup',
        proto: ['tcp', 'udp'],
        externalPort: '8550-8560',
        destIp: '192.168.1.50',
      })
    taken.assertStatus(409)
    taken.assertBodyContains({ error: 'firewall_port_taken', id: body.object.id })
    const unreserved = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards`)
      .bearerToken(env.adminToken)
      .json({ name: 'Static', proto: ['tcp'], externalPort: '9000', destIp: '192.168.1.200' })
    unreserved.assertStatus(422)
    unreserved.assertBodyContains({ error: 'firewall_dest_not_reserved' })
    const staged = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards?apply=0`)
      .bearerToken(env.adminToken)
      .json({
        name: 'Static',
        proto: ['tcp'],
        externalPort: '9000',
        destIp: '192.168.1.200',
        allowUnreserved: true,
      })
    staged.assertStatus(201)
    assert.isNull(staged.body().data.apply)
    assert.equal(staged.body().data.object.sync.status, 'ahead')
    const bad = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards`)
      .bearerToken(env.adminToken)
      .json({ name: 'Bad', proto: ['tcp'], externalPort: '70000', destIp: '192.168.1.50' })
    bad.assertStatus(422)
    const noDevice = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards`)
      .bearerToken(env.adminToken)
      .json({ name: 'X', proto: ['tcp'], externalPort: '9100', deviceMac: '02:00:00:00:00:99' })
    noDevice.assertStatus(409)
    noDevice.assertBodyContains({ error: 'device_no_lease' })
  })

  test('edit and delete an imported port forward; T-F2: a router delete is gone in Perch', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await overview(client, env)
    const id = view.portForwards[0].id
    const patch = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards/${id}`)
      .bearerToken(env.adminToken)
      .json({ externalPort: '5443', reflection: false })
    patch.assertStatus(200)
    await confirmed(patch.body().data.apply.id)
    const nas = env.gw.configs.firewall.find((s) => s.name === 'nas_https')!
    assert.deepInclude(nas.options, { src_dport: '5443', reflection: '0', dest_ip: '192.168.1.50' })

    // LuCI deletes it: two-way, it is gone in Perch.
    env.gw.routerEdit('firewall', (s) => {
      s.splice(
        s.findIndex((x) => x.name === 'nas_https'),
        1
      )
    })
    await eventually(
      () => overview(client, env),
      (v) => v.portForwards.length === 0
    )
    const missing = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards/${id}`)
      .bearerToken(env.adminToken)
    missing.assertStatus(404)
  })

  test('T-F3 server side: rules that would cut the controller or the admin are refused', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const post = (body: Record<string, unknown>) =>
      client
        .post(`/api/v1/gateways/${env.gatewayId}/firewall/rules`)
        .bearerToken(env.adminToken)
        .json(body)
    // "zone lan output REJECT": lan is this router's controller path.
    const output = await post({ name: 'Cut', dest: 'lan', target: 'REJECT' })
    output.assertStatus(422)
    output.assertBodyContains({ error: 'firewall_controller_path' })
    const input = await post({ name: 'Cut-in', src: 'lan', target: 'DROP' })
    input.assertStatus(422)
    input.assertBodyContains({ error: 'firewall_controller_path' })
    const luci = await post({
      name: 'No-LuCI',
      src: 'lan',
      proto: ['tcp'],
      destPort: '443',
      target: 'REJECT',
    })
    luci.assertStatus(422)
    luci.assertBodyContains({ error: 'firewall_admin_path' })
    const outputElsewhere = await post({ name: 'Out', dest: 'wan', target: 'REJECT' })
    outputElsewhere.assertStatus(422)
    outputElsewhere.assertBodyContains({ error: 'firewall_rule_unsupported' })
    const unknownZone = await post({ name: 'X', src: 'dmz', dest: 'wan', target: 'DROP' })
    unknownZone.assertStatus(422)
    unknownZone.assertBodyContains({ error: 'firewall_zone_unknown' })
    assert.isFalse(env.gw.calls.some((c) => c.method === 'gateway.config.apply'))
  })

  test('a Perch rule on top, then a reorder; the order op adopts what it moves', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/rules`)
      .bearerToken(env.adminToken)
      .json({
        name: 'Block-Telnet',
        src: 'lan',
        dest: 'wan',
        proto: ['tcp'],
        destPort: '23',
        target: 'REJECT',
        placement: 'top',
      })
    created.assertStatus(201)
    const ruleId = created.body().data.object.id
    await confirmed(created.body().data.apply.id)
    assert.deepEqual(names(env.gw, 'rule'), [
      'Block-Telnet',
      'Allow-Ping',
      'LAN-to-WAN',
      'Allow-ISAKMP',
    ])
    let view = await overview(client, env)
    assert.equal(view.orders.rule.status, 'in_sync')
    assert.equal(view.rules[0].id, ruleId)

    const ids = view.rules.map((r: any) => r.id)
    const incomplete = await client
      .put(`/api/v1/gateways/${env.gatewayId}/firewall/rules/order`)
      .bearerToken(env.adminToken)
      .json({ ids: ids.slice(1) })
    incomplete.assertStatus(422)
    incomplete.assertBodyContains({ error: 'firewall_order_incomplete' })

    // Move Allow-ISAKMP (anonymous, never adopted) to the top.
    const wanted = [ids[3], ids[0], ids[1], ids[2]]
    const reordered = await client
      .put(`/api/v1/gateways/${env.gatewayId}/firewall/rules/order`)
      .bearerToken(env.adminToken)
      .json({ ids: wanted })
    reordered.assertStatus(200)
    assert.equal(reordered.body().data.order.status, 'ahead')
    await confirmed(reordered.body().data.apply.id)
    assert.deepEqual(names(env.gw, 'rule'), [
      'Allow-ISAKMP',
      'Block-Telnet',
      'Allow-Ping',
      'LAN-to-WAN',
    ])
    const op = env.gw.orderOps.at(-1)!
    assert.equal(op.type, 'rule')
    assert.lengthOf(op.sections, 4)
    // The anonymous rules it moved were adopted (renamed perch_<id>) in the same job.
    assert.isTrue(op.sections.every((n) => n.startsWith('perch_') || n === 'lan_to_wan'))
    view = await eventually(
      () => overview(client, env),
      (v) => v.orders.rule.status === 'in_sync'
    )
    assert.deepEqual(view.orders.rule.desired, wanted)
    // Zones, the forwarding and the include never moved.
    assert.equal(env.gw.configs.firewall.find((s) => s.type === 'include')!.name, 'miniupnpd')
  })

  test('two-way: a LuCI reorder is imported; T-F4 the block rule dragged below an ACCEPT is shadowed', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await lease(env, PHONE_MAC, '192.168.1.60')
    const block = await client
      .put(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    block.assertStatus(200)
    await confirmed(block.body().data.apply.id)
    // The device page's network card carries the block (observation.md section 7).
    const card = await client
      .get(`/api/v1/devices/${PHONE_MAC}/network`)
      .bearerToken(env.operatorToken)
    card.assertStatus(200)
    assert.equal(card.body().data.gatewayId, env.gatewayId)
    assert.deepInclude(card.body().data.wanBlocked, {
      mac: PHONE_MAC,
      blocked: true,
      applied: true,
    })
    // First among the rules toward WAN: before LAN-to-WAN.
    assert.deepEqual(names(env.gw, 'rule'), [
      'Allow-Ping',
      'Perch: block internet (wan)',
      'LAN-to-WAN',
      'Allow-ISAKMP',
    ])
    let view = await overview(client, env)
    const blockRule = view.rules.find((r: any) => r.perchBlock)
    assert.isNull(blockRule.shadowedBy)

    // LuCI drags the block rule below LAN-to-WAN.
    env.gw.routerEdit('firewall', (s) => {
      const i = s.findIndex((x) => x.name === 'perch_block_wan_wan')
      const [moved] = s.splice(i, 1)
      s.splice(s.findIndex((x) => x.name === 'lan_to_wan') + 1, 0, moved)
    })
    view = await eventually(
      () => overview(client, env),
      (v) => v.rules[2]?.perchBlock === true
    )
    assert.equal(view.orders.rule.status, 'in_sync', 'imported (two-way)')
    const lanToWan = view.rules.find((r: any) => r.name === 'LAN-to-WAN')
    assert.equal(view.rules.find((r: any) => r.perchBlock).shadowedBy, lanToWan.id)
  })

  test('Authoritative: a LuCI reorder is drift, restored after the grace delay (T-F4)', async ({
    client,
    assert,
  }) => {
    const env = await setup({}, { authoritativeRevertDelaySeconds: 60 })
    await toManaged(client, env)
    const adopt = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({})
    adopt.assertStatus(202)
    await allConfirmed(env)
    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    assert.isTrue(status.body().data.inSync, JSON.stringify(status.body().data.blockers))
    const on = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({
        authoritative: true,
        expectRevision: status.body().data.headRevision,
        currentPassword: PASSWORD,
      })
    on.assertStatus(200)

    const before = names(env.gw, 'rule')
    env.gw.routerEdit('firewall', (s) => {
      const i = s.findIndex((x) => x.options.name === 'Allow-ISAKMP')
      const [moved] = s.splice(i, 1)
      s.splice(
        s.findIndex((x) => x.type === 'rule'),
        0,
        moved
      )
    })
    const drift = await eventually(
      () => GatewaySectionOrder.query().where('section_type', 'rule').firstOrFail(),
      (o) => o.status === 'drift'
    )
    assert.isNotNull(drift.driftSince)
    const blocked = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status`)
      .bearerToken(env.adminToken)
    assert.isTrue(
      blocked.body().data.blockers.some((b: any) => b.kind === 'order' && b.status === 'drift')
    )
    const gw = await Gateway.findOrFail(env.gatewayId)
    assert.equal(gw.syncState, 'drift')

    await gatewayConfigTick(DateTime.utc().plus({ seconds: 20 }))
    assert.lengthOf(await GatewayApply.query().where('kind', 'revert'), 0)
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 61 }))
    const revert = await eventually(
      () => GatewayApply.query().where('kind', 'revert').first(),
      (a) => a !== null && a.state === 'confirmed',
      8000
    )
    assert.isTrue(revert!.ops.some((op) => op.op === 'order'))
    assert.deepEqual(names(env.gw, 'rule'), before)
    await eventually(
      () => GatewaySectionOrder.query().where('section_type', 'rule').firstOrFail(),
      (o) => o.status === 'in_sync'
    )
  })

  test('T-F1 server side: block and unblock a device, conntrack flush after the apply is live', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    await lease(env, PHONE_MAC, '192.168.1.60')
    await lease(env, CONTROLLER_MAC, '192.168.1.5')

    const operator = await client
      .put(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.operatorToken)
      .json({ blocked: true })
    operator.assertStatus(403)
    const self = await client
      .put(`/api/v1/devices/${CONTROLLER_MAC}/wan-access`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    self.assertStatus(422)
    self.assertBodyContains({ error: 'wan_block_self' })

    const block = await client
      .put(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.adminToken)
      .json({ blocked: true, note: 'homework time' })
    block.assertStatus(200)
    const body = block.body().data
    assert.isTrue(body.object.blocked)
    assert.isFalse(body.object.applied)
    // The flush waits for the fresh session after the commit.
    assert.oneOf(body.flushed, [null, true])
    await confirmed(body.apply.id)

    const set = env.gw.configs.firewall.find((s) => s.name === 'perch_block_wan')!
    assert.deepEqual(set.options, {
      name: 'perch_block_wan',
      match: 'src_mac',
      entry: [PHONE_MAC],
    })
    const rule = env.gw.configs.firewall.find((s) => s.name === 'perch_block_wan_wan')!
    assert.deepInclude(rule.options, {
      src: '*',
      dest: 'wan',
      ipset: 'perch_block_wan',
      target: 'REJECT',
    })
    assert.deepEqual(env.gw.flushes, [{ ips: ['192.168.1.60'] }])

    const got = await client
      .get(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.operatorToken)
    got.assertStatus(200)
    const state = got.body().data
    assert.isTrue(state.blocked)
    assert.isTrue(state.applied)
    assert.isTrue(state.ruleEnabled)
    assert.equal(state.note, 'homework time')
    assert.isTrue(state.lastFlush.flushed)
    assert.deepEqual(state.lastFlush.ips, ['192.168.1.60'])
    assert.isNotNull(state.since)

    // LuCI disables the rule: still blocked in Perch, but "rule disabled on router".
    env.gw.routerEdit('firewall', (s) => {
      s.find((x) => x.name === 'perch_block_wan_wan')!.options.enabled = '0'
    })
    await eventually(
      async () => {
        const r = await client
          .get(`/api/v1/devices/${PHONE_MAC}/wan-access`)
          .bearerToken(env.adminToken)
        return r.body().data
      },
      (d) => d.ruleEnabled === false
    )

    // A second device joins the set; the rule is not duplicated.
    await lease(env, CAMERA_MAC, '192.168.1.61')
    const second = await client
      .put(`/api/v1/devices/${CAMERA_MAC}/wan-access`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    second.assertStatus(200)
    await confirmed(second.body().data.apply.id)
    assert.lengthOf(
      env.gw.configs.firewall.filter((s) => s.options.ipset === 'perch_block_wan'),
      1
    )
    assert.sameMembers(
      env.gw.configs.firewall.find((s) => s.name === 'perch_block_wan')!.options.entry as string[],
      [PHONE_MAC, CAMERA_MAC]
    )

    const unblock = await client
      .put(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.adminToken)
      .json({ blocked: false })
    unblock.assertStatus(200)
    await confirmed(unblock.body().data.apply.id)
    assert.deepEqual(
      env.gw.configs.firewall.find((s) => s.name === 'perch_block_wan')!.options.entry,
      [CAMERA_MAC]
    )
    assert.lengthOf(env.gw.flushes, 2, 'no flush on unblock')
    assert.isNull(await GatewayWanBlock.findBy('mac', PHONE_MAC))
  })

  test('without the conntrack capability the block applies and says so', async ({
    client,
    assert,
  }) => {
    const env = await setup({ capabilities: ['gateway_stats', 'gateway_config'] })
    await toManaged(client, env)
    await lease(env, PHONE_MAC, '192.168.1.60')
    const block = await client
      .put(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.adminToken)
      .json({ blocked: true })
    await confirmed(block.body().data.apply.id)
    const got = await client
      .get(`/api/v1/devices/${PHONE_MAC}/wan-access`)
      .bearerToken(env.adminToken)
    assert.isTrue(got.body().data.blocked)
    assert.isNull(got.body().data.lastFlush.flushed)
    assert.equal(got.body().data.lastFlush.reason, 'capability_missing')
    assert.lengthOf(env.gw.flushes, 0)
  })

  test('T-F5 server side: operator rules, the include and their order stay byte-identical', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    // LuCI adds a custom rule and an nftables include.
    env.gw.routerEdit('firewall', (s) => {
      s.push({
        name: 'cfg0f92bd',
        type: 'rule',
        anonymous: true,
        options: {
          name: 'Operator-Custom',
          src: 'wan',
          proto: 'tcp',
          dest_port: '8',
          target: 'DROP',
        },
      })
      s.push({
        name: 'cfg1092bd',
        type: 'include',
        anonymous: true,
        options: { type: 'nftables', path: '/etc/nftables.d/10-custom.nft', position: 'chain-pre' },
      })
    })
    await eventually(
      () => overview(client, env),
      (v) => v.rules.some((r: any) => r.name === 'Operator-Custom') && v.includes.length === 2
    )
    const before = JSON.parse(JSON.stringify(env.gw.configs.firewall)) as Section[]
    const r = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/port-forwards`)
      .bearerToken(env.adminToken)
      .json({ name: 'Game', proto: ['udp'], externalPort: '27015', destIp: '192.168.1.50' })
    r.assertStatus(201)
    await confirmed(r.body().data.apply.id)
    const after = env.gw.configs.firewall
    const perch = new Set(
      env.gw.ledger.filter((e) => e.config === 'firewall').map((e) => e.section)
    )
    const operatorOnly = (list: Section[]) => list.filter((s) => !perch.has(s.name))
    assert.deepEqual(operatorOnly(after), operatorOnly(before))
    assert.equal(after.length, before.length + 1)
    // Placed after its neighbour in the redirect order (NAS-HTTPS).
    const game = after.findIndex((x) => x.options.name === 'Game')
    assert.equal(after[game - 1].name, 'nas_https')
  })

  test('includes never drift under Authoritative Mode', async ({ client, assert }) => {
    const env = await setup({}, { authoritativeRevertDelaySeconds: 0 })
    await toManaged(client, env)
    const adopt = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({})
    adopt.assertStatus(202)
    await allConfirmed(env)
    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    const on = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({
        authoritative: true,
        expectRevision: status.body().data.headRevision,
        currentPassword: PASSWORD,
      })
    on.assertStatus(200)
    env.gw.routerEdit('firewall', (s) => {
      s.find((x) => x.name === 'miniupnpd')!.options.reload = '1'
    })
    await eventually(
      () => overview(client, env),
      (v) => v.includes[0] && v.includes[0].section === 'miniupnpd'
    )
    await gatewayQueue.drain(env.gatewayId)
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 5 }))
    assert.lengthOf(await GatewayApply.query().where('kind', 'revert'), 0)
    assert.equal(env.gw.configs.firewall.find((s) => s.name === 'miniupnpd')!.options.reload, '1')
    const gw = await Gateway.findOrFail(env.gatewayId)
    assert.notEqual(gw.syncState, 'drift')
  })

  test('order conflict (two-way): staged reorder vs a LuCI reorder; "in sync" waits; resolve', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await overview(client, env)
    const [ping, lanToWan, isakmp] = view.rules.map((r: any) => r.id)
    const staged = await client
      .put(`/api/v1/gateways/${env.gatewayId}/firewall/rules/order?apply=0`)
      .bearerToken(env.adminToken)
      .json({ ids: [lanToWan, ping, isakmp] })
    staged.assertStatus(200)
    assert.isNull(staged.body().data.apply)
    assert.equal(staged.body().data.order.status, 'ahead')

    // "In sync" (the Authoritative precondition) counts the order.
    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status`)
      .bearerToken(env.adminToken)
    assert.isTrue(
      status.body().data.blockers.some((b: any) => b.kind === 'order' && b.status === 'ahead')
    )

    // LuCI moves ISAKMP to the top: both sides reordered differently.
    env.gw.routerEdit('firewall', (s) => {
      const i = s.findIndex((x) => x.options.name === 'Allow-ISAKMP')
      const [moved] = s.splice(i, 1)
      s.splice(
        s.findIndex((x) => x.type === 'rule'),
        0,
        moved
      )
    })
    await eventually(
      () => overview(client, env),
      (v) => v.orders.rule.status === 'conflict'
    )
    const gw = await Gateway.findOrFail(env.gatewayId)
    assert.equal(gw.syncState, 'conflict')
    const nothing = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/order/resolve`)
      .bearerToken(env.adminToken)
      .json({ type: 'redirect', take: 'router' })
    nothing.assertStatus(409)
    nothing.assertBodyContains({ error: 'nothing_to_resolve' })
    const resolved = await client
      .post(`/api/v1/gateways/${env.gatewayId}/firewall/order/resolve`)
      .bearerToken(env.adminToken)
      .json({ type: 'rule', take: 'router' })
    resolved.assertStatus(200)
    assert.equal(resolved.body().data.order.status, 'in_sync')
    assert.deepEqual(resolved.body().data.order.desired, [isakmp, ping, lanToWan])
    assert.isNull(resolved.body().data.apply)
  })
})
