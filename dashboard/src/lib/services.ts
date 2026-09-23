import { windowSpanSeconds, type TimeWindow } from '@/lib/time-window'
import type { SeriesSource, ServiceTrafficBucket } from '@/types/api'

export type ServiceTrafficPoint = {
  ts: number
  served: number
  received: number
  /**
   * Seconds of the bucket that lie inside the window (shorter for the partial
   * first and last bucket); drives the rate overlay (bytes × 8 / seconds).
   */
  seconds: number
}

/**
 * Refresh cadence of a live per-name series: the server's finest buckets
 * (15 s by default) only appear on short windows, so those poll every 15 s;
 * wider windows every minute.
 */
export function nameSeriesRefreshMs(window: TimeWindow): number {
  return windowSpanSeconds(window) <= 6 * 3600 ? 15_000 : 60_000
}

/** `15 s` · `1 min` · `5 min` · `1 h` · `1 day` for a bucket length in seconds. */
export function formatBucketSeconds(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return 'bucket'
  if (seconds % 86400 === 0) {
    const days = seconds / 86400
    return days === 1 ? '1 day' : `${days} days`
  }
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

/** How the stored tier behind a series reads in a caption. */
export function seriesSourceNote(source: SeriesSource | undefined): string | null {
  if (source === 'native') return 'from per-poll data'
  if (source === '5m') return 'from 5-minute data'
  if (source === '1h') return 'from hourly data'
  return null
}

/** Length of one bucket: the server's `seconds`, else end − start, else the fallback. */
export function bucketSecondsOf(
  bucket: { bucketStart: string | null; bucketEnd: string | null; seconds?: number },
  fallbackSeconds: number,
): number {
  if (typeof bucket.seconds === 'number' && bucket.seconds > 0) return bucket.seconds
  const ts = bucket.bucketStart ? Date.parse(bucket.bucketStart) : Number.NaN
  const end = bucket.bucketEnd ? Date.parse(bucket.bucketEnd) : Number.NaN
  return Number.isNaN(ts) || Number.isNaN(end) || end <= ts ? fallbackSeconds : (end - ts) / 1000
}

/**
 * The server answers a dense series (every bucket of the window, empty ones
 * as zero), so nothing is dropped here: a zero bucket is a real zero.
 */
export function serviceBucketsToPoints(
  buckets: ServiceTrafficBucket[],
  fallbackSeconds = 3600,
): ServiceTrafficPoint[] {
  return buckets
    .map((bucket) => {
      const ts = Date.parse(bucket.bucketStart)
      if (Number.isNaN(ts)) return null
      return {
        ts,
        served: bucket.bytesServed,
        received: bucket.bytesReceived,
        seconds: bucketSecondsOf(bucket, fallbackSeconds),
      }
    })
    .filter((point): point is ServiceTrafficPoint => point !== null)
    .sort((a, b) => a.ts - b.ts)
}

/** True when a series has no bytes at all (the dense series is never empty). */
export function seriesIsSilent(points: ServiceTrafficPoint[]): boolean {
  return points.every((p) => p.served === 0 && p.received === 0)
}
