import type { ChartSettings } from '#services/chart_settings'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import { windowSpanSeconds } from '#services/rollup_tiers'
import {
  apPollIntervalSeconds,
  bucketLabel,
  cacheResolutionFor,
  denseSlots,
  estimateBucketSeconds,
  mbps,
  planWindowSeries,
  querySeriesKeyedSums,
  wifiSeriesTiers,
  type SeriesSource,
} from '#services/series_buckets'
import { RESOLUTION_SECONDS, type WifiResolution } from '#validators/wifi'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

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
  bucketEnd: string
  /** Seconds of the bucket inside the window and not in the future. */
  seconds: number
  /** Keyed by AP id (as a string, since it is a JSON object key): every listed AP. */
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
  /** Label of the bucket width (`15s`, `1m`, `2m`…). */
  resolution: string
  resolutionSeconds: number
  bucketSeconds: number
  source: SeriesSource
  floorSeconds: number
  maxPoints: number
  /** Every enabled AP plus any disabled one that has data, busiest first. */
  aps: ApThroughputAp[]
  buckets: ApThroughputBucket[]
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

type ApThroughputOptions = {
  since: DateTime
  until: DateTime
  /** The caller's `resolution=` in seconds: the bucket width wanted. */
  requestedSeconds?: number
  settings: ChartSettings
}

/**
 * Dense (`series_buckets.ts`): one width and tier for the window, every
 * bucket, every listed AP in each (zero when quiet), rates over each
 * bucket's real seconds.
 */
export async function queryApThroughputHistory(
  opts: ApThroughputOptions
): Promise<ApThroughputHistory> {
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
      'wifi:apThroughput',
      segment,
      opts.requestedSeconds ?? '',
      opts.settings.minBucketSeconds,
      opts.settings.maxPoints,
    ]),
    ttlMs,
    () => queryApThroughputHistoryUncached(opts)
  )
}

async function queryApThroughputHistoryUncached(
  opts: ApThroughputOptions
): Promise<ApThroughputHistory> {
  const pushSeconds = await apPollIntervalSeconds()
  const plan = await planWindowSeries({
    sinceSec: Math.floor(opts.since.toSeconds()),
    untilSec: Math.floor(opts.until.toSeconds()),
    nowSec: Math.floor(Date.now() / 1000),
    tiers: wifiSeriesTiers(pushSeconds),
    pollSeconds: pushSeconds,
    floorSeconds: opts.requestedSeconds ?? opts.settings.minBucketSeconds,
    maxPoints: opts.settings.maxPoints,
  })

  // AP transmit (bytes_out) is what clients download.
  const [sums, apRows] = await Promise.all([
    querySeriesKeyedSums({
      plan,
      sinceSql: opts.since.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
      untilSql: opts.until.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
      columns: ['bytes_out', 'bytes_in'],
      keyExpr: 't.ap_id',
      where: [],
      bindings: [],
    }),
    db
      .from('wifi_access_points')
      .select('id', 'name', 'friendly_name AS friendlyName', 'enabled')
      .orderBy('id', 'asc') as unknown as Promise<ApRow[]>,
  ])

  const totals = new Map<number, { downloadBytes: number; uploadBytes: number }>()
  for (const byKey of sums.values()) {
    for (const [key, [downloadBytes, uploadBytes]] of byKey) {
      const apId = Number(key)
      const total = totals.get(apId) ?? { downloadBytes: 0, uploadBytes: 0 }
      total.downloadBytes += downloadBytes
      total.uploadBytes += uploadBytes
      totals.set(apId, total)
    }
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
        a.name.localeCompare(b.name) ||
        a.id - b.id
    )

  const buckets: ApThroughputBucket[] = denseSlots(plan).map((slot) => {
    const byKey = sums.get(slot.index)
    const points: Record<string, ApThroughputPoint> = {}
    for (const ap of aps) {
      const [downloadBytes, uploadBytes] = byKey?.get(String(ap.id)) ?? [0, 0]
      points[String(ap.id)] = {
        downloadBytes,
        uploadBytes,
        downloadMbps: mbps(downloadBytes, slot.seconds),
        uploadMbps: mbps(uploadBytes, slot.seconds),
      }
    }
    return {
      bucketStart: slot.bucketStart,
      bucketEnd: slot.bucketEnd,
      seconds: slot.seconds,
      aps: points,
    }
  })

  return {
    resolution: bucketLabel(plan.bucketSeconds),
    resolutionSeconds: plan.bucketSeconds,
    bucketSeconds: plan.bucketSeconds,
    source: plan.tier.source,
    floorSeconds: opts.settings.minBucketSeconds,
    maxPoints: opts.settings.maxPoints,
    aps,
    buckets,
  }
}
