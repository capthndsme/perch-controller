import PortalApiClient from '#models/portal_api_client'
import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import {
  IOT_NET,
  MAC_A,
  MAC_B,
  bodyOf,
  outboxFirstIds,
  outboxKinds,
  call,
  resetPortalTests,
  seedGrant,
  seedPortal,
  seedPortalWorld,
} from '#tests/helpers/portal'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

function assertStatus(response: { assertStatus(status: number): void }, status: number) {
  response.assertStatus(status)
}

test.group('portal | API clients', (group) => {
  group.each.setup(resetPortalTests)

  test('create shows the token once; only its hash is stored', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const r = await call(client, 'post', '/api/v1/portal/api-clients', world.adminToken).json({
      name: 'Coin box',
      portalIds: [portal.id, portal.id],
      scopes: ['read', 'authorize'],
      maxMinutesPerCall: 120,
    })
    r.assertStatus(201)
    assert.equal(r.header('cache-control'), 'no-store')
    const { client: created, token } = bodyOf(r).data
    assert.match(token, /^perch_pa_[A-Za-z0-9_-]{32}$/)
    assert.deepInclude(created, {
      name: 'Coin box',
      prefix: token.slice(0, 13),
      scopes: ['authorize', 'read'],
      portalIds: [portal.id],
      maxMinutesPerCall: 120,
      maxBytesPerCall: 10_000_000_000,
      maxActiveGrants: 500,
      activeGrants: 0,
      revokedAt: null,
      lastUsedAt: null,
      createdByUserId: world.adminId,
    })
    const row = await db.from('portal_api_clients').where('id', created.id).first()
    assert.notEqual(row.token_hash, token)
    assert.notInclude(JSON.stringify(row), token)

    const list = await call(client, 'get', '/api/v1/portal/api-clients', world.adminToken)
    assert.notInclude(JSON.stringify(bodyOf(list)), token)
    assert.lengthOf(bodyOf(list).data, 1)

    const bad = await call(client, 'post', '/api/v1/portal/api-clients', world.adminToken).json({
      name: 'x',
      portalIds: [999],
      scopes: ['read'],
    })
    bad.assertStatus(404)
    assert.equal(bodyOf(bad).error, 'portal_not_found')
    const noScope = await call(client, 'post', '/api/v1/portal/api-clients', world.adminToken).json(
      {
        name: 'x',
        portalIds: [portal.id],
        scopes: ['admin'],
      }
    )
    noScope.assertStatus(422)
  })

  test('patch, rotate (old token dies), revoke (grants stay)', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const p1 = await seedPortal(world.gatewayId)
    const p2 = await seedPortal(world.gatewayId, IOT_NET)
    const created = bodyOf(
      await call(client, 'post', '/api/v1/portal/api-clients', world.adminToken).json({
        name: 'Coin box',
        portalIds: [p1.id],
        scopes: ['authorize', 'read'],
      })
    ).data
    const id = created.client.id

    let r = await call(client, 'patch', `/api/v1/portal/api-clients/${id}`, world.adminToken).json({
      name: 'Lobby coin box',
      portalIds: [p2.id],
      maxActiveGrants: 10,
    })
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data, {
      name: 'Lobby coin box',
      portalIds: [p2.id],
      maxActiveGrants: 10,
    })

    const auth = (token: string) =>
      call(client, 'post', '/api/v1/portal/authorizations', token).json({
        portalId: p2.id,
        mac: MAC_A,
        minutes: 5,
      })
    assertStatus(await auth(created.token), 201)

    r = await call(client, 'post', `/api/v1/portal/api-clients/${id}/rotate`, world.adminToken)
    r.assertStatus(200)
    const rotated = bodyOf(r).data.token
    assert.notEqual(rotated, created.token)
    assertStatus(await auth(created.token), 401)
    assertStatus(await auth(rotated), 200)
    const listed = bodyOf(await call(client, 'get', '/api/v1/portal/api-clients', world.adminToken))
      .data[0]
    assert.equal(listed.activeGrants, 1)
    assert.isNotNull(listed.lastUsedAt)

    r = await call(client, 'delete', `/api/v1/portal/api-clients/${id}`, world.adminToken)
    r.assertStatus(204)
    assertStatus(await auth(rotated), 401)
    const revoked = await PortalApiClient.findOrFail(id)
    assert.isNotNull(revoked.revokedAt)
    assert.equal(
      await PortalGrant.query()
        .whereNot('state', 'ended')
        .count('* as n')
        .then((x) => Number(x[0].$extras.n)),
      1
    )

    r = await call(client, 'post', `/api/v1/portal/api-clients/${id}/rotate`, world.adminToken)
    r.assertStatus(409)
    assert.equal(bodyOf(r).error, 'api_client_revoked')
    r = await call(client, 'patch', '/api/v1/portal/api-clients/999', world.adminToken).json({
      name: 'x',
    })
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'api_client_not_found')
  })
})

test.group('portal | portal users', (group) => {
  group.each.setup(resetPortalTests)

  test('CRUD; passwords hashed and never shown', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    let r = await call(client, 'post', '/api/v1/portal/users', world.adminToken).json({
      username: 'room101',
      password: 'sunny-beach-7',
      displayName: 'Room 101',
      maxDevices: 3,
      sessionMinutes: 720,
      portalIds: [portal.id],
    })
    r.assertStatus(201)
    const user = bodyOf(r).data
    assert.deepInclude(user, {
      username: 'room101',
      displayName: 'Room 101',
      enabled: true,
      maxDevices: 3,
      sessionMinutes: 720,
      portalIds: [portal.id],
      activeDevices: 0,
    })
    assert.notProperty(user, 'password')
    const stored = await PortalUser.findOrFail(user.id)
    assert.notEqual(stored.password, 'sunny-beach-7')
    assert.isTrue(await stored.verifyPassword('sunny-beach-7'))

    r = await call(client, 'post', '/api/v1/portal/users', world.adminToken).json({
      username: 'room101',
      password: 'another-pass-1',
    })
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'username_taken')
    r = await call(client, 'post', '/api/v1/portal/users', world.adminToken).json({
      username: 'Bad Name',
      password: 'another-pass-1',
    })
    r.assertStatus(422)
    r = await call(client, 'post', '/api/v1/portal/users', world.adminToken).json({
      username: 'short',
      password: 'x',
    })
    r.assertStatus(422)
    r = await call(client, 'post', '/api/v1/portal/users', world.adminToken).json({
      username: 'guest',
      password: 'guest-pass-1',
      portalIds: [999],
    })
    r.assertStatus(404)

    r = await call(
      client,
      'put',
      `/api/v1/portal/users/${user.id}/password`,
      world.adminToken
    ).json({ password: 'rainy-hills-9' })
    r.assertStatus(204)
    await stored.refresh()
    assert.isTrue(await stored.verifyPassword('rainy-hills-9'))

    const list = await call(client, 'get', '/api/v1/portal/users', world.adminToken)
    assert.deepEqual(
      bodyOf(list).data.map((u: any) => u.username),
      ['room101']
    )
    r = await call(client, 'patch', '/api/v1/portal/users/999', world.adminToken).json({
      enabled: false,
    })
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'portal_user_not_found')
  })

  test('changing limits resends live logins; disabling or deleting ends them', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const user = await PortalUser.create({
      username: 'room102',
      password: 'room-pass-102',
      maxDevices: 2,
    })
    const g1 = await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      source: 'user',
      groupKey: `u:${user.id}`,
      portalUserId: user.id,
      expiresAt: DateTime.utc().plus({ hours: 2 }),
    })
    const g2 = await seedGrant({
      portalId: portal.id,
      mac: MAC_B,
      source: 'user',
      groupKey: `u:${user.id}`,
      portalUserId: user.id,
      state: 'paused',
    })

    let r = await call(client, 'patch', `/api/v1/portal/users/${user.id}`, world.adminToken).json({
      downKbps: 2048,
    })
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data, { downKbps: 2048, activeDevices: 2 })
    await user.refresh()
    assert.equal(user.revision, 2)
    assert.sameMembers(await outboxFirstIds(world.gatewayId), [Number(g1.id), Number(g2.id)])

    r = await call(client, 'patch', `/api/v1/portal/users/${user.id}`, world.adminToken).json({
      enabled: false,
    })
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data, { enabled: false, activeDevices: 0 })
    for (const g of [g1, g2]) {
      await g.refresh()
      assert.deepInclude(g.$attributes, { state: 'ended', endReason: 'revoked' })
    }

    const g3 = await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      source: 'user',
      groupKey: `u:${user.id}`,
      portalUserId: user.id,
    })
    r = await call(client, 'delete', `/api/v1/portal/users/${user.id}`, world.adminToken)
    r.assertStatus(204)
    await g3.refresh()
    assert.equal(g3.state, 'ended')
    assert.isNull(g3.portalUserId)
    assert.isNull(await PortalUser.find(user.id))
  })
})

test.group('portal | settings', (group) => {
  group.each.setup(resetPortalTests)

  test('read and change the tunables; gateways with portals resync', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    await seedPortal(world.gatewayId)
    let r = await call(client, 'get', '/api/v1/settings/portal', world.adminToken)
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.settings, {
      sessionRetentionDays: 30,
      offlineRedemption: true,
    })
    assert.deepEqual(bodyOf(r).data.limits.sessionRetentionDays, { min: 1, max: 730 })
    assert.equal(bodyOf(r).data.defaults.apiRequestsPerClientPerMinute, 120)

    r = await call(client, 'patch', '/api/v1/settings/portal', world.adminToken).json({
      sessionRetentionDays: 7,
      offlineRedemption: false,
    })
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.settings, {
      sessionRetentionDays: 7,
      offlineRedemption: false,
      enforceIntervalSeconds: 5,
    })
    assert.deepEqual(await outboxKinds(world.gatewayId), ['sync'])

    for (const bad of [
      { sessionRetentionDays: 0 },
      { enforceIntervalSeconds: 61 },
      { offlineRedemption: 'yes' },
      { apiRequestsPerClientPerMinute: 1.5 },
    ]) {
      r = await call(client, 'patch', '/api/v1/settings/portal', world.adminToken).json(bad)
      assert.equal(r.status(), 422, JSON.stringify(bad))
    }
  })
})
