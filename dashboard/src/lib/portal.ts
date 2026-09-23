import { ApiError, apiErrorCode } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'
import type {
  Portal,
  PortalGrant,
  PortalGrantEndReason,
  PortalGrantSource,
  PortalGrantState,
  PortalGroup,
  VoucherBatch,
  VoucherStatus,
} from '@/types/api'

/**
 * Pure shaping for the guest portal pages (docs/gateway/portal.md §11–12):
 * labels, limits, error wording, grant stacking and the template pre-check
 * that mirrors the server's upload rules.
 */

// ── Durations, sizes, rates ──────────────────────────────────────────────

/** `90` → "1 h 30 min"; `2880` → "2 d". Minutes. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = Math.round(minutes % 60)
  const parts: string[] = []
  if (days) parts.push(`${days} d`)
  if (hours) parts.push(`${hours} h`)
  if (mins && days === 0) parts.push(`${mins} min`)
  return parts.join(' ') || '0 min'
}

/** Seconds, shortest honest form: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s'
  if (seconds < 60) return `${Math.round(seconds)} s`
  return formatMinutes(Math.floor(seconds / 60))
}

/** Decimal data sizes, as a guest reads a voucher ("500 MB", "2 GB"). */
export function formatQuota(bytes: number): string {
  if (bytes >= 1e12) return `${trim(bytes / 1e12)} TB`
  if (bytes >= 1e9) return `${trim(bytes / 1e9)} GB`
  if (bytes >= 1e6) return `${trim(bytes / 1e6)} MB`
  return formatBytes(bytes)
}

function trim(value: number): string {
  return String(Number(value.toFixed(value >= 100 ? 0 : 2)))
}

/** kbit/s as "512 kbps" / "10 Mbps". */
export function formatKbps(kbps: number): string {
  if (kbps >= 1000) return `${trim(kbps / 1000)} Mbps`
  return `${kbps} kbps`
}

/** "↓ 10 Mbps · ↑ 2 Mbps", or null without any rate limit. */
export function rateLabel(downKbps: number | null, upKbps: number | null): string | null {
  const parts: string[] = []
  if (downKbps) parts.push(`↓ ${formatKbps(downKbps)}`)
  if (upKbps) parts.push(`↑ ${formatKbps(upKbps)}`)
  return parts.length ? parts.join(' · ') : null
}

/** What a batch (or group) grants, e.g. "2 h wall clock · 1 GB · 2 devices". */
export function limitsLabel(limits: {
  durationMinutes: number | null
  durationMode: 'wall_clock' | 'active_time'
  quotaBytes: number | null
  maxDevices?: number
}): string {
  const parts: string[] = []
  if (limits.durationMinutes) {
    parts.push(
      `${formatMinutes(limits.durationMinutes)}${limits.durationMode === 'active_time' ? ' of use' : ''}`,
    )
  }
  if (limits.quotaBytes) parts.push(formatQuota(limits.quotaBytes))
  if (!limits.durationMinutes && !limits.quotaBytes) parts.push('No limit')
  if (limits.maxDevices && limits.maxDevices > 1) parts.push(`${limits.maxDevices} devices`)
  return parts.join(' · ')
}

/** "time", "data", "time + data" — the stacking class of a batch (decision 23). */
export function batchKind(batch: Pick<VoucherBatch, 'durationMinutes' | 'quotaBytes'>): string {
  if (batch.durationMinutes && batch.quotaBytes) return 'Time + data'
  if (batch.durationMinutes) return 'Time'
  if (batch.quotaBytes) return 'Data'
  return 'Open'
}

// ── Times ────────────────────────────────────────────────────────────────

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "in 2 h 5 min" / "3 min ago", against `now` (ms). */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—'
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return '—'
  const diff = Math.round((at - now) / 1000)
  if (Math.abs(diff) < 30) return 'just now'
  return diff > 0 ? `in ${formatSeconds(diff)}` : `${formatSeconds(-diff)} ago`
}

// ── Grants ───────────────────────────────────────────────────────────────

export const GRANT_STATE_LABELS: Record<PortalGrantState, string> = {
  queued: 'Queued',
  pending_device: 'Waiting for device',
  active: 'Online',
  paused: 'Idle',
  ended: 'Ended',
}

export const GRANT_END_REASONS: Record<PortalGrantEndReason, string> = {
  expired: 'Time up',
  quota: 'Data used up',
  revoked: 'Revoked',
  logout: 'Logged out',
  router_deauth: 'Removed on the router',
  replaced: 'Replaced',
  moved: 'Moved to another device',
  rejected: 'Refused by the router',
}

export const GRANT_SOURCE_LABELS: Record<PortalGrantSource, string> = {
  voucher: 'Voucher',
  user: 'Portal user',
  api: 'API',
  admin: 'Admin',
  clickthrough: 'Click-through',
}

/** Tailwind classes of a grant state badge (status tokens, never series colours). */
export function grantStateClass(state: PortalGrantState): string {
  switch (state) {
    case 'active':
      return 'border-status-good/30 bg-status-good/10 text-status-good'
    case 'pending_device':
      return 'border-status-warning/40 bg-status-warning/10 text-foreground'
    case 'paused':
      return 'border-border bg-muted text-muted-foreground'
    case 'queued':
      return 'border-brand/30 bg-brand/10 text-brand'
    default:
      return 'border-border text-muted-foreground'
  }
}

/** Who the grant came from: "Voucher ··7QH4", "Portal user ana", "API coin-box". */
export function grantSourceLabel(grant: PortalGrant): string {
  if (grant.source === 'voucher' && grant.voucher) return `Voucher ··${grant.voucher.hint}`
  if (grant.source === 'user' && grant.portalUser) return grant.portalUser.username
  if (grant.source === 'api' && grant.apiClient) return grant.apiClient.name
  if (grant.source === 'admin' && grant.createdBy) return grant.createdBy.email
  return GRANT_SOURCE_LABELS[grant.source]
}

/** What is left of a grant, e.g. "1 h 20 min · 300 MB left", "Unlimited", "Waiting to start". */
export function remainingLabel(grant: PortalGrant, now = Date.now()): string {
  if (grant.state === 'ended') return grant.endReason ? GRANT_END_REASONS[grant.endReason] : 'Ended'
  const group = grant.group
  const parts: string[] = []
  const seconds = remainingSeconds(grant, now)
  if (seconds !== null) parts.push(formatSeconds(seconds))
  if (group?.remaining.bytes != null) parts.push(formatQuota(Math.max(0, group.remaining.bytes)))
  if (parts.length === 0) return 'No limit'
  const waiting = grant.state === 'queued' && !grant.expiresAt && group?.durationMode === 'wall_clock'
  return `${parts.join(' · ')} ${waiting ? 'when it starts' : 'left'}`
}

/** Seconds left: the group's figure, else the grant's own deadline. */
export function remainingSeconds(grant: PortalGrant, now = Date.now()): number | null {
  const fromGroup = grant.group?.remaining.seconds
  if (fromGroup != null) return Math.max(0, fromGroup)
  if (grant.expiresAt) return Math.max(0, (new Date(grant.expiresAt).getTime() - now) / 1000)
  return null
}

/** Share of the group's time or data used, 0–1 (the tighter of the two), or null without limits. */
export function usedFraction(group: PortalGroup | null): number | null {
  if (!group) return null
  const fractions: number[] = []
  if (group.quotaBytes) fractions.push(group.bytesUsed / group.quotaBytes)
  if (group.durationMinutes && group.remaining.seconds != null) {
    const total = group.durationMinutes * 60
    fractions.push(1 - group.remaining.seconds / total)
  }
  if (!fractions.length) return null
  return Math.min(1, Math.max(0, Math.max(...fractions)))
}

export type DeviceEntitlements = {
  mac: string
  /** The one running entitlement (pending_device, active or paused), if any. */
  live: PortalGrant | null
  /** Waiting entitlements in the order the router will use them (decision 23). */
  queued: PortalGrant[]
  ended: PortalGrant[]
}

const LIVE_STATES: PortalGrantState[] = ['pending_device', 'active', 'paused']

/**
 * Classes of the consumption order (docs/gateway/portal.md §4.6): time and
 * open entitlements before data buckets; a running clock before a waiting
 * one, earlier deadline first; then the older grant.
 */
function entitlementClass(grant: PortalGrant): number {
  const group = grant.group
  const hasTime = Boolean(group?.durationMinutes || group?.expiresAt || grant.expiresAt)
  const hasData = Boolean(group?.quotaBytes)
  if (!hasTime && hasData) return 1
  return 0
}

export function compareEntitlements(a: PortalGrant, b: PortalGrant): number {
  const ca = entitlementClass(a)
  const cb = entitlementClass(b)
  if (ca !== cb) return ca - cb
  const da = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY
  const db = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY
  if (da !== db) return da - db
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
  if (ta !== tb) return ta - tb
  return a.id - b.id
}

/**
 * Groups grants per device: the live one first, then the queue in the order
 * the router consumes it. Devices with something live come first, newest
 * activity first.
 */
export function groupByDevice(grants: PortalGrant[]): DeviceEntitlements[] {
  const byMac = new Map<string, DeviceEntitlements>()
  for (const grant of grants) {
    let entry = byMac.get(grant.mac)
    if (!entry) {
      entry = { mac: grant.mac, live: null, queued: [], ended: [] }
      byMac.set(grant.mac, entry)
    }
    if (LIVE_STATES.includes(grant.state)) {
      // Two live grants is a race the reconciler settles; show the newer as live.
      if (!entry.live || grant.id > entry.live.id) {
        if (entry.live) entry.queued.push(entry.live)
        entry.live = grant
      } else {
        entry.queued.push(grant)
      }
    } else if (grant.state === 'queued') {
      entry.queued.push(grant)
    } else {
      entry.ended.push(grant)
    }
  }
  const out = [...byMac.values()]
  for (const entry of out) entry.queued.sort(compareEntitlements)
  const seen = (e: DeviceEntitlements) => {
    const g = e.live ?? e.queued[0] ?? e.ended[0]
    return new Date(g?.lastSeenAt ?? g?.createdAt ?? 0).getTime()
  }
  out.sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || seen(b) - seen(a))
  return out
}

// ── Vouchers ─────────────────────────────────────────────────────────────

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  unused: 'Unused',
  active: 'In use',
  exhausted: 'Used up',
  expired: 'Expired',
  revoked: 'Revoked',
}

export function voucherStatusClass(status: VoucherStatus): string {
  switch (status) {
    case 'unused':
      return 'border-brand/30 bg-brand/10 text-brand'
    case 'active':
      return 'border-status-good/30 bg-status-good/10 text-status-good'
    case 'revoked':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

/** Normalises a typed code for display only (the server accepts any spelling). */
export function tidyCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z-]/g, '')
}

// ── Errors ───────────────────────────────────────────────────────────────

const ERROR_TEXT: Record<string, string> = {
  admin_required: 'Only admins can change the guest portal.',
  password_change_required: 'Change your password first.',
  portal_not_found: 'That portal no longer exists.',
  gateway_not_found: 'That gateway no longer exists.',
  template_not_found: 'That template no longer exists.',
  portal_exists: 'That network already has a portal.',
  network_not_found: 'The gateway has no such network.',
  network_hosts_controller:
    'The gateway reaches the controller through this network: a portal there would cut the controller off.',
  portal_active_grants: 'Guests are still online on this portal.',
  grant_not_found: 'That grant no longer exists.',
  grant_ended: 'That grant has already ended.',
  grant_not_extendable: 'Voucher grants follow their voucher: extend with a new voucher instead.',
  nothing_to_extend: 'This grant has no such limit to extend (it would turn "unlimited" into a limit).',
  no_limit: 'Give at least a duration or a data quota.',
  start_mode_requires_wall_clock: '"Starts at creation" needs a wall-clock duration.',
  redeem_by_past: 'The redeem-by date is in the past.',
  invalid_date: 'That date is not valid.',
  invalid_mac: 'That MAC address is not valid (broadcast, multicast and all-zero MACs are refused).',
  batch_not_found: 'That batch no longer exists.',
  batch_used: 'A voucher of this batch was used: revoke the batch instead.',
  codes_unrecoverable: 'The codes of this batch can no longer be decrypted (the controller key changed).',
  voucher_not_found: 'No voucher with that code.',
  username_taken: 'That username is taken.',
  portal_user_not_found: 'That portal user no longer exists.',
  api_client_not_found: 'That API client no longer exists.',
  api_client_revoked: 'That API client is revoked.',
  builtin_template: 'The built-in template is read-only: duplicate it to change it.',
  template_in_use: 'Portals still use this template.',
  template_file_not_found: 'That file is not in the template.',
  login_page_required: 'A template needs its login.html.',
  file_required: 'Choose a file.',
  limit_exceeded: 'Over this client’s per-call cap.',
  too_many_active_grants: 'This client has too many active grants.',
  rate_limited: 'Too many requests. Wait a minute.',
  idempotency_conflict: 'That payment reference was used for a different request.',
  no_active_grant: 'The device has nothing live on this portal.',
  // Paid Hotspot (portal.md §14.9)
  price_table_not_found: 'That price table no longer exists.',
  price_table_in_use: 'Portals or terminals still use this price table: point them at another one first.',
  price_table_required: 'The payment method needs a price table.',
  no_entries: 'A price table needs at least one rate.',
  too_many_entries: 'A price table has at most 32 rates.',
  duplicate_amount: 'Two rates have the same amount: each amount can appear once.',
  mixed_quota: 'Either every rate includes data or none does.',
  invalid_entry: 'One of the rates is not valid.',
  invalid_currency: 'The currency is a three-letter code, e.g. PHP or USD.',
  terminal_not_found: 'That terminal no longer exists.',
  checkout_not_found: 'That payment no longer exists.',
  not_a_payment: 'Only payments can be voided.',
  checkout_voided: 'This payment is already voided.',
  refund_exceeds_amount: 'The refund is more than was paid.',
  not_unclaimed: 'Only unclaimed coins can be credited or dismissed.',
  already_resolved: 'Someone already credited or dismissed these coins.',
  below_minimum: 'This amount buys nothing under the terminal’s price table: give minutes instead.',
  invalid_range: 'The start date is after the end date.',
}

/** A sentence for a failed portal call: the known code's wording, else the server's message. */
export function portalErrorMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
  if (error instanceof ApiError) {
    if (error.status === 403) return ERROR_TEXT.admin_required
    if (error.status === 422) {
      const body = error.body as { errors?: Array<{ message: string }> } | null
      if (body?.errors?.length) return body.errors.map((e) => e.message).join(' ')
    }
    return error.message
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** Field of the body of a refusal (`{error, message, ...detail}`). */
export function errorDetail<T = unknown>(error: unknown, key: string): T | undefined {
  if (!(error instanceof ApiError)) return undefined
  const body = error.body
  if (typeof body !== 'object' || body === null) return undefined
  return (body as Record<string, unknown>)[key] as T | undefined
}

// ── MACs ─────────────────────────────────────────────────────────────────

/** `aa-bb-…`, `aabb.ccdd.eeff`, 12 hex → `aa:bb:…`; null if not a MAC. The server re-checks. */
export function normalizeMac(input: string): string | null {
  const hex = input.trim().toLowerCase().replace(/[:.\-\s]/g, '')
  if (!/^[0-9a-f]{12}$/.test(hex)) return null
  return hex.match(/../g)!.join(':')
}

// ── Templates (mirror of app/services/portal/templates.ts) ────────────────

export const TEMPLATE_LIMITS = {
  maxFiles: 24,
  maxFileBytes: 512 * 1024,
  maxHtmlBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const

export const TEMPLATE_FILE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const TEMPLATE_EXTENSIONS = ['html', 'css', 'js', 'txt', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'woff2']

export const TEMPLATE_VARIABLES = [
  'portal_name',
  'gateway_name',
  'client_mac',
  'client_ip',
  'origin_url',
  'message',
  'message_code',
  'assets',
  'remaining_time',
  'remaining_data',
  'expires_at',
  'privacy_notice',
  'methods',
  'status_json',
  'voucher_form',
  'login_form',
  'logout_form',
] as const

export const PORTAL_MESSAGE_CODES = [
  'invalid_code',
  'invalid_credentials',
  'expired',
  'exhausted',
  'revoked',
  'disabled',
  'device_limit',
  'already_authorized',
  'wrong_portal',
  'rate_limited',
  'controller_unreachable',
  'origin_mismatch',
  'bad_request',
  'logged_out',
  'connected',
  'time_up',
  'data_used_up',
] as const

export type TemplateIssue = { file: string | null; line?: number; message: string }

const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g
const VARIABLE_SET = new Set<string>(TEMPLATE_VARIABLES)

/** `{{name}}` uses with an unknown name, with their line numbers. */
export function unknownVariables(text: string): Array<{ line: number; name: string }> {
  const out: Array<{ line: number; name: string }> = []
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    if (VARIABLE_SET.has(match[1])) continue
    out.push({ line: text.slice(0, match.index).split('\n').length, name: match[1] })
  }
  return out
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

/**
 * Every problem the server would refuse, per file and line, before the
 * upload: the server stops at its first refusal, the admin wants the list.
 * `requireLogin` = a whole set (a new template), not one replaced file.
 */
export async function precheckTemplateFiles(
  files: Array<{ name: string; file: Blob }>,
  options: { requireLogin: boolean },
): Promise<TemplateIssue[]> {
  const issues: TemplateIssue[] = []
  const names = new Set<string>()
  let total = 0
  for (const { name, file } of files) {
    total += file.size
    if (names.has(name)) issues.push({ file: name, message: 'appears twice' })
    names.add(name)
    if (!TEMPLATE_FILE_NAME_REGEX.test(name)) {
      issues.push({ file: name, message: 'not an allowed name (a-z, 0-9, ".", "_", "-"; lower case; no folders)' })
      continue
    }
    const ext = extensionOf(name)
    if (!TEMPLATE_EXTENSIONS.includes(ext)) {
      issues.push({ file: name, message: `.${ext || '(none)'} is not accepted (${TEMPLATE_EXTENSIONS.join(', ')})` })
      continue
    }
    const limit = ext === 'html' ? TEMPLATE_LIMITS.maxHtmlBytes : TEMPLATE_LIMITS.maxFileBytes
    if (file.size > limit) {
      issues.push({ file: name, message: `${formatBytes(file.size)}; the limit is ${formatBytes(limit)}` })
      continue
    }
    if (ext === 'html') {
      const text = await file.text()
      for (const unknown of unknownVariables(text)) {
        issues.push({ file: name, line: unknown.line, message: `{{${unknown.name}}} is not a portal variable` })
      }
    }
  }
  if (files.length > TEMPLATE_LIMITS.maxFiles) {
    issues.push({ file: null, message: `${files.length} files; a template holds at most ${TEMPLATE_LIMITS.maxFiles}` })
  }
  if (total > TEMPLATE_LIMITS.maxTotalBytes) {
    issues.push({ file: null, message: `${formatBytes(total)} in total; the limit is ${formatBytes(TEMPLATE_LIMITS.maxTotalBytes)}` })
  }
  if (options.requireLogin && !names.has('login.html')) {
    issues.push({ file: null, message: 'a template needs a login.html' })
  }
  return issues
}

/** The server's refusal of an upload as a per-file issue. */
export function templateIssueFromError(error: unknown): TemplateIssue {
  const file = errorDetail<string>(error, 'file') ?? null
  const line = errorDetail<number>(error, 'line')
  const name = errorDetail<string>(error, 'name')
  const code = apiErrorCode(error)
  if (code === 'unknown_variable' && name) {
    return { file, line, message: `{{${name}}} is not a portal variable` }
  }
  const message = error instanceof ApiError ? error.message : portalErrorMessage(error)
  return { file, line, message }
}

// ── Form helpers ─────────────────────────────────────────────────────────

export const selectClassName =
  'h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'

export const textareaClassName =
  'min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30'

/** The field errors of a Vine 422 (`{errors: [{field, message}]}`), keyed by field. */
export function vineFieldErrors(error: unknown): Record<string, string> {
  if (typeof error !== 'object' || error === null || !('body' in error)) return {}
  const body = (error as { body: unknown }).body
  if (typeof body !== 'object' || body === null || !('errors' in body)) return {}
  const out: Record<string, string> = {}
  for (const item of (body as { errors: Array<{ field?: string; message: string }> }).errors ?? []) {
    if (item.field && !out[item.field]) out[item.field] = item.message
  }
  return out
}

/** `""` → undefined, else the whole number (NaN for junk: the server's 422 names it). */
export function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined
  return Number(value)
}


export type DurationUnit = 'min' | 'h' | 'd'
export type QuotaUnit = 'MB' | 'GB'

const DURATION_FACTORS: Record<DurationUnit, number> = { min: 1, h: 60, d: 1440 }
const QUOTA_FACTORS: Record<QuotaUnit, number> = { MB: 1e6, GB: 1e9 }

/** Minutes from an amount and unit; undefined when empty, NaN when not a number. */
export function toMinutes(amount: string, unit: DurationUnit): number | undefined {
  if (amount.trim() === '') return undefined
  return Math.round(Number(amount) * DURATION_FACTORS[unit])
}

/** Bytes (decimal, as vouchers are sold) from an amount and unit. */
export function toBytes(amount: string, unit: QuotaUnit): number | undefined {
  if (amount.trim() === '') return undefined
  return Math.round(Number(amount) * QUOTA_FACTORS[unit])
}

/** kbit/s from Mbit/s typed by the admin. */
export function mbpsToKbps(amount: string): number | undefined {
  if (amount.trim() === '') return undefined
  return Math.round(Number(amount) * 1000)
}

/** The largest unit a whole number of minutes divides into, for editing. */
export function splitMinutes(minutes: number | null): { amount: string; unit: DurationUnit } {
  if (!minutes) return { amount: '', unit: 'h' }
  if (minutes % 1440 === 0) return { amount: String(minutes / 1440), unit: 'd' }
  if (minutes % 60 === 0) return { amount: String(minutes / 60), unit: 'h' }
  return { amount: String(minutes), unit: 'min' }
}

export function splitBytes(bytes: number | null): { amount: string; unit: QuotaUnit } {
  if (!bytes) return { amount: '', unit: 'GB' }
  if (bytes % 1e9 === 0 || bytes >= 1e9) return { amount: String(Number((bytes / 1e9).toFixed(3))), unit: 'GB' }
  return { amount: String(Number((bytes / 1e6).toFixed(3))), unit: 'MB' }
}

export function kbpsToMbpsText(kbps: number | null): string {
  return kbps ? String(Number((kbps / 1000).toFixed(3))) : ''
}

// ── Methods ──────────────────────────────────────────────────────────────

/** The ways a portal lets guests online, e.g. ["Vouchers", "Paid access"]. */
export function methodLabels(methods: Portal['methods']): string[] {
  return [
    methods.voucher ? 'Vouchers' : null,
    methods.password ? 'Username + password' : null,
    methods.payment ? 'Paid access' : null,
    methods.clickThrough ? 'Click-through' : null,
  ].filter((m): m is string => m !== null)
}

// ── Portal health ────────────────────────────────────────────────────────

/** One-word health of a portal for its card and header. */
export function portalHealth(portal: Portal): { label: string; tone: 'good' | 'warning' | 'bad' | 'muted' } {
  if (!portal.gateway) return { label: 'No gateway', tone: 'bad' }
  if (portal.gateway.portalCapable === false) return { label: 'Collector too old', tone: 'bad' }
  if (!portal.gateway.online) return { label: 'Gateway offline', tone: 'warning' }
  if (portal.status.fas === 'misconfigured' || portal.status.issues.length > 0) return { label: 'Needs attention', tone: 'warning' }
  if (portal.enforcement === 'opennds' && portal.status.openNds !== 'running') {
    return { label: `openNDS ${portal.status.openNds}`, tone: 'warning' }
  }
  if (portal.status.delivery === 'pending') return { label: 'Applying', tone: 'muted' }
  if (portal.status.fas === 'ok') return { label: 'Running', tone: 'good' }
  return { label: 'Not reported yet', tone: 'muted' }
}

