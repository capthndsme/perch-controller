import { windowSpanSeconds, type TimeWindow } from '@/lib/time-window'
import type { ServiceTrafficBucket, TrafficResolution } from '@/types/api'

export type ServiceTrafficPoint = {
  ts: number
  served: number
  received: number
  /** Bucket length; drives the rate overlay (bytes × 8 / seconds). */
  seconds: number
}

/** The grains the service history API stores: 5-minute (recent), hourly, daily. */
export type ServiceResolution = '5m' | '1h' | '1d'

/** How long the 5-minute service tier is kept on the server. */
export const SERVICE_5M_RETENTION_DAYS = 14

/**
 * Resolution to *ask* for: 5-minute detail up to two days, hourly up to two
 * weeks, daily beyond. The API may still answer hourly for a short window
 * that is older than the 5-minute retention — read `data.resolution`.
 */
export function serviceResolutionFor(window: TimeWindow): ServiceResolution {
  const span = windowSpanSeconds(window)
  if (span <= 2 * 86400) return '5m'
  if (span <= 14 * 86400) return '1h'
  return '1d'
}

/** `5 min` · `hour` · `day` for captions. */
export function resolutionNoun(resolution: TrafficResolution | string | undefined): string {
  if (resolution === '5m') return '5 min'
  if (resolution === '1d') return 'day'
  if (resolution === '1h') return 'hour'
  return resolution ? String(resolution) : 'bucket'
}

export function serviceBucketsToPoints(
  buckets: ServiceTrafficBucket[],
  fallbackSeconds = 3600,
): ServiceTrafficPoint[] {
  return buckets
    .map((bucket) => {
      const ts = Date.parse(bucket.bucketStart)
      if (Number.isNaN(ts)) return null
      const end = Date.parse(bucket.bucketEnd)
      const seconds = Number.isNaN(end) || end <= ts ? fallbackSeconds : (end - ts) / 1000
      return { ts, served: bucket.bytesServed, received: bucket.bytesReceived, seconds }
    })
    .filter((point): point is ServiceTrafficPoint => point !== null)
    .sort((a, b) => a.ts - b.ts)
}
