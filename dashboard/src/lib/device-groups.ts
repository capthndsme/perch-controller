import type { DeviceGroup } from '@/types/device-groups'

/** "20 / 5 Mbit/s", "policy Slow", or null. */
export function groupSpeedText(group: DeviceGroup, policyName?: (id: number) => string | undefined): string | null {
  const q = group.qos
  if (!q) return null
  const parts: string[] = []
  if (q.policyId !== null) parts.push(`policy ${policyName?.(q.policyId) ?? `#${q.policyId}`}`)
  if (q.rate) {
    const mbit = (kbit: number | null) => (kbit ? `${Number((kbit / 1000).toFixed(2))}` : '∞')
    parts.push(`${mbit(q.rate.downloadKbit)} / ${mbit(q.rate.uploadKbit)} Mbit/s`)
  }
  return parts.join(', ') || null
}
