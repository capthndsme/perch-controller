import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/ui/panel'
import { formatLastSeen } from '@/lib/collectors'
import { formatDateTime, PART_LABELS, PART_ORDER } from '@/lib/gateway-observation'
import type { GatewayObservationOverview } from '@/types/api'

/**
 * When each part of the router's state last arrived and last changed. The
 * agent resends everything at least every 10 min, so a part older than
 * 30 min means the agent is gone or stuck ("stale").
 */
export function GatewayFreshnessPanel({ overview, isAdmin }: { overview: GatewayObservationOverview; isAdmin: boolean }) {
  const parts = PART_ORDER.filter((part) => overview.parts[part] !== undefined)
  return (
    <Panel title="Last observed" description="Each part of the router's state, as last reported." flush>
      {parts.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing observed yet.</p>
      ) : (
        <ul className="divide-y divide-border/70 px-4 pb-2">
          {parts.map((part) => {
            const info = overview.parts[part]!
            return (
              <li key={part} className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]">
                <span className="flex items-center gap-1.5">
                  {PART_LABELS[part]}
                  {info.stale ? (
                    <Badge variant="outline" className="rounded border-status-warning/50 text-[10px] text-status-warning">
                      stale
                    </Badge>
                  ) : null}
                </span>
                <span className="text-right text-[11.5px] text-muted-foreground">
                  <span title={formatDateTime(info.observedAt)}>{formatLastSeen(info.observedAt)}</span>
                  <span className="block text-[10.5px]" title={formatDateTime(info.changedAt)}>
                    changed {formatLastSeen(info.changedAt)}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {isAdmin && overview.capabilities && overview.capabilities.length > 0 ? (
        <details className="border-t border-border/70 px-4 py-2.5 text-[11.5px]">
          <summary className="cursor-pointer text-muted-foreground">Agent capabilities ({overview.capabilities.length})</summary>
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-muted-foreground">
            {overview.capabilities.join(' · ')}
          </p>
        </details>
      ) : null}
    </Panel>
  )
}
