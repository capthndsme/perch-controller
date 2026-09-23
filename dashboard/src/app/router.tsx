import { createBrowserRouter, Navigate } from 'react-router-dom'
import { pages, type PageName } from '@/app/pages'
import type { PageRouteHandle } from '@/app/prefetch'
import { LoginRoute, PageRoute } from '@/app/route-elements'
import { AuthGate } from '@/components/auth/auth-gate'
import { AppLayout } from '@/components/layout/app-layout'
import { RouteError } from '@/components/layout/route-error'
import { SetupGate } from '@/components/setup/setup-gate'

/**
 * A lazily loaded page route. Its own key gives it its own Suspense boundary
 * (see PageRoute); `handle.page` lets prefetch.ts find the chunk behind a link.
 */
function page(name: PageName, options: { fullScreen?: boolean } = {}) {
  return {
    element: <PageRoute key={name} page={pages[name]} fullScreen={options.fullScreen} />,
    handle: { page: pages[name] } satisfies PageRouteHandle,
  }
}

export const router = createBrowserRouter([
  {
    path: '/setup',
    ...page('setup', { fullScreen: true }),
    errorElement: <RouteError fullScreen />,
  },
  {
    path: '/login',
    element: (
      <SetupGate>
        <LoginRoute />
      </SetupGate>
    ),
    handle: { page: pages.login } satisfies PageRouteHandle,
    errorElement: <RouteError fullScreen />,
  },
  {
    path: '/',
    element: (
      <SetupGate>
        <AuthGate>
          <AppLayout />
        </AuthGate>
      </SetupGate>
    ),
    errorElement: <RouteError fullScreen />,
    children: [
      {
        // Pathless, so a page that fails (code that will not load, a render
        // error) is reported inside the shell, which keeps working.
        errorElement: <RouteError />,
        children: [
          { index: true, ...page('dashboard') },
          { path: 'traffic', ...page('traffic') },
          { path: 'usage', ...page('usage') },
          { path: 'devices', ...page('devices') },
          { path: 'devices/:mac', ...page('device') },
          { path: 'servers', ...page('servers') },
          { path: 'wifi', ...page('wifi') },
          { path: 'wifi/ssids/:ssid', ...page('wifiSsid') },
          { path: 'wifi/clients/:mac', ...page('wifiClient') },
          { path: 'wifi/aps/:id', ...page('wifiAp') },
          { path: 'infrastructure', ...page('infrastructure') },
          { path: 'settings', ...page('settings') },
          { path: 'settings/collectors', ...page('settingsCollectors') },
          { path: 'settings/users', ...page('settingsUsers') },
          { path: 'settings/hostname-enrichment', ...page('settingsHostnameEnrichment') },
          { path: 'settings/presence', ...page('settingsPresence') },
          { path: 'settings/wifi-sources', ...page('settingsWifiSources') },
          { path: '*', ...page('notFound') },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])
