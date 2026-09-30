import AlertPushSubscription, { type PushService } from '#models/alert_push_subscription'
import { alertNow, isoOrNull } from '#services/alerts/clock'
import {
  mergeFilters,
  normalizeFilters,
  PUSH_FILTER_DEFAULTS,
  type Filters,
} from '#services/alerts/filters'
import { pushServiceOf } from '#services/alerts/push/push_services'
import { DateTime } from 'luxon'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Push subscriptions (docs/design/alerts/api.md §3.4): the upsert behind
 * "Notify this device", the service worker's renew path and the wire view.
 * One browser has one subscription, so rows are keyed by sha256(endpoint): a
 * browser that changes hands (another user signs in there) moves its row to
 * the new user.
 */

export type PushSubscriptionView = {
  id: number
  userId: number
  endpointHash: string
  pushService: PushService
  label: string | null
  platform: string | null
  enabled: boolean
  state: 'active' | 'failing' | 'gone'
  filters: Filters
  vapidKeyId: string
  createdAt: string
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
}

export function pushSubscriptionView(row: AlertPushSubscription): PushSubscriptionView {
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    endpointHash: row.endpointHash,
    pushService: row.pushService,
    label: row.label,
    platform: row.platform,
    enabled: row.enabled,
    state: row.state,
    filters: normalizeFilters(row.filters, PUSH_FILTER_DEFAULTS),
    vapidKeyId: row.vapidKeyId,
    createdAt: isoOrNull(row.createdAt)!,
    lastSuccessAt: isoOrNull(row.lastSuccessAt),
    lastFailureAt: isoOrNull(row.lastFailureAt),
    lastError: row.lastError,
  }
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

/** `pr_` + 32 random bytes (base64url); only its sha256 is stored. */
export function newRenewToken(): { token: string; hash: string } {
  const token = `pr_${randomBytes(32).toString('base64url')}`
  return { token, hash: endpointHash(token) }
}

export function renewTokenMatches(token: string, hash: string | null): boolean {
  if (!hash) return false
  const a = Buffer.from(endpointHash(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** base64url (padding tolerated) of exactly `bytes` bytes, or null. */
export function base64urlBytes(value: string, bytes: number): Buffer | null {
  const bare = value.replace(/=+$/, '')
  if (!/^[A-Za-z0-9_-]+$/.test(bare)) return null
  const decoded = Buffer.from(bare, 'base64url')
  return decoded.length === bytes ? decoded : null
}

/** "Chrome on Android", "Safari on iPhone" (the dashboard's `platformLabel`, from the User-Agent). */
export function platformFromUserAgent(ua: string | undefined | null): string | null {
  if (!ua) return null
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /CriOS|Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null
  if (!browser) return os
  return (os ? `${browser} on ${os}` : browser).slice(0, 80)
}

export type SubscriptionInput = {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export class PushSubscriptionError extends Error {
  constructor(
    readonly code: 'push_service_not_allowed' | 'invalid_keys' | 'invalid_endpoint',
    message: string,
    readonly field: string
  ) {
    super(message)
  }
}

/** Checks the browser's subscription; returns its push service. */
export function checkSubscription(input: SubscriptionInput, allowAny: boolean): PushService {
  const service = pushServiceOf(input.endpoint)
  if (!service) {
    throw new PushSubscriptionError(
      'invalid_endpoint',
      'The endpoint must be an https URL on a push service (no address literal, port 443).',
      'subscription.endpoint'
    )
  }
  if (service === 'other' && !allowAny) {
    throw new PushSubscriptionError(
      'push_service_not_allowed',
      'This push service is not on the allowlist (Settings → Alerts → allow any push service).',
      'subscription.endpoint'
    )
  }
  const p256dh = base64urlBytes(input.keys.p256dh, 65)
  if (!p256dh || p256dh[0] !== 0x04) {
    throw new PushSubscriptionError(
      'invalid_keys',
      'keys.p256dh must be an uncompressed P-256 point (65 bytes, base64url).',
      'subscription.keys.p256dh'
    )
  }
  if (!base64urlBytes(input.keys.auth, 16)) {
    throw new PushSubscriptionError(
      'invalid_keys',
      'keys.auth must be 16 bytes, base64url.',
      'subscription.keys.auth'
    )
  }
  return service
}

function expirationOf(input: SubscriptionInput): DateTime | null {
  return typeof input.expirationTime === 'number' && Number.isFinite(input.expirationTime)
    ? DateTime.fromMillis(input.expirationTime, { zone: 'utc' })
    : null
}

/**
 * Subscribe or refresh, by sha256(endpoint). A refresh keeps the row's id,
 * label (unless a new one is given), filters (merged with the given part) and
 * `enabled`; it takes the new keys and key id, revives a `gone` row and
 * resets its failure count. Every call makes a new renew token.
 */
export async function upsertSubscription(options: {
  userId: number
  subscription: SubscriptionInput
  service: PushService
  vapidKeyId: string
  label?: string | null
  filters?: Partial<Filters>
  platform: string | null
}): Promise<{ row: AlertPushSubscription; created: boolean; renewToken: string }> {
  const hash = endpointHash(options.subscription.endpoint)
  const renew = newRenewToken()
  const existing = await AlertPushSubscription.findBy('endpointHash', hash)
  const row = existing ?? new AlertPushSubscription()
  row.userId = options.userId
  row.endpoint = options.subscription.endpoint
  row.endpointHash = hash
  row.pushService = options.service
  row.p256dh = options.subscription.keys.p256dh
  row.auth = options.subscription.keys.auth
  row.vapidKeyId = options.vapidKeyId
  row.expirationAt = expirationOf(options.subscription)
  if (options.label !== undefined) row.label = options.label?.slice(0, 80) || null
  else if (!existing) row.label = null
  row.platform = options.platform
  row.filters = mergeFilters(existing?.filters, options.filters, PUSH_FILTER_DEFAULTS)
  if (!existing) row.enabled = true
  row.state = 'active'
  row.consecutiveFailures = 0
  row.lastError = null
  row.renewTokenHash = renew.hash
  await row.save()
  return { row, created: !existing, renewToken: renew.token }
}

/**
 * The service worker's `pushsubscriptionchange`: the row of the old endpoint
 * takes the new endpoint and keys (same user, label, filters). Returns null
 * when the old row or the token does not match. When the new endpoint already
 * has a row of its own (the page re-subscribed first), that row wins and the
 * old one goes.
 */
export async function renewSubscription(input: {
  oldEndpoint: string
  renewToken: string
  subscription: SubscriptionInput
  service: PushService
}): Promise<{ row: AlertPushSubscription; renewToken: string } | null> {
  const old = await AlertPushSubscription.findBy('endpointHash', endpointHash(input.oldEndpoint))
  if (!old || !renewTokenMatches(input.renewToken, old.renewTokenHash)) return null
  const hash = endpointHash(input.subscription.endpoint)
  const renew = newRenewToken()
  let row = old
  if (hash !== old.endpointHash) {
    const taken = await AlertPushSubscription.findBy('endpointHash', hash)
    if (taken) {
      await old.delete()
      row = taken
    }
  }
  row.endpoint = input.subscription.endpoint
  row.endpointHash = hash
  row.pushService = input.service
  row.p256dh = input.subscription.keys.p256dh
  row.auth = input.subscription.keys.auth
  row.expirationAt = expirationOf(input.subscription)
  row.state = 'active'
  row.consecutiveFailures = 0
  row.lastError = null
  row.renewTokenHash = renew.hash
  await row.save()
  return { row, renewToken: renew.token }
}

/* Renew budget: 10 calls per minute per client address (the route has no bearer). */

const RENEW_LIMIT = 10
const RENEW_WINDOW_MS = 60_000
const MAX_TRACKED = 1024
const renewWindows = new Map<string, { count: number; startedAt: number }>()

/** Charges one renew call; returns the seconds to wait when the address is over budget. */
export function chargeRenew(address: string, now: number = alertNow().toMillis()): number | null {
  let window = renewWindows.get(address)
  if (window && now - window.startedAt >= RENEW_WINDOW_MS) {
    renewWindows.delete(address)
    window = undefined
  }
  if (!window) {
    window = { count: 0, startedAt: now }
    renewWindows.set(address, window)
    while (renewWindows.size > MAX_TRACKED) renewWindows.delete(renewWindows.keys().next().value!)
  }
  if (window.count >= RENEW_LIMIT) {
    return Math.max(1, Math.ceil((window.startedAt + RENEW_WINDOW_MS - now) / 1000))
  }
  window.count += 1
  return null
}

/** Tests only. */
export function _resetRenewLimits(): void {
  renewWindows.clear()
}
