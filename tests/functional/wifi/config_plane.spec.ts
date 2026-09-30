import ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import SystemSetting from '#models/system_setting'
import WifiDivergence from '#models/wifi_divergence'
import WifiIfaceLink from '#models/wifi_iface_link'
import WifiNetwork from '#models/wifi_network'
import WifiRollout from '#models/wifi_rollout'
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
 * The Wi-Fi plane end to end (docs/design/wifi controller.md sections 4–7)
 * against a scripted perch-apd over the real AP socket: the hello and the
 * configure block, observe and the read, adoption with zero change on the
 * AP, entering managed with adopt jobs, the passphrase check, a network edit
 * rolled out with the confirm on the fresh session and the AP's health
 * check, a health failure stopping the rollout, router edits as
 * divergences, radio edits, and the REST refusals.
 */

const PASSWORD = 'admin-pass-123'
const PASSPHRASE = 'correct horse battery'

let fakes: FakeAp[] = []

type Env = { adminToken: string; operatorToken: string; apId: number; fake: FakeAp }

/** The typed client knows only the committed route registry: these routes are new. */
function api(client: unknown): any {
  return client
}

async function setup(options: Partial<FakeApOptions> = {}, name = 'ap-one'): Promise<Env> {
  const { adminToken, operatorToken } = await seedSetupComplete()
  const env = await addAp(name, options)
  return { adminToken, operatorToken, ...env }
}

async function addAp(name: string, options: Partial<FakeApOptions> = {}) {
  const { ap, agentId, agentSecret } = await seedPlaneAp(name)
  const fake = new FakeAp({ agentId, agentSecret, ...options })
  fakes.push(fake)
  await fake.connect()
  if (!options.noPlane) {
    await eventually(
      () => fake.configureBlock(),
      (block) => typeof block?.fingerprintKey === 'string',
      4000
    )
    await eventually(
      () => ApConfig.find(ap.id),
      (row) => row !== null && row.capabilities !== null,
      4000
    )
  }
  await drainPlane()
  return { apId: ap.id, fake }
}

async function patchAp(client: unknown, env: Env, body: Record<string, unknown>, query = '') {
  return api(client)
    .patch(`/api/v1/wifi/config/aps/${env.apId}${query}`)
    .bearerToken(env.adminToken)
    .json(body)
}

/** Observe, adopt everything proposed, then managed (the adopt rollout runs). */
async function toManaged(client: unknown, env: Env) {
  const observe = await patchAp(client, env, { mode: 'observe' })
  observe.assertStatus(200)
  await drainPlane()
  const view = await api(client).get('/api/v1/wifi/adoption').bearerToken(env.adminToken)
  view.assertStatus(200)
  const proposals = view.body().data.proposals as Array<{ key: string }>
  const accepted = await api(client)
    .post('/api/v1/wifi/adoption')
    .bearerToken(env.adminToken)
    .json({ proposals: proposals.map((p) => ({ key: p.key })), countryDefault: 'PH' })
  accepted.assertStatus(200)
  const managed = await patchAp(client, env, { mode: 'managed', currentPassword: PASSWORD })
  managed.assertStatus(200)
  await drainPlane()
  const rolloutId = managed.body().data.rollout?.id as number | undefined
  if (rolloutId) await settled(rolloutId)
  return { adoption: accepted.body().data, managed: managed.body().data }
}

/** Waits for a rollout to finish (completed, stopped or cancelled). */
async function settled(id: number, timeoutMs = 8000) {
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

test.group('wifi config plane', (group) => {
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

  test('the hello creates the row and configure carries the plane block', async ({
    assert,
    client,
  }) => {
    const env = await setup()
    const row = await ApConfig.findOrFail(env.apId)
    assert.equal(row.mode, 'off')
    assert.equal(row.agentAccess, 'write')
    assert.equal(row.guard, 'installed')
    const block = env.fake.configureBlock()!
    assert.equal(block.mode, 'off')
    assert.match(String(block.fingerprintKey), /^[0-9a-f]{64}$/)
    assert.equal(block.healthWaitSeconds, 45)

    const list = await api(client).get('/api/v1/wifi/config/aps').bearerToken(env.operatorToken)
    list.assertStatus(200)
    const ap = list.body().data.find((a: any) => a.apId === env.apId)
    assert.isTrue(ap.capable)
    assert.isTrue(ap.online)
    assert.isTrue(ap.secure)
    assert.isTrue(ap.writable)
    assert.equal(ap.mode, 'off')
    assert.equal(ap.features.sae, true)
    assert.notProperty(ap, 'capabilities')

    const detail = await api(client)
      .get(`/api/v1/wifi/config/aps/${env.apId}`)
      .bearerToken(env.operatorToken)
    assert.equal(detail.body().data.capabilities.radios.length, 2)
    assert.equal(detail.body().data.managementPath.network, 'lan')
    // Nothing was read in mode off.
    assert.isFalse(env.fake.calls.some((c) => c.method === 'wifi.config.read'))
  }).timeout(120_000)

  test('observe reads, adoption changes nothing, managed only adopts', async ({
    assert,
    client,
  }) => {
    const env = await setup()
    const observe = await patchAp(client, env, { mode: 'observe' })
    observe.assertStatus(200)
    assert.equal(observe.body().data.object.mode, 'observe')
    assert.isNull(observe.body().data.rollout)
    await drainPlane()
    assert.isTrue(env.fake.calls.some((c) => c.method === 'wifi.config.read'))

    const adoption = await api(client).get('/api/v1/wifi/adoption').bearerToken(env.adminToken)
    const proposals = adoption.body().data.proposals
    assert.lengthOf(proposals, 1)
    assert.equal(proposals[0].ssid, 'Home')
    assert.equal(proposals[0].security, 'wpa2')
    assert.deepEqual(proposals[0].bands, ['2g', '5g'])
    assert.equal(proposals[0].apScope, 'all')
    // The time zone (UTC) suggests nothing: the most common radio country.
    assert.equal(adoption.body().data.suggestedCountry, 'PH')

    const wirelessBefore = env.fake.hash('wireless')
    const { adoption: accepted } = await toManaged(client, env)
    assert.lengthOf(accepted.networks, 1)
    assert.equal(accepted.divergences, 0)
    assert.equal(accepted.networks[0].passphrase.state, 'unknown')
    // Adopt jobs changed only the ledger: the AP's Wi-Fi is untouched.
    assert.equal(env.fake.hash('wireless'), wirelessBefore)
    assert.lengthOf(env.fake.ledger, 4)
    const applies = await ApConfigApply.query().where('ap_id', env.apId)
    assert.lengthOf(applies, 1)
    assert.equal(applies[0].kind, 'adopt')
    assert.equal(applies[0].state, 'confirmed')
    const rollout = await WifiRollout.query().firstOrFail()
    assert.equal(rollout.kind, 'adopt')
    assert.equal(rollout.state, 'completed')
    const row = await ApConfig.findOrFail(env.apId)
    assert.equal(row.fleetState, 'in_line')
    assert.equal(row.syncState, 'in_sync')
    assert.equal(env.fake.configureBlock()!.mode, 'managed')
  }).timeout(120_000)

  test('the passphrase is checked against the AP; a network edit rolls out and confirms', async ({
    assert,
    client,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const network = await WifiNetwork.firstOrFail()

    const wrong = await api(client)
      .post(`/api/v1/wifi/networks/${network.id}/passphrase`)
      .bearerToken(env.adminToken)
      .json({ passphrase: 'not the passphrase' })
    wrong.assertStatus(409)
    assert.equal(wrong.body().error, 'passphrase_mismatch')
    assert.lengthOf(wrong.body().matches, 2)
    assert.isFalse(wrong.body().matches[0].match)

    const right = await api(client)
      .post(`/api/v1/wifi/networks/${network.id}/passphrase`)
      .bearerToken(env.adminToken)
      .json({ passphrase: PASSPHRASE })
    right.assertStatus(200)
    assert.equal(right.body().data.network.passphrase.state, 'set')
    assert.isNull(right.body().data.rollout)
    await drainPlane()
    // Nothing to apply: the AP already runs that key.
    assert.equal(right.body().data.network.status, 'in_sync')

    const edit = await api(client)
      .patch(`/api/v1/wifi/networks/${network.id}`)
      .bearerToken(env.adminToken)
      .json({ hidden: true })
    edit.assertStatus(200)
    const rollout = edit.body().data.rollout
    assert.equal(rollout.kind, 'change')
    assert.lengthOf(rollout.steps, 1)
    const done = await settled(rollout.id)
    assert.equal(done.state, 'completed')
    assert.equal(env.fake.section('wireless', 'default_radio0')!.options.hidden, '1')
    assert.equal(env.fake.section('wireless', 'default_radio1')!.options.hidden, '1')
    // Router-owned options and the key are the AP's, kept by the write.
    assert.equal(env.fake.section('wireless', 'default_radio0')!.options.ifname, 'home-2g')
    assert.equal(env.fake.section('wireless', 'default_radio0')!.options.key, PASSPHRASE)
    const apply = await ApConfigApply.query()
      .where('ap_id', env.apId)
      .where('kind', 'apply')
      .firstOrFail()
    assert.equal(apply.state, 'confirmed')
    assert.isNotNull(apply.agentReconnectedAt)
    assert.isNotNull(apply.agentConfirmedAt)
    assert.equal(apply.confirmMode, 'agent')
    assert.isTrue(apply.health?.ok)
    // On the wire, options Perch does not own travel as {"$keep": true}.
    const sent = env.fake.calls.filter((c) => c.method === 'wifi.config.apply').at(-1)!
    const put = (sent.params.ops as any[]).find(
      (op) => op.op === 'put' && op.section === 'default_radio0'
    )
    assert.deepEqual(put.options.ifname, { $keep: true })
    // The AP holds that passphrase already: it is kept, not sent again.
    assert.deepEqual(put.options.key, { $keep: true })
    assert.notProperty(sent.params, 'secrets')
    assert.equal(put.options.hidden, '1')
    assert.deepEqual((sent.params.expect as any).bss, ['default_radio0', 'default_radio1'])

    const view = await api(client)
      .get(`/api/v1/wifi/networks/${network.id}`)
      .bearerToken(env.operatorToken)
    assert.equal(view.body().data.status, 'in_sync')
    assert.isTrue(view.body().data.hidden)
    assert.lengthOf(view.body().data.aps[0].slots, 2)

    // A new passphrase goes to the AP as a secret value.
    const rekey = await api(client)
      .patch(`/api/v1/wifi/networks/${network.id}`)
      .bearerToken(env.adminToken)
      .json({ passphrase: 'a new strong passphrase' })
    rekey.assertStatus(200)
    await settled(rekey.body().data.rollout.id)
    const rekeyed = env.fake.calls.filter((c) => c.method === 'wifi.config.apply').at(-1)!
    assert.deepEqual(Object.values(rekeyed.params.secrets as object), ['a new strong passphrase'])
    assert.equal(
      env.fake.section('wireless', 'default_radio1')!.options.key,
      'a new strong passphrase'
    )
    const reveal = await api(client)
      .get(`/api/v1/wifi/networks/${network.id}/passphrase`)
      .bearerToken(env.adminToken)
    assert.equal(reveal.body().data.passphrase, 'a new strong passphrase')
    const operatorReveal = await api(client)
      .get(`/api/v1/wifi/networks/${network.id}/passphrase`)
      .bearerToken(env.operatorToken)
    operatorReveal.assertStatus(403)
  }).timeout(120_000)

  test('a failed health check rolls back and stops the rollout; retry goes through', async ({
    assert,
    client,
  }) => {
    // A window long enough for the tick's health retries (they stop 5 s before it).
    const env = await setup({ confirmMs: 20_000 })
    await toManaged(client, env)
    const network = await WifiNetwork.firstOrFail()
    env.fake.health = 'fail'
    const edit = await api(client)
      .patch(`/api/v1/wifi/networks/${network.id}`)
      .bearerToken(env.adminToken)
      .json({ isolate: true })
    edit.assertStatus(200)
    const stopped = await settled(edit.body().data.rollout.id)
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.stop?.reason, 'health_failed')
    assert.isUndefined(env.fake.section('wireless', 'default_radio0')!.options.isolate)
    const apply = await ApConfigApply.query()
      .where('ap_id', env.apId)
      .where('kind', 'apply')
      .firstOrFail()
    assert.equal(apply.state, 'rolled_back')
    assert.equal(apply.outcome?.reason, 'health_failed')
    assert.isFalse(apply.health?.ok)

    // Another rollout is refused while this one waits for the admin.
    const other = await api(client)
      .post('/api/v1/wifi/rollouts')
      .bearerToken(env.adminToken)
      .json({})
    other.assertStatus(409)
    assert.equal(other.body().error, 'rollout_running')
    const current = await api(client)
      .get('/api/v1/wifi/rollouts/current')
      .bearerToken(env.operatorToken)
    assert.equal(current.body().data.state, 'stopped')

    env.fake.health = { pending: 2 }
    const retry = await api(client)
      .post(`/api/v1/wifi/rollouts/${stopped.id}/retry`)
      .bearerToken(env.adminToken)
      .json({})
    retry.assertStatus(200)
    // The AP's health check is pending twice (a radar check): the tick retries.
    const done = await eventually(
      async () => {
        await wifiConfigTick()
        await drainPlane()
        return WifiRollout.findOrFail(stopped.id)
      },
      (r) => r.state !== 'running',
      10_000
    )
    assert.equal(done.state, 'completed')
    assert.equal(env.fake.section('wireless', 'default_radio0')!.options.isolate, '1')
  }).timeout(120_000)

  test('a LuCI edit becomes a divergence; override keeps it, revert pushes the fleet', async ({
    assert,
    client,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    env.fake.routerEdit('wireless', (sections) => {
      sections.find((s) => s.name === 'default_radio1')!.options.hidden = '1'
    })
    const divergence = await eventually(
      async () => {
        await drainPlane()
        return WifiDivergence.query().whereNull('resolved_at').first()
      },
      (d) => d !== null,
      4000
    )
    assert.equal(divergence!.kind, 'option')
    assert.equal(divergence!.option, 'hidden')
    assert.equal(divergence!.apValue, '1')
    assert.equal(divergence!.routerAuthor?.kind, 'luci')

    const list = await api(client)
      .get(`/api/v1/wifi/divergences?apId=${env.apId}`)
      .bearerToken(env.operatorToken)
    assert.lengthOf(list.body().data, 1)
    assert.includeMembers(list.body().data[0].resolutions, ['fleet', 'override', 'revert'])
    // The AP keeps its value until resolved: nothing is ahead.
    const row = await ApConfig.findOrFail(env.apId)
    assert.equal(row.fleetState, 'diverged')
    assert.equal(row.syncState, 'in_sync')

    const revert = await api(client)
      .post('/api/v1/wifi/divergences/resolve')
      .bearerToken(env.adminToken)
      .json({ items: [{ id: divergence!.id, resolution: 'revert' }] })
    revert.assertStatus(200)
    assert.deepEqual(revert.body().data.resolved, [divergence!.id])
    await settled(revert.body().data.rollout.id)
    assert.isUndefined(env.fake.section('wireless', 'default_radio1')!.options.hidden)

    env.fake.routerEdit('wireless', (sections) => {
      sections.find((s) => s.name === 'default_radio0')!.options.isolate = '1'
    })
    const second = await eventually(
      async () => {
        await drainPlane()
        return WifiDivergence.query().whereNull('resolved_at').first()
      },
      (d) => d !== null,
      4000
    )
    const override = await api(client)
      .post('/api/v1/wifi/divergences/resolve')
      .bearerToken(env.adminToken)
      .json({ items: [{ id: second!.id, resolution: 'override' }] })
    override.assertStatus(200)
    // The override is this AP's: its other radio follows.
    await settled(override.body().data.rollout.id)
    const network = await api(client).get('/api/v1/wifi/networks').bearerToken(env.adminToken)
    assert.deepEqual(network.body().data[0].aps[0].overrides, { isolate: true })
    assert.equal(env.fake.section('wireless', 'default_radio1')!.options.isolate, '1')
    assert.equal(network.body().data[0].status, 'in_sync')
    assert.lengthOf(await WifiDivergence.query().whereNull('resolved_at'), 0)
  }).timeout(120_000)

  test('radio edits: validated, one-AP rollout, apply=0 keeps a draft', async ({
    assert,
    client,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const bad = await api(client)
      .patch(`/api/v1/wifi/config/aps/${env.apId}/radios/radio1`)
      .bearerToken(env.adminToken)
      .json({ channelMode: 'fixed', channel: 13 })
    bad.assertStatus(422)
    assert.equal(bad.body().error, 'invalid_channel')

    const draft = await api(client)
      .patch(`/api/v1/wifi/config/aps/${env.apId}/radios/radio1?apply=0`)
      .bearerToken(env.adminToken)
      .json({ channelMode: 'fixed', channel: 149 })
    draft.assertStatus(200)
    assert.isNull(draft.body().data.rollout)
    assert.equal(draft.body().data.object.channel, 149)
    assert.equal(draft.body().data.object.status, 'ahead')
    assert.equal(env.fake.section('wireless', 'radio1')!.options.channel, '36')

    const radios = await api(client)
      .get(`/api/v1/wifi/radios?apId=${env.apId}`)
      .bearerToken(env.operatorToken)
    const radio1 = radios.body().data.find((r: any) => r.section === 'radio1')
    assert.equal(radio1.band, '5g')
    assert.equal(radio1.clients, 0)
    assert.isAbove(radio1.options.channels.length, 4)

    const apply = await api(client)
      .patch(`/api/v1/wifi/config/aps/${env.apId}/radios/radio1`)
      .bearerToken(env.adminToken)
      .json({ width: 40 })
    apply.assertStatus(200)
    assert.equal(apply.body().data.rollout.kind, 'radios')
    await settled(apply.body().data.rollout.id)
    assert.equal(env.fake.section('wireless', 'radio1')!.options.channel, '149')
    assert.equal(env.fake.section('wireless', 'radio1')!.options.htmode, 'HE40')
    assert.equal(env.fake.section('wireless', 'radio1')!.options.cell_density, '0')
  }).timeout(120_000)

  test('refusals: operators cannot write, managed needs the password and TLS', async ({
    assert,
    client,
  }) => {
    const env = await setup({ secure: false })
    const operator = await api(client)
      .patch(`/api/v1/wifi/config/aps/${env.apId}`)
      .bearerToken(env.operatorToken)
      .json({ mode: 'observe' })
    operator.assertStatus(403)

    const noPassword = await patchAp(client, env, { mode: 'managed' })
    noPassword.assertStatus(403)
    assert.equal(noPassword.body().error, 'invalid_password')

    const plain = await patchAp(client, env, { mode: 'managed', currentPassword: PASSWORD })
    plain.assertStatus(409)
    assert.equal(plain.body().error, 'insecure_transport')

    const list = await api(client).get('/api/v1/wifi/config/aps').bearerToken(env.operatorToken)
    assert.equal(list.body().data[0].writeBlockedReason, 'insecure_transport')
    assert.notEqual(list.body().data[0].secure, true)

    const unknown = await api(client)
      .get('/api/v1/wifi/config/aps/999')
      .bearerToken(env.operatorToken)
    unknown.assertStatus(404)
  }).timeout(120_000)

  test('settings: read, clamp, re-sent to the APs', async ({ assert, client }) => {
    const env = await setup()
    const view = await api(client).get('/api/v1/settings/wifi-config').bearerToken(env.adminToken)
    view.assertStatus(200)
    assert.equal(view.body().data.settings.confirmMode, 'agent')
    const bad = await api(client)
      .patch('/api/v1/settings/wifi-config')
      .bearerToken(env.adminToken)
      .json({ healthWaitSeconds: 5 })
    bad.assertStatus(422)
    const ok = await api(client)
      .patch('/api/v1/settings/wifi-config')
      .bearerToken(env.adminToken)
      .json({ healthWaitSeconds: 90 })
    ok.assertStatus(200)
    assert.equal(ok.body().data.settings.healthWaitSeconds, 90)
    await eventually(
      () => env.fake.configureBlock(),
      (block) => block?.healthWaitSeconds === 90,
      2000
    )
    const stored = await SystemSetting.get<Record<string, unknown>>(WIFI_CONFIG_SETTING_KEY)
    assert.equal(stored?.healthWaitSeconds, 90)
    const operator = await api(client)
      .get('/api/v1/settings/wifi-config')
      .bearerToken(env.operatorToken)
    operator.assertStatus(403)
    assert.lengthOf(await WifiIfaceLink.all(), 0)
  }).timeout(120_000)
})
