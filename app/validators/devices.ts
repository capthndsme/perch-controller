import vine from '@vinejs/vine'

/**
 * Accepted range syntax for `?range=`. We hand-roll the regex (instead of
 * exposing free-form duration strings) because the read endpoints turn the
 * value into an `INTERVAL` lookup, and we want validation to reject
 * obviously-bogus inputs at the edge before they hit Knex.
 *
 * Examples: `60s`, `15m`, `24h`, `7d`. Min unit is seconds, max is days.
 */
const RANGE_REGEX = /^(\d{1,6})(s|m|h|d)$/

/**
 * Supported graph rollups. `5s` is the native bucket size for collectors
 * created post-cadence-tightening; `15s` covers historical buckets from
 * before the change. Coarser values are calculated on read by grouping
 * buckets in SQL via `UNIX_TIMESTAMP(bucket_start) DIV resolutionSeconds`.
 */
const RESOLUTION_VALUES = ['5s', '15s', '1m', '5m', '15m', '1h', '1d'] as const

const PEER_SCOPES = ['wan', 'lan'] as const

/**
 * Traffic-scope filter for `?scope=`. Differs from `PEER_SCOPES` because
 * traffic queries also accept `all` (the default) — peer queries don't,
 * since WAN and LAN heaps are answering distinct questions.
 */
const TRAFFIC_SCOPES = ['all', 'wan', 'lan'] as const

export type TrafficScope = (typeof TRAFFIC_SCOPES)[number]

/**
 * Time window shared by every read endpoint. Callers pass *either* a
 * relative `range` (default) or an absolute `from`/`to` pair (Grafana
 * drag-to-zoom / custom range pickers). When both are present, `from`/
 * `to` win — `range` is still validated so dashboards can keep the
 * relative value in the URL alongside the absolute one without
 * triggering a 400.
 */
const TIME_WINDOW_FIELDS = {
  range: vine.string().regex(RANGE_REGEX).optional(),
  from: vine.string().optional(),
  to: vine.string().optional(),
}

/**
 * `GET /api/v1/devices/:mac/traffic?range=...&resolution=...&collectorId?=...`
 *
 * `collectorId` is optional: when omitted, the controller aggregates rows
 * from every collector that has data for this MAC (rare in single-host
 * deployments but useful for the eventual multi-host fan-in).
 */
export const trafficQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
    scope: vine.enum(TRAFFIC_SCOPES).optional(),
  })
)

/**
 * `GET /api/v1/devices/:mac/peers?scope=wan|lan&collectorId?=...`
 *
 * `scope` is required because WAN and LAN heaps are answering very
 * different questions ("who is this device uploading to on the internet?"
 * vs "who is this device chatting with on the LAN?") — defaulting one
 * would make the UI's intent ambiguous.
 */
export const peersQueryValidator = vine.compile(
  vine.object({
    scope: vine.enum(PEER_SCOPES),
    collectorId: vine.number().positive().optional(),
  })
)

/**
 * `GET /api/v1/devices?range=...&collectorId?=...`
 *
 * Restricts the index to one collector when set; otherwise shows the
 * top-talker view across all collectors. Accepts the standard
 * `range`/`from`/`to` time window so the rendered "Total" column matches
 * the windowed sums the protocol and traffic endpoints already return —
 * see the controller for how the window is applied.
 */
export const devicesIndexValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    collectorId: vine.number().positive().optional(),
  })
)

export const aggregateTrafficQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
    scope: vine.enum(TRAFFIC_SCOPES).optional(),
  })
)

/**
 * `GET /api/v1/traffic/top?range=1h&resolution=15s&scope=all&limit=5&by=total`
 *
 * Top-N devices by bytes in the window, each as its own series, plus the
 * rest folded into one. `by` picks the ranking metric; `limit` caps N.
 */
export const TOP_TRAFFIC_RANK_VALUES = ['total', 'download', 'upload'] as const
export const topTrafficQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
    scope: vine.enum(TRAFFIC_SCOPES).optional(),
    limit: vine.number().min(1).max(10).optional(),
    by: vine.enum(TOP_TRAFFIC_RANK_VALUES).optional(),
  })
)

export const overviewQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
    scope: vine.enum(TRAFFIC_SCOPES).optional(),
  })
)

/**
 * `GET /api/v1/devices/:mac/protocols` and `GET /api/v1/protocols`.
 */
export const protocolsQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
  })
)

/**
 * `GET /api/v1/protocols/:protocol/devices`.
 */
export const protocolTopDevicesQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    collectorId: vine.number().positive().optional(),
    limit: vine.number().min(1).max(50).optional(),
  })
)

/**
 * `GET /api/v1/devices/:mac/peers/history?scope=wan|lan&range=...&limit?=...`
 * and `GET /api/v1/peers/top?scope=wan|lan&range=...&limit?=...`.
 *
 * Both read the hourly peer history (`device_peer_buckets_hourly`), so the
 * time window is the same one every other read endpoint takes. `scope` is
 * required for the same reason as `/peers` (WAN and LAN answer different
 * questions).
 */
export const peerHistoryQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    scope: vine.enum(PEER_SCOPES),
    collectorId: vine.number().positive().optional(),
    limit: vine.number().min(1).max(200).optional(),
  })
)

/**
 * `GET /api/v1/services` and `GET /api/v1/devices/:mac/services`: bytes served
 * per TLS SNI / HTTP Host, over the standard time window.
 */
export const servicesQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    collectorId: vine.number().positive().optional(),
    limit: vine.number().min(1).max(200).optional(),
  })
)

/**
 * `GET /api/v1/services/:serverName/traffic` and
 * `/api/v1/destinations/:serverName/traffic`: the finest bucket the caller
 * wants. Omitted = auto (the admin floor, `chart_settings.ts`). The server
 * may answer coarser: the point cap and the stored detail win
 * (`series_buckets.ts`). The old values `5m` / `1h` / `1d` keep working.
 */
export const SERIES_RESOLUTION_VALUES = [
  '15s',
  '30s',
  '1m',
  '2m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '2h',
  '3h',
  '6h',
  '12h',
  '1d',
] as const
export type SeriesResolution = (typeof SERIES_RESOLUTION_VALUES)[number]

export const serviceTrafficQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(SERIES_RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
  })
)

/** `GET /api/v1/destinations` and `GET /api/v1/devices/:mac/destinations`. */
export const destinationsQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    collectorId: vine.number().positive().optional(),
    limit: vine.number().min(1).max(200).optional(),
  })
)

/**
 * Optional `?mac=` on the usage endpoints: one device's usage. Colon or
 * dash separated, any case; the controller normalises it to the stored
 * lower-case colon form (`normalizeMac`).
 */
const USAGE_MAC_REGEX = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/

/** `GET /api/v1/usage` — vnstat-style buckets per local day / week / month. */
export const USAGE_PERIOD_VALUES = ['day', 'week', 'month'] as const
export const USAGE_SCOPE_VALUES = ['all', 'wan', 'lan'] as const
export const usageQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    period: vine.enum(USAGE_PERIOD_VALUES).optional(),
    scope: vine.enum(USAGE_SCOPE_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
    protocols: vine.number().min(1).max(20).optional(),
    mac: vine.string().trim().regex(USAGE_MAC_REGEX).optional(),
  })
)

/** `GET /api/v1/usage/intervals` — sub-day slots for the daily view. */
export const USAGE_INTERVAL_VALUES = ['auto', '1h', '4h', '8h', '12h'] as const
export const usageIntervalsQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    interval: vine.enum(USAGE_INTERVAL_VALUES).optional(),
    scope: vine.enum(USAGE_SCOPE_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
    mac: vine.string().trim().regex(USAGE_MAC_REGEX).optional(),
  })
)

/** `GET /api/v1/router` — gateway samples, ~200 points per window. */
export const ROUTER_RESOLUTION_VALUES = ['auto', '1m', '5m', '15m', '1h'] as const
export const routerQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(ROUTER_RESOLUTION_VALUES).optional(),
  })
)

/** `GET /api/v1/destinations/:serverName/traffic` — hourly history, `1h` or `1d`. */
export const destinationTrafficQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(SERIES_RESOLUTION_VALUES).optional(),
    collectorId: vine.number().positive().optional(),
  })
)

/**
 * Parses `15m` → `{ value: 15, unit: 'm' }`. Exposed for the controller
 * (which converts to seconds) and for tests. Returns null on a malformed
 * input that somehow bypasses the validator (defensive).
 */
export function parseRange(raw: string): { seconds: number } | null {
  const m = RANGE_REGEX.exec(raw)
  if (!m) return null
  const value = Number(m[1])
  const unit = m[2]
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
  return { seconds: value * multipliers[unit] }
}

export const RESOLUTION_SECONDS: Record<(typeof RESOLUTION_VALUES)[number], number> = {
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
}

export type TrafficResolution = (typeof RESOLUTION_VALUES)[number]
