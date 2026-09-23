import { createHmac } from 'node:crypto'
import { VOUCHER_ALPHABET } from '#services/portal/codes'
import type { PortalGatewayKeys } from '#services/portal/crypto'
import type { DurationMode } from '#services/portal/types'

/**
 * The Paid Hotspot follow-up (docs/gateway/portal.md section 14): price
 * tables, checkout records and their reference codes, click-through limits.
 * Pure: no app imports. perch-collector (`internal/portal/hotspot*.go`)
 * implements the same functions and is tested against the vectors in
 * `tests/unit/services/portal/hotspot.spec.ts`.
 *
 * The router runs every checkout itself (so paid access works through a
 * controller outage) and journals a signed `checkout_finalized` record; the
 * controller verifies the signature and derives the guest's reference code
 * from the same record, so the code never crosses the network:
 *
 *   checkoutKey   = HMAC(gatewayKey, "perch-portal-checkout-v1")
 *   sig           = base64url(HMAC(signKey, canonical))
 *   referenceCode = 10 Crockford symbols, symbol i = VOUCHER_ALPHABET[b[i] & 31],
 *                   b = HMAC(checkoutKey, canonical)
 */

// ---------------------------------------------------------------------------
// Price tables
// ---------------------------------------------------------------------------

/**
 * One rate: `amount` (in the table's minor units, e.g. 5 = PHP 5 with
 * `decimals: 0`) buys `minutes`, optionally a data quota and a speed tier.
 */
export type PriceEntry = {
  amount: number
  minutes: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
}

export type PriceTable = {
  priceTableId: number
  revision: number
  name: string
  /** ISO 4217 code, display only (`PHP`). */
  currency: string
  /** Minor-unit digits for display: 0 = whole units, 2 = cents. */
  decimals: number
  durationMode: DurationMode
  entries: PriceEntry[]
}

export const PRICE_LIMITS = {
  entries: 32,
  amount: 1_000_000,
  minutes: 525_600,
  quotaBytes: 10_000_000_000_000,
  kbps: { min: 64, max: 10_000_000 },
  decimals: 3,
} as const

/** The most a single checkout may take (minor units). */
export const MAX_CHECKOUT_AMOUNT = 10_000_000
/** Total time a checkout may buy (one year). */
export const MAX_CHECKOUT_SECONDS = 525_600 * 60
/** Coins one checkout may take. */
export const MAX_CHECKOUT_COINS = 500

export type PriceTableError =
  | 'no_entries'
  | 'too_many_entries'
  | 'duplicate_amount'
  | 'mixed_quota'
  | 'invalid_entry'

/** Checks a table's entries; null when they are usable. */
export function validatePriceEntries(entries: readonly PriceEntry[]): PriceTableError | null {
  if (entries.length === 0) return 'no_entries'
  if (entries.length > PRICE_LIMITS.entries) return 'too_many_entries'
  const amounts = new Set<number>()
  let withQuota = 0
  for (const e of entries) {
    const intIn = (v: number, lo: number, hi: number) =>
      Number.isSafeInteger(v) && v >= lo && v <= hi
    if (!intIn(e.amount, 1, PRICE_LIMITS.amount)) return 'invalid_entry'
    if (!intIn(e.minutes, 1, PRICE_LIMITS.minutes)) return 'invalid_entry'
    if (e.quotaBytes !== null && !intIn(e.quotaBytes, 1_000_000, PRICE_LIMITS.quotaBytes))
      return 'invalid_entry'
    for (const k of [e.downKbps, e.upKbps]) {
      if (k !== null && !intIn(k, PRICE_LIMITS.kbps.min, PRICE_LIMITS.kbps.max))
        return 'invalid_entry'
    }
    if (amounts.has(e.amount)) return 'duplicate_amount'
    amounts.add(e.amount)
    if (e.quotaBytes !== null) withQuota++
  }
  if (withQuota !== 0 && withQuota !== entries.length) return 'mixed_quota'
  return null
}

/** Entries in the order the greedy fill takes them: largest amount first. */
export function sortPriceEntries(entries: readonly PriceEntry[]): PriceEntry[] {
  return [...entries].sort((a, b) => b.amount - a.amount)
}

export type PriceResult = {
  /** What was paid (minor units). */
  amount: number
  durationMode: DurationMode
  /** 0 = the amount buys nothing yet. */
  durationSeconds: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  /** Paid but below the smallest rate: bought nothing. */
  unusedAmount: number
}

/**
 * What an amount buys under a table (greedy, the coin-box convention): take
 * the largest rate that fits as often as it fits, then the next smaller one,
 * and so on. Time and data add up; the speed tier is the most expensive rate
 * taken. What is left below the smallest rate is `unusedAmount`. Time is
 * capped at one year and data at 10 TB.
 */
export function priceEntitlement(
  table: Pick<PriceTable, 'durationMode' | 'entries'>,
  amount: number
): PriceResult {
  const paid = Number.isSafeInteger(amount) && amount > 0 ? amount : 0
  let rest = paid
  let minutes = 0
  let quota = 0
  let hasQuota = false
  let tier: PriceEntry | null = null
  for (const e of sortPriceEntries(table.entries)) {
    if (e.amount <= 0 || rest < e.amount) continue
    const n = Math.floor(rest / e.amount)
    rest -= n * e.amount
    minutes += n * e.minutes
    if (e.quotaBytes !== null) {
      hasQuota = true
      quota += n * e.quotaBytes
    }
    tier ??= e
  }
  const seconds = Math.min(minutes * 60, MAX_CHECKOUT_SECONDS)
  return {
    amount: paid,
    durationMode: table.durationMode,
    durationSeconds: tier ? seconds : 0,
    quotaBytes: tier && hasQuota ? Math.min(quota, PRICE_LIMITS.quotaBytes) : null,
    downKbps: tier?.downKbps ?? null,
    upKbps: tier?.upKbps ?? null,
    unusedAmount: rest,
  }
}

// ---------------------------------------------------------------------------
// Checkout records
// ---------------------------------------------------------------------------

export const CHECKOUT_RECORD_TAG = 'perch-portal-checkout-v1'
const CHECKOUT_SUBKEY_LABEL = 'perch-portal-checkout-v1'
export const REFERENCE_CODE_LENGTH = 10

export const CHECKOUT_REASONS = ['done', 'timeout', 'terminal'] as const
export type CheckoutReason = (typeof CHECKOUT_REASONS)[number]

export const CHECKOUT_REF_REGEX = /^[A-Za-z0-9._:-]{1,64}$/
export const CURRENCY_REGEX = /^[A-Z]{3}$/
const MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/** The signed facts of one finalized checkout (router → controller). */
export type CheckoutRecord = {
  checkoutRef: string
  portalId: number
  terminalId: number
  mac: string
  amount: number
  currency: string
  priceTableId: number
  priceRevision: number
  durationMode: DurationMode
  durationSeconds: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  openedAt: number
  finalizedAt: number
  reason: CheckoutReason
  /** The router's reference of the grant it made for the paying device. */
  localRef: string
  unusedAmount: number
  coinCount: number
}

function field(value: number | string | null, name: string): string {
  if (value === null) return ''
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`${name}: not a non-negative integer`)
    return String(value)
  }
  if (!/^[A-Za-z0-9._:-]{0,64}$/.test(value)) throw new Error(`${name}: not a canonical token`)
  return value
}

/** Canonical text of a checkout record (docs/gateway/portal.md 14.4). */
export function canonicalCheckout(keys: PortalGatewayKeys, r: CheckoutRecord): string {
  if (!CHECKOUT_REF_REGEX.test(r.checkoutRef)) throw new Error('checkoutRef: invalid')
  if (!CHECKOUT_REF_REGEX.test(r.localRef)) throw new Error('localRef: invalid')
  if (!MAC_REGEX.test(r.mac)) throw new Error('mac: invalid')
  if (!CURRENCY_REGEX.test(r.currency)) throw new Error('currency: invalid')
  if (!(CHECKOUT_REASONS as readonly string[]).includes(r.reason))
    throw new Error('reason: invalid')
  if (r.durationMode !== 'wall_clock' && r.durationMode !== 'active_time')
    throw new Error('durationMode: invalid')
  const fields: Array<[string, number | string | null]> = [
    ['checkoutRef', r.checkoutRef],
    ['portalId', r.portalId],
    ['terminalId', r.terminalId],
    ['mac', r.mac],
    ['amount', r.amount],
    ['currency', r.currency],
    ['priceTableId', r.priceTableId],
    ['priceRevision', r.priceRevision],
    ['durationMode', r.durationMode],
    ['durationSeconds', r.durationSeconds],
    ['quotaBytes', r.quotaBytes],
    ['downKbps', r.downKbps],
    ['upKbps', r.upKbps],
    ['openedAt', r.openedAt],
    ['finalizedAt', r.finalizedAt],
    ['reason', r.reason],
    ['localRef', r.localRef],
    ['unusedAmount', r.unusedAmount],
    ['coinCount', r.coinCount],
  ]
  return [
    CHECKOUT_RECORD_TAG,
    String(keys.gatewayId),
    String(keys.epoch),
    ...fields.map(([n, v]) => field(v, n)),
  ].join('\n')
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

export function checkoutKey(keys: PortalGatewayKeys): Buffer {
  return hmac(keys.gatewayKey, CHECKOUT_SUBKEY_LABEL)
}

/** base64url (no padding) HMAC of the record under the gateway's signKey. */
export function signCheckout(keys: PortalGatewayKeys, r: CheckoutRecord): string {
  return hmac(keys.signKey, canonicalCheckout(keys, r)).toString('base64url')
}

/**
 * The guest's reference code for a checkout: 10 Crockford symbols (50 bits)
 * from HMAC(checkoutKey, canonical). Both sides compute it; it is never sent.
 */
export function checkoutReferenceCode(keys: PortalGatewayKeys, r: CheckoutRecord): string {
  const b = hmac(checkoutKey(keys), canonicalCheckout(keys, r))
  let code = ''
  for (let i = 0; i < REFERENCE_CODE_LENGTH; i++) code += VOUCHER_ALPHABET[b[i] & 31]
  return code
}

// ---------------------------------------------------------------------------
// Portal settings of the two methods
// ---------------------------------------------------------------------------

/** `portals.payment`: the checkout method's settings. */
export type PaymentSettings = {
  /** The portal's price table (a terminal may override it). */
  priceTableId: number | null
  /** A checkout without a coin for this long closes (with credit: finalized). */
  idleTimeoutSeconds: number
}

export const PAYMENT_DEFAULTS: PaymentSettings = { priceTableId: null, idleTimeoutSeconds: 60 }
export const PAYMENT_LIMITS = { idleTimeoutSeconds: { min: 15, max: 600 } } as const

/** `portals.click_through`: free access after accepting the terms (decision 32). */
export type ClickThroughSettings = {
  minutes: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  /** At most `perWindow` grants per device in any `windowHours`. */
  windowHours: number
  perWindow: number
  terms: string
}

export const CLICK_THROUGH_DEFAULTS: ClickThroughSettings = {
  minutes: 30,
  quotaBytes: null,
  downKbps: null,
  upKbps: null,
  windowHours: 24,
  perWindow: 1,
  terms: '',
}
export const CLICK_THROUGH_LIMITS = {
  minutes: { min: 1, max: 1440 },
  windowHours: { min: 1, max: 720 },
  perWindow: { min: 1, max: 24 },
  terms: 4000,
} as const

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function optInt(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

/** A stored value read defensively (wrong types read as the default). */
export function normalizePaymentSettings(value: unknown): PaymentSettings {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const id = o.priceTableId
  return {
    priceTableId: typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null,
    idleTimeoutSeconds: clampInt(
      o.idleTimeoutSeconds,
      PAYMENT_DEFAULTS.idleTimeoutSeconds,
      PAYMENT_LIMITS.idleTimeoutSeconds.min,
      PAYMENT_LIMITS.idleTimeoutSeconds.max
    ),
  }
}

export function normalizeClickThroughSettings(value: unknown): ClickThroughSettings {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const d = CLICK_THROUGH_DEFAULTS
  const L = CLICK_THROUGH_LIMITS
  return {
    minutes: clampInt(o.minutes, d.minutes, L.minutes.min, L.minutes.max),
    quotaBytes: optInt(o.quotaBytes, 1_000_000, PRICE_LIMITS.quotaBytes),
    downKbps: optInt(o.downKbps, PRICE_LIMITS.kbps.min, PRICE_LIMITS.kbps.max),
    upKbps: optInt(o.upKbps, PRICE_LIMITS.kbps.min, PRICE_LIMITS.kbps.max),
    windowHours: clampInt(o.windowHours, d.windowHours, L.windowHours.min, L.windowHours.max),
    perWindow: clampInt(o.perWindow, d.perWindow, L.perWindow.min, L.perWindow.max),
    terms: typeof o.terms === 'string' ? o.terms.slice(0, L.terms) : '',
  }
}

// ---------------------------------------------------------------------------
// Terminal tokens and request signatures
// ---------------------------------------------------------------------------

/** `perch_pt_` + 32 base64url characters (192 bits). */
export const TERMINAL_TOKEN_PREFIX = 'perch_pt_'
export const TERMINAL_TOKEN_REGEX = /^perch_pt_[A-Za-z0-9_-]{32}$/
export const TERMINAL_REQUEST_TAG = 'perch-terminal-v1'

/**
 * The string a terminal signs for each request (docs 14.6), with the token
 * as the HMAC key: the token itself never crosses the guest network.
 */
export function terminalSigningString(r: {
  method: string
  path: string
  terminalId: number
  session: string
  seq: number
  bodySha256Hex: string
}): string {
  return [
    TERMINAL_REQUEST_TAG,
    r.method.toUpperCase(),
    r.path,
    String(r.terminalId),
    r.session,
    String(r.seq),
    r.bodySha256Hex,
  ].join('\n')
}

export function signTerminalRequest(
  token: string,
  r: Parameters<typeof terminalSigningString>[0]
): string {
  return createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(terminalSigningString(r), 'utf8')
    .digest('base64url')
}

// ---------------------------------------------------------------------------
// Display texts (the router's guest pages use the same rules, section 14.8)
// ---------------------------------------------------------------------------

/** `PHP 5`, `USD 1.25` (amount in minor units). */
export function moneyText(amount: number, currency: string, decimals: number): string {
  const a = Math.max(0, Math.trunc(amount))
  if (decimals <= 0) return `${currency} ${a}`
  const unit = 10 ** decimals
  return `${currency} ${Math.floor(a / unit)}.${String(a % unit).padStart(decimals, '0')}`
}

/** `45 min`, `1 h 30 min`, `2 d 3 h`. */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds))
  if (s <= 0) return '0 min'
  if (s < 3600) return `${Math.ceil(s / 60)} min`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m > 0 ? `${h} h ${m} min` : `${h} h`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return h > 0 ? `${d} d ${h} h` : `${d} d`
}

function oneDecimal(v: number): string {
  // Go's %.1f rounds half to even on the binary value; format both sides
  // from an integer count of tenths instead.
  const tenths = Math.round(v * 10)
  return tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)}.${tenths % 10}`
}

/** `500 MB`, `1.5 GB` (1000-based). */
export function bytesText(bytes: number): string {
  const b = Math.max(0, Math.trunc(bytes))
  if (b < 1000) return `${b} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let v = b / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${oneDecimal(v)} ${units[i]}`
}

/** `5 Mbit/s`, `1.5 Mbit/s`, `512 kbit/s`. */
export function speedText(kbps: number): string {
  return kbps >= 1000 ? `${oneDecimal(kbps / 1000)} Mbit/s` : `${Math.trunc(kbps)} kbit/s`
}

/** `1 h 20 min · 500 MB · 5 Mbit/s down`. */
export function entitlementText(
  seconds: number,
  quotaBytes: number | null,
  downKbps: number | null
): string {
  const parts = [durationText(seconds)]
  if (quotaBytes !== null) parts.push(bytesText(quotaBytes))
  if (downKbps !== null) parts.push(`${speedText(downKbps)} down`)
  return parts.join(' · ')
}

/** What the running total buys so far, as the checkout panel shows it. */
export function previewText(result: PriceResult, currency: string, decimals: number): string {
  if (result.durationSeconds > 0) {
    const unused =
      result.unusedAmount > 0
        ? ` (${moneyText(result.unusedAmount, currency, decimals)} unused)`
        : ''
    return entitlementText(result.durationSeconds, result.quotaBytes, result.downKbps) + unused
  }
  return result.amount === 0 ? 'Insert coins' : 'Not enough for a rate yet'
}

/** One line of the rates list: `PHP 5: 1 h · 5 Mbit/s down`. */
export function rateText(e: PriceEntry, currency: string, decimals: number): string {
  return `${moneyText(e.amount, currency, decimals)}: ${entitlementText(e.minutes * 60, e.quotaBytes, e.downKbps)}`
}
