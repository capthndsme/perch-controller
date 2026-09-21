import { useMemo } from 'react'
import { ProtocolSegments } from '@/components/usage/protocol-segments'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { bucketHint, bucketTitle, periodNoun } from '@/lib/usage'
import { cn } from '@/lib/utils'
import type { UsageBucket, UsagePeriod, UsageTotals } from '@/types/api'

type UsageTableProps = {
  period: UsagePeriod
  buckets: UsageBucket[]
  totals: UsageTotals
  className?: string
}

function wifiCell(avg: number | null, max: number | null) {
  if (avg === null && max === null) return <span className="text-muted-foreground">—</span>
  return (
    <>
      {avg ?? '—'}
      <span className="text-muted-foreground"> / </span>
      {max ?? '—'}
    </>
  )
}

/**
 * The vnstat table: one row per bucket, newest first, with a totals footer.
 * Down / up / total / avg rate / devices / Wi-Fi avg÷max / protocol split.
 */
export function UsageTable({ period, buckets, totals, className }: UsageTableProps) {
  const rows = useMemo(() => [...buckets].reverse(), [buckets])
  const filled = buckets.filter((b) => b.totalBytes > 0).length

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="data-table">
        <thead>
          <tr>
            <th>{period === 'day' ? 'Day' : period === 'week' ? 'Week' : 'Month'}</th>
            <th className="text-right">Down</th>
            <th className="text-right">Up</th>
            <th className="text-right">Total</th>
            <th className="text-right">Avg rate</th>
            <th className="text-right" title="Distinct devices with traffic">
              Devices
            </th>
            <th className="text-right" title="Connected Wi-Fi clients: average / peak">
              Wi-Fi avg / peak
            </th>
            <th className="min-w-56">Protocols</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((bucket) => {
            const hint = bucketHint(period, bucket)
            const empty = bucket.totalBytes === 0
            return (
              <tr key={bucket.bucketStart} className={cn(empty && 'text-muted-foreground')}>
                <td>
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[12px] tabular-nums">{bucket.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{bucketTitle(period, bucket.label)}</span>
                    {hint ? (
                      <span className="rounded-sm border border-border/70 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {hint}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="text-right font-mono tabular-nums">{formatBytes(bucket.bytesIn)}</td>
                <td className="text-right font-mono tabular-nums">{formatBytes(bucket.bytesOut)}</td>
                <td className="text-right font-mono font-medium tabular-nums">{formatBytes(bucket.totalBytes)}</td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">{formatMbps(bucket.avgMbps)}</td>
                <td className="text-right font-mono tabular-nums">{bucket.activeDevices}</td>
                <td className="text-right font-mono tabular-nums">
                  {wifiCell(bucket.wifiClients.avg, bucket.wifiClients.max)}
                </td>
                <td>
                  <ProtocolSegments protocols={bucket.protocols} other={bucket.otherProtocols} />
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/30 font-medium">
            <td className="px-3 py-2">
              Total
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                {filled} of {buckets.length} {periodNoun(period, buckets.length)} with traffic
              </span>
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">{formatBytes(totals.bytesIn)}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">{formatBytes(totals.bytesOut)}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">{formatBytes(totals.totalBytes)}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
              {formatMbps(totals.avgMbps)}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums" title="Distinct devices over the whole window">
              {totals.activeDevices}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {wifiCell(totals.wifiClients.avg, totals.wifiClients.max)}
            </td>
            <td className="px-3 py-2">
              <ProtocolSegments protocols={totals.protocols} other={totals.otherProtocols} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
