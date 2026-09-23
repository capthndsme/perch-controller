import { formatLastSeen } from '@/lib/collectors'
import type { DevicePresence } from '@/types/api'

/**
 * Wording for whether a device or a Wi-Fi client is connected right now. The
 * API decides (`DevicePresence`, `WifiClientSummary.active`); these only say
 * it, so every view reads "Connected" / "Disconnected" the same way.
 */

/** "Connected", "Disconnected · last seen 2 h ago", or "Disconnected" when never seen. */
export function presenceLabel(connected: boolean, lastSeenAt: string | null | undefined): string {
  if (connected) return 'Connected'
  const last = formatLastSeen(lastSeenAt)
  return last === 'never' ? 'Disconnected' : `Disconnected · last seen ${last}`
}

/** Status dot: green while connected, the wired grey once it left. */
export function presenceDotClass(connected: boolean): string {
  return connected ? 'bg-status-good' : 'bg-muted-foreground/40'
}

const CONNECTION_LABELS: Record<DevicePresence['via'], string> = {
  wifi: 'WiFi',
  ethernet: 'Ethernet',
  lan: 'Wired / unknown',
}

/**
 * What each way of attaching is called: `DevicePresence.via`, or a label's
 * `connection` mark (a subset of it). The `Record` makes a new value a compile
 * error until it has a name.
 */
export function connectionLabel(via: DevicePresence['via']): string {
  return CONNECTION_LABELS[via]
}
