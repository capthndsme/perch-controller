import type { ChartSettings } from '#services/chart_settings'
import { getDeviceLabels, type DeviceType } from '#services/device_labels'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import { windowSpanSeconds } from '#services/rollup_tiers'
import {
  bucketLabel,
  cacheResolutionFor,
  denseSlots,
  estimateBucketSeconds,
  mbps,
  planWindowSeries,
  pollIntervalSeconds,
  querySeriesKeyedSums,
  seriesSinceSql,
  seriesUntilSql,
  trafficSeriesTiers,
  type SeriesSource,
} from '#services/series_buckets'
import type { TrafficScope } from '#validators/devices'
import db from '@adonisjs/lucid/services/db'
import { type DateTime } from 'luxon'

/**
 * "Who is using the bandwidth right now, over time": the top-N devices by
 * bytes inside the window, each as its own rate series, plus every other
 * device folded into one `rest` series. Byte direction follows the rest of
 * the device API: `bytesIn` is what the device downloaded, `bytesOut` what
 * it uploaded.
 *
 * Dense like the Servers charts (`series_buckets.ts`): one bucket width and
 * one stored tier for the whole window, every bucket returned (quiet ones as
 * zero), each top device present in every bucket, rates over each bucket's
 * real seconds (partial first bucket, live last bucket). The ranking reads
 * the same tier and time range as the series, so the legend totals are the
 * chart's area. Two statements: a per-MAC window SUM (ranking) and a
 * per-bucket SUM where a CASE folds every non-top MAC into `''`, so the row
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
  bucketEnd: string
  /** Seconds of the bucket inside the window and not in the future. */
  seconds: number
  /** Keyed by MAC: every top-N device, zero when it was quiet. */
  devices: Record<string, TopTrafficPoint>
  rest: TopTrafficPoint
}

export type TopDevicesHistory = {
  bucketSeconds: number
  /** `bucketLabel(bucketSeconds)`: `15s`, `1m`, `5m`, `1h`… */
  resolution: string
  resolutionSeconds: number
  source: SeriesSource
  floorSeconds: number
  maxPoints: number
  devices: TopDevice[]
  rest: { deviceCount: number; bytesIn: number; bytesOut: number }
  buckets: TopTrafficBucket[]
}

type RankRow = {
  mac: string
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
  if (scope === 'wan') return { bytesIn: 'bytes_in_wan', bytesOut: 'bytes_out_wan' }
  if (scope === 'lan') return { bytesIn: 'bytes_in_lan', bytesOut: 'bytes_out_lan' }
  return { bytesIn: 'bytes_in', bytesOut: 'bytes_out' }
}

function rankValue(row: { bytesIn: number; bytesOut: number }, by: TopTrafficRank): number {
  if (by === 'download') return row.bytesIn
  if (by === 'upload') return row.bytesOut
  return row.bytesIn + row.bytesOut
}

type TopTrafficOptions = {
  since: DateTime
  until: DateTime
  /** The caller's `resolution=` in seconds: the bucket width wanted. */
  requestedSeconds?: number
  settings: ChartSettings
  scope: TrafficScope
  limit: number
  by: TopTrafficRank
  collectorId?: number
}

export async function queryTopDevicesHistory(opts: TopTrafficOptions): Promise<TopDevicesHistory> {
  const floor = opts.requestedSeconds ?? opts.settings.minBucketSeconds
  const estimate = estimateBucketSeconds(
    windowSpanSeconds(opts.since, opts.until),
    floor,
    opts.settings.maxPoints
  )
  const { ttlMs, segment } = windowCache(
    cacheResolutionFor(estimate),
    opts.since,
    opts.until,
    Date.now()
  )
  return cachedQuery(
    cacheKey([
      'traffic:top',
      segment,
      opts.requestedSeconds ?? '',
      opts.settings.minBucketSeconds,
      opts.settings.maxPoints,
      opts.scope,
      opts.limit,
      opts.by,
      opts.collectorId ?? '',
    ]),
    ttlMs,
    () => queryTopDevicesHistoryUncached(opts)
  )
}

async function queryTopDevicesHistoryUncached(opts: TopTrafficOptions): Promise<TopDevicesHistory> {
  const { since, until, scope, limit, by, collectorId } = opts
  const cols = scopeColumns(scope)
  const sinceSql = since.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  // An explicit `resolution=` is the width wanted (it may be finer than the
  // Settings → Charts floor, as the device charts always allowed); without
  // one the floor applies. The point cap holds either way.
  const pollSeconds = await pollIntervalSeconds(collectorId)
  const plan = await planWindowSeries({
    sinceSec: Math.floor(since.toSeconds()),
    untilSec: Math.floor(until.toSeconds()),
    nowSec: Math.floor(Date.now() / 1000),
    tiers: trafficSeriesTiers(pollSeconds),
    pollSeconds,
    floorSeconds: opts.requestedSeconds ?? opts.settings.minBucketSeconds,
    maxPoints: opts.settings.maxPoints,
  })
  const meta = {
    bucketSeconds: plan.bucketSeconds,
    resolution: bucketLabel(plan.bucketSeconds),
    resolutionSeconds: plan.bucketSeconds,
    source: plan.tier.source,
    floorSeconds: opts.settings.minBucketSeconds,
    maxPoints: opts.settings.maxPoints,
  }
  const slots = denseSlots(plan)

  // ── 1. Ranking: per-MAC totals over the series' own tier and range ──
  const timeCol = `t.${plan.tier.timeColumn}`
  const where: string[] = []
  const bindings: Array<string | number> = []
  if (collectorId) {
    where.push('t.collector_id = ?')
    bindings.push(collectorId)
  }
  const rankRows =
    slots.length === 0
      ? []
      : rawRows<RankRow>(
          await db.rawQuery(
            `
        SELECT t.mac AS mac, SUM(t.${cols.bytesIn}) AS bytesIn, SUM(t.${cols.bytesOut}) AS bytesOut
        FROM ${plan.tier.table} t
        WHERE ${[...where, `${timeCol} >= ?`, `${timeCol} < ?`].join(' AND ')}
        GROUP BY t.mac
      `,
            [...bindings, seriesSinceSql(plan, sinceSql), seriesUntilSql(plan, untilSql)]
          )
        )
  // Ties break on the MAC so the set and its order never flip between
  // refreshes of equal totals.
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

  if (top.length === 0) {
    // Still every bucket of the window, all zero: the chart keeps its axis.
    return {
      ...meta,
      devices: [],
      rest,
      buckets: slots.map((slot) => ({
        bucketStart: slot.bucketStart,
        bucketEnd: slot.bucketEnd,
        seconds: slot.seconds,
        devices: {},
        rest: zeroPoint(),
      })),
    }
  }

  // ── 2. Series: per-bucket SUM with non-top MACs folded into one key ──
  const macPlaceholders = top.map(() => '?').join(', ')
  const sums = await querySeriesKeyedSums({
    plan,
    sinceSql,
    untilSql,
    columns: [cols.bytesIn, cols.bytesOut],
    keyExpr: `CASE WHEN t.mac IN (${macPlaceholders}) THEN t.mac ELSE '${REST_KEY}' END`,
    keyBindings: top.map((row) => row.mac),
    where,
    bindings,
  })

  const buckets: TopTrafficBucket[] = slots.map((slot) => {
    const byKey = sums.get(slot.index)
    const devices: Record<string, TopTrafficPoint> = {}
    for (const row of top) {
      const v = byKey?.get(row.mac)
      devices[row.mac] = toPoint(v?.[0] ?? 0, v?.[1] ?? 0, slot.seconds)
    }
    const r = byKey?.get(REST_KEY)
    return {
      bucketStart: slot.bucketStart,
      bucketEnd: slot.bucketEnd,
      seconds: slot.seconds,
      devices,
      rest: toPoint(r?.[0] ?? 0, r?.[1] ?? 0, slot.seconds),
    }
  })

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

  return { ...meta, devices, rest, buckets }
}

function zeroPoint(): TopTrafficPoint {
  return { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 }
}

function toPoint(bytesIn: number, bytesOut: number, seconds: number): TopTrafficPoint {
  return { bytesIn, bytesOut, mbpsIn: mbps(bytesIn, seconds), mbpsOut: mbps(bytesOut, seconds) }
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
