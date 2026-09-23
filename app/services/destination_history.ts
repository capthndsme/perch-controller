import { UNKNOWN_ORG, enrichIp, type AsnInfo } from '#services/asn_enrichment'
import { UNKNOWN_CATEGORY } from '#services/protocol_categories'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import type { ChartSettings } from '#services/chart_settings'
import { HOURLY_ROLLUP_SECONDS, coveredFrom, windowSpanSeconds } from '#services/rollup_tiers'
import {
  bucketLabel,
  cacheResolutionFor,
  denseBuckets,
  estimateBucketSeconds,
  mbps,
  planSeries,
  querySeriesSums,
  type SeriesTier,
} from '#services/series_buckets'
import type { SeriesMeta } from '#services/service_history'
import db from '@adonisjs/lucid/services/db'
import { type DateTime } from 'luxon'

/**
 * Read side of "where did the bytes go, by site / app"
 * (`device_destination_buckets_hourly`). Names are what the client asked
 * for (TLS SNI / HTTP Host / QUIC SNI); the unnamed pool per protocol keeps
 * app-level labels complete. Everything is cached per time window like the
 * other read helpers because the dashboard polls it.
 */

type DestinationRow = {
  serverName: string
  peerIp: string
  protocol: string
  category: string
  bytesIn: bigint | number | string
  bytesOut: bigint | number | string
  deviceCount: bigint | number | string
}

export type DestinationEntry = {
  serverName: string | null
  domain: string | null
  /** Peer address of an unnamed TLS/HTTP/QUIC row (null for named rows and the pool). */
  peerIp: string | null
  /** ASN / organisation of `peerIp`, when known. */
  asn: number | null
  org: string | null
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
  deviceCount: number
}

export type DestinationGroupName = {
  serverName: string | null
  peerIp: string | null
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
}

export type DestinationDomainGroup = {
  /** `d:<domain>` (named), `a:<asn|ip>` (unnamed, by network) or `p:<protocol>` (pool). */
  key: string
  domain: string | null
  protocol: string | null
  /** Network of an address group: ASN + organisation ("Google LLC"). */
  asn: number | null
  org: string | null
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
  nameCount: number
  deviceCount: number
  names: DestinationGroupName[]
}

export type DestinationCategoryEntry = {
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
}

export type DestinationsSummary = {
  /** Start of the hour rows read (`coveredFrom`): the hour that holds `from`. */
  coveredFrom: string
  totalBytes: number
  totalBytesIn: number
  totalBytesOut: number
  destinations: DestinationEntry[]
  domains: DestinationDomainGroup[]
  categories: DestinationCategoryEntry[]
}

export type DestinationTrafficBucket = {
  bucketStart: string
  bucketEnd: string
  /** Seconds of the bucket inside the window and not in the future. */
  seconds: number
  bytesIn: number
  bytesOut: number
  mbpsIn: number
  mbpsOut: number
}

export type DestinationTrafficSeries = SeriesMeta & { buckets: DestinationTrafficBucket[] }

/** Destinations are stored per hour only; their charts never go finer. */
const DESTINATION_TIERS: readonly SeriesTier[] = [
  {
    source: '1h',
    grainSeconds: HOURLY_ROLLUP_SECONDS,
    table: 'device_destination_buckets_hourly',
    timeColumn: 'hour_start',
  },
]

/** Members listed under each domain group. */
const GROUP_NAMES_LIMIT = 10
/** Peer addresses enriched with ASN per query; the long tail groups as unknown. */
const ENRICH_LIMIT = 400

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

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
/**
 * Second-level labels that act as a public suffix under a two-letter country
 * TLD ("co.uk", "com.au", "ne.jp"). Good enough for grouping hostnames on a
 * home network without shipping the public suffix list.
 */
const COUNTRY_SECOND_LEVEL = new Set([
  'co',
  'com',
  'net',
  'org',
  'gov',
  'edu',
  'ac',
  'ne',
  'or',
  'go',
  'mil',
  'nom',
  'sch',
  'ltd',
  'plc',
  'me',
  'id',
  'in',
])

/**
 * Registered domain of a server name: `rr4---sn-4g5e6nzl.googlevideo.com` →
 * `googlevideo.com`, `photos.example.co.uk` → `example.co.uk`. IP literals
 * and bare names come back unchanged; `''` and `null` map to null.
 */
/** `10.0.0.5`, `2001:db8::1` — an address where a hostname was expected. */
export function isIpLiteral(name: string): boolean {
  const trimmed = name.trim().toLowerCase()
  return IPV4.test(trimmed) || trimmed.includes(':')
}

export function registeredDomain(serverName: string | null | undefined): string | null {
  if (!serverName) return null
  const name = serverName.trim().toLowerCase().replace(/\.$/, '')
  if (!name) return null
  if (IPV4.test(name) || name.includes(':')) return name
  const labels = name.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const tld = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  const take = tld.length === 2 && COUNTRY_SECOND_LEVEL.has(second) && labels.length >= 3 ? 3 : 2
  return labels.slice(-take).join('.')
}

/** Whether any destination history exists for this MAC (drives 404 semantics). */
export async function destinationHistoryExistsForMac(mac: string): Promise<boolean> {
  const rows = await db
    .from('device_destination_buckets_hourly')
    .where('mac', mac)
    .limit(1)
    .select('mac')
  return rows.length > 0
}

/**
 * Network-wide (or one device's) destinations over the window: top names,
 * top registered domains with their member names, and the category split.
 */
export async function queryDestinationsSummary(opts: {
  since: DateTime
  until: DateTime
  collectorId?: number
  mac?: string
  limit: number
}): Promise<DestinationsSummary> {
  const { ttlMs, segment } = windowCache(null, opts.since, opts.until, Date.now())
  return cachedQuery(
    cacheKey(['destinations:summary', opts.mac ?? '', segment, opts.collectorId ?? '', opts.limit]),
    ttlMs,
    () => queryDestinationsSummaryUncached(opts)
  )
}

async function queryDestinationsSummaryUncached(opts: {
  since: DateTime
  until: DateTime
  collectorId?: number
  mac?: string
  limit: number
}): Promise<DestinationsSummary> {
  // Hourly rows only: from the hour that holds the window start.
  const from = coveredFrom(opts.since.toUTC(), HOURLY_ROLLUP_SECONDS)
  const where: string[] = ['d.hour_start >= ?', 'd.hour_start < ?']
  const bindings: Array<string | number> = [sql(from), sql(opts.until)]
  if (opts.collectorId) {
    where.push('d.collector_id = ?')
    bindings.push(opts.collectorId)
  }
  if (opts.mac) {
    where.push('d.mac = ?')
    bindings.push(opts.mac)
  }
  const rows = rawRows<DestinationRow>(
    await db.rawQuery(
      `
      SELECT
        d.server_name         AS serverName,
        d.peer_ip             AS peerIp,
        d.protocol            AS protocol,
        d.category            AS category,
        SUM(d.bytes_in)       AS bytesIn,
        SUM(d.bytes_out)      AS bytesOut,
        COUNT(DISTINCT d.mac) AS deviceCount
      FROM device_destination_buckets_hourly d
      WHERE ${where.join(' AND ')}
      GROUP BY d.server_name, d.peer_ip, d.protocol, d.category
    `,
      bindings
    )
  )

  // Fold the per-category rows of one (name, protocol) together; the
  // category with the most bytes wins the label.
  type Acc = DestinationEntry & { byCategory: Map<string, number> }
  const entries = new Map<string, Acc>()
  let totalBytesIn = 0
  let totalBytesOut = 0
  for (const row of rows) {
    const bytesIn = n(row.bytesIn)
    const bytesOut = n(row.bytesOut)
    totalBytesIn += bytesIn
    totalBytesOut += bytesOut
    const serverName = row.serverName || null
    // A server "name" that is really an address (an HTTP Host or SNI set to
    // a bare IP) has no domain to group under; treat it as an addressed
    // destination so it joins its network group like an unnamed flow would.
    const literal = serverName !== null && isIpLiteral(serverName)
    const peerIp = literal ? serverName : serverName ? null : row.peerIp || null
    const category = row.category || UNKNOWN_CATEGORY
    const key = `${serverName ?? ''}|${peerIp ?? ''}|${row.protocol}`
    const entry =
      entries.get(key) ??
      ({
        serverName,
        domain: literal ? null : registeredDomain(serverName),
        peerIp,
        asn: null,
        org: null,
        protocol: row.protocol,
        category,
        bytesIn: 0,
        bytesOut: 0,
        totalBytes: 0,
        percentage: 0,
        deviceCount: 0,
        byCategory: new Map<string, number>(),
      } satisfies Acc)
    entry.bytesIn += bytesIn
    entry.bytesOut += bytesOut
    entry.totalBytes += bytesIn + bytesOut
    entry.deviceCount = Math.max(entry.deviceCount, n(row.deviceCount))
    entry.byCategory.set(category, (entry.byCategory.get(category) ?? 0) + bytesIn + bytesOut)
    entries.set(key, entry)
  }
  const totalBytes = totalBytesIn + totalBytesOut

  // Attribute the unnamed-by-address rows to a network. Only the biggest
  // addresses are looked up (the ASN cache makes repeats free); the rest
  // group as an unknown network rather than stalling the response.
  const addressed = [...entries.values()]
    .filter((e) => e.peerIp)
    .sort((a, b) => b.totalBytes - a.totalBytes)
  const infos = await Promise.all(
    addressed.slice(0, ENRICH_LIMIT).map((e) => enrichIp(e.peerIp!).catch(() => null))
  )
  addressed.forEach((e, i) => {
    const info: AsnInfo | null = infos[i] ?? null
    e.asn = info?.asn ?? null
    e.org = info?.org ?? null
  })

  const all = [...entries.values()]
    .map(({ byCategory, ...entry }) => ({
      ...entry,
      category: dominant(byCategory) ?? entry.category,
      percentage: pct(entry.totalBytes, totalBytes),
    }))
    .sort(
      (a, b) =>
        b.totalBytes - a.totalBytes || cmp(a.serverName, b.serverName) || cmp(a.peerIp, b.peerIp)
    )

  const destinations = all.slice(0, opts.limit)

  // Registered-domain groups; unnamed rows pool per protocol.
  type Group = DestinationDomainGroup & { byCategory: Map<string, number> }
  const groups = new Map<string, Group>()
  for (const entry of all) {
    // An address whose lookup failed (timeout, prefix missing from the ASN
    // feed) has no network to share, so it stands alone under its own key
    // instead of every such address collapsing into one "Unknown" group.
    const networkKnown =
      entry.peerIp !== null &&
      (entry.asn !== null || (entry.org !== null && entry.org !== UNKNOWN_ORG))
    const key = entry.domain
      ? `d:${entry.domain}`
      : entry.peerIp
        ? networkKnown
          ? `a:${entry.asn ?? entry.org}`
          : `a:${entry.peerIp}`
        : `p:${entry.protocol}`
    const group =
      groups.get(key) ??
      ({
        key,
        domain: entry.domain,
        protocol: entry.domain || entry.peerIp ? null : entry.protocol,
        asn: networkKnown ? entry.asn : null,
        org: networkKnown ? entry.org : null,
        category: entry.category,
        bytesIn: 0,
        bytesOut: 0,
        totalBytes: 0,
        percentage: 0,
        nameCount: 0,
        deviceCount: 0,
        names: [],
        byCategory: new Map<string, number>(),
      } satisfies Group)
    group.bytesIn += entry.bytesIn
    group.bytesOut += entry.bytesOut
    group.totalBytes += entry.totalBytes
    group.nameCount += 1
    group.deviceCount = Math.max(group.deviceCount, entry.deviceCount)
    group.byCategory.set(
      entry.category,
      (group.byCategory.get(entry.category) ?? 0) + entry.totalBytes
    )
    group.names.push({
      serverName: entry.serverName,
      peerIp: entry.peerIp,
      protocol: entry.protocol,
      category: entry.category,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
      totalBytes: entry.totalBytes,
    })
    groups.set(key, group)
  }
  const domains = [...groups.values()]
    .map(({ byCategory, ...group }) => ({
      ...group,
      category: dominant(byCategory) ?? group.category,
      percentage: pct(group.totalBytes, totalBytes),
      names: group.names.sort((a, b) => b.totalBytes - a.totalBytes).slice(0, GROUP_NAMES_LIMIT),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes || cmp(a.domain ?? a.org, b.domain ?? b.org))
    .slice(0, opts.limit)

  const byCategory = new Map<string, { bytesIn: number; bytesOut: number }>()
  for (const row of rows) {
    const category = row.category || UNKNOWN_CATEGORY
    const acc = byCategory.get(category) ?? { bytesIn: 0, bytesOut: 0 }
    acc.bytesIn += n(row.bytesIn)
    acc.bytesOut += n(row.bytesOut)
    byCategory.set(category, acc)
  }
  const categories = [...byCategory.entries()]
    .map(([category, acc]) => ({
      category,
      bytesIn: acc.bytesIn,
      bytesOut: acc.bytesOut,
      totalBytes: acc.bytesIn + acc.bytesOut,
      percentage: pct(acc.bytesIn + acc.bytesOut, totalBytes),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes || a.category.localeCompare(b.category))

  return {
    coveredFrom: from.toISO()!,
    totalBytes,
    totalBytesIn,
    totalBytesOut,
    destinations,
    domains,
    categories,
  }
}

/**
 * Dense in/out series for one destination name: every bucket of the window,
 * empty ones as zero (`series_buckets.ts`). Only hourly rows exist, so the
 * width is at least an hour whatever the admin floor says.
 */
export async function queryDestinationTraffic(opts: {
  serverName: string
  since: DateTime
  until: DateTime
  collectorId?: number
  requestedSeconds?: number
  settings: ChartSettings
}): Promise<DestinationTrafficSeries> {
  const { minBucketSeconds: floorSeconds, maxPoints } = opts.settings
  const estimate = estimateBucketSeconds(
    windowSpanSeconds(opts.since, opts.until),
    Math.max(HOURLY_ROLLUP_SECONDS, opts.requestedSeconds ?? 0),
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
      'destinations:traffic',
      opts.serverName,
      segment,
      opts.collectorId ?? '',
      opts.requestedSeconds ?? '',
      maxPoints,
    ]),
    ttlMs,
    async () => {
      const plan = planSeries({
        sinceSec: Math.floor(opts.since.toSeconds()),
        untilSec: Math.floor(opts.until.toSeconds()),
        nowSec: Math.floor(Date.now() / 1000),
        floorSeconds,
        maxPoints,
        requestedSeconds: opts.requestedSeconds,
        tiers: DESTINATION_TIERS.map((t) => ({ ...t, covers: true })),
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
        columns: ['bytes_in', 'bytes_out'],
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
      bytesIn: b.a,
      bytesOut: b.b,
      mbpsIn: mbps(b.a, b.seconds),
      mbpsOut: mbps(b.b, b.seconds),
    })),
  }
}

function dominant(byCategory: Map<string, number>): string | null {
  let best: string | null = null
  let bestBytes = -1
  for (const [category, bytes] of byCategory) {
    if (bytes > bestBytes || (bytes === bestBytes && best !== null && category < best)) {
      best = category
      bestBytes = bytes
    }
  }
  return best
}

function cmp(a: string | null, b: string | null): number {
  return (a ?? '').localeCompare(b ?? '')
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}
