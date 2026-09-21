import { deviceDisplayName } from '@/lib/device-labels'
import { formatBytes } from '@/lib/format-bytes'
import type { TopTrafficResponse, WifiApThroughputResponse } from '@/types/api'

/**
 * Shared shape for the "several entities, each with a download and an
 * upload rate" charts (per-AP throughput, top talkers). Every series owns
 * two columns on each point: `<key>__down` and `<key>__up`, both Mbps.
 */
export type RateSeries = {
  /** CSS-identifier-safe key (see `sanitizeSeriesKey`). */
  key: string
  label: string
  color: string
  /** Optional legend suffix, e.g. the window totals. */
  detail?: string
}

export type RatePoint = { ts: number } & Record<string, number>

export type RateChartMode = 'lines' | 'stacked'
export type RateChartDirection = 'down' | 'up' | 'both'

export const RATE_MODE_OPTIONS = [
  { id: 'lines', label: 'Lines', title: 'One line per series' },
  { id: 'stacked', label: 'Stacked', title: 'Stacked areas; the top edge is the total' },
] as const satisfies ReadonlyArray<{ id: RateChartMode; label: string; title?: string }>

export const RATE_DIRECTION_OPTIONS = [
  { id: 'down', label: 'Down', title: 'Download only' },
  { id: 'up', label: 'Up', title: 'Upload only' },
  { id: 'both', label: 'Both', title: 'Download and upload' },
] as const satisfies ReadonlyArray<{ id: RateChartDirection; label: string; title?: string }>

export function sanitizeSeriesKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_')
}

export function downKey(key: string): string {
  return `${key}__down`
}

export function upKey(key: string): string {
  return `${key}__up`
}

/** The eight categorical slots the other multi-series charts draw from. */
export const SERIES_SLOT_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const

export function seriesSlotColor(index: number): string {
  return SERIES_SLOT_COLORS[index % SERIES_SLOT_COLORS.length]
}

function totalsDetail(downloadBytes: number, uploadBytes: number): string {
  return `${formatBytes(downloadBytes)} ↓ · ${formatBytes(uploadBytes)} ↑`
}

/**
 * Per-AP throughput → chart series + points. Colours follow the same rule
 * as the client-distribution chart (slot by the AP's position in the
 * alphabetically sorted display names) so an AP wears one colour across
 * the WiFi page; the series order itself is the API's busiest-first.
 */
export function apThroughputToRateData(response: WifiApThroughputResponse): {
  series: RateSeries[]
  points: RatePoint[]
} {
  const labels = response.aps.map((ap) => ap.friendlyName ?? ap.name)
  const colourOrder = [...labels].sort()
  const series: RateSeries[] = response.aps.map((ap, index) => ({
    key: `ap_${ap.id}`,
    label: labels[index],
    color: seriesSlotColor(colourOrder.indexOf(labels[index])),
    detail: totalsDetail(ap.downloadBytes, ap.uploadBytes),
  }))

  const points: RatePoint[] = []
  for (const bucket of response.buckets) {
    const ts = Date.parse(bucket.bucketStart)
    if (Number.isNaN(ts)) continue
    const point: RatePoint = { ts }
    for (const ap of response.aps) {
      const entry = bucket.aps[String(ap.id)]
      const key = `ap_${ap.id}`
      point[downKey(key)] = entry?.downloadMbps ?? 0
      point[upKey(key)] = entry?.uploadMbps ?? 0
    }
    points.push(point)
  }
  return { series, points }
}

export const OTHERS_SERIES_KEY = 'others'

export function topTrafficDeviceLabel(device: {
  customName?: string | null
  hostname: string | null
  primaryIp: string | null
  mac: string
}): string {
  return deviceDisplayName(device)
}

/**
 * Top talkers → chart series + points. The top-N wear the categorical
 * slots in rank order; everyone else is one neutral "Others" series.
 */
export function topTrafficToRateData(response: TopTrafficResponse): {
  series: RateSeries[]
  points: RatePoint[]
} {
  const keyed = response.devices.map((device) => ({
    device,
    key: `dev_${sanitizeSeriesKey(device.mac)}`,
  }))
  const series: RateSeries[] = keyed.map(({ device, key }, index) => ({
    key,
    label: topTrafficDeviceLabel(device),
    color: seriesSlotColor(index),
    detail: totalsDetail(device.bytesIn, device.bytesOut),
  }))
  if (response.rest.deviceCount > 0) {
    series.push({
      key: OTHERS_SERIES_KEY,
      label: `Others (${response.rest.deviceCount} ${response.rest.deviceCount === 1 ? 'device' : 'devices'})`,
      color: 'var(--series-other)',
      detail: totalsDetail(response.rest.bytesIn, response.rest.bytesOut),
    })
  }

  const points: RatePoint[] = []
  for (const bucket of response.buckets) {
    const ts = Date.parse(bucket.bucketStart)
    if (Number.isNaN(ts)) continue
    const point: RatePoint = { ts }
    for (const { device, key } of keyed) {
      const entry = bucket.devices[device.mac]
      point[downKey(key)] = entry?.mbpsIn ?? 0
      point[upKey(key)] = entry?.mbpsOut ?? 0
    }
    if (response.rest.deviceCount > 0) {
      point[downKey(OTHERS_SERIES_KEY)] = bucket.rest.mbpsIn
      point[upKey(OTHERS_SERIES_KEY)] = bucket.rest.mbpsOut
    }
    points.push(point)
  }
  return { series, points }
}
