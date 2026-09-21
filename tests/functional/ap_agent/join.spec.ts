import ApJoinToken from '#models/ap_join_token'
import WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import { AP_AGENT_FAILURE_LIMIT, _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { agentSecretMatches } from '#services/ap_agent_credentials'
import { FakeAgent, attemptHandshake, seedJoinToken } from '#tests/helpers/ap_agent'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const ENDPOINT = '/api/v1/ap-agent/join'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

function joinBody(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    hostname: 'ap-garage',
    model: 'Example AP 1',
    boardName: 'example,ap-1',
    release: '25.12.4',
    revision: 'r1-abcdef',
    target: 'ramips/mt7621',
    arch: 'mipsle',
    kernel: '6.12.87',
    agentVersion: '0.1.0',
    macs: ['02:00:00:00:00:10', '02:00:00:00:00:1A'],
    ...overrides,
  }
}

async function countAps() {
  const rows = await WifiAccessPoint.all()
  return rows.length
}

async function seedScrapeApWithBssid(bssid: string) {
  const ap = await WifiAccessPoint.create({
    name: 'Garage AP (node_exporter)',
    friendlyName: 'Garage',
    metricsUrl: 'http://192.168.1.6:9100/metrics',
    pollIntervalSeconds: 5,
    enabled: true,
    enableTwoWayCommands: true,
    sshHost: '192.168.1.6',
    sshPort: 22,
    sshUsername: 'root',
    sshPrivateKey: null,
    model: null,
    openwrtRelease: null,
    nodename: null,
    lastStatus: null,
    lastSeenAt: DateTime.utc(),
  })
  await db
    .insertQuery()
    .table('wifi_network_latest')
    .insert({
      ap_id: ap.id,
      ifname: 'phy0-ap0',
      ssid: 'Example',
      bssid,
      radio: 'radio0',
      channel: 6,
      frequency_mhz: 2437,
      band: '2.4',
      quality: 70,
      signal_dbm: -50,
      noise_dbm: -95,
      bitrate_kbps: 72200,
      recorded_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
  return ap
}

test.group('ap-agent join', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetApAgentRateLimits()
    return () => {
      hub.closeAll(1000, 'test reset')
      _resetApAgentRateLimits()
    }
  })

  test('a fresh AP is created with agent transport and working credentials', async ({
    client,
    assert,
  }) => {
    const { token, row } = await seedJoinToken({ label: 'garage' })

    const response = await client.post(ENDPOINT).json(joinBody(token))
    response.assertStatus(201)
    const data = response.body().data
    assert.equal(data.outcome, 'created')
    assert.match(data.agentId, /^[0-9a-f]{32}$/)
    assert.match(data.agentSecret, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(data.apName, 'ap-garage')

    const ap = await WifiAccessPoint.findOrFail(data.apId)
    assert.equal(ap.transport, 'agent')
    assert.isNull(ap.metricsUrl)
    assert.equal(ap.name, 'ap-garage')
    assert.equal(ap.nodename, 'ap-garage')
    assert.equal(ap.model, 'Example AP 1')
    assert.equal(ap.openwrtRelease, '25.12.4')
    assert.equal(ap.pollIntervalSeconds, 15)
    assert.isTrue(Boolean(ap.enabled))
    assert.equal(ap.agentId, data.agentId)
    assert.equal(ap.agentVersion, '0.1.0')
    assert.isTrue(agentSecretMatches(ap.agentSecretHash, data.agentSecret))
    assert.deepEqual(ap.agentInfo?.macs, ['02:00:00:00:00:10', '02:00:00:00:00:1a'])
    assert.deepEqual(ap.agentInfo?.capabilities, [])
    assert.equal(ap.agentInfo?.arch, 'mipsle')
    assert.equal(ap.joinTokenId, row.id)
    assert.isNotNull(ap.agentJoinedAt)

    await row.refresh()
    assert.equal(row.useCount, 1)
    assert.isNotNull(row.lastUsedAt)

    const agent = await FakeAgent.connect({ agentId: data.agentId, agentSecret: data.agentSecret })
    assert.isTrue(agent.isOpen)
    await agent.close()
  })

  test('an AP scraped today is linked by BSSID and keeps its id and settings', async ({
    client,
    assert,
  }) => {
    const existing = await seedScrapeApWithBssid('02:00:00:00:00:1a')
    const { token } = await seedJoinToken()

    const response = await client.post(ENDPOINT).json(joinBody(token))
    response.assertStatus(201)
    const data = response.body().data
    assert.equal(data.outcome, 'linked')
    assert.equal(data.apId, existing.id)
    assert.equal(data.apName, 'Garage')

    const ap = await WifiAccessPoint.findOrFail(existing.id)
    assert.equal(ap.transport, 'agent')
    assert.equal(ap.metricsUrl, 'http://192.168.1.6:9100/metrics')
    assert.equal(ap.name, 'Garage AP (node_exporter)')
    assert.equal(ap.pollIntervalSeconds, 5)
    assert.equal(ap.nodename, 'ap-garage')
    assert.equal(await countAps(), 1)
  })

  test('rejoining rotates the credentials and closes the old session with 4001', async ({
    client,
    assert,
  }) => {
    const { token } = await seedJoinToken()
    const firstResponse = await client.post(ENDPOINT).json(joinBody(token))
    const first = firstResponse.body().data
    const agent = await FakeAgent.connect({
      agentId: first.agentId,
      agentSecret: first.agentSecret,
    })
    await agent.waitFor('system.info')

    const secondResponse = await client
      .post(ENDPOINT)
      .json(joinBody(token, { macs: ['02:00:00:00:00:10'] }))
    secondResponse.assertStatus(201)
    const second = secondResponse.body().data
    assert.equal(second.outcome, 'rejoined')
    assert.equal(second.apId, first.apId)
    assert.notEqual(second.agentId, first.agentId)

    const closed = await agent.closed
    assert.equal(closed.code, 4001)

    const stale = await attemptHandshake({
      authorization: `Bearer ${first.agentId}.${first.agentSecret}`,
    })
    assert.equal(stale.status, 401)

    const fresh = await FakeAgent.connect({
      agentId: second.agentId,
      agentSecret: second.agentSecret,
    })
    assert.isTrue(fresh.isOpen)
    await fresh.close()
    assert.equal(await countAps(), 1)
  })

  test('unknown, revoked, expired and used-up tokens are refused with 401', async ({
    client,
    assert,
  }) => {
    const unknown = await client.post(ENDPOINT).json(joinBody('mlap_doesnotexist'))
    unknown.assertStatus(401)
    unknown.assertBodyContains({ error: 'invalid_join_token', message: 'Unknown join token.' })

    const revoked = await seedJoinToken({ revokedAt: DateTime.utc().minus({ minutes: 1 }) })
    const revokedResponse = await client.post(ENDPOINT).json(joinBody(revoked.token))
    revokedResponse.assertStatus(401)
    revokedResponse.assertBodyContains({ error: 'invalid_join_token' })
    assert.include(revokedResponse.body().message, 'revoked')

    const expired = await seedJoinToken({ expiresAt: DateTime.utc().minus({ minutes: 1 }) })
    const expiredResponse = await client.post(ENDPOINT).json(joinBody(expired.token))
    expiredResponse.assertStatus(401)
    assert.include(expiredResponse.body().message, 'expired')

    const single = await seedJoinToken({ maxUses: 1 })
    const used = await client.post(ENDPOINT).json(joinBody(single.token))
    used.assertStatus(201)
    const exhausted = await client
      .post(ENDPOINT)
      .json(joinBody(single.token, { hostname: 'ap-other', macs: ['02:00:00:00:00:99'] }))
    exhausted.assertStatus(401)
    assert.include(exhausted.body().message, 'used up')

    await single.row.refresh()
    assert.equal(single.row.useCount, 1)
    assert.equal(await countAps(), 1)
  })

  test('an invalid body is a 422 and counts as a failure', async ({ client, assert }) => {
    const { token } = await seedJoinToken()
    const response = await client.post(ENDPOINT).json({ token, macs: ['nope'] })
    response.assertStatus(422)
    const row = await ApJoinToken.firstOrFail()
    assert.equal(row.useCount, 0)
  })

  test('20 failures in 15 minutes get the address a 429, even with a good token', async ({
    client,
    assert,
  }) => {
    for (let i = 0; i < AP_AGENT_FAILURE_LIMIT; i++) {
      const refused = await client.post(ENDPOINT).json(joinBody(`mlap_wrong${i}`))
      refused.assertStatus(401)
    }
    const { token } = await seedJoinToken()
    const limited = await client.post(ENDPOINT).json(joinBody(token))
    limited.assertStatus(429)
    limited.assertBodyContains({ error: 'rate_limited' })
    assert.isAbove(limited.body().retryAfterSeconds, 0)
    assert.isDefined(limited.header('retry-after'))

    // The WebSocket shares the budget.
    const handshake = await attemptHandshake({ authorization: 'Bearer nope' })
    assert.equal(handshake.status, 429)

    _resetApAgentRateLimits()
    const accepted = await client.post(ENDPOINT).json(joinBody(token))
    accepted.assertStatus(201)
  })
})
