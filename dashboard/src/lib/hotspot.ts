import { formatKbps, formatQuota, formatSeconds } from '@/lib/portal'
import type {
  CheckoutReason,
  Portal,
  CheckoutState,
  HotspotCheckout,
  HotspotTerminal,
  PriceDurationMode,
  PriceEntry,
  PriceTable,
} from '@/types/api'

/**
 * Pure shaping for the Paid Hotspot pages (docs/gateway/portal.md §14):
 * money in minor units, the draft pricing preview, ledger and terminal
 * labels.
 */

// ── Money ────────────────────────────────────────────────────────────────

/** `moneyText` of app/services/portal/hotspot.ts: "PHP 5", "USD 1.50". Amounts in minor units. */
export function moneyText(amount: number, currency: string | null, decimals: number | null): string {
  const a = Math.max(0, Math.trunc(amount))
  const cur = currency ?? ''
  const d = decimals ?? 0
  if (d <= 0) return `${cur} ${a}`.trim()
  const unit = 10 ** d
  return `${cur} ${Math.floor(a / unit)}.${String(a % unit).padStart(d, '0')}`.trim()
}

/** Minor units → the number an admin types ("150" with 2 decimals → "1.5"). */
export function minorToMajorText(amount: number | null | undefined, decimals: number): string {
  if (amount === null || amount === undefined) return ''
  if (decimals <= 0) return String(amount)
  return String(Number((amount / 10 ** decimals).toFixed(decimals)))
}

/**
 * The amount an admin typed ("1.50") in minor units (150 with 2 decimals).
 * undefined when empty; NaN when not a number or finer than `decimals`.
 */
export function parseMoney(text: string, decimals: number): number | undefined {
  const t = text.trim().replace(',', '.')
  if (t === '') return undefined
  if (!/^\d+(\.\d+)?$/.test(t)) return Number.NaN
  const [whole, frac = ''] = t.split('.')
  if (frac.length > decimals) return Number.NaN
  return Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || '0')
}

// ── Pricing (draft preview) ──────────────────────────────────────────────

const MAX_SECONDS = 365 * 86400
const MAX_QUOTA = 1e13

export type PriceResult = {
  amount: number
  durationSeconds: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  unusedAmount: number
}

/**
 * Mirror of the server's `priceEntitlement` for a table that is not saved
 * yet (the editor's preview). Greedy, the coin-box convention: the largest
 * rate as often as it fits, then the next smaller; minutes and data add up;
 * the speed tier is the most expensive rate taken. Saved tables are quoted
 * by the server (`POST /price-tables/:id/quote`).
 */
export function priceDraft(entries: PriceEntry[], amount: number): PriceResult {
  const paid = Number.isSafeInteger(amount) && amount > 0 ? amount : 0
  let rest = paid
  let minutes = 0
  let quota = 0
  let hasQuota = false
  let tier: PriceEntry | null = null
  for (const e of [...entries].sort((a, b) => b.amount - a.amount)) {
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
  return {
    amount: paid,
    durationSeconds: tier ? Math.min(minutes * 60, MAX_SECONDS) : 0,
    quotaBytes: tier && hasQuota ? Math.min(quota, MAX_QUOTA) : null,
    downKbps: tier?.downKbps ?? null,
    upKbps: tier?.upKbps ?? null,
    unusedAmount: rest,
  }
}

/** "1 h 20 min · 500 MB · 5 Mbps down", or null when it buys nothing. */
export function entitlementLabel(e: {
  durationSeconds: number | null
  quotaBytes: number | null
  downKbps: number | null
  upKbps?: number | null
  durationMode?: PriceDurationMode | string | null
}): string | null {
  if (!e.durationSeconds) return null
  const parts = [`${formatSeconds(e.durationSeconds)}${e.durationMode === 'active_time' ? ' of use' : ''}`]
  if (e.quotaBytes !== null) parts.push(formatQuota(e.quotaBytes))
  if (e.downKbps !== null) parts.push(`${formatKbps(e.downKbps)} down`)
  return parts.join(' · ')
}

/** One rate as a line: "1 h · 5 Mbps down". */
export function rateLabel(entry: PriceEntry, durationMode?: PriceDurationMode): string {
  return entitlementLabel({ ...entry, durationSeconds: entry.minutes * 60, durationMode }) ?? ''
}

export const DURATION_MODE_LABELS: Record<PriceDurationMode, string> = {
  wall_clock: 'Clock time',
  active_time: 'Time online',
}

/** The table's smallest amount (what the cheapest rate costs), or null without rates. */
export function minimumAmount(table: Pick<PriceTable, 'entries'>): number | null {
  if (!table.entries.length) return null
  return Math.min(...table.entries.map((e) => e.amount))
}

// ── Ledger ───────────────────────────────────────────────────────────────

export const CHECKOUT_STATE_LABELS: Record<CheckoutState, string> = {
  paid: 'Paid',
  voided: 'Voided',
  unclaimed: 'Unclaimed',
  credited: 'Credited',
  dismissed: 'Dismissed',
}

export function checkoutStateClass(state: CheckoutState): string {
  switch (state) {
    case 'paid':
      return 'border-status-good/30 bg-status-good/10 text-status-good'
    case 'unclaimed':
      return 'border-status-warning/40 bg-status-warning/10 text-foreground'
    case 'voided':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    case 'credited':
      return 'border-brand/30 bg-brand/10 text-brand'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

export const CHECKOUT_REASON_LABELS: Record<CheckoutReason, string> = {
  done: 'Guest pressed Done',
  terminal: 'Done button on the terminal',
  timeout: 'Walked away (idle timeout)',
  late: 'Coin after the checkout closed',
  full: 'Coin while the terminal was busy',
  below_minimum: 'Too little for any rate',
}

/** What the ledger row bought or was credited, as one line. */
export function checkoutBought(c: HotspotCheckout): string | null {
  if (!c.entitlement) return null
  return entitlementLabel({
    durationSeconds: c.entitlement.durationSeconds,
    quotaBytes: c.entitlement.quotaBytes,
    downKbps: c.entitlement.downKbps,
    durationMode: c.entitlement.durationMode,
  })
}

/** The amount of a row, formatted even when the server gave no text. */
export function checkoutAmount(c: Pick<HotspotCheckout, 'amount' | 'amountText' | 'currency' | 'decimals'>): string {
  return c.amountText ?? moneyText(c.amount, c.currency, c.decimals)
}

/** `YYYY-MM-DD` of a date input → the ISO instant at the start (or end) of that local day. */
export function dayBound(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const [y, m, d] = day.split('-').map(Number)
  const date = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0)
  return date.toISOString()
}

// ── Terminals ────────────────────────────────────────────────────────────

export type TerminalState = { label: string; tone: 'good' | 'busy' | 'warning' | 'muted' | 'bad'; detail: string | null }

/** Busy (a guest's checkout is open on it), idle, offline, disabled. */
export function terminalState(t: HotspotTerminal): TerminalState {
  if (!t.enabled) return { label: 'Disabled', tone: 'muted', detail: null }
  if (!t.tokenRecoverable) return { label: 'Needs a new token', tone: 'bad', detail: 'The controller key changed: rotate the token.' }
  if (!t.online) return { label: t.lastSeenAt ? 'Offline' : 'Never seen', tone: t.lastSeenAt ? 'warning' : 'muted', detail: null }
  if (t.status?.error) return { label: 'Error', tone: 'bad', detail: t.status.error }
  if (t.status?.checkout?.state === 'open') return { label: 'Busy', tone: 'busy', detail: 'A guest is paying' }
  if (t.status?.acceptor === 'off') return { label: 'Idle', tone: 'good', detail: 'Coin slot closed' }
  return { label: 'Idle', tone: 'good', detail: null }
}

export function terminalToneClass(tone: TerminalState['tone']): string {
  switch (tone) {
    case 'good':
      return 'border-status-good/30 bg-status-good/10 text-status-good'
    case 'busy':
      return 'border-brand/30 bg-brand/10 text-brand'
    case 'warning':
      return 'border-status-warning/40 bg-status-warning/10 text-foreground'
    case 'bad':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

/** The portal's guest-page address (where a terminal sends its requests), else a placeholder. */
export function routerAddress(portal: Pick<Portal, 'status'> | undefined): string {
  return portal?.status.listen ? `http://${portal.status.listen}` : 'http://192.168.x.x:2080'
}

/** The terminal protocol in the public controller docs (portal.md §14.10). */
export const TERMINAL_PROTOCOL_URL =
  'https://github.com/capthndsme/perch-controller/blob/main/docs/gateway/portal.md#1410-terminal-protocol-reference-no-firmware-ships'

/** The shell reference client of portal.md §14.10, with this terminal's id and the portal's address. */
export function terminalExample(terminalId: number | string, router: string): string {
  return [
    `ROUTER=${router} TERMINAL=${terminalId} TOKEN=perch_pt_...   # the token shown once`,
    `b64url() { base64 | tr '+/' '-_' | tr -d '=\\n'; }`,
    `sign() {   # METHOD PATH SESSION SEQ BODY`,
    `  body_sha=$(printf %s "$5" | openssl dgst -sha256 -hex | sed 's/^.*= //')`,
    `  printf 'perch-terminal-v1\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s' "$1" "$2" "$TERMINAL" "$3" "$4" "$body_sha" |`,
    `    openssl dgst -sha256 -hmac "$TOKEN" -binary | b64url`,
    `}`,
    `call() {   # METHOD PATH [BODY]`,
    `  SEQ=$((SEQ + 1))`,
    `  curl -sS -X "$1" "$ROUTER$2" -H 'Content-Type: application/json' \\`,
    `    -H "X-Perch-Terminal: $TERMINAL" -H "X-Perch-Session: $SESSION" -H "X-Perch-Seq: $SEQ" \\`,
    `    -H "X-Perch-Signature: $(sign "$1" "$2" "$SESSION" "$SEQ" "\${3:-}")" \${3:+--data-binary "$3"}`,
    `}`,
    `# 1. open a session (at boot, and after 401 session_unknown)`,
    `body="{\\"nonce\\":\\"$(openssl rand -hex 16)\\"}"`,
    `SESSION=$(curl -sS -X POST "$ROUTER/portal/v1/terminal/session" -H 'Content-Type: application/json' \\`,
    `  -H "X-Perch-Terminal: $TERMINAL" -H 'X-Perch-Seq: 0' \\`,
    `  -H "X-Perch-Signature: $(sign POST /portal/v1/terminal/session '' 0 "$body")" \\`,
    `  --data-binary "$body" | jq -r .session); SEQ=0`,
    `# 2. heartbeat every heartbeatSeconds; a checkout appears when a guest picks this terminal`,
    `REF=$(call POST /portal/v1/terminal/heartbeat '{"status":{"acceptor":"off"}}' | jq -r '.checkout.checkoutRef // empty')`,
    `# 3. report each coin as it drops (eventId: unique per coin, kept across retries)`,
    `call POST /portal/v1/terminal/coins "{\\"checkoutRef\\":\\"$REF\\",\\"eventId\\":\\"boot7-1\\",\\"amount\\":5}"`,
    `# 4. the box's "done" button (the guest can also press Done on the page)`,
    `call POST /portal/v1/terminal/done "{\\"checkoutRef\\":\\"$REF\\"}"`,
  ].join('\n')
}

