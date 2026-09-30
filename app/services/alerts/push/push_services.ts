import type { PushService } from '#models/alert_push_subscription'
import { isIP } from 'node:net'

/**
 * The push-service allowlist (docs/design/alerts/delivery.md §1.7). A browser
 * hands the controller an endpoint URL, and the controller POSTs to it: the
 * allowlist keeps that from being a way to make the controller call anything
 * on the LAN. `allowAnyPushService` (Settings → Alerts) lifts it for
 * self-hosted push services.
 */

export const KNOWN_PUSH_SERVICES: PushService[] = ['fcm', 'mozilla', 'apple', 'wns']

const suffix = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** The service an endpoint belongs to, or null when it is no usable push endpoint at all. */
export function pushServiceOf(endpoint: string): PushService | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (url.port && url.port !== '443') return null
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || isIP(host) !== 0) return null
  if (host === 'fcm.googleapis.com') return 'fcm'
  if (suffix(host, 'push.services.mozilla.com')) return 'mozilla'
  if (host === 'web.push.apple.com' || suffix(host, 'push.apple.com')) return 'apple'
  if (suffix(host, 'notify.windows.com')) return 'wns'
  return 'other'
}

/** What `GET /alerts/push/config` lists. */
export function allowedPushServices(allowAny: boolean): PushService[] {
  return allowAny ? [...KNOWN_PUSH_SERVICES, 'other'] : [...KNOWN_PUSH_SERVICES]
}
