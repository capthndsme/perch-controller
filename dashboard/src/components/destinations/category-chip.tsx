import { categoryColor, categoryLabel, isFlaggedCategory } from '@/lib/categories'
import { cn } from '@/lib/utils'

/** Inline nDPI category tag: colour dot + short label, red-ish when flagged. */
export function CategoryChip({ category, className }: { category: string | null | undefined; className?: string }) {
  const flagged = isFlaggedCategory(category)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-border/70 px-1.5 py-px text-[10px] font-medium text-muted-foreground',
        flagged && 'border-status-critical/40 text-foreground',
        className,
      )}
      title={category ?? 'other'}
    >
      <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ backgroundColor: categoryColor(category) }} />
      {categoryLabel(category)}
    </span>
  )
}
