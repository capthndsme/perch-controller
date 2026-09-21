import { CategoryChip } from '@/components/destinations/category-chip'
import { EmptyState } from '@/components/ui/empty-state'
import { ShareBar } from '@/components/ui/share-bar'
import { formatBytes } from '@/lib/format-bytes'
import { formatProtocolLabel, protocolColor } from '@/lib/protocols'
import type { UsageOtherProtocols, UsageProtocol } from '@/types/api'

type UsageApplicationsProps = {
  protocols: UsageProtocol[]
  other: UsageOtherProtocols
}

/**
 * "Applications in this window": the window's top protocols with their
 * nDPI category, down / up bytes and share. Colour is stable per protocol.
 */
export function UsageApplications({ protocols, other }: UsageApplicationsProps) {
  if (protocols.length === 0) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          title="No protocol data in this window"
          description="Protocol usage comes from the hourly rollups; it fills in as the collector runs."
        />
      </div>
    )
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Protocol</th>
          <th>Category</th>
          <th className="text-right">Down / up</th>
          <th className="text-right">Share</th>
        </tr>
      </thead>
      <tbody>
        {protocols.map((p) => (
          <tr key={p.protocol}>
            <td>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: protocolColor(p.protocol) }}
                />
                <span className="truncate font-medium">{formatProtocolLabel(p.protocol)}</span>
              </span>
            </td>
            <td>
              <CategoryChip category={p.category} />
            </td>
            <td className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              <span className="text-foreground">{formatBytes(p.bytesIn)}</span> / {formatBytes(p.bytesOut)}
            </td>
            <td>
              <ShareBar percentage={p.percentage} color={protocolColor(p.protocol)} />
            </td>
          </tr>
        ))}
        {other ? (
          <tr className="text-muted-foreground">
            <td>
              <span className="flex items-center gap-2">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] bg-series-other" />
                {other.count} other {other.count === 1 ? 'protocol' : 'protocols'}
              </span>
            </td>
            <td />
            <td className="text-right font-mono text-[11px] tabular-nums">
              {formatBytes(other.bytesIn)} / {formatBytes(other.bytesOut)}
            </td>
            <td>
              <ShareBar percentage={other.percentage} color="var(--series-other)" />
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  )
}
