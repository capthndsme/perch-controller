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
 * Below sm it is solid instead: a phone already scrolls under the frosted top
 * and bottom bars, and a third blurred layer over live charts costs frames.
 *
 * Anchored a small breather below the sticky top bar (it used to pin at
 * `top-3` and slid over the bar's account menu) and `z-20`, under the top
 * bar (`z-30`) and Radix popovers (`z-50`) but above page content like
 * cards and charts.
 */
export function DashboardToolbar({ children, className }: DashboardToolbarProps) {
  return (
    <div
      className={cn(
        'sticky top-[calc(var(--topbar-height)+0.75rem)] z-20 flex flex-wrap items-center justify-end gap-3',
        'rounded-xl border border-border/70 bg-background px-3 py-2 shadow-md',
        'sm:bg-background/70 sm:backdrop-blur-md sm:supports-[backdrop-filter]:bg-background/55',
        className,
      )}
      role="toolbar"
      aria-label="Dashboard controls"
    >
      {children}
    </div>
  )
}
