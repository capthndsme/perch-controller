import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayConfigEvent from '#models/gateway_config_event'
import GatewaySection from '#models/gateway_section'
import QosWanQueue from '#models/qos_wan_queue'
import SystemSetting from '#models/system_setting'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetPollerState } from '#services/collector_poller'
import { gatewayConfigTick } from '#services/gateway_config/apply_lifecycle'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { _resetQosLive } from '#services/qos_live'
import { bucketSectionName } from '#services/qos_plan'
import { setQosPlaneWriter, StubQosPlaneWriter } from '#services/qos_plane'
import { _uninstallPlaneListeners, installPlaneWriters } from '#services/qos_plane_writers'
import { ensureTierPolicy, shapeDevice } from '#services/qos_shaping'
import { _resetQosSync, flushQosSync, setQosSyncTiming, sweepQosSync } from '#services/qos_sync'
import { _resetRouterState } from '#services/router_metrics'
import { setSqmPlaneWriter, StubSqmPlaneWriter } from '#services/sqm_plane'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type FakeGatewayOptions, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'

/**
 * The QoS writers on the real config plane (docs/gateway/qos.md sections
 * 2.4 and 6.3; config-plane.md 6.8) against a scripted gateway agent: WAN
 * queue writes become `sqm` section edits and an apply, a router refusal
 * comes back in words and leaves no draft, the router's allowlist is
 * surfaced, the `perch-qos` package goes out with its revision and follows
 * its apply, Perch's own writes are authored "Perch (system)", and a
 * router-side pause (`globals.enabled '0'`, sqm `enabled '0'`) is imported
 * as a pause, never reverted, until an admin explicitly resumes over it.
 */

const PASSWORD = 'admin-pass-123'
const MAC = '02:00:00:00:00:51'

function routerConfigs(): Record<string, Section[]> {
  return {
    'network': [
      {
        name: 'lan',
        type: 'interface',
        options: { proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0' },
      },
    ],
    'dhcp': [],
    'sqm': [
      {
        name: 'eth1',
        type: 'queue',
        options: {
          enabled: '1',
          interface: 'eth1',
          download: '85000',
          upload: '10000',
          qdisc: 'cake',
          script: 'piece_of_cake.qos',
        },
      },
    ],
    // What the perch-qos package installs.
    'perch-qos': [{ name: 'globals', type: 'globals', options: { enabled: '1' } }],
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
  _resetQosSync()
  _resetQosLive()
  setQosSyncTiming({ deviceDebounceMs: 0, configDebounceMs: 0 })
  installPlaneWriters()
}

type Env = {
  adminToken: string
  operatorToken: string
  adminId: number
  collector: Collector
  gw: FakeGateway
  gatewayId: number
}

async function setup(options: FakeGatewayOptions = {}): Promise<Env> {
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, {
    confirmMode: 'agent',
    authoritativeRevertDelaySeconds: 0,
  })
  const tokens = await seedSetupComplete()
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
    qos: true,
    wan: ['wan2'],
    ...options,
  })
  gw.packages = { 'dnsmasq': '2.90-r1', 'sqm-scripts': '1.6.0', 'perch-qos': '1.0.0' }
  gateways.push(gw)
  await gw.connect()
  const gateway = await eventually(
    () => Gateway.findBy('collector_id', collector.id),
    (g) => g !== null
  )
  return { ...tokens, collector, gw, gatewayId: gateway!.id }
}

async function toManaged(client: ApiClient, env: Env) {
  const r = await client
    .patch(`/api/v1/gateways/${env.gatewayId}`)
    .bearerToken(env.adminToken)
    .json({ mode: 'managed', currentPassword: PASSWORD })
  r.assertStatus(200)
  await gatewayQueue.drain(env.gatewayId)
  await eventually(
    () => GatewaySection.query().where('gateway_id', env.gatewayId).where('config', 'perch-qos'),
    (rows) => rows.length > 0
  )
  // The sender writes the package once the gateway is managed (its globals,
  // with the first revision; the 30 s sweep in production): let that
  // apply finish.
  await sweepQosSync()
  await eventually(
    () => env.gw.configs['perch-qos'][0].options.revision,
    (revision) => revision === '1',
    8000
  )
  await idle(env.gatewayId)
}

/** No apply of the gateway is open (and the sender has nothing pending). */
async function idle(gatewayId: number) {
  await flushQosSync()
  await eventually(
    () =>
      GatewayApply.query()
        .where('gateway_id', gatewayId)
        .whereIn('state', ['queued', 'sending', 'pending_confirm'])
        .first(),
    (open) => open === null,
    8000
  )
  await gatewayQueue.drain(gatewayId)
}

/** Waits until the router's perch-qos has a section (by name) matching `check`. */
async function onRouter(
  gw: FakeGateway,
  config: string,
  name: string,
  check: (options: Record<string, string | string[]>) => boolean = () => true
) {
  const found = await eventually(
    () => gw.configs[config]?.find((x) => x.name === name) ?? null,
    (x) => x !== null && check(x.options),
    8000
  )
  return found!
}

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

async function confirmed(applyKey: string) {
  return eventually(
    () => GatewayApply.findByOrFail('apply_key', applyKey),
    (a) => ['confirmed', 'rolled_back', 'failed'].includes(a.state),
    8000
  )
}

/** The newest confirmed apply carrying the package. */
async function lastPackageApply(gatewayId: number): Promise<GatewayApply> {
  const applies = await GatewayApply.query()
    .where('gateway_id', gatewayId)
    .where('state', 'confirmed')
    .orderBy('id', 'desc')
  return applies.find((a) => (a.configs ?? []).includes('perch-qos'))!
}

function routerSection(gw: FakeGateway, config: string, name: string) {
  return gw.configs[config]?.find((s) => s.name === name) ?? null
}

async function sectionRow(gatewayId: number, config: string, name: string) {
  return GatewaySection.query()
    .where('gateway_id', gatewayId)
    .where('config', config)
    .where('section_name', name)
    .firstOrFail()
}

test.group('qos | plane writers (fake gateway)', (group) => {
  group.each.setup(async () => {
    await resetAll()
  })
  group.each.teardown(async () => {
    for (const gw of gateways) await gw.destroy()
    gateways = []
    _uninstallPlaneListeners()
    setSqmPlaneWriter(new StubSqmPlaneWriter())
    setQosPlaneWriter(new StubQosPlaneWriter())
    await new Promise((r) => setTimeout(r, 100))
    await flushQosSync()
    await gatewayQueue.drainAll()
    await new Promise((r) => setTimeout(r, 50))
  })

  test('a WAN queue is created and edited through the sqm domain and an apply', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    // The router's own queue came in with the read.
    await eventually(
      () => QosWanQueue.query().where('gateway_id', env.gatewayId),
      (rows) => rows.length === 1
    )

    const created = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, device: 'wan2', downloadKbit: 50000, uploadKbit: 10000 })
    created.assertStatus(201)
    const body = bodyOf(created).data
    assert.match(body.queue.uciSection, /^perch_[a-z0-9]+$/)
    assert.isString(body.queue.perchId)
    assert.equal(body.queue.origin, 'controller')
    assert.include(['sending', 'pending_confirm'], body.apply.state)
    assert.deepEqual(body.apply.configs, ['sqm'])
    assert.isNull(body.applyError)
    assert.equal(body.apply.requestedBy.email, 'admin@example.com')

    const apply = await confirmed(body.apply.id)
    assert.equal(apply.state, 'confirmed')
    const written = routerSection(env.gw, 'sqm', body.queue.uciSection)
    assert.isNotNull(written)
    assert.containsSubset(written!.options, {
      interface: 'wan2',
      download: '50000',
      upload: '10000',
      qdisc: 'cake',
      enabled: '1',
    })

    // The read after the confirm: one row per queue, in sync.
    const list = await eventually(
      async () =>
        bodyOf(
          await client
            .get(`/api/v1/qos/wan-queues?gatewayId=${env.gatewayId}`)
            .bearerToken(env.operatorToken)
        ).data,
      (rows: any[]) =>
        rows.length === 2 && rows.find((r) => r.id === body.queue.id)?.sync.state === 'in_sync',
      5000
    )
    assert.lengthOf(list, 2)

    await idle(env.gatewayId)
    const edited = await client
      .patch(`/api/v1/qos/wan-queues/${body.queue.id}`)
      .bearerToken(env.adminToken)
      .json({ downloadKbit: 60000 })
    edited.assertStatus(200)
    const edit = bodyOf(edited).data
    assert.equal(edit.queue.sync.state, 'applying')
    const editApply = await confirmed(edit.apply.id)
    assert.equal(editApply.state, 'confirmed')
    assert.equal(routerSection(env.gw, 'sqm', body.queue.uciSection)!.options.download, '60000')

    // The revision is the admin's.
    const revisions = await client
      .get(`/api/v1/gateways/${env.gatewayId}/revisions`)
      .bearerToken(env.operatorToken)
    const newest = bodyOf(revisions).data.items[0]
    assert.equal(newest.source, 'controller')
    assert.equal(newest.author.email, 'admin@example.com')
  })

  test('a router edit a collector mislabels as Perch’s own echo is still read', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const created = bodyOf(
      await client
        .post('/api/v1/qos/wan-queues')
        .bearerToken(env.adminToken)
        .json({ gatewayId: env.gatewayId, device: 'wan2', downloadKbit: 50000, uploadKbit: 10000 })
    ).data
    await confirmed(created.apply.id)
    await idle(env.gatewayId)
    // The router's admin edits the queue; the collector (a pre-rc.3 bug)
    // reports it as the echo of Perch's own apply.
    const queue = routerSection(env.gw, 'sqm', created.queue.uciSection)!
    queue.options.download = '30000'
    env.gw.collector!.notifyServer('gateway.config.changed', {
      hashes: env.gw.hashes(),
      changed: ['sqm'],
      origin: 'perch',
      applyId: created.apply.id,
      author: { kind: 'perch' },
      at: new Date().toISOString(),
      uncommitted: [],
    })
    const row = await eventually(
      () => QosWanQueue.find(created.queue.id),
      (q) => q?.options.download === '30000',
      5000
    )
    assert.equal(row!.options.download, '30000')
  })

  test('a router refusal (sqm_below_floor) answers in words and leaves no draft', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const queue = await eventually(
      () =>
        QosWanQueue.query().where('gateway_id', env.gatewayId).where('uci_section', 'eth1').first(),
      (q) => q !== null
    )
    env.gw.failNextApply = {
      error: 'invalid_config',
      message: 'sqm.eth1: download 20000 kbit/s is below min_wan_kbit 80000',
      data: { config: 'sqm', section: 'eth1', detail: 'sqm_below_floor', minWanKbit: 80000 },
    }
    const refused = await client
      .patch(`/api/v1/qos/wan-queues/${queue!.id}`)
      .bearerToken(env.adminToken)
      .json({ downloadKbit: 20000 })
    refused.assertStatus(422)
    const body = bodyOf(refused)
    assert.equal(body.error, 'sqm_below_floor')
    assert.include(body.message, '80000')
    assert.equal(body.minWanKbit, 80000)
    assert.isString(body.applyId)

    // Nothing changed: the queue, the router and the draft.
    await queue!.refresh()
    assert.equal(queue!.options.download, '85000')
    assert.equal(routerSection(env.gw, 'sqm', 'eth1')!.options.download, '85000')
    const draft = await client
      .get(`/api/v1/gateways/${env.gatewayId}/draft`)
      .bearerToken(env.adminToken)
    // (Only the adoption of the router's own sections waits in the draft.)
    assert.deepEqual(
      bodyOf(draft).data.changes.filter((c: any) => c.action !== 'adopt'),
      []
    )
    const failed = await GatewayApply.findByOrFail('apply_key', body.applyId)
    assert.equal(failed.state, 'failed')
    assert.equal((failed.outcome as any).data.detail, 'sqm_below_floor')
  })

  test('a config off the router allowlist is refused early and shown on GET /qos', async ({
    client,
    assert,
  }) => {
    const env = await setup({ allowedConfigs: ['network', 'dhcp', 'perch-qos'] })
    await toManaged(client, env)
    const refused = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, device: 'wan2', downloadKbit: 50000, uploadKbit: 10000 })
    refused.assertStatus(409)
    assert.equal(bodyOf(refused).error, 'config_not_allowed')
    assert.include(bodyOf(refused).message, "managed_config 'sqm'")

    const overview = bodyOf(
      await client.get(`/api/v1/qos?gatewayId=${env.gatewayId}`).bearerToken(env.operatorToken)
    ).data
    assert.containsSubset(overview.planeAccess, {
      sqm: { config: 'sqm', package: 'sqm-scripts', allowed: false, installed: true },
      perchQos: { config: 'perch-qos', allowed: true, hint: null },
    })
    assert.isTrue(overview.errors.some((e: any) => e.code === 'config_not_allowed'))
  })

  test('the perch-qos package goes out with its revision; Perch’s own writes are the system’s', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const policy = bodyOf(
      await client
        .post('/api/v1/qos/policies')
        .bearerToken(env.adminToken)
        .json({
          gatewayId: env.gatewayId,
          name: 'Guests',
          shared: { downloadKbit: 50000, uploadKbit: 10000 },
          each: { downloadKbit: 5000, uploadKbit: 1000 },
        })
    ).data
    const assigned = await client
      .post('/api/v1/qos/assignments')
      .bearerToken(env.adminToken)
      .json({
        gatewayId: env.gatewayId,
        target: { type: 'network', network: 'guest' },
        policyId: policy.id,
      })
    assigned.assertStatus(201)
    const bucketName = bucketSectionName(policy.classMinor)
    await onRouter(env.gw, 'perch-qos', bucketName)
    await idle(env.gatewayId)
    const first = await lastPackageApply(env.gatewayId)
    assert.equal(first.confirmMode, 'agent')
    assert.equal(first.requestedByUserId, env.adminId)

    const globals = routerSection(env.gw, 'perch-qos', 'globals')!
    assert.containsSubset(globals.options, { enabled: '1', revision: '2', min_wan_kbit: '1000' })
    assert.containsSubset(routerSection(env.gw, 'perch-qos', bucketName)!.options, {
      policy: String(policy.id),
      down_kbit: '50000',
      up_kbit: '10000',
    })
    const network = routerSection(env.gw, 'perch-qos', 'guest')!
    assert.equal(network.type, 'network')
    assert.equal(network.options.bucket, bucketName)
    // Empty options are left out (UCI keeps no empty values).
    assert.notProperty(routerSection(env.gw, 'perch-qos', bucketName)!.options, 'parent')

    // In sync: confirmed, and this router reports no shaper revision.
    const overview = bodyOf(
      await client.get(`/api/v1/qos?gatewayId=${env.gatewayId}`).bearerToken(env.operatorToken)
    ).data
    assert.containsSubset(overview.config, { state: 'in_sync', revision: 2, error: null })

    // A portal grant (Perch's own write): a tier bucket for one device.
    const tier = await ensureTierPolicy({
      gatewayId: env.gatewayId,
      key: 'hour',
      name: 'Voucher: 1 hour',
      shared: { downloadKbit: 20000, uploadKbit: 5000 },
    })
    await shapeDevice({
      gatewayId: env.gatewayId,
      mac: MAC,
      policyId: tier.id,
      source: 'portal',
      sourceRef: 'voucher:1',
    })
    await onRouter(env.gw, 'perch-qos', 'globals', (o) => o.revision === '3')
    await idle(env.gatewayId)
    const second = await lastPackageApply(env.gatewayId)
    assert.isNull(second.requestedByUserId)
    assert.equal(second.systemActor, 'qos')

    const revisions = bodyOf(
      await client.get(`/api/v1/gateways/${env.gatewayId}/revisions`).bearerToken(env.operatorToken)
    ).data.items
    assert.deepEqual(revisions[0].author, {
      id: null,
      email: null,
      system: true,
      name: 'Perch (system)',
      via: 'qos',
    })
    const apply = bodyOf(
      await client
        .get(`/api/v1/gateways/${env.gatewayId}/applies/${second.applyKey}`)
        .bearerToken(env.operatorToken)
    ).data
    assert.equal(apply.requestedBy.name, 'Perch (system)')
    const event = await GatewayConfigEvent.query()
      .where('gateway_id', env.gatewayId)
      .where('event', 'apply_requested')
      .where('apply_id', Number(second.id))
      .firstOrFail()
    assert.equal(event.systemActor, 'qos')
    assert.isNull(event.userId)

    // The REST writes stay admin-only.
    const operatorWrite = await client
      .post('/api/v1/qos/policies')
      .bearerToken(env.operatorToken)
      .json({
        gatewayId: env.gatewayId,
        name: 'X',
        shared: { downloadKbit: 1000, uploadKbit: 1000 },
      })
    operatorWrite.assertStatus(403)
  })

  test('a router-side perch-qos pause is imported, never reverted, and resumed only on request', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const policy = bodyOf(
      await client
        .post('/api/v1/qos/policies')
        .bearerToken(env.adminToken)
        .json({
          gatewayId: env.gatewayId,
          name: 'Guests',
          shared: { downloadKbit: 50000, uploadKbit: 10000 },
        })
    ).data
    await client
      .post('/api/v1/qos/assignments')
      .bearerToken(env.adminToken)
      .json({
        gatewayId: env.gatewayId,
        target: { type: 'network', network: 'guest' },
        policyId: policy.id,
      })
    await onRouter(env.gw, 'perch-qos', 'guest')
    await idle(env.gatewayId)

    // The router's admin pauses shaping (uci set perch-qos.globals.enabled=0).
    env.gw.routerEdit(
      'perch-qos',
      (sections) => {
        sections.find((s) => s.name === 'globals')!.options.enabled = '0'
      },
      { kind: 'cli', via: 'trigger' }
    )
    const held = await eventually(
      () => sectionRow(env.gatewayId, 'perch-qos', 'globals'),
      (row) => row.routerContent?.options.enabled === '0',
      5000
    )
    assert.deepInclude(held.ownership as object, { kind: 'options' })
    assert.notInclude((held.ownership as any).options, 'enabled')
    assert.include((held.ownership as any).options, 'revision')
    assert.equal(held.status, 'in_sync')
    assert.equal(held.desiredContent?.options.enabled, '0')
    const paused = await GatewayConfigEvent.query()
      .where('gateway_id', env.gatewayId)
      .where('event', 'router_paused')
    assert.lengthOf(paused, 1)

    // One-way domain, grace delay 0: the tick reverts drift, never the pause.
    await gatewayConfigTick()
    await gatewayQueue.drain(env.gatewayId)
    assert.equal(routerSection(env.gw, 'perch-qos', 'globals')!.options.enabled, '0')
    assert.isNull(
      await GatewayApply.query().where('gateway_id', env.gatewayId).where('kind', 'revert').first()
    )

    // A later change keeps the router's pause.
    await client
      .patch(`/api/v1/qos/policies/${policy.id}`)
      .bearerToken(env.adminToken)
      .json({ shared: { downloadKbit: 40000, uploadKbit: 10000 } })
    const globals = await onRouter(env.gw, 'perch-qos', 'globals', (o) => o.revision === '3')
    await idle(env.gatewayId)
    assert.equal(globals.options.enabled, '0')
    assert.equal(routerSection(env.gw, 'perch-qos', globals.name)!.options.enabled, '0')

    // An explicit resume over the router's pause writes enabled '1'.
    const resumed = await client
      .post('/api/v1/qos/resume')
      .bearerToken(env.adminToken)
      .json({ gatewayId: env.gatewayId, overrideRouter: true })
    resumed.assertStatus(200)
    await onRouter(env.gw, 'perch-qos', 'globals', (o) => o.enabled === '1')
    await idle(env.gatewayId)
    const after = await eventually(
      () => sectionRow(env.gatewayId, 'perch-qos', 'globals'),
      (row) => row.routerContent?.options.enabled === '1'
    )
    assert.isNull(after.ownership)
  })

  test('a router edit of the package is drift and reverted (one-way)', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const policy = bodyOf(
      await client
        .post('/api/v1/qos/policies')
        .bearerToken(env.adminToken)
        .json({
          gatewayId: env.gatewayId,
          name: 'Guests',
          shared: { downloadKbit: 50000, uploadKbit: 10000 },
        })
    ).data
    await client
      .post('/api/v1/qos/assignments')
      .bearerToken(env.adminToken)
      .json({
        gatewayId: env.gatewayId,
        target: { type: 'network', network: 'guest' },
        policyId: policy.id,
      })
    const bucket = bucketSectionName(policy.classMinor)
    await onRouter(env.gw, 'perch-qos', bucket)
    await idle(env.gatewayId)

    env.gw.routerEdit('perch-qos', (sections) => {
      sections.find((s) => s.name === bucket)!.options.down_kbit = '99999'
    })
    await eventually(
      () => sectionRow(env.gatewayId, 'perch-qos', bucket),
      (row) => row.status === 'drift',
      5000
    )
    await gatewayConfigTick()
    const revert = await eventually(
      () => GatewayApply.query().where('gateway_id', env.gatewayId).where('kind', 'revert').first(),
      (a) => a !== null
    )
    assert.equal(revert!.systemActor, 'enforcement')
    await confirmed(revert!.applyKey)
    assert.equal(routerSection(env.gw, 'perch-qos', bucket)!.options.down_kbit, '50000')
  })

  test('a router-side sqm pause is not reverted in Authoritative Mode', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    // Adopt the router's own sections first (Authoritative Mode needs "in sync").
    const adopt = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({})
    adopt.assertStatus(202)
    await idle(env.gatewayId)
    const head = await Gateway.findOrFail(env.gatewayId)
    const on = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({
        authoritative: true,
        currentPassword: PASSWORD,
        expectRevision: head.headRevision,
      })
    on.assertStatus(200)

    env.gw.routerEdit('sqm', (sections) => {
      sections.find((s) => s.name === 'eth1')!.options.enabled = '0'
    })
    const row = await eventually(
      () => sectionRow(env.gatewayId, 'sqm', 'eth1'),
      (r) => r.routerContent?.options.enabled === '0',
      5000
    )
    assert.equal(row.status, 'in_sync')
    await gatewayConfigTick()
    await gatewayQueue.drain(env.gatewayId)
    assert.equal(routerSection(env.gw, 'sqm', 'eth1')!.options.enabled, '0')
    assert.isNull(
      await GatewayApply.query().where('gateway_id', env.gatewayId).where('kind', 'revert').first()
    )
    const queue = await eventually(
      () =>
        QosWanQueue.query().where('gateway_id', env.gatewayId).where('uci_section', 'eth1').first(),
      (q) => q?.routerPausedAt !== null
    )
    assert.isNotNull(queue!.routerPausedAt)

    // The router switches it back on: Perch owns it again, nothing reverts.
    env.gw.routerEdit('sqm', (sections) => {
      sections.find((s) => s.name === 'eth1')!.options.enabled = '1'
    })
    const back = await eventually(
      () => sectionRow(env.gatewayId, 'sqm', 'eth1'),
      (r) => r.routerContent?.options.enabled === '1',
      5000
    )
    assert.equal(back.status, 'in_sync')
    assert.isNull(back.ownership)
  })
})
