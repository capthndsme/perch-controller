import type { Collector, WifiSourceAgent } from '@/types/api'

/**
 * Plain HTTP between the controller and its agents or browsers is supported
 * (the default Docker install serves nothing else), but it is only sensible on
 * a network client devices can't reach. These helpers decide where the
 * dashboard says so; the copy lives in components/security/plain-http.tsx.
 */

/** The README section every plain-HTTP warning links to. */
export const PLAIN_HTTP_DOCS_URL =
  'https://github.com/capthndsme/perch-controller#plain-http-and-a-management-vlan'

/** `http://…`, not https and not garbage. */
export function isPlainHttpUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^http:\/\//i.test(url.trim())
}

/** This browser's own machine: nothing crosses the network to reach it. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  )
}

/** The dashboard itself came over plain HTTP from another machine. */
export function isDashboardPlainHttp(
  location: Pick<Location, 'protocol' | 'hostname'> = window.location,
): boolean {
  return location.protocol === 'http:' && !isLocalHostname(location.hostname)
}

/**
 * An AP whose live perch-apd session reached the controller unencrypted.
 * `secure === null` (offline, or a proxy that does not say) stays quiet.
 */
export function isApAgentUnencrypted(agent: WifiSourceAgent | null | undefined): boolean {
  return agent?.online === true && agent.secure === false
}

/**
 * Why a collector's traffic with the controller is unencrypted, if it is: a
 * socket session that reached the controller over plain HTTP, or an active
 * polled collector (its API is plain HTTP, and the controller sends the
 * collector's key with every poll). Unknown and inactive rows stay quiet.
 */
export function collectorUnencryptedReason(collector: Collector): 'socket' | 'poll' | null {
  if (collector.transport === 'agent') {
    return collector.connection?.online === true && collector.connection.secure === false
      ? 'socket'
      : null
  }
  if (collector.lifecycle !== 'adopted' || !collector.enabled) return null
  return isPlainHttpUrl(collector.baseUrl) ? 'poll' : null
}
