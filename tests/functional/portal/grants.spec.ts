import PortalGrant from '#models/portal_grant'
import PortalSession from '#models/portal_session'
import PortalUser from '#models/portal_user'
import {
  IOT_NET,
  MAC_A,
  MAC_B,
  bodyOf,
  outboxFirstIds,
  outboxPairs,
  call,
  resetPortalTests,
  seedGrant,
  seedPortal,
  seedPortalWorld,
  seedVoucher,
} from '#tests/helpers/portal'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

test.group('portal | grants', (group) => {
  group.each.setup(resetPortalTests)

  test('list: views with group math, filters and paging', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const p1 = await seedPortal(world.gatewayId)
    const p2 = await seedPortal(world.gatewayId, IOT_NET)
    const { voucher } = await seedVoucher(
      p1.id,
      'K7Q2M9XH4D',
      { maxDevices: 2, quotaBytes: 1_000_000_000, durationMinutes: 60 },
      {
        boundPortalId: p1.id,
        firstUsedAt: DateTime.utc().minus({ minutes: 10 }),
        expiresAt: DateTime.utc().plus({ minutes: 50 }),
        bytesUsed: 250_000_000,
      }
    )
    const vg = await seedGrant({
      portalId: p1.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
      bytesUp: 50_000_000,
      bytesDown: 200_000_000,
      ip: '192.168.20.10',
      hostname: 'phone',
    })
    const api = await seedGrant({
      portalId: p2.id,
      mac: MAC_B,
      source: 'admin',
      createdByUserId: world.adminId,
      expiresAt: DateTime.utc().plus({ minutes: 30 }),
      timeBudgetSeconds: 1800,
    })
    await seedGrant({ portalId: p1.id, mac: MAC_B, state: 'ended', endReason: 'expired' })

    const r = await call(client, 'get', '/api/v1/portal/grants', world.viewerToken)
    r.assertStatus(200)
    const { items, total } = bodyOf(r).data
    assert.equal(total, 2)
    const view = items.find((g: any) => g.id === Number(vg.id))
    assert.deepInclude(view, {
      portalId: p1.id,
      mac: MAC_A,
      ip: '192.168.20.10',
      hostname: 'phone',
      source: 'voucher',
      state: 'active',
      delivery: 'applied',
      bytesUp: 50_000_000,
      bytesDown: 200_000_000,
      portalUser: null,
      apiClient: null,
    })
    assert.deepEqual(view.voucher, { id: voucher.id, batchId: voucher.batchId, hint: 'XH4D' })
    assert.deepInclude(view.group, {
      key: `v:${voucher.id}`,
      devices: 1,
      maxDevices: 2,
      bytesUsed: 250_000_000,
      quotaBytes: 1_000_000_000,
      durationMinutes: 60,
      durationMode: 'wall_clock',
    })
    assert.equal(view.group.remaining.bytes, 750_000_000)
    assert.closeTo(view.group.remaining.seconds, 50 * 60, 5)
    const adminView = items.find((g: any) => g.id === Number(api.id))
    assert.deepEqual(adminView.createdBy, { id: world.adminId, email: 'admin@example.com' })
    assert.closeTo(adminView.group.remaining.seconds, 30 * 60, 5)

    const q = async (qs: string) =>
      bodyOf(await call(client, 'get', `/api/v1/portal/grants?${qs}`, world.adminToken)).data
    const count = async (qs: string): Promise<number> => {
      const data = await q(qs)
      return data.total
    }
    assert.equal(await count('state=all'), 3)
    assert.equal(await count('state=ended'), 1)
    assert.equal(await count(`portalId=${p2.id}`), 1)
    assert.equal(await count(`gatewayId=${world.gatewayId}&state=all`), 3)
    assert.equal(await count('mac=02-00-00-00-AA-02&state=all'), 2)
    assert.equal(await count('source=voucher'), 1)
    assert.equal(await count(`voucherId=${voucher.id}`), 1)
    const paged = await q('state=all&limit=1&offset=2')
    assert.equal(paged.total, 3)
    assert.lengthOf(paged.items, 1)

    const bad = await call(client, 'get', '/api/v1/portal/grants?mac=zz', world.adminToken)
    bad.assertStatus(422)
    assert.equal(bodyOf(bad).error, 'invalid_mac')
  })

  test('extend an API/admin grant: time moves on, quota grows, the router is told', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const deadline = DateTime.utc().plus({ minutes: 10 })
    const grant = await seedGrant({
      portalId: portal.id,
      expiresAt: deadline,
      timeBudgetSeconds: 600,
      quotaBytes: 1_000_000,
    })
    const r = await call(
      client,
      'post',
      `/api/v1/portal/grants/${grant.id}/extend`,
      world.adminToken
    ).json({
      minutes: 30,
      bytes: 4_000_000,
    })
    r.assertStatus(200)
    const { grant: view, delivery } = bodyOf(r).data
    assert.equal(delivery, 'pending')
    assert.deepInclude(view, { revision: 2, delivery: 'pending' })
    assert.equal(view.group.quotaBytes, 5_000_000)
    assert.closeTo(Date.parse(view.expiresAt) - deadline.toMillis(), 30 * 60_000, 1000)
    assert.deepEqual(await outboxFirstIds(world.gatewayId), [Number(grant.id)])

    // An expired-but-not-yet-ended deadline moves on from now.
    const late = await seedGrant({
      portalId: portal.id,
      mac: MAC_B,
      expiresAt: DateTime.utc().minus({ minutes: 5 }),
      timeBudgetSeconds: 60,
    })
    const r2 = await call(
      client,
      'post',
      `/api/v1/portal/grants/${late.id}/extend`,
      world.adminToken
    ).json({ minutes: 10 })
    assert.closeTo(Date.parse(bodyOf(r2).data.grant.expiresAt) - Date.now(), 10 * 60_000, 5000)
  })

  test('extend refusals', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const { voucher } = await seedVoucher(portal.id, 'K7Q2M9XH4D')
    const voucherGrant = await seedGrant({
      portalId: portal.id,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
    })
    const timeOnly = await seedGrant({
      portalId: portal.id,
      mac: MAC_B,
      expiresAt: DateTime.utc().plus({ hours: 1 }),
      timeBudgetSeconds: 3600,
    })
    const ended = await seedGrant({
      portalId: portal.id,
      state: 'ended',
      endReason: 'expired',
      timeBudgetSeconds: 60,
    })
    const user = await PortalUser.create({
      username: 'ana',
      password: 'ana-pass-123',
      maxDevices: 2,
    })
    const login = await seedGrant({
      portalId: portal.id,
      mac: MAC_B,
      source: 'user',
      groupKey: `u:${user.id}`,
      portalUserId: user.id,
      expiresAt: DateTime.utc().plus({ hours: 1 }),
    })

    const extend = (id: unknown, body: object) =>
      call(client, 'post', `/api/v1/portal/grants/${id}/extend`, world.adminToken).json(body)
    let r = await extend(voucherGrant.id, { minutes: 10 })
    r.assertStatus(409)
    assert.equal(bodyOf(r).error, 'grant_not_extendable')
    r = await extend(timeOnly.id, { bytes: 1000 })
    r.assertStatus(422)
    assert.deepInclude(bodyOf(r), { error: 'nothing_to_extend', field: 'bytes' })
    r = await extend(ended.id, { minutes: 10 })
    r.assertStatus(409)
    assert.equal(bodyOf(r).error, 'grant_ended')
    r = await extend(999, { minutes: 10 })
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'grant_not_found')
    r = await extend(timeOnly.id, {})
    r.assertStatus(422)
    // A portal user's login deadline can move.
    r = await extend(login.id, { minutes: 15 })
    r.assertStatus(200)
    r = await extend(login.id, { bytes: 15 })
    r.assertStatus(422)
  })

  test('revoke: the grant ends, its session closes, the next queued entitlement starts', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const grant = await seedGrant({
      portalId: portal.id,
      expiresAt: DateTime.utc().plus({ hours: 1 }),
      timeBudgetSeconds: 3600,
      bytesUp: 300,
      bytesDown: 900,
    })
    await PortalSession.create({
      grantId: grant.id,
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.20.10',
      startedAt: DateTime.utc().minus({ minutes: 5 }),
      startBytesUp: 100,
      startBytesDown: 400,
      bytesUp: 0,
      bytesDown: 0,
    })
    const { voucher } = await seedVoucher(portal.id, 'K7Q2M9XH4D', { durationMinutes: 30 })
    const queued = await seedGrant({
      portalId: portal.id,
      state: 'queued',
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
    })

    const r = await call(
      client,
      'post',
      `/api/v1/portal/grants/${grant.id}/revoke`,
      world.adminToken
    )
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.grant, { state: 'ended', endReason: 'revoked' })

    const session = await PortalSession.findByOrFail('grantId', grant.id)
    assert.isNotNull(session.endedAt)
    assert.equal(session.endReason, 'revoked')
    assert.equal(Number(session.bytesUp), 200)
    assert.equal(Number(session.bytesDown), 500)

    const next = await PortalGrant.findOrFail(queued.id)
    assert.equal(next.state, 'pending_device')
    // The voucher's first-use clock starts with the promotion.
    await voucher.refresh()
    assert.closeTo(voucher.expiresAt!.toMillis() - Date.now(), 30 * 60_000, 5000)
    assert.deepEqual(await outboxPairs(world.gatewayId), [
      ['deauthorize', [Number(grant.id)]],
      ['authorize', [Number(queued.id)]],
      ['vouchers', []],
    ])

    // Revoking an ended grant is a no-op.
    const again = await call(
      client,
      'post',
      `/api/v1/portal/grants/${grant.id}/revoke`,
      world.adminToken
    )
    again.assertStatus(200)
  })
})

test.group('portal | sessions', (group) => {
  group.each.setup(resetPortalTests)

  test('history with live bytes for open sessions, filters and range', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const grant = await seedGrant({ portalId: portal.id, bytesUp: 1000, bytesDown: 5000 })
    const closed = await PortalSession.create({
      grantId: grant.id,
      portalId: portal.id,
      mac: MAC_A,
      ip: null,
      startedAt: DateTime.utc().minus({ days: 2 }),
      endedAt: DateTime.utc().minus({ days: 2 }).plus({ hours: 1 }),
      startBytesUp: 0,
      startBytesDown: 0,
      bytesUp: 10,
      bytesDown: 20,
      endReason: 'idle',
    })
    const open = await PortalSession.create({
      grantId: grant.id,
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.20.10',
      startedAt: DateTime.utc().minus({ minutes: 5 }),
      startBytesUp: 400,
      startBytesDown: 1000,
      bytesUp: 0,
      bytesDown: 0,
    })
    const r = await call(client, 'get', '/api/v1/portal/sessions', world.operatorToken)
    r.assertStatus(200)
    const { items, total } = bodyOf(r).data
    assert.equal(total, 2)
    assert.deepEqual(items[0], {
      id: Number(open.id),
      grantId: Number(grant.id),
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.20.10',
      startedAt: items[0].startedAt,
      endedAt: null,
      bytesUp: 600,
      bytesDown: 4000,
      endReason: null,
    })
    assert.match(items[0].startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.deepInclude(items[1], {
      id: Number(closed.id),
      bytesUp: 10,
      bytesDown: 20,
      endReason: 'idle',
    })

    const recent = await call(
      client,
      'get',
      `/api/v1/portal/sessions?from=${DateTime.utc().minus({ days: 1 }).toISO()}`,
      world.operatorToken
    )
    assert.deepEqual(
      bodyOf(recent).data.items.map((s: any) => s.id),
      [Number(open.id)]
    )
    const old = await call(
      client,
      'get',
      `/api/v1/portal/sessions?to=${DateTime.utc().minus({ days: 1 }).toISO()}`,
      world.operatorToken
    )
    assert.deepEqual(
      bodyOf(old).data.items.map((s: any) => s.id),
      [Number(closed.id)]
    )
    const byMac = await call(
      client,
      'get',
      `/api/v1/portal/sessions?mac=${MAC_B}`,
      world.operatorToken
    )
    assert.equal(bodyOf(byMac).data.total, 0)
    const byGrant = await call(
      client,
      'get',
      `/api/v1/portal/sessions?grantId=${grant.id}&limit=1`,
      world.operatorToken
    )
    assert.lengthOf(bodyOf(byGrant).data.items, 1)

    const bad = await call(
      client,
      'get',
      '/api/v1/portal/sessions?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z',
      world.operatorToken
    )
    bad.assertStatus(422)
    assert.equal(bodyOf(bad).error, 'invalid_range')
    const badDate = await call(
      client,
      'get',
      '/api/v1/portal/sessions?from=yesterday',
      world.operatorToken
    )
    badDate.assertStatus(422)
    assert.equal(bodyOf(badDate).error, 'invalid_date')
  })
})
