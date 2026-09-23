import type HotspotCheckout from '#models/hotspot_checkout'
import type HotspotPriceTable from '#models/hotspot_price_table'
import type HotspotTerminal from '#models/hotspot_terminal'
import type { HotspotCoin } from '#models/hotspot_checkout'
import {
  type PriceEntry,
  type PriceTable,
  moneyText,
  normalizeClickThroughSettings,
  normalizePaymentSettings,
} from '#services/portal/hotspot'
import type { VoucherStatus } from '#services/portal/redemption'
import { iso } from '#transformers/portal'

/**
 * Response shapes of the Paid Hotspot REST API (docs/gateway/portal.md
 * section 14.9). Times are ISO strings in UTC; amounts are integers in the
 * table's minor units, with a display text next to them.
 */

const num = (v: bigint | number | null | undefined): number => Number(v ?? 0)
const numOrNull = (v: bigint | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v)

// ---------------------------------------------------------------------------
// Price tables
// ---------------------------------------------------------------------------

export type PriceTableView = {
  id: number
  name: string
  currency: string
  decimals: number
  durationMode: 'wall_clock' | 'active_time'
  entries: Array<PriceEntry & { amountText: string }>
  revision: number
  usedBy: { portalIds: number[]; terminalIds: number[] }
  createdAt: string | null
  updatedAt: string | null
}

export function priceTableView(
  t: HotspotPriceTable,
  usedBy: PriceTableView['usedBy']
): PriceTableView {
  return {
    id: t.id,
    name: t.name,
    currency: t.currency,
    decimals: t.decimals,
    durationMode: t.durationMode,
    entries: (t.entries ?? []).map((e) => ({
      ...e,
      amountText: moneyText(e.amount, t.currency, t.decimals),
    })),
    revision: t.revision,
    usedBy,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  }
}

/** The wire/pure form of a table row (what the router gets). */
export function priceTableWire(t: HotspotPriceTable): PriceTable {
  return {
    priceTableId: t.id,
    revision: t.revision,
    name: t.name,
    currency: t.currency,
    decimals: t.decimals,
    durationMode: t.durationMode,
    entries: (t.entries ?? []).map((e) => ({
      amount: e.amount,
      minutes: e.minutes,
      quotaBytes: e.quotaBytes ?? null,
      downKbps: e.downKbps ?? null,
      upKbps: e.upKbps ?? null,
    })),
  }
}

export type PriceRevisionView = {
  revision: number
  name: string
  currency: string
  decimals: number
  durationMode: 'wall_clock' | 'active_time'
  entries: PriceEntry[]
  createdAt: string | null
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/** A report older than this reads as offline (the router reports every 30 s). */
export const TERMINAL_STALE_MS = 90_000

export type TerminalView = {
  id: number
  portalId: number
  name: string
  /** `perch_pt_` + 4 characters: recognizes a token, useless to guess it. */
  prefix: string
  mac: string | null
  enabled: boolean
  priceTableId: number | null
  /** Its own table, else the portal's. */
  effectivePriceTableId: number | null
  online: boolean
  lastSeenAt: string | null
  status: {
    acceptor: string | null
    firmware: string | null
    error: string | null
    checkout: { checkoutRef: string; state: string; amount: number; openedAt: string | null } | null
    reportedAt: string | null
  } | null
  /** False after an APP_KEY change: rotate the token. */
  tokenRecoverable: boolean
  createdAt: string | null
  updatedAt: string | null
}

export function terminalView(
  t: HotspotTerminal,
  portalPriceTableId: number | null,
  now: number = Date.now()
): TerminalView {
  const s = t.status
  const reportedAt = s?.at ? Date.parse(s.at) : Number.NaN
  const fresh = Number.isFinite(reportedAt) && now - reportedAt <= TERMINAL_STALE_MS
  return {
    id: t.id,
    portalId: t.portalId,
    name: t.name,
    prefix: t.tokenPrefix,
    mac: t.mac,
    enabled: Boolean(t.enabled),
    priceTableId: t.priceTableId,
    effectivePriceTableId: t.priceTableId ?? portalPriceTableId,
    online: Boolean(fresh && s?.online),
    lastSeenAt: iso(t.lastSeenAt),
    status: s
      ? {
          acceptor: s.acceptor ?? null,
          firmware: s.firmware ?? null,
          error: s.error ?? null,
          checkout: s.checkout
            ? {
                checkoutRef: s.checkout.checkoutRef,
                state: s.checkout.state,
                amount: s.checkout.amount,
                openedAt:
                  s.checkout.openedAt === null ? null : new Date(s.checkout.openedAt).toISOString(),
              }
            : null,
          reportedAt: s.at ?? null,
        }
      : null,
    tokenRecoverable: t.token !== null,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type CheckoutView = {
  id: number
  kind: 'payment' | 'unclaimed'
  state: 'paid' | 'voided' | 'unclaimed' | 'credited' | 'dismissed'
  gatewayId: number
  portalId: number | null
  terminal: { id: number | null; name: string | null }
  checkoutRef: string | null
  mac: string | null
  ip: string | null
  hostname: string | null
  amount: number
  amountText: string | null
  unusedAmount: number
  refundAmount: number | null
  currency: string | null
  decimals: number | null
  price: {
    priceTableId: number | null
    revision: number | null
    snapshot: PriceTable | null
  } | null
  entitlement: {
    durationMode: string | null
    durationSeconds: number | null
    quotaBytes: number | null
    downKbps: number | null
    upKbps: number | null
  } | null
  coinCount: number
  coins: HotspotCoin[]
  /** done | timeout | terminal (payments); late | full | below_minimum (unclaimed). */
  reason: string | null
  openedAt: string | null
  finalizedAt: string | null
  /** The voucher minted from the payment (its reference code), or credited for unclaimed coins. */
  voucher: { id: number; batchId: number; hint: string; status: VoucherStatus } | null
  keyEpoch: number | null
  note: string | null
  resolvedAt: string | null
  resolvedBy: { id: number; email: string } | null
  createdAt: string | null
}

export function checkoutView(
  c: HotspotCheckout,
  refs: {
    voucher: CheckoutView['voucher']
    resolvedBy: CheckoutView['resolvedBy']
  }
): CheckoutView {
  const amount = num(c.amount)
  return {
    id: num(c.id),
    kind: c.kind,
    state: c.state,
    gatewayId: c.gatewayId,
    portalId: c.portalId,
    terminal: { id: c.terminalId, name: c.terminalName },
    checkoutRef: c.checkoutRef,
    mac: c.mac,
    ip: c.ip,
    hostname: c.hostname,
    amount,
    amountText: c.currency ? moneyText(amount, c.currency, c.decimals ?? 0) : null,
    unusedAmount: num(c.unusedAmount),
    refundAmount: numOrNull(c.refundAmount),
    currency: c.currency,
    decimals: c.decimals,
    price:
      c.kind === 'payment'
        ? { priceTableId: c.priceTableId, revision: c.priceRevision, snapshot: c.priceSnapshot }
        : null,
    entitlement:
      c.kind === 'payment' || c.voucherId !== null
        ? {
            durationMode: c.durationMode,
            durationSeconds: c.durationSeconds,
            quotaBytes: numOrNull(c.quotaBytes),
            downKbps: c.downKbps,
            upKbps: c.upKbps,
          }
        : null,
    coinCount: c.coinCount,
    coins: c.coins ?? [],
    reason: c.reason,
    openedAt: iso(c.openedAt),
    finalizedAt: iso(c.finalizedAt),
    voucher: refs.voucher,
    keyEpoch: c.keyEpoch,
    note: c.note,
    resolvedAt: iso(c.resolvedAt),
    resolvedBy: refs.resolvedBy,
    createdAt: iso(c.createdAt),
  }
}

// ---------------------------------------------------------------------------
// Portal method settings (part of the Portal view)
// ---------------------------------------------------------------------------

export function portalHotspotSettings(p: { payment: unknown; clickThrough: unknown }) {
  return {
    payment: normalizePaymentSettings(p.payment),
    clickThrough: normalizeClickThroughSettings(p.clickThrough),
  }
}
