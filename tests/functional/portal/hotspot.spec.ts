import Collector from '#models/collector'
import Gateway from '#models/gateway'
import HotspotCheckout from '#models/hotspot_checkout'
import HotspotTerminal from '#models/hotspot_terminal'
import PortalGrant from '#models/portal_grant'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { apiKeyFingerprint } from '#services/collector_announce'
import {
  SocketPortalAgentSender,
  _resetPortalAgentState,
  _setPortalAgentTimings,
  isPortalGatewayReady,
} from '#services/portal_agent'
import { setPortalAgentSender } from '#services/portal_agent_sender'
import { _resetPortalGuestLimits } from '#services/portal_guest'
import { hashVoucherCode } from '#services/portal_keys'
import { prunePortalHistory } from '#services/portal_retention'
import { normalizeVoucherCode } from '#services/portal/codes'
import { signTerminalRequest } from '#services/portal/hotspot'
import { eventually } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import {
  IOT_NET,
  MAC_A,
  MAC_B,
  type PortalWorld,
  bodyOf,
  resetPortalTests,
  seedPortal,
  seedPortalWorld,
} from '#tests/helpers/portal'
import { FakePortalRouter } from '#tests/helpers/portal_router'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'

/**
 * The Paid Hotspot and click-through (docs/gateway/portal.md section 14):
 * the admin API (price tables, terminals, ledger), what `portal.configure`
 * carries, and the ingest of what the router journals (a fake router that
 * runs checkouts the way perch-collector does and signs them with its key,
 * and a fake terminal that signs its requests with its token).
 */

let world: PortalWorld
let routers: FakePortalRouter[] = []

const RATES = [
  { amount: 1, minutes: 10 },
  { amount: 5, minutes: 60, downKbps: 5000, upKbps: 2000 },
  { amount: 20, minutes: 300, downKbps: 10000, upKbps: 5000 },
]

async function linkCollector(gatewayId: number) {
  const gateway = await Gateway.findOrFail(gatewayId)
  const collector = await Collector.findOrFail(gateway.collectorId!)
  collector.merge({
    instanceId: TEST_INSTANCE_ID,
    apiKey: TEST_API_KEY,
    apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    transport: 'agent',
    lifecycle: 'adopted',
  })
  await collector.save()
}

async function connected(router?: FakePortalRouter): Promise<FakePortalRouter> {
  const r = router ?? (await FakePortalRouter.connect())
  if (!router) routers.push(r)
  await r.hello()
  await eventually(
    () => isPortalGatewayReady(world.gatewayId),
    (ready) => ready,
    5000
  )
  return r
}

type Client = ApiClient

async function seedHotspot(client: Client) {
  const table = bodyOf(
    await client
      .post('/api/v1/portal/price-tables')
      .bearerToken(world.adminToken)
      .json({ name: 'Coins', currency: 'php', entries: RATES })
  ).data
  const portal = await seedPortal(world.gatewayId)
  const patched = await client
    .patch(`/api/v1/portal/portals/${portal.id}`)
    .bearerToken(world.adminToken)
    .json({
      methods: { payment: true, clickThrough: true },
      payment: { priceTableId: table.id, idleTimeoutSeconds: 45 },
      clickThrough: { minutes: 30, windowHours: 24, perWindow: 1, terms: 'Be nice.' },
    })
  patched.assertStatus(200)
  const lobby = bodyOf(
    await client
      .post('/api/v1/portal/terminals')
      .bearerToken(world.adminToken)
      .json({ portalId: portal.id, name: 'Lobby', mac: '02-00-00-00-bb-01' })
  ).data
  return { table, portal, lobby }
}

/** Reads the router's report for a sync (portal.event → schedule). */
async function syncNow(router: FakePortalRouter) {
  const syncs = router.calls('portal.sync').length
  const authorizes = router.calls('portal.authorize').length
  const vouchers = router.calls('portal.vouchers').length
  router.collector.notifyServer('portal.event', { type: 'poke', seq: 0, at: 0, mac: '' })
  // The sync, its full authorize and the offline list after it.
  await eventually(
    () =>
      router.calls('portal.sync').length > syncs &&
      router.calls('portal.authorize').length > authorizes &&
      router.calls('portal.vouchers').length > vouchers,
    (done) => done,
    5000
  )
  await new Promise((r) => setTimeout(r, 50))
}

test.group('portal | paid hotspot', (group) => {
  group.each.setup(async () => {
    const teardown = await resetPortalTests()
    _resetPortalAgentState()
    _resetPortalGuestLimits()
    setPortalAgentSender(new SocketPortalAgentSender())
    _setPortalAgentTimings({
      callTimeoutMs: 400,
      syncTimeoutMs: 400,
      retryBaseMs: 100,
      retryMaxMs: 400,
      eventSyncDelayMs: 30,
    })
    world = await seedPortalWorld()
    await linkCollector(world.gatewayId)
    return teardown
  })
  group.each.teardown(async () => {
    for (const r of routers) await r.collector.close()
    routers = []
    _resetPortalAgentState()
    _setPortalAgentTimings()
  })

  test('price tables: create, validate, revisions, quote, in-use delete', async ({
    assert,
    client,
  }) => {
    const created = await client
      .post('/api/v1/portal/price-tables')
      .bearerToken(world.adminToken)
      .json({ name: 'Coins', currency: 'php', entries: RATES })
    created.assertStatus(201)
    const table = bodyOf(created).data
    assert.equal(table.currency, 'PHP')
    assert.equal(table.revision, 1)
    assert.deepEqual(
      table.entries.map((e: any) => e.amountText),
      ['PHP 1', 'PHP 5', 'PHP 20']
    )

    const dup = await client
      .post('/api/v1/portal/price-tables')
      .bearerToken(world.adminToken)
      .json({ name: 'Bad', currency: 'PHP', entries: [RATES[0], { ...RATES[0], minutes: 5 }] })
    dup.assertStatus(422)
    assert.equal(bodyOf(dup).error, 'duplicate_amount')
    const mixed = await client
      .post('/api/v1/portal/price-tables')
      .bearerToken(world.adminToken)
      .json({
        name: 'Bad',
        currency: 'PHP',
        entries: [RATES[0], { amount: 2, minutes: 20, quotaBytes: 5_000_000 }],
      })
    assert.equal(bodyOf(mixed).error, 'mixed_quota')
    const viewerWrite = await client
      .post('/api/v1/portal/price-tables')
      .bearerToken(world.viewerToken)
      .json({ name: 'X', currency: 'PHP', entries: RATES })
    viewerWrite.assertStatus(403)

    const quote = bodyOf(
      await client
        .post(`/api/v1/portal/price-tables/${table.id}/quote`)
        .bearerToken(world.viewerToken)
        .json({ amount: 7 })
    ).data
    assert.equal(quote.durationSeconds, 4800)
    assert.equal(quote.previewText, '1 h 20 min · 5 Mbit/s down')
    assert.equal(quote.amountText, 'PHP 7')

    const updated = bodyOf(
      await client
        .patch(`/api/v1/portal/price-tables/${table.id}`)
        .bearerToken(world.adminToken)
        .json({ entries: [{ amount: 1, minutes: 15 }] })
    ).data
    assert.equal(updated.priceTable.revision, 2)
    // An unchanged patch keeps the revision.
    const same = bodyOf(
      await client
        .patch(`/api/v1/portal/price-tables/${table.id}`)
        .bearerToken(world.adminToken)
        .json({ entries: [{ amount: 1, minutes: 15 }] })
    ).data
    assert.equal(same.priceTable.revision, 2)
    const detail = bodyOf(
      await client.get(`/api/v1/portal/price-tables/${table.id}`).bearerToken(world.viewerToken)
    ).data
    assert.deepEqual(
      detail.revisions.map((r: any) => r.revision),
      [2, 1]
    )
    assert.equal(detail.revisions[1].entries.length, 3)

    // A portal using it blocks the delete.
    const portal = await seedPortal(world.gatewayId)
    await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { payment: true }, payment: { priceTableId: table.id } })
      .then((r) => r.assertStatus(200))
    const blocked = await client
      .delete(`/api/v1/portal/price-tables/${table.id}`)
      .bearerToken(world.adminToken)
    blocked.assertStatus(409)
    assert.deepEqual(bodyOf(blocked).portalIds, [portal.id])
  })

  test('portals: the payment method needs a price table; the view carries both methods', async ({
    assert,
    client,
  }) => {
    const portal = await seedPortal(world.gatewayId, IOT_NET)
    const refused = await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { payment: true } })
    refused.assertStatus(422)
    assert.equal(bodyOf(refused).error, 'price_table_required')
    const missing = await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { payment: true }, payment: { priceTableId: 999 } })
    missing.assertStatus(404)

    const { portal: p2 } = await seedHotspot(client)
    const view = bodyOf(
      await client.get(`/api/v1/portal/portals/${p2.id}`).bearerToken(world.viewerToken)
    ).data
    assert.deepEqual(view.methods, {
      voucher: true,
      password: false,
      payment: true,
      clickThrough: true,
    })
    assert.equal(view.payment.idleTimeoutSeconds, 45)
    assert.equal(view.clickThrough.terms, 'Be nice.')
    assert.equal(view.clickThrough.perWindow, 1)
  })

  test('terminals: token once, hash only, rotate, pin, views', async ({ assert, client }) => {
    const { portal, lobby, table } = await seedHotspot(client)
    const created = await client
      .post('/api/v1/portal/terminals')
      .bearerToken(world.adminToken)
      .json({ portalId: portal.id, name: 'Cafe', priceTableId: table.id })
    created.assertStatus(201)
    assert.equal(created.header('cache-control'), 'no-store')
    const { terminal, token } = bodyOf(created).data
    assert.match(token, /^perch_pt_[A-Za-z0-9_-]{32}$/)
    assert.equal(terminal.prefix, token.slice(0, 13))
    assert.isTrue(terminal.tokenRecoverable)
    assert.equal(terminal.effectivePriceTableId, table.id)
    const row = await HotspotTerminal.findOrFail(terminal.id)
    assert.equal(row.tokenHash, createHash('sha256').update(token).digest('hex'))
    assert.equal(row.token, token)

    const list = bodyOf(
      await client
        .get(`/api/v1/portal/terminals?portalId=${portal.id}`)
        .bearerToken(world.viewerToken)
    ).data
    assert.deepEqual(
      list.map((t: any) => t.name),
      ['Cafe', 'Lobby']
    )
    assert.notProperty(list[0], 'token')
    assert.equal(list[1].mac, '02:00:00:00:bb:01')
    assert.isFalse(list[1].online)

    const rotated = bodyOf(
      await client
        .post(`/api/v1/portal/terminals/${lobby.terminal.id}/rotate`)
        .bearerToken(world.adminToken)
    ).data
    assert.notEqual(rotated.token, lobby.token)
    const badMac = await client
      .patch(`/api/v1/portal/terminals/${lobby.terminal.id}`)
      .bearerToken(world.adminToken)
      .json({ mac: 'ff:ff:ff:ff:ff:ff' })
    badMac.assertStatus(422)
    const viewer = await client
      .post('/api/v1/portal/terminals')
      .bearerToken(world.viewerToken)
      .json({ portalId: portal.id, name: 'X' })
    viewer.assertStatus(403)
    const gone = await client
      .delete(`/api/v1/portal/terminals/${terminal.id}`)
      .bearerToken(world.adminToken)
    gone.assertStatus(204)
  })

  test('portal.configure carries terminals, tokens, price tables and click-through', async ({
    assert,
    client,
  }) => {
    const { portal, lobby, table } = await seedHotspot(client)
    const router = await connected()
    const cfg = (router.calls('portal.configure')[0].params as any).portals[0]
    assert.deepEqual(cfg.methods, {
      voucher: true,
      password: false,
      payment: true,
      clickThrough: true,
    })
    assert.equal(cfg.payment.idleTimeoutSeconds, 45)
    assert.equal(cfg.payment.priceTableId, table.id)
    assert.deepEqual(cfg.payment.terminals, [
      {
        terminalId: lobby.terminal.id,
        name: 'Lobby',
        token: lobby.token,
        mac: '02:00:00:00:bb:01',
        enabled: true,
        priceTableId: null,
      },
    ])
    assert.equal(cfg.payment.priceTables[0].currency, 'PHP')
    assert.equal(cfg.payment.priceTables[0].entries.length, 3)
    assert.deepEqual(cfg.clickThrough, {
      minutes: 30,
      quotaBytes: null,
      downKbps: null,
      upKbps: null,
      windowHours: 24,
      perWindow: 1,
      terms: 'Be nice.',
    })

    // The terminal's token verifies what it signs (a fake terminal).
    const body = JSON.stringify({ nonce: 'abcdefghijklmnop' })
    const sig = signTerminalRequest(cfg.payment.terminals[0].token, {
      method: 'POST',
      path: '/portal/v1/terminal/session',
      terminalId: lobby.terminal.id,
      session: '',
      seq: 0,
      bodySha256Hex: createHash('sha256').update(body).digest('hex'),
    })
    assert.equal(
      sig,
      signTerminalRequest(lobby.token, {
        method: 'POST',
        path: '/portal/v1/terminal/session',
        terminalId: lobby.terminal.id,
        session: '',
        seq: 0,
        bodySha256Hex: createHash('sha256').update(body).digest('hex'),
      })
    )

    // A table change reaches the router at once (a new revision).
    const before = router.calls('portal.configure').length
    await client
      .patch(`/api/v1/portal/price-tables/${table.id}`)
      .bearerToken(world.adminToken)
      .json({ name: 'Coins v2' })
    await eventually(
      () => router.calls('portal.configure').length,
      (n) => n > before
    )
    const again = (router.calls('portal.configure').at(-1)!.params as any).portals[0]
    assert.equal(again.payment.priceTables[0].revision, 2)
    assert.equal(portal.id, again.portalId)
  })

  test('a finalized checkout becomes a payment voucher, a ledger row and the grant', async ({
    assert,
    client,
  }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    router.present.add(MAC_A)
    const { code, record } = router.finalizeCheckout({
      portalId: portal.id,
      terminalId: lobby.terminal.id,
      mac: MAC_A,
      amount: 7,
      checkoutRef: 'ck-0000000000000001',
      localRef: 'k1-aaaaaaaa',
      coins: [
        { eventId: 'b1-1', amount: 5, at: Date.now() - 5000 },
        { eventId: 'b1-2', amount: 1, at: Date.now() - 3000 },
        { eventId: 'b1-3', amount: 1, at: Date.now() - 1000 },
      ],
    })
    assert.equal(record.durationSeconds, 4800)
    await syncNow(router)

    const row = await HotspotCheckout.query()
      .where('checkout_ref', 'ck-0000000000000001')
      .firstOrFail()
    assert.equal(row.kind, 'payment')
    assert.equal(row.state, 'paid')
    assert.equal(Number(row.amount), 7)
    assert.equal(row.terminalId, lobby.terminal.id)
    assert.equal(row.terminalName, 'Lobby')
    assert.equal(row.coinCount, 3)
    assert.lengthOf(row.coins ?? [], 3)
    assert.equal(row.priceSnapshot?.revision, 1)
    assert.equal(row.priceSnapshot?.entries.length, 3)

    // The voucher has the code the guest was shown; its batch is a payment one.
    const voucher = await Voucher.findOrFail(row.voucherId!)
    assert.equal(voucher.code, normalizeVoucherCode(code))
    assert.equal(voucher.codeHash, hashVoucherCode(code))
    assert.equal(voucher.boundPortalId, portal.id)
    assert.isNotNull(voucher.firstUsedAt)
    assert.isNotNull(voucher.expiresAt)
    const batch = await VoucherBatch.findOrFail(voucher.batchId)
    assert.equal(batch.kind, 'payment')
    assert.equal(batch.durationMinutes, 80)
    assert.equal(batch.downKbps, 5000)
    assert.equal(batch.maxDevices, 1)
    const batches = bodyOf(
      await client.get('/api/v1/portal/voucher-batches').bearerToken(world.adminToken)
    ).data
    assert.lengthOf(batches, 0)

    // The router's grant got its id and the voucher's group.
    const grant = await PortalGrant.query().where('local_ref', 'k1-aaaaaaaa').firstOrFail()
    assert.equal(grant.source, 'voucher')
    assert.equal(grant.voucherId, voucher.id)
    const held = router.grant(MAC_A)!
    assert.equal(held.grantId, Number(grant.id))
    assert.equal(held.groupKey, `v:${voucher.id}`)
    // The router may redeem the code offline from now on.
    await eventually(
      () => router.vouchers.some((v) => v.voucherId === voucher.id),
      (x) => x
    )

    // The ledger over REST.
    const list = bodyOf(
      await client
        .get(`/api/v1/portal/checkouts?portalId=${portal.id}`)
        .bearerToken(world.viewerToken)
    ).data
    assert.equal(list.total, 1)
    assert.deepEqual(list.totals, [{ currency: 'PHP', amount: 7, count: 1 }])
    const item = list.items[0]
    assert.equal(item.amountText, 'PHP 7')
    assert.equal(item.voucher.hint, voucher.hint)
    assert.equal(item.voucher.status, 'active')
    assert.equal(item.entitlement.durationSeconds, 4800)
    assert.equal(item.reason, 'done')

    // A replay of the same journal (a lost ack) records nothing twice.
    router.events = router.events.map((e) => ({ ...e }))
    await db
      .from('portal_gateway_states')
      .where('gateway_id', world.gatewayId)
      .update({ acked_event_seq: 0 })
    await syncNow(router)
    const ledger = await HotspotCheckout.all()
    assert.lengthOf(ledger, 1)
    const mapped = await PortalGrant.query().where('local_ref', 'k1-aaaaaaaa')
    assert.lengthOf(mapped, 1)
  })

  test('the reference code moves the remaining time to a new MAC (online)', async ({
    assert,
    client,
  }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    router.present.add(MAC_A)
    const { code } = router.finalizeCheckout({
      portalId: portal.id,
      terminalId: lobby.terminal.id,
      mac: MAC_A,
      amount: 5,
      checkoutRef: 'ck-0000000000000002',
      localRef: 'k1-bbbbbbbb',
    })
    await syncNow(router)
    const first = await PortalGrant.query().where('local_ref', 'k1-bbbbbbbb').firstOrFail()

    const reply = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.30',
      code,
    })
    const result = reply.result as any
    assert.equal(result.grant.groupKey, `v:${first.voucherId}`)
    assert.equal(result.grant.mac, MAC_B)
    await first.refresh()
    assert.equal(first.state, 'ended')
    assert.equal(first.endReason, 'moved')
    // Same deadline: the remaining time moved, nothing new was minted.
    const voucher = await Voucher.findOrFail(first.voucherId!)
    assert.equal(result.group.expiresAt, voucher.expiresAt!.toMillis())
  })

  test('a code redeemed on the router before the controller knew it is reconciled', async ({
    assert,
    client,
  }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    // The controller is away while the guest pays and then changes MAC.
    await router.collector.close()
    await eventually(
      () => isPortalGatewayReady(world.gatewayId),
      (ready) => !ready
    )
    router.present.add(MAC_A)
    router.present.add(MAC_B)
    router.finalizeCheckout({
      portalId: portal.id,
      terminalId: lobby.terminal.id,
      mac: MAC_A,
      amount: 20,
      checkoutRef: 'ck-0000000000000003',
      localRef: 'k1-cccccccc',
      reason: 'timeout',
    })
    router.redeemReferenceLocally({
      portalId: portal.id,
      checkoutRef: 'ck-0000000000000003',
      oldLocalRef: 'k1-cccccccc',
      mac: MAC_B,
      localRef: 'o3-dddddddd',
    })
    await router.reconnect()
    await connected(router)

    const row = await HotspotCheckout.query()
      .where('checkout_ref', 'ck-0000000000000003')
      .firstOrFail()
    assert.equal(row.reason, 'timeout')
    const grants = await PortalGrant.query().where('voucher_id', row.voucherId!).orderBy('id')
    assert.deepEqual(
      grants.map((g) => [g.mac, g.state, g.endReason]),
      [
        [MAC_A, 'ended', 'moved'],
        [MAC_B, 'active', null],
      ]
    )
    assert.equal(router.grant(MAC_B)!.groupKey, `v:${row.voucherId}`)
    assert.isUndefined(router.grant(MAC_A))
  })

  test('a tampered record is refused: no voucher, the router drops the grant', async ({
    assert,
    client,
  }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    router.present.add(MAC_A)
    router.finalizeCheckout({
      portalId: portal.id,
      terminalId: lobby.terminal.id,
      mac: MAC_A,
      amount: 5,
      checkoutRef: 'ck-0000000000000004',
      localRef: 'k1-eeeeeeee',
      tamper: true,
    })
    await syncNow(router)
    assert.lengthOf(await HotspotCheckout.all(), 0)
    const rejected = await db.from('portal_events').where('type', 'checkout_rejected')
    assert.lengthOf(rejected, 1)
    assert.equal(JSON.parse(rejected[0].detail).reason, 'bad_signature')
    assert.isUndefined(router.grant(MAC_A))
  })

  test('void: the voucher is revoked and the device goes offline', async ({ assert, client }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    router.present.add(MAC_A)
    router.finalizeCheckout({
      portalId: portal.id,
      terminalId: lobby.terminal.id,
      mac: MAC_A,
      amount: 5,
      checkoutRef: 'ck-0000000000000005',
      localRef: 'k1-ffffffff',
    })
    await syncNow(router)
    const row = await HotspotCheckout.query().firstOrFail()
    const voided = await client
      .post(`/api/v1/portal/checkouts/${row.id}/void`)
      .bearerToken(world.adminToken)
      .json({ note: 'Refunded at the desk', refundAmount: 5 })
    voided.assertStatus(200)
    const data = bodyOf(voided).data
    assert.equal(data.checkout.state, 'voided')
    assert.equal(data.checkout.refundAmount, 5)
    assert.equal(data.checkout.voucher.status, 'revoked')
    assert.equal(data.delivery, 'applied')
    const grant = await PortalGrant.query().where('local_ref', 'k1-ffffffff').firstOrFail()
    assert.equal(grant.endReason, 'revoked')
    assert.isUndefined(router.grant(MAC_A))
    const again = await client
      .post(`/api/v1/portal/checkouts/${row.id}/void`)
      .bearerToken(world.adminToken)
      .json({})
    again.assertStatus(409)
    assert.equal(bodyOf(again).error, 'checkout_voided')
    const tooMuch = await client
      .post(`/api/v1/portal/checkouts/${row.id}/credit`)
      .bearerToken(world.adminToken)
      .json({})
    assert.equal(bodyOf(tooMuch).error, 'not_unclaimed')
  })

  test('unclaimed coins: recorded once, credited as a code, or dismissed', async ({
    assert,
    client,
  }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    for (const eventId of ['late-1', 'late-1']) {
      router.journal({
        type: 'checkout_unclaimed',
        portalId: portal.id,
        mac: '',
        terminalId: lobby.terminal.id,
        eventId,
        amount: 5,
        currency: 'PHP',
        checkoutRef: 'ck-0000000000000006',
        reason: 'late',
      })
    }
    router.journal({
      type: 'checkout_unclaimed',
      portalId: portal.id,
      mac: '',
      terminalId: lobby.terminal.id,
      eventId: '',
      amount: 3,
      currency: 'PHP',
      checkoutRef: 'ck-0000000000000007',
      reason: 'below_minimum',
    })
    await syncNow(router)
    const rows = await HotspotCheckout.query().orderBy('id')
    assert.deepEqual(
      rows.map((r) => [r.kind, r.state, Number(r.amount), r.reason]),
      [
        ['unclaimed', 'unclaimed', 5, 'late'],
        ['unclaimed', 'unclaimed', 3, 'below_minimum'],
      ]
    )

    const credited = await client
      .post(`/api/v1/portal/checkouts/${rows[0].id}/credit`)
      .bearerToken(world.adminToken)
      .json({ note: 'Coin after the window' })
    credited.assertStatus(200)
    assert.equal(credited.header('cache-control'), 'no-store')
    const { code, checkout } = bodyOf(credited).data
    assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    assert.equal(checkout.state, 'credited')
    assert.equal(checkout.entitlement.durationSeconds, 3600)
    const voucher = await Voucher.findOrFail(checkout.voucher.id)
    assert.equal(voucher.codeHash, hashVoucherCode(code))

    // Once the smallest rate is PHP 5, PHP 3 buys nothing: the admin must give minutes.
    const tables = bodyOf(
      await client.get('/api/v1/portal/price-tables').bearerToken(world.adminToken)
    ).data
    await client
      .patch(`/api/v1/portal/price-tables/${tables[0].id}`)
      .bearerToken(world.adminToken)
      .json({ entries: [{ amount: 5, minutes: 60 }] })
      .then((r) => r.assertStatus(200))
    const below = await client
      .post(`/api/v1/portal/checkouts/${rows[1].id}/credit`)
      .bearerToken(world.adminToken)
      .json({})
    below.assertStatus(422)
    assert.equal(bodyOf(below).error, 'below_minimum')
    const dismissed = await client
      .post(`/api/v1/portal/checkouts/${rows[1].id}/dismiss`)
      .bearerToken(world.adminToken)
      .json({ note: 'Returned' })
    assert.equal(bodyOf(dismissed).data.state, 'dismissed')
    const twice = await client
      .post(`/api/v1/portal/checkouts/${rows[1].id}/dismiss`)
      .bearerToken(world.adminToken)
      .json({})
    assert.equal(bodyOf(twice).error, 'already_resolved')
  })

  test('click-through grants become g: grants; the router takes the id and group', async ({
    assert,
    client,
  }) => {
    const { portal } = await seedHotspot(client)
    const router = await connected()
    router.present.add(MAC_B)
    router.clickThrough({ portalId: portal.id, mac: MAC_B, localRef: 't1-12345678', minutes: 30 })
    await syncNow(router)
    const grant = await PortalGrant.query().where('local_ref', 't1-12345678').firstOrFail()
    assert.equal(grant.source, 'clickthrough')
    assert.equal(grant.groupKey, `g:${grant.id}`)
    assert.equal(grant.timeBudgetSeconds, 1800)
    assert.equal(grant.downKbps, 1000)
    assert.isNotNull(grant.expiresAt)
    const held = router.grant(MAC_B)!
    assert.equal(held.grantId, Number(grant.id))
    assert.equal(held.groupKey, `g:${grant.id}`)
    const heldGroup = router.groups.get(`g:${grant.id}`)!
    assert.equal(heldGroup.expiresAt, grant.expiresAt!.toMillis())
    const list = bodyOf(
      await client.get(`/api/v1/portal/grants?source=clickthrough`).bearerToken(world.viewerToken)
    ).data
    assert.equal(list.total, 1)
  })

  test('portal.terminals marks terminals online; the view shows it', async ({ assert, client }) => {
    const { lobby, portal } = await seedHotspot(client)
    const router = await connected()
    router.collector.notifyServer('portal.terminals', {
      collectedAt: Date.now(),
      terminals: [
        {
          terminalId: lobby.terminal.id,
          portalId: portal.id,
          online: true,
          lastSeenAt: Date.now(),
          status: { acceptor: 'on', firmware: 'box-1.2', error: null },
          checkout: { checkoutRef: 'ck-1', state: 'open', amount: 5, openedAt: Date.now() },
        },
        { terminalId: 99999, portalId: portal.id, online: true, lastSeenAt: Date.now() },
      ],
    })
    const view = await eventually(
      async () =>
        bodyOf(
          await client
            .get(`/api/v1/portal/terminals/${lobby.terminal.id}`)
            .bearerToken(world.viewerToken)
        ).data,
      (v) => v.online
    )
    assert.equal(view.status.acceptor, 'on')
    assert.equal(view.status.firmware, 'box-1.2')
    assert.equal(view.status.checkout.amount, 5)
    assert.isNotNull(view.lastSeenAt)
  })

  test('retention clears guest data from old ledger rows, keeps the amounts', async ({
    assert,
    client,
  }) => {
    const { portal, lobby } = await seedHotspot(client)
    const router = await connected()
    router.finalizeCheckout({
      portalId: portal.id,
      terminalId: lobby.terminal.id,
      mac: MAC_A,
      amount: 5,
      checkoutRef: 'ck-0000000000000008',
      localRef: 'k1-99999999',
    })
    await syncNow(router)
    const result = await prunePortalHistory(30, new Date(Date.now() + 31 * 86_400_000))
    assert.equal(result.checkoutsAnonymized, 1)
    const row = await HotspotCheckout.query().firstOrFail()
    assert.isNull(row.mac)
    assert.isNull(row.ip)
    assert.equal(Number(row.amount), 5)
  })
})
