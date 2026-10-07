import HotspotCheckout from '#models/hotspot_checkout'
import HotspotPriceTable from '#models/hotspot_price_table'
import HotspotTerminal from '#models/hotspot_terminal'
import Portal from '#models/portal'
import User from '#models/user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { hashVoucherCode } from '#services/portal_keys'
import { type PortalDelivery, sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, idParam, portalNotFound } from '#services/portal_errors'
import { num, utc } from '#services/portal_grants'
import { page, parseIsoTime } from '#services/portal_params'
import { findPortal } from '#services/portal_portals'
import { runInPortalQueue } from '#services/portal_queue'
import { revokeVoucher, voucherFacts } from '#services/portal_vouchers'
import { formatVoucherCode, generateVoucherCode, voucherHint } from '#services/portal/codes'
import {
  type PriceEntry,
  CURRENCY_REGEX,
  PRICE_LIMITS,
  TERMINAL_TOKEN_PREFIX,
  TERMINAL_TOKEN_REGEX,
  entitlementText,
  moneyText,
  normalizeDeskSettings,
  normalizePaymentSettings,
  previewText,
  priceEntitlement,
  validatePriceEntries,
} from '#services/portal/hotspot'
import { voucherStatus } from '#services/portal/redemption'
import type { DurationMode } from '#services/portal/types'
import { normalizeMac } from '#services/portal/types'
import {
  type CheckoutView,
  type PriceRevisionView,
  type PriceTableView,
  type TerminalView,
  checkoutView,
  priceTableView,
  priceTableWire,
  terminalView,
} from '#transformers/hotspot'
import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Paid Hotspot administration (docs/gateway/portal.md section 14.9): price
 * tables, coin terminals and the payment ledger. The router runs the
 * checkouts; everything here reaches it through `portal.configure`
 * (terminals with their tokens, the tables they use), pushed to every
 * gateway a change touches.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const priceTableNotFound = (id: number | string) =>
  new PortalError(404, 'price_table_not_found', `There is no price table ${id}.`)

export const terminalNotFound = (id: number | string) =>
  new PortalError(404, 'terminal_not_found', `There is no terminal ${id}.`)

export const checkoutNotFound = (id: number | string) =>
  new PortalError(404, 'checkout_not_found', `There is no checkout ${id}.`)

export { idParam }

// ---------------------------------------------------------------------------
// Pushes
// ---------------------------------------------------------------------------

/** `portal.configure` to the gateways of the given portals (one push per gateway). */
export async function configurePortals(portalIds: number[]): Promise<PortalDelivery> {
  const ids = [...new Set(portalIds)]
  if (!ids.length) return 'applied'
  const portals = await Portal.query().whereIn('id', ids)
  const byGateway = new Map<number, number>()
  for (const p of portals) if (!byGateway.has(p.gatewayId)) byGateway.set(p.gatewayId, p.id)
  let delivery: PortalDelivery = 'applied'
  for (const [gatewayId, portalId] of byGateway) {
    const result = await runInPortalQueue(gatewayId, () =>
      sendPortalPushes(gatewayId, [{ kind: 'configure', portalId }])
    )
    if (result === 'pending') delivery = 'pending'
  }
  return delivery
}

// ---------------------------------------------------------------------------
// Price tables
// ---------------------------------------------------------------------------

export type PriceTableInput = {
  name?: string
  currency?: string
  decimals?: number
  durationMode?: DurationMode
  entries?: Array<{
    amount: number
    minutes: number
    quotaBytes?: number | null
    downKbps?: number | null
    upKbps?: number | null
  }>
}

function cleanEntries(entries: NonNullable<PriceTableInput['entries']>): PriceEntry[] {
  const out: PriceEntry[] = entries.map((e) => ({
    amount: e.amount,
    minutes: e.minutes,
    quotaBytes: e.quotaBytes ?? null,
    downKbps: e.downKbps ?? null,
    upKbps: e.upKbps ?? null,
  }))
  const error = validatePriceEntries(out)
  if (error) {
    const messages: Record<string, string> = {
      no_entries: 'A price table needs at least one rate.',
      too_many_entries: `A price table holds at most ${PRICE_LIMITS.entries} rates.`,
      duplicate_amount: 'Two rates have the same amount.',
      mixed_quota: 'Either every rate has a data quota or none has.',
      invalid_entry: 'A rate is out of range.',
    }
    throw new PortalError(422, error, messages[error])
  }
  return out.sort((a, b) => a.amount - b.amount)
}

/** Portals (by their payment or desk settings) and terminals using each table. */
async function priceTableUsage(): Promise<Map<number, PriceTableView['usedBy']>> {
  const usage = new Map<number, PriceTableView['usedBy']>()
  const get = (id: number) => {
    let u = usage.get(id)
    if (!u) {
      u = { portalIds: [], terminalIds: [] }
      usage.set(id, u)
    }
    return u
  }
  const portals = await Portal.query().whereNull('deleted_at').select(['id', 'payment', 'desk'])
  for (const p of portals) {
    const ids = new Set([
      normalizePaymentSettings(p.payment).priceTableId,
      normalizeDeskSettings(p.desk).priceTableId,
    ])
    for (const id of ids) if (id !== null) get(id).portalIds.push(p.id)
  }
  const terminals = await HotspotTerminal.query()
    .whereNotNull('price_table_id')
    .select(['id', 'price_table_id'])
  for (const t of terminals) get(t.priceTableId!).terminalIds.push(t.id)
  return usage
}

/** One table's users (none: empty lists). */
async function usageOfTable(tableId: number): Promise<PriceTableView['usedBy']> {
  const usage = await priceTableUsage()
  return usage.get(tableId) ?? { portalIds: [], terminalIds: [] }
}

async function portalsUsingTable(tableId: number): Promise<number[]> {
  const usage = await usageOfTable(tableId)
  const terminals = usage.terminalIds.length
    ? await HotspotTerminal.query().whereIn('id', usage.terminalIds)
    : []
  const viaTerminals = terminals.map((t) => t.portalId)
  return [...new Set([...usage.portalIds, ...viaTerminals])]
}

async function saveRevision(trx: TransactionClientContract, t: HotspotPriceTable) {
  await trx.table('hotspot_price_revisions').insert({
    price_table_id: t.id,
    revision: t.revision,
    name: t.name,
    currency: t.currency,
    decimals: t.decimals,
    duration_mode: t.durationMode,
    entries: JSON.stringify(t.entries),
    created_at: utc(Date.now()).toSQL({ includeOffset: false }),
  })
}

export async function findPriceTable(id: number): Promise<HotspotPriceTable> {
  const t = await HotspotPriceTable.find(id)
  if (!t) throw priceTableNotFound(id)
  return t
}

export async function listPriceTables(): Promise<PriceTableView[]> {
  const rows = await HotspotPriceTable.query().orderBy('name').orderBy('id')
  const usage = await priceTableUsage()
  return rows.map((t) => priceTableView(t, usage.get(t.id) ?? { portalIds: [], terminalIds: [] }))
}

export async function showPriceTable(
  id: number
): Promise<{ priceTable: PriceTableView; revisions: PriceRevisionView[] }> {
  const t = await findPriceTable(id)
  const usage = await usageOfTable(t.id)
  const revisions = (await db
    .from('hotspot_price_revisions')
    .where('price_table_id', id)
    .orderBy('revision', 'desc')
    .limit(100)) as Array<Record<string, unknown>>
  return {
    priceTable: priceTableView(t, usage),
    revisions: revisions.map((r) => ({
      revision: Number(r.revision),
      name: String(r.name),
      currency: String(r.currency),
      decimals: Number(r.decimals),
      durationMode: r.duration_mode as DurationMode,
      entries: JSON.parse(String(r.entries)) as PriceEntry[],
      createdAt: r.created_at
        ? DateTime.fromJSDate(r.created_at as Date)
            .toUTC()
            .toISO()
        : null,
    })),
  }
}

function checkCurrency(currency: string | undefined) {
  if (currency !== undefined && !CURRENCY_REGEX.test(currency)) {
    throw new PortalError(422, 'invalid_currency', 'The currency is a three-letter ISO 4217 code.')
  }
}

export async function createPriceTable(
  input: Required<Pick<PriceTableInput, 'name' | 'currency' | 'entries'>> & PriceTableInput,
  userId: number | null
): Promise<PriceTableView> {
  checkCurrency(input.currency)
  const entries = cleanEntries(input.entries)
  const table = await db.transaction(async (trx) => {
    const t = new HotspotPriceTable()
    t.fill({
      name: input.name,
      currency: input.currency,
      decimals: input.decimals ?? 0,
      durationMode: input.durationMode ?? 'wall_clock',
      entries,
      revision: 1,
      createdByUserId: userId,
    })
    t.useTransaction(trx)
    await t.save()
    await saveRevision(trx, t)
    return t
  })
  return priceTableView(table, { portalIds: [], terminalIds: [] })
}

/**
 * Any change bumps the revision and keeps it: open checkouts stay priced at
 * the revision they started under (the router locked it), new ones take the
 * new one once the router has it.
 */
export async function updatePriceTable(
  id: number,
  input: PriceTableInput
): Promise<{ priceTable: PriceTableView; delivery: PortalDelivery }> {
  checkCurrency(input.currency)
  const entries = input.entries ? cleanEntries(input.entries) : undefined
  const changed = await db.transaction(async (trx) => {
    const t = await HotspotPriceTable.query({ client: trx }).where('id', id).forUpdate().first()
    if (!t) throw priceTableNotFound(id)
    const before = JSON.stringify(priceTableWire(t))
    if (input.name !== undefined) t.name = input.name
    if (input.currency !== undefined) t.currency = input.currency
    if (input.decimals !== undefined) t.decimals = input.decimals
    if (input.durationMode !== undefined) t.durationMode = input.durationMode
    if (entries) t.entries = entries
    if (JSON.stringify(priceTableWire(t)) === before) return false
    t.revision += 1
    t.useTransaction(trx)
    await t.save()
    await saveRevision(trx, t)
    return true
  })
  const delivery = changed ? await configurePortals(await portalsUsingTable(id)) : 'applied'
  const usage = await usageOfTable(id)
  return { priceTable: priceTableView(await findPriceTable(id), usage), delivery }
}

export async function deletePriceTable(id: number): Promise<void> {
  await findPriceTable(id)
  const usage = await usageOfTable(id)
  if (usage.portalIds.length || usage.terminalIds.length) {
    throw new PortalError(
      409,
      'price_table_in_use',
      'Portals or terminals use this price table; point them at another one first.',
      usage
    )
  }
  await HotspotPriceTable.query().where('id', id).delete()
}

/** What an amount buys under a table (the dashboard's "what does 7 buy" preview). */
export async function quotePriceTable(id: number, amount: number) {
  const t = await findPriceTable(id)
  const result = priceEntitlement(priceTableWire(t), amount)
  return {
    ...result,
    amountText: moneyText(result.amount, t.currency, t.decimals),
    previewText: previewText(result, t.currency, t.decimals),
    text:
      result.durationSeconds > 0
        ? entitlementText(result.durationSeconds, result.quotaBytes, result.downKbps)
        : null,
    priceTableId: t.id,
    revision: t.revision,
  }
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

const TOKEN_RANDOM_BYTES = 24
const DISPLAY_PREFIX_LENGTH = TERMINAL_TOKEN_PREFIX.length + 4

export function generateTerminalToken(): string {
  return TERMINAL_TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')
}

export function terminalTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The terminal a token belongs to (constant-time compare after the hash lookup), or null. */
export async function terminalByToken(token: string): Promise<HotspotTerminal | null> {
  if (!TERMINAL_TOKEN_REGEX.test(token)) return null
  const hash = terminalTokenHash(token)
  const t = await HotspotTerminal.query().where('token_hash', hash).first()
  if (!t) return null
  const a = Buffer.from(t.tokenHash, 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b) ? t : null
}

export type TerminalInput = {
  portalId?: number
  name?: string
  mac?: string | null
  enabled?: boolean
  priceTableId?: number | null
}

function macOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const mac = normalizeMac(value)
  if (!mac) throw new PortalError(422, 'invalid_mac', `"${value}" is not a device MAC address.`)
  return mac
}

async function terminalViews(rows: HotspotTerminal[]): Promise<TerminalView[]> {
  if (!rows.length) return []
  const portals = await Portal.query().whereIn('id', [...new Set(rows.map((t) => t.portalId))])
  const tableOf = new Map(
    portals.map((p) => [p.id, normalizePaymentSettings(p.payment).priceTableId])
  )
  const now = Date.now()
  return rows.map((t) => terminalView(t, tableOf.get(t.portalId) ?? null, now))
}

export async function findTerminal(id: number): Promise<HotspotTerminal> {
  const t = await HotspotTerminal.find(id)
  if (!t) throw terminalNotFound(id)
  return t
}

export async function listTerminals(filter: { portalId?: number }): Promise<TerminalView[]> {
  const query = HotspotTerminal.query().orderBy('portal_id').orderBy('name').orderBy('id')
  if (filter.portalId) query.where('portal_id', filter.portalId)
  return terminalViews(await query)
}

export async function showTerminal(id: number): Promise<TerminalView> {
  const [view] = await terminalViews([await findTerminal(id)])
  return view
}

export async function createTerminal(
  input: Required<Pick<TerminalInput, 'portalId' | 'name'>> & TerminalInput,
  userId: number | null
): Promise<{ terminal: TerminalView; token: string; delivery: PortalDelivery }> {
  await findPortal(input.portalId)
  if (input.priceTableId !== undefined && input.priceTableId !== null) {
    await findPriceTable(input.priceTableId)
  }
  const token = generateTerminalToken()
  const t = new HotspotTerminal()
  t.fill({
    portalId: input.portalId,
    name: input.name,
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    tokenHash: terminalTokenHash(token),
    token,
    mac: macOrNull(input.mac),
    enabled: input.enabled ?? true,
    priceTableId: input.priceTableId ?? null,
    lastSeenAt: null,
    status: null,
    createdByUserId: userId,
  })
  await t.save()
  const delivery = await configurePortals([t.portalId])
  return { terminal: await showTerminal(t.id), token, delivery }
}

export async function updateTerminal(
  id: number,
  input: TerminalInput
): Promise<{ terminal: TerminalView; delivery: PortalDelivery }> {
  const t = await findTerminal(id)
  const touched = new Set<number>([t.portalId])
  let changed = false
  if (input.portalId !== undefined && input.portalId !== t.portalId) {
    await findPortal(input.portalId)
    t.portalId = input.portalId
    touched.add(input.portalId)
    changed = true
  }
  if (input.name !== undefined && input.name !== t.name) {
    t.name = input.name
    changed = true
  }
  if (input.mac !== undefined) {
    const mac = macOrNull(input.mac)
    if (mac !== t.mac) {
      t.mac = mac
      changed = true
    }
  }
  if (input.enabled !== undefined && input.enabled !== Boolean(t.enabled)) {
    t.enabled = input.enabled
    changed = true
  }
  if (input.priceTableId !== undefined && input.priceTableId !== t.priceTableId) {
    if (input.priceTableId !== null) await findPriceTable(input.priceTableId)
    t.priceTableId = input.priceTableId
    changed = true
  }
  let delivery: PortalDelivery = 'applied'
  if (changed) {
    await t.save()
    delivery = await configurePortals([...touched])
  }
  return { terminal: await showTerminal(t.id), delivery }
}

/** A new token; the old one stops working with the router's next configure. */
export async function rotateTerminal(
  id: number
): Promise<{ terminal: TerminalView; token: string; delivery: PortalDelivery }> {
  const t = await findTerminal(id)
  const token = generateTerminalToken()
  t.tokenPrefix = token.slice(0, DISPLAY_PREFIX_LENGTH)
  t.tokenHash = terminalTokenHash(token)
  t.token = token
  await t.save()
  const delivery = await configurePortals([t.portalId])
  return { terminal: await showTerminal(t.id), token, delivery }
}

/** Deletes a terminal; its ledger rows keep its name (`terminal_id` goes null). */
export async function deleteTerminal(id: number): Promise<PortalDelivery> {
  const t = await findTerminal(id)
  await db
    .from('hotspot_checkouts')
    .where('terminal_id', id)
    .whereNull('terminal_name')
    .update({ terminal_name: t.name })
  await t.delete()
  return configurePortals([t.portalId])
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type CheckoutFilter = {
  portalId?: number
  gatewayId?: number
  terminalId?: number
  kind?: 'payment' | 'unclaimed'
  channel?: 'coin' | 'desk'
  state?: 'paid' | 'voided' | 'unclaimed' | 'credited' | 'dismissed'
  mac?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

async function checkoutViews(rows: HotspotCheckout[]): Promise<CheckoutView[]> {
  if (!rows.length) return []
  const voucherIds = [
    ...new Set(rows.map((r) => r.voucherId).filter((x): x is number => x !== null)),
  ]
  const vouchers = voucherIds.length ? await Voucher.query().whereIn('id', voucherIds) : []
  const batches = vouchers.length
    ? await VoucherBatch.query().whereIn('id', [...new Set(vouchers.map((v) => v.batchId))])
    : []
  const batchById = new Map(batches.map((b) => [b.id, b]))
  const now = Date.now()
  const voucherRefs = new Map(
    vouchers.map((v) => [
      v.id,
      {
        id: v.id,
        batchId: v.batchId,
        hint: v.hint,
        status: voucherStatus(voucherFacts(v, batchById.get(v.batchId)!), now),
      },
    ])
  )
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.resolvedByUserId, r.sellerUserId])
        .filter((x): x is number => x !== null)
    ),
  ]
  const users = userIds.length
    ? await User.query().select(['id', 'email', 'full_name']).whereIn('id', userIds)
    : []
  const userById = new Map(users.map((u) => [u.id, u]))
  return rows.map((r) => {
    const resolver = r.resolvedByUserId === null ? null : userById.get(r.resolvedByUserId)
    const seller = r.sellerUserId === null ? null : userById.get(r.sellerUserId)
    return checkoutView(r, {
      voucher: r.voucherId === null ? null : (voucherRefs.get(r.voucherId) ?? null),
      resolvedBy: resolver ? { id: resolver.id, email: resolver.email } : null,
      seller: seller ? { id: seller.id, email: seller.email, fullName: seller.fullName } : null,
    })
  })
}

export async function listCheckouts(filter: CheckoutFilter): Promise<{
  items: CheckoutView[]
  total: number
  totals: Array<{ currency: string; amount: number; count: number }>
}> {
  const { limit, offset } = page(filter)
  const from = parseIsoTime(filter.from, 'from')
  const to = parseIsoTime(filter.to, 'to')
  if (from && to && from.getTime() > to.getTime()) {
    throw new PortalError(422, 'invalid_range', '`from` is after `to`.')
  }
  let mac: string | null = null
  if (filter.mac) {
    mac = normalizeMac(filter.mac)
    if (!mac)
      throw new PortalError(422, 'invalid_mac', `"${filter.mac}" is not a device MAC address.`)
  }
  const apply = <T extends ReturnType<typeof HotspotCheckout.query>>(q: T): T => {
    if (filter.portalId) q.where('portal_id', filter.portalId)
    if (filter.gatewayId) q.where('gateway_id', filter.gatewayId)
    if (filter.terminalId) q.where('terminal_id', filter.terminalId)
    if (filter.kind) q.where('kind', filter.kind)
    if (filter.channel) q.where('channel', filter.channel)
    if (filter.state) q.where('state', filter.state)
    if (mac) q.where('mac', mac)
    if (from) q.where('created_at', '>=', utc(from.getTime()).toSQL({ includeOffset: false })!)
    if (to) q.where('created_at', '<=', utc(to.getTime()).toSQL({ includeOffset: false })!)
    return q
  }
  const [{ n }] = (await apply(HotspotCheckout.query()).count('* as n').pojo()) as Array<{
    n: number | string
  }>
  const rows: HotspotCheckout[] = await apply(HotspotCheckout.query())
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .offset(offset)
  const sums = (await apply(HotspotCheckout.query())
    .where('state', 'paid')
    .groupBy('currency')
    .select('currency')
    .sum('amount as amount')
    .count('* as count')
    .pojo()) as Array<{ currency: string | null; amount: number | string; count: number | string }>
  return {
    items: await checkoutViews(rows),
    total: Number(n),
    totals: sums
      .filter((s) => s.currency)
      .map((s) => ({ currency: s.currency!, amount: Number(s.amount), count: Number(s.count) })),
  }
}

async function findCheckout(id: number): Promise<HotspotCheckout> {
  const c = await HotspotCheckout.find(id)
  if (!c) throw checkoutNotFound(id)
  return c
}

export async function showCheckout(id: number): Promise<CheckoutView> {
  const [view] = await checkoutViews([await findCheckout(id)])
  return view
}

/**
 * Voids a payment (a refund, a mistake): its voucher is revoked, so the
 * devices using it go offline and its reference code stops working. The
 * money is not handled by Perch: `refundAmount` and `note` record what the
 * operator did.
 */
export async function voidCheckout(
  id: number,
  input: { note?: string | null; refundAmount?: number | null },
  userId: number | null
): Promise<{ checkout: CheckoutView; delivery: PortalDelivery }> {
  const c = await findCheckout(id)
  if (c.kind !== 'payment') {
    throw new PortalError(
      409,
      'not_a_payment',
      'Only a payment can be voided; dismiss unclaimed coins.'
    )
  }
  if (c.state === 'voided') {
    throw new PortalError(409, 'checkout_voided', `Checkout ${id} is already voided.`)
  }
  if (
    input.refundAmount !== undefined &&
    input.refundAmount !== null &&
    input.refundAmount > num(c.amount)
  ) {
    throw new PortalError(422, 'refund_exceeds_amount', 'The refund is larger than the payment.')
  }
  c.state = 'voided'
  c.note = input.note ?? c.note
  c.refundAmount = input.refundAmount ?? null
  c.resolvedAt = DateTime.utc()
  c.resolvedByUserId = userId
  await c.save()
  let delivery: PortalDelivery = 'applied'
  if (c.voucherId !== null) {
    const revoked = await revokeVoucher(c.voucherId)
    delivery = revoked.delivery
  }
  return { checkout: await showCheckout(id), delivery }
}

/** Unclaimed coins that need an admin (credit or dismiss). */
async function openUnclaimed(id: number): Promise<HotspotCheckout> {
  const c = await findCheckout(id)
  if (c.kind !== 'unclaimed') {
    throw new PortalError(409, 'not_unclaimed', `Checkout ${id} is not an unclaimed coin record.`)
  }
  if (c.state !== 'unclaimed') {
    throw new PortalError(409, 'already_resolved', `Checkout ${id} was already ${c.state}.`)
  }
  return c
}

/**
 * Mints the one-voucher `payment` batch of a paid checkout (or of an
 * admin's credit): bound to the portal, one device (a reused code moves,
 * decision 23), first-use wall clock or active time as priced.
 */
export async function mintPaymentVoucher(
  trx: TransactionClientContract,
  input: {
    portalId: number
    name: string
    code: string
    durationMode: DurationMode
    durationSeconds: number
    quotaBytes: number | null
    downKbps: number | null
    upKbps: number | null
    createdByUserId: number | null
    note?: string | null
    now: number
  }
): Promise<number> {
  const sqlNow = utc(input.now).toSQL({ includeOffset: false })!
  const [batchId] = await trx.table('voucher_batches').insert({
    portal_id: input.portalId,
    name: input.name.slice(0, 80),
    note: input.note ?? null,
    count: 1,
    code_length: input.code.length,
    duration_minutes: Math.max(1, Math.ceil(input.durationSeconds / 60)),
    duration_mode: input.durationMode,
    start_mode: 'first_use',
    quota_bytes: input.quotaBytes,
    down_kbps: input.downKbps,
    up_kbps: input.upKbps,
    max_devices: 1,
    redeem_by: null,
    created_by_user_id: input.createdByUserId,
    revoked_at: null,
    kind: 'payment',
    created_at: sqlNow,
    updated_at: sqlNow,
  })
  const [voucherId] = await trx.table('vouchers').insert({
    batch_id: Number(batchId),
    code_hash: hashVoucherCode(input.code)!,
    code_encrypted: encryption.encrypt(input.code),
    hint: voucherHint(input.code),
    bound_portal_id: input.portalId,
    first_used_at: null,
    starts_at: null,
    expires_at: null,
    time_used_seconds: 0,
    bytes_used: 0,
    revision: 1,
    revoked_at: null,
    exhausted_at: null,
    created_at: sqlNow,
    updated_at: sqlNow,
  })
  return Number(voucherId)
}

/**
 * Credits unclaimed coins: a voucher for what they buy under the terminal's
 * (else the portal's) current price table, or `minutes` when the admin
 * sets them. The code is in this answer only (`no-store`); the admin hands
 * it to the guest, who enters it as a voucher code.
 */
export async function creditCheckout(
  id: number,
  input: { minutes?: number | null; note?: string | null },
  userId: number | null
): Promise<{ checkout: CheckoutView; code: string; delivery: PortalDelivery }> {
  const c = await openUnclaimed(id)
  if (c.portalId === null) throw portalNotFound('(deleted)')
  const portal = await findPortal(c.portalId)
  const terminal = c.terminalId !== null ? await HotspotTerminal.find(c.terminalId) : null
  const tableId = terminal?.priceTableId ?? normalizePaymentSettings(portal.payment).priceTableId
  const table = tableId !== null ? await HotspotPriceTable.find(tableId) : null
  let durationSeconds = 0
  let quotaBytes: number | null = null
  let downKbps: number | null = null
  let upKbps: number | null = null
  let durationMode: DurationMode = table?.durationMode ?? 'wall_clock'
  if (input.minutes) {
    durationSeconds = input.minutes * 60
  } else if (table) {
    const r = priceEntitlement(priceTableWire(table), num(c.amount))
    durationSeconds = r.durationSeconds
    quotaBytes = r.quotaBytes
    downKbps = r.downKbps
    upKbps = r.upKbps
    durationMode = r.durationMode
  }
  if (durationSeconds <= 0) {
    throw new PortalError(
      422,
      'below_minimum',
      'The amount buys nothing under the current price table: give `minutes`.'
    )
  }
  const code = generateVoucherCode()
  const now = Date.now()
  await db.transaction(async (trx) => {
    const voucherId = await mintPaymentVoucher(trx, {
      portalId: portal.id,
      name: `Credit for checkout ${id}`,
      code,
      durationMode,
      durationSeconds,
      quotaBytes,
      downKbps,
      upKbps,
      createdByUserId: userId,
      note: input.note ?? null,
      now,
    })
    await trx
      .from('hotspot_checkouts')
      .where('id', id)
      .update({
        state: 'credited',
        voucher_id: voucherId,
        duration_mode: durationMode,
        duration_seconds: durationSeconds,
        quota_bytes: quotaBytes,
        down_kbps: downKbps,
        up_kbps: upKbps,
        note: input.note ?? c.note,
        resolved_at: utc(now).toSQL({ includeOffset: false }),
        resolved_by_user_id: userId,
        updated_at: utc(now).toSQL({ includeOffset: false }),
      })
  })
  const delivery = await runInPortalQueue(portal.gatewayId, () =>
    sendPortalPushes(portal.gatewayId, [{ kind: 'vouchers' }])
  )
  return { checkout: await showCheckout(id), code: formatVoucherCode(code), delivery }
}

export async function dismissCheckout(
  id: number,
  input: { note?: string | null },
  userId: number | null
): Promise<CheckoutView> {
  const c = await openUnclaimed(id)
  c.state = 'dismissed'
  c.note = input.note ?? c.note
  c.resolvedAt = DateTime.utc()
  c.resolvedByUserId = userId
  await c.save()
  return showCheckout(id)
}

// ---------------------------------------------------------------------------
// Router configuration (portal.configure)
// ---------------------------------------------------------------------------

export type PaymentWire = {
  idleTimeoutSeconds: number
  priceTableId: number | null
  terminals: Array<{
    terminalId: number
    name: string
    token: string
    mac: string | null
    enabled: boolean
    priceTableId: number | null
  }>
  priceTables: ReturnType<typeof priceTableWire>[]
}

/**
 * The `payment` object of each portal in `portal.configure`: its terminals
 * (with their tokens: the router verifies their signatures with them) and
 * every price table they use. A terminal whose token cannot be decrypted
 * (APP_KEY changed) is left out: rotate it.
 */
export async function paymentWireFor(portals: Portal[]): Promise<Map<number, PaymentWire>> {
  const out = new Map<number, PaymentWire>()
  const paying = portals.filter((p) => p.methods?.payment)
  if (!paying.length) return out
  const terminals = await HotspotTerminal.query()
    .whereIn(
      'portal_id',
      paying.map((p) => p.id)
    )
    .orderBy('id')
  const tableIds = new Set<number>()
  for (const p of paying) {
    const id = normalizePaymentSettings(p.payment).priceTableId
    if (id !== null) tableIds.add(id)
  }
  for (const t of terminals) if (t.priceTableId !== null) tableIds.add(t.priceTableId)
  const tables = tableIds.size ? await HotspotPriceTable.query().whereIn('id', [...tableIds]) : []
  const tableById = new Map(tables.map((t) => [t.id, t]))
  for (const p of paying) {
    const settings = normalizePaymentSettings(p.payment)
    const mine = terminals.filter((t) => t.portalId === p.id && t.token !== null)
    const used = new Set<number>()
    if (settings.priceTableId !== null && tableById.has(settings.priceTableId)) {
      used.add(settings.priceTableId)
    }
    for (const t of mine)
      if (t.priceTableId !== null && tableById.has(t.priceTableId)) used.add(t.priceTableId)
    out.set(p.id, {
      idleTimeoutSeconds: settings.idleTimeoutSeconds,
      priceTableId:
        settings.priceTableId !== null && tableById.has(settings.priceTableId)
          ? settings.priceTableId
          : null,
      terminals: mine.map((t) => ({
        terminalId: t.id,
        name: t.name,
        token: t.token!,
        mac: t.mac,
        enabled: Boolean(t.enabled),
        priceTableId:
          t.priceTableId !== null && tableById.has(t.priceTableId) ? t.priceTableId : null,
      })),
      priceTables: [...used].sort((a, b) => a - b).map((id) => priceTableWire(tableById.get(id)!)),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// portal.terminals (router → controller)
// ---------------------------------------------------------------------------

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null
}

/**
 * The router's terminal report: last seen, online, acceptor state, the open
 * checkout. Rows of other gateways' portals are ignored.
 */
export async function recordTerminalReport(gatewayId: number, params: unknown): Promise<void> {
  const o = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const list = Array.isArray(o.terminals) ? (o.terminals as unknown[]).slice(0, 256) : []
  if (!list.length) return
  const portals = await Portal.query().where('gateway_id', gatewayId).select('id')
  const own = new Set(portals.map((p) => p.id))
  const now = new Date()
  for (const item of list) {
    const t = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const id =
      typeof t?.terminalId === 'number' && Number.isSafeInteger(t.terminalId) ? t.terminalId : null
    if (!t || id === null) continue
    const row = await HotspotTerminal.find(id)
    if (!row || !own.has(row.portalId)) continue
    const status =
      t.status && typeof t.status === 'object' ? (t.status as Record<string, unknown>) : {}
    const co =
      t.checkout && typeof t.checkout === 'object' ? (t.checkout as Record<string, unknown>) : null
    const lastSeen = typeof t.lastSeenAt === 'number' && t.lastSeenAt > 0 ? t.lastSeenAt : null
    row.status = {
      online: t.online === true,
      acceptor: str(status.acceptor, 8),
      firmware: str(status.firmware, 32),
      error: str(status.error, 64),
      checkout:
        co && typeof co.checkoutRef === 'string'
          ? {
              checkoutRef: co.checkoutRef.slice(0, 64),
              state: String(co.state ?? '').slice(0, 12),
              amount: typeof co.amount === 'number' ? co.amount : 0,
              openedAt: typeof co.openedAt === 'number' ? co.openedAt : null,
            }
          : null,
      at: now.toISOString(),
    }
    if (lastSeen !== null) row.lastSeenAt = utc(lastSeen)
    await row.save()
  }
}
