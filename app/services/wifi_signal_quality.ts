export type WifiSignalQuality = 'excellent' | 'very_good' | 'good' | 'fair' | 'weak' | 'very_weak'

/**
 * Maps RSSI (dBm) into operator-friendly quality tiers.
 */
export function classifySignalQuality(
  signalDbm: number | null | undefined
): WifiSignalQuality | null {
  if (signalDbm === null || signalDbm === undefined || Number.isNaN(signalDbm)) {
    return null
  }
  if (signalDbm >= -50) return 'excellent'
  if (signalDbm >= -60) return 'very_good'
  if (signalDbm >= -67) return 'good'
  if (signalDbm >= -70) return 'fair'
  if (signalDbm >= -80) return 'weak'
  return 'very_weak'
}
