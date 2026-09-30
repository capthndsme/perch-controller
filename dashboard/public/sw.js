/*
 * Perch: shows pushed alerts and opens them. Nothing else.
 *
 * No fetch handler and no caching, on purpose: every request goes to the network exactly as without a service
 * worker, so API responses are never cached and a tab opened before a redeploy still gets the server's 404 for
 * a chunk it no longer has, which is what src/lib/chunk-reload.ts recovers from. Registered by src/lib/push.ts
 * (secure contexts only), served with Cache-Control: no-cache. Contract: docs alerts delivery.md §1.
 */
const FALLBACK = '/alerts'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/** A same-origin path from a push message, or null. */
function pathOf(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const target = new URL(url, self.location.origin)
    return target.origin === self.location.origin ? target.pathname + target.search + target.hash : null
  } catch {
    return null
  }
}

self.addEventListener('push', (event) => {
  let msg = {}
  try {
    msg = event.data ? event.data.json() : {}
  } catch {
    msg = { body: event.data ? event.data.text() : '' }
  }
  if (!msg || typeof msg !== 'object') msg = {}
  const tag = typeof msg.tag === 'string' && msg.tag ? msg.tag : undefined
  const options = {
    body: typeof msg.body === 'string' ? msg.body : '',
    tag,
    // renotify without a tag throws in Chrome.
    renotify: Boolean(tag && msg.renotify),
    requireInteraction: msg.severity === 'critical',
    icon: '/icons/perch-192.png',
    badge: '/icons/badge-96.png',
    timestamp: typeof msg.ts === 'number' ? msg.ts : Date.now(),
    data: { url: pathOf(msg.url) || FALLBACK },
  }
  const title = typeof msg.title === 'string' && msg.title ? msg.title : 'Perch'
  const work = [self.registration.showNotification(title, options)]
  if (typeof msg.badge === 'number' && 'setAppBadge' in self.navigator) {
    work.push(msg.badge > 0 ? self.navigator.setAppBadge(msg.badge) : self.navigator.clearAppBadge())
  }
  // Open dashboards refresh their bell now instead of at the next 30 s poll.
  work.push(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((all) => all.forEach((client) => client.postMessage({ type: 'perch:alert', id: msg.id ?? null }))),
  )
  event.waitUntil(Promise.allSettled(work))
})

/**
 * Asks an open dashboard to show `path` in place (its router, no reload). A tab without the bridge (opened
 * before this version) never answers: then it is navigated the plain way.
 */
function navigateInPlace(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(false), 1500)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve(true)
    }
    client.postMessage({ type: 'perch:navigate', path }, [channel.port2])
  })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = pathOf(event.notification.data && event.notification.data.url) || FALLBACK
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (!open) {
        await self.clients.openWindow(path)
        return
      }
      // Focus first, while the click still counts as a user gesture.
      await open.focus()
      if (await navigateInPlace(open, path)) return
      try {
        await open.navigate(new URL(path, self.location.origin).href)
      } catch {
        // Not controlled by this worker: it stays focused where it was.
      }
    })(),
  )
})

// The browser replaced the subscription (Firefox does this; Chrome rarely). The service worker has no bearer
// token, so it proves itself with the renew token the page stored when it subscribed (src/lib/push.ts).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const stored = await idb('get')
      if (!stored) return
      const key = (event.oldSubscription && event.oldSubscription.options.applicationServerKey) || fromB64u(stored.key)
      const sub =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
      const res = await fetch('/api/v1/alerts/push/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          oldEndpoint: (event.oldSubscription && event.oldSubscription.endpoint) || stored.endpoint,
          renewToken: stored.token,
          subscription: sub.toJSON(),
        }),
      })
      if (res.ok) {
        const body = await res.json()
        await idb('put', { endpoint: sub.endpoint, token: body.data.renewToken, key: stored.key })
      }
    })(),
  )
})

function fromB64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

// One record in IndexedDB 'perch' / store 'push' / key 'renew' (the page writes it, src/lib/push.ts).
function idb(op, value) {
  return new Promise((resolve) => {
    const open = indexedDB.open('perch', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('push')
    open.onerror = () => resolve(null)
    open.onsuccess = () => {
      const tx = open.result.transaction('push', op === 'get' ? 'readonly' : 'readwrite')
      const req = op === 'get' ? tx.objectStore('push').get('renew') : tx.objectStore('push').put(value, 'renew')
      req.onsuccess = () => resolve(op === 'get' ? req.result || null : true)
      req.onerror = () => resolve(null)
    }
  })
}
