import SystemSetting from '#models/system_setting'
import { categoryFor, getProtocolCategoryMap } from '#services/protocol_categories'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * vnstat-style usage report: bytes per local day / ISO week / month over a
 * window, with the active-device count, the Wi-Fi client average and peak,
 * and the top protocols (with their application category) inside each
 * bucket.
 *
 * Buckets are aligned to the instance timezone (`system_settings.timezone`):
 * a "day" is local midnight to local midnight, not UTC. The fold is done in
 * SQL with the zone's offset at the middle of the window, so across a DST
 * change the hour at the boundary can land in the neighbouring bucket — an
 * acceptable trade for keeping every query a single indexed range scan.
 *
 * Source tier: hourly rollups up to `DAILY_SOURCE_AFTER_DAYS`, the daily
 * rollups beyond that (their UTC day boundaries then stand in for local
 * ones, which is fine at week / month grain).
 *
 * Per device (`mac`): the same buckets, source rules and alignment, read
 * from that MAC's rows only (the `(mac, time)` index on each rollup table).
 * `scope` still picks the byte columns; protocols have no WAN / LAN split
 * in any rollup, so they are the device's totals, as for the whole network.
 * The network-wide columns make no sense for one device: `activeDevices`
 * and `wifiClients` are `null` then, and the Wi-Fi totals are not read.
 */

export type UsagePeriod = 'day' | 'week' | 'month'
export type UsageScope = 'all' | 'wan' | 'lan'
export type UsageSource = 'hourly' | 'daily'

export type UsageProtocol = {
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
}

export type UsageOtherProtocols = {
  count: number
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
} | null

/** Bytes per application category inside a bucket, complete (not top-N). */
export type UsageCategory = {
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
}

export type UsageWifiClients = {
  avg: number | null
  max: number | null
  peakAt: string | null
}

export type UsageBucket = {
  bucketStart: string
  bucketEnd: string
  /** `2026-09-18`, `2026-W38` or `2026-09`. */
  label: string
  /** True when the bucket is still running (or cut short by `to`). */
  partial: boolean
  /** Seconds of the bucket covered by the window (drives avgMbps). */
  seconds: number
  bytesIn: number
  bytesOut: number
  totalBytes: number
  avgMbps: number
  /** Distinct MACs with traffic; `null` for a per-device report. */
  activeDevices: number | null
  /** `null` for a per-device report. */
  wifiClients: UsageWifiClients | null
  protocols: UsageProtocol[]
  otherProtocols: UsageOtherProtocols
  categories: UsageCategory[]
}

export type UsageTotals = Omit<UsageBucket, 'bucketStart' | 'bucketEnd' | 'label' | 'partial'>

export type UsageIntervalSeconds = 3600 | 14400 | 28800 | 43200

export type UsageIntervalBucket = {
  bucketStart: string
  bucketEnd: string
  partial: boolean
  seconds: number
  bytesIn: number
  bytesOut: number
  totalBytes: number
  avgMbps: number
  /** Distinct MACs with traffic; `null` for a per-device report. */
  activeDevices: number | null
}

export type UsageIntervalsReport = {
  from: string
  to: string
  scope: UsageScope
  /** Present only on a per-device report. */
  mac?: string
  timezone: string
  offsetMinutes: number
  intervalSeconds: UsageIntervalSeconds
  buckets: UsageIntervalBucket[]
}

export type UsageReport = {
  period: UsagePeriod
  from: string
  to: string
  scope: UsageScope
  /** Present only on a per-device report. */
  mac?: string
  timezone: string
  offsetMinutes: number
  source: UsageSource
  protocolsLimit: number
  buckets: UsageBucket[]
  totals: UsageTotals
}

/** Beyond this many days the daily rollups are read instead of hourly. */
export const DAILY_SOURCE_AFTER_DAYS = 120
/** Wi-Fi client totals grain: 5 m for short windows, hourly beyond this. */
const WIFI_FINE_GRAIN_UP_TO_DAYS = 45

const PERIOD_UNIT: Record<UsagePeriod, 'day' | 'week' | 'month'> = {
  day: 'day',
  week: 'week',
  month: 'month',
}

function n(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

function pct(part: number, total: number): number {
  if (total === 0) return 0
  return Math.round((part / total) * 1000) / 10
}

function sql(ts: DateTime): string {
  return ts.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()
  const parsed = DateTime.fromSQL(value, { zone: 'utc' })
  return parsed.isValid ? parsed.toISO() : String(value)
}

/** Bucket key for a local DateTime, matching the SQL fold below. */
function keyFor(period: UsagePeriod, local: DateTime): string {
  if (period === 'month') return local.toFormat('yyyy-MM-01')
  return local.toFormat('yyyy-MM-dd')
}

function labelFor(period: UsagePeriod, local: DateTime): string {
  if (period === 'day') return local.toFormat('yyyy-MM-dd')
  if (period === 'week') return `${local.weekYear}-W${String(local.weekNumber).padStart(2, '0')}`
  return local.toFormat('yyyy-MM')
}

/**
 * SQL expression that folds a UTC time column onto the local bucket key
 * (`YYYY-MM-DD` for day and week — the week key is its Monday — and
 * `YYYY-MM-01` for month). `offsetSeconds` is a trusted integer.
 */
function keyExpr(period: UsagePeriod, column: string, offsetSeconds: number): string {
  const shifted = `DATE_ADD(${column}, INTERVAL ${Math.trunc(offsetSeconds)} SECOND)`
  if (period === 'day') return `DATE_FORMAT(${shifted}, '%Y-%m-%d')`
  if (period === 'week') {
    return `DATE_FORMAT(DATE_SUB(${shifted}, INTERVAL WEEKDAY(${shifted}) DAY), '%Y-%m-%d')`
  }
  return `DATE_FORMAT(${shifted}, '%Y-%m-01')`
}

export async function instanceTimezone(): Promise<string> {
  const tz = (await SystemSetting.get<string>('timezone')) || 'UTC'
  return DateTime.now().setZone(tz).isValid ? tz : 'UTC'
}

export async function queryUsageReport(opts: {
  period: UsagePeriod
  since: DateTime
  until: DateTime
  scope: UsageScope
  collectorId?: number
  /** Normalised lower-case colon form; limits the report to this device. */
  mac?: string
  protocolsLimit: number
  now?: DateTime
}): Promise<UsageReport> {
  const tz = await instanceTimezone()
  const { ttlMs, segment } = windowCache(null, opts.since, opts.until, Date.now())
  return cachedQuery(
    cacheKey([
      'usage',
      opts.period,
      tz,
      segment,
      opts.scope,
      opts.collectorId ?? '',
      opts.protocolsLimit,
      opts.mac ?? '',
    ]),
    ttlMs,
    () => queryUsageReportUncached({ ...opts, tz })
  )
}

async function queryUsageReportUncached(opts: {
  period: UsagePeriod
  since: DateTime
  until: DateTime
  scope: UsageScope
  collectorId?: number
  mac?: string
  protocolsLimit: number
  now?: DateTime
  tz: string
}): Promise<UsageReport> {
  const { period, tz } = opts
  const mac = opts.mac
  const unit = PERIOD_UNIT[period]
  const now = (opts.now ?? DateTime.utc()).setZone(tz)
  const sinceLocal = opts.since.setZone(tz).startOf(unit)
  const untilLocal = DateTime.min(opts.until.setZone(tz), now)
  const spanDays = Math.max(0, untilLocal.diff(sinceLocal, 'days').days)
  const source: UsageSource = spanDays > DAILY_SOURCE_AFTER_DAYS ? 'daily' : 'hourly'
  const offsetMinutes = sinceLocal.plus({ days: spanDays / 2 }).offset
  const offsetSeconds = offsetMinutes * 60

  // Every bucket the window touches, in order, including empty ones.
  const buckets: UsageBucket[] = []
  const index = new Map<string, number>()
  for (let start = sinceLocal; start < untilLocal; start = start.plus({ [unit]: 1 })) {
    const end = start.plus({ [unit]: 1 })
    const effectiveEnd = DateTime.min(end, untilLocal)
    const seconds = Math.max(0, Math.round(effectiveEnd.diff(start, 'seconds').seconds))
    index.set(keyFor(period, start), buckets.length)
    buckets.push({
      bucketStart: start.toUTC().toISO()!,
      bucketEnd: end.toUTC().toISO()!,
      label: labelFor(period, start),
      partial: effectiveEnd < end,
      seconds,
      bytesIn: 0,
      bytesOut: 0,
      totalBytes: 0,
      avgMbps: 0,
      activeDevices: mac ? null : 0,
      wifiClients: mac ? null : { avg: null, max: null, peakAt: null },
      protocols: [],
      otherProtocols: null,
      categories: [],
    })
  }
  const bucketFor = (key: string): UsageBucket | null => {
    if (buckets.length === 0) return null
    const i = index.get(key)
    if (i !== undefined) return buckets[i]
    // A DST edge hour can fold onto the neighbouring key; keep it in range.
    return key < keyFor(period, sinceLocal) ? buckets[0] : buckets[buckets.length - 1]
  }

  const sinceSql = sql(sinceLocal)
  const untilSql = sql(untilLocal)
  const trafficTable =
    source === 'daily' ? 'device_traffic_buckets_daily' : 'device_traffic_buckets_hourly'
  const protocolTable =
    source === 'daily' ? 'device_protocol_buckets_daily' : 'device_protocol_buckets_hourly'
  const timeCol = source === 'daily' ? 'day_start' : 'hour_start'
  const suffix = opts.scope === 'all' ? '' : `_${opts.scope}`
  const colIn = `bytes_in${suffix}`
  const colOut = `bytes_out${suffix}`

  const where: string[] = [`b.${timeCol} >= ?`, `b.${timeCol} < ?`]
  const bindings: Array<string | number> = [sinceSql, untilSql]
  if (mac) {
    // Equality on the leading column of the `(mac, time)` index.
    where.unshift('b.mac = ?')
    bindings.unshift(mac)
  }
  if (opts.collectorId) {
    where.push('b.collector_id = ?')
    bindings.push(opts.collectorId)
  }
  const whereSql = where.join(' AND ')
  const key = keyExpr(period, `b.${timeCol}`, offsetSeconds)
  // One device: the network-wide count is meaningless, so it is not read.
  const activeDevicesCol = mac ? '' : ', COUNT(DISTINCT b.mac) AS activeDevices'
  const trafficFrom = fromTable(trafficTable, mac)
  const protocolFrom = fromTable(protocolTable, mac)

  const categories = await getProtocolCategoryMap()

  const [trafficRows, deviceRows, protocolRows, wifiRows, wifiTotalRows] = await Promise.all([
    rawRows<{
      k: string
      bytesIn: bigint | number | string
      bytesOut: bigint | number | string
      activeDevices?: bigint | number | string
    }>(
      await db.rawQuery(
        `
        SELECT ${key} AS k,
               SUM(b.${colIn})       AS bytesIn,
               SUM(b.${colOut})      AS bytesOut${activeDevicesCol}
        FROM ${trafficFrom}
        WHERE ${whereSql}
        GROUP BY k
      `,
        bindings
      )
    ),
    mac
      ? []
      : rawRows<{ activeDevices: bigint | number | string }>(
          await db.rawQuery(
            `SELECT COUNT(DISTINCT b.mac) AS activeDevices FROM ${trafficTable} b WHERE ${whereSql}`,
            bindings
          )
        ),
    rawRows<{
      k: string
      protocol: string
      bytesIn: bigint | number | string
      bytesOut: bigint | number | string
    }>(
      await db.rawQuery(
        `
        SELECT ${key} AS k,
               b.protocol       AS protocol,
               SUM(b.bytes_in)  AS bytesIn,
               SUM(b.bytes_out) AS bytesOut
        FROM ${protocolFrom}
        WHERE ${whereSql}
        GROUP BY k, b.protocol
      `,
        bindings
      )
    ),
    mac ? [] : queryWifiClients(period, sinceSql, untilSql, offsetSeconds, spanDays, true),
    mac ? [] : queryWifiClients(period, sinceSql, untilSql, offsetSeconds, spanDays, false),
  ])

  for (const row of trafficRows) {
    const bucket = bucketFor(row.k)
    if (!bucket) continue
    bucket.bytesIn += n(row.bytesIn)
    bucket.bytesOut += n(row.bytesOut)
    if (bucket.activeDevices !== null) {
      bucket.activeDevices = Math.max(bucket.activeDevices, n(row.activeDevices))
    }
  }

  const protocolsByBucket = new Map<
    UsageBucket,
    Map<string, { bytesIn: number; bytesOut: number }>
  >()
  const protocolsAll = new Map<string, { bytesIn: number; bytesOut: number }>()
  for (const row of protocolRows) {
    const bucket = bucketFor(row.k)
    if (!bucket) continue
    const perBucket = protocolsByBucket.get(bucket) ?? new Map()
    const acc = perBucket.get(row.protocol) ?? { bytesIn: 0, bytesOut: 0 }
    acc.bytesIn += n(row.bytesIn)
    acc.bytesOut += n(row.bytesOut)
    perBucket.set(row.protocol, acc)
    protocolsByBucket.set(bucket, perBucket)
    const all = protocolsAll.get(row.protocol) ?? { bytesIn: 0, bytesOut: 0 }
    all.bytesIn += n(row.bytesIn)
    all.bytesOut += n(row.bytesOut)
    protocolsAll.set(row.protocol, all)
  }

  for (const row of wifiRows) {
    const bucket = bucketFor(row.k)
    if (!bucket) continue
    bucket.wifiClients = {
      avg: row.avg === null ? null : Math.round(n(row.avg) * 10) / 10,
      max: row.max === null ? null : n(row.max),
      peakAt: toIso(row.peakAt),
    }
  }

  for (const bucket of buckets) {
    bucket.totalBytes = bucket.bytesIn + bucket.bytesOut
    bucket.avgMbps = avgMbps(bucket.totalBytes, bucket.seconds)
    const split = topProtocols(protocolsByBucket.get(bucket), opts.protocolsLimit, categories)
    bucket.protocols = split.protocols
    bucket.otherProtocols = split.other
    bucket.categories = categorySplit(protocolsByBucket.get(bucket), categories)
  }

  const totalSeconds = buckets.reduce((sum, b) => sum + b.seconds, 0)
  const totalBytesIn = buckets.reduce((sum, b) => sum + b.bytesIn, 0)
  const totalBytesOut = buckets.reduce((sum, b) => sum + b.bytesOut, 0)
  const totalSplit = topProtocols(protocolsAll, opts.protocolsLimit, categories)
  const wifiTotal = wifiTotalRows[0]
  const totals: UsageTotals = {
    seconds: totalSeconds,
    bytesIn: totalBytesIn,
    bytesOut: totalBytesOut,
    totalBytes: totalBytesIn + totalBytesOut,
    avgMbps: avgMbps(totalBytesIn + totalBytesOut, totalSeconds),
    activeDevices: mac ? null : n(deviceRows[0]?.activeDevices),
    wifiClients: mac
      ? null
      : {
          avg: wifiTotal && wifiTotal.avg !== null ? Math.round(n(wifiTotal.avg) * 10) / 10 : null,
          max: wifiTotal && wifiTotal.max !== null ? n(wifiTotal.max) : null,
          peakAt: toIso(wifiTotal?.peakAt),
        },
    protocols: totalSplit.protocols,
    otherProtocols: totalSplit.other,
    categories: categorySplit(protocolsAll, categories),
  }

  return {
    period,
    from: sinceLocal.toUTC().toISO()!,
    to: untilLocal.toUTC().toISO()!,
    scope: opts.scope,
    ...(mac ? { mac } : {}),
    timezone: tz,
    offsetMinutes,
    source,
    protocolsLimit: opts.protocolsLimit,
    buckets,
    totals,
  }
}

/**
 * `FROM` clause for a rollup table aliased `b`. Per device it pins the
 * table's `<table>_mac_time_idx` (`mac`, time): on a small table MariaDB
 * otherwise full-scans for a device that owns a large share of the rows
 * (live, 2026-09-24: the busiest device is 8 % of the daily protocol rows),
 * and the index is never worse for one MAC over a time range.
 */
function fromTable(table: string, mac: string | undefined): string {
  return mac ? `${table} b FORCE INDEX (${table}_mac_time_idx)` : `${table} b`
}

type WifiRow = {
  k: string
  avg: bigint | number | string | null
  max: bigint | number | string | null
  peakAt: Date | string | null
}

/**
 * Wi-Fi client count average / peak per bucket (grouped) or for the whole
 * window (one row). Reads `wifi_client_totals`; the peak slot comes from a
 * GROUP_CONCAT ordered by count so a single pass answers both.
 */
async function queryWifiClients(
  period: UsagePeriod,
  sinceSql: string,
  untilSql: string,
  offsetSeconds: number,
  spanDays: number,
  grouped: boolean
): Promise<WifiRow[]> {
  const grain = spanDays <= WIFI_FINE_GRAIN_UP_TO_DAYS ? 300 : 3600
  const key = grouped ? keyExpr(period, 'w.slot_start', offsetSeconds) : `'all'`
  return rawRows<WifiRow>(
    await db.rawQuery(
      `
      SELECT ${key} AS k,
             AVG(w.client_count) AS avg,
             MAX(w.client_count) AS max,
             SUBSTRING_INDEX(
               GROUP_CONCAT(w.slot_start ORDER BY w.client_count DESC, w.slot_start ASC),
               ',', 1
             ) AS peakAt
      FROM wifi_client_totals w
      WHERE w.grain_seconds = ? AND w.slot_start >= ? AND w.slot_start < ?
      ${grouped ? 'GROUP BY k' : ''}
    `,
      [grain, sinceSql, untilSql]
    )
  ).filter((row) => row.avg !== null)
}

function topProtocols(
  acc: Map<string, { bytesIn: number; bytesOut: number }> | undefined,
  limit: number,
  categories: Map<string, string>
): { protocols: UsageProtocol[]; other: UsageOtherProtocols } {
  if (!acc || acc.size === 0) return { protocols: [], other: null }
  const total = [...acc.values()].reduce((sum, v) => sum + v.bytesIn + v.bytesOut, 0)
  const sorted = [...acc.entries()]
    .map(([protocol, v]) => ({
      protocol,
      category: categoryFor(categories, protocol),
      bytesIn: v.bytesIn,
      bytesOut: v.bytesOut,
      totalBytes: v.bytesIn + v.bytesOut,
      percentage: pct(v.bytesIn + v.bytesOut, total),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes || a.protocol.localeCompare(b.protocol))
  const protocols = sorted.slice(0, limit)
  const rest = sorted.slice(limit)
  if (rest.length === 0) return { protocols, other: null }
  const bytesIn = rest.reduce((sum, p) => sum + p.bytesIn, 0)
  const bytesOut = rest.reduce((sum, p) => sum + p.bytesOut, 0)
  return {
    protocols,
    other: {
      count: rest.length,
      bytesIn,
      bytesOut,
      totalBytes: bytesIn + bytesOut,
      percentage: pct(bytesIn + bytesOut, total),
    },
  }
}

/** Fold a bucket's full protocol map onto categories (nothing truncated). */
function categorySplit(
  acc: Map<string, { bytesIn: number; bytesOut: number }> | undefined,
  categories: Map<string, string>
): UsageCategory[] {
  if (!acc || acc.size === 0) return []
  const byCategory = new Map<string, { bytesIn: number; bytesOut: number }>()
  let total = 0
  for (const [protocol, v] of acc) {
    const category = categoryFor(categories, protocol)
    const c = byCategory.get(category) ?? { bytesIn: 0, bytesOut: 0 }
    c.bytesIn += v.bytesIn
    c.bytesOut += v.bytesOut
    byCategory.set(category, c)
    total += v.bytesIn + v.bytesOut
  }
  return [...byCategory.entries()]
    .map(([category, v]) => ({
      category,
      bytesIn: v.bytesIn,
      bytesOut: v.bytesOut,
      totalBytes: v.bytesIn + v.bytesOut,
      percentage: pct(v.bytesIn + v.bytesOut, total),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes || a.category.localeCompare(b.category))
}

/** Auto interval for the hourly breakdown: ~170 points at most. */
export function pickUsageInterval(
  requested: '1h' | '4h' | '8h' | '12h' | 'auto' | undefined,
  since: DateTime,
  until: DateTime
): UsageIntervalSeconds {
  if (requested === '1h') return 3600
  if (requested === '4h') return 14400
  if (requested === '8h') return 28800
  if (requested === '12h') return 43200
  const days = until.diff(since, 'days').days
  if (days <= 7) return 3600
  if (days <= 14) return 14400
  if (days <= 30) return 28800
  return 43200
}

/** Seconds from the Unix epoch to MariaDB's TO_SECONDS() origin (year 0). */
const TO_SECONDS_EPOCH = 62_167_219_200

/**
 * Sub-day breakdown for the daily view: bytes per 1 h / 4 h / 8 h / 12 h
 * slot aligned to local midnight (a 4 h slot is 00–04, 04–08, …). One
 * range scan on the hourly rollups; the fold uses the same fixed-offset
 * rule as the day / week / month report, in both SQL and JS, so the two
 * always agree on where a slot starts.
 */
export async function queryUsageIntervals(opts: {
  since: DateTime
  until: DateTime
  scope: UsageScope
  collectorId?: number
  /** Normalised lower-case colon form; limits the report to this device. */
  mac?: string
  intervalSeconds: UsageIntervalSeconds
  now?: DateTime
}): Promise<UsageIntervalsReport> {
  const mac = opts.mac
  const tz = await instanceTimezone()
  const { ttlMs, segment } = windowCache(null, opts.since, opts.until, Date.now())
  return cachedQuery(
    cacheKey([
      'usage:intervals',
      tz,
      segment,
      opts.scope,
      opts.collectorId ?? '',
      opts.intervalSeconds,
      mac ?? '',
    ]),
    ttlMs,
    async () => {
      const interval = opts.intervalSeconds
      const now = opts.now ?? DateTime.utc()
      const until = DateTime.min(opts.until, now)
      const spanDays = Math.max(0, until.diff(opts.since, 'days').days)
      const offsetMinutes = opts.since.setZone(tz).plus({ days: spanDays / 2 }).offset
      const off = offsetMinutes * 60

      // Align the window start down to a local slot boundary.
      const sinceEpoch = Math.floor(opts.since.toSeconds())
      const firstKey = Math.floor((sinceEpoch + off) / interval)
      const untilEpoch = Math.floor(until.toSeconds())
      const nowEpoch = Math.floor(now.toSeconds())

      const buckets: UsageIntervalBucket[] = []
      const index = new Map<number, number>()
      for (let key = firstKey; key * interval - off < untilEpoch; key++) {
        const start = key * interval - off
        const end = start + interval
        const effectiveEnd = Math.min(end, untilEpoch, nowEpoch)
        index.set(key, buckets.length)
        buckets.push({
          bucketStart: DateTime.fromSeconds(start, { zone: 'utc' }).toISO()!,
          bucketEnd: DateTime.fromSeconds(end, { zone: 'utc' }).toISO()!,
          partial: effectiveEnd < end,
          seconds: Math.max(0, effectiveEnd - start),
          bytesIn: 0,
          bytesOut: 0,
          totalBytes: 0,
          avgMbps: 0,
          activeDevices: mac ? null : 0,
        })
      }
      if (buckets.length === 0) {
        return {
          from: opts.since.toUTC().toISO()!,
          to: until.toUTC().toISO()!,
          scope: opts.scope,
          ...(mac ? { mac } : {}),
          timezone: tz,
          offsetMinutes,
          intervalSeconds: interval,
          buckets,
        }
      }

      const suffix = opts.scope === 'all' ? '' : `_${opts.scope}`
      const where: string[] = ['b.hour_start >= ?', 'b.hour_start < ?']
      const bindings: Array<string | number> = [
        sql(DateTime.fromSeconds(firstKey * interval - off, { zone: 'utc' })),
        sql(until),
      ]
      if (mac) {
        where.unshift('b.mac = ?')
        bindings.unshift(mac)
      }
      if (opts.collectorId) {
        where.push('b.collector_id = ?')
        bindings.push(opts.collectorId)
      }
      const activeDevicesCol = mac ? '' : ', COUNT(DISTINCT b.mac) AS activeDevices'
      const rows = rawRows<{
        k: bigint | number | string
        bytesIn: bigint | number | string
        bytesOut: bigint | number | string
        activeDevices?: bigint | number | string
      }>(
        await db.rawQuery(
          `
          SELECT FLOOR((TO_SECONDS(b.hour_start) - ${TO_SECONDS_EPOCH} + ${Math.trunc(off)}) / ${interval}) AS k,
                 SUM(b.bytes_in${suffix})  AS bytesIn,
                 SUM(b.bytes_out${suffix}) AS bytesOut${activeDevicesCol}
          FROM ${fromTable('device_traffic_buckets_hourly', mac)}
          WHERE ${where.join(' AND ')}
          GROUP BY k
        `,
          bindings
        )
      )
      for (const row of rows) {
        const i = index.get(n(row.k))
        if (i === undefined) continue
        const bucket = buckets[i]
        bucket.bytesIn += n(row.bytesIn)
        bucket.bytesOut += n(row.bytesOut)
        if (bucket.activeDevices !== null) {
          bucket.activeDevices = Math.max(bucket.activeDevices, n(row.activeDevices))
        }
      }
      for (const bucket of buckets) {
        bucket.totalBytes = bucket.bytesIn + bucket.bytesOut
        bucket.avgMbps = avgMbps(bucket.totalBytes, bucket.seconds)
      }
      return {
        from: buckets[0].bucketStart,
        to: until.toUTC().toISO()!,
        scope: opts.scope,
        ...(mac ? { mac } : {}),
        timezone: tz,
        offsetMinutes,
        intervalSeconds: interval,
        buckets,
      }
    }
  )
}

function avgMbps(bytes: number, seconds: number): number {
  if (seconds <= 0) return 0
  // Six decimals: a quiet day on a home network is ~0.0002 Mbps, not 0.
  return Math.round(((bytes * 8) / seconds / 1_000_000) * 1e6) / 1e6
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}
