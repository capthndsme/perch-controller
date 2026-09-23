import PortalAuthorization from '#models/portal_authorization'
import PortalGrant from '#models/portal_grant'
import { authenticatePortalApiToken } from '#services/portal_api_clients'
import { authorizeDevice, clientPrincipal } from '#services/portal_authorize'
import { updatePortalSettings } from '#services/portal_settings'
import {
  IOT_NET,
  MAC_A,
  MAC_B,
  bodyOf,
  outboxFirstIds,
  outboxPairs,
  call,
  clearOutbox,
  outbox,
  resetPortalTests,
  seedApiClient,
  seedGrant,
  seedPortal,
  seedPortalWorld,
  seedVoucher,
} from '#tests/helpers/portal'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const AUTH = '/api/v1/portal/authorizations'

test.group('portal | authorize API (Paid Hotspot API)', (group) => {
  group.each.setup(resetPortalTests)

  test('an API client authorizes a MAC; the router is told; the call is logged', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const r = await call(client, 'post', AUTH, coin.token).json({
      portalId: portal.id,
      mac: '02-00-00-00-AA-01',
      minutes: 30,
      downKbps: 5000,
      externalRef: 'coin:0001',
      note: 'five pesos',
    })
    r.assertStatus(201)
    assert.equal(r.header('cache-control'), 'no-store')
    const { grant, delivery, outcome } = bodyOf(r).data
    assert.equal(delivery, 'pending')
    assert.equal(outcome, 'created')
    assert.deepInclude(grant, {
      portalId: portal.id,
      mac: MAC_A,
      source: 'api',
      state: 'pending_device',
      delivery: 'pending',
      externalRef: 'coin:0001',
      note: 'five pesos',
    })
    assert.deepEqual(grant.apiClient, { id: coin.id, name: 'Coin box' })
    assert.deepInclude(grant.group, {
      key: `g:${grant.id}`,
      durationMinutes: 30,
      durationMode: 'wall_clock',
      downKbps: 5000,
      maxDevices: 1,
    })
    assert.closeTo(Date.parse(grant.expiresAt) - Date.now(), 30 * 60_000, 5000)
    assert.deepEqual(await outbox(world.gatewayId), [
      { kind: 'authorize', dedupe_key: 'authorize', portal_id: null, grant_ids: [grant.id] },
    ])
    const ledger = await PortalAuthorization.findByOrFail('externalRef', 'coin:0001')
    assert.deepInclude(ledger.$attributes, {
      principal: `c:${coin.id}`,
      apiClientId: coin.id,
      outcome: 'created',
      minutes: 30,
      via: 'http',
      mac: MAC_A,
    })
  })

  test('a second coin extends the same grant; a retry with the same ref credits nothing', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const post = (body: object) =>
      call(client, 'post', AUTH, coin.token).json({ portalId: portal.id, mac: MAC_A, ...body })

    const first = bodyOf(await post({ minutes: 10, externalRef: 'c1' })).data.grant
    const second = await post({ minutes: 20, externalRef: 'c2' })
    second.assertStatus(200)
    const extended = bodyOf(second).data
    assert.equal(extended.outcome, 'extended')
    assert.equal(extended.grant.id, first.id)
    assert.equal(extended.grant.revision, 2)
    assert.equal(extended.grant.group.durationMinutes, 30)
    assert.closeTo(
      Date.parse(extended.grant.expiresAt) - Date.parse(first.expiresAt),
      20 * 60_000,
      2000
    )

    const replay = await post({ minutes: 20, externalRef: 'c2' })
    replay.assertStatus(200)
    assert.equal(bodyOf(replay).data.outcome, 'replayed')
    assert.equal(bodyOf(replay).data.grant.group.durationMinutes, 30)

    const conflict = await post({ minutes: 25, externalRef: 'c2' })
    conflict.assertStatus(409)
    assert.equal(bodyOf(conflict).error, 'idempotency_conflict')
    assert.equal(
      await PortalAuthorization.query()
        .count('* as n')
        .then((x) => Number(x[0].$extras.n)),
      2
    )

    // Bytes on a time-only grant: a separate data grant, queued behind the time (decision 23).
    const data = await post({ bytes: 500_000_000 })
    data.assertStatus(201)
    assert.deepInclude(bodyOf(data).data.grant, { state: 'queued', delivery: 'applied' })
  })

  test("mode replace ends the client's own grant and starts a new one", async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const first = bodyOf(
      await call(client, 'post', AUTH, coin.token).json({
        portalId: portal.id,
        mac: MAC_A,
        minutes: 10,
      })
    ).data.grant
    const r = await call(client, 'post', AUTH, coin.token).json({
      portalId: portal.id,
      mac: MAC_A,
      minutes: 60,
      mode: 'replace',
    })
    r.assertStatus(201)
    assert.notEqual(bodyOf(r).data.grant.id, first.id)
    const old = await PortalGrant.findOrFail(first.id)
    assert.deepInclude(old.$attributes, { state: 'ended', endReason: 'replaced' })
  })

  test('a paid wall clock waits behind a running voucher and starts with its turn', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const { voucher } = await seedVoucher(
      portal.id,
      'K7Q2M9XH4D',
      {},
      {
        boundPortalId: portal.id,
        firstUsedAt: DateTime.utc(),
        expiresAt: DateTime.utc().plus({ minutes: 20 }),
      }
    )
    await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
    })

    const r = await call(client, 'post', AUTH, coin.token).json({
      portalId: portal.id,
      mac: MAC_A,
      minutes: 15,
    })
    r.assertStatus(201)
    const grant = bodyOf(r).data.grant
    assert.deepInclude(grant, { state: 'queued', delivery: 'applied', expiresAt: null })
    assert.equal(bodyOf(r).data.delivery, 'applied')
    assert.deepEqual(await outbox(world.gatewayId), [])
    assert.equal(grant.group.remaining.seconds, 15 * 60)
  })

  test('a time grant over a running data bucket swaps it back into the queue', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const bucket = await seedGrant({ portalId: portal.id, mac: MAC_A, quotaBytes: 1_000_000_000 })
    const r = await call(client, 'post', AUTH, coin.token).json({
      portalId: portal.id,
      mac: MAC_A,
      minutes: 15,
    })
    r.assertStatus(201)
    assert.equal(bodyOf(r).data.grant.state, 'pending_device')
    await bucket.refresh()
    assert.deepInclude(bucket.$attributes, { state: 'queued', delivery: 'pending' })
    assert.deepEqual(await outboxPairs(world.gatewayId), [
      ['deauthorize', [Number(bucket.id)]],
      ['authorize', [bodyOf(r).data.grant.id]],
    ])
  })

  test('token, scope and portal checks', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const other = await seedPortal(world.gatewayId, IOT_NET)
    const reader = await seedApiClient([portal.id], ['read'])
    const writer = await seedApiClient([portal.id], ['authorize'])
    const body = { portalId: portal.id, mac: MAC_A, minutes: 5 }

    let r = await call(client, 'post', AUTH).json(body)
    r.assertStatus(401)
    assert.equal(bodyOf(r).error, 'invalid_api_token')
    r = await call(client, 'post', AUTH, 'perch_pa_' + 'x'.repeat(32)).json(body)
    r.assertStatus(401)
    r = await call(client, 'post', AUTH, 'not-a-token').json(body)
    r.assertStatus(401)

    r = await call(client, 'post', AUTH, reader.token).json(body)
    r.assertStatus(403)
    assert.deepInclude(bodyOf(r), { error: 'scope_required', scope: 'authorize' })
    r = await call(client, 'get', `${AUTH}/${MAC_A}?portalId=${portal.id}`, writer.token)
    r.assertStatus(403)
    assert.deepInclude(bodyOf(r), { error: 'scope_required', scope: 'read' })

    r = await call(client, 'post', AUTH, writer.token).json({ ...body, portalId: other.id })
    r.assertStatus(403)
    assert.equal(bodyOf(r).error, 'portal_not_allowed')
    // Not even the existence of other portals leaks.
    r = await call(client, 'post', AUTH, writer.token).json({ ...body, portalId: 999 })
    r.assertStatus(403)

    // An allowed portal that was deleted.
    portal.deletedAt = DateTime.utc()
    await portal.save()
    r = await call(client, 'post', AUTH, writer.token).json(body)
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'portal_not_found')

    // Revoked client: 401.
    const revoke = await call(
      client,
      'delete',
      `/api/v1/portal/api-clients/${writer.id}`,
      world.adminToken
    )
    revoke.assertStatus(204)
    r = await call(client, 'post', AUTH, writer.token).json({ ...body, portalId: other.id })
    r.assertStatus(401)
  })

  test('body checks and per-client caps', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id], ['authorize'], {
      maxMinutesPerCall: 60,
      maxBytesPerCall: 1_000_000_000,
      maxActiveGrants: 1,
    })
    const post = (body: object) =>
      call(client, 'post', AUTH, coin.token).json({ portalId: portal.id, mac: MAC_A, ...body })
    let r = await post({})
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'no_limit')
    r = await post({ mac: 'ff:ff:ff:ff:ff:ff', minutes: 5 })
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'invalid_mac')
    r = await post({ mac: '03:00:00:00:00:01', minutes: 5 })
    assert.equal(bodyOf(r).error, 'invalid_mac')
    r = await post({ mac: 'nope', minutes: 5 })
    r.assertStatus(422)
    r = await post({ minutes: 61 })
    r.assertStatus(422)
    assert.deepInclude(bodyOf(r), { error: 'limit_exceeded', field: 'minutes', max: 60 })
    r = await post({ bytes: 2_000_000_000 })
    assert.deepInclude(bodyOf(r), { error: 'limit_exceeded', field: 'bytes' })
    r = await post({ minutes: 5, externalRef: 'has spaces' })
    r.assertStatus(422)
    r = await post({ minutes: 5, mode: 'topup' })
    r.assertStatus(422)

    r = await post({ minutes: 5 })
    r.assertStatus(201)
    r = await post({ mac: MAC_B, minutes: 5 })
    r.assertStatus(422)
    assert.deepInclude(bodyOf(r), { error: 'too_many_active_grants', max: 1 })
    // Extending the one it holds is still fine.
    r = await post({ minutes: 5 })
    r.assertStatus(200)
  })

  test('rate limits: per token per minute, and bad tokens per address', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    await updatePortalSettings({ apiRequestsPerClientPerMinute: 10 })
    for (let i = 0; i < 10; i++) {
      const r = await call(client, 'get', `${AUTH}/${MAC_A}?portalId=${portal.id}`, coin.token)
      r.assertStatus(200)
    }
    const limited = await call(client, 'get', `${AUTH}/${MAC_A}?portalId=${portal.id}`, coin.token)
    limited.assertStatus(429)
    assert.equal(bodyOf(limited).error, 'rate_limited')
    assert.isAbove(Number(limited.header('retry-after')), 0)

    for (let i = 0; i < 20; i++) {
      await call(
        client,
        'get',
        `${AUTH}/${MAC_A}?portalId=${portal.id}`,
        'perch_pa_' + 'y'.repeat(32)
      )
    }
    const blocked = await call(
      client,
      'get',
      `${AUTH}/${MAC_A}?portalId=${portal.id}`,
      world.adminToken
    )
    blocked.assertStatus(429)
  })

  test('admin tokens work (any portal); other user tokens do not', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const r = await call(client, 'post', AUTH, world.adminToken).json({
      portalId: portal.id,
      mac: MAC_B,
      bytes: 2_000_000_000,
      externalRef: 'my-laptop',
    })
    r.assertStatus(201)
    assert.deepInclude(bodyOf(r).data.grant, { source: 'admin', apiClient: null })
    assert.deepEqual(bodyOf(r).data.grant.createdBy, {
      id: world.adminId,
      email: 'admin@example.com',
    })

    const replay = await call(client, 'post', AUTH, world.adminToken).json({
      portalId: portal.id,
      mac: MAC_B,
      bytes: 2_000_000_000,
      externalRef: 'my-laptop',
    })
    assert.equal(bodyOf(replay).data.outcome, 'replayed')

    for (const token of [world.operatorToken, world.viewerToken]) {
      const denied = await call(client, 'post', AUTH, token).json({
        portalId: portal.id,
        mac: MAC_B,
        minutes: 5,
      })
      denied.assertStatus(403)
      assert.equal(bodyOf(denied).error, 'admin_required')
    }
  })

  test("GET shows the device's current grant; a client sees only its own", async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const otherCoin = await seedApiClient([portal.id])
    await call(client, 'post', AUTH, coin.token).json({
      portalId: portal.id,
      mac: MAC_A,
      minutes: 10,
    })

    let r = await call(client, 'get', `${AUTH}/${MAC_A}?portalId=${portal.id}`, coin.token)
    r.assertStatus(200)
    assert.equal(bodyOf(r).data.grant.mac, MAC_A)
    r = await call(client, 'get', `${AUTH}/${MAC_A}?portalId=${portal.id}`, otherCoin.token)
    assert.isNull(bodyOf(r).data.grant)
    r = await call(client, 'get', `${AUTH}/${MAC_B}?portalId=${portal.id}`, world.adminToken)
    assert.isNull(bodyOf(r).data.grant)
    r = await call(client, 'get', `${AUTH}/${MAC_A}?portalId=${portal.id}`, world.adminToken)
    assert.equal(bodyOf(r).data.grant.mac, MAC_A)
    r = await call(client, 'get', `${AUTH}/${MAC_A}`, coin.token)
    r.assertStatus(422)
    r = await call(client, 'get', `${AUTH}/not-a-mac?portalId=${portal.id}`, coin.token)
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'invalid_mac')
  })

  test("DELETE ends the device's grant; nothing to end is 404", async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const otherCoin = await seedApiClient([portal.id])
    const created = bodyOf(
      await call(client, 'post', AUTH, coin.token).json({
        portalId: portal.id,
        mac: MAC_A,
        minutes: 10,
      })
    ).data.grant
    await clearOutbox()

    let r = await call(client, 'delete', `${AUTH}/${MAC_A}?portalId=${portal.id}`, otherCoin.token)
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'no_active_grant')

    r = await call(client, 'delete', `${AUTH}/${MAC_A}?portalId=${portal.id}`, coin.token)
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.grant, {
      id: created.id,
      state: 'ended',
      endReason: 'revoked',
    })
    assert.equal(bodyOf(r).data.delivery, 'pending')
    assert.deepEqual(await outboxFirstIds(world.gatewayId), [created.id])

    r = await call(client, 'delete', `${AUTH}/${MAC_A}?portalId=${portal.id}`, coin.token)
    r.assertStatus(404)
  })
})

test.group('portal | authorize API via the router relay', (group) => {
  group.each.setup(resetPortalTests)

  test("a relayed call acts only on the relaying gateway's portals and is logged as relay", async ({
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const coin = await seedApiClient([portal.id])
    const client = await authenticatePortalApiToken(coin.token)
    assert.exists(client)
    const principal = clientPrincipal(client!)
    const input = { portalId: portal.id, mac: MAC_A, minutes: 5, externalRef: 'relay-1' }

    await assert.rejects(
      () => authorizeDevice(principal, input, { via: 'relay', address: null, gatewayId: 999 }),
      /may not act on portal/
    )
    const result = await authorizeDevice(principal, input, {
      via: 'relay',
      address: '192.168.20.50',
      gatewayId: world.gatewayId,
    })
    assert.equal(result.status, 201)
    const ledger = await PortalAuthorization.findByOrFail('externalRef', 'relay-1')
    assert.deepInclude(ledger.$attributes, { via: 'relay', address: '192.168.20.50' })
    assert.isNull(await authenticatePortalApiToken('perch_pa_' + 'z'.repeat(32)))
  })
})
