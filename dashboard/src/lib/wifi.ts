import { windowSpanSeconds, type TimeWindow } from '@/lib/time-window'
import type { TrafficResolution, WifiSignalQuality } from '@/types/api'

export function wifiSignalQualityLabel(quality: WifiSignalQuality | null | undefined): string {
  if (!quality) return 'Unknown'
  if (quality === 'excellent') return 'Excellent'
  if (quality === 'very_good') return 'Very Good'
  if (quality === 'good') return 'Good'
  if (quality === 'fair') return 'Fair'
  if (quality === 'weak') return 'Weak'
  return 'Very Weak'
}

export function wifiSignalQualityDotClass(quality: WifiSignalQuality | null | undefined): string {
  if (quality === 'excellent' || quality === 'very_good') return 'bg-emerald-500'
  if (quality === 'good' || quality === 'fair') return 'bg-amber-500'
  if (quality === 'weak' || quality === 'very_weak') return 'bg-rose-500'
  return 'bg-muted-foreground/50'
}

export function formatWifiBand(band: string | null | undefined): string {
  if (!band) return 'Unknown'
  if (band === '2.4') return '2.4 GHz'
  if (band === '5') return '5 GHz'
  if (band === '6') return '6 GHz'
  return `${band} GHz`
}

export function formatSignal(signalDbm: number | null | undefined): string {
  if (signalDbm === null || signalDbm === undefined) return 'n/a'
  return `${Math.round(signalDbm)} dBm`
}

/**
 * Coarsest client-count grain that keeps a window under ~300 points. Only
 * the rollup grains (1m/5m/15m/1h) are offered: the raw 5s/15s fallback
 * scans snapshots and has no business on a dashboard tile.
 */
export function wifiHistoryResolutionForWindow(window: TimeWindow): TrafficResolution {
  const span = windowSpanSeconds(window)
  if (span <= 3 * 3600) return '1m'
  if (span <= 24 * 3600) return '5m'
  if (span <= 3 * 86_400) return '15m'
  return '1h'
}

