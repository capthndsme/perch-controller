import type ApJoinToken from '#models/ap_join_token'
import hub from '#services/ap_agent_hub'
import { sha256Hex } from '#services/ap_agent_credentials'
import { FakeAgent, seedAgentAp, seedJoinToken, seedSetupComplete } from '#tests/helpers/ap_agent'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const ENDPOINT = '/api/v1/settings/ap-join-tokens'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

test.group('perch-apd settings: join tokens', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => () => {
    hub.closeAll(1000, 'test reset')
  })

  test('create returns the token once, stores only its hash and prefix', async ({
    client,
    assert,
  }) => {
    const { adminToken, adminId } = await seedSetupComplete()
    const response = await client
      .post(ENDPOINT)
      .bearerToken(adminToken)
      .json({ label: 'upstairs', expiresInHours: 24, maxUses: 3 })
    response.assertStatus(201)
    assert.equal(response.header('cache-control'), 'no-store')

    const { token, joinToken } = response.body().data
    assert.match(token, /^mlap_[0-9a-hjkmnp-tv-z]{40}$/)
    assert.equal(joinToken.prefix, token.slice(0, 9))
    assert.equal(joinToken.label, 'upstairs')
    assert.equal(joinToken.status, 'active')
    assert.equal(joinToken.useCount, 0)
    assert.equal(joinToken.maxUses, 3)
    assert.isNull(joinToken.revokedAt)
    assert.isNull(joinToken.lastUsedAt)
    assert.deepEqual(joinToken.createdBy, { id: adminId, email: 'admin@example.com' })
    const expiresInMs = DateTime.fromISO(joinToken.expiresAt).diffNow().as('hours')
    assert.approximately(expiresInMs, 24, 0.1)
    assert.notProperty(joinToken, 'token')
    assert.notProperty(joinToken, 'tokenHash')

    const row = await db.from('ap_join_tokens').where('id', joinToken.id).firstOrFail()
    assert.equal(row.token_hash, sha256Hex(token))
    assert.notInclude(row.token_encrypted, token)
  })

  test('defaults: no label, never expires, unlimited uses', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const response = await client.post(ENDPOINT).bearerToken(adminToken).json({})
    response.assertStatus(201)
    const { joinToken } = response.body().data
    assert.isNull(joinToken.label)
    assert.isNull(joinToken.expiresAt)
    assert.isNull(joinToken.maxUses)

    const invalid = await client.post(ENDPOINT).bearerToken(adminToken).json({ maxUses: 0 })
    invalid.assertStatus(422)
  })

  test('list is newest first with a status per row', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const active = await seedJoinToken({ label: 'active' })
    const expired = await seedJoinToken({
      label: 'expired',
      expiresAt: DateTime.utc().minus({ hours: 1 }),
    })
    const exhausted = await seedJoinToken({ label: 'exhausted', maxUses: 2, useCount: 2 })
    const revoked = await seedJoinToken({ label: 'revoked', revokedAt: DateTime.utc() })
    const ages: Array<[ApJoinToken, number]> = [
      [active.row, 4],
      [expired.row, 3],
      [exhausted.row, 2],
      [revoked.row, 1],
    ]
    for (const [row, hoursAgo] of ages) {
      await db
        .from('ap_join_tokens')
        .where('id', row.id)
        .update({
          created_at: DateTime.utc().minus({ hours: hoursAgo }).toFormat('yyyy-MM-dd HH:mm:ss'),
        })
    }

    const response = await client.get(ENDPOINT).bearerToken(adminToken)
    response.assertStatus(200)
    const rows = response.body().data as Array<{ label: string; status: string }>
    assert.deepEqual(
      rows.map((row) => [row.label, row.status]),
      [
        ['revoked', 'revoked'],
        ['exhausted', 'exhausted'],
        ['expired', 'expired'],
        ['active', 'active'],
      ]
    )
  })

  test('reveal shows an active token again; inactive ones are 410', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const active = await seedJoinToken()
    const revoked = await seedJoinToken({ revokedAt: DateTime.utc() })

    const shown = await client.post(`${ENDPOINT}/${active.row.id}/reveal`).bearerToken(adminToken)
    shown.assertStatus(200)
    assert.equal(shown.header('cache-control'), 'no-store')
    assert.equal(shown.body().data.token, active.token)

    const gone = await client.post(`${ENDPOINT}/${revoked.row.id}/reveal`).bearerToken(adminToken)
    gone.assertStatus(410)
    gone.assertBodyContains({ error: 'join_token_inactive' })

    const missing = await client.post(`${ENDPOINT}/999/reveal`).bearerToken(adminToken)
    missing.assertStatus(404)
    const garbage = await client.post(`${ENDPOINT}/abc/reveal`).bearerToken(adminToken)
    garbage.assertStatus(404)
  })

  test('delete revokes, is idempotent, and 404s unknown ids', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { row } = await seedJoinToken()

    const first = await client.delete(`${ENDPOINT}/${row.id}`).bearerToken(adminToken)
    first.assertStatus(204)
    await row.refresh()
    const revokedAt = row.revokedAt?.toISO()
    assert.isNotNull(revokedAt)

    const second = await client.delete(`${ENDPOINT}/${row.id}`).bearerToken(adminToken)
    second.assertStatus(204)
    await row.refresh()
    assert.equal(row.revokedAt?.toISO(), revokedAt)

    const list = await client.get(ENDPOINT).bearerToken(adminToken)
    assert.equal(list.body().data[0].status, 'revoked')

    const missing = await client.delete(`${ENDPOINT}/999`).bearerToken(adminToken)
    missing.assertStatus(404)
  })

  test('operators cannot touch tokens or install info', async ({ client }) => {
    const { operatorToken } = await seedSetupComplete()
    const list = await client.get(ENDPOINT).bearerToken(operatorToken)
    list.assertStatus(403)
    const create = await client.post(ENDPOINT).bearerToken(operatorToken).json({})
    create.assertStatus(403)
    const install = await client.get('/api/v1/settings/ap-agent/install').bearerToken(operatorToken)
    install.assertStatus(403)
  })
})

test.group('perch-apd settings: install info and agent ping', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => () => {
    hub.closeAll(1000, 'test reset')
  })

  test('install info: controller URL from the request, GitHub releases by default', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const response = await client
      .get('/api/v1/settings/ap-agent/install')
      .bearerToken(adminToken)
      .header('Host', 'metrics.example.com')
    response.assertStatus(200)
    const data = response.body().data
    assert.equal(data.controllerUrl, 'http://metrics.example.com')
    // Pinned to the perch-apd release this controller pairs with, never latest.
    assert.isString(data.apdVersion)
    assert.notEqual(data.apdVersion, 'latest')
    assert.equal(
      data.releaseBaseUrl,
      `https://github.com/capthndsme/perch-apd/releases/download/v${data.apdVersion}`
    )
    assert.equal(data.rebindDomain, 'metrics.example.com')
    assert.equal(data.installScriptUrl, `${data.releaseBaseUrl}/install.sh`)
    assert.deepEqual(
      data.assets.map((asset: { arch: string }) => asset.arch),
      ['mipsle', 'mips', 'armv7', 'armv5', 'arm64', 'amd64']
    )
    assert.deepEqual(data.assets[0], {
      arch: 'mipsle',
      file: 'perch-apd-linux-mipsle',
      label: 'MIPS little-endian',
      hint: 'MT7621, MT7628 (mipsel_24kc)',
    })
  })

  test('install info: no rebind domain when the controller is reached by address', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    for (const host of ['192.168.1.10:8080', '[fd00::10]:8080', 'localhost:3333']) {
      const response = await client
        .get('/api/v1/settings/ap-agent/install')
        .bearerToken(adminToken)
        .header('Host', host)
      response.assertStatus(200)
      assert.isNull(response.body().data.rebindDomain, host)
    }
  })

  test('ping answers with the round trip; 409 offline; 404 without an agent', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()

    const offline = await client
      .post(`/api/v1/settings/wifi-sources/${ap.id}/agent/ping`)
      .bearerToken(adminToken)
    offline.assertStatus(409)
    offline.assertBodyContains({ error: 'agent_offline' })

    const agent = await FakeAgent.connect({ agentId, agentSecret })
    const online = await client
      .post(`/api/v1/settings/wifi-sources/${ap.id}/agent/ping`)
      .bearerToken(adminToken)
    online.assertStatus(200)
    assert.equal(online.body().data.online, true)
    assert.isNumber(online.body().data.latencyMs)
    await agent.waitFor('ping')
    await agent.close()

    const noSource = await client
      .post('/api/v1/settings/wifi-sources/999/agent/ping')
      .bearerToken(adminToken)
    noSource.assertStatus(404)
    noSource.assertBodyContains({ error: 'wifi_source_not_found' })

    await db.from('wifi_access_points').where('id', ap.id).update({ agent_id: null })
    const noAgent = await client
      .post(`/api/v1/settings/wifi-sources/${ap.id}/agent/ping`)
      .bearerToken(adminToken)
    noAgent.assertStatus(404)
    noAgent.assertBodyContains({ error: 'agent_not_found' })
  })

  test('probe of an agent row goes through system.info', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()

    const offline = await client
      .post(`/api/v1/settings/wifi-sources/${ap.id}/probe`)
      .bearerToken(adminToken)
    offline.assertStatus(200)
    assert.equal(offline.body().data.probe.ok, false)
    assert.equal(offline.body().data.probe.error, 'agent offline')

    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    const probed = await client
      .post(`/api/v1/settings/wifi-sources/${ap.id}/probe`)
      .bearerToken(adminToken)
    probed.assertStatus(200)
    const { probe, source } = probed.body().data
    assert.equal(probe.ok, true)
    assert.equal(probe.model, 'Example AP 1')
    assert.equal(probe.nodename, 'ap-garage')
    assert.equal(probe.openwrtRelease, '25.12.4')
    assert.equal(source.transport, 'agent')
    assert.equal(source.agent.online, true)

    // An update keeps the admin's edit while the probe runs through the agent.
    const updated = await client
      .put(`/api/v1/settings/wifi-sources/${ap.id}`)
      .bearerToken(adminToken)
      .json({ friendlyName: 'Garage', pollIntervalSeconds: 10 })
    updated.assertStatus(200)
    assert.equal(updated.body().data.source.friendlyName, 'Garage')
    assert.equal(updated.body().data.source.pollIntervalSeconds, 10)
    assert.equal(updated.body().data.probe.ok, true)
    await agent.close()
  })
})
