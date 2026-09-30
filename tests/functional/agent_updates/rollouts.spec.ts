import AgentUpdateDevice from '#models/agent_update_device'
import AgentUpdateEvent from '#models/agent_update_event'
import AgentUpdateJob, { type JobState } from '#models/agent_update_job'
import AgentUpdateRollout from '#models/agent_update_rollout'
import AgentUpdateRolloutDevice from '#models/agent_update_rollout_device'
import WifiAccessPoint from '#models/wifi_access_point'
import { transition } from '#services/agent_updates/jobs'
import { advanceRollouts, autoUpdate } from '#services/agent_updates/rollouts'
import { getAgentUpdateSettings } from '#services/agent_updates/settings'
import { _resetInFlight } from '#services/agent_updates/state'
import { _resetTickSchedule } from '#services/agent_updates/tick'
import hub from '#services/ap_agent_hub'
import {
  DEFAULT_SYSTEM_INFO,
  FakeAgent,
  eventually,
  seedAgentAp,
  seedSetupComplete,
} from '#tests/helpers/ap_agent'
import {
  api,
  seedRelease,
  trustTestKey,
  updateBlock,
  useScratchStore,
} from '#tests/helpers/agent_updates'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * Rollouts, the maintenance window and auto-update (agent-updates
 * controller.md sections 6 and 9.2, endpoints 7, 8, 20, 21). The engine is
 * stepped with `advanceRollouts(settings, now)` at chosen times; jobs are
 * settled directly (the job path itself is covered by jobs.spec.ts).
 */

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

let seeded = 10

/** An AP on perch-apd 1.1.0 that reports an update block, online or not. */
async function seedAp(name: string, options: { online?: boolean; freeBytes?: number } = {}) {
  const suffix = String((seeded++ % 90) + 10)
  const { ap, agentId, agentSecret } = await seedAgentAp({
    name,
    macs: [`02:00:00:00:01:${suffix}`],
  })
  const update = updateBlock({
    flash: {
      path: '/overlay',
      fsType: 'jffs2',
      freeBytes: options.freeBytes ?? 4308992,
      totalBytes: 8060928,
    },
  })
  if (options.online === false) {
    ap.agentVersion = '1.1.0'
    await ap.save()
    await AgentUpdateDevice.create({
      apId: ap.id,
      collectorId: null,
      channel: null,
      autoUpdate: 'inherit',
      pinnedVersion: null,
      report: update as never,
      reportedAt: DateTime.utc(),
      versionSeen: '1.1.0',
      facts: null,
      updatedAt: DateTime.utc(),
    })
    return { ap, agent: null }
  }
  const agent = await FakeAgent.connect({
    agentId,
    agentSecret,
    handlers: {
      'system.info': () => ({
        ...DEFAULT_SYSTEM_INFO,
        agentVersion: '1.1.0',
        capabilities: [...DEFAULT_SYSTEM_INFO.capabilities, 'agent_update'],
        update,
      }),
      'agent.update.ack': (params) => ({ acked: (params.updateIds as string[]).length }),
    },
  })
  await agent.waitFor('system.info')
  await eventually(
    () => AgentUpdateDevice.query().where('ap_id', ap.id).first(),
    (row) => row !== null && row.report !== null
  )
  return { ap, agent }
}

/** What a finished update leaves: the job final, the AP on the new version. */
async function finishJob(
  apId: number,
  state: JobState,
  version = '1.2.0',
  reason: string | null = null
) {
  const job = await AgentUpdateJob.query()
    .where('ap_id', apId)
    .whereNotNull('active_key')
    .firstOrFail()
  if (state === 'confirmed') {
    await WifiAccessPoint.query().where('id', apId).update({ agent_version: version })
  }
  await transition(job, state, { reason })
  return job
}

async function devicesOf(rolloutId: number) {
  const rows = await AgentUpdateRolloutDevice.query()
    .where('rollout_id', rolloutId)
    .orderBy('position')
  return rows.map((row) => ({
    apId: row.apId,
    state: row.state,
    canary: row.isCanary,
    skip: row.skipReason,
  }))
}

async function reload(id: number) {
  return AgentUpdateRollout.findOrFail(id)
}

test.group('agent updates: rollouts', (group) => {
  group.each.setup(resetDb)
  group.each.setup(async () => useScratchStore())
  group.each.setup(() => {
    _resetInFlight()
    _resetTickSchedule()
    return () => {
      hub.closeAll(1000, 'test reset')
    }
  })

  test('canary → observe → batches of one with a gap → completed', async ({ client, assert }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    const a = await seedAp('ap-attic', { freeBytes: 40_000_000 })
    const b = await seedAp('ap-bedroom')
    const c = await seedAp('ap-cellar')

    const created = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({
        product: 'perch-apd',
        version: '1.2.0',
        batchSize: 1,
        batchGapSeconds: 60,
        canaryObserveMinutes: 10,
        respectWindow: false,
      })
    created.assertStatus(201)
    const view = created.body().data
    assert.equal(view.state, 'canary')
    assert.equal(view.counts.total, 3)
    // The suggested canary: the AP with the most free flash.
    assert.equal(view.canary.key, `ap:${a.ap.id}`)
    assert.deepEqual(
      view.devices.map((d: { device: { name: string }; isCanary: boolean; version: string }) => [
        d.device.name,
        d.isCanary,
        d.version,
      ]),
      [
        ['ap-attic', true, '1.1.0'],
        ['ap-bedroom', false, '1.1.0'],
        ['ap-cellar', false, '1.1.0'],
      ]
    )

    // Only one open rollout per product; operators cannot create one.
    const again = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({ product: 'perch-apd', version: '1.2.0' })
    again.assertStatus(409)
    assert.equal(again.body().error, 'rollout_open')
    const operator = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(operatorToken)
      .json({ product: 'perch-apd', version: '1.2.0' })
    operator.assertStatus(403)

    // The rollout owns its devices: no manual update meanwhile.
    const manual = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${b.ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    manual.assertStatus(409)
    assert.equal(manual.body().error, 'rollout_owns_device')
    assert.equal(manual.body().rolloutId, view.id)

    const settings = await getAgentUpdateSettings()
    const t0 = DateTime.utc()
    await advanceRollouts(settings, t0)
    const canaryJob = await AgentUpdateJob.query().where('ap_id', a.ap.id).firstOrFail()
    assert.equal(canaryJob.rolloutId, view.id)
    assert.equal(canaryJob.systemActor, 'rollout')
    assert.equal(canaryJob.state, 'queued')
    assert.equal(await AgentUpdateJob.query().where('ap_id', b.ap.id).first(), null)

    // The fleet shows who belongs to the open rollout (readable by operators).
    const fleet = await api(client).get('/api/v1/agent-updates/fleet').bearerToken(operatorToken)
    fleet.assertStatus(200)
    const rows = fleet.body().data.devices as Array<{
      key: string
      rollout: Record<string, unknown> | null
    }>
    assert.deepEqual(rows.find((d) => d.key === `ap:${a.ap.id}`)!.rollout, {
      id: view.id,
      state: 'canary',
      deviceState: 'running',
      isCanary: true,
    })
    assert.equal(rows.find((d) => d.key === `ap:${b.ap.id}`)!.rollout!.deviceState, 'pending')
    assert.deepEqual(fleet.body().data.openRollouts, [
      { id: view.id, product: 'perch-apd', version: '1.2.0', state: 'canary' },
    ])

    await finishJob(a.ap.id, 'confirmed')
    await advanceRollouts(settings, t0.plus({ seconds: 5 }))
    let rollout = await reload(view.id)
    assert.equal(rollout.state, 'observing')
    assert.equal(rollout.waitingFor, 'observe')

    await advanceRollouts(settings, t0.plus({ minutes: 5 }))
    rollout = await reload(view.id)
    assert.equal(rollout.state, 'observing')
    assert.equal(await AgentUpdateJob.query().where('ap_id', b.ap.id).first(), null)

    // Observed long enough: the first batch (one device) starts.
    await advanceRollouts(settings, t0.plus({ minutes: 11 }))
    rollout = await reload(view.id)
    assert.equal(rollout.state, 'rolling')
    await finishJob(b.ap.id, 'confirmed')

    // The batch finished: the gap runs before the next one.
    await advanceRollouts(settings, t0.plus({ minutes: 11, seconds: 5 }))
    rollout = await reload(view.id)
    assert.equal(rollout.waitingFor, 'gap')
    assert.equal(await AgentUpdateJob.query().where('ap_id', c.ap.id).first(), null)
    await advanceRollouts(settings, t0.plus({ minutes: 12, seconds: 10 }))
    await finishJob(c.ap.id, 'confirmed')
    await advanceRollouts(settings, t0.plus({ minutes: 12, seconds: 15 }))

    rollout = await reload(view.id)
    assert.equal(rollout.state, 'completed')
    assert.isNotNull(rollout.finishedAt)
    const done = await AgentUpdateEvent.query()
      .where('rollout_id', view.id)
      .where('event', 'agent_update.rollout_completed')
      .firstOrFail()
    assert.deepInclude(done.detail as Record<string, unknown>, {
      confirmed: 3,
      skipped: 0,
      failed: 0,
    })

    const shown = await api(client)
      .get(`/api/v1/agent-updates/rollouts/${view.id}`)
      .bearerToken(operatorToken)
    shown.assertStatus(200)
    assert.equal(shown.body().data.state, 'completed')
    assert.deepEqual(
      shown
        .body()
        .data.devices.map((d: { state: string; version: string; job: { state: string } }) => [
          d.state,
          d.version,
          d.job.state,
        ]),
      [
        ['confirmed', '1.2.0', 'confirmed'],
        ['confirmed', '1.2.0', 'confirmed'],
        ['confirmed', '1.2.0', 'confirmed'],
      ]
    )
    const list = await api(client)
      .get('/api/v1/agent-updates/rollouts?state=open')
      .bearerToken(adminToken)
    assert.lengthOf(list.body().data.rollouts, 0)
  })

  test('a failed canary pauses; resume with skipFailed makes the next device the canary', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    const a = await seedAp('ap-attic')
    const b = await seedAp('ap-bedroom')

    const created = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({ product: 'perch-apd', version: '1.2.0', canaryKey: `ap:${a.ap.id}` })
    created.assertStatus(201)
    const id = created.body().data.id
    const settings = await getAgentUpdateSettings()
    const t0 = DateTime.utc()
    await advanceRollouts(settings, t0)
    await finishJob(a.ap.id, 'rolled_back', '1.1.0', 'confirm_timeout')
    await advanceRollouts(settings, t0.plus({ seconds: 5 }))

    let rollout = await reload(id)
    assert.equal(rollout.state, 'paused')
    assert.equal(rollout.pausedReason, 'device_failed')
    assert.match(rollout.pausedDetail!, /ap-attic: rolled_back: confirm_timeout/)
    const paused = await AgentUpdateEvent.query()
      .where('rollout_id', id)
      .where('event', 'agent_update.rollout_paused')
      .firstOrFail()
    assert.equal(paused.severity, 'warning')
    assert.equal(paused.apId, a.ap.id)

    // Nothing moves while paused.
    await advanceRollouts(settings, t0.plus({ minutes: 1 }))
    assert.equal(await AgentUpdateJob.query().where('ap_id', b.ap.id).first(), null)

    const notPaused = await api(client)
      .post(`/api/v1/agent-updates/rollouts/${id}/pause`)
      .bearerToken(adminToken)
      .json({})
    notPaused.assertStatus(200)
    const resumed = await api(client)
      .post(`/api/v1/agent-updates/rollouts/${id}/resume`)
      .bearerToken(adminToken)
      .json({ skipFailed: true })
    resumed.assertStatus(200)
    assert.equal(resumed.body().data.state, 'canary')

    await advanceRollouts(settings, t0.plus({ minutes: 2 }))
    await advanceRollouts(settings, t0.plus({ minutes: 2, seconds: 5 }))
    assert.deepEqual(await devicesOf(id), [
      { apId: a.ap.id, state: 'skipped', canary: false, skip: 'failed' },
      { apId: b.ap.id, state: 'running', canary: true, skip: null },
    ])
    rollout = await reload(id)
    assert.equal(rollout.state, 'canary')

    const again = await api(client)
      .post(`/api/v1/agent-updates/rollouts/${id}/resume`)
      .bearerToken(adminToken)
      .json({})
    again.assertStatus(409)
    assert.equal(again.body().error, 'rollout_not_paused')

    // Cancel: the queued job is cancelled, nothing else starts.
    const cancelled = await api(client)
      .post(`/api/v1/agent-updates/rollouts/${id}/cancel`)
      .bearerToken(adminToken)
      .json({})
    cancelled.assertStatus(200)
    assert.equal(cancelled.body().data.state, 'cancelled')
    const job = await AgentUpdateJob.query().where('ap_id', b.ap.id).firstOrFail()
    assert.equal(job.state, 'cancelled')
    const final = await api(client)
      .post(`/api/v1/agent-updates/rollouts/${id}/cancel`)
      .bearerToken(adminToken)
      .json({})
    final.assertStatus(409)
    assert.equal(final.body().error, 'rollout_final')
  })

  test('without stop-on-failure it goes on; offline devices wait, then are skipped; the window gates batches', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({
      githubCheck: false,
      windowEnabled: true,
      windowDays: [0, 1, 2, 3, 4, 5, 6],
      windowStart: '02:00',
      windowEnd: '05:00',
    })
    await seedRelease({ version: '1.2.0', store: true })
    const a = await seedAp('ap-attic', { freeBytes: 40_000_000 })
    const b = await seedAp('ap-bedroom')
    const c = await seedAp('ap-cellar', { online: false })

    const created = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({
        product: 'perch-apd',
        version: '1.2.0',
        batchSize: 2,
        batchGapSeconds: 0,
        canaryObserveMinutes: 0,
        offlineWaitMinutes: 30,
        stopOnFailure: false,
      })
    created.assertStatus(201)
    const id = created.body().data.id
    // respectWindow defaults to on when a window is set.
    assert.isTrue(created.body().data.respectWindow)
    const settings = await getAgentUpdateSettings()

    // Outside the window (UTC 12:00): nothing starts.
    const noon = DateTime.utc().startOf('day').plus({ hours: 12 })
    await advanceRollouts(settings, noon)
    let rollout = await reload(id)
    assert.equal(rollout.waitingFor, 'window')
    assert.equal(await AgentUpdateJob.query().where('ap_id', a.ap.id).first(), null)

    // Inside it (03:00 the next day): the canary starts.
    const night = noon.plus({ hours: 15 })
    await advanceRollouts(settings, night)
    await finishJob(a.ap.id, 'confirmed')
    await advanceRollouts(settings, night.plus({ seconds: 5 }))
    // Batch of two: ap-bedroom starts, ap-cellar is offline and waits.
    rollout = await reload(id)
    assert.equal(rollout.state, 'rolling')
    const states = await devicesOf(id)
    assert.deepEqual(
      states.map((d) => d.state),
      ['confirmed', 'running', 'pending']
    )
    await finishJob(b.ap.id, 'failed', '1.1.0', 'insufficient_flash')
    await advanceRollouts(settings, night.plus({ seconds: 10 }))
    rollout = await reload(id)
    assert.equal(rollout.state, 'rolling')
    assert.equal(rollout.waitingFor, 'online')

    await advanceRollouts(settings, night.plus({ minutes: 31 }))
    await advanceRollouts(settings, night.plus({ minutes: 31, seconds: 5 }))
    rollout = await reload(id)
    assert.equal(rollout.state, 'completed')
    assert.deepEqual(await devicesOf(id), [
      { apId: a.ap.id, state: 'confirmed', canary: true, skip: null },
      { apId: b.ap.id, state: 'failed', canary: false, skip: null },
      { apId: c.ap.id, state: 'skipped', canary: false, skip: 'offline' },
    ])
  })

  test('refusals: unknown release, no eligible device, canary outside, withdrawn release pauses', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    const { release } = await seedRelease({ version: '1.2.0', store: true })
    const a = await seedAp('ap-attic')
    const b = await seedAp('ap-bedroom')
    const row = await AgentUpdateDevice.query().where('ap_id', b.ap.id).firstOrFail()
    row.pinnedVersion = '1.1.0'
    await row.save()

    const unknown = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({ product: 'perch-apd', version: '9.9.9' })
    unknown.assertStatus(422)
    assert.equal(unknown.body().error, 'release_not_found')

    const pinnedOnly = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({ product: 'perch-apd', version: '1.2.0', deviceKeys: [`ap:${b.ap.id}`] })
    pinnedOnly.assertStatus(422)
    assert.equal(pinnedOnly.body().error, 'no_eligible_devices')
    assert.equal(pinnedOnly.body().skipped[0].reason, 'pinned')

    const outside = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({ product: 'perch-apd', version: '1.2.0', canaryKey: `ap:${b.ap.id}` })
    outside.assertStatus(422)
    assert.equal(outside.body().error, 'canary_not_in_rollout')

    // Named devices that cannot take part are listed as skipped, with why.
    const created = await api(client)
      .post('/api/v1/agent-updates/rollouts')
      .bearerToken(adminToken)
      .json({
        product: 'perch-apd',
        version: '1.2.0',
        deviceKeys: [`ap:${a.ap.id}`, `ap:${b.ap.id}`],
      })
    created.assertStatus(201)
    const id = created.body().data.id
    assert.deepEqual(
      created
        .body()
        .data.devices.map((d: { state: string; skipReason: string | null }) => [
          d.state,
          d.skipReason,
        ]),
      [
        ['pending', null],
        ['skipped', 'pinned'],
      ]
    )

    const withdrawn = await api(client)
      .patch(`/api/v1/agent-updates/releases/${release.id}`)
      .bearerToken(adminToken)
      .json({ withdrawn: true })
    withdrawn.assertStatus(200)
    const rollout = await reload(id)
    assert.equal(rollout.state, 'paused')
    assert.equal(rollout.pausedReason, 'release_withdrawn')
    const resume = await api(client)
      .post(`/api/v1/agent-updates/rollouts/${id}/resume`)
      .bearerToken(adminToken)
      .json({})
    resume.assertStatus(409)
    assert.equal(resume.body().error, 'release_not_offerable')

    // An open rollout keeps its release.
    const del = await api(client)
      .delete(`/api/v1/agent-updates/releases/${release.id}`)
      .bearerToken(adminToken)
    del.assertStatus(409)
    assert.equal(del.body().rollouts, 1)
  })

  test('auto-update: a rollout only inside the maintenance window, once per release', async ({
    assert,
  }) => {
    await seedSetupComplete()
    await trustTestKey({ githubCheck: false, autoUpdateAp: 'auto' })
    await seedRelease({ version: '1.2.0', store: true })
    const a = await seedAp('ap-attic')
    await seedAp('ap-bedroom')
    const today = DateTime.utc().startOf('day')

    // No window set: auto-update never starts anything.
    let settings = await getAgentUpdateSettings()
    assert.lengthOf(await autoUpdate(settings, today.plus({ hours: 3 })), 0)

    settings = await trustTestKey({
      githubCheck: false,
      autoUpdateAp: 'auto',
      windowEnabled: true,
      windowStart: '02:00',
      windowEnd: '05:00',
    })
    // A device set to notify stays out.
    const row = await AgentUpdateDevice.query().where('ap_id', a.ap.id).firstOrFail()
    row.autoUpdate = 'notify'
    await row.save()

    assert.lengthOf(await autoUpdate(settings, today.plus({ hours: 12 })), 0)
    const created = await autoUpdate(settings, today.plus({ hours: 3 }))
    assert.lengthOf(created, 1)
    const rollout = created[0]
    assert.isTrue(rollout.auto)
    assert.isTrue(rollout.respectWindow)
    assert.isTrue(rollout.stopOnFailure)
    assert.equal(rollout.version, '1.2.0')
    assert.lengthOf(await devicesOf(rollout.id), 1)
    const event = await AgentUpdateEvent.query()
      .where('rollout_id', rollout.id)
      .where('event', 'rollout_created')
      .firstOrFail()
    assert.equal(event.systemActor, 'auto_update')

    // Not while it is open, and not again for the same release once it ended.
    assert.lengthOf(await autoUpdate(settings, today.plus({ hours: 3, minutes: 1 })), 0)
    rollout.state = 'cancelled'
    await rollout.save()
    assert.lengthOf(await autoUpdate(settings, today.plus({ hours: 3, minutes: 2 })), 0)
  })

  test('settings limits cover every field; the fleet shows the window schedule to operators', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    await trustTestKey({
      githubCheck: false,
      windowEnabled: true,
      windowDays: [1, 3],
      windowStart: '23:00',
      windowEnd: '01:30',
    })
    const settings = await api(client).get('/api/v1/settings/agent-updates').bearerToken(adminToken)
    settings.assertStatus(200)
    const limits = settings.body().data.limits
    assert.deepEqual(limits.defaultChannel, { options: ['stable', 'pre', 'local'] })
    assert.deepEqual(limits.autoUpdateCollector, { options: ['off', 'notify', 'auto'] })
    assert.deepEqual(limits.windowStart, { pattern: 'HH:MM' })
    assert.deepEqual(limits.windowDays, { min: 0, max: 6, maxItems: 7 })
    assert.deepEqual(limits.batchSize, { min: 1, max: 50 })

    const forbidden = await api(client)
      .get('/api/v1/settings/agent-updates')
      .bearerToken(operatorToken)
    forbidden.assertStatus(403)
    const fleet = await api(client).get('/api/v1/agent-updates/fleet').bearerToken(operatorToken)
    fleet.assertStatus(200)
    assert.deepInclude(fleet.body().data.window, {
      enabled: true,
      days: [1, 3],
      start: '23:00',
      end: '01:30',
      timezone: 'UTC',
    })
    assert.property(fleet.body().data.window, 'closesAt')
  })
})
