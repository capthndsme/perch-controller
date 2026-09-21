const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    UNITS.length - 1,
  )
  const value = bytes / k ** i

  return `${value.toFixed(decimals)} ${UNITS[i]}`
}

/**
 * Round ticks for a zero-based byte axis: 1 / 2 / 2.5 / 5 steps in the
 * 1024-based unit of `max` (as formatBytes), every label in that one unit
 * so neighbouring ticks never round to the same text ("1.5 GB", not "2 GB").
 */
export function byteAxisTicks(max: number, count = 4): { ticks: number[]; format: (bytes: number) => string } {
  const top = Math.max(max, 1)
  const i = Math.min(Math.floor(Math.log(top) / Math.log(1024)), UNITS.length - 1)
  const unit = 1024 ** i
  const raw = top / unit / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = Math.max(([1, 2, 2.5, 5, 10].find((f) => f * mag >= raw) ?? 10) * mag, i === 0 ? 1 : 0)
  const n = Math.max(1, Math.ceil(top / unit / step - 1e-9))
  return {
    ticks: Array.from({ length: n + 1 }, (_, j) => j * step * unit),
    format: (bytes) => (bytes === 0 ? '0' : `${Number((bytes / unit).toFixed(2))} ${UNITS[i]}`),
  }
}

export function formatMbps(mbps: number, decimals = 2): string {
  if (!Number.isFinite(mbps)) return '0 Mbps'
  if (Math.abs(mbps) >= 100) return `${mbps.toFixed(0)} Mbps`
  if (Math.abs(mbps) >= 10) return `${mbps.toFixed(1)} Mbps`
  return `${mbps.toFixed(decimals)} Mbps`
}
