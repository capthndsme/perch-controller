import PortalGrant from '#models/portal_grant'
import Voucher from '#models/voucher'
import { hashVoucherCode } from '#services/portal_keys'
import { normalizeVoucherCode } from '#services/portal/codes'
import {
  MAC_A,
  MAC_B,
  bodyOf,
  outboxKinds,
  call,
  clearOutbox,
  outbox,
  resetPortalTests,
  seedGrant,
  seedPortal,
  seedPortalWorld,
  seedVoucher,
} from '#tests/helpers/portal'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const CODE = 'K7Q2M9XH4D'

test.group('portal | voucher batches', (group) => {
  group.each.setup(resetPortalTests)

  test('create a batch: codes once, hashed and encrypted at rest, offline list queued', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const r = await call(client, 'post', '/api/v1/portal/voucher-batches', world.adminToken).json({
      portalId: portal.id,
      name: 'Day passes',
      note: 'front desk',
      count: 25,
      durationMinutes: 1440,
      quotaBytes: 5_000_000_000,
      downKbps: 10_000,
      maxDevices: 2,
      redeemBy: DateTime.utc().plus({ days: 30 }).toISO(),
    })
    r.assertStatus(201)
    assert.equal(r.header('cache-control'), 'no-store')
    const { batch, codes, delivery } = bodyOf(r).data
    assert.equal(delivery, 'pending')
    assert.lengthOf(codes, 25)
    assert.lengthOf(new Set(codes), 25)
    for (const code of codes) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    assert.deepInclude(batch, {
      portalId: portal.id,
      name: 'Day passes',
      note: 'front desk',
      count: 25,
      codeLength: 10,
      durationMinutes: 1440,
      durationMode: 'wall_clock',
      startMode: 'first_use',
      quotaBytes: 5_000_000_000,
      downKbps: 10_000,
      upKbps: null,
      maxDevices: 2,
      revokedAt: null,
    })
    assert.deepEqual(batch.createdBy, { id: world.adminId, email: 'admin@example.com' })
    assert.deepEqual(batch.counts, { unused: 25, active: 0, exhausted: 0, expired: 0, revoked: 0 })

    // At rest: the HMAC and an encrypted copy, never the code.
    const row = await db.from('vouchers').where('code_hash', hashVoucherCode(codes[0])!).first()
    assert.exists(row)
    assert.notInclude(row.code_encrypted, normalizeVoucherCode(codes[0])!)
    assert.equal(row.hint, normalizeVoucherCode(codes[0])!.slice(-4))
    assert.deepEqual(await outboxKinds(world.gatewayId), ['vouchers'])
  })

  test('start at creation fixes the clock; any-portal batches queue nothing', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const r = await call(client, 'post', '/api/v1/portal/voucher-batches', world.adminToken).json({
      portalId: null,
      name: 'Event',
      count: 2,
      codeLength: 12,
      durationMinutes: 120,
      startMode: 'creation',
    })
    r.assertStatus(201)
    const { batch, codes, delivery } = bodyOf(r).data
    assert.equal(delivery, 'applied')
    assert.match(codes[0], /^.{4}-.{4}-.{4}$/)
    const detail = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches/${batch.id}`,
      world.adminToken
    )
    const voucher = bodyOf(detail).data.vouchers[0]
    assert.isNotNull(voucher.startsAt)
    const minutes = (Date.parse(voucher.expiresAt) - Date.parse(voucher.startsAt)) / 60_000
    assert.equal(minutes, 120)
    assert.notProperty(voucher, 'code')
    assert.deepEqual(await outbox(world.gatewayId), [])
  })

  test('refusals on create', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const post = (body: object) =>
      call(client, 'post', '/api/v1/portal/voucher-batches', world.adminToken).json({
        name: 'x',
        count: 1,
        ...body,
      })
    let r = await post({})
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'no_limit')
    r = await post({ quotaBytes: 1e9, startMode: 'creation' })
    assert.equal(bodyOf(r).error, 'start_mode_requires_wall_clock')
    r = await post({ durationMinutes: 60, durationMode: 'active_time', startMode: 'creation' })
    assert.equal(bodyOf(r).error, 'start_mode_requires_wall_clock')
    r = await post({ durationMinutes: 60, redeemBy: '2020-01-01T00:00:00Z' })
    assert.equal(bodyOf(r).error, 'redeem_by_past')
    r = await post({ durationMinutes: 60, redeemBy: 'tomorrow' })
    assert.equal(bodyOf(r).error, 'invalid_date')
    r = await post({ durationMinutes: 60, portalId: 999 })
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'portal_not_found')
    for (const bad of [
      { count: 1001 },
      { count: 0 },
      { codeLength: 7 },
      { codeLength: 17 },
      { quotaBytes: 10 },
      { maxDevices: 11 },
      { downKbps: 10 },
    ]) {
      r = await post({ durationMinutes: 60, ...bad })
      assert.equal(r.status(), 422, JSON.stringify(bad))
    }
  })

  test('list and show count vouchers by status', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const used = await seedVoucher(
      portal.id,
      CODE,
      {},
      {
        firstUsedAt: DateTime.utc().minus({ minutes: 5 }),
        boundPortalId: portal.id,
        expiresAt: DateTime.utc().plus({ minutes: 55 }),
      }
    )
    await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${used.voucher.id}`,
      voucherId: used.voucher.id,
    })
    await seedVoucher(portal.id, 'ABCDEFGH23', {}, { revokedAt: DateTime.utc() })
    await seedVoucher(null, 'ZZZZ9999XX', { redeemBy: DateTime.utc().minus({ days: 1 }) })

    const list = await call(client, 'get', '/api/v1/portal/voucher-batches', world.adminToken)
    list.assertStatus(200)
    const counts = bodyOf(list).data.map((b: any) => b.counts)
    assert.sameDeepMembers(counts, [
      { unused: 0, active: 1, exhausted: 0, expired: 0, revoked: 0 },
      { unused: 0, active: 0, exhausted: 0, expired: 0, revoked: 1 },
      { unused: 0, active: 0, exhausted: 0, expired: 1, revoked: 0 },
    ])
    const filtered = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches?portalId=${portal.id}`,
      world.adminToken
    )
    assert.lengthOf(bodyOf(filtered).data, 2)

    const show = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches/${used.batch.id}`,
      world.adminToken
    )
    show.assertStatus(200)
    assert.deepInclude(bodyOf(show).data.vouchers[0], {
      id: used.voucher.id,
      hint: 'XH4D',
      status: 'active',
      boundPortalId: portal.id,
      devices: 1,
    })
    const missing = await call(
      client,
      'get',
      '/api/v1/portal/voucher-batches/999',
      world.adminToken
    )
    missing.assertStatus(404)
    assert.equal(bodyOf(missing).error, 'batch_not_found')
  })

  test('codes for printing, and CSV export', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const { batch } = await seedVoucher(null, CODE, { name: '=cmd|calc, "day"' })
    const codes = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches/${batch.id}/codes`,
      world.adminToken
    )
    codes.assertStatus(200)
    assert.equal(codes.header('cache-control'), 'no-store')
    assert.equal(bodyOf(codes).data.vouchers[0].code, 'K7Q2M-9XH4D')

    const csv = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches/${batch.id}/codes.csv`,
      world.adminToken
    )
    csv.assertStatus(200)
    assert.match(csv.header('content-type')!, /^text\/csv/)
    assert.equal(
      csv.header('content-disposition'),
      `attachment; filename="perch-vouchers-batch-${batch.id}.csv"`
    )
    assert.equal(csv.header('cache-control'), 'no-store')
    const lines = csv.text().trim().split('\r\n')
    assert.equal(
      lines[0],
      'code,hint,status,batch_id,batch_name,duration_minutes,duration_mode,quota_bytes,max_devices,redeem_by,expires_at'
    )
    // Quoted, and a formula-looking name is defused.
    assert.equal(lines[1].split(',')[0], '"K7Q2M-9XH4D"')
    assert.include(lines[1], `"'=cmd|calc, ""day"""`)

    // APP_KEY rotated since: the codes cannot be shown.
    await db.from('vouchers').update({ code_encrypted: 'garbage' })
    const gone = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches/${batch.id}/codes`,
      world.adminToken
    )
    gone.assertStatus(410)
    assert.equal(bodyOf(gone).error, 'codes_unrecoverable')
    const goneCsv = await call(
      client,
      'get',
      `/api/v1/portal/voucher-batches/${batch.id}/codes.csv`,
      world.adminToken
    )
    goneCsv.assertStatus(410)
  })

  test('revoking a batch ends its grants and promotes what each device had queued', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const { batch, voucher } = await seedVoucher(
      portal.id,
      CODE,
      {},
      {
        boundPortalId: portal.id,
        firstUsedAt: DateTime.utc(),
        expiresAt: DateTime.utc().plus({ hours: 1 }),
      }
    )
    const live = await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
    })
    const next = await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      state: 'queued',
      delivery: 'applied',
      durationMode: 'wall_clock',
      timeBudgetSeconds: 600,
      source: 'api',
    })

    const r = await call(
      client,
      'post',
      `/api/v1/portal/voucher-batches/${batch.id}/revoke`,
      world.adminToken
    )
    r.assertStatus(200)
    assert.isNotNull(bodyOf(r).data.batch.revokedAt)
    assert.equal(bodyOf(r).data.batch.counts.revoked, 1)
    assert.equal(bodyOf(r).data.delivery, 'pending')

    await live.refresh()
    await next.refresh()
    assert.deepInclude(live.$attributes, { state: 'ended', endReason: 'revoked' })
    assert.deepInclude(next.$attributes, {
      state: 'pending_device',
      delivery: 'pending',
      revision: 2,
    })
    // The queued API grant's wall clock starts at its promotion.
    assert.closeTo(next.expiresAt!.toMillis() - Date.now(), 600_000, 5_000)
    const rows = await outbox(world.gatewayId)
    assert.deepEqual(
      rows.map((x) => x.kind),
      ['deauthorize', 'authorize', 'vouchers']
    )
    assert.deepEqual(rows[0].grant_ids, [Number(live.id)])
    assert.deepEqual(rows[1].grant_ids, [Number(next.id)])
    const v = await Voucher.findOrFail(voucher.id)
    assert.equal(v.revision, 2)

    // Revoking again changes nothing.
    await clearOutbox()
    const again = await call(
      client,
      'post',
      `/api/v1/portal/voucher-batches/${batch.id}/revoke`,
      world.adminToken
    )
    again.assertStatus(200)
    assert.deepEqual(await outboxKinds(world.gatewayId), ['vouchers'])
  })

  test('delete: only never-redeemed batches', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const unused = await seedVoucher(portal.id, CODE)
    const used = await seedVoucher(portal.id, 'ABCDEFGH23', {}, { firstUsedAt: DateTime.utc() })

    let r = await call(
      client,
      'delete',
      `/api/v1/portal/voucher-batches/${used.batch.id}`,
      world.adminToken
    )
    r.assertStatus(409)
    assert.equal(bodyOf(r).error, 'batch_used')
    r = await call(
      client,
      'delete',
      `/api/v1/portal/voucher-batches/${unused.batch.id}`,
      world.adminToken
    )
    r.assertStatus(204)
    assert.isNull(await Voucher.find(unused.voucher.id))
    assert.deepEqual(await outboxKinds(world.gatewayId), ['vouchers'])
    r = await call(
      client,
      'delete',
      `/api/v1/portal/voucher-batches/${unused.batch.id}`,
      world.adminToken
    )
    r.assertStatus(404)
  })
})

test.group('portal | vouchers', (group) => {
  group.each.setup(resetPortalTests)

  test('list with filters and paging', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const p1 = await seedPortal(world.gatewayId)
    const a = await seedVoucher(p1.id, CODE)
    const b = await seedVoucher(
      null,
      'ABCDEFGH23',
      {},
      { boundPortalId: p1.id, firstUsedAt: DateTime.utc() }
    )
    const c = await seedVoucher(null, 'ZZZZ9999XX', {}, { revokedAt: DateTime.utc() })

    const all = await call(client, 'get', '/api/v1/portal/vouchers', world.adminToken)
    assert.equal(bodyOf(all).data.total, 3)
    const onPortal = await call(
      client,
      'get',
      `/api/v1/portal/vouchers?portalId=${p1.id}`,
      world.adminToken
    )
    assert.sameMembers(
      bodyOf(onPortal).data.items.map((v: any) => v.id),
      [a.voucher.id, b.voucher.id]
    )
    const revoked = await call(
      client,
      'get',
      '/api/v1/portal/vouchers?status=revoked',
      world.adminToken
    )
    assert.deepEqual(
      bodyOf(revoked).data.items.map((v: any) => v.id),
      [c.voucher.id]
    )
    const active = await call(
      client,
      'get',
      '/api/v1/portal/vouchers?status=active',
      world.adminToken
    )
    assert.deepEqual(
      bodyOf(active).data.items.map((v: any) => v.id),
      [b.voucher.id]
    )
    const paged = await call(
      client,
      'get',
      '/api/v1/portal/vouchers?limit=1&offset=1',
      world.adminToken
    )
    assert.equal(bodyOf(paged).data.total, 3)
    assert.lengthOf(bodyOf(paged).data.items, 1)
    const byBatch = await call(
      client,
      'get',
      `/api/v1/portal/vouchers?batchId=${a.batch.id}`,
      world.adminToken
    )
    assert.deepEqual(
      bodyOf(byBatch).data.items.map((v: any) => v.id),
      [a.voucher.id]
    )
    const bad = await call(client, 'get', '/api/v1/portal/vouchers?limit=5000', world.adminToken)
    bad.assertStatus(422)
  })

  test('lookup by code accepts any spelling of it', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const { voucher } = await seedVoucher(portal.id, CODE)
    await seedGrant({
      portalId: portal.id,
      mac: MAC_B,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
      state: 'ended',
      endReason: 'expired',
    })
    for (const spelling of ['K7Q2M-9XH4D', 'k7q2m 9xh4d', 'K7Q2M9XH4D']) {
      const r = await call(client, 'post', '/api/v1/portal/vouchers/lookup', world.adminToken).json(
        { code: spelling }
      )
      r.assertStatus(200)
      assert.equal(bodyOf(r).data.voucher.id, voucher.id)
      assert.lengthOf(bodyOf(r).data.grants, 1)
      assert.equal(bodyOf(r).data.grants[0].mac, MAC_B)
    }
    for (const code of ['K7Q2M9XH4E', 'not a code at all!']) {
      const r = await call(client, 'post', '/api/v1/portal/vouchers/lookup', world.adminToken).json(
        { code }
      )
      r.assertStatus(404)
      assert.equal(bodyOf(r).error, 'voucher_not_found')
    }
  })

  test('revoke one voucher: its devices are cut', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const { voucher } = await seedVoucher(
      portal.id,
      CODE,
      { maxDevices: 2 },
      { boundPortalId: portal.id, firstUsedAt: DateTime.utc() }
    )
    const g1 = await seedGrant({
      portalId: portal.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
    })
    const g2 = await seedGrant({
      portalId: portal.id,
      mac: MAC_B,
      source: 'voucher',
      groupKey: `v:${voucher.id}`,
      voucherId: voucher.id,
      state: 'paused',
    })

    const r = await call(
      client,
      'post',
      `/api/v1/portal/vouchers/${voucher.id}/revoke`,
      world.adminToken
    )
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.voucher, { status: 'revoked', devices: 0 })
    assert.equal(bodyOf(r).data.delivery, 'pending')
    for (const g of [g1, g2]) {
      const fresh = await PortalGrant.findOrFail(g.id)
      assert.deepInclude(fresh.$attributes, { state: 'ended', endReason: 'revoked' })
    }
    const rows = await outbox(world.gatewayId)
    assert.sameMembers(rows[0].grant_ids, [Number(g1.id), Number(g2.id)])

    const missing = await call(
      client,
      'post',
      '/api/v1/portal/vouchers/999/revoke',
      world.adminToken
    )
    missing.assertStatus(404)
    assert.equal(bodyOf(missing).error, 'voucher_not_found')
  })
})
