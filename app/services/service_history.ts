import { getDeviceLabels } from '#services/device_labels'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import type { ChartSettings } from '#services/chart_settings'
import {
  FIVE_MIN_ROLLUP_SECONDS,
  HOURLY_ROLLUP_SECONDS,
  coveredFrom,
  windowSpanSeconds,
} from '#services/rollup_tiers'
import {
  bucketLabel,
  cacheResolutionFor,
  denseBuckets,
  estimateBucketSeconds,
  mbps,
  planWindowSeries,
  pollIntervalSeconds,
  querySeriesSums,
  tierCoverage,
  type SeriesSource,
  type SeriesTier,
} from '#services/series_buckets'
import db from '@adonisjs/lucid/services/db'
import { type DateTime } from 'luxon'

/**
 * Read side of the "bytes served per server name" history
 * (`device_service_buckets_hourly`). Every function is cached per time window
 * like the other read helpers, hostname enrichment included, because the
 * dashboard polls these.
 */

type ServiceRow = {
  collectorId: number
  mac: string
  serverName: string
  protocol: string
  bytesServed: bigint | number | string
  bytesReceived: bigint | number | string
}

type IdentityRow = {
  collectorId: number
  mac: string
  primaryIp: string | null
  ips: string | null
}

export type ServiceServer = {
  mac: string
  hostname: string | null
  /** Operator-supplied name from `device_labels`, preferred by the UI. */
  customName: string | null
  primaryIp: string | null
  bytesServed: number
  bytesReceived: number
}

export type ServiceEntry = {
  serverName: string
  protocol: string
  bytesServed: number
  bytesReceived: number
  totalBytes: number
  percentage: number
  servers: ServiceServer[]
}

export type ServerEntry = {
  mac: string
  hostname: string | null
  customName: string | null
  primaryIp: string | null
  bytesServed: number
  bytesReceived: number
  totalBytes: number
  serviceCount: number
}

export type ServicesSummary = {
  /** Start of the rows read (`coveredFrom`): the 5-minute slot or hour that holds `from`. */
  coveredFrom: string
  totalBytesServed: number
  totalBytesReceived: number
  services: ServiceEntry[]
  servers: ServerEntry[]
}

export type DeviceServicesSummary = {
  coveredFrom: string
  totalBytesServed: number
  totalBytesReceived: number
  services: Array<Omit<ServiceEntry, 'servers'>>
}

/** Where a name's chart reads from, finest first (see `series_buckets.ts`). */
const SERVICE_TIERS: readonly SeriesTier[] = [
  // Per-poll rows: grainSeconds is replaced per request by the poll interval.
  {
    source: 'native',
    grainSeconds: 5,
    table: 'device_service_buckets',
    timeColumn: 'bucket_start',
    maxBucketSeconds: FIVE_MIN_ROLLUP_SECONDS - 1,
    freshness: 'poll',
  },
  // The bucket writer adds to these on every poll too (not the rollup pass).
  {
    source: '5m',
    grainSeconds: FIVE_MIN_ROLLUP_SECONDS,
    table: 'device_service_buckets_5m',
    timeColumn: 'slot_start',
    freshness: 'poll',
  },
  {
    source: '1h',
    grainSeconds: HOURLY_ROLLUP_SECONDS,
    table: 'device_service_buckets_hourly',
    timeColumn: 'hour_start',
    freshness: 'poll',
  },
]

export type ServiceTrafficBucket = {
  bucketStart: string
  bucketEnd: string
  /** Seconds of the bucket inside the window and not in the future. */
  seconds: number
  bytesServed: number
  bytesReceived: number
  mbpsServed: number
  mbpsReceived: number
}

/** Bucket metadata of a dense series (both name charts). */
export type SeriesMeta = {
  bucketSeconds: number
  /** `bucketLabel(bucketSeconds)`: `15s`, `1m`, `5m`, `1h`, `1d`… */
  resolution: string
  source: SeriesSource
  floorSeconds: number
  maxPoints: number
}

export type ServiceTrafficSeries = SeriesMeta & { buckets: ServiceTrafficBucket[] }

function n(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

function pct(part: number, total: number): number {
  if (total === 0) return 0
  return Math.round((part / total) * 1000) / 10
}

function sql(ts: DateTime): string {
  return ts.toFormat('yyyy-MM-dd HH:mm:ss')
}

/** Windows up to this long list names from the 5-minute table (kept 14 days). */
const LIST_FINE_MAX_SPAN_SECONDS = 2 * 86_400

/**
 * Which table a name list reads and from when: the 5-minute slots for a
 * window of up to two days that they still cover, hour rows otherwise; from
 * the slot or hour that holds the window start (`coveredFrom`), so a short
 * window is never cut to the minutes since the top of the hour.
 */
async function listSource(since: DateTime, until: DateTime) {
  const hourly = SERVICE_TIERS[2]
  const fine = SERVICE_TIERS[1]
  if (windowSpanSeconds(since, until) <= LIST_FINE_MAX_SPAN_SECONDS) {
    const from = coveredFrom(since.toUTC(), fine.grainSeconds)
    const [candidate] = await tierCoverage([fine, hourly], Math.floor(from.toSeconds()))
    if (candidate.covers) return { table: fine.table, timeColumn: fine.timeColumn, from }
  }
  return {
    table: hourly.table,
    timeColumn: hourly.timeColumn,
    from: coveredFrom(since.toUTC(), hourly.grainSeconds),
  }
}

/** Whether any service history exists for this MAC (drives 404 semantics). */
export async function serviceHistoryExistsForMac(mac: string): Promise<boolean> {
  const rows = await db
    .from('device_service_buckets_hourly')
    .where('mac', mac)
    .limit(1)
    .select('mac')
  return rows.length > 0
}

/**
 * Network-wide view: every (server name, protocol) summed over the window
 * with the servers behind it, plus the per-server totals.
 */
export async function queryServicesSummary(opts: {
  since: DateTime
  until: DateTime
  collectorId?: number
  limit: number
}): Promise<ServicesSummary> {
  const { ttlMs, segment } = windowCache(null, opts.since, opts.until, Date.now())
  return cachedQuery(
    cacheKey(['services:summary', segment, opts.collectorId ?? '', opts.limit]),
    ttlMs,
    () => queryServicesSummaryUncached(opts)
  )
}

async function queryServicesSummaryUncached(opts: {
  since: DateTime
  until: DateTime
  collectorId?: number
  limit: number
}): Promise<ServicesSummary> {
  const source = await listSource(opts.since, opts.until)
  const where: string[] = [`s.${source.timeColumn} >= ?`, `s.${source.timeColumn} < ?`]
  const bindings: Array<string | number> = [sql(source.from), sql(opts.until)]
  if (opts.collectorId) {
    where.push('s.collector_id = ?')
    bindings.push(opts.collectorId)
  }
  const rows = rawRows<ServiceRow>(
    await db.rawQuery(
      `
      SELECT
        s.collector_id        AS collectorId,
        s.mac                 AS mac,
        s.server_name         AS serverName,
        s.protocol            AS protocol,
        SUM(s.bytes_served)   AS bytesServed,
        SUM(s.bytes_received) AS bytesReceived
      FROM ${source.table} s
      WHERE ${where.join(' AND ')}
      GROUP BY s.collector_id, s.mac, s.server_name, s.protocol
    `,
      bindings
    )
  )

  const identities = await identitiesFor([...new Set(rows.map((r) => r.mac))])

  const services = new Map<string, ServiceEntry>()
  const servers = new Map<string, ServerEntry & { names: Set<string> }>()
  let totalBytesServed = 0
  let totalBytesReceived = 0

  for (const row of rows) {
    const served = n(row.bytesServed)
    const received = n(row.bytesReceived)
    totalBytesServed += served
    totalBytesReceived += received
    const identity = identities.get(row.mac.toLowerCase())

    const key = `${row.serverName}|${row.protocol}`
    const service =
      services.get(key) ??
      ({
        serverName: row.serverName,
        protocol: row.protocol,
        bytesServed: 0,
        bytesReceived: 0,
        totalBytes: 0,
        percentage: 0,
        servers: [],
      } satisfies ServiceEntry)
    service.bytesServed += served
    service.bytesReceived += received
    service.totalBytes += served + received
    service.servers.push({
      mac: row.mac,
      hostname: identity?.hostname ?? null,
      customName: identity?.customName ?? null,
      primaryIp: identity?.primaryIp ?? null,
      bytesServed: served,
      bytesReceived: received,
    })
    services.set(key, service)

    const server =
      servers.get(row.mac) ??
      ({
        mac: row.mac,
        hostname: identity?.hostname ?? null,
        customName: identity?.customName ?? null,
        primaryIp: identity?.primaryIp ?? null,
        bytesServed: 0,
        bytesReceived: 0,
        totalBytes: 0,
        serviceCount: 0,
        names: new Set<string>(),
      } satisfies ServerEntry & { names: Set<string> })
    server.bytesServed += served
    server.bytesReceived += received
    server.totalBytes += served + received
    server.names.add(row.serverName)
    servers.set(row.mac, server)
  }

  const serviceList = [...services.values()]
    .map((service) => ({
      ...service,
      percentage: pct(service.bytesServed, totalBytesServed),
      servers: service.servers.sort((a, b) => b.bytesServed - a.bytesServed),
    }))
    .sort((a, b) => b.bytesServed - a.bytesServed || b.totalBytes - a.totalBytes)
    .slice(0, opts.limit)

  const serverList: ServerEntry[] = [...servers.values()]
    .map(({ names, ...server }) => ({ ...server, serviceCount: names.size }))
    .sort((a, b) => b.bytesServed - a.bytesServed)

  return {
    coveredFrom: source.from.toISO()!,
    totalBytesServed,
    totalBytesReceived,
    services: serviceList,
    servers: serverList,
  }
}

/** One device's served names over the window. */
export async function queryDeviceServices(opts: {
  mac: string
  since: DateTime
  until: DateTime
  collectorId?: number
  limit: number
}): Promise<DeviceServicesSummary> {
  const { ttlMs, segment } = windowCache(null, opts.since, opts.until, Date.now())
  return cachedQuery(
    cacheKey(['services:device', opts.mac, segment, opts.collectorId ?? '', opts.limit]),
    ttlMs,
    async () => {
      const source = await listSource(opts.since, opts.until)
      const where: string[] = [
        's.mac = ?',
        `s.${source.timeColumn} >= ?`,
        `s.${source.timeColumn} < ?`,
      ]
      const bindings: Array<string | number> = [opts.mac, sql(source.from), sql(opts.until)]
      if (opts.collectorId) {
        where.push('s.collector_id = ?')
        bindings.push(opts.collectorId)
      }
      const rows = rawRows<ServiceRow>(
        await db.rawQuery(
          `
          SELECT
            s.server_name         AS serverName,
            s.protocol            AS protocol,
            SUM(s.bytes_served)   AS bytesServed,
            SUM(s.bytes_received) AS bytesReceived
          FROM ${source.table} s
          WHERE ${where.join(' AND ')}
          GROUP BY s.server_name, s.protocol
          ORDER BY SUM(s.bytes_served) DESC, SUM(s.bytes_received) DESC
        `,
          bindings
        )
      )
      const totalBytesServed = rows.reduce((sum, r) => sum + n(r.bytesServed), 0)
      const totalBytesReceived = rows.reduce((sum, r) => sum + n(r.bytesReceived), 0)
      return {
        coveredFrom: source.from.toISO()!,
        totalBytesServed,
        totalBytesReceived,
        services: rows.slice(0, opts.limit).map((r) => {
          const bytesServed = n(r.bytesServed)
          const bytesReceived = n(r.bytesReceived)
          return {
            serverName: r.serverName,
            protocol: r.protocol,
            bytesServed,
            bytesReceived,
            totalBytes: bytesServed + bytesReceived,
            percentage: pct(bytesServed, totalBytesServed),
          }
        }),
      }
    }
  )
}

/**
 * Dense served/received series for one server name: every bucket of the
 * window, empty ones as zero, width from the admin floor and point cap
 * (`series_buckets.ts`), read from the per-poll, 5-minute or hourly table.
 */
export async function queryServiceTraffic(opts: {
  serverName: string
  since: DateTime
  until: DateTime
  collectorId?: number
  /** The caller's finest acceptable bucket (`resolution=`), seconds. */
  requestedSeconds?: number
  settings: ChartSettings
}): Promise<ServiceTrafficSeries> {
  const { minBucketSeconds: floorSeconds, maxPoints } = opts.settings
  const estimate = estimateBucketSeconds(
    windowSpanSeconds(opts.since, opts.until),
    Math.max(floorSeconds, opts.requestedSeconds ?? 0),
    maxPoints
  )
  const { ttlMs, segment } = windowCache(
    cacheResolutionFor(estimate),
    opts.since,
    opts.until,
    Date.now()
  )
  const cached = await cachedQuery(
    cacheKey([
      'services:traffic',
      opts.serverName,
      segment,
      opts.collectorId ?? '',
      opts.requestedSeconds ?? '',
      floorSeconds,
      maxPoints,
    ]),
    ttlMs,
    async () => {
      const nativeGrain = await pollIntervalSeconds(opts.collectorId)
      const tiers = SERVICE_TIERS.map((t) =>
        t.source === 'native' ? { ...t, grainSeconds: nativeGrain } : t
      )
      const plan = await planWindowSeries({
        sinceSec: Math.floor(opts.since.toSeconds()),
        untilSec: Math.floor(opts.until.toSeconds()),
        nowSec: Math.floor(Date.now() / 1000),
        tiers,
        pollSeconds: nativeGrain,
        floorSeconds,
        maxPoints,
        requestedSeconds: opts.requestedSeconds,
      })
      const where = ['t.server_name = ?']
      const bindings: Array<string | number> = [opts.serverName]
      if (opts.collectorId) {
        where.push('t.collector_id = ?')
        bindings.push(opts.collectorId)
      }
      const sums = await querySeriesSums({
        plan,
        sinceSql: sql(opts.since.toUTC()),
        untilSql: sql(opts.until.toUTC()),
        columns: ['bytes_served', 'bytes_received'],
        where,
        bindings,
      })
      return { plan, sums: [...sums.entries()] }
    }
  )

  const { plan } = cached
  return {
    bucketSeconds: plan.bucketSeconds,
    resolution: bucketLabel(plan.bucketSeconds),
    source: plan.tier.source,
    floorSeconds,
    maxPoints,
    buckets: denseBuckets(plan, new Map(cached.sums)).map((b) => ({
      bucketStart: b.bucketStart,
      bucketEnd: b.bucketEnd,
      seconds: b.seconds,
      bytesServed: b.a,
      bytesReceived: b.b,
      mbpsServed: mbps(b.a, b.seconds),
      mbpsReceived: mbps(b.b, b.seconds),
    })),
  }
}

type ServerIdentity = {
  hostname: string | null
  customName: string | null
  primaryIp: string | null
}

async function identitiesFor(macs: string[]): Promise<Map<string, ServerIdentity>> {
  const out = new Map<string, ServerIdentity>()
  if (macs.length === 0) return out

  const labelsByMac = await getDeviceLabels(macs)
  const rows = (await db
    .from('device_identities')
    .whereIn('mac', macs)
    .select('collector_id as collectorId', 'mac', 'primary_ip as primaryIp', 'ips')
    .orderBy('last_seen_at', 'desc')) as IdentityRow[]
  const firstByMac = new Map<string, IdentityRow>()
  for (const row of rows) {
    const key = row.mac.toLowerCase()
    if (!firstByMac.has(key)) firstByMac.set(key, row)
  }
  const list = [...firstByMac.values()]
  const matches = await getHostnameMatches(
    list.map((row) => ({ mac: row.mac, primaryIp: row.primaryIp, ips: parseIps(row.ips) }))
  )
  list.forEach((row, i) => {
    out.set(row.mac.toLowerCase(), {
      hostname: matches[i]?.hostname ?? null,
      customName: labelsByMac.get(row.mac.toLowerCase())?.name ?? null,
      primaryIp: row.primaryIp,
    })
  })
  // MACs without an identity row still get a hostname attempt by MAC alone.
  const missing = macs.filter((mac) => !out.has(mac.toLowerCase()))
  if (missing.length > 0) {
    const extra = await getHostnameMatches(
      missing.map((mac) => ({ mac, primaryIp: null, ips: [] }))
    )
    missing.forEach((mac, i) => {
      out.set(mac.toLowerCase(), {
        hostname: extra[i]?.hostname ?? null,
        customName: labelsByMac.get(mac.toLowerCase())?.name ?? null,
        primaryIp: null,
      })
    })
  }
  return out
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
  return (Array.isArray(result) ? result[0] : result) as T[]
}
