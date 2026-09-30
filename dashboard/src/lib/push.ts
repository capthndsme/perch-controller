import type { QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { safeAppPath } from '@/lib/alert-badge'

/**
 * The browser half of Web Push that the shell needs (entry chunk, keep it small): whether this browser can
 * take pushes, the service worker's registration and its message bridge, and unsubscribing on logout.
 * Subscribing lives in `push-subscribe.ts`, loaded with the Notifications page or the daily re-sync.
 *
 * The worker is `public/sw.js` at scope `/`. It has no fetch handler, so it never caches or answers a
 * request (API responses and the stale-chunk recovery in `chunk-reload.ts` are untouched); it only shows
 * pushes and routes a tap to the alert. Browsers expose service workers and push only in secure contexts
 * (https, or localhost): on a plain-HTTP install nothing is registered.
 */

const SW_URL = '/sw.js'
const SW_OPTIONS: RegistrationOptions = { scope: '/', updateViaCache: 'none' }

/** This browser and page, as far as push is concerned (the Notifications page's "This device" card). */
export type PushSupport = 'insecure' | 'ios_needs_install' | 'unsupported' | 'denied' | 'default' | 'granted'

/** iPhone or iPad, including iPadOS that calls itself a Mac. */
export function isIos(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

/** Opened from the Home Screen or as an installed app. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function canUseServiceWorker(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure'
  // A Safari tab on iOS has no push API at all; the Home Screen app does (iOS 16.4+).
  if (isIos() && !isStandalone()) return 'ios_needs_install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

/** The worker's registration once it is active, registering it if the page has not yet. */
export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (!existing) await navigator.serviceWorker.register(SW_URL, SW_OPTIONS)
  return navigator.serviceWorker.ready
}

/** This browser's push subscription, without registering anything. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!canUseServiceWorker() || !('PushManager' in window)) return null
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

type Navigator_ = { navigate: (path: string) => unknown }

/**
 * Startup (main.tsx): registers the worker once the page has loaded, and listens to it. `perch:navigate` (a
 * tapped notification, with a dashboard already open) shows the alert through the router, no reload, and
 * answers so the worker does not fall back to a full navigation; `perch:alert` (a push arrived) refreshes
 * the bell and the inbox now rather than at their next poll.
 */
export function installServiceWorker(router: Navigator_, queryClient: QueryClient) {
  if (!canUseServiceWorker()) return
  const container = navigator.serviceWorker
  container.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data
    if (!data || typeof data !== 'object' || !('type' in data)) return
    if (data.type === 'perch:navigate') {
      const path = safeAppPath((data as { path?: unknown }).path)
      if (path) void router.navigate(path)
      event.ports[0]?.postMessage('ok')
    } else if (data.type === 'perch:alert') {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'alerts' && ['summary', 'list', 'detail'].includes(String(query.queryKey[1])),
      })
    }
  })
  container.startMessages()
  const register = () => {
    container.register(SW_URL, SW_OPTIONS).catch(() => {
      // No worker, no push: the Notifications page says why when it matters.
    })
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

/**
 * Stops pushes to this browser: the controller forgets it first (it needs the session), then the browser
 * drops the subscription. Used by "Turn off" and by logout, so a shared tablet stops receiving the previous
 * user's alerts. Never throws.
 */
export async function unsubscribeThisBrowser(): Promise<void> {
  try {
    const subscription = await currentPushSubscription()
    if (!subscription) return
    await apiFetch('/api/v1/alerts/push/subscriptions/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined)
    await subscription.unsubscribe().catch(() => false)
    await renewRecord('delete')
  } catch {
    // Logout must never fail on this.
  }
}

/** Base64url (VAPID public key) to bytes. */
export function b64uToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** What the worker needs to renew a replaced subscription on its own (sw.js `pushsubscriptionchange`). */
export type RenewRecord = { endpoint: string; token: string; key: string }

/** The one record in IndexedDB `perch` / store `push` / key `renew`, shared with sw.js. */
export function renewRecord(op: 'put', value: RenewRecord): Promise<boolean>
export function renewRecord(op: 'delete'): Promise<boolean>
export function renewRecord(op: 'put' | 'delete', value?: RenewRecord): Promise<boolean> {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(false)
    const open = indexedDB.open('perch', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('push')
    open.onerror = () => resolve(false)
    open.onsuccess = () => {
      const store = open.result.transaction('push', 'readwrite').objectStore('push')
      const request = op === 'put' ? store.put(value, 'renew') : store.delete('renew')
      request.onsuccess = () => resolve(true)
      request.onerror = () => resolve(false)
    }
  })
}
