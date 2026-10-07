import { formatKbps } from '@/lib/portal'
import type { SellItem } from '@/types/sell'

/**
 * Pure helpers for Sell Mode (docs/gateway/portal.md §15): the sale attempt
 * reference, the remembered portal, times in the instance's zone.
 */

/**
 * One reference per sale attempt (§15.3 `clientRef`, `^[A-Za-z0-9._:-]{8,64}$`),
 * reused when the seller retries: a double tap or a lost answer never sells
 * twice. `crypto.randomUUID` exists only in secure contexts, and Perch is
 * often reached over plain HTTP on the LAN: `getRandomValues` works in both.
 */
export function newClientRef(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const PORTAL_KEY = 'perch-sell-portal'

/** The portal this browser last sold on (a convenience: null when unknown or unreadable). */
export function readLastPortal(): number | null {
  try {
    const value = Number(localStorage.getItem(PORTAL_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function writeLastPortal(id: number) {
  try {
    localStorage.setItem(PORTAL_KEY, String(id))
  } catch {
    // per-browser convenience only
  }
}

/** "14:05" in the instance's time zone (the one "today" is counted in); the browser's when it is unknown. */
export function saleTime(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone })
  } catch {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
}

/** "↓ 5 Mbps · ↑ 2 Mbps" for the confirm step, or null without a speed tier. */
export function itemSpeed(item: Pick<SellItem, 'downKbps' | 'upKbps'>): string | null {
  const parts: string[] = []
  if (item.downKbps) parts.push(`↓ ${formatKbps(item.downKbps)}`)
  if (item.upKbps) parts.push(`↑ ${formatKbps(item.upKbps)}`)
  return parts.length ? parts.join(' · ') : null
}

/** What a shared code says (SMS, a chat app). */
export function shareText(code: string, what: string, portalName: string): string {
  return `Wi-Fi code for ${portalName}: ${code}\n${what}\nConnect to the Wi-Fi, then enter the code on the sign-in page.`
}
