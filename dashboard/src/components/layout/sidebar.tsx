import { Link, NavLink, useLocation } from 'react-router-dom'
import { CashRegister, SidebarSimple } from '@phosphor-icons/react'
import { useCanEnterSellMode } from '@/hooks/use-sell-mode'
import { NAV_ITEMS, navItemActive } from '@/lib/nav'
import { cn } from '@/lib/utils'

type SidebarProps = {
  collapsed: boolean
  onToggleCollapsed: () => void
  siteName: string
}

/**
 * Fixed left navigation on lg+: a permanent rail that collapses to icons.
 * Below lg the bottom bar (BottomNav) takes its place. Collapsing animates
 * only the rail's width; the labels stay mounted, clipped by the moving edge,
 * and fade.
 */
export function Sidebar({ collapsed, onToggleCollapsed, siteName }: SidebarProps) {
  const { pathname } = useLocation()
  const canSell = useCanEnterSellMode()
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 hidden flex-col overflow-x-clip border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex',
        // Only the rail animates; its labels stay mounted and are clipped by the moving edge.
        'transition-[width] duration-base ease-drawer motion-reduce:transition-none',
        'w-[var(--sidebar-width)]',
        collapsed && 'lg:w-[var(--sidebar-width-collapsed)]',
      )}
      aria-label="Primary"
    >
      <div className="flex h-[var(--topbar-height)] items-center gap-2 border-b border-sidebar-border px-3">
        <NavLink to="/" className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand text-brand-foreground text-[11px] font-bold"
          >
            P
          </span>
          <span
            className={cn(
              'min-w-0 shrink-0 transition-opacity duration-fast ease-out motion-reduce:transition-none',
              collapsed && 'opacity-0',
            )}
          >
            <span className="block truncate text-sm font-semibold leading-tight">{siteName}</span>
            <span className="block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
              Network controller
            </span>
          </span>
        </NavLink>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="Sections">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            title={collapsed ? item.label : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
              navItemActive(item, pathname)
                ? 'bg-brand/10 text-brand'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
            )}
          >
            <item.icon className="size-[18px] shrink-0" weight="regular" />
            <span
              className={cn(
                'whitespace-nowrap transition-opacity duration-fast ease-out motion-reduce:transition-none',
                collapsed && 'opacity-0',
              )}
            >
              {item.label}
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="hidden border-t border-sidebar-border p-2 lg:block">
        {canSell ? (
          // Sell Mode (portal.md §15) leaves the shell: a full-screen page with its own back button.
          <Link
            to="/sell"
            title={collapsed ? 'Enter Sell Mode' : undefined}
            className="mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand/10"
          >
            <CashRegister className="size-[18px] shrink-0" />
            <span
              className={cn(
                'whitespace-nowrap transition-opacity duration-fast ease-out motion-reduce:transition-none',
                collapsed && 'opacity-0',
              )}
            >
              Enter Sell Mode
            </span>
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <SidebarSimple className="size-[18px] shrink-0" />
          <span
            className={cn(
              'whitespace-nowrap transition-opacity duration-fast ease-out motion-reduce:transition-none',
              collapsed && 'opacity-0',
            )}
          >
            Collapse
          </span>
        </button>
      </div>
    </aside>
  )
}
