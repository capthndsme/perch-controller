import HotspotCheckout from '#models/hotspot_checkout'
import HotspotPriceTable from '#models/hotspot_price_table'
import Portal, { portalMethods } from '#models/portal'
import User from '#models/user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { isPortalGatewayReady } from '#services/portal_agent'
import { type PortalDelivery, sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, portalNotFound } from '#services/portal_errors'
import { num, utc } from '#services/portal_grants'
import { mintPaymentVoucher, voidCheckout } from '#services/portal_hotspot'
import { parseIsoTime } from '#services/portal_params'
import { runInPortalQueue } from '#services/portal_queue'
import { voucherFacts } from '#services/portal_vouchers'
import { formatVoucherCode, generateVoucherCode } from '#services/portal/codes'
import {
  type PriceEntry,
  entitlementText,
  moneyText,
  normalizeDeskSettings,
} from '#services/portal/hotspot'
import { type VoucherStatus, voucherStatus } from '#services/portal/redemption'
import type { DurationMode } from '#services/portal/types'
import { instanceTimezone } from '#services/usage_history'
import { priceTableWire } from '#transformers/hotspot'
import { iso } from '#transformers/portal'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Sell Mode desk sales (docs/gateway/portal.md section 15). A sale is one
 * entry of a portal's desk price table, turned into a one-voucher `payment`
 * batch and a ledger row (`hotspot_checkouts`, channel `desk`) in one
 * transaction: the controller's version of crediting unclaimed coins
 * (section 14.5). Redemption, clocks, device moves and void are the payment
 * voucher's. Admins see and change every sale; a Wi-Fi vendor only their own,
 * and only while the code is unused.
 */

// ---------------------------------------------------------------------------
// Shapes (section 15.3)
// ---------------------------------------------------------------------------

export type SellItem = {
  amount: number
  amountText: string
  minutes: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  text: string
}

export type SellPortal = {
  id: number
  name: string
  gatewayId: number
  gatewayOnline: boolean
  codeLength: number
  priceTable: {
    id: number
    name: string
    revision: number
    currency: string
    decimals: number
    durationMode: DurationMode
  }
  items: SellItem[]
}

export type SellMenu = {
  seller: { id: number; email: string; fullName: string | null; role: string }
  timezone: string
  portals: SellPortal[]
}

export type Sale = {
  id: number
  state: 'paid' | 'voided'
  portal: { id: number; name: string } | null
  amount: number
  amountText: string
  currency: string
  decimals: number
  item: {
    minutes: number
    quotaBytes: number | null
    downKbps: number | null
    upKbps: number | null
    durationMode: string
    text: string
  }
  voucher: { id: number; hint: string; status: VoucherStatus } | null
  codeAvailable: boolean
  voidable: boolean
  seller: { id: number; email: string; fullName: string | null } | null
  note: string | null
  refundAmount: number | null
  createdAt: string | null
  voidedAt: string | null
  voidedBy: { id: number; email: string } | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const saleNotFound = (id: number | string) =>
  new PortalError(404, 'sale_not_found', `There is no sale ${id}.`)

const deskSalesOff = (portal: Portal) =>
  new PortalError(409, 'desk_sales_off', `"${portal.name}" does not sell codes at the desk.`)

const codesUnrecoverable = () =>
  new PortalError(
    410,
    'codes_unrecoverable',
    "The code cannot be read back (the controller's APP_KEY changed)."
  )

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function itemOf(e: PriceEntry, currency: string, decimals: number): SellItem {
  return {
    amount: e.amount,
    amountText: moneyText(e.amount, currency, decimals),
    minutes: e.minutes,
    quotaBytes: e.quotaBytes ?? null,
    downKbps: e.downKbps ?? null,
    upKbps: e.upKbps ?? null,
    text: entitlementText(e.minutes * 60, e.quotaBytes ?? null, e.downKbps ?? null),
  }
}

function sellPortalView(p: Portal, t: HotspotPriceTable): SellPortal {
  const wire = priceTableWire(t)
  return {
    id: p.id,
    name: p.name,
    gatewayId: p.gatewayId,
    gatewayOnline: isPortalGatewayReady(p.gatewayId),
    codeLength: normalizeDeskSettings(p.desk).codeLength,
    priceTable: {
      id: t.id,
      name: t.name,
      revision: t.revision,
      currency: t.currency,
      decimals: t.decimals,
      durationMode: t.durationMode,
    },
    // Cheapest first (sortPriceEntries is the coin box's greedy order, largest first).
    items: [...wire.entries]
      .sort((a, b) => a.amount - b.amount)
      .map((e) => itemOf(e, t.currency, t.decimals)),
  }
}

/** A live portal with desk sales on and its desk table (null: it does not sell). */
async function deskTableOf(p: Portal): Promise<HotspotPriceTable | null> {
  if (p.deletedAt !== null || !portalMethods(p.methods).desk) return null
  const id = normalizeDeskSettings(p.desk).priceTableId
  return id === null ? null : await HotspotPriceTable.find(id)
}

export async function sellMenu(user: User): Promise<SellMenu> {
  const live = await Portal.query().whereNull('deleted_at').orderBy('name')
  const portals = live.filter((p) => portalMethods(p.methods).desk)
  const ids = [
    ...new Set(
      portals.map((p) => normalizeDeskSettings(p.desk).priceTableId).filter((x) => x !== null)
    ),
  ] as number[]
  const tables = ids.length ? await HotspotPriceTable.query().whereIn('id', ids) : []
  const tableById = new Map(tables.map((t) => [t.id, t]))
  const out: SellPortal[] = []
  for (const p of portals) {
    const table = tableById.get(normalizeDeskSettings(p.desk).priceTableId ?? 0)
    if (!table || !(table.entries ?? []).length) continue
    out.push(sellPortalView(p, table))
  }
  return {
    seller: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
    timezone: await instanceTimezone(),
    portals: out,
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type VoucherRef = { voucher: Voucher; status: VoucherStatus }

async function voucherRefs(rows: HotspotCheckout[]): Promise<Map<number, VoucherRef>> {
  const ids = [...new Set(rows.map((r) => r.voucherId).filter((x): x is number => x !== null))]
  if (!ids.length) return new Map()
  const vouchers = await Voucher.query().whereIn('id', ids)
  const batches = await VoucherBatch.query().whereIn('id', [
    ...new Set(vouchers.map((v) => v.batchId)),
  ])
  const batchById = new Map(batches.map((b) => [b.id, b]))
  const now = Date.now()
  return new Map(
    vouchers.map((v) => [
      v.id,
      { voucher: v, status: voucherStatus(voucherFacts(v, batchById.get(v.batchId)!), now) },
    ])
  )
}

const isAdmin = (user: User) => user.role === 'admin'

/** What `user` may do with a sale whose voucher is in `status`. */
function rights(
  row: HotspotCheckout,
  status: VoucherStatus | null,
  user: User
): { codeAvailable: boolean; voidable: boolean } {
  if (row.state !== 'paid' || status === null) return { codeAvailable: false, voidable: false }
  if (isAdmin(user)) return { codeAvailable: status !== 'revoked', voidable: true }
  const own = row.sellerUserId === user.id && status === 'unused'
  return { codeAvailable: own, voidable: own }
}

async function saleViews(rows: HotspotCheckout[], viewer: User): Promise<Sale[]> {
  if (!rows.length) return []
  const vouchers = await voucherRefs(rows)
  const portalIds = [...new Set(rows.map((r) => r.portalId).filter((x): x is number => x !== null))]
  const portals = portalIds.length
    ? await Portal.query().select(['id', 'name']).whereIn('id', portalIds)
    : []
  const portalById = new Map(portals.map((p) => [p.id, { id: p.id, name: p.name }]))
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.sellerUserId, r.resolvedByUserId]).filter((x) => x !== null)),
  ] as number[]
  const users = userIds.length
    ? await User.query().select(['id', 'email', 'full_name']).whereIn('id', userIds)
    : []
  const userById = new Map(users.map((u) => [u.id, u]))
  return rows.map((r) => {
    const ref = r.voucherId === null ? undefined : vouchers.get(r.voucherId)
    const seller = r.sellerUserId === null ? undefined : userById.get(r.sellerUserId)
    const voider =
      r.state === 'voided' && r.resolvedByUserId !== null
        ? userById.get(r.resolvedByUserId)
        : undefined
    const amount = num(r.amount)
    const currency = r.currency ?? ''
    const decimals = r.decimals ?? 0
    const seconds = r.durationSeconds ?? 0
    const quotaBytes = r.quotaBytes === null ? null : num(r.quotaBytes)
    return {
      id: num(r.id),
      state: r.state === 'voided' ? 'voided' : 'paid',
      portal: r.portalId === null ? null : (portalById.get(r.portalId) ?? null),
      amount,
      amountText: moneyText(amount, currency, decimals),
      currency,
      decimals,
      item: {
        minutes: Math.round(seconds / 60),
        quotaBytes,
        downKbps: r.downKbps,
        upKbps: r.upKbps,
        durationMode: r.durationMode ?? 'wall_clock',
        text: entitlementText(seconds, quotaBytes, r.downKbps),
      },
      voucher: ref ? { id: ref.voucher.id, hint: ref.voucher.hint, status: ref.status } : null,
      ...rights(r, ref?.status ?? null, viewer),
      seller: seller ? { id: seller.id, email: seller.email, fullName: seller.fullName } : null,
      note: r.note,
      refundAmount: r.refundAmount === null ? null : num(r.refundAmount),
      createdAt: iso(r.createdAt),
      voidedAt: r.state === 'voided' ? iso(r.resolvedAt) : null,
      voidedBy: voider ? { id: voider.id, email: voider.email } : null,
    }
  })
}

/** A desk sale `viewer` may see (another vendor's reads as missing). */
async function findSale(id: number, viewer: User): Promise<HotspotCheckout> {
  const row = await HotspotCheckout.query().where('id', id).where('channel', 'desk').first()
  if (!row || (!isAdmin(viewer) && row.sellerUserId !== viewer.id)) throw saleNotFound(id)
  return row
}

async function saleView(id: number, viewer: User): Promise<Sale> {
  const [view] = await saleViews([await findSale(id, viewer)], viewer)
  return view
}

// ---------------------------------------------------------------------------
// Sell
// ---------------------------------------------------------------------------

export type SaleInput = {
  portalId: number
  amount: number
  priceRevision: number
  clientRef: string
  note?: string | null
}

export type SaleResult = { sale: Sale; code: string; delivery: PortalDelivery; created: boolean }

const eventKey = (clientRef: string) => `desk:${clientRef}`

/** The answer to a retried sale: the same sale and code, for the same seller and order only. */
async function replay(
  existing: HotspotCheckout,
  user: User,
  portal: Portal,
  input: SaleInput
): Promise<SaleResult> {
  if (
    existing.channel !== 'desk' ||
    existing.sellerUserId !== user.id ||
    existing.portalId !== portal.id ||
    num(existing.amount) !== input.amount
  ) {
    throw new PortalError(
      409,
      'client_ref_used',
      '`clientRef` belongs to another sale: make a new one for each sale.'
    )
  }
  const voucher = existing.voucherId === null ? null : await Voucher.find(existing.voucherId)
  if (!voucher?.code) throw codesUnrecoverable()
  return {
    sale: await saleView(num(existing.id), user),
    code: formatVoucherCode(voucher.code),
    delivery: isPortalGatewayReady(portal.gatewayId) ? 'applied' : 'pending',
    created: false,
  }
}

const findByClientRef = (gatewayId: number, clientRef: string) =>
  HotspotCheckout.query()
    .where('gateway_id', gatewayId)
    .where('event_key', eventKey(clientRef))
    .first()

export async function createSale(user: User, input: SaleInput): Promise<SaleResult> {
  const portal = await Portal.query().where('id', input.portalId).whereNull('deleted_at').first()
  if (!portal) throw portalNotFound(input.portalId)
  // A retry answers with the sale it made, even if prices changed since.
  const existing = await findByClientRef(portal.gatewayId, input.clientRef)
  if (existing) return replay(existing, user, portal, input)

  const table = await deskTableOf(portal)
  if (!table) throw deskSalesOff(portal)
  if (table.revision !== input.priceRevision) {
    throw new PortalError(409, 'price_changed', 'The prices changed: check them and sell again.', {
      portal: sellPortalView(portal, table),
    })
  }
  const entry = priceTableWire(table).entries.find((e) => e.amount === input.amount)
  if (!entry) {
    throw new PortalError(422, 'not_on_menu', `Nothing on the menu costs ${input.amount}.`)
  }
  const desk = normalizeDeskSettings(portal.desk)

  let saleId = 0
  let code = ''
  // A new code on the (astronomically rare) collision with another voucher.
  for (let attempt = 0; attempt < 3 && saleId === 0; attempt++) {
    code = generateVoucherCode(desk.codeLength)
    const now = Date.now()
    const sqlNow = utc(now).toSQL({ includeOffset: false })!
    try {
      saleId = await db.transaction(async (trx) => {
        const voucherId = await mintPaymentVoucher(trx, {
          portalId: portal.id,
          name: `Desk sale by ${user.fullName || user.email}`,
          code,
          durationMode: table.durationMode,
          durationSeconds: entry.minutes * 60,
          quotaBytes: entry.quotaBytes,
          downKbps: entry.downKbps,
          upKbps: entry.upKbps,
          createdByUserId: user.id,
          note: input.note ?? null,
          now,
        })
        const [id] = await trx.table('hotspot_checkouts').insert({
          gateway_id: portal.gatewayId,
          portal_id: portal.id,
          terminal_id: null,
          terminal_name: null,
          kind: 'payment',
          state: 'paid',
          channel: 'desk',
          seller_user_id: user.id,
          event_key: eventKey(input.clientRef),
          checkout_ref: null,
          mac: null,
          ip: null,
          hostname: null,
          amount: entry.amount,
          unused_amount: 0,
          currency: table.currency,
          decimals: table.decimals,
          price_table_id: table.id,
          price_revision: table.revision,
          price_snapshot: JSON.stringify(priceTableWire(table)),
          duration_mode: table.durationMode,
          duration_seconds: entry.minutes * 60,
          quota_bytes: entry.quotaBytes,
          down_kbps: entry.downKbps,
          up_kbps: entry.upKbps,
          coin_count: 0,
          coins: null,
          reason: null,
          opened_at: sqlNow,
          finalized_at: sqlNow,
          key_epoch: null,
          router_sig: null,
          voucher_id: voucherId,
          refund_amount: null,
          note: input.note ?? null,
          resolved_at: null,
          resolved_by_user_id: null,
          created_at: sqlNow,
          updated_at: sqlNow,
        })
        return Number(id)
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error
      // The same clientRef won a race (a double tap): answer with that sale.
      const raced = await findByClientRef(portal.gatewayId, input.clientRef)
      if (raced) return replay(raced, user, portal, input)
    }
  }
  if (saleId === 0) throw new Error('could not mint a unique desk code')

  // The router learns the voucher for offline redemption (decision 20).
  const delivery = await runInPortalQueue(portal.gatewayId, () =>
    sendPortalPushes(portal.gatewayId, [{ kind: 'vouchers' }])
  )
  return {
    sale: await saleView(saleId, user),
    code: formatVoucherCode(code),
    delivery,
    created: true,
  }
}

// ---------------------------------------------------------------------------
// Sales list, code, void
// ---------------------------------------------------------------------------

export type SaleFilter = {
  from?: string
  to?: string
  portalId?: number
  sellerId?: number
  state?: 'paid' | 'voided'
  limit?: number
  offset?: number
}

export async function listSales(
  viewer: User,
  filter: SaleFilter
): Promise<{
  items: Sale[]
  total: number
  totals: Array<{ currency: string; amount: number; count: number }>
  range: { from: string; to: string }
  timezone: string
}> {
  const timezone = await instanceTimezone()
  const from =
    parseIsoTime(filter.from, 'from') ??
    DateTime.now().setZone(timezone).startOf('day').toUTC().toJSDate()
  const to = parseIsoTime(filter.to, 'to') ?? new Date()
  if (from.getTime() > to.getTime()) {
    throw new PortalError(422, 'invalid_range', '`from` is after `to`.')
  }
  // A vendor only ever sees their own sales.
  const sellerId = isAdmin(viewer) ? filter.sellerId : viewer.id
  const apply = <T extends ReturnType<typeof HotspotCheckout.query>>(q: T): T => {
    q.where('channel', 'desk')
      .where('kind', 'payment')
      .where('created_at', '>=', utc(from.getTime()).toSQL({ includeOffset: false })!)
      .where('created_at', '<=', utc(to.getTime()).toSQL({ includeOffset: false })!)
    if (sellerId) q.where('seller_user_id', sellerId)
    if (filter.portalId) q.where('portal_id', filter.portalId)
    if (filter.state) q.where('state', filter.state)
    return q
  }
  const [{ n }] = (await apply(HotspotCheckout.query()).count('* as n').pojo()) as Array<{
    n: number | string
  }>
  const rows = await apply(HotspotCheckout.query())
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0)
  const sums = (await apply(HotspotCheckout.query())
    .where('state', 'paid')
    .groupBy('currency')
    .select('currency')
    .sum('amount as amount')
    .count('* as count')
    .pojo()) as Array<{ currency: string | null; amount: number | string; count: number | string }>
  return {
    items: await saleViews(rows, viewer),
    total: Number(n),
    totals: sums
      .filter((s) => s.currency)
      .map((s) => ({ currency: s.currency!, amount: Number(s.amount), count: Number(s.count) })),
    range: { from: from.toISOString(), to: to.toISOString() },
    timezone,
  }
}

/** The sale's voucher and its status (a paid sale always has one). */
async function voucherOf(row: HotspotCheckout): Promise<VoucherRef> {
  const refs = await voucherRefs([row])
  const ref = row.voucherId === null ? undefined : refs.get(row.voucherId)
  if (!ref) throw saleNotFound(num(row.id))
  return ref
}

export async function saleCode(viewer: User, id: number): Promise<string> {
  const row = await findSale(id, viewer)
  if (row.state === 'voided') {
    throw new PortalError(409, 'sale_voided', `Sale ${id} was voided: its code no longer works.`)
  }
  const { voucher, status } = await voucherOf(row)
  if (status === 'revoked') {
    throw new PortalError(409, 'code_revoked', `The code of sale ${id} was revoked.`)
  }
  if (!isAdmin(viewer) && status !== 'unused') {
    throw new PortalError(409, 'code_used', 'The code is in use already: ask an admin.')
  }
  if (!voucher.code) throw codesUnrecoverable()
  return formatVoucherCode(voucher.code)
}

export async function voidSale(
  viewer: User,
  id: number,
  input: { refundAmount?: number | null; note?: string | null }
): Promise<{ sale: Sale; delivery: PortalDelivery }> {
  const row = await findSale(id, viewer)
  if (row.state === 'voided') {
    throw new PortalError(409, 'sale_voided', `Sale ${id} is already voided.`)
  }
  if (!isAdmin(viewer)) {
    const { status } = await voucherOf(row)
    if (status !== 'unused') {
      throw new PortalError(
        409,
        'sale_used',
        'The code was used already: only an admin can void this sale.'
      )
    }
  }
  const { delivery } = await voidCheckout(id, input, viewer.id)
  return { sale: await saleView(id, viewer), delivery }
}
