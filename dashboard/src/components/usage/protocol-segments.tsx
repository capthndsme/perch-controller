import { useState } from 'react'
import { CategoryChip } from '@/components/destinations/category-chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatBytes } from '@/lib/format-bytes'
import { formatProtocolLabel, protocolColor } from '@/lib/protocols'
import { cn } from '@/lib/utils'
import type { UsageOtherProtocols, UsageProtocol } from '@/types/api'

type ProtocolSegmentsProps = {
  protocols: UsageProtocol[]
  other: UsageOtherProtocols
  className?: string
}

/**
 * One bucket's protocol split as a compact stacked segment bar (colour
 * stable per protocol, 2px surface gaps), with a hover/click popover that
 * lists protocol · category · bytes · share. The popover is the readable
 * form; the bar is the glanceable one.
 */
export function ProtocolSegments({ protocols, other, className }: ProtocolSegmentsProps) {
  const [open, setOpen] = useState(false)
  if (protocols.length === 0) {
    return <span className="text-[11px] text-muted-foreground">—</span>
  }
  const segments = [
    ...protocols.map((p) => ({
      key: p.protocol,
      label: formatProtocolLabel(p.protocol),
      color: protocolColor(p.protocol),
      percentage: p.percentage,
    })),
    ...(other
      ? [
          {
            key: '__other',
            label: `${other.count} other`,
            color: 'var(--series-other)',
            percentage: other.percentage,
          },
        ]
      : []),
  ]
  const lead = protocols[0]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full min-w-40 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className,
          )}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          aria-label={`Protocols: ${segments.map((s) => `${s.label} ${s.percentage}%`).join(', ')}`}
        >
          <span className="flex h-2 flex-1 gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
            {segments.map((s) => (
              <span
                key={s.key}
                className="h-full"
                style={{ width: `${Math.max(0, Math.min(100, s.percentage))}%`, backgroundColor: s.color }}
              />
            ))}
          </span>
          <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">
            {formatProtocolLabel(lead.protocol)} {lead.percentage}%
            {other ? ` · +${other.count}` : ''}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <table className="w-full text-[11px]">
          <tbody>
            {protocols.map((p) => (
              <tr key={p.protocol}>
                <td className="py-0.5 pr-2">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: protocolColor(p.protocol) }}
                    />
                    <span className="truncate font-medium">{formatProtocolLabel(p.protocol)}</span>
                  </span>
                </td>
                <td className="py-0.5 pr-2">
                  <CategoryChip category={p.category} />
                </td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatBytes(p.totalBytes)}
                </td>
                <td className="py-0.5 text-right font-mono tabular-nums">{p.percentage}%</td>
              </tr>
            ))}
            {other ? (
              <tr>
                <td className="py-0.5 pr-2" colSpan={2}>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span aria-hidden className="size-2 shrink-0 rounded-[2px] bg-series-other" />
                    {other.count} other {other.count === 1 ? 'protocol' : 'protocols'}
                  </span>
                </td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatBytes(other.totalBytes)}
                </td>
                <td className="py-0.5 text-right font-mono tabular-nums">{other.percentage}%</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  )
}
