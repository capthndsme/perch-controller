import HotspotTerminal from '#models/hotspot_terminal'
import Portal from '#models/portal'
import { portalGatewayKeys } from '#services/portal_keys'
import { mintPaymentVoucher } from '#services/portal_hotspot'
import { utc } from '#services/portal_grants'
import { signatureMatches } from '#services/portal/crypto'
import {
  type CheckoutRecord,
  CHECKOUT_REASONS,
  CHECKOUT_REF_REGEX,
  CURRENCY_REGEX,
  checkoutReferenceCode,
  signCheckout,
} from '#services/portal/hotspot'
import type { RouterEvent, RouterPortalReport } from '#services/portal/reconcile'
import { normalizeMac } from '#services/portal/types'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * The Paid Hotspot's part of reconciliation (docs/gateway/portal.md section
 * 14.5), run on each `portal.sync` report **before** `loadServerPortalState`
 * and `reconcile`, in the gateway's portal queue:
 *
 * - `checkout_finalized`: the signature is checked against the gateway's key
 *   at the event's epoch; the reference code is derived from the same record
 *   (it never crossed the network); a `payment` voucher with that code and
 *   the ledger row are written (once: `event_key` is unique per gateway).
 *   The event then goes on as an ordinary `offline_redeemed` of that voucher,
 *   so reconciliation binds, clocks and places it exactly like a voucher the
 *   router redeemed offline (the router's grant keeps its localRef).
 * - `offline_redeemed` with `checkoutRef` and no voucher id (the reference
 *   code redeemed on another device before the controller knew it): the
 *   voucher id is filled in from the ledger.
 * - `checkout_unclaimed`: a ledger row for money the router could not credit.
 * - `clickthrough_granted`: the free grant is written as a `g:` grant with
 *   the router's localRef (decision 32); reconciliation then treats it like
 *   any grant the router holds.
 *
 * Everything is idempotent: a report replayed after a failed apply finds its
 * rows and transforms the events the same way. Events that fail a check are
 * logged (`checkout_rejected`) and dropped.
 */

type Raw = Record<string, unknown>

const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null
const nonNeg = (v: unknown): number | null => {
  const n = int(v)
  return n !== null && n >= 0 ? n : null
}
const optNonNeg = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : (nonNeg(v) ?? undefined)
const str = (v: unknown, max = 64): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
const sqlTime = (ms: number | null) =>
  ms === null ? null : utc(ms).toSQL({ includeOffset: false })

const HOTSPOT_TYPES = new Set(['checkout_finalized', 'checkout_unclaimed', 'clickthrough_granted'])

/** The record a `checkout_finalized` event carries, or why it is not one. */
export function checkoutRecordOf(e: Raw): { record: CheckoutRecord } | { error: string } {
  const mac = typeof e.mac === 'string' ? normalizeMac(e.mac) : null
  const record = {
    checkoutRef: str(e.checkoutRef),
    portalId: int(e.portalId),
    terminalId: int(e.terminalId),
    mac,
    amount: nonNeg(e.amount),
    currency: typeof e.currency === 'string' ? e.currency : null,
    priceTableId: nonNeg(e.priceTableId),
    priceRevision: nonNeg(e.priceRevision),
    durationMode: e.durationMode,
    durationSeconds: nonNeg(e.durationSeconds),
    quotaBytes: optNonNeg(e.quotaBytes),
    downKbps: optNonNeg(e.downKbps),
    upKbps: optNonNeg(e.upKbps),
    openedAt: nonNeg(e.openedAt),
    finalizedAt: nonNeg(e.finalizedAt),
    reason: e.reason,
    localRef: str(e.localRef),
    unusedAmount: nonNeg(e.unusedAmount),
    coinCount: nonNeg(e.coinCount),
  }
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || (v === null && !['quotaBytes', 'downKbps', 'upKbps'].includes(k))) {
      return { error: `bad_${k}` }
    }
  }
  if (!CHECKOUT_REF_REGEX.test(record.checkoutRef!) || !CHECKOUT_REF_REGEX.test(record.localRef!))
    return { error: 'bad_ref' }
  if (!CURRENCY_REGEX.test(record.currency!)) return { error: 'bad_currency' }
  if (record.durationMode !== 'wall_clock' && record.durationMode !== 'active_time')
    return { error: 'bad_durationMode' }
  if (!(CHECKOUT_REASONS as readonly unknown[]).includes(record.reason))
    return { error: 'bad_reason' }
  if (record.amount! < 1 || record.durationSeconds! < 1) return { error: 'nothing_bought' }
  return { record: record as CheckoutRecord }
}

async function logEvent(
  trx: TransactionClientContract | null,
  gatewayId: number,
  type: string,
  detail: Record<string, unknown>,
  refs: { portalId?: number | null; mac?: string | null; at?: number } = {}
) {
  await (trx ?? db).table('portal_events').insert({
    gateway_id: gatewayId,
    portal_id: refs.portalId ?? null,
    grant_id: null,
    mac: refs.mac ?? null,
    type,
    detail: JSON.stringify(detail),
    created_at: sqlTime(refs.at ?? Date.now()),
  })
}

type Ctx = {
  gatewayId: number
  keyEpoch: number
  /** The gateway's portals (deleted ones too: history still names them). */
  portals: Map<number, Portal>
  now: number
}

async function priceSnapshot(trx: TransactionClientContract, tableId: number, revision: number) {
  const row = (await trx
    .from('hotspot_price_revisions')
    .where('price_table_id', tableId)
    .where('revision', revision)
    .first()) as Raw | null
  if (!row) return null
  return JSON.stringify({
    priceTableId: tableId,
    revision,
    name: row.name,
    currency: row.currency,
    decimals: Number(row.decimals),
    durationMode: row.duration_mode,
    entries: JSON.parse(String(row.entries)),
  })
}

/** Returns the voucher id the finalized checkout is redeemed as, or null (rejected). */
async function ingestCheckout(ctx: Ctx, e: Raw): Promise<number | null> {
  const parsed = checkoutRecordOf(e)
  const portalId = int(e.portalId)
  const reject = async (reason: string, extra: Raw = {}) => {
    await logEvent(
      null,
      ctx.gatewayId,
      'checkout_rejected',
      { seq: e.seq, checkoutRef: e.checkoutRef ?? null, reason, ...extra },
      { portalId: portalId !== null && ctx.portals.has(portalId) ? portalId : null }
    )
    logger.warn(
      { gatewayId: ctx.gatewayId, reason, checkoutRef: e.checkoutRef },
      'hotspot: checkout rejected'
    )
    return null
  }
  if ('error' in parsed) return reject(parsed.error)
  const r = parsed.record
  const portal = ctx.portals.get(r.portalId)
  if (!portal) return reject('unknown_portal')
  const epoch = int(e.keyEpoch)
  if (epoch === null || epoch < 1 || epoch > ctx.keyEpoch)
    return reject('bad_key_epoch', { keyEpoch: epoch })
  const keys = portalGatewayKeys(ctx.gatewayId, epoch)
  if (!signatureMatches(signCheckout(keys, r), e.sig)) return reject('bad_signature')
  const code = checkoutReferenceCode(keys, r)
  const eventKey = `checkout:${r.checkoutRef}`

  return db.transaction(async (trx) => {
    const existing = (await trx
      .from('hotspot_checkouts')
      .where('gateway_id', ctx.gatewayId)
      .where('event_key', eventKey)
      .forUpdate()
      .first()) as Raw | null
    if (existing) return existing.voucher_id === null ? null : Number(existing.voucher_id)
    const terminal = await HotspotTerminal.find(r.terminalId, { client: trx })
    const voucherId = await mintPaymentVoucher(trx, {
      portalId: r.portalId,
      name: `Payment ${r.checkoutRef}`,
      code,
      durationMode: r.durationMode,
      durationSeconds: r.durationSeconds,
      quotaBytes: r.quotaBytes,
      downKbps: r.downKbps,
      upKbps: r.upKbps,
      createdByUserId: null,
      now: ctx.now,
    })
    const coins = Array.isArray(e.coins)
      ? (e.coins as unknown[])
          .slice(0, 500)
          .map((c) => (c && typeof c === 'object' ? (c as Raw) : {}))
          .map((c) => ({
            eventId: String(c.eventId ?? '').slice(0, 64),
            amount: nonNeg(c.amount) ?? 0,
            at: nonNeg(c.at) ?? 0,
          }))
      : []
    const snapshot = await priceSnapshot(trx, r.priceTableId, r.priceRevision)
    // Display digits: the locked revision's, else the table's today, else whole units.
    const current = snapshot
      ? null
      : ((await trx.from('hotspot_price_tables').where('id', r.priceTableId).first()) as Raw | null)
    const decimals = snapshot
      ? (JSON.parse(snapshot).decimals as number)
      : current
        ? Number(current.decimals)
        : 0
    await trx.table('hotspot_checkouts').insert({
      gateway_id: ctx.gatewayId,
      portal_id: r.portalId,
      terminal_id: terminal && terminal.portalId === r.portalId ? terminal.id : null,
      terminal_name: terminal?.name ?? null,
      kind: 'payment',
      state: 'paid',
      event_key: eventKey,
      checkout_ref: r.checkoutRef,
      mac: r.mac,
      ip: str(e.ip, 45),
      hostname: str(e.hostname, 255),
      amount: r.amount,
      unused_amount: r.unusedAmount,
      currency: r.currency,
      decimals,
      price_table_id: r.priceTableId,
      price_revision: r.priceRevision,
      price_snapshot: snapshot,
      duration_mode: r.durationMode,
      duration_seconds: r.durationSeconds,
      quota_bytes: r.quotaBytes,
      down_kbps: r.downKbps,
      up_kbps: r.upKbps,
      coin_count: r.coinCount,
      coins: JSON.stringify(coins),
      reason: r.reason,
      opened_at: sqlTime(r.openedAt),
      finalized_at: sqlTime(r.finalizedAt),
      key_epoch: epoch,
      router_sig: String(e.sig),
      voucher_id: voucherId,
      created_at: sqlTime(ctx.now),
      updated_at: sqlTime(ctx.now),
    })
    await logEvent(
      trx,
      ctx.gatewayId,
      'checkout_recorded',
      {
        seq: e.seq,
        checkoutRef: r.checkoutRef,
        terminalId: r.terminalId,
        amount: r.amount,
        currency: r.currency,
        voucherId,
        reason: r.reason,
      },
      { portalId: r.portalId, mac: r.mac, at: r.finalizedAt }
    )
    return voucherId
  })
}

async function ingestUnclaimed(ctx: Ctx, e: Raw): Promise<void> {
  const terminalId = int(e.terminalId)
  const amount = nonNeg(e.amount)
  const portalId = int(e.portalId)
  const eventId = typeof e.eventId === 'string' ? e.eventId.slice(0, 64) : ''
  const checkoutRef = str(e.checkoutRef)
  if (terminalId === null || amount === null || amount < 1 || (!eventId && !checkoutRef)) {
    await logEvent(null, ctx.gatewayId, 'checkout_rejected', {
      seq: e.seq,
      reason: 'bad_unclaimed',
    })
    return
  }
  const eventKey = eventId ? `coin:${terminalId}:${eventId}` : `below:${checkoutRef}`
  const terminal = await HotspotTerminal.find(terminalId)
  const currency =
    typeof e.currency === 'string' && CURRENCY_REGEX.test(e.currency) ? e.currency : null
  const reason = str(e.reason, 16)
  await db.rawQuery(
    `INSERT IGNORE INTO hotspot_checkouts
       (gateway_id, portal_id, terminal_id, terminal_name, kind, state, event_key, checkout_ref,
        mac, amount, currency, coin_count, coins, reason, finalized_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'unclaimed', 'unclaimed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.gatewayId,
      portalId !== null && ctx.portals.has(portalId) ? portalId : null,
      terminal ? terminal.id : null,
      terminal?.name ?? null,
      eventKey,
      checkoutRef,
      typeof e.mac === 'string' ? normalizeMac(e.mac) : null,
      amount,
      currency,
      eventId ? 1 : 0,
      eventId ? JSON.stringify([{ eventId, amount, at: int(e.at) ?? ctx.now }]) : null,
      reason,
      sqlTime(int(e.at) ?? ctx.now),
      sqlTime(ctx.now),
      sqlTime(ctx.now),
    ] as never[]
  )
}

async function ingestClickThrough(ctx: Ctx, e: Raw): Promise<void> {
  const portalId = int(e.portalId)
  const localRef = str(e.localRef)
  const mac = typeof e.mac === 'string' ? normalizeMac(e.mac) : null
  const startsAt = nonNeg(e.startsAt)
  const expiresAt = nonNeg(e.expiresAt)
  const duration = nonNeg(e.durationSeconds)
  if (
    portalId === null ||
    !ctx.portals.has(portalId) ||
    !localRef ||
    !CHECKOUT_REF_REGEX.test(localRef) ||
    !mac ||
    expiresAt === null
  ) {
    await logEvent(null, ctx.gatewayId, 'clickthrough_rejected', {
      seq: e.seq,
      localRef: e.localRef ?? null,
    })
    return
  }
  await db.transaction(async (trx) => {
    const existing = await trx
      .from('portal_grants')
      .where('portal_id', portalId)
      .where('local_ref', localRef)
      .first()
    if (existing) return
    const at = int(e.at) ?? ctx.now
    const [id] = await trx.table('portal_grants').insert({
      portal_id: portalId,
      mac,
      ip: str(e.ip, 45),
      hostname: str(e.hostname, 255),
      source: 'clickthrough',
      group_key: 'g:0',
      local_ref: localRef,
      duration_mode: 'wall_clock',
      started_at: null,
      expires_at: sqlTime(expiresAt),
      time_budget_seconds: duration,
      time_used_seconds: 0,
      quota_bytes: optNonNeg(e.quotaBytes) ?? null,
      bytes_up: 0,
      bytes_down: 0,
      down_kbps: optNonNeg(e.downKbps) ?? null,
      up_kbps: optNonNeg(e.upKbps) ?? null,
      state: 'pending_device',
      delivery: 'pending',
      revision: 1,
      created_at: sqlTime(startsAt ?? at),
      updated_at: sqlTime(ctx.now),
    })
    await trx
      .from('portal_grants')
      .where('id', Number(id))
      .update({ group_key: `g:${Number(id)}` })
    await trx.table('portal_events').insert({
      gateway_id: ctx.gatewayId,
      portal_id: portalId,
      grant_id: Number(id),
      mac,
      type: 'clickthrough_granted',
      detail: JSON.stringify({ seq: e.seq, localRef, expiresAt }),
      created_at: sqlTime(at),
    })
  })
}

/**
 * Materializes the hotspot events of a report and returns the report
 * reconciliation should see: payment checkouts as `offline_redeemed`, the
 * other hotspot events removed.
 */
export async function materializeHotspotEvents(
  gatewayId: number,
  report: RouterPortalReport,
  options: { ackedEventSeq: number; keyEpoch: number; now?: number }
): Promise<RouterPortalReport> {
  const journalReset = report.lastEventSeq < options.ackedEventSeq
  const floor = journalReset ? -1 : options.ackedEventSeq
  const relevant = report.events.some((e) => {
    const t = (e as { type: string }).type
    return HOTSPOT_TYPES.has(t) || (t === 'offline_redeemed' && !(e as Raw).voucherId)
  })
  if (!relevant) return report
  const portalRows = await Portal.query().where('gateway_id', gatewayId)
  const ctx: Ctx = {
    gatewayId,
    keyEpoch: options.keyEpoch,
    portals: new Map(portalRows.map((p) => [p.id, p])),
    now: options.now ?? Date.now(),
  }
  const events: RouterEvent[] = []
  for (const ev of [...report.events].sort((a, b) => a.seq - b.seq)) {
    const e = ev as unknown as Raw
    const type = e.type as string
    // Events the controller already acknowledged: reconcile skips them too.
    const fresh = ev.seq > floor
    if (type === 'checkout_finalized') {
      if (!fresh) continue
      const voucherId = await ingestCheckout(ctx, e)
      if (voucherId === null) continue
      events.push({
        type: 'offline_redeemed',
        seq: ev.seq,
        at: ev.at,
        portalId: ev.portalId,
        mac: ev.mac,
        voucherId,
        localRef: String(e.localRef),
        placement: (e.placement as 'current' | 'queue' | 'swap') ?? 'current',
        demotedGrantId: int(e.demotedGrantId),
        demotedLocalRef: str(e.demotedLocalRef),
        startsAt: int(e.startsAt),
        expiresAt: int(e.expiresAt),
        ip: str(e.ip, 45),
        hostname: str(e.hostname, 255),
      })
    } else if (type === 'checkout_unclaimed') {
      if (fresh) await ingestUnclaimed(ctx, e)
    } else if (type === 'clickthrough_granted') {
      if (fresh) await ingestClickThrough(ctx, e)
    } else if (type === 'offline_redeemed' && !e.voucherId && typeof e.checkoutRef === 'string') {
      const row = (await db
        .from('hotspot_checkouts')
        .where('gateway_id', gatewayId)
        .where('event_key', `checkout:${e.checkoutRef}`)
        .first()) as Raw | null
      if (!row || row.voucher_id === null) {
        if (fresh) {
          await logEvent(null, gatewayId, 'offline_redeem_rejected', {
            seq: e.seq,
            checkoutRef: e.checkoutRef,
            localRef: e.localRef ?? null,
            reason: 'unknown_checkout',
          })
        }
        continue
      }
      events.push({ ...(ev as object), voucherId: Number(row.voucher_id) } as RouterEvent)
    } else {
      events.push(ev)
    }
  }
  return { ...report, events }
}
