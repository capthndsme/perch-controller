/** 4708 → "4.7k", 262144 → "262k", 950 → "950". */
export function formatCompactCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(Math.round(value))
}

/** "12 s ago", "3 min ago", "1.5 h ago". */
export function formatSampleAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'never'
  if (seconds < 90) return `${Math.round(seconds)} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return `${(seconds / 3600).toFixed(1)} h ago`
}

/** Where the collector took its WAN interfaces from, as a stat hint. */
export function wanSourceHint(wanSource: string | null | undefined): string | undefined {
  if (wanSource === 'configured') return 'set on the collector'
  if (wanSource === 'default-route') return 'holding a default route'
  return undefined
}
