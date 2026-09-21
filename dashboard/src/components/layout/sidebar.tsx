import { NavLink } from 'react-router-dom'
import { SidebarSimple, X } from '@phosphor-icons/react'
import { NAV_ITEMS } from '@/lib/nav'
import { cn } from '@/lib/utils'

type SidebarProps = {
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Mobile drawer state; the sidebar is always visible on lg+. */
  mobileOpen: boolean
  onCloseMobile: () => void
  siteName: string
}

/**
 * Fixed left navigation. On lg+ it is a permanent rail that collapses to
 * icons; below lg it becomes a drawer over the content.
 */
export function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile, siteName }: SidebarProps) {
  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={onCloseMobile}
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200',
          'w-[var(--sidebar-width)]',
          collapsed && 'lg:w-[var(--sidebar-width-collapsed)]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        aria-label="Primary"
      >
        <div className="flex h-[var(--topbar-height)] items-center gap-2 border-b border-sidebar-border px-3">
          <NavLink to="/" className="flex min-w-0 flex-1 items-center gap-2" onClick={onCloseMobile}>
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand text-brand-foreground text-[11px] font-bold"
            >
              P
            </span>
            {!collapsed ? (
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold leading-tight">{siteName}</span>
                <span className="block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                  Network controller
                </span>
              </span>
            ) : null}
          </NavLink>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:hidden"
            aria-label="Close navigation"
            onClick={onCloseMobile}
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="Sections">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onCloseMobile}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
                  isActive
                    ? 'bg-brand/10 text-brand'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                  collapsed && 'lg:justify-center lg:px-0',
                )
              }
            >
              <item.icon className="size-[18px] shrink-0" weight="regular" />
              <span className={cn(collapsed && 'lg:hidden')}>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="hidden border-t border-sidebar-border p-2 lg:block">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
              collapsed && 'justify-center px-0',
            )}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <SidebarSimple className="size-[18px] shrink-0" />
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        </div>
      </aside>
    </>
  )
}
