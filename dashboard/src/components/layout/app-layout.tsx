import { useCallback, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from '@/components/layout/sidebar'
import { DashboardPlainHttpNotice } from '@/components/security/plain-http'
import { Topbar } from '@/components/layout/topbar'
import { cn } from '@/lib/utils'

const COLLAPSED_KEY = 'metricsfe-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * App shell: fixed sidebar (collapsible rail on lg+, drawer below), sticky
 * top bar with global search, and a full-width content area with a 1600px
 * ceiling and 16px gutters.
 */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { pathname } = useLocation()
  // The drawer closes itself on every nav link click (see Sidebar).
  const [mobileOpen, setMobileOpen] = useState(false)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // per-viewer convenience only
      }
      return next
    })
  }, [])

  return (
    <div className="min-h-svh bg-background">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        siteName="Perch"
      />
      <div
        className={cn(
          'flex min-h-svh flex-col transition-[padding] duration-200',
          collapsed ? 'lg:pl-[var(--sidebar-width-collapsed)]' : 'lg:pl-[var(--sidebar-width)]',
        )}
      >
        <Topbar onOpenMobileNav={() => setMobileOpen(true)} />
        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 px-4 py-5">
          {pathname.startsWith('/settings') ? <DashboardPlainHttpNotice /> : null}
          <Outlet />
        </main>
      </div>
    </div>
  )
}
