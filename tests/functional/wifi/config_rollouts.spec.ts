import ApConfig from '#models/ap_config'
import ApConfigSection from '#models/ap_config_section'
import SystemSetting from '#models/system_setting'
import WifiNetwork from '#models/wifi_network'
import WifiRollout from '#models/wifi_rollout'
import WifiRolloutStep from '#models/wifi_rollout_step'
import hub from '#services/ap_agent_hub'
import { WIFI_CONFIG_SETTING_KEY } from '#services/wifi_config/settings'
import { wifiConfigTick } from '#services/wifi_config/tick'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  drainPlane,
  FakeAp,
  resetPlaneState,
  seedPlaneAp,
  type FakeApOptions,
} from '#tests/helpers/fake_ap'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * Rollouts across APs and the REST surface around them (docs/design/wifi
 * controller.md sections 4.5, 4.6, 6 and 7): one AP at a time, stopping at
 * the first failure, skip and retry, an offline AP skipped and caught up on
 * reconnect, the active rollout read, a preview of unsaved edits that
 * stores nothing, the country policy as a draft, revision restores,
 * Authoritative Mode's revert of a router edit, and the rejoin offer of a
 * reset AP.
 */

const PASSWORD = 'admin-pass-123'

let fakes: FakeAp[] = []

type Ap = { apId: number; fake: FakeAp }
type Env = { adminToken: string; operatorToken: string; aps: Ap[] }

function api(client: unknown): any {
  return client
}

async function addAp(name: string, options: Partial<FakeApOptions> = {}): Promise<Ap> {
  const { ap, agentId, agentSecret } = await seedPlaneAp(name)
  const fake = new FakeAp({ agentId, agentSecret, ...options })
  fakes.push(fake)
  await fake.connect()
  await eventually(
    () => ApConfig.find(ap.id),
    (row) => row !== null && row.capabilities !== null,
    4000
  )
  await drainPlane()
  return { apId: ap.id, fake }
}

async function settled(id: number, timeoutMs = 10_000) {
  const rollout = await eventually(
    async () => {
      await drainPlane()
      return WifiRollout.findOrFail(id)
    },
    (r) => r.state !== 'running',
    timeoutMs
  )
  await drainPlane()
  return rollout
}

async function patchAp(client: unknown, env: Env, apId: number, body: object, query = '') {
  return api(client)
    .patch(`/api/v1/wifi/config/aps/${apId}${query}`)
    .bearerToken(env.adminToken)
    .json(body)
}

/** Every AP observed, the one proposal adopted, every AP managed. */
async function setup(
  client: unknown,
  count = 2,
  options: Partial<FakeApOptions> = {}
): Promise<Env> {
  const { adminToken, operatorToken } = await seedSetupComplete()
  const aps: Ap[] = []
  for (let i = 1; i <= count; i++) aps.push(await addAp(`ap-${i}`, options))
  const env = { adminToken, operatorToken, aps }
  for (const ap of aps) {
    const observe = await patchAp(client, env, ap.apId, { mode: 'observe' })
    observe.assertStatus(200)
  }
  await drainPlane()
  const view = await api(client).get('/api/v1/wifi/adoption').bearerToken(adminToken)
  const proposals = view.body().data.proposals as Array<{ key: string }>
  const adopted = await api(client)
    .post('/api/v1/wifi/adoption')
    .bearerToken(adminToken)
    .json({ proposals: proposals.map((p) => ({ key: p.key })) })
  adopted.assertStatus(200)
  for (const ap of aps) {
    const managed = await patchAp(client, env, ap.apId, {
      mode: 'managed',
      currentPassword: PASSWORD,
    })
    managed.assertStatus(200)
    const rollout = managed.body().data.rollout
    if (rollout) await settled(rollout.id)
  }
  return env
}

async function editNetwork(client: unknown, env: Env, body: object, query = '') {
  const network = await WifiNetwork.firstOrFail()
  const r = await api(client)
    .patch(`/api/v1/wifi/networks/${network.id}${query}`)
    .bearerToken(env.adminToken)
    .json(body)
  r.assertStatus(200)
  return r.body().data
}

test.group('wifi rollouts', (group) => {
  group.each.setup(async () => {
    const teardown = await testUtils.db().truncate()
    await teardown()
    await resetPlaneState()
    fakes = []
    return async () => {
      for (const fake of fakes) await fake.destroy()
      hub.closeAll(1000, 'test reset')
      await drainPlane()
      await resetPlaneState()
    }
  })

  test('one AP at a time, stop at the first failure, skip goes on', async ({ assert, client }) => {
    const env = await setup(client)
    const [first, second] = env.aps
    first.fake.health = 'fail'
    const appliesBefore = second.fake.calls.filter((c) => c.method === 'wifi.config.apply').length
    const result = await editNetwork(client, env, { hidden: true })
    assert.deepEqual(
      result.rollout.steps.map((s: any) => s.apId),
      [first.apId, second.apId]
    )
    assert.deepEqual(
      result.rollout.impact.aps.map((a: any) => a.order),
      [0, 1]
    )
    const stopped = await settled(result.rollout.id)
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.stop?.apId, first.apId)
    // The second AP was never touched.
    assert.lengthOf(
      second.fake.calls.filter((c) => c.method === 'wifi.config.apply'),
      appliesBefore
    )
    const steps = await WifiRolloutStep.query()
      .where('rollout_id', Number(stopped.id))
      .orderBy('position')
    assert.deepEqual(
      steps.map((s) => s.state),
      ['rolled_back', 'pending']
    )

    const view = await api(client)
      .get(`/api/v1/wifi/rollouts/${stopped.id}`)
      .bearerToken(env.operatorToken)
    assert.equal(view.body().data.steps[0].state, 'rolled_back')
    assert.equal(view.body().data.steps[0].apply.outcome.reason, 'health_failed')
    const network = await api(client).get('/api/v1/wifi/networks').bearerToken(env.operatorToken)
    assert.equal(network.body().data[0].status, 'ahead')

    const skip = await api(client)
      .post(`/api/v1/wifi/rollouts/${stopped.id}/skip`)
      .bearerToken(env.adminToken)
      .json({ apId: first.apId })
    skip.assertStatus(200)
    const done = await settled(Number(stopped.id))
    const doneSteps = await WifiRolloutStep.query()
      .where('rollout_id', Number(done.id))
      .orderBy('position')
    assert.equal(
      done.state,
      'completed',
      JSON.stringify({ stop: done.stop, steps: doneSteps.map((s) => [s.state, s.outcome]) })
    )
    assert.equal(second.fake.section('wireless', 'default_radio0')!.options.hidden, '1')
    assert.isUndefined(first.fake.section('wireless', 'default_radio0')!.options.hidden)
    const after = await api(client).get('/api/v1/wifi/networks').bearerToken(env.operatorToken)
    assert.equal(after.body().data[0].status, 'partial')

    const history = await api(client)
      .get('/api/v1/wifi/rollouts?limit=2')
      .bearerToken(env.operatorToken)
    assert.lengthOf(history.body().data.items, 2)
    assert.isNotNull(history.body().data.nextBefore)
  }).timeout(120_000)

  test('an offline AP is skipped and catches up when it is back', async ({ assert, client }) => {
    const env = await setup(client)
    const [first, second] = env.aps
    await second.fake.close()
    await eventually(
      () => hub.isOnline(second.apId),
      (online) => !online,
      2000
    )
    const result = await editNetwork(client, env, { isolate: true })
    const done = await settled(result.rollout.id)
    assert.equal(done.state, 'completed')
    const steps = await WifiRolloutStep.query()
      .where('rollout_id', Number(done.id))
      .orderBy('position')
    assert.deepEqual(
      steps.map((s) => [s.apId, s.state]),
      [
        [first.apId, 'confirmed'],
        [second.apId, 'skipped'],
      ]
    )
    assert.equal(first.fake.section('wireless', 'default_radio1')!.options.isolate, '1')

    await second.fake.connect()
    const caughtUp = await eventually(
      async () => {
        await drainPlane()
        return WifiRollout.query().where('kind', 'catch_up').first()
      },
      (r) => r !== null,
      6000
    )
    const finished = await settled(Number(caughtUp!.id))
    assert.equal(finished.state, 'completed')
    assert.equal(finished.confirmMode, 'agent')
    assert.equal(second.fake.section('wireless', 'default_radio1')!.options.isolate, '1')
  }).timeout(120_000)

  test('REST: preview of unsaved edits, the active rollout, a country draft, restore', async ({
    assert,
    client,
  }) => {
    const env = await setup(client, 1)
    const [ap] = env.aps
    const network = await WifiNetwork.firstOrFail()

    const preview = await api(client)
      .post('/api/v1/wifi/rollouts/preview')
      .bearerToken(env.adminToken)
      .json({ draft: { network: { id: network.id, hidden: true } } })
    preview.assertStatus(200)
    assert.lengthOf(preview.body().data.aps, 1)
    assert.equal(preview.body().data.aps[0].order, 0)
    assert.equal(preview.body().data.aps[0].touchedBss, 2)
    // Nothing stored.
    await network.refresh()
    assert.notOk(network.hidden)
    const ahead = await ApConfigSection.query().where('ap_id', ap.apId).where('status', 'ahead')
    assert.lengthOf(ahead, 0)

    const current = await api(client)
      .get('/api/v1/wifi/rollouts/current')
      .bearerToken(env.operatorToken)
    current.assertStatus(200)
    assert.isNull(current.body().data)

    const country = await patchAp(
      client,
      env,
      ap.apId,
      { country: { mode: 'fixed', code: 'us' } },
      '?apply=0'
    )
    country.assertStatus(200)
    assert.isNull(country.body().data.rollout)
    assert.equal(country.body().data.object.country.mode, 'fixed')
    assert.equal(country.body().data.object.country.effective, 'US')
    const radios = await ApConfigSection.query()
      .where('ap_id', ap.apId)
      .where('domain', 'wifi_radios')
    assert.deepEqual(
      radios.map((r) => r.status),
      ['ahead', 'ahead']
    )
    const started = await api(client)
      .post('/api/v1/wifi/rollouts')
      .bearerToken(env.adminToken)
      .json({ apIds: [ap.apId], note: 'country' })
    started.assertStatus(202)
    const running = await api(client)
      .get('/api/v1/wifi/rollouts/current')
      .bearerToken(env.operatorToken)
    assert.equal(running.body().data.id, started.body().data.id)
    await settled(started.body().data.id)
    assert.equal(ap.fake.section('wireless', 'radio0')!.options.country, 'US')

    const overview = await api(client).get('/api/v1/wifi/config').bearerToken(env.operatorToken)
    assert.isNull(overview.body().data.rollout)
    assert.equal(overview.body().data.adoptionPending, 0)
    assert.lengthOf(overview.body().data.networks, 1)
    assert.equal(overview.body().data.divergences, 0)

    const revisions = await api(client)
      .get(`/api/v1/wifi/config/aps/${ap.apId}/revisions`)
      .bearerToken(env.operatorToken)
    const before = revisions.body().data.items.find((r: any) => r.rolloutId === null)
    const restore = await api(client)
      .post(`/api/v1/wifi/config/aps/${ap.apId}/revisions/${before.number}/restore?apply=0`)
      .bearerToken(env.adminToken)
      .json({})
    restore.assertStatus(200)
    assert.includeMembers(Object.keys(restore.body().data), [
      'perchIds',
      'changes',
      'rollout',
      'rolloutError',
    ])
    assert.isNull(restore.body().data.rollout)
    assert.lengthOf(restore.body().data.perchIds, 2)
    assert.equal(restore.body().data.changes[0].options[0].name, 'country')
    const draft = await api(client)
      .get(`/api/v1/wifi/config/aps/${ap.apId}/draft`)
      .bearerToken(env.operatorToken)
    assert.lengthOf(draft.body().data.jobs, 1)
  }).timeout(120_000)

  test('Authoritative Mode: only in sync; a router edit is reverted', async ({
    assert,
    client,
  }) => {
    const env = await setup(client, 1)
    const [ap] = env.aps
    await SystemSetting.set(WIFI_CONFIG_SETTING_KEY, { authoritativeRevertDelaySeconds: 0 })
    const status = await api(client)
      .get(`/api/v1/wifi/config/aps/${ap.apId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    status.assertStatus(200)
    assert.isTrue(status.body().data.inSync)
    const stale = await patchAp(client, env, ap.apId, {
      authoritative: true,
      expectRevision: status.body().data.headRevision + 5,
      currentPassword: PASSWORD,
    })
    stale.assertStatus(409)
    assert.equal(stale.body().error, 'sync_changed')
    const on = await patchAp(client, env, ap.apId, {
      authoritative: true,
      expectRevision: status.body().data.headRevision,
      currentPassword: PASSWORD,
    })
    on.assertStatus(200)
    assert.isTrue(on.body().data.object.authoritative)
    assert.isTrue(ap.fake.configureBlock()!.authoritative as boolean)

    ap.fake.routerEdit('wireless', (sections) => {
      sections.find((s) => s.name === 'default_radio0')!.options.hidden = '1'
    })
    await eventually(
      async () => {
        await drainPlane()
        return ApConfigSection.query().where('ap_id', ap.apId).where('status', 'drift').first()
      },
      (row) => row !== null,
      4000
    )
    await eventually(
      async () => {
        await wifiConfigTick()
        await drainPlane()
        return ap.fake.section('wireless', 'default_radio0')!.options.hidden
      },
      (hidden) => hidden === undefined,
      8000
    )
    await eventually(
      async () => {
        await drainPlane()
        return ApConfig.findOrFail(ap.apId)
      },
      (row) => row.syncState === 'in_sync',
      4000
    )
  }).timeout(120_000)

  test('a reset AP is offered a rejoin; nothing happens until the admin chooses', async ({
    assert,
    client,
  }) => {
    const env = await setup(client, 1)
    const [ap] = env.aps
    ap.fake.ledger = []
    ap.fake.routerEdit('wireless', () => {}, { kind: 'cli', via: 'poll' })
    const row = await eventually(
      async () => {
        await drainPlane()
        return ApConfig.findOrFail(ap.apId)
      },
      (r) => r.rejoinOffer !== null,
      4000
    )
    assert.equal(row.rejoinOffer!.reason, 'ledger_reset')
    assert.lengthOf(ap.fake.ledger, 0)
    const view = await api(client)
      .get(`/api/v1/wifi/config/aps/${ap.apId}`)
      .bearerToken(env.operatorToken)
    assert.equal(view.body().data.rejoinOffer.reason, 'ledger_reset')

    const rejoin = await api(client)
      .post(`/api/v1/wifi/config/aps/${ap.apId}/rejoin`)
      .bearerToken(env.adminToken)
      .json({ use: 'fleet' })
    rejoin.assertStatus(202)
    assert.equal(rejoin.body().data.kind, 'rejoin')
    await settled(rejoin.body().data.id)
    assert.lengthOf(ap.fake.ledger, 4)
    await ApConfig.findOrFail(ap.apId).then((r) => assert.isNull(r.rejoinOffer))
  }).timeout(120_000)
})
