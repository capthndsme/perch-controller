import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type DashboardToolbarProps = {
  children: ReactNode
  className?: string
}

/**
 * Sticky, frosted "floating" toolbar that hosts the global dashboard
 * controls (scope, time range, auto-refresh). Modeled on Grafana's
 * top-of-dashboard toolbar — once the page scrolls past the title, the
 * toolbar detaches and pins to the top of the viewport so the
 * time-range and scope are always one click away.
 *
 * The translucent background plus `backdrop-blur` produces the frosted
 * glass effect; the `supports-[backdrop-filter]` fallback bumps the
 * opacity higher on browsers that can't do the blur, so the bar still
 * reads as a distinct strip without losing legibility.
 *
 * Anchored at `top-3` (small breather from the viewport edge) and
 * `z-30` so it sits below Radix popovers (which run at `z-50`) but
 * above page content like cards and charts.
 */
export function DashboardToolbar({ children, className }: DashboardToolbarProps) {
  return (
    <div
      className={cn(
        'sticky top-3 z-30 flex flex-wrap items-center justify-end gap-3',
        'rounded-xl border border-border/70 bg-background/70 px-3 py-2 shadow-md',
        'backdrop-blur-md supports-[backdrop-filter]:bg-background/55',
        className,
      )}
      role="toolbar"
      aria-label="Dashboard controls"
    >
      {children}
    </div>
  )
}
