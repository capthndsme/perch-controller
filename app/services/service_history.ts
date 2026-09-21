import { getDeviceLabels } from '#services/device_labels'
import { getHostnameMatches } from '#services/hostname_enrichment'
import env from '#start/env'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import { windowSpanSeconds } from '#services/rollup_tiers'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

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
  totalBytesServed: number
  totalBytesReceived: number
  services: ServiceEntry[]
  servers: ServerEntry[]
}

export type DeviceServicesSummary = {
  totalBytesServed: number
  totalBytesReceived: number
  services: Array<Omit<ServiceEntry, 'servers'>>
}

export type ServiceResolutionSeconds = 300 | 3600 | 86400

/** Longest window the 5-minute tier serves (864 points). */
export const SERVICE_5M_MAX_SPAN_SECONDS = 3 * 86400
/** Windows up to this long pick 5 m automatically. */
const SERVICE_5M_AUTO_SPAN_SECONDS = 2 * 86400

export type ServiceTrafficBucket = {
  bucketStart: string | null
  bucketEnd: string | null
  bytesServed: number
  bytesReceived: number
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
  return ts.toFormat('yyyy-MM-dd HH:mm:ss')
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()
  const parsed = DateTime.fromSQL(value, { zone: 'utc' })
  return parsed.isValid ? parsed.toISO() : String(value)
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
  const where: string[] = ['s.hour_start >= ?', 's.hour_start < ?']
  const bindings: Array<string | number> = [sql(opts.since), sql(opts.until)]
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
      FROM device_service_buckets_hourly s
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

  return { totalBytesServed, totalBytesReceived, services: serviceList, servers: serverList }
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
      const where: string[] = ['s.mac = ?', 's.hour_start >= ?', 's.hour_start < ?']
      const bindings: Array<string | number> = [opts.mac, sql(opts.since), sql(opts.until)]
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
          FROM device_service_buckets_hourly s
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

/** 5-minute, hourly or daily served/received series for one server name. */
export async function queryServiceTraffic(opts: {
  serverName: string
  since: DateTime
  until: DateTime
  resolutionSeconds: ServiceResolutionSeconds
  collectorId?: number
}): Promise<ServiceTrafficBucket[]> {
  const { ttlMs, segment } = windowCache(
    resolutionLabel(opts.resolutionSeconds),
    opts.since,
    opts.until,
    Date.now()
  )
  return cachedQuery(
    cacheKey([
      'services:traffic',
      opts.serverName,
      segment,
      opts.resolutionSeconds,
      opts.collectorId ?? '',
    ]),
    ttlMs,
    async () => {
      const fiveMin = opts.resolutionSeconds === 300
      const daily = opts.resolutionSeconds === 86400
      const table = fiveMin ? 'device_service_buckets_5m' : 'device_service_buckets_hourly'
      const timeCol = fiveMin ? 's.slot_start' : 's.hour_start'
      const bucketExpr = daily
        ? 'DATE_SUB(s.hour_start, INTERVAL MOD(TO_SECONDS(s.hour_start), 86400) SECOND)'
        : timeCol
      const where: string[] = ['s.server_name = ?', `${timeCol} >= ?`, `${timeCol} < ?`]
      const bindings: Array<string | number> = [opts.serverName, sql(opts.since), sql(opts.until)]
      if (opts.collectorId) {
        where.push('s.collector_id = ?')
        bindings.push(opts.collectorId)
      }
      const rows = rawRows<{
        bucketStart: Date | string
        bytesServed: bigint | number | string
        bytesReceived: bigint | number | string
      }>(
        await db.rawQuery(
          `
          SELECT
            ${bucketExpr}         AS bucketStart,
            SUM(s.bytes_served)   AS bytesServed,
            SUM(s.bytes_received) AS bytesReceived
          FROM ${table} s
          WHERE ${where.join(' AND ')}
          GROUP BY bucketStart
          ORDER BY bucketStart ASC
        `,
          bindings
        )
      )
      return rows.map((r) => {
        const start = toIso(r.bucketStart)
        return {
          bucketStart: start,
          bucketEnd: start
            ? DateTime.fromISO(start, { setZone: true })
                .plus({ seconds: opts.resolutionSeconds })
                .toISO()
            : null,
          bytesServed: n(r.bytesServed),
          bytesReceived: n(r.bytesReceived),
        }
      })
    }
  )
}

/**
 * Resolution for a name's traffic chart. `5m` is served only while the
 * window fits the 5-minute tier (≤ 3 days, and not older than its
 * retention); a request for it outside that falls back to hourly. Auto:
 * 5 m up to two days, hourly up to ~2000 points, daily beyond.
 */
export function pickServiceResolution(
  requested: '5m' | '1h' | '1d' | undefined,
  since: DateTime,
  until: DateTime,
  now: DateTime = DateTime.utc()
): ServiceResolutionSeconds {
  const span = windowSpanSeconds(since, until)
  const retentionDays = env.get('SERVICE_5M_RETENTION_DAYS', 14)
  const fiveMinAvailable =
    span <= SERVICE_5M_MAX_SPAN_SECONDS && since >= now.minus({ days: retentionDays })
  if (requested === '5m') return fiveMinAvailable ? 300 : 3600
  if (requested === '1d') return 86400
  if (requested === '1h') return 3600
  if (fiveMinAvailable && span <= SERVICE_5M_AUTO_SPAN_SECONDS) return 300
  return span / 3600 > 2000 ? 86400 : 3600
}

export function resolutionLabel(seconds: ServiceResolutionSeconds): '5m' | '1h' | '1d' {
  if (seconds === 300) return '5m'
  return seconds === 86400 ? '1d' : '1h'
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
