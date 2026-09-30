import { apiErrorCode, apiFetch } from '@/lib/api'
import { b64uToBytes, currentPushSubscription, pushRegistration, renewRecord } from '@/lib/push'
import type { Filters, PushConfig, PushSubscribeResponse, PushSubscriptionView } from '@/types/alerts'

/**
 * Subscribing this browser to the controller's pushes (design delivery.md §1.6). Loaded with the
 * Notifications page, and by the shell once per load when this browser already has a subscription
 * (`syncPushSubscription`): never part of the entry chunk.
 */

const SUBSCRIPTIONS = '/api/v1/alerts/push/subscriptions'
const SYNC_KEY = 'perch-push-sync'
const DAY_MS = 24 * 60 * 60 * 1000

/** sha256 hex, the controller's `endpointHash`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** "Chrome on Android", "Safari on iPhone": the default name of a new device. */
export function platformLabel(ua = navigator.userAgent): string {
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
            : 'Browser'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
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
  return os ? `${browser} on ${os}` : browser
}

/** Whether the subscription was made with this VAPID public key. */
function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey
  if (!current) return false
  const a = new Uint8Array(current)
  const b = b64uToBytes(publicKey)
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/**
 * The permission prompt. Call it straight from the tap, before any `await`: iOS shows the prompt only
 * then (and Safari before 15 took a callback).
 */
export function requestNotificationPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    const maybe = Notification.requestPermission(resolve)
    if (maybe) void maybe.then(resolve, () => resolve(Notification.permission))
  })
}

/** This browser's subscription and its hash, when it has one. */
export async function browserSubscription(): Promise<{ endpoint: string; hash: string } | null> {
  const subscription = await currentPushSubscription()
  return subscription ? { endpoint: subscription.endpoint, hash: await sha256Hex(subscription.endpoint) } : null
}

type SubscribeOptions = {
  label?: string | null
  filters?: Partial<Filters>
  /** Drop the browser's current subscription first (the controller marked it gone). */
  fresh?: boolean
}

/**
 * Subscribes this browser (or refreshes its subscription) and tells the controller. Permission must already
 * be granted. A subscription made with another key (rotated or restored) is replaced. A 409
 * `vapid_key_mismatch` (the key rotated while this page was open) fetches the new key and tries once more.
 */
export async function subscribeThisBrowser(config: PushConfig, options: SubscribeOptions = {}): Promise<PushSubscribeResponse> {
  try {
    return await subscribeWith(config, options)
  } catch (error) {
    if (apiErrorCode(error) !== 'vapid_key_mismatch') throw error
    const current = await apiFetch<PushConfig>('/api/v1/alerts/push/config')
    return subscribeWith(current, options)
  }
}

async function subscribeWith(config: PushConfig, options: SubscribeOptions): Promise<PushSubscribeResponse> {
  const registration = await pushRegistration()
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && (options.fresh || !sameKey(subscription, config.vapidPublicKey))) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64uToBytes(config.vapidPublicKey),
  })
  const response = await apiFetch<PushSubscribeResponse>(SUBSCRIPTIONS, {
    method: 'POST',
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      vapidKeyId: config.vapidKeyId,
      ...(options.label ? { label: options.label } : {}),
      ...(options.filters ? { filters: options.filters } : {}),
    }),
  })
  await renewRecord('put', { endpoint: subscription.endpoint, token: response.renewToken, key: config.vapidPublicKey })
  writeStamp(config.vapidKeyId)
  return response
}

function readStamp(): { at: number; keyId: string } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_KEY) ?? 'null') as { at?: unknown; keyId?: unknown } | null
    return parsed && typeof parsed.at === 'number' && typeof parsed.keyId === 'string'
      ? { at: parsed.at, keyId: parsed.keyId }
      : null
  } catch {
    return null
  }
}

function writeStamp(keyId: string) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ at: Date.now(), keyId }))
  } catch {
    // Then it re-syncs on the next load; harmless.
  }
}

/**
 * Once per app load, signed in, when this browser holds a push subscription: if the controller's key
 * changed (rotation, a restored database) it subscribes again, and at most once a day it re-posts the
 * subscription anyway (refreshes keys and platform, revives a row marked gone). The row's name and filters
 * go along, so a new endpoint keeps them.
 */
export async function syncPushSubscription(): Promise<void> {
  if (Notification.permission !== 'granted') return
  const subscription = await currentPushSubscription()
  if (!subscription) return
  const config = await apiFetch<PushConfig>('/api/v1/alerts/push/config')
  if (!config.available) return
  const stamp = readStamp()
  if (
    stamp &&
    stamp.keyId === config.vapidKeyId &&
    Date.now() - stamp.at < DAY_MS &&
    sameKey(subscription, config.vapidPublicKey)
  ) {
    return
  }
  const hash = await sha256Hex(subscription.endpoint)
  const mine = await apiFetch<PushSubscriptionView[]>(SUBSCRIPTIONS)
  const row = mine.find((item) => item.endpointHash === hash)
  // Removed on the controller, or switched off there: that was on purpose, so it stays that way.
  if (!row || !row.enabled) {
    writeStamp(config.vapidKeyId)
    return
  }
  // A row the push service dropped (404/410) needs a new endpoint, not the dead one again.
  await subscribeThisBrowser(config, { label: row.label, filters: row.filters, fresh: row.state === 'gone' })
}
