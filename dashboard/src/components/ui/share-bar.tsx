import { cn } from '@/lib/utils'

type ShareBarProps = {
  /** 0–100. */
  percentage: number
  /** Show the number next to the bar. */
  showLabel?: boolean
  /** CSS color for the fill; defaults to the brand accent. */
  color?: string
  className?: string
}

/** Thin proportional bar used in dense tables (one series → one color). */
export function ShareBar({ percentage, showLabel = true, color, className }: ShareBarProps) {
  const clamped = Math.max(0, Math.min(100, percentage))
  return (
    <div className={cn('flex items-center justify-end gap-2', className)}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full"
          style={{ width: `${clamped}%`, backgroundColor: color ?? 'var(--brand)' }}
        />
      </div>
      {showLabel ? (
        <span className="w-11 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {clamped.toFixed(clamped >= 10 ? 0 : 1)}%
        </span>
      ) : null}
    </div>
  )
}
