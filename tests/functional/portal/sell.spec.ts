import Collector from '#models/collector'
import Gateway from '#models/gateway'
import HotspotCheckout from '#models/hotspot_checkout'
import PortalGrant from '#models/portal_grant'
import User from '#models/user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { mapCheckout } from '#services/alerts/detectors/scans'
import { apiKeyFingerprint } from '#services/collector_announce'
import {
  SocketPortalAgentSender,
  _resetPortalAgentState,
  _setPortalAgentTimings,
  isPortalGatewayReady,
} from '#services/portal_agent'
import { setPortalAgentSender } from '#services/portal_agent_sender'
import { _resetPortalGuestLimits } from '#services/portal_guest'
import { moneyText } from '#services/portal/hotspot'
import { eventually } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import {
  MAC_A,
  type PortalWorld,
  bodyOf,
  resetPortalTests,
  seedPortal,
  seedPortalWorld,
} from '#tests/helpers/portal'
import { FakePortalRouter } from '#tests/helpers/portal_router'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'

/**
 * Sell Mode desk sales (docs/gateway/portal.md section 15): the Wi-Fi vendor
 * role and its route gate, the portal's desk method, selling (price lock,
 * idempotent retries), redemption of a desk code on the router, the vendor's
 * limits, the sales list and the shared payment ledger.
 */

let world: PortalWorld
let routers: FakePortalRouter[] = []
let refs = 0

const RATES = [
  { amount: 5, minutes: 60, downKbps: 5000, upKbps: 2000 },
  { amount: 1, minutes: 10 },
  { amount: 20, minutes: 300, downKbps: 10000, upKbps: 5000 },
]

const clientRef = () => `ref-${Date.now()}-${++refs}`

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

async function connected(): Promise<FakePortalRouter> {
  const r = await FakePortalRouter.connect()
  routers.push(r)
  await r.hello()
  await eventually(
    () => isPortalGatewayReady(world.gatewayId),
    (ready) => ready,
    5000
  )
  return r
}

async function vendor(email: string, patch: Partial<User> = {}) {
  const user = await User.create({
    fullName: email.split('@')[0],
    email,
    password: 'desk-pass-1234',
    role: 'wifi_vendor',
    ...patch,
  })
  const access = await User.accessTokens.create(user)
  return { user, token: access.value!.release() }
}

/** A price table and a portal that sells it at the desk (voucher entry off). */
async function seedDesk(client: ApiClient) {
  const table = bodyOf(
    await client
      .post('/api/v1/portal/price-tables')
      .bearerToken(world.adminToken)
      .json({ name: 'Desk', currency: 'php', entries: RATES })
  ).data
  const portal = await seedPortal(world.gatewayId)
  const patched = await client
    .patch(`/api/v1/portal/portals/${portal.id}`)
    .bearerToken(world.adminToken)
    .json({ methods: { voucher: false, desk: true }, desk: { priceTableId: table.id } })
  patched.assertStatus(200)
  return { table, portal }
}

function sell(
  client: ApiClient,
  token: string,
  body: { portalId: number; amount: number; priceRevision: number; clientRef?: string }
) {
  return client
    .post('/api/v1/sell/sales')
    .bearerToken(token)
    .json({ clientRef: clientRef(), ...body })
}

test.group('portal | sell mode', (group) => {
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

  test('a Wi-Fi vendor reaches Sell Mode and their account, nothing else', async ({
    assert,
    client,
  }) => {
    const invited = await client.post('/api/v1/settings/users').bearerToken(world.adminToken).json({
      fullName: 'Front desk',
      email: 'frontdesk@example.com',
      password: 'front-desk-123',
      passwordConfirmation: 'front-desk-123',
      role: 'wifi_vendor',
    })
    invited.assertStatus(201)
    assert.equal(bodyOf(invited).data.user.role, 'wifi_vendor')

    const { token } = await vendor('desk@example.com')
    const profile = await client.get('/api/v1/account/profile').bearerToken(token)
    profile.assertStatus(200)
    const menu = await client.get('/api/v1/sell').bearerToken(token)
    menu.assertStatus(200)
    for (const path of [
      '/api/v1/devices',
      '/api/v1/portal/portals',
      '/api/v1/portal/checkouts',
      '/api/v1/settings/users',
      '/api/v1/alerts/summary',
    ]) {
      const r = await client.get(path).bearerToken(token)
      assert.equal(r.status(), 403, path)
      assert.equal(bodyOf(r).error, 'role_forbidden', path)
    }
    // The Paid Hotspot API takes admin tokens only.
    const api = await client
      .post('/api/v1/portal/authorizations')
      .bearerToken(token)
      .json({ portalId: 1, mac: MAC_A, minutes: 10 })
    assert.equal(api.status(), 403)
    // Viewers and operators do not sell.
    for (const t of [world.viewerToken, world.operatorToken]) {
      const r = await client.get('/api/v1/sell').bearerToken(t)
      assert.equal(r.status(), 403)
      assert.equal(bodyOf(r).error, 'role_forbidden')
    }
    // A temporary password is changed first.
    const fresh = await vendor('new@example.com', { mustChangePassword: true })
    const blocked = await client.get('/api/v1/sell').bearerToken(fresh.token)
    assert.equal(bodyOf(blocked).error, 'password_change_required')
  })

  test('portals: the desk method needs a table, takes codes, holds its table', async ({
    assert,
    client,
  }) => {
    const table = bodyOf(
      await client
        .post('/api/v1/portal/price-tables')
        .bearerToken(world.adminToken)
        .json({ name: 'Desk', currency: 'php', entries: RATES })
    ).data
    const portal = await seedPortal(world.gatewayId)
    const noTable = await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { desk: true } })
    assert.equal(bodyOf(noTable).error, 'desk_price_table_required')
    const unknown = await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { desk: true }, desk: { priceTableId: 99999 } })
    assert.equal(bodyOf(unknown).error, 'price_table_not_found')
    const short = await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ desk: { codeLength: 6 } })
    short.assertStatus(422)

    const ok = await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { voucher: false, desk: true }, desk: { priceTableId: table.id } })
    ok.assertStatus(200)
    const view = bodyOf(ok).data.portal
    assert.isTrue(view.methods.desk)
    assert.isFalse(view.methods.voucher)
    assert.deepEqual(view.desk, { priceTableId: table.id, codeLength: 8 })

    // The router has no desk method: it sees voucher entry.
    const router = await connected()
    const cfg = (router.calls('portal.configure')[0].params as any).portals[0]
    assert.deepEqual(cfg.methods, {
      voucher: true,
      password: false,
      payment: false,
      clickThrough: false,
    })

    const del = await client
      .delete(`/api/v1/portal/price-tables/${table.id}`)
      .bearerToken(world.adminToken)
    assert.equal(bodyOf(del).error, 'price_table_in_use')
    assert.deepEqual(bodyOf(del).portalIds, [portal.id])
  })

  test('sell: menu, a sale, an idempotent retry, the price lock', async ({ assert, client }) => {
    const { table, portal } = await seedDesk(client)
    const router = await connected()
    const desk = await vendor('desk@example.com')
    const other = await vendor('other@example.com')

    const menu = bodyOf(await client.get('/api/v1/sell').bearerToken(desk.token)).data
    assert.equal(menu.seller.email, 'desk@example.com')
    assert.equal(menu.seller.role, 'wifi_vendor')
    assert.equal(menu.timezone, 'UTC')
    assert.lengthOf(menu.portals, 1)
    const p = menu.portals[0]
    assert.equal(p.id, portal.id)
    assert.isTrue(p.gatewayOnline)
    assert.equal(p.codeLength, 8)
    assert.equal(p.priceTable.revision, table.revision)
    assert.deepEqual(
      p.items.map((i: any) => i.amount),
      [1, 5, 20]
    )
    assert.equal(p.items[1].amountText, moneyText(5, 'PHP', 0))
    assert.equal(p.items[1].downKbps, 5000)

    const ref = clientRef()
    const sold = await sell(client, desk.token, {
      portalId: portal.id,
      amount: 5,
      priceRevision: table.revision,
      clientRef: ref,
    })
    sold.assertStatus(201)
    assert.equal(sold.header('cache-control'), 'no-store')
    const { sale, code, delivery } = bodyOf(sold).data
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    assert.equal(delivery, 'applied')
    assert.equal(sale.state, 'paid')
    assert.equal(sale.amount, 5)
    assert.equal(sale.item.minutes, 60)
    assert.equal(sale.item.downKbps, 5000)
    assert.equal(sale.voucher.status, 'unused')
    assert.equal(sale.voucher.hint, code.replace('-', '').slice(-4))
    assert.isTrue(sale.codeAvailable)
    assert.isTrue(sale.voidable)
    assert.equal(sale.seller.email, 'desk@example.com')

    // The ledger row and the payment voucher behind it.
    const row = await HotspotCheckout.findOrFail(sale.id)
    assert.equal(row.channel, 'desk')
    assert.equal(row.kind, 'payment')
    assert.equal(row.sellerUserId, desk.user.id)
    assert.isNull(row.terminalId)
    assert.isNull(row.mac)
    assert.equal(row.priceRevision, table.revision)
    const voucher = await Voucher.findOrFail(row.voucherId!)
    const batch = await VoucherBatch.findOrFail(voucher.batchId)
    assert.equal(batch.kind, 'payment')
    assert.equal(batch.maxDevices, 1)
    assert.equal(batch.startMode, 'first_use')
    assert.equal(batch.portalId, portal.id)
    // The router got the offline list with it.
    await eventually(
      () => router.calls('portal.vouchers').length,
      (n) => n > 0
    )

    // A retry answers with the same sale and code.
    const retry = await sell(client, desk.token, {
      portalId: portal.id,
      amount: 5,
      priceRevision: table.revision,
      clientRef: ref,
    })
    retry.assertStatus(200)
    assert.equal(bodyOf(retry).data.sale.id, sale.id)
    assert.equal(bodyOf(retry).data.code, code)
    assert.lengthOf(await HotspotCheckout.query().where('channel', 'desk'), 1)
    const stolen = await sell(client, other.token, {
      portalId: portal.id,
      amount: 5,
      priceRevision: table.revision,
      clientRef: ref,
    })
    assert.equal(bodyOf(stolen).error, 'client_ref_used')

    // Prices changed: refused with the fresh menu.
    const updated = await client
      .patch(`/api/v1/portal/price-tables/${table.id}`)
      .bearerToken(world.adminToken)
      .json({ entries: [{ amount: 5, minutes: 90 }] })
    updated.assertStatus(200)
    const stale = await sell(client, desk.token, {
      portalId: portal.id,
      amount: 5,
      priceRevision: table.revision,
    })
    stale.assertStatus(409)
    assert.equal(bodyOf(stale).error, 'price_changed')
    assert.equal(bodyOf(stale).portal.priceTable.revision, table.revision + 1)
    assert.equal(bodyOf(stale).portal.items[0].minutes, 90)
    const offMenu = await sell(client, desk.token, {
      portalId: portal.id,
      amount: 7,
      priceRevision: table.revision + 1,
    })
    assert.equal(bodyOf(offMenu).error, 'not_on_menu')

    // Desk sales off.
    await client
      .patch(`/api/v1/portal/portals/${portal.id}`)
      .bearerToken(world.adminToken)
      .json({ methods: { desk: false, voucher: true } })
    const off = await sell(client, desk.token, {
      portalId: portal.id,
      amount: 5,
      priceRevision: table.revision + 1,
    })
    assert.equal(bodyOf(off).error, 'desk_sales_off')
    assert.lengthOf(
      bodyOf(await client.get('/api/v1/sell').bearerToken(desk.token)).data.portals,
      0
    )
  })

  test('a desk code signs a guest in; after that only an admin shows or voids it', async ({
    assert,
    client,
  }) => {
    const { table, portal } = await seedDesk(client)
    const router = await connected()
    const desk = await vendor('desk@example.com')
    const { sale, code } = bodyOf(
      await sell(client, desk.token, {
        portalId: portal.id,
        amount: 5,
        priceRevision: table.revision,
      })
    ).data

    // Before use the vendor can show the code again.
    const again = await client.get(`/api/v1/sell/sales/${sale.id}/code`).bearerToken(desk.token)
    again.assertStatus(200)
    assert.equal(bodyOf(again).data.code, code)

    router.present.add(MAC_A)
    const reply = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.30.10',
      code: code.toLowerCase(),
    })
    const result = reply.result as any
    const grant = await PortalGrant.query().where('mac', MAC_A).firstOrFail()
    assert.equal(result.grant.groupKey, `v:${grant.voucherId}`)

    const list = bodyOf(await client.get('/api/v1/sell/sales').bearerToken(desk.token)).data
    assert.equal(list.items[0].voucher.status, 'active')
    assert.isFalse(list.items[0].codeAvailable)
    assert.isFalse(list.items[0].voidable)
    const used = await client.get(`/api/v1/sell/sales/${sale.id}/code`).bearerToken(desk.token)
    assert.equal(bodyOf(used).error, 'code_used')
    const vendorVoid = await client
      .post(`/api/v1/sell/sales/${sale.id}/void`)
      .bearerToken(desk.token)
      .json({ refundAmount: 5 })
    assert.equal(bodyOf(vendorVoid).error, 'sale_used')

    const adminCode = await client
      .get(`/api/v1/sell/sales/${sale.id}/code`)
      .bearerToken(world.adminToken)
    assert.equal(bodyOf(adminCode).data.code, code)
    const voided = await client
      .post(`/api/v1/sell/sales/${sale.id}/void`)
      .bearerToken(world.adminToken)
      .json({ refundAmount: 5, note: 'Wrong plan' })
    voided.assertStatus(200)
    const data = bodyOf(voided).data
    assert.equal(data.sale.state, 'voided')
    assert.equal(data.sale.refundAmount, 5)
    assert.equal(data.sale.voidedBy.email, 'admin@example.com')
    assert.equal(data.delivery, 'applied')
    await grant.refresh()
    assert.equal(grant.endReason, 'revoked')
    const twice = await client
      .post(`/api/v1/sell/sales/${sale.id}/void`)
      .bearerToken(world.adminToken)
      .json({})
    assert.equal(bodyOf(twice).error, 'sale_voided')
  })

  test('sales list: a vendor sees their own, an admin everyone; totals skip voids', async ({
    assert,
    client,
  }) => {
    const { table, portal } = await seedDesk(client)
    const a = await vendor('a@example.com')
    const b = await vendor('b@example.com')
    const order = { portalId: portal.id, priceRevision: table.revision }
    const a1 = bodyOf(await sell(client, a.token, { ...order, amount: 5 })).data.sale
    await sell(client, a.token, { ...order, amount: 20 })
    const b1 = bodyOf(await sell(client, b.token, { ...order, amount: 1 })).data.sale
    const adminSale = bodyOf(await sell(client, world.adminToken, { ...order, amount: 1 })).data
      .sale
    assert.equal(adminSale.seller.email, 'admin@example.com')

    // A vendor voids an unused sale of their own.
    const voided = await client
      .post(`/api/v1/sell/sales/${a1.id}/void`)
      .bearerToken(a.token)
      .json({ refundAmount: 5 })
    voided.assertStatus(200)
    assert.equal(bodyOf(voided).data.sale.voucher.status, 'revoked')

    const mine = bodyOf(
      await client.get(`/api/v1/sell/sales?sellerId=${b.user.id}`).bearerToken(a.token)
    ).data
    assert.equal(mine.total, 2)
    assert.deepEqual(
      mine.items.map((s: any) => s.seller.email),
      ['a@example.com', 'a@example.com']
    )
    assert.deepEqual(mine.totals, [{ currency: 'PHP', amount: 20, count: 1 }])
    assert.equal(mine.timezone, 'UTC')
    assert.match(mine.range.from, /T00:00:00\.000Z$/)

    const all = bodyOf(await client.get('/api/v1/sell/sales').bearerToken(world.adminToken)).data
    assert.equal(all.total, 4)
    assert.deepEqual(all.totals, [{ currency: 'PHP', amount: 22, count: 3 }])
    const onlyB = bodyOf(
      await client.get(`/api/v1/sell/sales?sellerId=${b.user.id}`).bearerToken(world.adminToken)
    ).data
    assert.equal(onlyB.total, 1)
    const voids = bodyOf(
      await client.get('/api/v1/sell/sales?state=voided').bearerToken(world.adminToken)
    ).data
    assert.equal(voids.total, 1)

    // Another vendor's sale does not exist for a vendor.
    const foreign = await client.get(`/api/v1/sell/sales/${b1.id}/code`).bearerToken(a.token)
    assert.equal(bodyOf(foreign).error, 'sale_not_found')
    const foreignVoid = await client
      .post(`/api/v1/sell/sales/${b1.id}/void`)
      .bearerToken(a.token)
      .json({})
    assert.equal(bodyOf(foreignVoid).error, 'sale_not_found')
    const past = bodyOf(
      await client
        .get('/api/v1/sell/sales?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z')
        .bearerToken(world.adminToken)
    ).data
    assert.equal(past.total, 0)
  })

  test('the payment ledger shows desk sales with their seller; the alert says desk', async ({
    assert,
    client,
  }) => {
    const { table, portal } = await seedDesk(client)
    const desk = await vendor('desk@example.com')
    await sell(client, desk.token, {
      portalId: portal.id,
      amount: 5,
      priceRevision: table.revision,
    })

    const ledger = bodyOf(
      await client.get('/api/v1/portal/checkouts?channel=desk').bearerToken(world.adminToken)
    ).data
    assert.equal(ledger.total, 1)
    assert.equal(ledger.items[0].channel, 'desk')
    assert.equal(ledger.items[0].seller.email, 'desk@example.com')
    assert.isNull(ledger.items[0].terminal.id)
    assert.deepEqual(ledger.totals, [{ currency: 'PHP', amount: 5, count: 1 }])
    const coins = bodyOf(
      await client.get('/api/v1/portal/checkouts?channel=coin').bearerToken(world.adminToken)
    ).data
    assert.equal(coins.total, 0)

    const alert = mapCheckout({
      id: 1,
      kind: 'payment',
      channel: 'desk',
      terminalId: null,
      terminalName: null,
      portalId: portal.id,
      portalName: portal.name,
      amount: 5,
      currency: 'PHP',
      decimals: 0,
      reason: null,
      terminalExists: false,
      sellerName: 'desk',
    })
    assert.equal(alert?.type, 'hotspot.payment')
    assert.equal((alert?.payload as any).channel, 'desk')
    assert.equal((alert?.payload as any).sellerName, 'desk')
  })
})
