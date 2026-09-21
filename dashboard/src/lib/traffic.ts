import type { BandwidthPoint } from '@/components/charts/bandwidth-chart'
import type { TrafficBucket, WifiClientSignalBucket } from '@/types/api'

/**
 * Largest-Triangle-Three-Buckets downsampling. Reduces a time-ordered
 * series to at most `threshold` points while preserving its visual shape
 * (peaks/troughs survive, unlike naive every-Nth sampling). Whole rows are
 * kept — never interpolated — so each retained point's other fields stay
 * exact; only which points are shown changes.
 *
 * This is what lets the new long ranges render: the backend's coarsest
 * grain is 1h, so a 1y view returns ~8.7k points and 2y ~17.5k — well past
 * where Recharts drags. LTTB to ~2k keeps the line crisp and the frame
 * rate up. Series under the threshold pass through untouched.
 *
 * `value` selects the magnitude the triangle areas are computed against
 * (e.g. download+upload); endpoints are always preserved so axis domains
 * stay correct.
 */
export function downsampleTimeSeries<T extends { ts: number }>(
  rows: T[],
  threshold: number,
  value: (row: T) => number,
): T[] {
  const n = rows.length
  if (threshold >= n || threshold < 3) return rows

  const sampled: T[] = [rows[0]]
  const bucketSize = (n - 2) / (threshold - 2)
  let a = 0

  for (let i = 0; i < threshold - 2; i += 1) {
    // Average point of the *next* bucket (the triangle's far vertex).
    const avgStart = Math.floor((i + 1) * bucketSize) + 1
    const avgEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n)
    const avgLen = Math.max(1, avgEnd - avgStart)
    let avgX = 0
    let avgY = 0
    for (let j = avgStart; j < avgEnd; j += 1) {
      avgX += rows[j].ts
      avgY += value(rows[j])
    }
    avgX /= avgLen
    avgY /= avgLen

    // Pick the point in the current bucket that forms the largest triangle
    // with `a` and the next bucket's average.
    const rangeStart = Math.floor(i * bucketSize) + 1
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1
    const ax = rows[a].ts
    const ay = value(rows[a])
    let maxArea = -1
    let next = rangeStart
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      const area =
        Math.abs((ax - avgX) * (value(rows[j]) - ay) - (ax - rows[j].ts) * (avgY - ay)) * 0.5
      if (area > maxArea) {
        maxArea = area
        next = j
      }
    }
    sampled.push(rows[next])
    a = next
  }

  sampled.push(rows[n - 1])
  return sampled
}

/**
 * Fold a prior period's buckets into the current chart points as `compare*`
 * fields, re-based onto the current axis by shifting each comparison bucket
 * forward by `offsetMs` (so "last week" lines up under "this week"). Buckets
 * are matched to current points by exact timestamp, which holds because both
 * series are fetched at the same resolution and the offset is a multiple of
 * it. Newly cheap wide-window queries are what make this overlay practical.
 */
export function withComparison(
  points: BandwidthPoint[],
  compareBuckets: TrafficBucket[],
  offsetMs: number,
): BandwidthPoint[] {
  if (compareBuckets.length === 0) return points
  const byTs = new Map<number, { d: number; u: number; db: number; ub: number }>()
  for (const bucket of compareBuckets) {
    const ts = Date.parse(String(bucket.bucketStart))
    if (Number.isNaN(ts)) continue
    const key = ts + offsetMs
    const cur = byTs.get(key) ?? { d: 0, u: 0, db: 0, ub: 0 }
    cur.d += bucket.mbpsIn
    cur.u += bucket.mbpsOut
    cur.db += bucket.bytesIn
    cur.ub += bucket.bytesOut
    byTs.set(key, cur)
  }
  return points.map((point) => {
    const c = byTs.get(point.ts)
    if (!c) return point
    return {
      ...point,
      compareDownload: c.d,
      compareUpload: c.u,
      compareDownloadBytes: c.db,
      compareUploadBytes: c.ub,
    }
  })
}

export function macPath(mac: string): string {
  return encodeURIComponent(mac)
}

export function macFromPath(segment: string): string {
  return decodeURIComponent(segment)
}

type ChartAggRow = {
  ts: number
  download: number
  upload: number
  downloadBytes: number
  uploadBytes: number
  lanDownload: number
  lanUpload: number
  lanDownloadBytes: number
  lanUploadBytes: number
  wifiDownload?: number
  wifiUpload?: number
}

function emptyRow(ts: number): ChartAggRow {
  return {
    ts,
    download: 0,
    upload: 0,
    downloadBytes: 0,
    uploadBytes: 0,
    lanDownload: 0,
    lanUpload: 0,
    lanDownloadBytes: 0,
    lanUploadBytes: 0,
  }
}

/**
 * Sum buckets that share a timestamp into chart points. When `overlay` is
 * provided, those buckets are folded into the SAME row at the matching
 * timestamp (under the `lan*` keys) so Recharts can render the overlay
 * directly off the primary dataset. Overlay timestamps that don't appear
 * in the primary set still get a row — otherwise a 5 s gap on the WAN
 * series would silently drop the LAN overlay's matching point.
 *
 * Returned points carry the numeric epoch (`ts`) as the X-axis key so
 * Recharts can render a true time-scaled axis and the drag-to-zoom math
 * has actual timestamps to work with (not pre-formatted strings).
 */
export function bucketsToChartPoints(
  buckets: TrafficBucket[],
  overlay?: TrafficBucket[],
  wifiOverlay?: WifiClientSignalBucket[],
): BandwidthPoint[] {
  const byTime = new Map<number, ChartAggRow>()

  for (const bucket of buckets) {
    const key = Date.parse(String(bucket.bucketStart))
    if (Number.isNaN(key)) continue
    const row = byTime.get(key) ?? emptyRow(key)
    row.download += bucket.mbpsIn
    row.upload += bucket.mbpsOut
    row.downloadBytes += bucket.bytesIn
    row.uploadBytes += bucket.bytesOut
    byTime.set(key, row)
  }

  if (overlay) {
    for (const bucket of overlay) {
      const key = Date.parse(String(bucket.bucketStart))
      if (Number.isNaN(key)) continue
      const row = byTime.get(key) ?? emptyRow(key)
      row.lanDownload += bucket.mbpsIn
      row.lanUpload += bucket.mbpsOut
      row.lanDownloadBytes += bucket.bytesIn
      row.lanUploadBytes += bucket.bytesOut
      byTime.set(key, row)
    }
  }

  if (wifiOverlay) {
    for (const bucket of wifiOverlay) {
      const key = Date.parse(String(bucket.bucketStart))
      if (Number.isNaN(key)) continue
      const row = byTime.get(key) ?? emptyRow(key)
      if (bucket.txRateKbps !== null) {
        const downloadMbps = bucket.txRateKbps / 1000
        row.wifiDownload = Math.max(row.wifiDownload ?? 0, downloadMbps)
      }
      if (bucket.rxRateKbps !== null) {
        const uploadMbps = bucket.rxRateKbps / 1000
        row.wifiUpload = Math.max(row.wifiUpload ?? 0, uploadMbps)
      }
      byTime.set(key, row)
    }
  }

  return [...byTime.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({
      ts: row.ts,
      download: row.download,
      upload: row.upload,
      downloadBytes: row.downloadBytes,
      uploadBytes: row.uploadBytes,
      lanDownload: row.lanDownload,
      lanUpload: row.lanUpload,
      lanDownloadBytes: row.lanDownloadBytes,
      lanUploadBytes: row.lanUploadBytes,
      wifiDownload: row.wifiDownload,
      wifiUpload: row.wifiUpload,
    }))
}
