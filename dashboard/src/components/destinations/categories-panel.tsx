import { EmptyState } from '@/components/ui/empty-state'
import { ShareBar } from '@/components/ui/share-bar'
import { categoryColor, categoryLabel, isFlaggedCategory } from '@/lib/categories'
import { formatBytes } from '@/lib/format-bytes'
import type { DestinationCategoryEntry } from '@/types/api'

type CategoriesPanelProps = {
  categories: DestinationCategoryEntry[] | undefined
  isPending: boolean
  error: Error | null
  /** Hide the in/out columns. */
  compact?: boolean
  limit?: number
}

/**
 * "Applications": WAN bytes by nDPI category, from the destination history.
 * One share bar per category, colour stable per category (never per rank).
 */
export function CategoriesPanel({ categories, isPending, error, compact = false, limit = 10 }: CategoriesPanelProps) {
  if (isPending && !categories) {
    return <p className="px-4 pb-4 text-xs text-muted-foreground">Loading categories…</p>
  }
  if (error) {
    return <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
  }
  const rows = (categories ?? []).slice(0, limit)
  if (rows.length === 0) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          title="No application data in this window"
          description="Categories come from the hourly destination history. Widen the window or wait for the next hour to close."
        />
      </div>
    )
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Application</th>
          <th className="text-right">Share</th>
          {!compact ? <th className="text-right">Down</th> : null}
          {!compact ? <th className="text-right">Up</th> : null}
          <th className="text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <tr key={entry.category}>
            <td>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryColor(entry.category) }}
                />
                <span className="font-medium">{categoryLabel(entry.category)}</span>
                {isFlaggedCategory(entry.category) ? (
                  <span className="text-[10px] uppercase tracking-wide text-status-critical">flag</span>
                ) : null}
              </span>
            </td>
            <td>
              <ShareBar percentage={entry.percentage} color={categoryColor(entry.category)} />
            </td>
            {!compact ? <td className="text-right font-mono tabular-nums">{formatBytes(entry.bytesIn)}</td> : null}
            {!compact ? <td className="text-right font-mono tabular-nums">{formatBytes(entry.bytesOut)}</td> : null}
            <td className="text-right font-mono font-medium tabular-nums">{formatBytes(entry.totalBytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
