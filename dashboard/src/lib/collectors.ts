import type {
  Collector,
  CollectorConnection,
  CollectorGatewayReport,
  CollectorLifecycle,
  CollectorSource,
  CollectorStatus,
  CollectorTransport,
} from '@/types/api'

/**
 * Presentation helpers for collectors (Perch Network Collector, `Settings →
 * Collectors`).
 *
 * A collector's state lives in several columns that answer different
 * questions — `lifecycle` (may we use it at all), `enabled` (do we want to
 * right now), `connection` (is its socket open, socket rows only) and
 * `lastStatus` / `lastSeenAt` (did data arrive) — so every screen that shows
 * one has to fold them into a single word. `collectorHealth` is that one
 * place; use it instead of re-deriving "is this thing up" from `lastStatus.ok`.
 *
 * Everything here is pure: no fetching, no React, no `ApiError` handling.
 */

export type CollectorHealth = 'online' | 'stale' | 'offline' | 'never' | 'pending'

/** How late a poll may be, in multiples of the collector's own interval. */
const STALE_INTERVAL_MULTIPLIER = 3

/**
 * `pending` — announced, not adopted, never polled, so "up" is meaningless.
 * `never`   — adopted but never successfully probed, polled or pushed to.
 * `offline` — the last poll or probe failed, or a socket collector's socket
 *             is closed.
 * `stale`   — data stopped arriving: the last success was more than three
 *             intervals ago, or a connected socket collector went quiet.
 */
export function collectorHealth(collector: Collector, now = Date.now()): CollectorHealth {
  if (collector.lifecycle === 'pending') return 'pending'

  const socketRow = collector.transport === 'agent'
  if (socketRow && collector.connection && !collector.connection.online) return 'offline'

  const status = collector.lastStatus
  if (!status) return 'never'
  // A socket that is open but whose pushes stopped is not "offline": the
  // connection line on the card says it is connected.
  if (!status.ok) return socketRow && collector.connection?.online ? 'stale' : 'offline'

  const lastSeenMs = collector.lastSeenAt ? Date.parse(collector.lastSeenAt) : Number.NaN
  // A successful status with no `last_seen_at` is unusual enough that claiming
  // "online" would be a guess; say so instead.
  if (!Number.isFinite(lastSeenMs)) return 'stale'

  const intervalSeconds = collector.pollIntervalSeconds > 0 ? collector.pollIntervalSeconds : 5
  const staleAfterMs = intervalSeconds * STALE_INTERVAL_MULTIPLIER * 1000
  return now - lastSeenMs > staleAfterMs ? 'stale' : 'online'
}

export function collectorHealthLabel(health: CollectorHealth): string {
  if (health === 'online') return 'Online'
  if (health === 'stale') return 'Stale'
  if (health === 'offline') return 'Offline'
  if (health === 'pending') return 'Pending'
  return 'Never polled'
}

/** Dot colour for a health word, mirroring `wifiSignalQualityDotClass`. */
export function collectorHealthDotClass(health: CollectorHealth): string {
  if (health === 'online') return 'bg-status-good'
  if (health === 'stale') return 'bg-status-warning'
  if (health === 'offline') return 'bg-status-critical'
  return 'bg-muted-foreground/50'
}

export function collectorSourceLabel(source: CollectorSource): string {
  if (source === 'env') return 'COLLECTOR_URL'
  if (source === 'announced') return 'Announced'
  return 'Manual'
}

/** One line explaining who owns the row, or `null` when nothing needs saying. */
export function collectorSourceHint(
  source: CollectorSource,
  transport: CollectorTransport = 'poll',
): string | null {
  if (transport === 'agent') {
    return 'This collector dials in over a WebSocket and pushes its counters; nothing on it has to listen, and there is no address to poll.'
  }
  if (source === 'env') {
    return 'The server’s COLLECTOR_URL owns this address and restores it on every restart.'
  }
  if (source === 'announced') {
    return 'This collector announced itself; its address follows the announce it arrives from.'
  }
  return null
}

/** "Socket" or "Polled": how the controller gets this collector's counters. */
export function collectorTransportLabel(transport: CollectorTransport): string {
  return transport === 'agent' ? 'Socket' : 'Polled'
}

/** Tooltip for the transport badge. */
export function collectorTransportHint(transport: CollectorTransport): string {
  return transport === 'agent'
    ? 'The collector keeps a WebSocket open to this controller and pushes its counters'
    : "The controller polls the collector's HTTP API"
}

/**
 * "Push interval (seconds)" for a socket collector (the controller tells it
 * how often to push), "Poll interval (seconds)" otherwise.
 */
export function collectorIntervalLabel(transport: CollectorTransport): string {
  return transport === 'agent' ? 'Push interval (seconds)' : 'Poll interval (seconds)'
}

/**
 * The card's address line: the polled address, else where the socket comes
 * from, else a dash. Socket rows never show an address as if it were polled.
 */
export function collectorAddressLine(collector: Collector): string {
  if (collector.transport === 'agent') {
    const address = collector.connection?.address
    if (address) return `connected from ${address}`
    return collector.connection?.online === false ? 'not connected' : '—'
  }
  return collector.baseUrl ?? '—'
}

/** "just now", "40 s", "12 min", "3.5 h", "2 d": how long ago `timestamp` was. */
export function formatDurationSince(timestamp: string | null | undefined, now = Date.now()): string | null {
  if (!timestamp) return null
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at)) return null
  const seconds = Math.max(0, (now - at) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/**
 * One line for a socket collector's session: "Connected from 192.168.1.1
 * for 12 min", "Connected just now", or "Not connected · last data 3 min ago".
 */
export function collectorConnectionLine(
  connection: CollectorConnection | null,
  lastSeenAt: string | null,
  now = Date.now(),
): string {
  if (!connection || !connection.online) {
    const last = formatLastSeen(lastSeenAt, now)
    return last === 'never' ? 'Not connected' : `Not connected · last data ${last}`
  }
  const from = connection.address ? ` from ${connection.address}` : ''
  const since = formatDurationSince(connection.connectedAt, now)
  if (since === null) return `Connected${from}`
  if (since === 'just now') return `Connected${from} just now`
  return `Connected${from} for ${since}`
}

/** "Gateway · wan0, wan2" for a collector that reports gateway stats. */
export function collectorGatewayLabel(gateway: CollectorGatewayReport): string {
  return gateway.wanInterfaces.length > 0
    ? `Gateway · ${gateway.wanInterfaces.join(', ')}`
    : 'Gateway'
}

export function collectorLifecycleLabel(lifecycle: CollectorLifecycle): string {
  if (lifecycle === 'pending') return 'Pending adoption'
  if (lifecycle === 'dismissed') return 'Dismissed'
  return 'Adopted'
}

/**
 * The stored key fingerprint, as the admin can reproduce it on the collector:
 * `echo -n "$KEY" | sha256sum | cut -c1-8`. Lowercase hex, never the key.
 */
export function formatKeyFingerprint(fingerprint: string | null | undefined): string {
  if (!fingerprint) return '—'
  return fingerprint.toLowerCase()
}

/** "just now", "42 s ago", "3 min ago", "1.5 h ago", "2 d ago", "never". */
export function formatLastSeen(
  timestamp: string | null | undefined,
  now = Date.now(),
): string {
  if (!timestamp) return 'never'
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at)) return 'never'

  const seconds = Math.max(0, (now - at) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 90) return `${Math.round(seconds)} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

/**
 * True when the collector claimed an address the server is not polling — worth
 * showing, because "it says br-lan/192.168.1.1, we reach it at 192.168.1.1" is
 * the first thing to look at when an adoption polls the wrong box. Never for a
 * socket collector: nothing polls it, so there is no wrong box to reach.
 */
export function announcedAddressDiffers(collector: Collector): boolean {
  if (collector.transport === 'agent' || collector.baseUrl === null) return false
  return Boolean(collector.announcedBaseUrl) && collector.announcedBaseUrl !== collector.baseUrl
}

/** "down for 12 polls", or `null` while the collector is answering. */
export function collectorFailureNote(status: CollectorStatus | null): string | null {
  const failures = status?.failures ?? 0
  if (!failures) return null
  return `down for ${failures} ${failures === 1 ? 'poll' : 'polls'}`
}

/** The chunked purge a collector with history needs; never run from the UI. */
export function collectorPurgeCommand(collectorId: number): string {
  return `node ace collectors:purge --id=${collectorId}`
}

/** "147 devices · eno1 · v0.1.0 · 12 ms", or the failure reason. */
export function collectorProbeSummary(probe: CollectorStatus | null | undefined): string | null {
  if (!probe) return null
  if (!probe.ok) return probe.error ?? 'The collector did not answer.'

  const parts: string[] = []
  if (probe.totalDevices !== undefined) parts.push(`${probe.totalDevices} devices`)
  if (probe.captureInterface) parts.push(probe.captureInterface)
  if (probe.version) parts.push(`v${probe.version}`)
  if (probe.latencyMs !== undefined) parts.push(`${Math.round(probe.latencyMs)} ms`)
  return parts.length > 0 ? parts.join(' · ') : 'no detail reported'
}

/** Prints an OpenWrt collector's key fingerprint, to compare with the announced one. */
export const COLLECTOR_KEY_FINGERPRINT_COMMAND =
  "uci get perch-collector.main.api_key | tr -d '\\n' | sha256sum | cut -c1-8"

/** The commands that point an OpenWrt collector (the perch-collector package) at this controller. */
export function collectorServerUrlCommands(controllerUrl: string): string {
  return [
    `uci set perch-collector.main.server_url='${controllerUrl}'`,
    'uci commit perch-collector',
    '/etc/init.d/perch-collector restart',
  ].join('\n')
}
