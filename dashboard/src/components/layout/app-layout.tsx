import { useCallback, useState } from 'react'
import { Outlet, ScrollRestoration, useLocation, type Location } from 'react-router-dom'
import { GatewayApplyBanner } from '@/components/gateway-config/apply-banner'
import { BottomNav } from '@/components/layout/bottom-nav'
import { GatewaySectionNav } from '@/components/layout/gateway-section-nav'
import { Sidebar } from '@/components/layout/sidebar'
import { DashboardPlainHttpNotice } from '@/components/security/plain-http'
import { Topbar } from '@/components/layout/topbar'
import { inGatewaySection } from '@/lib/nav'
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
 * Scroll positions are remembered per page (path): a new page opens at its
 * top, Back and a tab opened again return to where you were, and a change of
 * the query alone (time window, filters) never scrolls. React Router restores
 * in a layout effect once the route has rendered, so no page paints at the
 * previous page's offset first.
 */
const scrollKey = (location: Location) => location.pathname

/**
 * App shell. On lg+: fixed sidebar (collapsible rail), sticky top bar with
 * global search, and a full-width content area with a 1600px ceiling and
 * 16px gutters. Below lg the sidebar gives way to a bottom tab bar
 * (BottomNav); the content keeps `--bottom-nav-height` free under it.
 */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { pathname } = useLocation()

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
      <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} siteName="Perch" />
      <ScrollRestoration getKey={scrollKey} />
      {/* Takes its new padding in one step; only the fixed rail animates (sidebar.tsx). */}
      <div
        className={cn(
          'flex min-h-svh flex-col',
          collapsed ? 'lg:pl-[var(--sidebar-width-collapsed)]' : 'lg:pl-[var(--sidebar-width)]',
        )}
      >
        <Topbar />
        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 px-4 pt-5 pb-[calc(1.25rem+var(--bottom-nav-height))]">
          {pathname.startsWith('/settings') ? <DashboardPlainHttpNotice /> : null}
          <GatewayApplyBanner />
          {inGatewaySection(pathname) ? <GatewaySectionNav /> : null}
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
