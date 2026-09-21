import WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import { AP_AGENT_FAILURE_LIMIT, _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import {
  AGENT_SUBPROTOCOL,
  DEFAULT_SYSTEM_INFO,
  FakeAgent,
  attemptHandshake,
  eventually,
  seedAgentAp,
  seedSetupComplete,
} from '#tests/helpers/ap_agent'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

test.group('ap-agent WebSocket gateway', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetApAgentRateLimits()
    return () => {
      hub.closeAll(1000, 'test reset')
      _resetApAgentRateLimits()
    }
  })

  test('missing or wrong credentials are refused with 401 before the upgrade', async ({
    assert,
  }) => {
    const { agentId } = await seedAgentAp()

    const none = await attemptHandshake({})
    assert.equal(none.status, 401)
    assert.deepInclude((none as { body: any }).body, { error: 'invalid_agent_credentials' })

    const wrong = await attemptHandshake({
      authorization: `Bearer ${agentId}.${'x'.repeat(43)}`,
    })
    assert.equal(wrong.status, 401)

    const unknown = await attemptHandshake({
      authorization: `Bearer ${'0'.repeat(32)}.${'x'.repeat(43)}`,
    })
    assert.equal(unknown.status, 401)
    assert.isFalse(hub.isOnline(1))
  })

  test('a client offering only another protocol version gets 400', async ({ assert }) => {
    const { agentId, agentSecret } = await seedAgentAp()
    const result = await attemptHandshake({
      authorization: `Bearer ${agentId}.${agentSecret}`,
      protocols: ['perch-ap.v2'],
    })
    assert.equal(result.status, 400)
    assert.deepInclude((result as { body: any }).body, { error: 'unsupported_protocol' })
  })

  test('a client offering no protocol is accepted as v1', async ({ assert }) => {
    const { agentId, agentSecret } = await seedAgentAp()
    const result = await attemptHandshake({
      authorization: `Bearer ${agentId}.${agentSecret}`,
      protocols: [],
    })
    assert.equal(result.status, 'open')
    if (result.status === 'open') result.socket.close()
  })

  test('good credentials: online, system.info asked and stored', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp({ capabilities: [] })

    const agent = await FakeAgent.connect({ agentId, agentSecret })
    assert.equal(agent.socket.protocol, AGENT_SUBPROTOCOL)
    await agent.waitFor('system.info')
    assert.isTrue(hub.isOnline(ap.id))

    const stored = await eventually(
      () => WifiAccessPoint.findOrFail(ap.id),
      (row) => (row.agentInfo?.capabilities ?? []).length > 0
    )
    assert.deepEqual(stored.agentInfo?.capabilities, DEFAULT_SYSTEM_INFO.capabilities)
    assert.equal(stored.agentInfo?.boardName, 'example,ap-1')
    assert.equal(stored.agentInfo?.target, 'ramips/mt7621')
    assert.lengthOf(stored.agentInfo?.interfaces ?? [], 1)
    assert.equal(stored.agentVersion, '0.1.0')
    assert.equal(stored.nodename, 'ap-garage')
    assert.equal(stored.model, 'Example AP 1')
    assert.equal(stored.openwrtRelease, '25.12.4')
    assert.isNotNull(stored.agentConnectedAt)
    assert.isNotNull(stored.agentLastAddress)

    const list = await client.get('/api/v1/settings/wifi-sources').bearerToken(adminToken)
    list.assertStatus(200)
    const sources = list.body().data as any[]
    const source = sources.find((row) => row.id === ap.id)
    assert.equal(source.transport, 'agent')
    assert.isNull(source.metricsUrl)
    assert.equal(source.agent.online, true)
    assert.equal(source.agent.idPrefix, agentId.slice(0, 8))
    assert.equal(source.agent.version, '0.1.0')
    assert.equal(source.agent.arch, 'mipsle')
    assert.deepEqual(source.agent.capabilities, DEFAULT_SYSTEM_INFO.capabilities)
    assert.isString(source.agent.connectedAt)
    assert.notProperty(source, 'agentSecretHash')
    assert.notProperty(source.agent, 'agentId')

    await agent.close()
    await eventually(
      () => WifiAccessPoint.findOrFail(ap.id),
      (row) => row.agentDisconnectedAt !== null
    )
    assert.isFalse(hub.isOnline(ap.id))
  })

  test('a second session with the same credentials replaces the first (4002)', async ({
    assert,
  }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const first = await FakeAgent.connect({ agentId, agentSecret })
    await first.waitFor('system.info')
    const second = await FakeAgent.connect({ agentId, agentSecret })

    const closed = await first.closed
    assert.equal(closed.code, 4002)
    await second.waitFor('system.info')
    assert.isTrue(hub.isOnline(ap.id))
    assert.isTrue(second.isOpen)

    // The replaced socket's close did not take the AP offline.
    const row = await WifiAccessPoint.findOrFail(ap.id)
    assert.isNull(row.agentDisconnectedAt)
    await second.close()
  })

  test('forgetting the agent closes its session with 4001 and kills the credentials', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')

    const response = await client
      .delete(`/api/v1/settings/wifi-sources/${ap.id}/agent`)
      .bearerToken(adminToken)
    response.assertStatus(200)
    assert.equal(response.body().data.transport, 'scrape')
    assert.isNull(response.body().data.agent)
    assert.equal(response.body().data.enabled, false)

    const closed = await agent.closed
    assert.equal(closed.code, 4001)
    const row = await WifiAccessPoint.findOrFail(ap.id)
    assert.isNull(row.agentId)
    assert.isNull(row.agentSecretHash)
    assert.equal(row.transport, 'scrape')
    assert.isFalse(Boolean(row.enabled))

    const again = await attemptHandshake({ authorization: `Bearer ${agentId}.${agentSecret}` })
    assert.equal(again.status, 401)

    const twice = await client
      .delete(`/api/v1/settings/wifi-sources/${ap.id}/agent`)
      .bearerToken(adminToken)
    twice.assertStatus(404)
    twice.assertBodyContains({ error: 'agent_not_found' })
  })

  test('forgetting an agent on a row with a metrics URL keeps it enabled', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp({ metricsUrl: 'http://192.168.1.6:9100/metrics' })
    const response = await client
      .delete(`/api/v1/settings/wifi-sources/${ap.id}/agent`)
      .bearerToken(adminToken)
    response.assertStatus(200)
    assert.equal(response.body().data.enabled, true)
    assert.equal(response.body().data.transport, 'scrape')
  })

  test('deleting the source closes its session with 4001', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')

    const response = await client
      .delete(`/api/v1/settings/wifi-sources/${ap.id}`)
      .bearerToken(adminToken)
    response.assertStatus(204)
    const closed = await agent.closed
    assert.equal(closed.code, 4001)
    assert.isFalse(hub.isOnline(ap.id))
  })

  test('requests from the agent are answered with -32601', async ({ assert }) => {
    const { agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    const reply = await agent.requestServer('whoami')
    assert.deepEqual(reply.error, { code: -32601, message: 'method not found: whoami' })
    await agent.close()
  })

  test('failed handshakes are rate-limited per address', async ({ assert }) => {
    const { agentId, agentSecret } = await seedAgentAp()
    for (let i = 0; i < AP_AGENT_FAILURE_LIMIT; i++) {
      const refused = await attemptHandshake({ authorization: 'Bearer garbage' })
      assert.equal(refused.status, 401)
    }
    const limited = await attemptHandshake({ authorization: `Bearer ${agentId}.${agentSecret}` })
    assert.equal(limited.status, 429)
    assert.isDefined((limited as { headers: any }).headers['retry-after'])
    assert.deepInclude((limited as { body: any }).body, { error: 'rate_limited' })
  })
})
