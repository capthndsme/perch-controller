import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewaySection from '#models/gateway_section'
import SystemSetting from '#models/system_setting'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetCollectorAgentState } from '#services/collector_agent'
import { _resetPollerState } from '#services/collector_poller'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { GATEWAY_CONFIG_SETTING_KEY } from '#services/gateway_config/gateway_config_settings'
import { _resetGatewaySessions } from '#services/gateway_config/gateway_registry'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { _resetRouterState } from '#services/router_metrics'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { FakeGateway, type Section } from '#tests/helpers/fake_gateway'
import { gatewaySyncConfig } from '#tests/unit/services/fixtures/gateway_sync'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * Gateway sync Phase A against the scripted gateway (docs/design/gateway-sync;
 * work packages B0 and B3): the four ambiguous port forwards of the live
 * gateway (fixture with placeholders) resolved from the API in one job
 * (owner decision D6: rename all four), the refusals of the resolve,
 * exclusion promoting the other member, the firewall `defaults` domain
 * (a protected job; REJECT/DROP needs the gateway's name) and MAC-less DNS
 * host records.
 */

const PASSWORD = 'admin-pass-123'
const NAS_MAC = '02:00:00:00:00:20'

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
      { name: 'nas', type: 'host', options: { mac: NAS_MAC, ip: '192.168.1.20', name: 'nas' } },
      {
        name: 'cfg08fe63',
        type: 'host',
        anonymous: true,
        options: { dns: '1', hostid: '10', ip: '192.168.1.5', name: 'controller-box' },
      },
    ],
    firewall: gatewaySyncConfig('firewall').sections.map(section),
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

type Env = { adminToken: string; gw: FakeGateway; gatewayId: number }

async function setup(): Promise<Env> {
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
  const gw = new FakeGateway({
    configs: routerConfigs(),
    secure: true,
    capabilities: ['gateway_stats', 'gateway_config'],
  })
  gateways.push(gw)
  await gw.connect()
  const gateway = await eventually(
    () => Gateway.findBy('collector_id', collector.id),
    (g) => g !== null
  )
  return { adminToken, gw, gatewayId: gateway!.id }
}

async function toManaged(client: any, env: Env) {
  const r = await client
    .patch(`/api/v1/gateways/${env.gatewayId}`)
    .bearerToken(env.adminToken)
    .json({ mode: 'managed', currentPassword: PASSWORD })
  r.assertStatus(200)
  await gatewayQueue.drain(env.gatewayId)
}

/** Waits until every job of the gateway is finished and confirmed. */
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

async function ambiguities(client: any, env: Env) {
  const r = await client
    .get(`/api/v1/gateways/${env.gatewayId}/ambiguities`)
    .bearerToken(env.adminToken)
  r.assertStatus(200)
  return r.body().data
}

function resolve(client: any, env: Env, body: object, query = '') {
  return client
    .post(`/api/v1/gateways/${env.gatewayId}/ambiguities/resolve${query}`)
    .bearerToken(env.adminToken)
    .json(body)
}

function redirects(gw: FakeGateway) {
  return gw.configs.firewall.filter((s) => s.type === 'redirect')
}

test.group('gateway sync | ambiguous sections', (group) => {
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

  test('the four redirects: listed, then renamed in one job; nothing else moves (D6)', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const before = redirects(env.gw).map((s) => s.name)

    const view = await ambiguities(client, env)
    assert.isTrue(view.blocksAuthoritative)
    assert.deepEqual(
      view.groups.map((g: any) => [g.key, g.members.map((m: any) => m.suggestedName)]),
      [
        ['redirect:game', ['GAME 25500-25600', 'GAME 45565']],
        ['redirect:wgx', ['WGX 63329', 'wgx 3022']],
      ]
    )
    const members = view.groups.flatMap((g: any) => g.members)
    const r = await resolve(client, env, {
      expectRevision: view.headRevision,
      items: members.map((m: any) => ({
        perchId: m.perchId,
        action: 'rename',
        name: m.suggestedName,
      })),
    })
    r.assertStatus(200)
    const data = r.body().data
    assert.sameMembers(
      data.promoted,
      members.map((m: any) => m.perchId)
    )
    assert.deepEqual(data.groups, [])
    assert.isNull(data.applyError)
    assert.deepEqual(data.apply.origin, { domains: ['firewall'] })
    await allConfirmed(env)

    const applies = await GatewayApply.query().where('gateway_id', env.gatewayId)
    assert.lengthOf(applies, 1, 'one job')
    const ops = applies[0].ops as Array<{ op: string; section: string; renameTo?: string }>
    assert.deepEqual(ops.map((o) => o.op).sort(), [
      'adopt',
      'adopt',
      'adopt',
      'adopt',
      'put',
      'put',
      'put',
      'put',
    ])
    assert.isFalse(Boolean(applies[0].protected))

    // The router: the four renamed perch_<id> with their new names, the rest untouched.
    const after = redirects(env.gw)
    const byName = (name: string) => after.find((s) => s.options.name === name)
    for (const m of members) {
      const s = byName(m.suggestedName)
      assert.exists(s, m.suggestedName)
      assert.equal(s!.name, `perch_${m.perchId}`)
    }
    assert.equal(byName('GAME 25500-25600')!.options.enabled, '0', 'still disabled')
    const untouched = before.filter((n) => !members.some((m: any) => m.section === n))
    assert.includeMembers(
      after.map((s) => s.name),
      untouched
    )

    const again = await ambiguities(client, env)
    assert.deepEqual(again.groups, [])
    assert.isFalse(again.blocksAuthoritative)
    const status = await client
      .get(`/api/v1/gateways/${env.gatewayId}/sync-status?fresh=1`)
      .bearerToken(env.adminToken)
    status.assertStatus(200)
    assert.notInclude(
      status.body().data.blockers.map((b: any) => b.code),
      'section_ambiguous'
    )
  })

  test('refusals: stale revision, incomplete group, still ambiguous, not ambiguous', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await ambiguities(client, env)
    const [game, wgx] = view.groups
    const [g1, g2] = game.members
    const expectRevision = view.headRevision

    const stale = await resolve(client, env, {
      expectRevision: expectRevision + 7,
      items: [{ perchId: g1.perchId, action: 'exclude' }],
    })
    stale.assertStatus(409)
    assert.equal(stale.body().error, 'sync_changed')
    assert.equal(stale.body().headRevision, expectRevision)

    const incomplete = await resolve(client, env, {
      expectRevision,
      items: [{ perchId: g1.perchId, action: 'rename', name: 'GAME A' }],
    })
    incomplete.assertStatus(422)
    assert.equal(incomplete.body().error, 'ambiguity_incomplete')
    assert.deepEqual(incomplete.body().missing, [g2.perchId])

    const bothKept = await resolve(client, env, {
      expectRevision,
      items: [
        { perchId: g1.perchId, action: 'keep' },
        { perchId: g2.perchId, action: 'keep' },
      ],
    })
    bothKept.assertStatus(422)
    assert.equal(bothKept.body().error, 'ambiguity_unresolved')

    const takenName = await resolve(client, env, {
      expectRevision,
      items: [
        { perchId: g1.perchId, action: 'rename', name: 'nas' },
        { perchId: g2.perchId, action: 'keep' },
      ],
    })
    takenName.assertStatus(422)
    assert.equal(takenName.body().error, 'ambiguity_unresolved', 'NAS is another forward')

    const noName = await resolve(client, env, {
      expectRevision,
      items: [
        { perchId: wgx.members[0].perchId, action: 'rename' },
        { perchId: wgx.members[1].perchId, action: 'keep' },
      ],
    })
    noName.assertStatus(422)
    assert.equal(noName.body().error, 'ambiguity_name_required')

    const synced = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('section_type', 'redirect')
      .where('scope', 'synced')
      .firstOrFail()
    const notAmbiguous = await resolve(client, env, {
      expectRevision,
      items: [{ perchId: synced.perchId, action: 'keep' }],
    })
    notAmbiguous.assertStatus(409)
    assert.equal(notAmbiguous.body().error, 'not_ambiguous')

    // Nothing was stored or sent.
    const still = await ambiguities(client, env)
    assert.lengthOf(still.groups, 2)
    assert.equal(still.headRevision, expectRevision)
    assert.lengthOf(await GatewayApply.query().where('gateway_id', env.gatewayId), 0)
  })

  test('exclude one GAME and keep the other; keep WGX, delete wgx: one job', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const view = await ambiguities(client, env)
    const [game, wgx] = view.groups
    const r = await resolve(client, env, {
      expectRevision: view.headRevision,
      items: [
        { perchId: game.members[0].perchId, action: 'exclude' },
        { perchId: game.members[1].perchId, action: 'keep' },
        { perchId: wgx.members[0].perchId, action: 'keep' },
        { perchId: wgx.members[1].perchId, action: 'delete' },
      ],
    })
    r.assertStatus(200)
    assert.deepEqual(r.body().data.excluded, [game.members[0].perchId])
    await allConfirmed(env)

    const applies = await GatewayApply.query().where('gateway_id', env.gatewayId)
    assert.lengthOf(
      applies,
      1,
      JSON.stringify(applies.map((a) => ({ kind: a.kind, ops: a.ops, perchIds: a.perchIds })))
    )
    const ops = applies[0].ops as Array<{ op: string; section: string; renameTo?: string }>
    assert.deepEqual(
      ops.map((o) => `${o.op}:${o.section}`).sort(),
      [
        `adopt:${game.members[1].section}`,
        `adopt:${wgx.members[0].section}`,
        `adopt:${wgx.members[1].section}`,
        `delete:perch_${wgx.members[1].perchId}`,
      ].sort()
    )
    const names = redirects(env.gw).map((s) => s.name)
    assert.include(names, game.members[0].section, 'the excluded one is untouched')
    assert.notInclude(names, `perch_${wgx.members[1].perchId}`)
    assert.notInclude(names, wgx.members[1].section)
    assert.isFalse(redirects(env.gw).some((s) => s.options.name === 'wgx'))

    // A later read keeps the exclusion and finds nothing ambiguous to block with.
    const refresh = await client
      .post(`/api/v1/gateways/${env.gatewayId}/refresh`)
      .bearerToken(env.adminToken)
    refresh.assertStatus(200)
    const excluded = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('perch_id', game.members[0].perchId)
      .firstOrFail()
    assert.equal(excluded.scope, 'excluded')
    assert.equal(excluded.issue, 'ambiguous')
    const again = await ambiguities(client, env)
    assert.deepEqual(again.groups, [])
    assert.isFalse(again.blocksAuthoritative)
  })

  test('excluding a member through the sections API promotes the other on the next read', async ({
    client,
    assert,
  }) => {
    const env = await setup()
    await toManaged(client, env)
    const overview = await ambiguities(client, env)
    const [game] = overview.groups
    const [g1, g2] = game.members
    const excluded = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/sections/${g1.perchId}`)
      .bearerToken(env.adminToken)
      .json({ scope: 'excluded' })
    excluded.assertStatus(200)
    const refresh = await client
      .post(`/api/v1/gateways/${env.gatewayId}/refresh`)
      .bearerToken(env.adminToken)
    refresh.assertStatus(200)
    const other = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('perch_id', g2.perchId)
      .firstOrFail()
    assert.equal(other.scope, 'synced')
    assert.isNull(other.issue)

    // Included again: a mirror, and the next read finds it ambiguous (its twin is synced).
    const included = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/sections/${g1.perchId}`)
      .bearerToken(env.adminToken)
      .json({ scope: 'synced' })
    included.assertStatus(200)
    await client.post(`/api/v1/gateways/${env.gatewayId}/refresh`).bearerToken(env.adminToken)
    const back = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('perch_id', g1.perchId)
      .firstOrFail()
    assert.equal(back.scope, 'unmodeled')
    assert.equal(back.issue, 'ambiguous')

    // A plain mirror still cannot be excluded.
    const loopbackLike = await GatewaySection.query()
      .where('gateway_id', env.gatewayId)
      .where('section_name', 'miniupnpd')
      .firstOrFail()
    const refused = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/sections/${loopbackLike.perchId}`)
      .bearerToken(env.adminToken)
      .json({ scope: 'excluded' })
    refused.assertStatus(409)
    assert.equal(refused.body().error, 'unmodeled')
  })
})

test.group('gateway sync | firewall defaults and DNS host records', (group) => {
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

  test('firewall defaults: synced on the first read; REJECT needs the name; a protected job', async ({
    client: api,
    assert,
  }) => {
    const client: any = api
    const env = await setup()
    await toManaged(client, env)
    const url = `/api/v1/gateways/${env.gatewayId}/firewall/defaults`
    const view = await client.get(url).bearerToken(env.adminToken)
    view.assertStatus(200)
    const defaults = view.body().data
    assert.deepInclude(defaults, {
      input: 'ACCEPT',
      output: 'ACCEPT',
      forward: 'ACCEPT',
      synfloodProtect: true,
      flowOffloadingHw: false,
      collectorWarning: null,
    })
    assert.equal(defaults.sync.scope, 'synced')
    assert.equal(defaults.sync.owner, 'perch')

    const invalid = await client.patch(url).bearerToken(env.adminToken).json({ input: 'ALLOW' })
    invalid.assertStatus(422)
    assert.equal(invalid.body().error, 'firewall_policy_invalid')
    const unconfirmed = await client
      .patch(url)
      .bearerToken(env.adminToken)
      .json({ input: 'REJECT' })
    unconfirmed.assertStatus(409)
    assert.equal(unconfirmed.body().error, 'firewall_defaults_confirm_required')
    assert.equal(unconfirmed.body().confirm, 'gateway')
    const mismatch = await client
      .patch(url)
      .bearerToken(env.adminToken)
      .json({ input: 'REJECT', confirm: 'router' })
    mismatch.assertStatus(422)
    assert.equal(mismatch.body().error, 'confirm_mismatch')

    const ok = await client
      .patch(url)
      .bearerToken(env.adminToken)
      .json({ input: 'REJECT', forward: 'REJECT', flowOffloadingHw: true, confirm: 'gateway' })
    ok.assertStatus(200)
    const body = ok.body().data
    assert.isTrue(body.apply.protected, 'firewall defaults ride the protected job')
    assert.include(
      body.issues.map((i: any) => i.code),
      'firewall_offloading_blinds_collector'
    )
    assert.isNotNull(body.object.collectorWarning)
    await allConfirmed(env)
    const onRouter = env.gw.configs.firewall.find((s) => s.type === 'defaults')!
    assert.deepInclude(onRouter.options, {
      input: 'REJECT',
      forward: 'REJECT',
      output: 'ACCEPT',
      flow_offloading_hw: '1',
      synflood_protect: '1',
    })
  })

  test('a MAC-less host is a DNS record of type host; publishDns and the controller warning', async ({
    client: api,
    assert,
  }) => {
    const client: any = api
    const env = await setup()
    await toManaged(client, env)
    const dns = await client
      .get(`/api/v1/gateways/${env.gatewayId}/dns`)
      .bearerToken(env.adminToken)
    dns.assertStatus(200)
    const record = dns.body().data.records.find((r: any) => r.type === 'host')
    assert.deepInclude(record, {
      type: 'host',
      name: 'controller-box',
      value: '192.168.1.5',
      publishDns: true,
      owner: 'perch',
    })
    assert.notInclude(
      dns.body().data.names.map((n: any) => n.hostname),
      'controller-box',
      'no longer listed as a reservation name'
    )
    assert.include(
      dns.body().data.names.map((n: any) => n.hostname),
      'nas'
    )

    const patched = await client
      .patch(`/api/v1/gateways/${env.gatewayId}/dns/records/${record.perchId}`)
      .bearerToken(env.adminToken)
      .json({ publishDns: false })
    patched.assertStatus(200)
    assert.include(
      patched.body().data.issues.map((i: any) => i.code),
      'dns_controller_address'
    )
    await allConfirmed(env)
    const host = env.gw.configs.dhcp.find((s) => s.options.name === 'controller-box')!
    assert.notProperty(host.options, 'dns')
    assert.equal(host.options.hostid, '10', 'router-owned options stay')
  })
})
