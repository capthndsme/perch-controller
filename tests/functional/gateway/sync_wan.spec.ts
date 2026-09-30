import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayConfigEvent from '#models/gateway_config_event'
import GatewaySection from '#models/gateway_section'
import GatewayWanTransition from '#models/gateway_wan_transition'
import SystemSetting from '#models/system_setting'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetPollerState } from '#services/collector_poller'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { GATEWAY_SYNC_SETTING_KEY } from '#services/gateway_config/gateway_sync_settings'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { recordGatewayObservation } from '#services/gateway_observe'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type Section } from '#tests/helpers/fake_gateway'
import { gatewaySyncConfig } from '#tests/unit/services/fixtures/gateway_sync'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * Gateway sync Phase B against the scripted gateway (docs/design/gateway-sync;
 * work packages B0 checks and B1): the live-shaped WAN side (three DHCP
 * uplinks, companions, aliases, a NAT link; placeholders only) as the `wan`
 * domain's objects, a WAN edit as a checked job whose router checks gate the
 * confirm (pass, fail → early rollback, "Keep anyway" with the gateway's
 * name), `wan_last_uplink`, the draft's job view, Settings → Gateway sync and
 * the WAN transitions.
 */

const PASSWORD = 'admin-pass-123'

function section(s: {
  name: string
  type: string
  anonymous: boolean
  options: Section['options']
}): Section {
  return {
    name: s.name,
    type: s.type,
    ...(s.anonymous ? { anonymous: true } : {}),
    options: { ...s.options },
  }
}

function routerConfigs(): Record<string, Section[]> {
  return {
    network: gatewaySyncConfig('network').sections.map(section),
    firewall: gatewaySyncConfig('firewall_zones').sections.map(section),
    dhcp: gatewaySyncConfig('dhcp').sections.map(section),
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

type Env = { adminToken: string; gw: FakeGateway; gatewayId: number; collectorId: number }

async function setup(options: { features?: string[]; wanConfirmMode?: string } = {}): Promise<Env> {
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, { confirmMode: 'agent' })
  await SystemSetting.set(GATEWAY_SYNC_SETTING_KEY, {
    wanConfirmMode: options.wanConfirmMode ?? 'agent',
  })
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
  const gw = new FakeGateway({
    configs: routerConfigs(),
    secure: true,
    capabilities: ['gateway_stats', 'gateway_config', 'observe.interfaces'],
    features: options.features ?? ['config.checks.v1'],
    confirmMs: 4000,
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
    .json({ mode: 'managed', currentPassword: PASSWORD })
  r.assertStatus(200)
  await gatewayQueue.drain(env.gatewayId)
}

async function overview(client: any, env: Env) {
  const r = await client.get(`/api/v1/gateways/${env.gatewayId}/wan`).bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

function wanOf(view: any, network: string) {
  return [...view.uplinks, ...view.natLinks].find((w: any) => w.network === network)
}

async function applyNamed(env: Env, applyKey: string) {
  return GatewayApply.query()
    .where('gateway_id', env.gatewayId)
    .where('apply_key', applyKey)
    .firstOrFail()
}

async function settled(env: Env, applyKey: string, states: string[]) {
  const apply = await eventually(
    () => applyNamed(env, applyKey),
    (a) => states.includes(a.state),
    15000
  )
  await gatewayQueue.drain(env.gatewayId)
  return apply
}

function interfaceOf(gw: FakeGateway, name: string) {
  return gw.configs.network.find((s) => s.name === name)!
}

test.group('gateway sync | WAN and apply checks', (group) => {
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

  test('the WAN view: three uplinks by rank, companions, aliases, a NAT link', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await overview(client, env)
    assert.isTrue(view.available)
    assert.deepEqual(
      view.uplinks.map((w: any) => [w.network, w.failoverRank, w.role, w.proto, w.editable]),
      [
        ['wan', 1, 'internet', 'dhcp', 'full'],
        ['lan2', 2, 'internet', 'dhcp', 'full'],
        ['globe', 3, 'internet', 'dhcp', 'full'],
      ]
    )
    assert.deepEqual(
      view.natLinks.map((w: any) => [w.network, w.role, w.failoverRank]),
      [['LANX', 'nat_link', null]]
    )
    const wan = wanOf(view, 'wan')
    assert.deepEqual(
      wan.aliases.map((a: any) => [a.network, a.addresses]),
      [['ADDR', ['192.168.100.21/24', '192.168.101.244/24']]]
    )
    assert.equal(wan.ipv6.mode, 'dhcpv6')
    assert.equal(wan.zone, 'wan')
    assert.isTrue(wan.zoneMasq)
    assert.deepEqual(wan.mac, {
      effective: '02:00:00:00:00:0b',
      source: 'device',
      deviceSection: wan.mac.deviceSection,
      ignoredInterfaceMac: true,
    })
    assert.equal(wan.pool.ignore, true)
    assert.equal(wan.sync.scope, 'synced')
    assert.deepEqual(
      wanOf(view, 'globe').aliases.map((a: any) => a.network),
      ['globe_force']
    )
    assert.deepEqual(
      view.failover.order,
      view.uplinks.map((w: any) => w.id)
    )
    assert.deepEqual(view.managementPath, { network: 'lan', wanSide: false })
    assert.deepEqual(view.checks.targets, ['$gateway', '1.1.1.1', '8.8.8.8'])

    // globe_force is the wan domain's, not a LAN network.
    const gf = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('section_name', 'globe_force')
      .firstOrFail()
    assert.equal(gf.domain, 'wan')
    const r = await client
      .get(`/api/v1/gateways/${env.gatewayId}/wan/nope`)
      .bearerToken(env.adminToken)
    r.assertStatus(404)
    assert.equal(r.body().error, 'wan_not_found')
  })

  test('a WAN edit is a checked job; the router’s checks pass, then it confirms', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const globe = wanOf(await overview(client, env), 'globe')
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${globe.id}`)
      .bearerToken(env.adminToken)
      .json({ metric: 101, label: 'WAN 3' })
    r.assertStatus(200)
    const body = r.body().data
    assert.isNull(body.applyError)
    assert.equal(body.object.label, 'WAN 3')
    // The WAN confirm window asked (the scripted router grants its own 4 s).
    const asked = env.gw.calls.find((c) => c.method === 'gateway.config.apply')!
    assert.equal(asked.params.confirmTimeoutSeconds, 300)
    assert.deepEqual(
      body.apply.checks.items.map((i: any) => [i.id, i.kind, i.mustPass]),
      [
        ['up:globe', 'interface_up', false],
        ['route4', 'default_route', false],
        ['reach4', 'reach', false],
        ['dns', 'resolve', false],
      ]
    )
    assert.deepEqual(body.apply.checks.items[2].targets, ['$gateway:wan', '1.1.1.1', '8.8.8.8'])
    const sent = env.gw.calls.find((c) => c.method === 'gateway.config.apply')!
    assert.deepInclude(sent.params.checks as object, { v: 1, timeoutSeconds: 60 })

    const apply = await settled(env, body.apply.id, ['confirmed', 'rolled_back', 'failed'])
    assert.equal(apply.state, 'confirmed')
    assert.equal(apply.checksState, 'passed')
    assert.equal(interfaceOf(env.gw, 'globe').options.metric, '101')
    const events = await GatewayConfigEvent.query()
      .where('gateway_id', env.gatewayId)
      .where('event', 'checks_passed')
    assert.lengthOf(events, 1)
    const confirm = env.gw.calls.find((c) => c.method === 'gateway.config.confirm')!
    assert.isUndefined(confirm.params.overrideChecks)
  })

  test('failed checks: the router rolls back early, the draft stays, the failed items shown', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    env.gw.checksOutcome = 'fail'
    const lan2 = wanOf(await overview(client, env), 'lan2')
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${lan2.id}`)
      .bearerToken(env.adminToken)
      .json({ metric: 5 })
    r.assertStatus(200)
    const applyId = r.body().data.apply.id
    const apply = await settled(env, applyId, ['rolled_back', 'failed', 'confirmed'])
    assert.equal(apply.state, 'rolled_back')
    assert.equal(apply.checksState, 'failed')
    assert.equal(apply.outcome?.reason, 'checks_failed')
    assert.equal(interfaceOf(env.gw, 'lan2').options.metric, '2', 'restored on the router')

    const view = await client
      .get(`/api/v1/gateways/${env.gatewayId}/applies/${applyId}`)
      .bearerToken(env.adminToken)
    const served = view.body().data
    assert.equal(served.checks.state, 'failed')
    assert.deepEqual(
      served.outcome.checks.map((i: any) => [i.id, i.state]),
      [['up:lan2', 'failed']]
    )
    const row = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('section_name', 'lan2')
      .firstOrFail()
    assert.equal(row.desiredContent?.options.metric, '5', 'the draft is kept for a retry')
    assert.isFalse(env.gw.calls.some((c) => c.method === 'gateway.config.confirm'))
  })

  test('"Keep anyway": 409 while checks run, 422 without the name, then confirmed', async ({
    client,
    assert,
  }) => {
    const env = await setup({ wanConfirmMode: 'admin_and_agent' })
    await toManaged(client, env)
    env.gw.checksOutcome = 'hold'
    const globe = wanOf(await overview(client, env), 'globe')
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${globe.id}`)
      .bearerToken(env.adminToken)
      .json({ metric: 150 })
    const applyId = r.body().data.apply.id
    assert.equal(r.body().data.apply.confirmMode, 'admin_and_agent')
    await eventually(
      () => applyNamed(env, applyId),
      (a) => a.checksState === 'running' && a.agentConfirmedAt !== null,
      10000
    )
    const confirm = (body: object) =>
      client
        .post(`/api/v1/gateways/${env.gatewayId}/applies/${applyId}/confirm`)
        .bearerToken(env.adminToken)
        .json(body)
    const plain = await confirm({})
    plain.assertStatus(409)
    assert.equal(plain.body().error, 'checks_pending')
    const wrong = await confirm({ overrideChecks: true, confirm: 'nope' })
    wrong.assertStatus(422)
    assert.equal(wrong.body().error, 'confirm_mismatch')
    const ok = await confirm({ overrideChecks: true, confirm: 'gateway' })
    ok.assertStatus(200)
    assert.equal(ok.body().data.checks.state, 'overridden')
    assert.isNotNull(ok.body().data.checks.overriddenBy)
    const apply = await settled(env, applyId, ['confirmed', 'rolled_back', 'failed'])
    assert.equal(apply.state, 'confirmed')
    const sent = env.gw.calls.filter((c) => c.method === 'gateway.config.confirm')
    assert.isTrue(sent.some((c) => c.params.overrideChecks === true))
    const events = await GatewayConfigEvent.query()
      .where('gateway_id', env.gatewayId)
      .where('event', 'checks_overridden')
    assert.lengthOf(events, 1)
  })

  test('wan_last_uplink: refused without the name; with it, no checks are sent', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await overview(client, env)
    // Two uplinks off with ?apply=0, then the last one.
    for (const network of ['lan2', 'globe']) {
      const r = await client
        .patch(`/api/v1/gateways/${env.gatewayId}/wan/${wanOf(view, network).id}?apply=0`)
        .bearerToken(env.adminToken)
        .json({ enabled: false })
      r.assertStatus(200)
    }
    const last = wanOf(view, 'wan')
    const refused = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${last.id}`)
      .bearerToken(env.adminToken)
      .json({ enabled: false })
    refused.assertStatus(409)
    assert.equal(refused.body().error, 'wan_last_uplink')
    assert.equal(refused.body().confirm, 'gateway')
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${last.id}`)
      .bearerToken(env.adminToken)
      .json({ enabled: false, confirm: 'gateway' })
    r.assertStatus(200)
    const apply = r.body().data.apply
    assert.isNull(apply.checks, 'no checks on the view')
    assert.match(apply.note, /without checks/)
    const sent = env.gw.calls.find((c) => c.method === 'gateway.config.apply')!
    assert.deepEqual(sent.params.checks, { v: 1, items: [] })
  })

  test('a collector without config.checks.v1: the WAN stays the router’s, read only', async ({
    client,
    assert,
  }) => {
    const env = await setup({ features: [] })
    await toManaged(client, env)
    const view = await overview(client, env)
    assert.isFalse(view.available)
    assert.equal(view.unavailableReason, 'capability_missing')
    const wan = wanOf(view, 'wan')
    assert.equal(wan.sync.scope, 'unmodeled')
    const r = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${wan.id}`)
      .bearerToken(env.adminToken)
      .json({ metric: 3 })
    r.assertStatus(409)
    assert.equal(r.body().error, 'gateway_capability_missing')
    // Perch-only metadata works without an apply.
    const label = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${wan.id}`)
      .bearerToken(env.adminToken)
      .json({ label: 'Fibre' })
    label.assertStatus(200)
    assert.equal(label.body().data.object.label, 'Fibre')
    assert.isNull(label.body().data.apply)
  })

  test('the draft shows the checked job with its checks, window and mode', async ({
    client,
    assert,
  }) => {
    const env = await setup({ wanConfirmMode: 'admin_and_agent' })
    await toManaged(client, env)
    const globe = wanOf(await overview(client, env), 'globe')
    const staged = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${globe.id}?apply=0`)
      .bearerToken(env.adminToken)
      .json({ metric: 120 })
    staged.assertStatus(200)
    assert.isNull(staged.body().data.apply)
    const draft = await client
      .get(`/api/v1/gateways/${env.gatewayId}/draft`)
      .bearerToken(env.adminToken)
    draft.assertStatus(200)
    const job = draft.body().data.jobs.find((j: any) => j.checked)
    assert.equal(job.confirmTimeoutSeconds, 300)
    assert.equal(job.confirmMode, 'admin_and_agent')
    assert.deepEqual(
      job.checks.map((i: any) => [i.id, i.state]),
      [
        ['up:globe', 'pending'],
        ['route4', 'pending'],
        ['reach4', 'pending'],
        ['dns', 'pending'],
      ]
    )
  })

  test('order, alias and delete guards', async ({ client, assert }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await overview(client, env)
    const ids = view.uplinks.map((w: any) => w.id)
    const bad = await client
      .put(`/api/v1/gateways/${env.gatewayId}/wan/order?apply=0`)
      .bearerToken(env.adminToken)
      .json({ ids: ids.slice(0, 2) })
    bad.assertStatus(422)
    assert.equal(bad.body().error, 'wan_order_incomplete')
    const order = await client
      .put(`/api/v1/gateways/${env.gatewayId}/wan/order?apply=0`)
      .bearerToken(env.adminToken)
      .json({ ids: [ids[1], ids[0], ids[2]] })
    order.assertStatus(200)
    assert.deepEqual(
      order.body().data.object.uplinks.map((w: any) => [w.network, w.metric]),
      [
        ['lan2', 1],
        ['wan', 2],
        ['globe', 100],
      ]
    )
    const toStatic = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/wan/${ids[1]}?apply=0`)
      .bearerToken(env.adminToken)
      .json({ proto: 'static', static: { addresses: ['203.0.113.10/24'], gateway: '203.0.113.1' } })
    toStatic.assertStatus(200)
    const overlap = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wan/${ids[1]}/aliases?apply=0`)
      .bearerToken(env.adminToken)
      .json({ network: 'lan2_x', addresses: ['203.0.113.0/24'] })
    overlap.assertStatus(422)
    assert.equal(overlap.body().error, 'wan_alias_overlaps_uplink')
    const alias = await client
      .post(`/api/v1/gateways/${env.gatewayId}/wan/${ids[0]}/aliases?apply=0`)
      .bearerToken(env.adminToken)
      .json({ network: 'modem', addresses: ['192.168.8.2/24'] })
    alias.assertStatus(201)
    assert.equal(alias.body().data.object.network, 'modem')
    const del = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/wan/${ids[2]}?apply=0`)
      .bearerToken(env.adminToken)
      .json({ confirm: 'wrong' })
    del.assertStatus(422)
    const deleted = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/wan/${ids[2]}?apply=0`)
      .bearerToken(env.adminToken)
      .json({ confirm: 'globe' })
    deleted.assertStatus(200)
    // globe, its companion and its alias go (a draft: C = null until applied),
    // and the `globe` zone drops them in the same draft.
    const rows = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .whereIn('section_name', ['globe', 'globev6', 'globe_force', 'wan'])
    const desired = Object.fromEntries(rows.map((r) => [r.sectionName, r.desiredContent]))
    assert.isNull(desired.globe)
    assert.isNull(desired.globev6)
    assert.isNull(desired.globe_force)
    assert.isNotNull(desired.wan)
  })

  test('Settings → Gateway sync: defaults, limits, the multi-WAN switch needs the password', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const r = await client.get('/api/v1/settings/gateway-sync').bearerToken(adminToken)
    r.assertStatus(200)
    assert.equal(r.body().data.settings.authoritativeWan, 'import')
    assert.equal(r.body().data.defaults.wanConfirmTimeoutSeconds, 300)
    assert.deepEqual(r.body().data.limits.wanConfirmTimeoutSeconds, { min: 120, max: 1800 })
    const bad = await client
      .patch('/api/v1/settings/gateway-sync')
      .bearerToken(adminToken)
      .json({ wanConfirmTimeoutSeconds: 30 })
    bad.assertStatus(422)
    const local = await client
      .patch('/api/v1/settings/gateway-sync')
      .bearerToken(adminToken)
      .json({ checkResolveName: 'router.lan' })
    local.assertStatus(422)
    const ok = await client
      .patch('/api/v1/settings/gateway-sync')
      .bearerToken(adminToken)
      .json({ checkTargets: ['$gateway', '9.9.9.9'], authoritativeWan: 'enforce' })
    ok.assertStatus(200)
    assert.deepEqual(ok.body().data.settings.checkTargets, ['$gateway', '9.9.9.9'])
    const noPassword = await client
      .patch('/api/v1/settings/gateway-sync')
      .bearerToken(adminToken)
      .json({ multiWanWrites: true })
    noPassword.assertStatus(403)
    const on = await client
      .patch('/api/v1/settings/gateway-sync')
      .bearerToken(adminToken)
      .json({ multiWanWrites: true, currentPassword: PASSWORD })
    on.assertStatus(200)
    assert.isTrue(on.body().data.settings.multiWanWrites)
  })

  test('WAN transitions from the interfaces observation', async ({ client, assert }) => {
    const env = await setup()
    await toManaged(client, env)
    const iface = (network: string, up: boolean, extra: object = {}) => ({
      network,
      device: network === 'wan' ? 'wan0' : network === 'lan2' ? 'wan2' : network,
      up,
      proto: 'dhcp',
      ipv4: up ? [network === 'wan' ? '203.0.113.10/24' : '192.168.50.2/24'] : [],
      ipv6: [],
      defaultRoute: up,
      metric: network === 'wan' ? 1 : 2,
      ...extra,
    })
    await recordGatewayObservation(env.collectorId, {
      interfaces: [iface('wan', true), iface('lan2', true)],
    })
    await recordGatewayObservation(env.collectorId, {
      interfaces: [iface('wan', false), iface('lan2', true)],
    })
    const rows = await GatewayWanTransition.query()
      .where('gateway_id', env.gatewayId)
      .orderBy('id', 'asc')
    assert.deepEqual(
      rows.map((t) => [t.event, t.network]),
      [
        ['down', 'wan'],
        ['failover', 'lan2'],
      ]
    )
    const history = await client
      .get(`/api/v1/gateways/${env.gatewayId}/wan/history?range=24h`)
      .bearerToken(env.adminToken)
    history.assertStatus(200)
    assert.lengthOf(history.body().data.transitions, 2)
    assert.deepEqual(history.body().data.transitions[1].detail, { from: 'wan', to: 'lan2' })
    const bad = await client
      .get(`/api/v1/gateways/${env.gatewayId}/wan/history?range=1y`)
      .bearerToken(env.adminToken)
    bad.assertStatus(400)
  })
})
