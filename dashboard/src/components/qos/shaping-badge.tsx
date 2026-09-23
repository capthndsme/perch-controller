import { Gauge } from '@phosphor-icons/react'
import { shapingSummary, SHAPING_STATE, viaLabel } from '@/lib/qos'
import { cn } from '@/lib/utils'
import type { DeviceShaping } from '@/types/api'

/** The devices list's speed-limit badge: the cap, tinted when the router does not enforce it right now. */
export function ShapingBadge({ shaping }: { shaping: DeviceShaping }) {
  const state = SHAPING_STATE[shaping.state]
  const trouble = shaping.state === 'exhausted' || shaping.state === 'failed'
  const title = [
    `Speed limit: ${shapingSummary(shaping)}`,
    shaping.policy ? `Policy ${shaping.policy.name} (${viaLabel(shaping.via).toLowerCase()})` : viaLabel(shaping.via),
    state.label,
  ].join(' · ')
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-4 items-center gap-0.5 rounded border px-1 text-[10px] whitespace-nowrap',
        trouble ? 'border-status-critical/50 text-status-critical' : 'border-border text-muted-foreground',
        shaping.state === 'paused' && 'line-through',
      )}
    >
      <Gauge className="size-3" aria-hidden />
      <span className="sr-only">Speed limit </span>
      {shaping.state === 'exhausted' ? 'quota used up' : shapingSummary(shaping)}
    </span>
  )
}
