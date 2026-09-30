import AgentUpdateDevice from '#models/agent_update_device'
import AgentUpdateEvent from '#models/agent_update_event'
import AgentUpdateJob from '#models/agent_update_job'
import { noteAgentPush } from '#services/agent_updates/bridge'
import { _resetInFlight, deviceUpdateInFlight } from '#services/agent_updates/state'
import { _resetTickSchedule, agentUpdatesTick } from '#services/agent_updates/tick'
import hub from '#services/ap_agent_hub'
import {
  DEFAULT_SYSTEM_INFO,
  FakeAgent,
  RpcFailure,
  eventually,
  seedAgentAp,
  seedSetupComplete,
} from '#tests/helpers/ap_agent'
import {
  preflightAnswer,
  seedRelease,
  trustTestKey,
  updateBlock,
  useScratchStore,
  api,
} from '#tests/helpers/agent_updates'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import type { AddressInfo } from 'node:net'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function baseUrl(): Promise<string> {
  const server = await app.container.make('server')
  const address = server.getNodeServer()!.address() as AddressInfo
  return `http://${address.address}:${address.port}`
}

function systemInfo(version: string, update: Record<string, unknown> | null) {
  return {
    ...DEFAULT_SYSTEM_INFO,
    agentVersion: version,
    capabilities: [...DEFAULT_SYSTEM_INFO.capabilities, ...(update ? ['agent_update'] : [])],
    ...(update ? { update } : {}),
  }
}

/** A perch-apd that reports `version` and `update`, and answers agent.update.* as told. */
async function connectAgent(
  credentials: { agentId: string; agentSecret: string },
  version: string,
  update: Record<string, unknown> | null,
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}
) {
  const agent = await FakeAgent.connect({
    ...credentials,
    handlers: {
      'system.info': () => systemInfo(version, update),
      'agent.update.ack': (params) => ({ acked: (params.updateIds as string[]).length }),
      ...handlers,
    },
  })
  await agent.waitFor('system.info')
  return agent
}

async function reportStored(apId: number, predicate: (row: AgentUpdateDevice) => boolean) {
  return eventually(
    () => AgentUpdateDevice.query().where('ap_id', apId).first(),
    (row) => row !== null && predicate(row)
  )
}

async function jobState(id: number) {
  const job = await AgentUpdateJob.findOrFail(id)
  return job.state
}

async function eventNames(jobId: number) {
  const rows = await AgentUpdateEvent.query().where('job_id', jobId).orderBy('id')
  return rows.map((row) => row.event)
}

test.group('agent updates: devices and jobs over the AP socket', (group) => {
  group.each.setup(resetDb)
  group.each.setup(async () => useScratchStore())
  group.each.setup(() => {
    _resetInFlight()
    _resetTickSchedule()
    return () => {
      hub.closeAll(1000, 'test reset')
    }
  })

  test('update → stage → staged → install → candidate → confirm after 30 s and 2 pushes', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    const { built } = await seedRelease({ version: '1.2.0', store: true })
    const { ap, agentId, agentSecret } = await seedAgentAp()

    let stageParams: Record<string, unknown> = {}
    const old = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => {
        stageParams = params
        return { updateId: params.updateId, state: 'downloading', preflight: preflightAnswer() }
      },
      'agent.update.install': (params) => ({
        updateId: params.updateId,
        state: 'installing',
        deadline: '2026-10-01T02:04:04Z',
        rollbackStore: 'flash',
      }),
    })
    await reportStored(ap.id, (row) => row.report !== null)

    const fleet = await api(client).get('/api/v1/agent-updates/fleet').bearerToken(adminToken)
    fleet.assertStatus(200)
    const device = fleet.body().data.devices.find((d: { key: string }) => d.key === `ap:${ap.id}`)
    assert.isTrue(device.selfUpdate.supported)
    assert.equal(device.selfUpdate.installKind, 'swapped')
    assert.isTrue(device.selfUpdate.packageRecordStale)
    assert.equal(device.available.version, '1.2.0')
    assert.equal(device.available.method, 'binary')
    assert.equal(device.versionState, 'update_available')
    assert.equal(fleet.body().data.summary.updateAvailable, 1)

    const created = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    created.assertStatus(201)
    const job = created.body().data
    assert.equal(job.state, 'queued')
    assert.match(job.updateId, /^u-[0-9a-f]{16}$/)
    assert.equal(job.fromVersion, '1.1.0')
    assert.deepEqual(job.requestedBy.name, 'Admin')

    // One open job per device.
    const second = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    second.assertStatus(409)
    second.assertBodyContains({ error: 'update_in_progress', jobId: job.id })

    await agentUpdatesTick()
    assert.equal(await jobState(job.id), 'staging')
    assert.equal(stageParams.updateId, job.updateId)
    assert.equal(stageParams.dryRun, false)
    assert.equal(stageParams.source, 'release')
    assert.equal(stageParams.method, 'binary')
    assert.equal(
      Buffer.from(stageParams.manifest as string, 'base64').toString(),
      built.bytes.toString()
    )
    const policy = stageParams.policy as Record<string, unknown>
    assert.equal(policy.rollbackStore, 'auto')
    assert.equal(policy.probationSeconds, 180)
    assert.equal(policy.flashReserveBytes, 512 * 1024)
    const artefacts = stageParams.artefacts as Array<{ file: string; path: string }>
    assert.deepEqual(
      artefacts.map((a) => a.file),
      ['perch-apd-linux-mipsle']
    )
    assert.match(
      artefacts[0].path,
      new RegExp(
        `^/api/v1/agent-updates/files/\\d+/perch-apd-linux-mipsle\\?d=ap-${ap.id}&exp=\\d+&sig=[0-9a-f]{64}$`
      )
    )
    // The path works for this device.
    const download = await fetch(`${await baseUrl()}${artefacts[0].path}`)
    assert.equal(download.status, 200)
    assert.isTrue(
      Buffer.from(await download.arrayBuffer()).equals(built.files.get('perch-apd-linux-mipsle')!)
    )

    // Progress, then the staged result (acked).
    old.notifyServer('agent.update.progress', {
      updateId: job.updateId,
      phase: 'downloading',
      file: 'perch-apd-linux-mipsle',
      bytes: 1560,
      totalBytes: 1560,
    })
    old.notifyServer('agent.update.result', {
      updateId: job.updateId,
      outcome: 'staged',
      reason: null,
      detail: null,
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      at: '2026-10-01T02:00:00Z',
    })
    await eventually(
      () => jobState(job.id),
      (state) => state === 'staged'
    )
    const ack = await old.waitFor('agent.update.ack')
    assert.deepEqual(ack.params, { updateIds: [job.updateId] })
    assert.isTrue(deviceUpdateInFlight('ap', ap.id))

    await agentUpdatesTick()
    assert.equal(await jobState(job.id), 'installing')
    const installing = await AgentUpdateJob.findOrFail(job.id)
    assert.equal(installing.rollbackStore, 'flash')
    assert.isNotNull(installing.deadlineAt)
    assert.isTrue(deviceUpdateInFlight('ap', ap.id))

    // The watchdog stops the old process; the new one connects a moment later.
    await old.close()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    let confirmed: Record<string, unknown> | null = null
    const candidate = await connectAgent(
      { agentId, agentSecret },
      '1.2.0',
      updateBlock({
        active: {
          updateId: job.updateId,
          phase: 'probation',
          fromVersion: '1.1.0',
          toVersion: '1.2.0',
          method: 'binary',
          rollbackStore: 'flash',
          bytes: null,
          totalBytes: null,
          deadline: '2026-10-01T02:04:04Z',
          watchdog: 'running',
        },
      }),
      {
        'agent.update.confirm': (params) => {
          confirmed = params
          return { updateId: params.updateId, state: 'confirmed', version: '1.2.0', floor: null }
        },
      }
    )
    await eventually(
      () => jobState(job.id),
      (state) => state === 'probation'
    )

    // One real push through the socket counts; not yet enough.
    candidate.notifyServer('metrics.push', {
      format: 'prometheus-text',
      text: '',
      collectedAt: '2026-10-01T02:00:20Z',
      durationMs: 3,
      seq: 1,
    })
    await eventually(
      () => AgentUpdateJob.findOrFail(job.id),
      (row) => row.pushesSeen === 1
    )
    await agentUpdatesTick(DateTime.utc().plus({ seconds: 31 }))
    assert.isNull(confirmed, 'one push is not enough')
    await noteAgentPush('ap', ap.id)
    // Two pushes, but the session is not 30 s old yet.
    await agentUpdatesTick()
    assert.isNull(confirmed, 'the session is too young')
    await agentUpdatesTick(DateTime.utc().plus({ seconds: 31 }))
    assert.deepEqual(confirmed, { updateId: job.updateId })
    assert.equal(await jobState(job.id), 'confirmed')
    assert.isFalse(deviceUpdateInFlight('ap', ap.id))

    const detail = await api(client)
      .get(`/api/v1/agent-updates/jobs/${job.id}`)
      .bearerToken(adminToken)
    detail.assertStatus(200)
    const body = detail.body().data
    assert.equal(body.state, 'confirmed')
    assert.isNotNull(body.confirmedAt)
    assert.deepEqual(
      body.timeline.map((entry: { state: string }) => entry.state),
      ['queued', 'staging', 'staged', 'installing', 'probation', 'confirmed']
    )
    assert.deepEqual(await eventNames(job.id), [
      'job_created',
      'agent_update.started',
      'agent_update.confirmed',
    ])
    await candidate.close()
  })

  test('a watchdog rollback reported on reconnect settles the job and is acked', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const old = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => ({
        updateId: params.updateId,
        state: 'staged',
        preflight: preflightAnswer(),
      }),
      // The watchdog stops the process before it answers.
      'agent.update.install': () => new Promise(() => {}),
    })
    await reportStored(ap.id, (row) => row.report !== null)
    const created = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    const job = created.body().data
    // Staged at once, and the install goes out in the same pass.
    const ticking = agentUpdatesTick()
    await old.waitFor('agent.update.install')
    await old.close()
    await ticking
    // An install without an answer still counts as sent: the device decides.
    assert.equal(await jobState(job.id), 'installing')

    const back = await connectAgent(
      { agentId, agentSecret },
      '1.1.0',
      updateBlock({
        results: [
          {
            updateId: job.updateId,
            outcome: 'rolled_back',
            reason: 'confirm_timeout',
            detail: 'no confirm by the deadline',
            fromVersion: '1.1.0',
            toVersion: '1.2.0',
            at: '2026-10-01T02:04:05Z',
          },
        ],
      })
    )
    await eventually(
      () => jobState(job.id),
      (state) => state === 'rolled_back'
    )
    const row = await AgentUpdateJob.findOrFail(job.id)
    assert.equal(row.reason, 'confirm_timeout')
    assert.isNull(row.activeKey)
    const ack = await back.waitFor('agent.update.ack')
    assert.deepEqual(ack.params, { updateIds: [job.updateId] })
    assert.include(await eventNames(job.id), 'agent_update.rolled_back')
    assert.isFalse(deviceUpdateInFlight('ap', ap.id))
    await back.close()
  })

  test('silent past the deadline → unknown; the new version reporting later → confirmed', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const old = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => ({ updateId: params.updateId, state: 'staged' }),
      'agent.update.install': (params) => ({ updateId: params.updateId, state: 'installing' }),
    })
    await reportStored(ap.id, (row) => row.report !== null)
    const jobResponse = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    const job = jobResponse.body().data
    await agentUpdatesTick()
    await agentUpdatesTick()
    assert.equal(await jobState(job.id), 'installing')
    await old.close()

    // 60 s swap + 180 s probation + 60 s grace later.
    await agentUpdatesTick(DateTime.utc().plus({ seconds: 301 }))
    assert.equal(await jobState(job.id), 'unknown')
    assert.include(await eventNames(job.id), 'agent_update.unknown')
    assert.isTrue(deviceUpdateInFlight('ap', ap.id))

    // It comes back on the new version with nothing pending: the confirm answer was lost.
    const back = await connectAgent({ agentId, agentSecret }, '1.2.0', updateBlock())
    await eventually(
      () => jobState(job.id),
      (state) => state === 'confirmed'
    )
    assert.isFalse(deviceUpdateInFlight('ap', ap.id))
    await back.close()
  })

  test('a pending device-groups apply holds the stage; abort cancels a queued job', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => ({ updateId: params.updateId, state: 'downloading' }),
      'agent.update.abort': (params) => ({ updateId: params.updateId, state: 'cancelled' }),
    })
    await reportStored(ap.id, (row) => row.report !== null)
    // The connect created the AP's device-groups row; make it wait for a confirm.
    await db.from('ap_group_states').where('ap_id', ap.id).delete()
    await db.table('ap_group_states').insert({
      ap_id: ap.id,
      revision: 2,
      applied_revision: 1,
      state: 'pending_confirm',
      converted: false,
      updated_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
    const jobResponse = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    const job = jobResponse.body().data
    await agentUpdatesTick()
    const held = await AgentUpdateJob.findOrFail(job.id)
    assert.equal(held.state, 'queued')
    assert.match(held.detail ?? '', /device_groups apply pending/)
    assert.lengthOf(
      agent.calls.filter((call) => call.method === 'agent.update.stage'),
      0
    )

    await db.from('ap_group_states').where('ap_id', ap.id).update({ state: 'applied' })
    await agentUpdatesTick()
    assert.equal(await jobState(job.id), 'staging')

    const aborted = await api(client)
      .post(`/api/v1/agent-updates/jobs/${job.id}/abort`)
      .bearerToken(adminToken)
    aborted.assertStatus(200)
    assert.equal(aborted.body().data.state, 'cancelled')
    const call = await agent.waitFor('agent.update.abort')
    assert.deepEqual(call.params, { updateId: job.updateId, reason: 'admin' })
    const again = await api(client)
      .post(`/api/v1/agent-updates/jobs/${job.id}/abort`)
      .bearerToken(adminToken)
    again.assertStatus(409)
    again.assertBodyContains({ error: 'job_final' })

    // A queued job is cancelled without asking the device.
    const queuedResponse = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    const queued = queuedResponse.body().data
    const cancelled = await api(client)
      .post(`/api/v1/agent-updates/jobs/${queued.id}/abort`)
      .bearerToken(adminToken)
    assert.equal(cancelled.body().data.state, 'cancelled')
    assert.include(await eventNames(queued.id), 'job_aborted')
    await agent.close()
  })

  test('an expired link re-stages; a refusal fails the job with the agent reason', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    let stages = 0
    const agent = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => {
        stages += 1
        if (stages >= 3) throw new RpcFailure(-32000, 'below the floor', { error: 'below_floor' })
        return { updateId: params.updateId, state: 'downloading' }
      },
    })
    await reportStored(ap.id, (row) => row.report !== null)
    const jobResponse = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    const job = jobResponse.body().data
    await agentUpdatesTick()
    agent.notifyServer('agent.update.result', {
      updateId: job.updateId,
      outcome: 'failed',
      reason: 'url_expired',
      detail: 'HTTP 403',
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      at: '2026-10-01T02:00:00Z',
    })
    await eventually(
      () => AgentUpdateJob.findOrFail(job.id),
      (row) => row.state === 'queued'
    )
    const restaged = await AgentUpdateJob.findOrFail(job.id)
    assert.equal(restaged.restageCount, 1)
    await agentUpdatesTick()
    assert.equal(stages, 2)
    assert.equal(await jobState(job.id), 'staging')

    agent.notifyServer('agent.update.result', {
      updateId: job.updateId,
      outcome: 'failed',
      reason: 'url_expired',
      detail: null,
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      at: '2026-10-01T02:00:00Z',
    })
    await eventually(
      () => jobState(job.id),
      (state) => state === 'queued'
    )
    await agentUpdatesTick()
    const failed = await AgentUpdateJob.findOrFail(job.id)
    assert.equal(failed.state, 'failed')
    assert.equal(failed.reason, 'below_floor')
    assert.include(await eventNames(job.id), 'agent_update.failed')
    await agent.close()
  })

  test('preflight is a dry-run stage; the agent refusal is 409 agent_refused', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: false })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    let refuse = false
    const agent = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => {
        if (refuse) throw new RpcFailure(-32000, 'unknown key', { error: 'unknown_key' })
        return {
          updateId: params.updateId,
          state: 'dry_run',
          preflight: preflightAnswer({
            ok: false,
            problems: [
              { code: 'insufficient_flash', message: 'not enough', freeBytes: 1, needBytes: 2 },
            ],
          }),
        }
      },
    })
    await reportStored(ap.id, (row) => row.report !== null)
    const response = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/preflight`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    response.assertStatus(200)
    const body = response.body().data
    assert.isFalse(body.preflight.ok)
    assert.equal(body.preflight.problems[0].code, 'insufficient_flash')
    assert.equal(body.release.version, '1.2.0')
    const call = await agent.waitFor('agent.update.stage')
    assert.isTrue(call.params.dryRun)

    refuse = true
    const refused = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/preflight`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0' })
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'agent_refused', code: 'unknown_key' })

    const missing = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/preflight`)
      .bearerToken(adminToken)
      .json({ version: '9.9.9' })
    missing.assertStatus(422)
    missing.assertBodyContains({ error: 'release_not_found' })

    const events = await AgentUpdateEvent.query().where('event', 'preflight')
    assert.lengthOf(events, 1)
    await agent.close()
  })

  test('old agents get a manual command; channel, pin and version changes', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    await seedRelease({ version: '1.2.0', store: true })
    await seedRelease({ version: '1.3.0-rc.1', channel: 'pre', store: true })
    const old = await seedAgentAp({ name: 'ap-old', macs: ['02:00:00:00:00:21'] })
    const fresh = await seedAgentAp({ name: 'ap-new', macs: ['02:00:00:00:00:31'] })

    const legacy = await connectAgent(old, '1.0.0', null)
    await reportStored(old.ap.id, (row) => row.versionSeen === '1.0.0')
    const current = await connectAgent(fresh, '1.1.0', updateBlock())
    await reportStored(fresh.ap.id, (row) => row.report !== null)

    const fleet = await api(client).get('/api/v1/agent-updates/fleet').bearerToken(operatorToken)
    fleet.assertStatus(200)
    const byKey = (key: string) =>
      fleet.body().data.devices.find((d: { key: string }) => d.key === key)
    const legacyView = byKey(`ap:${old.ap.id}`)
    assert.isFalse(legacyView.selfUpdate.supported)
    assert.equal(legacyView.selfUpdate.reason, 'agent_too_old')
    assert.isNull(legacyView.available)
    assert.equal(legacyView.manualCommand.targetVersion, '1.2.0')
    assert.match(legacyView.manualCommand.command, /sha256sum -c -/)
    assert.match(
      legacyView.manualCommand.command,
      /\/api\/v1\/agent-updates\/files\/\d+\/perch-apd-linux-mipsle\?d=ap-/
    )
    assert.isNotNull(legacyView.manualCommand.expiresAt)
    assert.isTrue(legacyView.manualCommand.notes.some((note: string) => /plain HTTP/.test(note)))
    assert.equal(byKey(`ap:${fresh.ap.id}`).available.version, '1.2.0')

    // Channel `pre` sees the release candidate.
    const pre = await api(client)
      .patch(`/api/v1/agent-updates/devices/ap/${fresh.ap.id}`)
      .bearerToken(adminToken)
      .json({ channel: 'pre' })
    pre.assertStatus(200)
    assert.equal(pre.body().data.channel, 'pre')
    assert.equal(pre.body().data.available.version, '1.3.0-rc.1')
    // Hold at: no offers.
    const pinned = await api(client)
      .patch(`/api/v1/agent-updates/devices/ap/${fresh.ap.id}`)
      .bearerToken(adminToken)
      .json({ pinnedVersion: '1.1.0' })
    assert.isNull(pinned.body().data.available)
    assert.equal(pinned.body().data.pinnedVersion, '1.1.0')
    const operatorWrite = await api(client)
      .patch(`/api/v1/agent-updates/devices/ap/${fresh.ap.id}`)
      .bearerToken(operatorToken)
      .json({ pinnedVersion: null })
    operatorWrite.assertStatus(403)

    // A manual update (no job): version_changed.
    await legacy.close()
    await connectAgent(old, '1.2.0', updateBlock())
    await eventually(
      () => AgentUpdateEvent.query().where('event', 'agent_update.version_changed').first(),
      (row) => row !== null
    )
    const events = await api(client)
      .get(`/api/v1/agent-updates/events?deviceKey=ap:${old.ap.id}`)
      .bearerToken(operatorToken)
    const changed = events
      .body()
      .data.events.find((e: { event: string }) => e.event === 'agent_update.version_changed')
    assert.deepEqual(changed.detail, { fromVersion: '1.0.0', toVersion: '1.2.0' })
    assert.equal(changed.device.key, `ap:${old.ap.id}`)
    await current.close()
  })

  test('rollback asks for no_previous or restores the kept version', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey({ githubCheck: false })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    let stage: Record<string, unknown> = {}
    const agent = await connectAgent({ agentId, agentSecret }, '1.2.0', updateBlock(), {
      'agent.update.stage': (params) => {
        stage = params
        return { updateId: params.updateId, state: 'staged' }
      },
    })
    await reportStored(ap.id, (row) => row.report !== null)
    const none = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/rollback`)
      .bearerToken(adminToken)
      .json({})
    none.assertStatus(409)
    none.assertBodyContains({ error: 'no_previous' })
    await agent.close()

    const again = await connectAgent(
      { agentId, agentSecret },
      '1.2.0',
      updateBlock({ previous: { version: '1.1.0', store: 'flash', sha256: 'b'.repeat(64) } }),
      {
        'agent.update.stage': (params) => {
          stage = params
          return { updateId: params.updateId, state: 'staged' }
        },
        'agent.update.install': (params) => ({ updateId: params.updateId, state: 'installing' }),
      }
    )
    await reportStored(ap.id, (row) => row.report?.previous?.version === '1.1.0')
    const rollback = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/rollback`)
      .bearerToken(adminToken)
      .json({})
    rollback.assertStatus(201)
    assert.equal(rollback.body().data.source, 'previous')
    assert.equal(rollback.body().data.toVersion, '1.1.0')
    await agentUpdatesTick()
    assert.equal(stage.source, 'previous')
    assert.isUndefined(stage.manifest)
    assert.equal(await jobState(rollback.body().data.id), 'installing')
    await again.close()
  })

  test('settings: defaults, limits, extra keys; jobs list pages', async ({ client, assert }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const read = await api(client).get('/api/v1/settings/agent-updates').bearerToken(adminToken)
    read.assertStatus(200)
    assert.equal(read.body().data.settings.probationSeconds, 180)
    assert.equal(read.body().data.limits.minPushes.max, 20)
    const operator = await api(client)
      .get('/api/v1/settings/agent-updates')
      .bearerToken(operatorToken)
    operator.assertStatus(403)

    const patched = await api(client)
      .patch('/api/v1/settings/agent-updates')
      .bearerToken(adminToken)
      .json({ stableSeconds: 45, windowEnabled: true, windowDays: [1, 3] })
    patched.assertStatus(200)
    assert.equal(patched.body().data.settings.stableSeconds, 45)
    assert.deepEqual(patched.body().data.settings.windowDays, [1, 3])
    const tooHigh = await api(client)
      .patch('/api/v1/settings/agent-updates')
      .bearerToken(adminToken)
      .json({ minPushes: 21 })
    tooHigh.assertStatus(422)
    const badKey = await api(client)
      .patch('/api/v1/settings/agent-updates')
      .bearerToken(adminToken)
      .json({ extraTrustedKeys: ['not a key'] })
    badKey.assertStatus(422)
    badKey.assertBodyContains({ error: 'key_invalid' })
    const logged = await AgentUpdateEvent.query().where('event', 'settings_changed')
    assert.lengthOf(logged, 1)
    assert.sameMembers((logged[0].detail as { changed: string[] }).changed, [
      'stableSeconds',
      'windowEnabled',
      'windowDays',
    ])

    const jobs = await api(client)
      .get('/api/v1/agent-updates/jobs?state=open')
      .bearerToken(adminToken)
    jobs.assertStatus(200)
    assert.deepEqual(jobs.body().data, { jobs: [], nextBefore: null })
  })

  test('"in the maintenance window" waits for the window', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    // A window that is never open now: one day, the day after tomorrow, for one minute.
    const day = (DateTime.utc().plus({ days: 2 }).weekday % 7) as number
    await trustTestKey({
      githubCheck: false,
      windowEnabled: true,
      windowDays: [day],
      windowStart: '03:00',
      windowEnd: '03:01',
    })
    await seedRelease({ version: '1.2.0', store: true })
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await connectAgent({ agentId, agentSecret }, '1.1.0', updateBlock(), {
      'agent.update.stage': (params) => ({ updateId: params.updateId, state: 'downloading' }),
    })
    await reportStored(ap.id, (row) => row.report !== null)
    const jobResponse = await api(client)
      .post(`/api/v1/agent-updates/devices/ap/${ap.id}/update`)
      .bearerToken(adminToken)
      .json({ version: '1.2.0', when: 'window' })
    const job = jobResponse.body().data
    const row = await AgentUpdateJob.findOrFail(job.id)
    assert.isTrue(row.respectWindow)
    assert.isTrue(row.notBefore! > DateTime.utc())
    await agentUpdatesTick()
    assert.equal(await jobState(job.id), 'queued')
    await agent.close()
  })
})
