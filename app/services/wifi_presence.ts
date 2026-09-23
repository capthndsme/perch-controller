/**
 * When a Wi-Fi station counts as a connected client, and, built on that,
 * whether a device is connected at all (`devicePresence`, at the end).
 *
 * `wifi_station_latest` keeps the last report of every MAC until the snapshot
 * retention drops it (14 d), so a row on its own means "seen at some point",
 * not "connected". A client that disassociates simply stops appearing in its
 * AP's station list: its row keeps the values of the last report that listed
 * it, a small `inactive_ms` included. Every "clients right now" read needs
 * both conditions:
 *
 * - its AP listed it recently: `recorded_at` within the AP's silence bound
 *   (`apStaleSeconds`, default max(3 × its report interval, 30 s)), the same
 *   bound after which an agent AP is reported stale (`ap_agent_metrics.ts`).
 *   An AP that stops reporting takes its clients with it.
 * - not idle for `CONNECTED_INACTIVE_MS` or longer, the threshold the client
 *   history rollup counts with (`client_distribution_rollup.ts`), so "now" and
 *   the history series count the same thing.
 *
 * The other thresholds are settings (Settings → Presence,
 * `presence_settings.ts`): callers read them once per request and pass them in.
 */

/**
 * Idle time from which a station an AP still lists no longer counts as a
 * client. Not a setting: the client-count rollup stores counts made with it,
 * so a new value would only reach history recomputed afterwards.
 */
export const CONNECTED_INACTIVE_MS = 200_000

/**
 * The thresholds behind "connected right now". All of them are applied when
 * data is read, so a new value takes effect on the next request.
 */
export type PresenceThresholds = {
  /** A device not on a Perch AP counts as connected while its traffic is this recent. */
  lanQuietMinutes: number
  /**
   * Traffic this long after a device's last Wi-Fi sighting still belongs to
   * that visit: the gateway keeps forwarding to a departed client's cached
   * address for a while (up to 7 min measured on 2026-09-22). Later traffic
   * means the device came back another way (a cable, an AP Perch does not read).
   */
  wifiTrailingTrafficMinutes: number
  /** An AP is silent after max(apStaleIntervals × its report interval, apStaleMinSeconds). */
  apStaleIntervals: number
  apStaleMinSeconds: number
  /**
   * The device list's "now" rates read 0 once a device's latest sample is
   * more than this many sample intervals older than the window's end.
   */
  nowRateIntervals: number
}

export const PRESENCE_DEFAULTS: Readonly<PresenceThresholds> = {
  lanQuietMinutes: 30,
  wifiTrailingTrafficMinutes: 10,
  apStaleIntervals: 3,
  apStaleMinSeconds: 30,
  nowRateIntervals: 3,
}

/** Seconds without a report after which an AP with this report interval is silent. */
export function apStaleSeconds(
  thresholds: PresenceThresholds,
  pollIntervalSeconds: number
): number {
  return Math.max(thresholds.apStaleIntervals * pollIntervalSeconds, thresholds.apStaleMinSeconds)
}

/**
 * SQL condition: the `wifi_station_latest` row aliased `station` is a
 * connected client; `ap` aliases its `wifi_access_points` row. Evaluated
 * against `UTC_TIMESTAMP()` in the database (stored times are UTC wall
 * times), so it does not depend on how the driver parses DATETIME values.
 * NULL when `inactive_ms` is unknown, which reads as not connected.
 */
export function stationConnectedSql(
  thresholds: PresenceThresholds,
  station = 's',
  ap = 'ap'
): string {
  // Integers from `presence_settings.ts`; Math.trunc keeps the SQL numeric whatever is passed.
  const intervals = Math.trunc(thresholds.apStaleIntervals)
  const floorSeconds = Math.trunc(thresholds.apStaleMinSeconds)
  return (
    `(${station}.inactive_ms < ${CONNECTED_INACTIVE_MS} AND ${station}.recorded_at >= ` +
    `UTC_TIMESTAMP() - INTERVAL GREATEST(${intervals} * ${ap}.poll_interval_seconds, ` +
    `${floorSeconds}) SECOND)`
  )
}

/**
 * SQL: seconds since the AP last heard from the station (its last listing
 * minus the idle time it reported then). Like the condition above it is
 * computed by the database; callers turn it into an instant right away.
 */
export function stationHeardAgoSql(station = 's'): string {
  return (
    `(TIMESTAMPDIFF(SECOND, ${station}.recorded_at, UTC_TIMESTAMP()) + ` +
    `COALESCE(${station}.inactive_ms, 0) DIV 1000)`
  )
}

/**
 * Whether a device is around right now and how it was last attached.
 * `ethernet`: the operator marked it as wired (its device label), or the
 * network map cables it with Ethernet or fibre. `lan`: not (or no longer) on a
 * Perch AP and not wired as far as Perch knows, a cable or Wi-Fi Perch does
 * not read; the dashboard says "Wired / unknown". `lastSeenAt`: over Wi-Fi,
 * when its AP last heard it (traffic trailing a departure is the gateway
 * talking to a device that is gone, not a sighting); wired, the later of its
 * last traffic and what its switch port last said; otherwise its last traffic.
 */
export type DevicePresence = {
  status: 'connected' | 'disconnected'
  via: 'wifi' | 'ethernet' | 'lan'
  lastSeenAt: string | null
}

/**
 * Where the network map puts a device (docs/infrastructure-view.md, amendment
 * A4 item 6), read per request from its node's uplink: the node's cabled port
 * with the lowest position.
 *
 * - `wired`: that cable is `ethernet` or `fiber`.
 * - `link`: its far end is a live agent port (an AP's or the Gateway agent's
 *   port, its agent online). `up` is that port's link state; `at` (epoch ms)
 *   is its agent's last report while up, and when the link went down while
 *   down. Null when the far end cannot be believed right now, or reports
 *   neither carrier nor operstate.
 */
export type DeviceOnMap = {
  wired: boolean
  link: { up: boolean; at: number } | null
}

/**
 * One rule for every device view. A device its AP lists is connected, however
 * quiet its traffic (a phone can sleep on Wi-Fi for hours); that holds for a
 * wired one too, since an AP lists it right now. A wired device (marked
 * Ethernet, or cabled on the map) otherwise is connected while its traffic is
 * recent or the port at the other end of its cable has link: traffic never
 * loses to the map, the link only adds. It never reads as gone from Wi-Fi.
 * Anything else: a device whose traffic ended with its last Wi-Fi sighting
 * (within `wifiTrailingTrafficMinutes`) left over Wi-Fi; otherwise it goes by
 * traffic, connected while it talked in the last `lanQuietMinutes`. Times are
 * epoch milliseconds.
 */
export function devicePresence(
  input: {
    /** From the device's `wifi_station_latest` row; null when it has none. */
    wifi: { connected: boolean; heardAt: number } | null
    /** When the collector last saw its traffic; null when never. */
    trafficAt: number | null
    /** The operator marked it as an Ethernet device (its label's `connection`). */
    ethernet?: boolean
    /** Where the network map puts it; null or absent when no node carries it. */
    onMap?: DeviceOnMap | null
  },
  thresholds: PresenceThresholds,
  now: number = Date.now()
): DevicePresence {
  const { wifi, trafficAt } = input
  const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())

  if (wifi?.connected) return { status: 'connected', via: 'wifi', lastSeenAt: iso(wifi.heardAt) }
  const talking = trafficAt !== null && now - trafficAt < thresholds.lanQuietMinutes * 60_000
  // Its traffic is on the cable, whatever Wi-Fi visit came before it; the
  // port at the other end of the cable can only add to it.
  if (input.ethernet || input.onMap?.wired) {
    const link = input.onMap?.link ?? null
    const status = talking || link?.up === true ? 'connected' : 'disconnected'
    const lastSeen =
      link === null ? trafficAt : trafficAt === null ? link.at : Math.max(trafficAt, link.at)
    return { status, via: 'ethernet', lastSeenAt: iso(lastSeen) }
  }
  if (
    wifi &&
    (trafficAt === null ||
      trafficAt <= wifi.heardAt + thresholds.wifiTrailingTrafficMinutes * 60_000)
  ) {
    return { status: 'disconnected', via: 'wifi', lastSeenAt: iso(wifi.heardAt) }
  }
  return { status: talking ? 'connected' : 'disconnected', via: 'lan', lastSeenAt: iso(trafficAt) }
}
