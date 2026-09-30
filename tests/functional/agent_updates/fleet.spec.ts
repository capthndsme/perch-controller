import AgentArtefact from '#models/agent_artefact'
import AgentUpdateDevice from '#models/agent_update_device'
import AgentUpdateEvent from '#models/agent_update_event'
import AgentUpdateJob from '#models/agent_update_job'
import Collector from '#models/collector'
import { getAgentUpdateSettings } from '#services/agent_updates/settings'
import { _resetInFlight, deviceUpdateInFlight } from '#services/agent_updates/state'
import {
  _resetTickSchedule,
  agentUpdatesTick,
  announceAvailable,
  runRetention,
} from '#services/agent_updates/tick'
import { _resetCollectorAgentState } from '#services/collector_agent'
import collectorHub from '#services/collector_agent_hub'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import {
  assertMergeRegistryMatchesSchema,
  executeCollectorMerge,
  planCollectorMerge,
} from '#services/collector_merge'
import { eventually, seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  api,
  preflightAnswer,
  seedRelease,
  trustTestKey,
  updateBlock,
  useScratchStore,
} from '#tests/helpers/agent_updates'
import { FakeCollector, TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function seedGatewayCollector() {
  return Collector.create({
    name: 'gateway',
    baseUrl: null,
    transport: 'agent',
    instanceId: TEST_INSTANCE_ID,
    source: 'announced',
    lifecycle: 'adopted',
    enabled: true,
    pollIntervalSeconds: 5,
    apiKey: TEST_API_KEY,
    apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    lastStatus: null,
  })
}

const COLLECTOR_UPDATE = updateBlock({
  installKind: 'unowned',
  binaryPath: '/usr/bin/perch-collector',
  packageManager: 'opkg',
  packageVersion: null,
  openwrt: { release: '23.05.3', series: '23.05', pkgArch: 'x86_64' },
  arch: 'amd64',
  variant: 'ndpi-static',
  flash: { path: '/', fsType: 'ext4', freeBytes: 24_000_000_000, totalBytes: 60_000_000_000 },
})

test.group('agent updates: the collector socket, merge, notices, retention', (group) => {
  group.each.setup(resetDb)
  group.each.setup(async () => useScratchStore())
  group.each.setup(() => {
    _resetInFlight()
    _resetTickSchedule()
    _resetAnnounceState()
    _resetCollectorAgentState()
    return () => {
      collectorHub.closeAll(1000, 'test reset')
    }
  })

  test('a collector reports its block in the hello and updates by binary swap', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ product: 'perch-collector', version: '1.2.0', store: true })
    const row = await seedGatewayCollector()
    await db.table('gateways').insert({
      collector_id: row.id,
      created_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })

    let stage: Record<string, unknown> = {}
    const collector = await FakeCollector.connect({
      handlers: {
        'agent.update.stage': (params) => {
          stage = params
          return { updateId: params.updateId, state: 'downloading', preflight: preflightAnswer() }
        },
      },
    })
    await collector.hello({
      version: '1.1.0',
      capabilities: ['gateway_stats', 'agent_update'],
      system: { os: 'OpenWrt 23.05.3', arch: 'amd64' },
      update: COLLECTOR_UPDATE,
    })
    await eventually(
      () => AgentUpdateDevice.query().where('collector_id', row.id).first(),
      (device) => device?.report !== null && device?.report !== undefined
    )

    const fleet = await api(client)
      .get('/api/v1/agent-updates/fleet?product=perch-collector')
      .bearerToken(adminToken)
    fleet.assertStatus(200)
    const view = fleet
      .body()
      .data.devices.find((d: { key: string }) => d.key === `collector:${row.id}`)
    assert.equal(view.role, 'gateway')
    assert.isTrue(view.selfUpdate.supported)
    assert.equal(view.selfUpdate.installKind, 'unowned')
    assert.equal(view.available.version, '1.2.0')

    const created = await api(client)
      .post(`/api/v1/agent-updates/devices/collector/${row.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    created.assertStatus(201)
    await agentUpdatesTick()
    assert.equal(stage.method, 'binary')
    // A gateway keeps its rollback copy on flash.
    assert.equal((stage.policy as Record<string, unknown>).rollbackStore, 'flash')
    assert.deepEqual(
      (stage.artefacts as Array<{ file: string }>).map((a) => a.file),
      ['perch-collector-linux-amd64-ndpi']
    )
    const staged = await AgentUpdateJob.findOrFail(created.body().data.id)
    assert.equal(staged.state, 'staging')
    assert.isFalse(deviceUpdateInFlight('collector', row.id))
    await collector.close()
  })

  test('a polled collector cannot update itself; old APs are "needs a manual update"', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const polled = await Collector.query().firstOrFail()
    const fleet = await api(client).get('/api/v1/agent-updates/fleet').bearerToken(adminToken)
    const view = fleet
      .body()
      .data.devices.find((d: { key: string }) => d.key === `collector:${polled.id}`)
    assert.isFalse(view.selfUpdate.supported)
    assert.equal(view.selfUpdate.reason, 'poll_transport')
    assert.isNull(view.manualCommand)
    const refresh = await api(client)
      .post(`/api/v1/agent-updates/devices/collector/${polled.id}/refresh`)
      .bearerToken(adminToken)
      .json({})
    refresh.assertStatus(409)
    refresh.assertBodyContains({ error: 'self_update_unsupported', reason: 'poll_transport' })
    const missing = await api(client)
      .post('/api/v1/agent-updates/devices/ap/999/update')
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    missing.assertStatus(404)
    missing.assertBodyContains({ error: 'device_not_found' })
  })

  test('collectors:merge moves update rows (registry check and dry run pass)', async ({
    assert,
  }) => {
    await seedSetupComplete()
    await assertMergeRegistryMatchesSchema()
    const old = await Collector.create({
      name: 'old',
      baseUrl: 'http://192.168.1.9:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const gw = await seedGatewayCollector()
    const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    await db.table('agent_update_devices').insert({
      collector_id: old.id,
      channel: 'local',
      auto_update: 'inherit',
      updated_at: now,
    })
    const [jobId] = await db.table('agent_update_jobs').insert({
      update_key: 'u-0000000000000001',
      collector_id: old.id,
      active_key: null,
      device_name: 'old',
      product: 'perch-collector',
      source: 'release',
      from_version: '1.0.0',
      to_version: '1.1.0',
      method: 'binary',
      state: 'confirmed',
      created_at: now,
      updated_at: now,
      finished_at: now,
    })
    await db.table('agent_update_events').insert({
      created_at: now,
      event: 'agent_update.confirmed',
      severity: 'info',
      collector_id: old.id,
      job_id: jobId,
    })

    const plan = await planCollectorMerge({ fromId: old.id, intoId: gw.id })
    assert.deepEqual(plan.refusals, [])
    await db.transaction((trx) => executeCollectorMerge(plan, trx))
    const survivor = plan.survivorId
    const devices = await db.from('agent_update_devices').select('collector_id', 'channel')
    assert.deepEqual(devices, [{ collector_id: survivor, channel: 'local' }])
    const job = await db.from('agent_update_jobs').where('id', jobId).first()
    assert.equal(job.collector_id, survivor)
    const event = await db.from('agent_update_events').first()
    assert.equal(event.collector_id, survivor)
  })

  test('agent_update.available is announced once per product and version', async ({ assert }) => {
    await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0' })
    const { ap } = await seedAgentAp()
    await db.table('agent_update_devices').insert({
      ap_id: ap.id,
      auto_update: 'inherit',
      report: JSON.stringify(updateBlock()),
      reported_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
      updated_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
    ap.agentVersion = '1.1.0'
    await ap.save()
    const settings = await getAgentUpdateSettings()
    await announceAvailable(settings)
    await announceAvailable(settings)
    const events = await AgentUpdateEvent.query().where('event', 'agent_update.available')
    assert.lengthOf(events, 1)
    assert.equal(events[0].detail?.version, '1.2.0')
    assert.lengthOf(events[0].detail?.devices as unknown[], 1)
  })

  test('retention drops old history and the files of releases nothing needs', async ({
    assert,
  }) => {
    await seedSetupComplete()
    await trustTestKey({ githubCheck: false, keepReleases: 2 })
    const oldest = await seedRelease({ version: '1.0.0', store: true })
    const second = await seedRelease({ version: '1.1.0', store: true })
    await seedRelease({ version: '1.2.0', store: true })
    await seedRelease({ version: '1.3.0', store: true })
    const { ap } = await seedAgentAp()
    ap.agentVersion = '1.0.0'
    await ap.save()
    const old = DateTime.utc().minus({ days: 400 }).toFormat('yyyy-MM-dd HH:mm:ss')
    await db.table('agent_update_events').insert({
      created_at: old,
      event: 'settings_changed',
      severity: 'info',
    })
    await runRetention(await getAgentUpdateSettings())

    assert.lengthOf(await AgentUpdateEvent.all(), 0)
    const stored = async (releaseId: number) => {
      const rows = await AgentArtefact.query()
        .where('release_id', releaseId)
        .whereNotNull('stored_path')
      return rows.length
    }
    // 1.3.0 and 1.2.0 are the newest two; 1.0.0 still runs somewhere; 1.1.0 goes.
    assert.equal(await stored(second.release.id), 0)
    assert.isAbove(await stored(oldest.release.id), 0)
    assert.lengthOf(await AgentArtefact.query().where('release_id', second.release.id), 2)
  })
})
