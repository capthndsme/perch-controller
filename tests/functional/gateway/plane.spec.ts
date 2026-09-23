import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayRevision from '#models/gateway_revision'
import GatewaySection from '#models/gateway_section'
import SystemSetting from '#models/system_setting'
import { saveDeviceLabel, resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { gatewayConfigTick } from '#services/gateway_config/apply_lifecycle'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { _resetPollerState } from '#services/collector_poller'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type FakeGatewayOptions, type Section } from '#tests/helpers/fake_gateway'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * The config plane end to end (docs/gateway/config-plane.md sections 4, 5,
 * 6 and 10) against a scripted gateway agent over the real collector
 * socket: import, change log, the apply lifecycle with drop-and-redial and
 * confirm modes, rollback at the deadline with discarded router edits,
 * conflicts, Authoritative Mode's drift enforcement and suspension, the
 * plain-HTTP rule with signed RPCs, the rejoin offer, and the first
 * domains (reservations, DNS records, label names).
 */

const HOST_MAC = '02:00:00:00:00:41'
const NEW_MAC = '02:00:00:00:00:42'
const PASSWORD = 'admin-pass-123'

function routerConfigs(): Record<string, Section[]> {
  return {
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
      { name: 'nas', type: 'host', options: { mac: HOST_MAC, ip: '192.168.1.50', name: 'nas' } },
    ],
    network: [
      {
        name: 'lan',
        type: 'interface',
        options: { proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0' },
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

async function settings(values: Record<string, unknown>) {
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, values)
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
    // Every push is accepted (no "too early" drops between redials).
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
  return r.body().data
}

async function sectionByName(gatewayId: number, name: string) {
  return GatewaySection.query()
    .where('gateway_id', gatewayId)
    .where('section_name', name)
    .firstOrFail()
}

async function applyState(key: string) {
  const row = await GatewayApply.findByOrFail('apply_key', key)
  return row
}

test.group('gateway config plane', (group) => {
  group.each.setup(async () => {
    await resetAll()
  })
  group.each.teardown(async () => {
    for (const gw of gateways) await gw.destroy()
    gateways = []
    // No background work of this test may still hold a connection when the
    // next one migrates (Lucid's advisory lock is per connection).
    await new Promise((r) => setTimeout(r, 100))
    await gatewayQueue.drainAll()
    await new Promise((r) => setTimeout(r, 50))
  })

  test('hello creates the gateway in mode off; configure carries gatewayConfig; authz', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    const configure = await env.gw.collector!.waitFor('agent.configure')
    assert.deepInclude(configure.params.gatewayConfig as object, {
      mode: 'off',
      authoritative: false,
      watchSeconds: 30,
      debounceSeconds: 5,
    })

    const anonymous = await client.get('/api/v1/gateways')
    anonymous.assertStatus(401)

    const list = await client.get('/api/v1/gateways').bearerToken(env.operatorToken)
    list.assertStatus(200)
    const [gateway] = list.body().data
    assert.equal(gateway.id, env.gatewayId)
    assert.equal(gateway.collectorId, env.collector.id)
    assert.equal(gateway.mode, 'off')
    assert.isTrue(gateway.online)
    assert.equal(gateway.agentAccess, 'write')
    // Direct plain connection from loopback without X-Forwarded-Proto.
    assert.isFalse(gateway.writable)
    assert.equal(gateway.writeBlockedReason, 'insecure_transport')

    const write = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.operatorToken)
      .json({ mode: 'observe' })
    write.assertStatus(403)
    const missing = await client.get('/api/v1/gateways/999').bearerToken(env.operatorToken)
    missing.assertStatus(404)
    missing.assertBodyContains({ error: 'gateway_not_found' })
  })

  test('an observation-only gateway collector gets a row; a pending one does not', async ({
    assert,
  }) => {
    await seedSetupComplete()
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
    const gw = new FakeGateway({ capabilities: ['gateway_stats', 'observe.dhcp'] })
    gateways.push(gw)
    await gw.connect()
    const row = await eventually(
      () => Gateway.findBy('collector_id', collector.id),
      (g) => g !== null
    )
    assert.equal(row!.mode, 'off')
    assert.isFalse(row!.capabilities?.capable)

    collector.lifecycle = 'pending'
    await collector.save()
    await row!.delete()
    await gw.redial()
    await new Promise((r) => setTimeout(r, 100))
    assert.isNull(await Gateway.findBy('collector_id', collector.id))
  })

  test('observe mode imports router-wins, then logs a router edit with its author', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    const patched = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'observe' })
    patched.assertStatus(200)
    assert.equal(patched.body().data.mode, 'observe')
    const configure = env.gw.collector!.lastConfigure()!
    assert.equal((configure.gatewayConfig as { mode: string }).mode, 'observe')

    const rev1 = await GatewayRevision.query().where('gateway_id', env.gatewayId).firstOrFail()
    assert.equal(rev1.number, 1)
    assert.equal(rev1.source, 'import')
    assert.isNotNull(rev1.confirmedAt)

    const sections = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sections`)
      .bearerToken(env.operatorToken)
    sections.assertStatus(200)
    const byName = new Map<string, any>(sections.body().data.map((s: any) => [s.section, s]))
    assert.equal(byName.get('nas').scope, 'synced')
    assert.equal(byName.get('nas').domain, 'dhcp_hosts')
    assert.equal(byName.get('lan').scope, 'unmodeled')
    assert.equal(byName.get('nas').router.options.ip, '192.168.1.50')

    env.gw.routerEdit('dhcp', (s) => {
      s.find((x) => x.name === 'nas')!.options.ip = '192.168.1.60'
    })
    const rev2 = await eventually(
      () => GatewayRevision.query().where('gateway_id', env.gatewayId).where('number', 2).first(),
      (r) => r !== null
    )
    assert.equal(rev2!.source, 'router')
    assert.deepInclude(rev2!.routerAuthor as object, { kind: 'luci', user: 'root' })

    const nas = await sectionByName(env.gatewayId, 'nas')
    const detail = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sections/${nas.perchId}`)
      .bearerToken(env.operatorToken)
    detail.assertStatus(200)
    assert.equal(detail.body().data.section.base.options.ip, '192.168.1.60')
    assert.deepEqual(
      detail.body().data.history.items.map((h: any) => h.number),
      [2, 1]
    )
    assert.equal(detail.body().data.history.items[0].routerAuthor.kind, 'luci')

    const events = await client
      .get(`/api/v1/gateways/${env.gatewayId}/events`)
      .bearerToken(env.operatorToken)
    events.assertStatus(200)
    const names = events.body().data.items.map((e: any) => e.event)
    assert.include(names, 'mode_changed')
    assert.include(names, 'imported')

    const revisions = await client
      .get(`/api/v1/gateways/${env.gatewayId}/revisions`)
      .bearerToken(env.operatorToken)
    assert.lengthOf(revisions.body().data.items, 2)
    const one = await client
      .get(`/api/v1/gateways/${env.gatewayId}/revisions/2`)
      .bearerToken(env.operatorToken)
    assert.equal(one.body().data.diff[0].options[0].name, 'ip')
  })

  test('managed needs the step-up password and a writable transport', async ({ client }) => {
    const env = await setup()
    const wrong = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'managed', currentPassword: 'nope' })
    wrong.assertStatus(403)
    wrong.assertBodyContains({ error: 'invalid_password' })
    const insecure = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'managed', currentPassword: PASSWORD })
    insecure.assertStatus(409)
    insecure.assertBodyContains({ error: 'insecure_transport' })
  })

  test('apply: drop and redial, agent half on the fresh session, admin keeps, confirmed revision', async ({
    client,
    assert,
  }) => {
    const env = await setup({ secure: true })
    await toManaged(client, env)

    const put = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.77', hostname: 'printer', publishDns: true })
    put.assertStatus(200)
    const body = put.body().data
    assert.equal(body.object.ip, '192.168.1.77')
    assert.equal(body.object.owner, 'perch')
    assert.isNull(body.applyError)
    const applyId = body.apply.id as string
    assert.equal(body.apply.confirmMode, 'admin_and_agent')

    // The agent committed, dropped its session, dialled a fresh one and pushed.
    const waiting = await eventually(
      () => applyState(applyId),
      (a) => a.state === 'pending_confirm' && a.agentConfirmedAt !== null,
      5000
    )
    assert.isNotNull(waiting.agentReconnectedAt)
    assert.isNull(waiting.adminConfirmedAt)
    assert.isTrue(env.gw.pending !== null)

    const view = await client
      .get(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.operatorToken)
    assert.equal(view.body().data.pendingApply.id, applyId)
    assert.equal(view.body().data.syncState, 'applying')

    const keep = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies/${applyId}/confirm`)
      .bearerToken(env.adminToken)
    keep.assertStatus(200)
    const done = await eventually(
      () => applyState(applyId),
      (a) => a.state === 'confirmed',
      5000
    )
    assert.isNotNull(done.revisionNumber)
    assert.isNull(env.gw.pending)
    const confirmCall = env.gw.calls.find((c) => c.method === 'gateway.config.confirm')
    assert.exists(confirmCall)

    const host = env.gw.configs.dhcp.find((s) => s.options.mac === NEW_MAC)!
    assert.deepInclude(host.options, { ip: '192.168.1.77', name: 'printer', dns: '1' })
    assert.isTrue(env.gw.ledger.some((e) => e.section === host.name))

    const revision = await GatewayRevision.query()
      .where('gateway_id', env.gatewayId)
      .where('number', done.revisionNumber!)
      .firstOrFail()
    assert.equal(revision.source, 'controller')
    assert.isNotNull(revision.confirmedAt)
    const row = await sectionByName(env.gatewayId, host.name)
    assert.equal(row.status, 'in_sync')

    const got = await client
      .get(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.operatorToken)
    got.assertStatus(200)
    assert.equal(got.body().data.reservation.hostname, 'printer')
    assert.isTrue(got.body().data.reservation.applied)
  })

  test('confirm mode agent: confirmed on the fresh session without the admin', async ({
    client,
    assert,
  }) => {
    await settings({ confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const put = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.78' })
    put.assertStatus(200)
    const applyId = put.body().data.apply.id
    await eventually(
      () => applyState(applyId),
      (a) => a.state === 'confirmed',
      5000
    )
    const events = await client
      .get(`/api/v1/gateways/${env.gatewayId}/events`)
      .bearerToken(env.adminToken)
    assert.include(
      events.body().data.items.map((e: any) => e.event),
      'confirmed'
    )
  })

  test('deadline rollback: draft kept, a router edit of the window comes back as a conflict', async ({
    client,
    assert,
  }) => {
    const env = await setup({ secure: true, confirmMs: 600 })
    await toManaged(client, env)
    const nas = await sectionByName(env.gatewayId, 'nas')
    env.gw.duringWindow = () => {
      env.gw.configs.dhcp.find((s) => s.name === 'nas')!.options.name = 'nas-luci'
    }
    const put = await client
      .put(`/api/v1/devices/${HOST_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.51' })
    put.assertStatus(200)
    const applyId = put.body().data.apply.id
    const rolled = await eventually(
      () => applyState(applyId),
      (a) => a.state === 'rolled_back',
      5000
    )
    assert.equal(rolled.outcome?.reason, 'confirm_timeout')
    assert.deepEqual(rolled.outcome?.discardedConfigs, ['dhcp'])
    assert.equal(env.gw.configs.dhcp.find((s) => s.name === 'nas')!.options.ip, '192.168.1.50')
    // Acked: the agent no longer reports it.
    await eventually(
      () => env.gw.results.length,
      (n) => n === 0,
      3000
    )

    const row = await eventually(
      () => GatewaySection.findOrFail(nas.id),
      (r) => r.status === 'conflict'
    )
    assert.equal(row.conflict?.origin, 'rollback_discarded')
    assert.equal(row.desiredContent?.options.ip, '192.168.1.51')

    const resolved = await client
      .post(`/api/v1/gateways/${env.gatewayId}/sections/resolve`)
      .bearerToken(env.adminToken)
      .json({ items: [{ perchId: nas.perchId, take: 'controller' }] })
    resolved.assertStatus(200)
    assert.equal(resolved.body().data.sections[0].status, 'ahead')
  })

  test('two-way conflict blocks its section; resolve, then apply', async ({ client, assert }) => {
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const nas = await sectionByName(env.gatewayId, 'nas')
    const staged = await client
      .put(`/api/v1/devices/${HOST_MAC}/reservation?apply=0`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.52' })
    staged.assertStatus(200)
    assert.isNull(staged.body().data.apply)
    assert.equal(staged.body().data.object.status, 'ahead')

    env.gw.routerEdit('dhcp', (s) => {
      s.find((x) => x.name === 'nas')!.options.ip = '192.168.1.53'
    })
    const row = await eventually(
      () => GatewaySection.findOrFail(nas.id),
      (r) => r.status === 'conflict'
    )
    assert.equal(row.conflict?.options[0].name, 'ip')

    const blocked = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({ perchIds: [nas.perchId] })
    blocked.assertStatus(409)
    blocked.assertBodyContains({ error: 'conflicts_open' })

    const draft = await client
      .get(`/api/v1/gateways/${env.gatewayId}/draft`)
      .bearerToken(env.adminToken)
    assert.include(draft.body().data.blockedByConflicts, nas.perchId)

    const nothing = await client
      .post(`/api/v1/gateways/${env.gatewayId}/sections/resolve`)
      .bearerToken(env.adminToken)
      .json({ items: [{ perchId: 'nope', take: 'router' }] })
    nothing.assertStatus(409)
    nothing.assertBodyContains({ error: 'nothing_to_resolve' })

    const resolved = await client
      .post(`/api/v1/gateways/${env.gatewayId}/sections/resolve`)
      .bearerToken(env.adminToken)
      .json({ items: [{ perchId: nas.perchId, take: 'custom', options: { ip: '192.168.1.54' } }] })
    resolved.assertStatus(200)
    assert.equal(resolved.body().data.sections[0].desired.options.ip, '192.168.1.54')

    const apply = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({ perchIds: [nas.perchId], confirmMode: 'agent' })
    apply.assertStatus(202)
    await eventually(
      () => applyState(apply.body().data.id),
      (a) => a.state === 'confirmed',
      5000
    )
    assert.equal(env.gw.configs.dhcp.find((s) => s.name === 'nas')!.options.ip, '192.168.1.54')
  })

  test('stale base: re-read and retried once', async ({ client, assert }) => {
    await settings({ confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    env.gw.staleNextApply = true
    const put = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.79' })
    put.assertStatus(200)
    const applyId = put.body().data.apply.id
    const done = await eventually(
      () => applyState(applyId),
      (a) => a.state === 'confirmed',
      5000
    )
    assert.isTrue(Boolean(done.retried))
    assert.equal(env.gw.calls.filter((c) => c.method === 'gateway.config.apply').length, 2)
  })

  test('queued while offline, sent by the tick when the agent is back, or expired', async ({
    client,
    assert,
  }) => {
    await settings({ confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    await env.gw.close()
    await eventually(
      () => client.get(`/api/v1/gateways/${env.gatewayId}`).bearerToken(env.adminToken),
      (r) => r.body().data.online === false
    )
    const staged = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.80' })
    staged.assertStatus(200)
    const queued = staged.body().data.apply
    assert.equal(queued.state, 'queued')
    assert.equal(queued.confirmMode, 'agent')

    await env.gw.connect()
    await gatewayQueue.drain(env.gatewayId)
    await gatewayConfigTick()
    await eventually(
      () => applyState(queued.id),
      (a) => a.state === 'confirmed',
      5000
    )

    // A second one that waits past queueExpiryHours expires.
    await env.gw.close()
    await eventually(
      () => client.get(`/api/v1/gateways/${env.gatewayId}`).bearerToken(env.adminToken),
      (r) => r.body().data.online === false
    )
    const again = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.81' })
    const second = again.body().data.apply
    assert.equal(second.state, 'queued')
    await gatewayConfigTick(DateTime.utc().plus({ hours: 25 }))
    const expired = await applyState(second.id)
    assert.equal(expired.state, 'expired')
  })

  test('Authoritative Mode: in-sync precondition, drift reverted after the grace delay, suspension', async ({
    client,
    assert,
  }) => {
    await settings({ authoritativeRevertDelaySeconds: 90, enforcementMaxFailures: 2 })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    // Adopt everything first (ledger), so the router and Perch are in sync.
    const adopt = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({})
    adopt.assertStatus(202)
    await eventually(
      () => applyState(adopt.body().data.id),
      (a) => a.state === 'confirmed',
      5000
    )
    await gatewayQueue.drain(env.gatewayId)

    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    status.assertStatus(200)
    assert.isTrue(status.body().data.inSync, JSON.stringify(status.body().data.blockers))
    const head = status.body().data.headRevision

    const noPassword = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ authoritative: true, expectRevision: head })
    noPassword.assertStatus(403)
    const changed = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ authoritative: true, expectRevision: head + 5, currentPassword: PASSWORD })
    changed.assertStatus(409)
    changed.assertBodyContains({ error: 'sync_changed' })
    const on = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ authoritative: true, expectRevision: head, currentPassword: PASSWORD })
    on.assertStatus(200)
    assert.isTrue(on.body().data.authoritative)
    assert.isTrue(
      (env.gw.collector!.lastConfigure()!.gatewayConfig as { authoritative: boolean }).authoritative
    )

    // A router edit is drift, not an import.
    const nas = await sectionByName(env.gatewayId, 'nas')
    env.gw.routerEdit('dhcp', (s) => {
      s.find((x) => x.name === 'nas')!.options.ip = '192.168.1.99'
    })
    const drifted = await eventually(
      () => GatewaySection.findOrFail(nas.id),
      (r) => r.status === 'drift'
    )
    assert.equal(drifted.desiredContent?.options.ip, '192.168.1.50')
    const sections = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sections?status=drift`)
      .bearerToken(env.adminToken)
    assert.isString(sections.body().data[0].revertAt)

    // Within the grace delay nothing happens; after it, a revert job.
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 30 }))
    assert.equal(
      await GatewayApply.query()
        .where('kind', 'revert')
        .count('* as n')
        .then((r) => Number(r[0].$extras.n)),
      0
    )
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 91 }))
    const revert = await eventually(
      () => GatewayApply.query().where('kind', 'revert').first(),
      (a) => a !== null && a.state === 'confirmed',
      5000
    )
    assert.equal(revert!.confirmMode, 'agent')
    assert.equal(env.gw.configs.dhcp.find((s) => s.name === 'nas')!.options.ip, '192.168.1.50')
    await eventually(
      () => GatewaySection.findOrFail(nas.id),
      (r) => r.status === 'in_sync'
    )

    // Two failed reverts inside the window suspend enforcement.
    env.gw.routerEdit('dhcp', (s) => {
      s.find((x) => x.name === 'nas')!.options.ip = '192.168.1.98'
    })
    await eventually(
      () => GatewaySection.findOrFail(nas.id),
      (r) => r.status === 'drift'
    )
    env.gw.failNextApply = { error: 'apply_failed', message: 'reload failed' }
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 200 }))
    env.gw.failNextApply = { error: 'apply_failed', message: 'reload failed' }
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 400 }))
    const suspended = await eventually(
      () => Gateway.findOrFail(env.gatewayId),
      (g) => g.enforcement === 'suspended'
    )
    assert.equal(suspended.enforcement, 'suspended')
    const failures = await GatewayApply.query().where('kind', 'revert').where('state', 'failed')
    assert.lengthOf(failures, 2)
    await gatewayConfigTick(DateTime.utc().plus({ seconds: 600 }))
    assert.lengthOf(await GatewayApply.query().where('kind', 'revert'), 3)

    const accept = await client
      .post(`/api/v1/gateways/${env.gatewayId}/drift/accept`)
      .bearerToken(env.adminToken)
      .json({ perchIds: [nas.perchId] })
    accept.assertStatus(200)
    const resumed = await client
      .post(`/api/v1/gateways/${env.gatewayId}/enforcement/resume`)
      .bearerToken(env.adminToken)
    resumed.assertStatus(200)
    assert.equal(resumed.body().data.enforcement, 'active')
  })

  test('enable race: a router edit right after the fresh read is drift, never a silent enable', async ({
    client,
    assert,
  }) => {
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const adopt = await client
      .post(`/api/v1/gateways/${env.gatewayId}/applies`)
      .bearerToken(env.adminToken)
      .json({ confirmMode: 'agent' })
    await eventually(
      () => applyState(adopt.body().data.id),
      (a) => a.state === 'confirmed',
      5000
    )
    await gatewayQueue.drain(env.gatewayId)
    const before = await Gateway.findOrFail(env.gatewayId)
    const head = before.headRevision
    // The edit lands while the PATCH holds the queue (between its read and commit).
    const reads = env.gw.calls.filter((c) => c.method === 'gateway.config.read').length
    const timer = setInterval(() => {
      if (env.gw.calls.filter((c) => c.method === 'gateway.config.read').length > reads) {
        clearInterval(timer)
        env.gw.routerEdit('dhcp', (s) => {
          s.find((x) => x.name === 'nas')!.options.name = 'nas-race'
        })
      }
    }, 1)
    const on = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ authoritative: true, expectRevision: head, currentPassword: PASSWORD })
    clearInterval(timer)
    on.assertStatus(200)
    const nas = await sectionByName(env.gatewayId, 'nas')
    const row = await eventually(
      () => GatewaySection.findOrFail(nas.id),
      (r) => r.status === 'drift'
    )
    assert.equal(row.routerContent?.options.name, 'nas-race')
    assert.equal(row.desiredContent?.options.name, 'nas')
  })

  test('plain HTTP: refused without both opt-ins; signed RPCs with them', async ({
    client,
    assert,
  }) => {
    const env = await setup({ transportOk: false, allowInsecure: false })
    const refused = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'managed', currentPassword: PASSWORD })
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'insecure_transport' })

    await settings({ allowInsecureTransport: true, confirmMode: 'agent' })
    const routerSays = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'managed', currentPassword: PASSWORD })
    routerSays.assertStatus(409)
    routerSays.assertBodyContains({ error: 'insecure_transport' })
    await env.gw.destroy()
    gateways = []

    // The router opts in too: config_allow_insecure '1'.
    const gw = new FakeGateway({
      configs: routerConfigs(),
      transportOk: false,
      allowInsecure: true,
    })
    gateways.push(gw)
    await gw.connect()
    await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'observe' })
    const managed = await client
      .patch(`/api/v1/gateways/${env.gatewayId}`)
      .bearerToken(env.adminToken)
      .json({ mode: 'managed', currentPassword: PASSWORD })
    managed.assertStatus(200)
    assert.isTrue(managed.body().data.signedWrites)
    const put = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.82' })
    put.assertStatus(200)
    assert.isNull(put.body().data.applyError)
    await eventually(
      () => applyState(put.body().data.apply.id),
      (a) => a.state === 'confirmed',
      5000
    )
    const writes = gw.calls.filter((c) =>
      ['gateway.config.apply', 'gateway.config.confirm'].includes(c.method)
    )
    assert.isAbove(writes.length, 1)
    assert.isTrue(writes.every((c) => c.signed))
    const signedApply = await applyState(put.body().data.apply.id)
    assert.isTrue(Boolean(signedApply.signed))
  })

  test('rejoin: a reset router is offered the last confirmed revision', async ({
    client,
    assert,
  }) => {
    await settings({ confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const put = await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.83', hostname: 'camera' })
    const done = await eventually(
      () => applyState(put.body().data.apply.id),
      (a) => a.state === 'confirmed',
      5000
    )
    await gatewayQueue.drain(env.gatewayId)
    const confirmedRevision = done.revisionNumber!

    // Factory reset: the router's config and ledger are gone.
    env.gw.ledger = []
    env.gw.routerEdit('dhcp', (s) => {
      s.splice(0, s.length, ...routerConfigs().dhcp)
    })
    const offered = await eventually(
      () => Gateway.findOrFail(env.gatewayId),
      (g) => g.rejoinOffer !== null
    )
    assert.equal(offered.rejoinOffer!.revision, confirmedRevision)
    assert.equal(offered.rejoinOffer!.reason, 'ledger_reset')
    assert.isAbove(offered.headRevision, confirmedRevision)

    const view = await client.get(`/api/v1/gateways/${env.gatewayId}`).bearerToken(env.adminToken)
    assert.equal(view.body().data.rejoinOffer.revision, confirmedRevision)

    const restore = await client
      .post(`/api/v1/gateways/${env.gatewayId}/revisions/${confirmedRevision}/restore`)
      .bearerToken(env.adminToken)
    restore.assertStatus(200)
    assert.isTrue(
      restore.body().data.changes.some((c: any) => c.options.some((o: any) => o.after === 'camera'))
    )
    const after = await Gateway.findOrFail(env.gatewayId)
    assert.isNull(after.rejoinOffer)
  })

  test('DNS records and label names under review; reserved names refused', async ({
    client,
    assert,
  }) => {
    await settings({ confirmMode: 'agent' })
    const env = await setup({ secure: true })
    await toManaged(client, env)

    const reserved = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dns/records?apply=0`)
      .bearerToken(env.adminToken)
      .json({ type: 'a', name: 'wpad', value: '192.168.1.10' })
    reserved.assertStatus(422)
    reserved.assertBodyContains({ error: 'dns_name_reserved' })
    const bad = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dns/records?apply=0`)
      .bearerToken(env.adminToken)
      .json({ type: 'a', name: 'files', value: 'not-an-ip' })
    bad.assertStatus(422)

    const created = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dns/records`)
      .bearerToken(env.adminToken)
      .json({ type: 'a', name: 'files.lan', value: '192.168.1.10' })
    created.assertStatus(201)
    await eventually(
      () => applyState(created.body().data.apply.id),
      (a) => a.state === 'confirmed',
      5000
    )
    const record = env.gw.configs.dhcp.find((s) => s.type === 'domain')!
    assert.deepEqual(record.options, { name: 'files.lan', ip: '192.168.1.10' })

    const dns = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.operatorToken)
    dns.assertStatus(200)
    assert.equal(dns.body().data.labelNames, 'review')
    assert.equal(dns.body().data.records[0].name, 'files.lan')

    // A label for the NAS becomes a pending DNS name, applied only on approval.
    await saveDeviceLabel(HOST_MAC, { name: 'Storage Box' })
    const pending = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dns/label-names`)
      .bearerToken(env.adminToken)
    assert.deepInclude(pending.body().data.pending[0], {
      mac: HOST_MAC,
      slug: 'storage-box',
      current: 'nas',
      blocked: null,
    })
    await saveDeviceLabel(NEW_MAC, { name: 'WPAD' })
    await client
      .put(`/api/v1/devices/${NEW_MAC}/reservation?apply=0`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.84', hostname: 'cam' })
    const both = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dns/label-names`)
      .bearerToken(env.adminToken)
    const wpad = both.body().data.pending.find((p: any) => p.mac === NEW_MAC)
    assert.equal(wpad.blocked, 'reserved')

    const approve = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dns/label-names/apply`)
      .bearerToken(env.adminToken)
      .json({ macs: [HOST_MAC] })
    approve.assertStatus(200)
    await eventually(
      () => applyState(approve.body().data.apply.id),
      (a) => a.state === 'confirmed',
      5000
    )
    assert.equal(env.gw.configs.dhcp.find((s) => s.name === 'nas')!.options.name, 'storage-box')

    const off = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
      .json({ labelNames: 'off' })
    off.assertStatus(200)
    const refused = await client
      .post(`/api/v1/gateways/${env.gatewayId}/dns/label-names/apply`)
      .bearerToken(env.adminToken)
      .json({})
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'dns_label_names_off' })
  })

  test('exclude and include a section; discard the draft', async ({ client, assert }) => {
    const env = await setup({ secure: true })
    await toManaged(client, env)
    const nas = await sectionByName(env.gatewayId, 'nas')
    const staged = await client
      .put(`/api/v1/devices/${HOST_MAC}/reservation?apply=0`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.55' })
    staged.assertStatus(200)
    const discarded = await client
      .delete(`/api/v1/gateways/${env.gatewayId}/draft`)
      .bearerToken(env.adminToken)
      .json({})
    assert.equal(discarded.body().data.discarded, 1)
    const cleared = await GatewaySection.findOrFail(nas.id)
    assert.equal(cleared.status, 'in_sync')

    const excluded = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/sections/${nas.perchId}`)
      .bearerToken(env.adminToken)
      .json({ scope: 'excluded' })
    excluded.assertStatus(200)
    assert.equal(excluded.body().data.scope, 'excluded')
    const refused = await client
      .put(`/api/v1/devices/${HOST_MAC}/reservation`)
      .bearerToken(env.adminToken)
      .json({ ip: '192.168.1.56' })
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'dhcp_host_exists' })
    const lan = await sectionByName(env.gatewayId, 'lan')
    const unmodeled = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/sections/${lan.perchId}`)
      .bearerToken(env.adminToken)
      .json({ scope: 'synced' })
    unmodeled.assertStatus(409)
    unmodeled.assertBodyContains({ error: 'unmodeled' })
    const included = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/sections/${nas.perchId}`)
      .bearerToken(env.adminToken)
      .json({ scope: 'synced' })
    included.assertStatus(200)
  })
})
