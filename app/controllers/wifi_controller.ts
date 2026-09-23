import WifiAccessPoint from '#models/wifi_access_point'
import SystemSetting from '#models/system_setting'
import {
  CLIENT_DISTRIBUTION_GRAINS,
  getAllTimePeakClients,
  queryPeakClientsInWindow,
} from '#services/client_distribution_rollup'
import { getDeviceLabels } from '#services/device_labels'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { getPresenceSettings } from '#services/presence_settings'
import { cacheKey, cacheTtlForResolution, cachedQuery, windowSegment } from '#services/query_cache'
import { queryApThroughputHistory } from '#services/wifi_ap_throughput'
import { pickAggregateTier, pickSeriesTier, windowSpanSeconds } from '#services/rollup_tiers'
import { recordWifiCommandAudit, runSshCommand } from '#services/wifi_command_runner'
import {
  agentAuditResult,
  agentErrorResponse,
  commandChannel,
  commandControls,
  runAgentCommand,
} from '#services/wifi_command_channel'
import hub from '#services/ap_agent_hub'
import {
  CONNECTED_INACTIVE_MS,
  stationConnectedSql,
  stationHeardAgoSql,
  type PresenceThresholds,
} from '#services/wifi_presence'
import { classifySignalQuality } from '#services/wifi_signal_quality'
import {
  RESOLUTION_SECONDS,
  parseRange,
  wifiApHealthQueryValidator,
  wifiApThroughputQueryValidator,
  wifiApLocateValidator,
  wifiApsQueryValidator,
  wifiClientMacParamValidator,
  wifiClientSignalQueryValidator,
  wifiClientSteerValidator,
  wifiClientsQueryValidator,
  wifiClientsHistoryQueryValidator,
  wifiOverviewQueryValidator,
  wifiRfHistoryQueryValidator,
  wifiRfQueryValidator,
  wifiSsidClientsQueryValidator,
  wifiSsidThroughputQueryValidator,
  wifiSsidsQueryValidator,
  type WifiResolution,
} from '#validators/wifi'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/** Window width from which the 5-minute WiFi snapshot rollups serve reads. */
const ROLLUP_MIN_SPAN_SECONDS = 6 * 3600
type LatestStationRow = {
  apId: number
  apName: string
  mac: string
  ifname: string
  ssid: string | null
  radio: string | null
  band: string | null
  signalDbm: number | null
  snrDb: number | null
  txRateKbps: number | null
  rxRateKbps: number | null
  inactiveMs: number | null
  recordedAt: Date | string
  /** Its AP still lists it and it is not idle past the threshold (`wifi_presence.ts`). */
  connected: boolean
  /** When its AP last heard from it (ISO): last listing minus the idle time. */
  heardAt: string
}

type LatestNetworkRow = {
  apId: number
  apName: string
  ifname: string
  ssid: string
  radio: string
  channel: number | null
  frequencyMhz: number | null
  band: string | null
  quality: number | null
  signalDbm: number | null
  noiseDbm: number | null
  bitrateKbps: number | null
  recordedAt: Date | string
}

type ThroughputBySsidRow = {
  ssid: string | null
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
}

type LatestSystemRow = {
  apId: number
  load1: number | null
  load5: number | null
  load15: number | null
  memTotal: bigint | number | string | null
  memAvailable: bigint | number | string | null
  conntrackEntries: number | null
  conntrackLimit: number | null
  uptimeSeconds: number | null
  recordedAt: Date | string
}

type RoamingEventRow = {
  id: number
  mac: string
  fromApId: number | null
  toApId: number | null
  fromApName: string | null
  toApName: string | null
  fromIfname: string | null
  toIfname: string | null
  fromSsid: string | null
  toSsid: string | null
  fromBand: string | null
  toBand: string | null
  eventType: string
  detectedAt: Date | string
}

export default class WifiController {
  /**
   * GET /api/v1/wifi/overview
   */
  async overview({ request, response, serialize }: HttpContext) {
    const qs = await wifiOverviewQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)

    // Clients, signal mix, SSID and AP counts all come from the same connected
    // stations, so they add up to `totalClients`.
    const stations = await queryConnectedStations(qs.apId)
    const latestNetworks = await queryLatestNetworks(qs.apId)
    const throughputBySsid = await querySsidThroughput(window.since, window.until, qs.apId)
    const signalDistribution = summarizeSignalDistribution(stations)
    const ssids = buildSsidSummaries(stations, latestNetworks, throughputBySsid)
    const aps = await queryAccessPointsWithHealth(qs.apId, true)

    const tz = (await SystemSetting.get<string>('timezone')) || 'UTC'
    const now = DateTime.now().setZone(tz)
    const todayStart = now.startOf('day').toUTC()
    const sevenDaysAgo = now.minus({ days: 7 }).toUTC()

    // These windows end now, so their peak is at least the current count; the
    // rollup behind them is recomputed every 5 minutes and can trail a rise.
    const peakClientsToday = Math.max(
      await queryPeakClients(todayStart, now.toUTC(), qs.apId),
      stations.length
    )
    const peakClients7d = Math.max(
      await queryPeakClients(sevenDaysAgo, now.toUTC(), qs.apId),
      stations.length
    )
    const peakClientsAllTime = Math.max(
      await queryPeakClients(null, now.toUTC(), qs.apId),
      peakClients7d
    )

    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      totalClients: stations.length,
      ssidCount: ssids.length,
      accessPointCount: aps.length,
      signalDistribution,
      ssids,
      accessPoints: aps,
      peakClientsToday,
      peakClients7d,
      peakClientsAllTime,
    })
  }

  /**
   * GET /api/v1/wifi/ssids
   */
  async ssids({ request, response, serialize }: HttpContext) {
    const qs = await wifiSsidsQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '1h')
    if (window.error) return response.badRequest(window.error)

    const stations = await queryConnectedStations(qs.apId)
    const latestNetworks = await queryLatestNetworks(qs.apId)
    const throughputBySsid = await querySsidThroughput(window.since, window.until, qs.apId)
    const ssids = buildSsidSummaries(stations, latestNetworks, throughputBySsid)

    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      ssids,
    })
  }

  /**
   * GET /api/v1/wifi/ssids/:ssid/clients
   */
  async ssidClients({ params, request, serialize }: HttpContext) {
    const qs = await wifiSsidClientsQueryValidator.validate(request.qs())
    const ssid = decodeURIComponent(String(params.ssid))
    const stations = await queryConnectedStations(qs.apId)
    const clients = stations
      .filter((station) => station.ssid === ssid)
      .map((station) => ({
        mac: station.mac,
        apId: station.apId,
        ap: station.apName,
        ifname: station.ifname,
        ssid: station.ssid,
        band: station.band,
        signalDbm: station.signalDbm,
        signalQuality: classifySignalQuality(station.signalDbm),
        snrDb: station.snrDb,
        txRateKbps: station.txRateKbps,
        rxRateKbps: station.rxRateKbps,
        inactiveMs: station.inactiveMs,
        lastSeenAt: station.heardAt,
      }))
      .sort((left, right) => (right.signalDbm ?? -999) - (left.signalDbm ?? -999))

    return serialize({
      ssid,
      clientCount: clients.length,
      clients,
    })
  }

  /**
   * GET /api/v1/wifi/ssids/:ssid/throughput
   */
  async ssidThroughput({ params, request, response, serialize }: HttpContext) {
    const qs = await wifiSsidThroughputQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const resolution = qs.resolution ?? '1m'
    const ssid = decodeURIComponent(String(params.ssid))

    const rows = await querySsidThroughputHistory({
      ssid,
      since: window.since,
      until: window.until,
      resolution,
      apId: qs.apId,
    })

    return serialize({
      ssid,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds: RESOLUTION_SECONDS[resolution],
      buckets: rows.map((row) => {
        const bytesIn = toNumber(row.bytesIn) ?? 0
        const bytesOut = toNumber(row.bytesOut) ?? 0
        const seconds = RESOLUTION_SECONDS[resolution]
        return {
          bucketStart: toIso(row.bucketStart),
          bytesIn,
          bytesOut,
          mbpsIn: (bytesIn * 8) / seconds / 1_000_000,
          mbpsOut: (bytesOut * 8) / seconds / 1_000_000,
        }
      }),
    })
  }

  /**
   * GET /api/v1/wifi/clients
   *
   * Every MAC with a latest row (last known state, search uses it); with
   * `activeOnly` just the connected ones. `active` = connected right now.
   */
  async clients({ request, serialize }: HttpContext) {
    const qs = await wifiClientsQueryValidator.validate(request.qs())
    const latestStations = await queryLatestStations(qs.apId)
    const rows = (
      qs.activeOnly ? latestStations.filter((station) => station.connected) : latestStations
    )
      .map((station) => ({
        mac: station.mac,
        apId: station.apId,
        ap: station.apName,
        ifname: station.ifname,
        ssid: station.ssid,
        band: station.band,
        signalDbm: station.signalDbm,
        signalQuality: classifySignalQuality(station.signalDbm),
        snrDb: station.snrDb,
        txRateKbps: station.txRateKbps,
        rxRateKbps: station.rxRateKbps,
        inactiveMs: station.inactiveMs,
        active: station.connected,
        lastSeenAt: station.heardAt,
      }))
      .sort((left, right) => (right.signalDbm ?? -999) - (left.signalDbm ?? -999))

    const macs = rows.map((row) => row.mac)
    const [matches, labelsByMac] = await Promise.all([
      getHostnameMatches(macs.map((mac) => ({ mac, primaryIp: null, ips: [] }))),
      getDeviceLabels(macs),
    ])
    const rowsWithNames = rows.map((row, i) => {
      const label = labelsByMac.get(row.mac.toLowerCase())
      return {
        ...row,
        hostname: matches[i]?.hostname ?? null,
        hostnameSource: matches[i]?.source ?? null,
        customName: label?.name ?? null,
        deviceType: label?.deviceType ?? null,
        tags: label?.tags ?? [],
      }
    })

    return serialize(rowsWithNames)
  }

  /**
   * GET /api/v1/wifi/clients/history
   */
  async clientsHistory({ request, response, serialize }: HttpContext) {
    const qs = await wifiClientsHistoryQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)

    const resolution = qs.resolution ?? '5m'
    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const ttlMs = cacheTtlForResolution(resolution)

    const sinceSql = window.since.toFormat('yyyy-MM-dd HH:mm:ss')
    const untilSql = window.until.toFormat('yyyy-MM-dd HH:mm:ss')

    // 1m/5m/15m/1h read pre-aggregated distinct counts from the rollup (a bare
    // indexed range scan); finer 5s/15s grains — only ever used over short
    // windows — fall back to the raw COUNT(DISTINCT mac) over the snapshots.
    const useRollup = (CLIENT_DISTRIBUTION_GRAINS as readonly number[]).includes(resolutionSeconds)
    let sql: string
    const bindings: Array<any> = []
    if (useRollup) {
      const where: string[] = ['d.grain_seconds = ?', 'd.slot_start >= ?', 'd.slot_start < ?']
      bindings.push(resolutionSeconds, sinceSql, untilSql)
      if (qs.apId) {
        where.push('d.ap_id = ?')
        bindings.push(qs.apId)
      }
      sql = `
        SELECT
          d.slot_start AS bucketStart,
          d.band AS band,
          COALESCE(ap.friendly_name, ap.name) AS apName,
          d.client_count AS clientCount
        FROM wifi_client_distribution d
        INNER JOIN wifi_access_points ap ON ap.id = d.ap_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.slot_start ASC
      `
    } else {
      const where: string[] = [
        's.recorded_at >= ?',
        's.recorded_at < ?',
        's.inactive_ms < ' + CONNECTED_INACTIVE_MS,
      ]
      bindings.push(resolutionSeconds, resolutionSeconds, sinceSql, untilSql)
      if (qs.apId) {
        where.push('s.ap_id = ?')
        bindings.push(qs.apId)
      }
      sql = `
        SELECT
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(s.recorded_at) / ?) * ?) AS bucketStart,
          s.band AS band,
          COALESCE(ap.friendly_name, ap.name) AS apName,
          COUNT(DISTINCT s.mac) AS clientCount
        FROM wifi_station_snapshots s
        INNER JOIN wifi_access_points ap ON ap.id = s.ap_id
        WHERE ${where.join(' AND ')}
        GROUP BY bucketStart, s.band, s.ap_id, apName
        ORDER BY bucketStart ASC
      `
    }

    // Distinct clients per bucket. The per-(AP, band) rows above are exact
    // *within* a part, but a client that roams or switches band inside a
    // slot appears in two parts, so their sum overcounts at busy times
    // (48 vs 29 on a crowded afternoon). Network-wide the exact series is
    // already rolled up in wifi_client_totals; per AP, and on the raw
    // path, one extra COUNT(DISTINCT mac) per bucket gives the truth.
    let distinctSql: string
    const distinctBindings: Array<any> = []
    if (useRollup && !qs.apId) {
      distinctSql = `
        SELECT t.slot_start AS bucketStart, t.client_count AS clientCount
        FROM wifi_client_totals t
        WHERE t.grain_seconds = ? AND t.slot_start >= ? AND t.slot_start < ?
      `
      distinctBindings.push(resolutionSeconds, sinceSql, untilSql)
    } else {
      const where: string[] = [
        's.recorded_at >= ?',
        's.recorded_at < ?',
        's.inactive_ms < ' + CONNECTED_INACTIVE_MS,
      ]
      distinctBindings.push(resolutionSeconds, resolutionSeconds, sinceSql, untilSql)
      if (qs.apId) {
        where.push('s.ap_id = ?')
        distinctBindings.push(qs.apId)
      }
      distinctSql = `
        SELECT
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(s.recorded_at) / ?) * ?) AS bucketStart,
          COUNT(DISTINCT s.mac) AS clientCount
        FROM wifi_station_snapshots s
        WHERE ${where.join(' AND ')}
        GROUP BY bucketStart
      `
    }

    const { rows, distinctRows } = await cachedQuery(
      cacheKey([
        'wifi:clientsHistory',
        windowSegment(window.since, window.until, ttlMs),
        resolution,
        qs.apId ?? '',
      ]),
      ttlMs,
      async () => {
        const [parts, distinct] = await Promise.all([
          db.rawQuery(sql, bindings),
          db.rawQuery(distinctSql, distinctBindings),
        ])
        return { rows: rawRows<any>(parts), distinctRows: rawRows<any>(distinct) }
      }
    )
    const distinctByBucket = new Map<string, number>()
    for (const row of distinctRows) {
      const iso = toIso(row.bucketStart)
      if (iso) distinctByBucket.set(iso, Number(row.clientCount))
    }
    const bucketsMap = new Map<
      string,
      {
        bucketStart: string
        ts: number
        bands: Record<string, number>
        aps: Record<string, number>
        total: number
      }
    >()
    const allBands = new Set<string>()
    const allAps = new Set<string>()

    for (const row of rows) {
      const bucketStartIso = toIso(row.bucketStart)
      if (!bucketStartIso) continue

      const band = row.band || 'Unknown'
      const apName = row.apName || 'Unknown AP'
      const count = Number(row.clientCount)

      allBands.add(band)
      allAps.add(apName)

      if (!bucketsMap.has(bucketStartIso)) {
        bucketsMap.set(bucketStartIso, {
          bucketStart: bucketStartIso,
          ts: DateTime.fromISO(bucketStartIso).toMillis(),
          bands: {},
          aps: {},
          total: 0,
        })
      }

      const bucket = bucketsMap.get(bucketStartIso)!
      bucket.bands[band] = (bucket.bands[band] ?? 0) + count
      bucket.aps[apName] = (bucket.aps[apName] ?? 0) + count
      bucket.total += count
    }
    for (const bucket of bucketsMap.values()) {
      const distinct = distinctByBucket.get(bucket.bucketStart)
      if (distinct !== undefined) bucket.total = Math.min(bucket.total, distinct)
    }

    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds,
      buckets: [...bucketsMap.values()].sort((a, b) => a.ts - b.ts),
      allBands: [...allBands].sort(),
      allAps: [...allAps].sort(),
    })
  }

  /**
   * GET /api/v1/wifi/clients/:mac
   */
  async client({ params, response, serialize }: HttpContext) {
    const { mac } = await wifiClientMacParamValidator.validate(params)
    const normalizedMac = mac.toLowerCase()

    const latestRows = await queryLatestStations()
    const latest = latestRows.find((row) => row.mac.toLowerCase() === normalizedMac)
    if (!latest) {
      return response.notFound({
        error: 'wifi_client_not_found',
        message: `No WiFi snapshots have been recorded for MAC ${mac}.`,
      })
    }

    const [roamingEvents, labelsByMac] = await Promise.all([
      queryRoamingEventsForClient(normalizedMac, 30),
      getDeviceLabels([normalizedMac]),
    ])
    const label = labelsByMac.get(normalizedMac) ?? null
    return serialize({
      mac: normalizedMac,
      label,
      latest: {
        apId: latest.apId,
        ap: latest.apName,
        ifname: latest.ifname,
        ssid: latest.ssid,
        band: latest.band,
        signalDbm: latest.signalDbm,
        signalQuality: classifySignalQuality(latest.signalDbm),
        snrDb: latest.snrDb,
        txRateKbps: latest.txRateKbps,
        rxRateKbps: latest.rxRateKbps,
        inactiveMs: latest.inactiveMs,
        active: latest.connected,
        lastSeenAt: latest.heardAt,
      },
      roamingEvents: roamingEvents.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        from: {
          apId: row.fromApId,
          apName: row.fromApName ?? null,
          ifname: row.fromIfname,
          ssid: row.fromSsid,
          band: row.fromBand,
        },
        to: {
          apId: row.toApId,
          apName: row.toApName ?? null,
          ifname: row.toIfname,
          ssid: row.toSsid,
          band: row.toBand,
        },
        detectedAt: toIso(row.detectedAt),
      })),
    })
  }

  /**
   * GET /api/v1/wifi/clients/:mac/signal
   */
  async clientSignal({ params, request, response, serialize }: HttpContext) {
    const { mac } = await wifiClientMacParamValidator.validate(params)
    const qs = await wifiClientSignalQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const resolution = qs.resolution ?? '1m'
    const resolutionSeconds = RESOLUTION_SECONDS[resolution]
    const normalizedMac = mac.toLowerCase()

    const history = await queryClientSignalHistory({
      mac: normalizedMac,
      since: window.since,
      until: window.until,
      resolution,
      apId: qs.apId,
    })
    if (history.length === 0 && !(await wifiMacExists(normalizedMac))) {
      return response.notFound({
        error: 'wifi_client_not_found',
        message: `No WiFi snapshots have been recorded for MAC ${mac}.`,
      })
    }

    return serialize({
      mac: normalizedMac,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds,
      buckets: history.map((row) => ({
        bucketStart: toIso(row.bucketStart),
        signalDbm: toNumber(row.signalDbm),
        signalQuality: classifySignalQuality(toNumber(row.signalDbm)),
        snrDb: toNumber(row.snrDb),
        txRateKbps: toNumber(row.txRateKbps),
        rxRateKbps: toNumber(row.rxRateKbps),
      })),
    })
  }

  /**
   * GET /api/v1/wifi/rf
   */
  async rf({ request, serialize }: HttpContext) {
    const qs = await wifiRfQueryValidator.validate(request.qs())
    const latestNetworks = await queryLatestNetworks(qs.apId)
    const stations = await queryConnectedStations(qs.apId)
    const clientCountByInterface = new Map<string, number>()
    for (const station of stations) {
      const key = `${station.apId}:${station.ifname}`
      clientCountByInterface.set(key, (clientCountByInterface.get(key) ?? 0) + 1)
    }

    return serialize(
      latestNetworks.map((network) => ({
        apId: network.apId,
        ap: network.apName,
        ifname: network.ifname,
        ssid: network.ssid,
        radio: network.radio,
        channel: network.channel,
        frequencyMhz: network.frequencyMhz,
        band: network.band,
        quality: network.quality,
        signalDbm: network.signalDbm,
        noiseDbm: network.noiseDbm,
        bitrateKbps: network.bitrateKbps,
        clientCount: clientCountByInterface.get(`${network.apId}:${network.ifname}`) ?? 0,
        recordedAt: toIso(network.recordedAt),
      }))
    )
  }

  /**
   * GET /api/v1/wifi/rf/history
   */
  async rfHistory({ request, response, serialize }: HttpContext) {
    const qs = await wifiRfHistoryQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)

    const rows = await queryRfHistory(window.since, window.until, qs.apId)
    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      buckets: rows.map((row) => ({
        bucketStart: toIso(row.bucketStart),
        ssid: row.ssid,
        avgNoiseDbm: toNumber(row.avgNoiseDbm),
        avgSignalDbm: toNumber(row.avgSignalDbm),
        avgQuality: toNumber(row.avgQuality),
      })),
    })
  }

  /**
   * GET /api/v1/wifi/aps
   */
  async aps({ request, serialize }: HttpContext) {
    const qs = await wifiApsQueryValidator.validate(request.qs())
    const rows = await queryAccessPointsWithHealth(undefined, qs.includeDisabled === true)
    return serialize(rows)
  }

  /**
   * GET /api/v1/wifi/aps/throughput?range=24h&resolution=1m
   *
   * Client throughput per access point over time, in *client* terms:
   * `download` is what the AP transmitted to its stations, `upload` what it
   * received from them (see `wifi_ap_throughput`). The grain is coarsened
   * to fit the chart budget and echoed back as `resolution`.
   */
  async apsThroughput({ request, response, serialize }: HttpContext) {
    const qs = await wifiApThroughputQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)

    const history = await queryApThroughputHistory({
      since: window.since,
      until: window.until,
      resolution: qs.resolution ?? '1m',
    })
    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      ...history,
    })
  }

  /**
   * GET /api/v1/wifi/aps/:id/health
   */
  async apHealth({ params, request, response, serialize }: HttpContext) {
    const apId = Number(params.id)
    if (!Number.isFinite(apId) || apId <= 0) {
      return response.badRequest({
        error: 'invalid_ap_id',
        message: 'AP id must be a positive integer.',
      })
    }
    const ap = await WifiAccessPoint.find(apId)
    if (!ap) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${apId} does not exist.`,
      })
    }

    const qs = await wifiApHealthQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const resolution = qs.resolution ?? '1m'

    const rows = await queryApHealthHistory(apId, window.since, window.until, resolution)
    return serialize({
      ap: {
        id: ap.id,
        name: ap.name,
        friendlyName: ap.friendlyName,
      },
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution,
      resolutionSeconds: RESOLUTION_SECONDS[resolution],
      buckets: rows.map((row) => ({
        bucketStart: toIso(row.bucketStart),
        load1: toNumber(row.load1),
        load5: toNumber(row.load5),
        load15: toNumber(row.load15),
        memTotal: toNumber(row.memTotal),
        memAvailable: toNumber(row.memAvailable),
        conntrackEntries: toNumber(row.conntrackEntries),
        conntrackLimit: toNumber(row.conntrackLimit),
        uptimeSeconds: toNumber(row.uptimeSeconds),
      })),
    })
  }

  /**
   * POST /api/v1/wifi/clients/:mac/kick
   */
  async kickClient({ auth, params, response, serialize }: HttpContext) {
    const actor = auth.getUserOrFail()
    const { mac } = await wifiClientMacParamValidator.validate(params)
    const normalizedMac = mac.toLowerCase()
    const station = await queryLatestStationByMac(normalizedMac)
    if (!station) {
      return response.notFound({
        error: 'wifi_client_not_found',
        message: `No WiFi snapshots have been recorded for MAC ${mac}.`,
      })
    }

    const ap = await WifiAccessPoint.find(station.apId)
    if (!ap) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${station.apId} does not exist.`,
      })
    }

    const channel = commandChannel(ap)
    if (channel === 'agent') {
      const rpcParams = {
        mac: normalizedMac,
        ifname: station.ifname,
        reason: 1,
        deauth: true,
        banTimeMs: 0,
      }
      const outcome = await runAgentCommand<{ ifname?: string }>(ap.id, 'client.kick', rpcParams)
      await recordWifiCommandAudit({
        apId: ap.id,
        executedByUserId: actor.id,
        mac: normalizedMac,
        command: 'kick_client',
        params: { via: 'agent', method: 'client.kick', ...rpcParams },
        result: agentAuditResult(outcome),
      })
      if (!outcome.ok) return sendAgentError(response, outcome.error)
      return serialize({
        ok: true,
        mac: normalizedMac,
        apId: ap.id,
        ifname: outcome.result?.ifname ?? station.ifname,
        latencyMs: outcome.latencyMs,
        via: 'agent',
      })
    }
    if (channel !== 'ssh') return commandsNotEnabled(response)

    const payload = {
      addr: normalizedMac,
      reason: 1,
      deauth: true,
    }
    const result = await runSshCommand(ap, [
      'ubus',
      'call',
      `hostapd.${station.ifname}`,
      'del_client',
      JSON.stringify(payload),
    ])
    await recordWifiCommandAudit({
      apId: ap.id,
      executedByUserId: actor.id,
      mac: normalizedMac,
      command: 'kick_client',
      params: { ifname: station.ifname, payload },
      result,
    })

    if (!result.ok) {
      return response.badRequest({
        error: 'wifi_command_failed',
        message: result.error ?? 'Failed to kick client from AP.',
      })
    }
    return serialize({
      ok: true,
      mac: normalizedMac,
      apId: ap.id,
      ifname: station.ifname,
      latencyMs: result.latencyMs,
      via: 'ssh',
    })
  }

  /**
   * POST /api/v1/wifi/clients/:mac/steer
   */
  async steerClient({ auth, params, request, response, serialize }: HttpContext) {
    const actor = auth.getUserOrFail()
    const { mac } = await wifiClientMacParamValidator.validate(params)
    const normalizedMac = mac.toLowerCase()
    const payload = await request.validateUsing(wifiClientSteerValidator)
    const station = await queryLatestStationByMac(normalizedMac)
    if (!station) {
      return response.notFound({
        error: 'wifi_client_not_found',
        message: `No WiFi snapshots have been recorded for MAC ${mac}.`,
      })
    }

    const ap = await WifiAccessPoint.find(station.apId)
    if (!ap) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${station.apId} does not exist.`,
      })
    }

    const banTimeMs = payload.banTimeMs ?? 5000
    const channel = commandChannel(ap)
    if (channel === 'agent') {
      const rpcParams = {
        mac: normalizedMac,
        ifname: station.ifname,
        reason: 1,
        deauth: true,
        banTimeMs,
      }
      const outcome = await runAgentCommand<{ ifname?: string }>(ap.id, 'client.kick', rpcParams)
      await recordWifiCommandAudit({
        apId: ap.id,
        executedByUserId: actor.id,
        mac: normalizedMac,
        command: 'steer_client',
        params: { via: 'agent', method: 'client.kick', ...rpcParams },
        result: agentAuditResult(outcome),
      })
      if (!outcome.ok) return sendAgentError(response, outcome.error)
      return serialize({
        ok: true,
        mac: normalizedMac,
        apId: ap.id,
        ifname: outcome.result?.ifname ?? station.ifname,
        banTimeMs,
        latencyMs: outcome.latencyMs,
        via: 'agent',
      })
    }
    if (channel !== 'ssh') return commandsNotEnabled(response)

    const commandPayload = {
      addr: normalizedMac,
      reason: 1,
      deauth: true,
      ban_time: banTimeMs,
    }
    const result = await runSshCommand(ap, [
      'ubus',
      'call',
      `hostapd.${station.ifname}`,
      'del_client',
      JSON.stringify(commandPayload),
    ])
    await recordWifiCommandAudit({
      apId: ap.id,
      executedByUserId: actor.id,
      mac: normalizedMac,
      command: 'steer_client',
      params: { ifname: station.ifname, payload: commandPayload },
      result,
    })

    if (!result.ok) {
      return response.badRequest({
        error: 'wifi_command_failed',
        message: result.error ?? 'Failed to steer client.',
      })
    }
    return serialize({
      ok: true,
      mac: normalizedMac,
      apId: ap.id,
      ifname: station.ifname,
      banTimeMs: commandPayload.ban_time,
      latencyMs: result.latencyMs,
      via: 'ssh',
    })
  }

  /**
   * POST /api/v1/wifi/aps/:id/reboot
   */
  async rebootAp({ auth, params, response, serialize }: HttpContext) {
    const actor = auth.getUserOrFail()
    const apId = Number(params.id)
    if (!Number.isFinite(apId) || apId <= 0) {
      return response.badRequest({
        error: 'invalid_ap_id',
        message: 'AP id must be a positive integer.',
      })
    }
    const ap = await WifiAccessPoint.find(apId)
    if (!ap) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${apId} does not exist.`,
      })
    }

    const channel = commandChannel(ap)
    if (channel === 'agent') {
      const rpcParams = { delaySeconds: 2 }
      const outcome = await runAgentCommand(ap.id, 'system.reboot', rpcParams)
      await recordWifiCommandAudit({
        apId: ap.id,
        executedByUserId: actor.id,
        command: 'reboot_ap',
        params: { via: 'agent', method: 'system.reboot', ...rpcParams },
        result: agentAuditResult(outcome),
      })
      if (!outcome.ok) return sendAgentError(response, outcome.error)
      return serialize({
        ok: true,
        apId: ap.id,
        latencyMs: outcome.latencyMs,
        via: 'agent',
      })
    }
    if (channel !== 'ssh') return commandsNotEnabled(response)

    const result = await runSshCommand(ap, ['reboot'])
    await recordWifiCommandAudit({
      apId: ap.id,
      executedByUserId: actor.id,
      command: 'reboot_ap',
      params: null,
      result,
    })

    if (!result.ok) {
      return response.badRequest({
        error: 'wifi_command_failed',
        message: result.error ?? 'Failed to reboot AP.',
      })
    }
    return serialize({
      ok: true,
      apId: ap.id,
      latencyMs: result.latencyMs,
      via: 'ssh',
    })
  }

  /**
   * POST /api/v1/wifi/aps/:id/locate
   *
   * Agents blink for `durationSeconds` (default 30) and can be told to
   * `stop`; the SSH path runs its fixed blink loop.
   */
  async locateAp({ auth, params, request, response, serialize }: HttpContext) {
    const actor = auth.getUserOrFail()
    const apId = Number(params.id)
    if (!Number.isFinite(apId) || apId <= 0) {
      return response.badRequest({
        error: 'invalid_ap_id',
        message: 'AP id must be a positive integer.',
      })
    }
    const ap = await WifiAccessPoint.find(apId)
    if (!ap) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${apId} does not exist.`,
      })
    }
    const channel = commandChannel(ap)
    if (channel === null) return commandsNotEnabled(response)
    const payload = await request.validateUsing(wifiApLocateValidator)

    if (channel === 'agent') {
      const method = payload.stop ? 'locate.stop' : 'locate.start'
      const rpcParams: Record<string, unknown> = payload.stop
        ? {}
        : { durationSeconds: payload.durationSeconds ?? 30 }
      const outcome = await runAgentCommand<{ active?: boolean; durationSeconds?: number }>(
        ap.id,
        method,
        rpcParams
      )
      await recordWifiCommandAudit({
        apId: ap.id,
        executedByUserId: actor.id,
        command: payload.stop ? 'locate_ap_stop' : 'locate_ap',
        params: { via: 'agent', method, ...rpcParams },
        result: agentAuditResult(outcome),
      })
      if (!outcome.ok) return sendAgentError(response, outcome.error)
      const active = outcome.result?.active ?? !payload.stop
      return serialize({
        ok: true,
        apId: ap.id,
        via: 'agent',
        active,
        durationSeconds: active
          ? (outcome.result?.durationSeconds ?? (rpcParams.durationSeconds as number))
          : 0,
        latencyMs: outcome.latencyMs,
      })
    }

    if (payload.stop) {
      return response.badRequest({
        error: 'wifi_command_unsupported',
        message: 'Stopping a locate is only possible on APs running the Perch AP Daemon.',
      })
    }
    const blinkTimes = payload.blinkTimes ?? 5
    const blinkDurationMs = payload.blinkDurationMs ?? 250
    const sleepSec = (blinkDurationMs / 1000).toFixed(3)
    const script = `for i in $(seq 1 ${blinkTimes}); do for led in /sys/class/leds/*/brightness; do echo 1 > "$led"; done; sleep ${sleepSec}; for led in /sys/class/leds/*/brightness; do echo 0 > "$led"; done; sleep ${sleepSec}; done`
    const result = await runSshCommand(ap, ['sh', '-c', script])
    await recordWifiCommandAudit({
      apId: ap.id,
      executedByUserId: actor.id,
      command: 'locate_ap',
      params: { blinkTimes, blinkDurationMs },
      result,
    })

    if (!result.ok) {
      return response.badRequest({
        error: 'wifi_command_failed',
        message: result.error ?? 'Failed to run AP locate command.',
      })
    }
    return serialize({
      ok: true,
      apId: ap.id,
      blinkTimes,
      blinkDurationMs,
      latencyMs: result.latencyMs,
      via: 'ssh',
    })
  }
}

function commandsNotEnabled(response: HttpContext['response']) {
  return response.badRequest({
    error: 'wifi_commands_not_enabled',
    message: 'Two-way commands are not enabled for this WiFi source.',
  })
}

function sendAgentError(response: HttpContext['response'], error: Error) {
  const { status, body } = agentErrorResponse(error)
  return response.status(status).send(body)
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}

function toNumber(value: bigint | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
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

async function queryLatestStations(apId?: number): Promise<LatestStationRow[]> {
  const ttlMs = cacheTtlForResolution(null)
  // The AP silence bound decides `connected`: part of the key, so a saved
  // change (Settings → Presence) applies to the next request.
  const thresholds = await getPresenceSettings()
  return cachedQuery(
    cacheKey([
      'wifi:latestStations',
      apId ?? '',
      thresholds.apStaleIntervals,
      thresholds.apStaleMinSeconds,
    ]),
    ttlMs,
    () => queryLatestStationsUncached(thresholds, apId)
  )
}

/**
 * The stations that are clients right now. Anything that counts or lists
 * current clients reads these, never the whole latest table: that also
 * holds every MAC seen during the snapshot retention.
 */
async function queryConnectedStations(apId?: number): Promise<LatestStationRow[]> {
  const stations = await queryLatestStations(apId)
  return stations.filter((station) => station.connected)
}

async function queryLatestStationsUncached(
  thresholds: PresenceThresholds,
  apId?: number
): Promise<LatestStationRow[]> {
  // One row per MAC, maintained by the poller (`upsertWifiLatest`) — no
  // "latest per group" derivation over the snapshot history. `connected` is
  // decided here, in SQL, while the row is read.
  const where: string[] = []
  const bindings: number[] = []
  if (apId) {
    where.push('s.ap_id = ?')
    bindings.push(apId)
  }
  const sql = `
    SELECT
      s.ap_id                               AS apId,
      COALESCE(ap.friendly_name, ap.name)   AS apName,
      s.mac                                  AS mac,
      s.ifname                               AS ifname,
      s.ssid                                 AS ssid,
      s.radio                                AS radio,
      s.band                                 AS band,
      s.signal_dbm                           AS signalDbm,
      s.snr_db                               AS snrDb,
      s.tx_rate_kbps                         AS txRateKbps,
      s.rx_rate_kbps                         AS rxRateKbps,
      s.inactive_ms                          AS inactiveMs,
      s.recorded_at                          AS recordedAt,
      ${stationConnectedSql(thresholds, 's', 'ap')} AS connected,
      ${stationHeardAgoSql('s')}             AS heardAgoSeconds
    FROM wifi_station_latest s
    INNER JOIN wifi_access_points ap ON ap.id = s.ap_id
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.recorded_at DESC
  `
  const rows = rawRows<LatestStationQueryRow>(await db.rawQuery(sql, bindings))
  const now = DateTime.utc()
  return rows.map((row) => toLatestStation(row, now))
}

async function queryLatestStationByMac(mac: string): Promise<LatestStationRow | null> {
  const thresholds = await getPresenceSettings()
  const sql = `
    SELECT
      s.ap_id                               AS apId,
      COALESCE(ap.friendly_name, ap.name)   AS apName,
      s.mac                                  AS mac,
      s.ifname                               AS ifname,
      s.ssid                                 AS ssid,
      s.radio                                AS radio,
      s.band                                 AS band,
      s.signal_dbm                           AS signalDbm,
      s.snr_db                               AS snrDb,
      s.tx_rate_kbps                         AS txRateKbps,
      s.rx_rate_kbps                         AS rxRateKbps,
      s.inactive_ms                          AS inactiveMs,
      s.recorded_at                          AS recordedAt,
      ${stationConnectedSql(thresholds, 's', 'ap')} AS connected,
      ${stationHeardAgoSql('s')}             AS heardAgoSeconds
    FROM wifi_station_latest s
    INNER JOIN wifi_access_points ap ON ap.id = s.ap_id
    WHERE s.mac = ?
    LIMIT 1
  `
  const rows = rawRows<LatestStationQueryRow>(await db.rawQuery(sql, [mac.toLowerCase()]))
  return rows[0] ? toLatestStation(rows[0], DateTime.utc()) : null
}

type LatestStationQueryRow = Omit<LatestStationRow, 'connected' | 'heardAt'> & {
  connected: unknown
  heardAgoSeconds: number | string
}

/**
 * The database decides `connected` and how long ago the AP heard the station;
 * the instant is fixed here, as the row is read, so a cached row keeps it.
 */
function toLatestStation(row: LatestStationQueryRow, now: DateTime): LatestStationRow {
  const { heardAgoSeconds, ...rest } = row
  return {
    ...rest,
    connected: Number(row.connected) === 1,
    heardAt: now.minus({ seconds: Number(heardAgoSeconds) }).toISO()!,
  }
}

async function queryLatestNetworks(apId?: number): Promise<LatestNetworkRow[]> {
  const ttlMs = cacheTtlForResolution(null)
  return cachedQuery(cacheKey(['wifi:latestNetworks', apId ?? '']), ttlMs, () =>
    queryLatestNetworksUncached(apId)
  )
}

async function queryLatestNetworksUncached(apId?: number): Promise<LatestNetworkRow[]> {
  const where: string[] = []
  const bindings: number[] = []
  if (apId) {
    where.push('n.ap_id = ?')
    bindings.push(apId)
  }
  const sql = `
    SELECT
      n.ap_id                               AS apId,
      COALESCE(ap.friendly_name, ap.name)   AS apName,
      n.ifname                               AS ifname,
      n.ssid                                 AS ssid,
      n.radio                                AS radio,
      n.channel                              AS channel,
      n.frequency_mhz                        AS frequencyMhz,
      n.band                                 AS band,
      n.quality                              AS quality,
      n.signal_dbm                           AS signalDbm,
      n.noise_dbm                            AS noiseDbm,
      n.bitrate_kbps                         AS bitrateKbps,
      n.recorded_at                          AS recordedAt
    FROM wifi_network_latest n
    INNER JOIN wifi_access_points ap ON ap.id = n.ap_id
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY n.recorded_at DESC
  `
  return rawRows<LatestNetworkRow>(await db.rawQuery(sql, bindings))
}

async function querySsidThroughput(
  since: DateTime,
  until: DateTime,
  apId?: number
): Promise<Map<string, { bytesIn: number; bytesOut: number }>> {
  const ttlMs = cacheTtlForResolution(null)
  return cachedQuery(
    cacheKey(['wifi:ssidThroughput', windowSegment(since, until, ttlMs), apId ?? '']),
    ttlMs,
    () => querySsidThroughputUncached(since, until, apId)
  )
}

async function querySsidThroughputUncached(
  since: DateTime,
  until: DateTime,
  apId?: number
): Promise<Map<string, { bytesIn: number; bytesOut: number }>> {
  // Window aggregate (no time grain): use the hourly rollup over wide windows.
  const tier = pickAggregateTier(since, until)
  const table = tier ? tier.wifiTable : 'wifi_interface_buckets'
  const timeCol = tier ? tier.timeColumn : 'bucket_start'
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')
  const where: string[] = [`${timeCol} >= ?`, `${timeCol} < ?`]
  const bindings: Array<string | number> = [sinceSql, untilSql]
  if (apId) {
    where.push('ap_id = ?')
    bindings.push(apId)
  }

  const sql = `
    SELECT
      ssid        AS ssid,
      SUM(bytes_in)  AS bytesIn,
      SUM(bytes_out) AS bytesOut
    FROM ${table}
    WHERE ${where.join(' AND ')}
    GROUP BY ssid
  `
  const rows = rawRows<ThroughputBySsidRow>(await db.rawQuery(sql, bindings))
  const map = new Map<string, { bytesIn: number; bytesOut: number }>()
  for (const row of rows) {
    const key = row.ssid ?? '(unknown)'
    map.set(key, {
      bytesIn: toNumber(row.bytesIn) ?? 0,
      bytesOut: toNumber(row.bytesOut) ?? 0,
    })
  }
  return map
}

function summarizeSignalDistribution(stations: LatestStationRow[]) {
  const distribution = {
    excellent: 0,
    veryGood: 0,
    good: 0,
    fair: 0,
    weak: 0,
    veryWeak: 0,
    unknown: 0,
  }

  for (const station of stations) {
    const tier = classifySignalQuality(station.signalDbm)
    if (tier === 'excellent') distribution.excellent += 1
    else if (tier === 'very_good') distribution.veryGood += 1
    else if (tier === 'good') distribution.good += 1
    else if (tier === 'fair') distribution.fair += 1
    else if (tier === 'weak') distribution.weak += 1
    else if (tier === 'very_weak') distribution.veryWeak += 1
    else distribution.unknown += 1
  }

  return distribution
}

function buildSsidSummaries(
  latestStations: LatestStationRow[],
  latestNetworks: LatestNetworkRow[],
  throughputBySsid: Map<string, { bytesIn: number; bytesOut: number }>
) {
  const stationsBySsid = new Map<
    string,
    {
      clients: number
      totalSignal: number
      signalSamples: number
      bands: Set<string>
      aps: Set<string>
    }
  >()

  for (const station of latestStations) {
    const ssid = station.ssid ?? '(unknown)'
    const stats = stationsBySsid.get(ssid) ?? {
      clients: 0,
      totalSignal: 0,
      signalSamples: 0,
      bands: new Set<string>(),
      aps: new Set<string>(),
    }
    stats.clients += 1
    if (station.signalDbm !== null) {
      stats.totalSignal += station.signalDbm
      stats.signalSamples += 1
    }
    if (station.band) stats.bands.add(station.band)
    stats.aps.add(station.apName)
    stationsBySsid.set(ssid, stats)
  }

  const rfBySsid = new Map<
    string,
    {
      quality: number | null
      noiseDbm: number | null
      channel: number | null
      frequencyMhz: number | null
      radios: Set<string>
    }
  >()
  for (const network of latestNetworks) {
    const existing = rfBySsid.get(network.ssid) ?? {
      quality: null,
      noiseDbm: null,
      channel: null,
      frequencyMhz: null,
      radios: new Set<string>(),
    }
    existing.radios.add(network.radio)
    if (network.quality !== null) {
      existing.quality =
        existing.quality === null ? network.quality : Math.max(existing.quality, network.quality)
    }
    if (network.noiseDbm !== null) {
      existing.noiseDbm =
        existing.noiseDbm === null
          ? network.noiseDbm
          : Math.min(existing.noiseDbm, network.noiseDbm)
    }
    if (existing.channel === null && network.channel !== null) existing.channel = network.channel
    if (existing.frequencyMhz === null && network.frequencyMhz !== null) {
      existing.frequencyMhz = network.frequencyMhz
    }
    rfBySsid.set(network.ssid, existing)
  }

  const names = new Set<string>([
    ...stationsBySsid.keys(),
    ...rfBySsid.keys(),
    ...throughputBySsid.keys(),
  ])
  return [...names]
    .map((ssid) => {
      const stations = stationsBySsid.get(ssid)
      const rf = rfBySsid.get(ssid)
      const throughput = throughputBySsid.get(ssid)
      const avgSignal =
        stations && stations.signalSamples > 0
          ? stations.totalSignal / stations.signalSamples
          : null
      return {
        ssid,
        clientCount: stations?.clients ?? 0,
        averageSignalDbm: avgSignal,
        signalQuality: classifySignalQuality(avgSignal),
        bytesIn: throughput?.bytesIn ?? 0,
        bytesOut: throughput?.bytesOut ?? 0,
        quality: rf?.quality ?? null,
        noiseDbm: rf?.noiseDbm ?? null,
        channel: rf?.channel ?? null,
        frequencyMhz: rf?.frequencyMhz ?? null,
        radios: rf ? [...rf.radios] : [],
        bands: stations ? [...stations.bands] : [],
        accessPoints: stations ? [...stations.aps] : [],
      }
    })
    .sort(
      (left, right) => right.clientCount - left.clientCount || left.ssid.localeCompare(right.ssid)
    )
}

async function queryAccessPointsWithHealth(apId?: number, includeDisabled = true) {
  const apsQuery = WifiAccessPoint.query()
    .if(!includeDisabled, (query) => query.where('enabled', true))
    .if(apId !== undefined, (query) => query.where('id', apId!))
    .orderByRaw('COALESCE(friendly_name, name) ASC')
  const [aps, systems, stations] = await Promise.all([
    apsQuery,
    queryLatestSystems(apId),
    queryConnectedStations(apId),
  ])

  const systemByAp = new Map<number, LatestSystemRow>()
  for (const row of systems) {
    systemByAp.set(row.apId, row)
  }
  const clientsByAp = new Map<number, number>()
  for (const station of stations) {
    clientsByAp.set(station.apId, (clientsByAp.get(station.apId) ?? 0) + 1)
  }

  return aps.map((ap) => {
    const system = systemByAp.get(ap.id)
    const memTotal = toNumber(system?.memTotal)
    const memAvailable = toNumber(system?.memAvailable)
    const memUsagePct =
      memTotal && memAvailable !== null
        ? Math.max(0, Math.min(1, 1 - memAvailable / memTotal))
        : null
    const conntrackEntries = toNumber(system?.conntrackEntries)
    const conntrackLimit = toNumber(system?.conntrackLimit)
    const conntrackUsagePct =
      conntrackEntries !== null && conntrackLimit && conntrackLimit > 0
        ? (conntrackEntries / conntrackLimit) * 100
        : null

    const transport = ap.transport ?? 'scrape'
    return {
      id: ap.id,
      name: ap.name,
      friendlyName: ap.friendlyName,
      enabled: ap.enabled,
      model: ap.model,
      openwrtRelease: ap.openwrtRelease,
      nodename: ap.nodename,
      pollIntervalSeconds: ap.pollIntervalSeconds,
      lastSeenAt: ap.lastSeenAt?.toISO() ?? null,
      lastStatus: ap.lastStatus,
      transport,
      agentOnline: transport === 'agent' ? hub.isOnline(ap.id) : null,
      controls: commandControls(ap),
      clientCount: clientsByAp.get(ap.id) ?? 0,
      system: system
        ? {
            load1: toNumber(system.load1),
            load5: toNumber(system.load5),
            load15: toNumber(system.load15),
            memTotal,
            memAvailable,
            memUsagePct,
            conntrackEntries,
            conntrackLimit,
            conntrackUsagePct,
            uptimeSeconds: toNumber(system.uptimeSeconds),
            recordedAt: toIso(system.recordedAt),
          }
        : null,
    }
  })
}

async function queryLatestSystems(apId?: number): Promise<LatestSystemRow[]> {
  const where: string[] = []
  const bindings: number[] = []
  if (apId) {
    where.push('s.ap_id = ?')
    bindings.push(apId)
  }
  const sql = `
    SELECT
      s.ap_id                 AS apId,
      s.load_1                AS load1,
      s.load_5                AS load5,
      s.load_15               AS load15,
      s.mem_total             AS memTotal,
      s.mem_available         AS memAvailable,
      s.conntrack_entries     AS conntrackEntries,
      s.conntrack_limit       AS conntrackLimit,
      s.uptime_seconds        AS uptimeSeconds,
      s.recorded_at           AS recordedAt
    FROM ap_system_latest s
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
  `
  return rawRows<LatestSystemRow>(await db.rawQuery(sql, bindings))
}

async function queryRoamingEventsForClient(mac: string, limit: number): Promise<RoamingEventRow[]> {
  const rows = await db
    .from('wifi_roaming_events as e')
    .leftJoin('wifi_access_points as from_ap', 'from_ap.id', 'e.from_ap_id')
    .leftJoin('wifi_access_points as to_ap', 'to_ap.id', 'e.to_ap_id')
    .select(
      'e.id as id',
      'e.mac as mac',
      'e.from_ap_id as fromApId',
      'e.to_ap_id as toApId',
      db.raw('COALESCE(from_ap.friendly_name, from_ap.name) as fromApName'),
      db.raw('COALESCE(to_ap.friendly_name, to_ap.name) as toApName'),
      'e.from_ifname as fromIfname',
      'e.to_ifname as toIfname',
      'e.from_ssid as fromSsid',
      'e.to_ssid as toSsid',
      'e.from_band as fromBand',
      'e.to_band as toBand',
      'e.event_type as eventType',
      'e.detected_at as detectedAt'
    )
    .where('e.mac', mac)
    .orderBy('e.detected_at', 'desc')
    .limit(limit)
  return rows as RoamingEventRow[]
}

async function wifiMacExists(mac: string): Promise<boolean> {
  // Cheapest first: the one-row-per-MAC latest table, then the 5-minute
  // rollup (which outlives the raw snapshots), then the raw history.
  const latest = await db.from('wifi_station_latest').where('mac', mac).limit(1).select('mac')
  if (latest.length > 0) return true
  const rolled = await db.from('wifi_station_buckets_5m').where('mac', mac).limit(1).select('mac')
  if (rolled.length > 0) return true
  const raw = await db.from('wifi_station_snapshots').where('mac', mac).limit(1).select('id')
  return raw.length > 0
}

async function queryClientSignalHistory({
  mac,
  since,
  until,
  resolution,
  apId,
}: {
  mac: string
  since: DateTime
  until: DateTime
  resolution: WifiResolution
  apId?: number
}): Promise<
  Array<{
    bucketStart: Date | string
    signalDbm: bigint | number | string | null
    snrDb: bigint | number | string | null
    txRateKbps: bigint | number | string | null
    rxRateKbps: bigint | number | string | null
  }>
> {
  const ttlMs = cacheTtlForResolution(resolution)
  return cachedQuery(
    cacheKey([
      'wifi:clientSignal',
      mac,
      windowSegment(since, until, ttlMs),
      resolution,
      apId ?? '',
    ]),
    ttlMs,
    () => queryClientSignalHistoryUncached({ mac, since, until, resolution, apId })
  )
}

async function queryClientSignalHistoryUncached({
  mac,
  since,
  until,
  resolution,
  apId,
}: {
  mac: string
  since: DateTime
  until: DateTime
  resolution: WifiResolution
  apId?: number
}): Promise<
  Array<{
    bucketStart: Date | string
    signalDbm: bigint | number | string | null
    snrDb: bigint | number | string | null
    txRateKbps: bigint | number | string | null
    rxRateKbps: bigint | number | string | null
  }>
> {
  const resolutionSeconds = RESOLUTION_SECONDS[resolution]
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')

  // Wide windows at ≥5m grain read the 5-minute station rollup (which also
  // outlives the raw snapshots' retention). Weighted re-average by sample
  // count so a 15m/1h read of the 5m rows is exact.
  const useRollup =
    resolutionSeconds >= 300 && windowSpanSeconds(since, until) >= ROLLUP_MIN_SPAN_SECONDS
  if (useRollup) {
    const bare = resolutionSeconds === 300
    const bindings: Array<string | number> = []
    let bucketSelect = 's.slot_start AS bucketStart'
    if (!bare) {
      bucketSelect = 'FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(s.slot_start) / ?) * ?) AS bucketStart'
      bindings.push(resolutionSeconds, resolutionSeconds)
    }
    const where: string[] = ['s.slot_start >= ?', 's.slot_start < ?', 's.mac = ?']
    bindings.push(sinceSql, untilSql, mac)
    if (apId) {
      where.push('s.ap_id = ?')
      bindings.push(apId)
    }
    const sql = `
      SELECT
        ${bucketSelect},
        SUM(IF(s.avg_signal_dbm IS NULL, 0, s.avg_signal_dbm * s.samples))
          / NULLIF(SUM(IF(s.avg_signal_dbm IS NULL, 0, s.samples)), 0) AS signalDbm,
        SUM(IF(s.avg_snr_db IS NULL, 0, s.avg_snr_db * s.samples))
          / NULLIF(SUM(IF(s.avg_snr_db IS NULL, 0, s.samples)), 0) AS snrDb,
        MAX(s.max_tx_rate_kbps) AS txRateKbps,
        MAX(s.max_rx_rate_kbps) AS rxRateKbps
      FROM wifi_station_buckets_5m s
      WHERE ${where.join(' AND ')}
      GROUP BY bucketStart
      ORDER BY bucketStart ASC
    `
    return rawRows(await db.rawQuery(sql, bindings))
  }

  const where: string[] = ['s.recorded_at >= ?', 's.recorded_at < ?', 's.mac = ?']
  const bindings: Array<string | number> = [
    resolutionSeconds,
    resolutionSeconds,
    sinceSql,
    untilSql,
    mac,
  ]
  if (apId) {
    where.push('s.ap_id = ?')
    bindings.push(apId)
  }

  const sql = `
    SELECT
      FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(s.recorded_at) / ?) * ?) AS bucketStart,
      AVG(s.signal_dbm) AS signalDbm,
      AVG(s.snr_db) AS snrDb,
      MAX(s.tx_rate_kbps) AS txRateKbps,
      MAX(s.rx_rate_kbps) AS rxRateKbps
    FROM wifi_station_snapshots s
    WHERE ${where.join(' AND ')}
    GROUP BY bucketStart
    ORDER BY bucketStart ASC
  `
  return rawRows(await db.rawQuery(sql, bindings))
}

async function queryRfHistory(since: DateTime, until: DateTime, apId?: number) {
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')
  const span = windowSpanSeconds(since, until)

  type RfRow = {
    bucketStart: Date | string
    ssid: string
    avgNoiseDbm: bigint | number | string | null
    avgSignalDbm: bigint | number | string | null
    avgQuality: bigint | number | string | null
  }

  // Wide windows read the 5-minute network rollup, coarsened so the chart
  // never gets more than ~2000 points per SSID.
  if (span >= ROLLUP_MIN_SPAN_SECONDS) {
    const grain = Math.max(300, Math.ceil(span / 2000 / 300) * 300)
    const bindings: Array<string | number> = []
    let bucketSelect = 'slot_start AS bucketStart'
    if (grain !== 300) {
      bucketSelect = 'FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(slot_start) / ?) * ?) AS bucketStart'
      bindings.push(grain, grain)
    }
    const where: string[] = ['slot_start >= ?', 'slot_start < ?']
    bindings.push(sinceSql, untilSql)
    if (apId) {
      where.push('ap_id = ?')
      bindings.push(apId)
    }
    const weighted = (col: string) =>
      `SUM(IF(${col} IS NULL, 0, ${col} * samples)) / NULLIF(SUM(IF(${col} IS NULL, 0, samples)), 0)`
    const sql = `
      SELECT
        ${bucketSelect},
        ssid AS ssid,
        ${weighted('avg_noise_dbm')}  AS avgNoiseDbm,
        ${weighted('avg_signal_dbm')} AS avgSignalDbm,
        ${weighted('avg_quality')}    AS avgQuality
      FROM wifi_network_buckets_5m
      WHERE ${where.join(' AND ')}
      GROUP BY bucketStart, ssid
      ORDER BY bucketStart ASC, ssid ASC
    `
    return rawRows<RfRow>(await db.rawQuery(sql, bindings))
  }

  const where: string[] = ['recorded_at >= ?', 'recorded_at < ?']
  const bindings: Array<string | number> = [sinceSql, untilSql]
  if (apId) {
    where.push('ap_id = ?')
    bindings.push(apId)
  }
  const sql = `
    SELECT
      FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / 60) * 60) AS bucketStart,
      ssid        AS ssid,
      AVG(noise_dbm)  AS avgNoiseDbm,
      AVG(signal_dbm) AS avgSignalDbm,
      AVG(quality)    AS avgQuality
    FROM wifi_network_snapshots
    WHERE ${where.join(' AND ')}
    GROUP BY bucketStart, ssid
    ORDER BY bucketStart ASC, ssid ASC
  `
  return rawRows<RfRow>(await db.rawQuery(sql, bindings))
}

async function queryApHealthHistory(
  apId: number,
  since: DateTime,
  until: DateTime,
  resolution: WifiResolution
): Promise<
  Array<{
    bucketStart: Date | string
    load1: number | null
    load5: number | null
    load15: number | null
    memTotal: bigint | number | string | null
    memAvailable: bigint | number | string | null
    conntrackEntries: number | null
    conntrackLimit: number | null
    uptimeSeconds: number | null
  }>
> {
  const ttlMs = cacheTtlForResolution(resolution)
  return cachedQuery(
    cacheKey(['wifi:apHealth', apId, windowSegment(since, until, ttlMs), resolution]),
    ttlMs,
    () => queryApHealthHistoryUncached(apId, since, until, resolution)
  )
}

async function queryApHealthHistoryUncached(
  apId: number,
  since: DateTime,
  until: DateTime,
  resolution: WifiResolution
): Promise<
  Array<{
    bucketStart: Date | string
    load1: number | null
    load5: number | null
    load15: number | null
    memTotal: bigint | number | string | null
    memAvailable: bigint | number | string | null
    conntrackEntries: number | null
    conntrackLimit: number | null
    uptimeSeconds: number | null
  }>
> {
  const resolutionSeconds = RESOLUTION_SECONDS[resolution]
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')

  const useRollup =
    resolutionSeconds >= 300 && windowSpanSeconds(since, until) >= ROLLUP_MIN_SPAN_SECONDS
  if (useRollup) {
    const bare = resolutionSeconds === 300
    const bindings: Array<string | number> = []
    let bucketSelect = 'slot_start AS bucketStart'
    if (!bare) {
      bucketSelect = 'FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(slot_start) / ?) * ?) AS bucketStart'
      bindings.push(resolutionSeconds, resolutionSeconds)
    }
    bindings.push(apId, sinceSql, untilSql)
    const weighted = (col: string) =>
      `SUM(IF(${col} IS NULL, 0, ${col} * samples)) / NULLIF(SUM(IF(${col} IS NULL, 0, samples)), 0)`
    const sql = `
      SELECT
        ${bucketSelect},
        ${weighted('avg_load_1')}  AS load1,
        ${weighted('avg_load_5')}  AS load5,
        ${weighted('avg_load_15')} AS load15,
        MAX(max_mem_total) AS memTotal,
        MAX(max_mem_available) AS memAvailable,
        MAX(max_conntrack_entries) AS conntrackEntries,
        MAX(max_conntrack_limit) AS conntrackLimit,
        MAX(max_uptime_seconds) AS uptimeSeconds
      FROM ap_system_buckets_5m
      WHERE ap_id = ? AND slot_start >= ? AND slot_start < ?
      GROUP BY bucketStart
      ORDER BY bucketStart ASC
    `
    return rawRows(await db.rawQuery(sql, bindings))
  }

  const sql = `
    SELECT
      FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ?) * ?) AS bucketStart,
      AVG(load_1) AS load1,
      AVG(load_5) AS load5,
      AVG(load_15) AS load15,
      MAX(mem_total) AS memTotal,
      MAX(mem_available) AS memAvailable,
      MAX(conntrack_entries) AS conntrackEntries,
      MAX(conntrack_limit) AS conntrackLimit,
      MAX(uptime_seconds) AS uptimeSeconds
    FROM ap_system_snapshots
    WHERE ap_id = ?
      AND recorded_at >= ?
      AND recorded_at < ?
    GROUP BY bucketStart
    ORDER BY bucketStart ASC
  `
  return rawRows(
    await db.rawQuery(sql, [resolutionSeconds, resolutionSeconds, apId, sinceSql, untilSql])
  )
}

async function querySsidThroughputHistory({
  ssid,
  since,
  until,
  resolution,
  apId,
}: {
  ssid: string
  since: DateTime
  until: DateTime
  resolution: WifiResolution
  apId?: number
}): Promise<
  Array<{
    bucketStart: Date | string
    bytesIn: bigint | number | string
    bytesOut: bigint | number | string
  }>
> {
  const ttlMs = cacheTtlForResolution(resolution)
  return cachedQuery(
    cacheKey([
      'wifi:ssidThroughputHistory',
      ssid,
      windowSegment(since, until, ttlMs),
      resolution,
      apId ?? '',
    ]),
    ttlMs,
    () => querySsidThroughputHistoryUncached({ ssid, since, until, resolution, apId })
  )
}

async function querySsidThroughputHistoryUncached({
  ssid,
  since,
  until,
  resolution,
  apId,
}: {
  ssid: string
  since: DateTime
  until: DateTime
  resolution: WifiResolution
  apId?: number
}): Promise<
  Array<{
    bucketStart: Date | string
    bytesIn: bigint | number | string
    bytesOut: bigint | number | string
  }>
> {
  const resolutionSeconds = RESOLUTION_SECONDS[resolution]
  const tier = pickSeriesTier(resolutionSeconds, since, until)
  const table = tier ? tier.wifiTable : 'wifi_interface_buckets'
  const timeCol = tier ? tier.timeColumn : 'bucket_start'
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')

  // When the requested resolution equals the tier grain, GROUP BY the bare
  // indexed time column instead of a derived FROM_UNIXTIME(FLOOR()) expression.
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

  const where: string[] = ['ssid = ?', `${timeCol} >= ?`, `${timeCol} < ?`]
  bindings.push(ssid, sinceSql, untilSql)
  if (apId) {
    where.push('ap_id = ?')
    bindings.push(apId)
  }

  const sql = `
    SELECT
      ${bucketSelect},
      SUM(bytes_in)  AS bytesIn,
      SUM(bytes_out) AS bytesOut
    FROM ${table}
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupByBucket}
    ORDER BY bucketStart ASC
  `
  return rawRows(await db.rawQuery(sql, bindings))
}

async function queryPeakClients(
  since: DateTime | null,
  until: DateTime,
  apId?: number
): Promise<number> {
  // `since = null` means all time: served from the stored peak that the
  // client-distribution task keeps current — no history scan at read time.
  if (!since) {
    const allTime = await getAllTimePeakClients(apId)
    return allTime.count
  }

  const ttlMs = cacheTtlForResolution(null)
  return cachedQuery(
    cacheKey(['wifi:peakClients', since.toISO(), windowSegment(since, until, ttlMs), apId ?? '']),
    ttlMs,
    async () => {
      const peak = await queryPeakClientsInWindow(since, until, apId)
      return peak.count
    }
  )
}
