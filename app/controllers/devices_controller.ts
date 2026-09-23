import { enrichIp, type AsnInfo } from '#services/asn_enrichment'
import { HOURLY_ROLLUP_SECONDS, PROTOCOL_NATIVE_GRAIN_SECONDS } from '#services/bucket_writer'
import {
  getDeviceLabels,
  normalizeMac,
  type DeviceConnection,
  type DeviceType,
} from '#services/device_labels'
import {
  queryDevicePresence,
  queryLatestWifiContext,
  queryTrafficSeenAt,
} from '#services/device_presence_query'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { loadDeviceAttachments } from '#services/infra_topology'
import { getPresenceSettings } from '#services/presence_settings'
import { categoryFor, getProtocolCategoryMap } from '#services/protocol_categories'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import { pickAggregateTier, pickSeriesTier, windowSpanSeconds } from '#services/rollup_tiers'
import { queryTopDevicesHistory } from '#services/top_devices_history'
import { devicePresence } from '#services/wifi_presence'
import { classifySignalQuality } from '#services/wifi_signal_quality'
import DeviceSummaryTransformer, {
  type DeviceSummaryRow,
} from '#transformers/device_summary_transformer'
import {
  RESOLUTION_SECONDS,
  aggregateTrafficQueryValidator,
  devicesIndexValidator,
  overviewQueryValidator,
  parseRange,
  peerHistoryQueryValidator,
  peersQueryValidator,
  protocolTopDevicesQueryValidator,
  protocolsQueryValidator,
  topTrafficQueryValidator,
  trafficQueryValidator,
  type TrafficResolution,
  type TrafficScope,
} from '#validators/devices'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

type TrafficBucketRow = {
  collectorId: number | null
  bucketStart: Date | string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
  packetsIn: bigint | number | string
  packetsOut: bigint | number | string
}

/**
 * Picks the byte/packet column pair that satisfies `scope`. WAN/LAN map
 * to the per-scope splits the collector emits; `all` aggregates the
 * totals (which still hold for buckets written before the LAN-split
 * release).
 */
function scopeColumns(scope: TrafficScope): {
  bytesIn: string
  bytesOut: string
  packetsIn: string
  packetsOut: string
} {
  if (scope === 'wan') {
    return {
      bytesIn: 'b.bytes_in_wan',
      bytesOut: 'b.bytes_out_wan',
      packetsIn: 'b.packets_in_wan',
      packetsOut: 'b.packets_out_wan',
    }
  }
  if (scope === 'lan') {
    return {
      bytesIn: 'b.bytes_in_lan',
      bytesOut: 'b.bytes_out_lan',
      packetsIn: 'b.packets_in_lan',
      packetsOut: 'b.packets_out_lan',
    }
  }
  return {
    bytesIn: 'b.bytes_in',
    bytesOut: 'b.bytes_out',
    packetsIn: 'b.packets_in',
    packetsOut: 'b.packets_out',
  }
}

/*
 * ── Rollup routing ──────────────────────────────────────────────────────
 * Wide-window reads switch from the native bucket tables to a rollup tier
 * (see bucket_writer's ROLLUP_TIERS). This collapses millions of native rows
 * into thousands of grain rows AND, when the requested grain equals the
 * tier's grain, lets the query GROUP BY a bare indexed column instead of a
 * derived FROM_UNIXTIME(FLOOR()) expression — dropping the "Using temporary;
 * Using filesort" the native path forces.
 */

// `pickSeriesTier`, `useHourlyForAggregate`, and `windowSpanSeconds` live in
// `#services/rollup_tiers` so the devices and wifi read paths share one
// native-vs-rollup decision.

const RESOLUTION_ORDER: TrafficResolution[] = ['5s', '15s', '1m', '5m', '15m', '1h', '1d']

/**
 * Coarsening target. The frontend already aims for ~2000 chart points;
 * matching it here means a too-fine request over a wide window is bumped up
 * the resolution ladder until it fits — and a multi-week window lands on
 * `1h`, which is exactly what routes it onto the rollup.
 */
const CLAMP_TARGET_BUCKETS = 2000

/**
 * Hard reject ceiling. Even at the coarsest grain (`1d`) a window can be
 * absurd (`range=999999d`); past this many buckets we 400 instead of
 * building the result.
 */
const HARD_MAX_BUCKETS = 50_000

/**
 * Coarsen `resolution` upward until the window fits inside
 * `CLAMP_TARGET_BUCKETS`, capping at the coarsest supported grain. Returns
 * the (possibly unchanged) resolution the query should actually use; the
 * endpoint echoes it back so the client sees the effective grain.
 */
function clampResolution(
  resolution: TrafficResolution,
  since: DateTime,
  until: DateTime
): TrafficResolution {
  const span = windowSpanSeconds(since, until)
  let i = RESOLUTION_ORDER.indexOf(resolution)
  while (
    i < RESOLUTION_ORDER.length - 1 &&
    span / RESOLUTION_SECONDS[RESOLUTION_ORDER[i]] > CLAMP_TARGET_BUCKETS
  ) {
    i += 1
  }
  return RESOLUTION_ORDER[i]
}

/** True when even the clamped grain would still produce too many buckets. */
function windowTooLarge(resolutionSeconds: number, since: DateTime, until: DateTime): boolean {
  return windowSpanSeconds(since, until) / resolutionSeconds > HARD_MAX_BUCKETS
}

/**
 * Resolve the effective time-series grain for an endpoint: take the caller's
 * `resolution` (or the endpoint default), coarsen it to fit the bucket
 * budget, and reject windows so wide they overflow even at `1h`. Endpoints
 * echo the returned `resolution` so the client sees the grain it actually got.
 */
function resolveResolution(
  requested: TrafficResolution | undefined,
  fallback: TrafficResolution,
  since: DateTime,
  until: DateTime,
  minSeconds = 0
):
  | { resolution: TrafficResolution; error?: never }
  | { error: { error: string; message: string }; resolution?: never } {
  let resolution = clampResolution(requested ?? fallback, since, until)
  if (RESOLUTION_SECONDS[resolution] < minSeconds) {
    resolution =
      RESOLUTION_ORDER.find((r) => RESOLUTION_SECONDS[r] >= minSeconds) ??
      RESOLUTION_ORDER[RESOLUTION_ORDER.length - 1]
  }
  if (windowTooLarge(RESOLUTION_SECONDS[resolution], since, until)) {
    return {
      error: {
        error: 'window_too_large',
        message:
          'The requested time range is too large to render even at 1h resolution. ' +
          'Narrow the range or use an absolute from/to window.',
      },
    }
  }
  return { resolution }
}

/**
 * Protocol series are stored at 1 m natively (`PROTOCOL_NATIVE_GRAIN_SECONDS`)
 * and are the highest-cardinality stream, so protocol reads never go finer
 * than 1 m and jump straight to the hourly tier once the window spans two
 * days — the 5-minute tier at 15 m over a week was a 17 s temp+filesort.
 */
function protocolMinResolutionSeconds(since: DateTime, until: DateTime): number {
  return windowSpanSeconds(since, until) >= 2 * 86400
    ? HOURLY_ROLLUP_SECONDS
    : PROTOCOL_NATIVE_GRAIN_SECONDS
}

type PeerRow = {
  collectorId: number
  peerIp: string
  scope: 'wan' | 'lan'
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
  updatedAt: Date | string
}

type IdentityRow = {
  collectorId: number
  mac: string
  primaryIp: string | null
  ips: string | null
  firstSeenAt: Date | string | null
  lastSeenAt: Date | string | null
}

type IdentityViewBase = {
  collectorId: number
  mac: string
  primaryIp: string | null
  ips: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
}

type IdentityView = IdentityViewBase & {
  hostname: string | null
  hostnameSource: string | null
  /** From `device_labels`: what an operator called this device. */
  customName: string | null
  deviceType: DeviceType | null
  /** `ethernet` when the operator marked it as wired. */
  connection: DeviceConnection | null
  tags: string[]
  notes: string | null
}

type TopAsn = {
  asn: number | null
  org: string
  prefix: string | null
  bytesIn: number
  bytesOut: number
  totalBytes: number
  peers: Array<{ ip: string; bytesIn: number; bytesOut: number }>
}

type ProtocolAggregateRow = {
  protocol: string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
  packetsIn: bigint | number | string
  packetsOut: bigint | number | string
}

type ProtocolTimeSeriesRow = {
  bucketStart: Date | string
  protocol: string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
}

type ProtocolBreakdownEntry = {
  protocol: string
  /** nDPI application category of the label (`other` when unknown). */
  category: string
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  percentage: number
}

type ProtocolTopDeviceRow = {
  collectorId: number
  mac: string
  primaryIp: string | null
  ips: string | null
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
  packetsIn: bigint | number | string
  packetsOut: bigint | number | string
}

export default class DevicesController {
  async index({ request, response, serialize }: HttpContext) {
    const qs = await devicesIndexValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)

    // Wide windows aggregate from a rollup tier (thousands of rows, bare
    // GROUP BY) instead of the native table (millions of rows, temp+filesort).
    const aggTier = pickAggregateTier(window.since, window.until)
    const table = aggTier ? aggTier.trafficTable : 'device_traffic_buckets'
    const timeCol = aggTier ? aggTier.timeColumn : 'bucket_start'
    // Mbps = latestBytes / resolutionSeconds. On the native path the latest
    // row is one poll interval; on a rollup path it is the most recent
    // (possibly still-filling) slot, so divide by the grain to read it as the
    // device's average rate over that slot rather than a live poll rate.
    const resolutionSecondsExpr = aggTier ? String(aggTier.grainSeconds) : 'c.poll_interval_seconds'

    const sinceSql = window.since.toFormat('yyyy-MM-dd HH:mm:ss')
    const untilSql = window.until.toFormat('yyyy-MM-dd HH:mm:ss')
    const where: string[] = [`b.${timeCol} >= ?`, `b.${timeCol} < ?`]
    const bindings: Array<string | number> = [sinceSql, untilSql]
    if (qs.collectorId) {
      where.push('b.collector_id = ?')
      bindings.push(qs.collectorId)
    }

    // Two pieces in one statement:
    //   1. `agg` SUMs per (collector, mac) inside the window so the
    //      "Total" column lines up with the protocols panel, which sums
    //      the same window.
    //   2. The JOIN back to `latest` picks up the most recent bucket *inside
    //      the window* so live Mbps columns reflect a recent slice rather
    //      than the whole window. Devices with no traffic in the window are
    //      dropped, matching `/api/v1/protocols` behavior — an idle device on
    //      a "Last 1h" view shouldn't pretend to have a current rate. Nor
    //      should one whose latest bucket lies more than `nowRateIntervals`
    //      intervals before the window's end (Settings → Presence, applied
    //      per request from `latestLagSeconds`): it went quiet, and its last
    //      rate from hours ago is not "now".
    const sql = `
      SELECT
        agg.mac                  AS mac,
        agg.windowBytesIn        AS windowBytesIn,
        agg.windowBytesOut       AS windowBytesOut,
        agg.windowPacketsIn      AS windowPacketsIn,
        agg.windowPacketsOut     AS windowPacketsOut,
        agg.windowBytesInWan     AS windowBytesInWan,
        agg.windowBytesOutWan    AS windowBytesOutWan,
        agg.windowBytesInLan     AS windowBytesInLan,
        agg.windowBytesOutLan    AS windowBytesOutLan,
        latest.bytes_in          AS latestBytesIn,
        latest.bytes_out         AS latestBytesOut,
        latest.bytes_in_wan      AS latestBytesInWan,
        latest.bytes_out_wan     AS latestBytesOutWan,
        latest.bytes_in_lan      AS latestBytesInLan,
        latest.bytes_out_lan     AS latestBytesOutLan,
        latest.${timeCol}        AS bucketStart,
        ${resolutionSecondsExpr} AS resolutionSeconds,
        TIMESTAMPDIFF(SECOND, latest.${timeCol}, ?) AS latestLagSeconds,
        i.primary_ip             AS primaryIp,
        i.ips                    AS ips,
        i.last_seen_at           AS identityLastSeenAt,
        c.id                     AS collectorId,
        c.name                   AS collectorName,
        c.last_status            AS collectorLastStatus
      FROM (
        SELECT
          b.collector_id        AS collectorId,
          b.mac                 AS mac,
          SUM(b.bytes_in)       AS windowBytesIn,
          SUM(b.bytes_out)      AS windowBytesOut,
          SUM(b.packets_in)     AS windowPacketsIn,
          SUM(b.packets_out)    AS windowPacketsOut,
          SUM(b.bytes_in_wan)   AS windowBytesInWan,
          SUM(b.bytes_out_wan)  AS windowBytesOutWan,
          SUM(b.bytes_in_lan)   AS windowBytesInLan,
          SUM(b.bytes_out_lan)  AS windowBytesOutLan,
          MAX(b.${timeCol})     AS latestBucketStart
        FROM ${table} b
        WHERE ${where.join(' AND ')}
        GROUP BY b.collector_id, b.mac
      ) agg
      INNER JOIN ${table} latest
        ON latest.collector_id = agg.collectorId
       AND latest.mac          = agg.mac
       AND latest.${timeCol}   = agg.latestBucketStart
      INNER JOIN collectors c ON c.id = agg.collectorId
      LEFT JOIN device_identities i
        ON i.collector_id = agg.collectorId
       AND i.mac          = agg.mac
      ORDER BY (agg.windowBytesIn + agg.windowBytesOut) DESC
    `

    const { ttlMs, segment } = windowCache(null, window.since, window.until, Date.now())
    const [rows, thresholds] = await Promise.all([
      cachedQuery(cacheKey(['devices:index', segment, qs.collectorId ?? '']), ttlMs, async () =>
        rawRows<DeviceSummaryRow>(await db.rawQuery(sql, [untilSql, ...bindings]))
      ),
      getPresenceSettings(),
    ])
    // All five enrichments are batched: wifi context and traffic times in one
    // query each, hostnames in one state lookup, labels in one cached table
    // read, and where the map puts the devices in a fixed handful of queries
    // (`loadDeviceAttachments`). The per-row map below is then pure CPU — no
    // awaits, no N+1 settings reads, no per-row chance of triggering the
    // lxc/ssh refresh. Wi-Fi, traffic times and attachments describe now, so
    // they are read per request, never from the cached rows above (a past
    // window's rows are kept for hours).
    const macs = rows.map((row) => row.mac)
    const [wifiByMac, trafficSeenAt, hostnameMatches, labelsByMac, placements] = await Promise.all([
      queryLatestWifiContext(macs, thresholds),
      queryTrafficSeenAt(macs),
      getHostnameMatches(
        rows.map((row) => ({
          mac: row.mac,
          primaryIp: row.primaryIp,
          ips: parseIps(row.ips),
        }))
      ),
      getDeviceLabels(macs),
      loadDeviceAttachments(macs, thresholds),
    ])
    const rowsWithHostnames = rows.map((row, i) => {
      const match = hostnameMatches[i]
      const wifi = wifiByMac.get(row.mac.toLowerCase())
      const label = labelsByMac.get(row.mac.toLowerCase())
      const placement = placements.get(row.mac.toLowerCase())
      const presence = devicePresence(
        {
          wifi: wifi ? { connected: wifi.connected, heardAt: wifi.heardAt } : null,
          trafficAt: trafficSeenAt.get(`${row.collectorId}:${row.mac.toLowerCase()}`) ?? null,
          ethernet: label?.connection === 'ethernet',
          onMap: placement?.onMap ?? null,
        },
        thresholds
      )
      return {
        ...row,
        latestIsCurrent:
          Number(row.latestLagSeconds) <=
          thresholds.nowRateIntervals * Number(row.resolutionSeconds),
        hostname: match?.hostname ?? null,
        hostnameSource: match?.source ?? null,
        customName: label?.name ?? null,
        deviceType: label?.deviceType ?? null,
        connection: label?.connection ?? null,
        tags: label?.tags ?? [],
        notes: label?.notes ?? null,
        wifiConnected: wifi?.connected ?? false,
        wifiApId: wifi?.apId ?? null,
        wifiApName: wifi?.apName ?? null,
        wifiSsid: wifi?.ssid ?? null,
        wifiBand: wifi?.band ?? null,
        wifiSignalDbm: wifi?.signalDbm ?? null,
        wifiSignalQuality: classifySignalQuality(wifi?.signalDbm),
        wifiSnrDb: wifi?.snrDb ?? null,
        wifiTxRateKbps: wifi?.txRateKbps ?? null,
        wifiRxRateKbps: wifi?.rxRateKbps ?? null,
        wifiInactiveMs: wifi?.inactiveMs ?? null,
        wifiHeardAt: wifi ? new Date(wifi.heardAt).toISOString() : null,
        presence,
        attachment: placement?.attachment ?? null,
      } satisfies DeviceSummaryRow
    })

    return serialize(DeviceSummaryTransformer.transform(rowsWithHostnames))
  }

  /**
   * GET /api/v1/peers/top?scope=wan|lan&range=...&limit?=25&collectorId?=
   *
   * Network-wide "where is the traffic going": the peer IPs every device
   * exchanged the most bytes with inside the window, from the hourly peer
   * history. WAN peers are enriched with their ASN and grouped by it.
   */
  async topPeers({ request, response, serialize }: HttpContext) {
    const qs = await peerHistoryQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 25

    const result = await queryPeerHistory({
      scope: qs.scope,
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
      limit,
    })

    return serialize({
      scope: qs.scope,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      limit,
      ...result,
    })
  }

  /**
   * GET /api/v1/devices/:mac/peers/history?scope=wan|lan&range=...&limit?=25
   *
   * The same view for one device: who it talked to inside the window and how
   * much, rather than the latest-only heap `/peers` returns.
   */
  async peersHistory({ request, params, response, serialize }: HttpContext) {
    const qs = await peerHistoryQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 25

    const result = await queryPeerHistory({
      mac: params.mac,
      scope: qs.scope,
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
      limit,
    })

    if (result.peers.length === 0 && !(await macExists(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has never been seen by any collector.`,
      })
    }

    return serialize({
      mac: params.mac,
      scope: qs.scope,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      limit,
      ...result,
    })
  }

  async aggregateTraffic({ request, response, serialize }: HttpContext) {
    const qs = await aggregateTrafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)
    const resolved = resolveResolution(qs.resolution, '15s', window.since, window.until)
    if (resolved.error) return response.badRequest(resolved.error)
    const resolution = resolved.resolution
    const scope = qs.scope ?? 'all'

    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const buckets = await queryTrafficBuckets({
      since: window.since,
      until: window.until,
      resolution,
      collectorId: qs.collectorId,
      scope,
      aggregateCollectors: true,
    })

    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds,
      scope,
      summary: summarizeBuckets(buckets, resolutionSeconds, DateTime.utc()),
      buckets: buckets.map((row) => toBucketRow(row, resolutionSeconds)),
    })
  }

  /**
   * GET /api/v1/traffic/top?range=1h&resolution=15s&scope=all&limit=5&by=total
   *
   * The busiest N devices in the window as separate rate series plus every
   * other device folded into `rest` — the "who is eating the bandwidth"
   * stack on the Devices page. Same grain clamping as `/traffic`.
   */
  async topTraffic({ request, response, serialize }: HttpContext) {
    const qs = await topTrafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)
    const resolved = resolveResolution(qs.resolution, '15s', window.since, window.until)
    if (resolved.error) return response.badRequest(resolved.error)
    const resolution = resolved.resolution
    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const scope = qs.scope ?? 'all'
    const limit = qs.limit ?? 5
    const by = qs.by ?? 'total'

    const history = await queryTopDevicesHistory({
      since: window.since,
      until: window.until,
      resolution,
      resolutionSeconds,
      scope,
      limit,
      by,
      collectorId: qs.collectorId,
    })

    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds,
      scope,
      limit,
      by,
      ...history,
    })
  }

  async traffic({ request, params, response, serialize }: HttpContext) {
    const qs = await trafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const resolved = resolveResolution(qs.resolution, '15s', window.since, window.until)
    if (resolved.error) return response.badRequest(resolved.error)
    const resolution = resolved.resolution
    const scope = qs.scope ?? 'all'

    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const buckets = await queryTrafficBuckets({
      mac: params.mac,
      since: window.since,
      until: window.until,
      resolution,
      collectorId: qs.collectorId,
      scope,
      aggregateCollectors: false,
    })

    if (buckets.length === 0 && !(await macExists(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `No traffic ever recorded for MAC ${params.mac}.`,
      })
    }

    return serialize({
      mac: params.mac,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds,
      scope,
      buckets: buckets.map((row) => toBucketRow(row, resolutionSeconds)),
    })
  }

  async peers({ request, params, response, serialize }: HttpContext) {
    const { scope, collectorId } = await peersQueryValidator.validate(request.qs())
    const rows = await queryPeers(params.mac, scope, collectorId)

    if (rows.length === 0 && !(await macExists(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has never been seen by any collector.`,
      })
    }

    return serialize({
      mac: params.mac,
      scope,
      peers: rows.map(toPeerRow),
    })
  }

  async aggregateProtocols({ request, response, serialize }: HttpContext) {
    const qs = await protocolsQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)
    const resolved = resolveResolution(
      qs.resolution,
      '1m',
      window.since,
      window.until,
      protocolMinResolutionSeconds(window.since, window.until)
    )
    if (resolved.error) return response.badRequest(resolved.error)
    const resolution = resolved.resolution

    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    // Only fetch the time series — the summary (total per protocol) is
    // derived from the same data in buildProtocolsResponse, avoiding a
    // second full scan of device_protocol_buckets.
    const [seriesRows, categories] = await Promise.all([
      queryProtocolTimeSeries({
        since: window.since,
        until: window.until,
        resolution,
        collectorId: qs.collectorId,
      }),
      getProtocolCategoryMap(),
    ])

    return serialize(
      buildProtocolsResponse(
        null,
        window.range,
        window.since,
        window.until,
        resolution,
        resolutionSeconds,
        null,
        seriesRows,
        categories
      )
    )
  }

  async aggregateProtocolDevices({ request, params, response, serialize }: HttpContext) {
    const qs = await protocolTopDevicesQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 5

    const rows = await queryProtocolTopDevices({
      protocol: params.protocol,
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
    })

    const devices = rows.map(toProtocolTopDevice)
    const protocolTotalBytes = devices.reduce((sum, device) => sum + device.totalBytes, 0)
    // Name enrichment is only resolved for the top-N rows we actually
    // return — the "other" bucket is aggregated and never displays a name,
    // so paying the lookup cost for the long tail is wasteful.
    const shown = devices.slice(0, limit)
    const [matches, labelsByMac] = await Promise.all([
      getHostnameMatches(
        shown.map((device) => ({
          mac: device.mac,
          primaryIp: device.primaryIp,
          ips: device.ips,
        }))
      ),
      getDeviceLabels(shown.map((device) => device.mac)),
    ])
    const topDevices = shown.map((device, i) => {
      const label = labelsByMac.get(device.mac.toLowerCase())
      return {
        ...device,
        hostname: matches[i]?.hostname ?? null,
        hostnameSource: matches[i]?.source ?? null,
        customName: label?.name ?? null,
        deviceType: label?.deviceType ?? null,
        percentage: percentageOf(device.totalBytes, protocolTotalBytes),
      }
    })
    const otherDevices = devices.slice(limit)
    const otherTotal = otherDevices.reduce((sum, device) => sum + device.totalBytes, 0)

    return serialize({
      protocol: params.protocol,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      limit,
      totalBytes: protocolTotalBytes,
      devices: topDevices,
      other:
        otherDevices.length > 0
          ? {
              deviceCount: otherDevices.length,
              bytesIn: otherDevices.reduce((sum, device) => sum + device.bytesIn, 0),
              bytesOut: otherDevices.reduce((sum, device) => sum + device.bytesOut, 0),
              totalBytes: otherTotal,
              percentage: percentageOf(otherTotal, protocolTotalBytes),
            }
          : null,
    })
  }

  async protocols({ request, params, response, serialize }: HttpContext) {
    const qs = await protocolsQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)
    const resolved = resolveResolution(
      qs.resolution,
      '1m',
      window.since,
      window.until,
      protocolMinResolutionSeconds(window.since, window.until)
    )
    if (resolved.error) return response.badRequest(resolved.error)
    const resolution = resolved.resolution

    if (!(await macExists(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has never been seen by any collector.`,
      })
    }

    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const [summaryRows, seriesRows, categories] = await Promise.all([
      queryProtocolSummary({
        mac: params.mac,
        since: window.since,
        until: window.until,
        collectorId: qs.collectorId,
      }),
      queryProtocolTimeSeries({
        mac: params.mac,
        since: window.since,
        until: window.until,
        resolution,
        collectorId: qs.collectorId,
      }),
      getProtocolCategoryMap(),
    ])

    return serialize(
      buildProtocolsResponse(
        params.mac,
        window.range,
        window.since,
        window.until,
        resolution,
        resolutionSeconds,
        summaryRows,
        seriesRows,
        categories
      )
    )
  }

  async overview({ request, params, response, serialize }: HttpContext) {
    const qs = await overviewQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)
    const resolved = resolveResolution(qs.resolution, '1m', window.since, window.until)
    if (resolved.error) return response.badRequest(resolved.error)
    const resolution = resolved.resolution
    const scope = qs.scope ?? 'all'

    if (!(await macExists(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has never been seen by any collector.`,
      })
    }

    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const [identityRows, buckets, wanPeers, lanPeers, protocolRows] = await Promise.all([
      queryIdentity(params.mac, qs.collectorId),
      queryTrafficBuckets({
        mac: params.mac,
        since: window.since,
        until: window.until,
        resolution,
        collectorId: qs.collectorId,
        scope,
        aggregateCollectors: false,
      }),
      queryPeers(params.mac, 'wan', qs.collectorId),
      queryPeers(params.mac, 'lan', qs.collectorId),
      queryProtocolSummary({
        mac: params.mac,
        since: window.since,
        until: window.until,
        collectorId: qs.collectorId,
      }),
    ])
    const identity = await enrichIdentityRows(identityRows)

    return serialize({
      mac: params.mac,
      scope,
      identity,
      traffic: {
        range: window.range,
        from: window.since.toISO(),
        to: window.until.toISO(),
        resolution,
        resolutionSeconds,
        scope,
        buckets: buckets.map((row) => toBucketRow(row, resolutionSeconds)),
      },
      peers: {
        wan: wanPeers.map(toPeerRow),
        lan: lanPeers.map(toPeerRow),
      },
      topAsns: await groupTopAsns(wanPeers),
      protocols: withPercentages(protocolRows, await getProtocolCategoryMap()).map((p) => ({
        protocol: p.protocol,
        category: p.category,
        bytesIn: p.bytesIn,
        bytesOut: p.bytesOut,
        percentage: p.percentage,
      })),
    })
  }

  /**
   * GET /api/v1/devices/:mac/presence
   *
   * Connected right now or not, and how (`wifi_presence.ts`), plus where the
   * network map puts the device (`attachment`, null when no node carries
   * it). Separate from the window-bound overview so the device page can poll
   * it whatever it shows.
   */
  async presence({ params, response, serialize }: HttpContext) {
    if (!(await macExists(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has never been seen by any collector.`,
      })
    }
    const thresholds = await getPresenceSettings()
    const mac = normalizeMac(params.mac) ?? String(params.mac).toLowerCase()
    const placements = await loadDeviceAttachments([mac], thresholds)
    const placement = placements.get(mac)
    const presence = await queryDevicePresence(params.mac, thresholds, placement?.onMap ?? null)
    return serialize({ ...presence, attachment: placement?.attachment ?? null })
  }
}

/**
 * Resolve `{ range?, from?, to? }` query params into a concrete
 * `[since, until]` pair. The three forms supported are:
 *
 *  - `from` + `to`: absolute window (Grafana drag-to-zoom / custom range).
 *  - `range`: relative window of N seconds ending now (the legacy form).
 *  - neither: fall back to the endpoint's default range.
 *
 * Both `from` and `to` must be valid ISO-8601 timestamps with `from <
 * to`. We surface the original `range` string on the response (or null
 * when absolute) so the client can preserve the relative selection in
 * the URL alongside the absolute one.
 */
function resolveTimeWindow(
  qs: { range?: string; from?: string; to?: string },
  defaultRange: string
):
  | { error: { error: string; message: string }; since?: never; until?: never; range?: never }
  | { error?: never; since: DateTime; until: DateTime; range: string | null } {
  if (qs.from && qs.to) {
    const since = DateTime.fromISO(qs.from, { zone: 'utc' })
    const until = DateTime.fromISO(qs.to, { zone: 'utc' })
    if (!since.isValid || !until.isValid) {
      return {
        error: {
          error: 'invalid_window',
          message: '`from` and `to` must be valid ISO-8601 timestamps.',
        },
      }
    }
    if (until <= since) {
      return {
        error: {
          error: 'invalid_window',
          message: '`to` must be strictly greater than `from`.',
        },
      }
    }
    return { since, until, range: qs.range ?? null }
  }

  const range = qs.range ?? defaultRange
  const parsed = parseRange(range)
  if (!parsed) {
    return {
      error: {
        error: 'invalid_range',
        message: `Range "${range}" is not a recognised duration.`,
      },
    }
  }
  const until = DateTime.utc()
  const since = until.minus({ seconds: parsed.seconds })
  return { since, until, range }
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}

async function macExists(mac: string): Promise<boolean> {
  const [identity, bucket, hourly, peer] = await Promise.all([
    db.from('device_identities').where('mac', mac).limit(1).select('id'),
    db.from('device_traffic_buckets').where('mac', mac).limit(1).select('id'),
    db.from('device_traffic_buckets_hourly').where('mac', mac).limit(1).select('mac'),
    db.from('device_top_peers').where('mac', mac).limit(1).select('id'),
  ])
  return identity.length > 0 || bucket.length > 0 || hourly.length > 0 || peer.length > 0
}

async function queryTrafficBuckets({
  mac,
  since,
  until,
  resolution,
  collectorId,
  scope,
  aggregateCollectors,
}: {
  mac?: string
  since: DateTime
  until: DateTime
  resolution: TrafficResolution
  collectorId?: number
  scope: TrafficScope
  aggregateCollectors: boolean
}): Promise<TrafficBucketRow[]> {
  const { ttlMs, segment } = windowCache(resolution, since, until, Date.now())
  return cachedQuery(
    cacheKey([
      'trafficBuckets',
      mac ?? '',
      segment,
      resolution,
      scope,
      collectorId ?? '',
      aggregateCollectors,
    ]),
    ttlMs,
    () =>
      queryTrafficBucketsUncached({
        mac,
        since,
        until,
        resolution,
        collectorId,
        scope,
        aggregateCollectors,
      })
  )
}

async function queryTrafficBucketsUncached({
  mac,
  since,
  until,
  resolution,
  collectorId,
  scope,
  aggregateCollectors,
}: {
  mac?: string
  since: DateTime
  until: DateTime
  resolution: TrafficResolution
  collectorId?: number
  scope: TrafficScope
  aggregateCollectors: boolean
}): Promise<TrafficBucketRow[]> {
  const resolutionSeconds = RESOLUTION_SECONDS[resolution]
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')
  const cols = scopeColumns(scope)
  const tier = pickSeriesTier(resolutionSeconds, since, until)
  const table = tier ? tier.trafficTable : 'device_traffic_buckets'
  const timeCol = tier ? `b.${tier.timeColumn}` : 'b.bucket_start'

  // When the tier grain equals the requested resolution, GROUP BY the bare
  // indexed time column — no derived expression, no temp table, no filesort.
  // Otherwise (native, or a finer tier like 15m-from-5m-slots) bucket on the
  // fly with FROM_UNIXTIME(FLOOR()); its `?` placeholders sit in the SELECT,
  // so those bindings come first.
  const bareGroup = tier !== null && resolutionSeconds === tier.grainSeconds
  const bindings: Array<string | number> = []
  let bucketSelect: string
  let groupByBucket: string
  if (bareGroup) {
    bucketSelect = `${timeCol} AS bucketStart`
    groupByBucket = timeCol
  } else {
    bucketSelect = `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${timeCol}) / ?) * ?) AS bucketStart`
    groupByBucket = 'bucketStart'
    bindings.push(resolutionSeconds, resolutionSeconds)
  }

  const where: string[] = [`${timeCol} >= ?`, `${timeCol} < ?`]
  bindings.push(sinceSql, untilSql)

  if (mac) {
    where.push('b.mac = ?')
    bindings.push(mac)
  }
  if (collectorId) {
    where.push('b.collector_id = ?')
    bindings.push(collectorId)
  }

  const collectorSelect = aggregateCollectors ? 'NULL' : 'b.collector_id'
  const collectorGroup = aggregateCollectors ? '' : ', b.collector_id'

  const sql = `
    SELECT
      ${collectorSelect} AS collectorId,
      ${bucketSelect},
      SUM(${cols.bytesIn}) AS bytesIn,
      SUM(${cols.bytesOut}) AS bytesOut,
      SUM(${cols.packetsIn}) AS packetsIn,
      SUM(${cols.packetsOut}) AS packetsOut
    FROM ${table} b
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupByBucket}${collectorGroup}
    ORDER BY bucketStart ASC
  `

  return rawRows<TrafficBucketRow>(await db.rawQuery(sql, bindings))
}

async function queryPeers(
  mac: string,
  scope: 'wan' | 'lan',
  collectorId?: number
): Promise<PeerRow[]> {
  const query = db
    .from('device_top_peers')
    .select(
      'collector_id as collectorId',
      'peer_ip as peerIp',
      'scope',
      'bytes_in as bytesIn',
      'bytes_out as bytesOut',
      'updated_at as updatedAt'
    )
    .where('mac', mac)
    .andWhere('scope', scope)
    .orderByRaw('(bytes_in + bytes_out) DESC')

  if (collectorId) query.andWhere('collector_id', collectorId)

  return (await query) as PeerRow[]
}

async function queryIdentity(mac: string, collectorId?: number): Promise<IdentityViewBase[]> {
  const query = db
    .from('device_identities')
    .select(
      'collector_id as collectorId',
      'mac',
      'primary_ip as primaryIp',
      'ips',
      'first_seen_at as firstSeenAt',
      'last_seen_at as lastSeenAt'
    )
    .where('mac', mac)
    .orderBy('last_seen_at', 'desc')

  if (collectorId) query.andWhere('collector_id', collectorId)

  const rows = (await query) as IdentityRow[]
  return rows.map(
    (row) =>
      ({
        collectorId: row.collectorId,
        mac: row.mac,
        primaryIp: row.primaryIp,
        ips: parseIps(row.ips),
        firstSeenAt: toIso(row.firstSeenAt),
        lastSeenAt: toIso(row.lastSeenAt),
      }) satisfies IdentityViewBase
  )
}

async function enrichIdentityRows(rows: IdentityViewBase[]): Promise<IdentityView[]> {
  const [matches, labelsByMac] = await Promise.all([
    getHostnameMatches(
      rows.map((row) => ({ mac: row.mac, primaryIp: row.primaryIp, ips: row.ips }))
    ),
    getDeviceLabels(rows.map((row) => row.mac)),
  ])

  return rows.map((row, i) => {
    const label = labelsByMac.get(row.mac.toLowerCase())

    return {
      ...row,
      hostname: matches[i]?.hostname ?? null,
      hostnameSource: matches[i]?.source ?? null,
      customName: label?.name ?? null,
      deviceType: label?.deviceType ?? null,
      connection: label?.connection ?? null,
      tags: label?.tags ?? [],
      notes: label?.notes ?? null,
    } satisfies IdentityView
  })
}

function parseIps(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((ip): ip is string => typeof ip === 'string') : []
  } catch {
    return []
  }
}

function toNumber(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value)
  return value
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()

  const sql = DateTime.fromSQL(value, { zone: 'utc' })
  if (sql.isValid) return sql.toISO()

  const iso = DateTime.fromISO(value, { setZone: true })
  return iso.isValid ? iso.toUTC().toISO() : String(value)
}

function addSeconds(value: Date | string, seconds: number): string | null {
  const start = toIso(value)
  if (!start) return null
  return DateTime.fromISO(start, { setZone: true }).plus({ seconds }).toISO()
}

function toBucketRow(row: TrafficBucketRow, resolutionSeconds: number) {
  const bytesIn = toNumber(row.bytesIn)
  const bytesOut = toNumber(row.bytesOut)

  return {
    collectorId: row.collectorId,
    bucketStart: toIso(row.bucketStart),
    bucketEnd: addSeconds(row.bucketStart, resolutionSeconds),
    bytesIn,
    bytesOut,
    packetsIn: toNumber(row.packetsIn),
    packetsOut: toNumber(row.packetsOut),
    mbpsIn: (bytesIn * 8) / resolutionSeconds / 1_000_000,
    mbpsOut: (bytesOut * 8) / resolutionSeconds / 1_000_000,
  }
}

function toPeerRow(row: PeerRow) {
  return {
    collectorId: row.collectorId,
    peerIp: row.peerIp,
    scope: row.scope,
    bytesIn: toNumber(row.bytesIn),
    bytesOut: toNumber(row.bytesOut),
    updatedAt: toIso(row.updatedAt),
  }
}

/**
 * Build the headline summary the dashboard tiles render.
 *
 * The trailing bucket is *probably still filling* — its window started at
 * `bucketStart` and only closes at `bucketStart + resolutionSeconds`. If we
 * naively pick `rows.at(-1)` for `latestMbps`, three consecutive 5 s polls
 * across one 15 s window will report ~33 %, ~66 %, then ~100 % of the true
 * rate, which makes the tile feel jumpy ("ramps up and resets every 15 s").
 *
 * Instead we fall back to the second-to-last bucket whenever the trailing
 * one isn't fully closed yet. That gives a stable Mbps reading at the cost
 * of up to `resolutionSeconds` of staleness — a worthwhile trade now that
 * the chart itself updates every poll cycle.
 */
function summarizeBuckets(rows: TrafficBucketRow[], resolutionSeconds: number, now: DateTime) {
  const bytesIn = rows.reduce((sum, row) => sum + toNumber(row.bytesIn), 0)
  const bytesOut = rows.reduce((sum, row) => sum + toNumber(row.bytesOut), 0)

  let latest = rows.at(-1)
  if (latest) {
    const startIso = toIso(latest.bucketStart)
    if (startIso) {
      const startSec = DateTime.fromISO(startIso, { setZone: true }).toSeconds()
      if (now.toSeconds() - startSec < resolutionSeconds) {
        latest = rows.at(-2) ?? latest
      }
    }
  }

  const latestBytesIn = latest ? toNumber(latest.bytesIn) : 0
  const latestBytesOut = latest ? toNumber(latest.bytesOut) : 0

  return {
    bytesIn,
    bytesOut,
    latestMbpsIn: (latestBytesIn * 8) / resolutionSeconds / 1_000_000,
    latestMbpsOut: (latestBytesOut * 8) / resolutionSeconds / 1_000_000,
  }
}

async function queryProtocolSummary({
  mac,
  since,
  until,
  collectorId,
}: {
  mac?: string
  since: DateTime
  until: DateTime
  collectorId?: number
}): Promise<ProtocolAggregateRow[]> {
  const { ttlMs, segment } = windowCache(null, since, until, Date.now())
  return cachedQuery(
    cacheKey(['protocolSummary', mac ?? '', segment, collectorId ?? '']),
    ttlMs,
    () => queryProtocolSummaryUncached({ mac, since, until, collectorId })
  )
}

async function queryProtocolSummaryUncached({
  mac,
  since,
  until,
  collectorId,
}: {
  mac?: string
  since: DateTime
  until: DateTime
  collectorId?: number
}): Promise<ProtocolAggregateRow[]> {
  const aggTier = pickAggregateTier(since, until)
  const table = aggTier ? aggTier.protocolTable : 'device_protocol_buckets'
  const timeCol = aggTier ? `b.${aggTier.timeColumn}` : 'b.bucket_start'
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')
  const where: string[] = [`${timeCol} >= ?`, `${timeCol} < ?`]
  const bindings: Array<string | number> = [sinceSql, untilSql]

  if (mac) {
    where.push('b.mac = ?')
    bindings.push(mac)
  }
  if (collectorId) {
    where.push('b.collector_id = ?')
    bindings.push(collectorId)
  }

  const sql = `
    SELECT
      b.protocol AS protocol,
      SUM(b.bytes_in) AS bytesIn,
      SUM(b.bytes_out) AS bytesOut,
      SUM(b.packets_in) AS packetsIn,
      SUM(b.packets_out) AS packetsOut
    FROM ${table} b
    WHERE ${where.join(' AND ')}
    GROUP BY b.protocol
    ORDER BY (SUM(b.bytes_in) + SUM(b.bytes_out)) DESC
  `

  return rawRows<ProtocolAggregateRow>(await db.rawQuery(sql, bindings))
}

async function queryProtocolTopDevices({
  protocol,
  since,
  until,
  collectorId,
}: {
  protocol: string
  since: DateTime
  until: DateTime
  collectorId?: number
}): Promise<ProtocolTopDeviceRow[]> {
  const { ttlMs, segment } = windowCache(null, since, until, Date.now())
  return cachedQuery(
    cacheKey(['protocolTopDevices', protocol, segment, collectorId ?? '']),
    ttlMs,
    () => queryProtocolTopDevicesUncached({ protocol, since, until, collectorId })
  )
}

async function queryProtocolTopDevicesUncached({
  protocol,
  since,
  until,
  collectorId,
}: {
  protocol: string
  since: DateTime
  until: DateTime
  collectorId?: number
}): Promise<ProtocolTopDeviceRow[]> {
  const aggTier = pickAggregateTier(since, until)
  const table = aggTier ? aggTier.protocolTable : 'device_protocol_buckets'
  const timeCol = aggTier ? `b.${aggTier.timeColumn}` : 'b.bucket_start'
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')
  const where: string[] = [`${timeCol} >= ?`, `${timeCol} < ?`, 'b.protocol = ?']
  const bindings: Array<string | number> = [sinceSql, untilSql, protocol]

  if (collectorId) {
    where.push('b.collector_id = ?')
    bindings.push(collectorId)
  }

  const sql = `
    SELECT
      grouped.collector_id AS collectorId,
      grouped.mac AS mac,
      i.primary_ip AS primaryIp,
      i.ips AS ips,
      grouped.bytesIn AS bytesIn,
      grouped.bytesOut AS bytesOut,
      grouped.packetsIn AS packetsIn,
      grouped.packetsOut AS packetsOut
    FROM (
      SELECT
        b.collector_id,
        b.mac,
        SUM(b.bytes_in) AS bytesIn,
        SUM(b.bytes_out) AS bytesOut,
        SUM(b.packets_in) AS packetsIn,
        SUM(b.packets_out) AS packetsOut
      FROM ${table} b
      WHERE ${where.join(' AND ')}
      GROUP BY b.collector_id, b.mac
    ) grouped
    LEFT JOIN device_identities i
      ON i.collector_id = grouped.collector_id
     AND i.mac = grouped.mac
    ORDER BY (grouped.bytesIn + grouped.bytesOut) DESC
  `

  return rawRows<ProtocolTopDeviceRow>(await db.rawQuery(sql, bindings))
}

async function queryProtocolTimeSeries({
  mac,
  since,
  until,
  resolution,
  collectorId,
}: {
  mac?: string
  since: DateTime
  until: DateTime
  resolution: TrafficResolution
  collectorId?: number
}): Promise<ProtocolTimeSeriesRow[]> {
  const { ttlMs, segment } = windowCache(resolution, since, until, Date.now())
  return cachedQuery(
    cacheKey(['protocolTimeSeries', mac ?? '', segment, resolution, collectorId ?? '']),
    ttlMs,
    () => queryProtocolTimeSeriesUncached({ mac, since, until, resolution, collectorId })
  )
}

async function queryProtocolTimeSeriesUncached({
  mac,
  since,
  until,
  resolution,
  collectorId,
}: {
  mac?: string
  since: DateTime
  until: DateTime
  resolution: TrafficResolution
  collectorId?: number
}): Promise<ProtocolTimeSeriesRow[]> {
  const resolutionSeconds = RESOLUTION_SECONDS[resolution]
  const tier = pickSeriesTier(resolutionSeconds, since, until)
  const table = tier ? tier.protocolTable : 'device_protocol_buckets'
  const timeCol = tier ? `b.${tier.timeColumn}` : 'b.bucket_start'
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')

  const bareGroup = tier !== null && resolutionSeconds === tier.grainSeconds
  const bindings: Array<string | number> = []
  let bucketSelect: string
  let groupByBucket: string
  if (bareGroup) {
    bucketSelect = `${timeCol} AS bucketStart`
    groupByBucket = timeCol
  } else {
    bucketSelect = `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${timeCol}) / ?) * ?) AS bucketStart`
    groupByBucket = 'bucketStart'
    bindings.push(resolutionSeconds, resolutionSeconds)
  }

  const where: string[] = [`${timeCol} >= ?`, `${timeCol} < ?`]
  bindings.push(sinceSql, untilSql)

  if (mac) {
    where.push('b.mac = ?')
    bindings.push(mac)
  }
  if (collectorId) {
    where.push('b.collector_id = ?')
    bindings.push(collectorId)
  }

  const sql = `
    SELECT
      ${bucketSelect},
      b.protocol AS protocol,
      SUM(b.bytes_in) AS bytesIn,
      SUM(b.bytes_out) AS bytesOut
    FROM ${table} b
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupByBucket}, b.protocol
    ORDER BY bucketStart ASC, b.protocol ASC
  `

  return rawRows<ProtocolTimeSeriesRow>(await db.rawQuery(sql, bindings))
}

function withPercentages(
  rows: ProtocolAggregateRow[],
  categories?: Map<string, string>
): ProtocolBreakdownEntry[] {
  const entries = rows.map((row) => ({
    protocol: row.protocol,
    category: categories ? categoryFor(categories, row.protocol) : 'other',
    bytesIn: toNumber(row.bytesIn),
    bytesOut: toNumber(row.bytesOut),
    packetsIn: toNumber(row.packetsIn),
    packetsOut: toNumber(row.packetsOut),
    percentage: 0,
  }))
  const total = entries.reduce((sum, e) => sum + e.bytesIn + e.bytesOut, 0)
  if (total === 0) return entries
  for (const e of entries) {
    e.percentage = Math.round(((e.bytesIn + e.bytesOut) / total) * 1000) / 10
  }
  return entries
}

function percentageOf(part: number, total: number): number {
  if (total === 0) return 0
  return Math.round((part / total) * 1000) / 10
}

function toProtocolTopDevice(row: ProtocolTopDeviceRow) {
  const bytesIn = toNumber(row.bytesIn)
  const bytesOut = toNumber(row.bytesOut)
  return {
    collectorId: row.collectorId,
    mac: row.mac,
    primaryIp: row.primaryIp,
    ips: parseIps(row.ips),
    bytesIn,
    bytesOut,
    packetsIn: toNumber(row.packetsIn),
    packetsOut: toNumber(row.packetsOut),
    totalBytes: bytesIn + bytesOut,
    percentage: 0,
  }
}

function buildProtocolsResponse(
  mac: string | null,
  range: string | null,
  since: DateTime,
  until: DateTime,
  resolution: TrafficResolution,
  resolutionSeconds: number,
  summaryRows: ProtocolAggregateRow[] | null,
  seriesRows: ProtocolTimeSeriesRow[],
  categories?: Map<string, string>
) {
  const timeSeriesMap = new Map<string, Record<string, { bytesIn: number; bytesOut: number }>>()

  for (const row of seriesRows) {
    const bucketStart = toIso(row.bucketStart)
    if (!bucketStart) continue
    const bucket = timeSeriesMap.get(bucketStart) ?? {}
    bucket[row.protocol] = {
      bytesIn: toNumber(row.bytesIn),
      bytesOut: toNumber(row.bytesOut),
    }
    timeSeriesMap.set(bucketStart, bucket)
  }

  // Derive the summary from the time series when not provided separately.
  // This avoids scanning device_protocol_buckets a second time.
  let protocols: ProtocolBreakdownEntry[]
  if (summaryRows) {
    protocols = withPercentages(summaryRows, categories)
  } else {
    const aggregated = new Map<
      string,
      { bytesIn: number; bytesOut: number; packetsIn: number; packetsOut: number }
    >()
    for (const row of seriesRows) {
      const existing = aggregated.get(row.protocol) ?? {
        bytesIn: 0,
        bytesOut: 0,
        packetsIn: 0,
        packetsOut: 0,
      }
      existing.bytesIn += toNumber(row.bytesIn)
      existing.bytesOut += toNumber(row.bytesOut)
      aggregated.set(row.protocol, existing)
    }
    const derived: ProtocolAggregateRow[] = [...aggregated.entries()].map(([protocol, stats]) => ({
      protocol,
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      packetsIn: stats.packetsIn,
      packetsOut: stats.packetsOut,
    }))
    protocols = withPercentages(derived, categories)
  }

  // Match queryProtocolSummary ORDER BY — derived-from-series order follows
  // first bucket appearance (bucketStart ASC, protocol ASC), not traffic share.
  protocols.sort((a, b) => b.bytesIn + b.bytesOut - (a.bytesIn + a.bytesOut))

  const timeSeries = [...timeSeriesMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketStart, protocolsByName]) => ({
      bucketStart,
      bucketEnd: addSeconds(bucketStart, resolutionSeconds),
      protocols: protocolsByName,
    }))

  return {
    ...(mac ? { mac } : {}),
    range,
    from: since.toISO(),
    to: until.toISO(),
    resolution,
    resolutionSeconds,
    protocols,
    timeSeries,
  }
}

async function groupTopAsns(peerRows: PeerRow[]): Promise<TopAsn[]> {
  const rows = peerRows.map(toPeerRow)
  const infos = await Promise.all(rows.map((row) => enrichIp(row.peerIp)))
  const grouped = new Map<string, TopAsn>()

  rows.forEach((row, index) => {
    const info: AsnInfo = infos[index]
    const key = `${info.asn ?? 'unknown'}:${info.org}`
    const existing =
      grouped.get(key) ??
      ({
        asn: info.asn,
        org: info.org,
        prefix: info.prefix,
        bytesIn: 0,
        bytesOut: 0,
        totalBytes: 0,
        peers: [],
      } satisfies TopAsn)

    existing.bytesIn += row.bytesIn
    existing.bytesOut += row.bytesOut
    existing.totalBytes += row.bytesIn + row.bytesOut
    existing.peers.push({ ip: row.peerIp, bytesIn: row.bytesIn, bytesOut: row.bytesOut })
    grouped.set(key, existing)
  })

  return [...grouped.values()].sort((a, b) => b.totalBytes - a.totalBytes)
}

type PeerHistoryRow = {
  peerIp: string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
  deviceCount: bigint | number | string
  firstHour: Date | string
  lastHour: Date | string
}

type PeerHistoryEntry = {
  peerIp: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
  deviceCount: number
  firstHour: string | null
  lastHour: string | null
  asn: number | null
  org: string | null
  prefix: string | null
}

type PeerHistoryResponse = {
  totalBytes: number
  peers: PeerHistoryEntry[]
  asns: TopAsn[]
}

/**
 * Top peers over a window from the hourly peer history, optionally for one
 * device. Cached with the window (ASN enrichment included) because the
 * dashboard polls it, and the DNS-backed enrichment is the slow part on a
 * cold `asn_cache`.
 */
async function queryPeerHistory({
  mac,
  scope,
  since,
  until,
  collectorId,
  limit,
}: {
  mac?: string
  scope: 'wan' | 'lan'
  since: DateTime
  until: DateTime
  collectorId?: number
  limit: number
}): Promise<PeerHistoryResponse> {
  const { ttlMs, segment } = windowCache(null, since, until, Date.now())
  return cachedQuery(
    cacheKey(['peerHistory', mac ?? '', scope, segment, collectorId ?? '', limit]),
    ttlMs,
    async () => {
      const rows = await queryPeerHistoryUncached({ mac, scope, since, until, collectorId, limit })
      return buildPeerHistoryResponse(rows, scope)
    }
  )
}

async function queryPeerHistoryUncached({
  mac,
  scope,
  since,
  until,
  collectorId,
  limit,
}: {
  mac?: string
  scope: 'wan' | 'lan'
  since: DateTime
  until: DateTime
  collectorId?: number
  limit: number
}): Promise<PeerHistoryRow[]> {
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')
  const where: string[] = ['p.scope = ?', 'p.hour_start >= ?', 'p.hour_start < ?']
  const bindings: Array<string | number> = [scope, sinceSql, untilSql]
  if (mac) {
    where.push('p.mac = ?')
    bindings.push(mac)
  }
  if (collectorId) {
    where.push('p.collector_id = ?')
    bindings.push(collectorId)
  }
  bindings.push(limit)

  const sql = `
    SELECT
      p.peer_ip              AS peerIp,
      SUM(p.bytes_in)        AS bytesIn,
      SUM(p.bytes_out)       AS bytesOut,
      COUNT(DISTINCT p.mac)  AS deviceCount,
      MIN(p.hour_start)      AS firstHour,
      MAX(p.hour_start)      AS lastHour
    FROM device_peer_buckets_hourly p
    WHERE ${where.join(' AND ')}
    GROUP BY p.peer_ip
    ORDER BY (SUM(p.bytes_in) + SUM(p.bytes_out)) DESC
    LIMIT ?
  `
  return rawRows<PeerHistoryRow>(await db.rawQuery(sql, bindings))
}

async function buildPeerHistoryResponse(
  rows: PeerHistoryRow[],
  scope: 'wan' | 'lan'
): Promise<PeerHistoryResponse> {
  const base = rows.map((row) => {
    const bytesIn = toNumber(row.bytesIn)
    const bytesOut = toNumber(row.bytesOut)
    return {
      peerIp: row.peerIp,
      bytesIn,
      bytesOut,
      totalBytes: bytesIn + bytesOut,
      deviceCount: toNumber(row.deviceCount),
      firstHour: toIso(row.firstHour),
      lastHour: toIso(row.lastHour),
    }
  })
  const totalBytes = base.reduce((sum, p) => sum + p.totalBytes, 0)

  // LAN peers are private addresses; only WAN peers get ASN enrichment.
  const infos: AsnInfo[] =
    scope === 'wan'
      ? await Promise.all(base.map((p) => enrichIp(p.peerIp)))
      : base.map((p) => ({ ip: p.peerIp, asn: null, org: 'Private / LAN', prefix: null }))

  const peers: PeerHistoryEntry[] = base.map((p, i) => ({
    ...p,
    percentage: percentageOf(p.totalBytes, totalBytes),
    asn: infos[i].asn,
    org: scope === 'wan' ? infos[i].org : null,
    prefix: infos[i].prefix,
  }))

  const asns =
    scope === 'wan'
      ? await groupTopAsns(
          base.map((p) => ({
            collectorId: 0,
            peerIp: p.peerIp,
            scope,
            bytesIn: p.bytesIn,
            bytesOut: p.bytesOut,
            updatedAt: '',
          }))
        )
      : []

  return { totalBytes, peers, asns }
}
