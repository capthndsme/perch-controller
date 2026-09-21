import { getDeviceLabels, type DeviceType } from '#services/device_labels'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import { pickAggregateTier, pickSeriesTier } from '#services/rollup_tiers'
import type { TrafficResolution, TrafficScope } from '#validators/devices'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * "Who is using the bandwidth right now, over time": the top-N devices by
 * bytes inside the window, each as its own rate series, plus every other
 * device folded into one `rest` series. Byte direction follows the rest of
 * the device API: `bytesIn` is what the device downloaded, `bytesOut` what
 * it uploaded.
 *
 * Two statements: a per-MAC window SUM on the aggregate tier (picks the
 * ranking, and the totals the legend shows) and a per-bucket SUM on the
 * series tier where a CASE folds every non-top MAC into `''` so the row
 * count is `buckets × (N + 1)` regardless of how many devices exist.
 */

export type TopTrafficRank = 'total' | 'download' | 'upload'

export type TopDevice = {
  mac: string
  hostname: string | null
  /** Operator-supplied name and type; the legend prefers `customName`. */
  customName: string | null
  deviceType: DeviceType | null
  primaryIp: string | null
  bytesIn: number
  bytesOut: number
}

export type TopTrafficPoint = {
  bytesIn: number
  bytesOut: number
  mbpsIn: number
  mbpsOut: number
}

export type TopTrafficBucket = {
  bucketStart: string
  /** Keyed by MAC, only the top-N devices. */
  devices: Record<string, TopTrafficPoint>
  rest: TopTrafficPoint
}

export type TopDevicesHistory = {
  devices: TopDevice[]
  rest: { deviceCount: number; bytesIn: number; bytesOut: number }
  buckets: TopTrafficBucket[]
}

type RankRow = {
  mac: string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
}

type SeriesRow = {
  bucketStart: Date | string
  k: string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
}

type IdentityRow = {
  mac: string
  primaryIp: string | null
  ips: string | null
}

const REST_KEY = ''

function scopeColumns(scope: TrafficScope): { bytesIn: string; bytesOut: string } {
  if (scope === 'wan') return { bytesIn: 'b.bytes_in_wan', bytesOut: 'b.bytes_out_wan' }
  if (scope === 'lan') return { bytesIn: 'b.bytes_in_lan', bytesOut: 'b.bytes_out_lan' }
  return { bytesIn: 'b.bytes_in', bytesOut: 'b.bytes_out' }
}

function rankValue(row: { bytesIn: number; bytesOut: number }, by: TopTrafficRank): number {
  if (by === 'download') return row.bytesIn
  if (by === 'upload') return row.bytesOut
  return row.bytesIn + row.bytesOut
}

export async function queryTopDevicesHistory(opts: {
  since: DateTime
  until: DateTime
  resolution: TrafficResolution
  resolutionSeconds: number
  scope: TrafficScope
  limit: number
  by: TopTrafficRank
  collectorId?: number
}): Promise<TopDevicesHistory> {
  const { ttlMs, segment } = windowCache(opts.resolution, opts.since, opts.until, Date.now())
  return cachedQuery(
    cacheKey([
      'traffic:top',
      segment,
      opts.resolution,
      opts.scope,
      opts.limit,
      opts.by,
      opts.collectorId ?? '',
    ]),
    ttlMs,
    () => queryTopDevicesHistoryUncached(opts)
  )
}

async function queryTopDevicesHistoryUncached(opts: {
  since: DateTime
  until: DateTime
  resolution: TrafficResolution
  resolutionSeconds: number
  scope: TrafficScope
  limit: number
  by: TopTrafficRank
  collectorId?: number
}): Promise<TopDevicesHistory> {
  const { since, until, resolutionSeconds, scope, limit, by, collectorId } = opts
  const cols = scopeColumns(scope)
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')

  // ── 1. Ranking: per-MAC window totals on the aggregate tier ──
  const aggTier = pickAggregateTier(since, until)
  const aggTable = aggTier ? aggTier.trafficTable : 'device_traffic_buckets'
  const aggTimeCol = aggTier ? aggTier.timeColumn : 'bucket_start'
  const rankWhere = [`b.${aggTimeCol} >= ?`, `b.${aggTimeCol} < ?`]
  const rankBindings: Array<string | number> = [sinceSql, untilSql]
  if (collectorId) {
    rankWhere.push('b.collector_id = ?')
    rankBindings.push(collectorId)
  }
  const rankRows = rawRows<RankRow>(
    await db.rawQuery(
      `
        SELECT b.mac AS mac, SUM(${cols.bytesIn}) AS bytesIn, SUM(${cols.bytesOut}) AS bytesOut
        FROM ${aggTable} b
        WHERE ${rankWhere.join(' AND ')}
        GROUP BY b.mac
      `,
      rankBindings
    )
  )
  const ranked = rankRows
    .map((row) => ({
      mac: row.mac,
      bytesIn: toNumber(row.bytesIn),
      bytesOut: toNumber(row.bytesOut),
    }))
    .filter((row) => row.bytesIn + row.bytesOut > 0)
    .sort((a, b) => rankValue(b, by) - rankValue(a, by) || a.mac.localeCompare(b.mac))
  const top = ranked.slice(0, limit)
  const restRows = ranked.slice(limit)
  const rest = {
    deviceCount: restRows.length,
    bytesIn: restRows.reduce((sum, row) => sum + row.bytesIn, 0),
    bytesOut: restRows.reduce((sum, row) => sum + row.bytesOut, 0),
  }

  if (top.length === 0) return { devices: [], rest, buckets: [] }

  // ── 2. Series: per-bucket SUM with non-top MACs folded into one key ──
  const tier = pickSeriesTier(resolutionSeconds, since, until)
  const table = tier ? tier.trafficTable : 'device_traffic_buckets'
  const timeCol = tier ? `b.${tier.timeColumn}` : 'b.bucket_start'
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
  const macPlaceholders = top.map(() => '?').join(', ')
  bindings.push(...top.map((row) => row.mac))
  const where = [`${timeCol} >= ?`, `${timeCol} < ?`]
  bindings.push(sinceSql, untilSql)
  if (collectorId) {
    where.push('b.collector_id = ?')
    bindings.push(collectorId)
  }
  const seriesRows = rawRows<SeriesRow>(
    await db.rawQuery(
      `
        SELECT
          ${bucketSelect},
          CASE WHEN b.mac IN (${macPlaceholders}) THEN b.mac ELSE '' END AS k,
          SUM(${cols.bytesIn})  AS bytesIn,
          SUM(${cols.bytesOut}) AS bytesOut
        FROM ${table} b
        WHERE ${where.join(' AND ')}
        GROUP BY ${groupByBucket}, k
        ORDER BY bucketStart ASC
      `,
      bindings
    )
  )

  const buckets = new Map<string, TopTrafficBucket>()
  for (const row of seriesRows) {
    const bucketStart = toIso(row.bucketStart)
    if (!bucketStart) continue
    let bucket = buckets.get(bucketStart)
    if (!bucket) {
      bucket = { bucketStart, devices: {}, rest: zeroPoint() }
      buckets.set(bucketStart, bucket)
    }
    const point = toPoint(toNumber(row.bytesIn), toNumber(row.bytesOut), resolutionSeconds)
    if (row.k === REST_KEY) bucket.rest = point
    else bucket.devices[row.k] = point
  }

  // ── 3. Names for the legend: identity table, hostname sources, labels ──
  const identityRows = rawRows<IdentityRow>(
    await db.rawQuery(
      `
        SELECT mac, primary_ip AS primaryIp, ips
        FROM device_identities
        WHERE mac IN (${macPlaceholders})
        ORDER BY last_seen_at DESC
      `,
      top.map((row) => row.mac)
    )
  )
  const identityByMac = new Map<string, IdentityRow>()
  for (const row of identityRows) {
    const key = row.mac.toLowerCase()
    if (!identityByMac.has(key)) identityByMac.set(key, row)
  }
  const identities = top.map((row) => {
    const identity = identityByMac.get(row.mac.toLowerCase())
    return {
      mac: row.mac,
      primaryIp: identity?.primaryIp ?? null,
      ips: parseIps(identity?.ips ?? null),
    }
  })
  const [matches, labelsByMac] = await Promise.all([
    getHostnameMatches(identities),
    getDeviceLabels(top.map((row) => row.mac)),
  ])
  const devices: TopDevice[] = top.map((row, i) => {
    const label = labelsByMac.get(row.mac.toLowerCase())
    return {
      mac: row.mac,
      hostname: matches[i]?.hostname ?? null,
      customName: label?.name ?? null,
      deviceType: label?.deviceType ?? null,
      primaryIp: identities[i].primaryIp,
      bytesIn: row.bytesIn,
      bytesOut: row.bytesOut,
    }
  })

  return { devices, rest, buckets: [...buckets.values()] }
}

function zeroPoint(): TopTrafficPoint {
  return { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 }
}

function toPoint(bytesIn: number, bytesOut: number, resolutionSeconds: number): TopTrafficPoint {
  return {
    bytesIn,
    bytesOut,
    mbpsIn: (bytesIn * 8) / resolutionSeconds / 1_000_000,
    mbpsOut: (bytesOut * 8) / resolutionSeconds / 1_000_000,
  }
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

function rawRows<T>(result: unknown): T[] {
  const payload = (result as { rows?: unknown }).rows ?? result
  if (Array.isArray(payload) && Array.isArray(payload[0])) return payload[0] as T[]
  return Array.isArray(payload) ? (payload as T[]) : []
}

function toNumber(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()
  const parsed = DateTime.fromSQL(value, { zone: 'utc' })
  return parsed.isValid ? parsed.toISO() : DateTime.fromISO(value, { zone: 'utc' }).toISO()
}
