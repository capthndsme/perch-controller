import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import { pickSeriesTier, windowSpanSeconds } from '#services/rollup_tiers'
import { RESOLUTION_SECONDS, type WifiResolution } from '#validators/wifi'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Per-access-point client throughput history, read from the AP interface
 * counters (`wifi_interface_buckets` and its rollup tiers).
 *
 * Direction is expressed in *client* terms, which is the opposite of the
 * interface counters: an AP's wlan interface *transmits* what stations
 * download and *receives* what they upload. So `download` = `bytes_out`
 * (AP → stations) and `upload` = `bytes_in` (stations → AP). The 5 GHz
 * SSIDs on this network carry ~10× more transmit than receive and the
 * camera SSID the reverse, which is how the mapping was confirmed.
 */

const RESOLUTION_ORDER: WifiResolution[] = ['5s', '15s', '1m', '5m', '15m', '1h']

/** Same chart-point budget the device traffic endpoints coarsen towards. */
const TARGET_BUCKETS = 2000

export type ApThroughputPoint = {
  downloadBytes: number
  uploadBytes: number
  downloadMbps: number
  uploadMbps: number
}

export type ApThroughputBucket = {
  bucketStart: string
  /** Keyed by AP id (as a string, since it is a JSON object key). */
  aps: Record<string, ApThroughputPoint>
}

export type ApThroughputAp = {
  id: number
  name: string
  friendlyName: string | null
  downloadBytes: number
  uploadBytes: number
}

export type ApThroughputHistory = {
  resolution: WifiResolution
  resolutionSeconds: number
  /** Every enabled AP plus any disabled one that has data, busiest first. */
  aps: ApThroughputAp[]
  buckets: ApThroughputBucket[]
}

type ThroughputRow = {
  apId: number
  bucketStart: Date | string
  downloadBytes: bigint | number | string
  uploadBytes: bigint | number | string
}

type ApRow = {
  id: number
  name: string
  friendlyName: string | null
  enabled: number | boolean
}

/**
 * Coarsen the requested grain until the window fits the point budget, the
 * way the device traffic endpoints do, so a 30-day request at `5s` reads
 * the hourly rollup instead of half a million rows.
 */
export function clampWifiResolution(
  requested: WifiResolution,
  since: DateTime,
  until: DateTime
): WifiResolution {
  const span = windowSpanSeconds(since, until)
  let i = Math.max(0, RESOLUTION_ORDER.indexOf(requested))
  while (
    i < RESOLUTION_ORDER.length - 1 &&
    span / RESOLUTION_SECONDS[RESOLUTION_ORDER[i]] > TARGET_BUCKETS
  ) {
    i += 1
  }
  return RESOLUTION_ORDER[i]
}

export async function queryApThroughputHistory(opts: {
  since: DateTime
  until: DateTime
  resolution: WifiResolution
}): Promise<ApThroughputHistory> {
  const resolution = clampWifiResolution(opts.resolution, opts.since, opts.until)
  const { ttlMs, segment } = windowCache(resolution, opts.since, opts.until, Date.now())
  return cachedQuery(cacheKey(['wifi:apThroughput', segment, resolution]), ttlMs, () =>
    queryApThroughputHistoryUncached(opts.since, opts.until, resolution)
  )
}

async function queryApThroughputHistoryUncached(
  since: DateTime,
  until: DateTime,
  resolution: WifiResolution
): Promise<ApThroughputHistory> {
  const resolutionSeconds = RESOLUTION_SECONDS[resolution]
  const tier = pickSeriesTier(resolutionSeconds, since, until)
  const table = tier ? tier.wifiTable : 'wifi_interface_buckets'
  const timeCol = tier ? tier.timeColumn : 'bucket_start'
  const sinceSql = since.toFormat('yyyy-MM-dd HH:mm:ss')
  const untilSql = until.toFormat('yyyy-MM-dd HH:mm:ss')

  // Bare GROUP BY on the indexed slot column when the grain matches the tier;
  // otherwise bucket on the fly (its `?` placeholders sit in the SELECT).
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
  bindings.push(sinceSql, untilSql)

  const sql = `
    SELECT
      ap_id          AS apId,
      ${bucketSelect},
      SUM(bytes_out) AS downloadBytes,
      SUM(bytes_in)  AS uploadBytes
    FROM ${table}
    WHERE ${timeCol} >= ? AND ${timeCol} < ?
    GROUP BY apId, ${groupByBucket}
    ORDER BY bucketStart ASC
  `
  const [rows, apRows] = await Promise.all([
    db.rawQuery(sql, bindings).then((result) => rawRows<ThroughputRow>(result)),
    db
      .from('wifi_access_points')
      .select('id', 'name', 'friendly_name AS friendlyName', 'enabled')
      .orderBy('id', 'asc') as unknown as Promise<ApRow[]>,
  ])

  const totals = new Map<number, { downloadBytes: number; uploadBytes: number }>()
  const buckets = new Map<string, ApThroughputBucket>()
  for (const row of rows) {
    const bucketStart = toIso(row.bucketStart)
    if (!bucketStart) continue
    const apId = Number(row.apId)
    const downloadBytes = toNumber(row.downloadBytes)
    const uploadBytes = toNumber(row.uploadBytes)

    let bucket = buckets.get(bucketStart)
    if (!bucket) {
      bucket = { bucketStart, aps: {} }
      buckets.set(bucketStart, bucket)
    }
    bucket.aps[String(apId)] = {
      downloadBytes,
      uploadBytes,
      downloadMbps: (downloadBytes * 8) / resolutionSeconds / 1_000_000,
      uploadMbps: (uploadBytes * 8) / resolutionSeconds / 1_000_000,
    }

    const total = totals.get(apId) ?? { downloadBytes: 0, uploadBytes: 0 }
    total.downloadBytes += downloadBytes
    total.uploadBytes += uploadBytes
    totals.set(apId, total)
  }

  const aps: ApThroughputAp[] = apRows
    .filter((ap) => Boolean(ap.enabled) || totals.has(ap.id))
    .map((ap) => {
      const total = totals.get(ap.id) ?? { downloadBytes: 0, uploadBytes: 0 }
      return {
        id: ap.id,
        name: ap.name,
        friendlyName: ap.friendlyName ?? null,
        downloadBytes: total.downloadBytes,
        uploadBytes: total.uploadBytes,
      }
    })
    .sort(
      (a, b) =>
        b.downloadBytes + b.uploadBytes - (a.downloadBytes + a.uploadBytes) ||
        a.name.localeCompare(b.name)
    )

  return { resolution, resolutionSeconds, aps, buckets: [...buckets.values()] }
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
