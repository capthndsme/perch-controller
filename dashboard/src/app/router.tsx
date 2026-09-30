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
    // The voucher print sheet: signed in, but outside the shell (nothing but cards on paper).
    path: '/portal/vouchers/:id/print',
    element: (
      <SetupGate>
        <AuthGate>
          <PageRoute key="portalVoucherPrint" page={pages.portalVoucherPrint} fullScreen />
        </AuthGate>
      </SetupGate>
    ),
    handle: { page: pages.portalVoucherPrint } satisfies PageRouteHandle,
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
          { path: 'gateway', ...page('gateway') },
          { path: 'infrastructure', ...page('infrastructure') },
          { path: 'portal', ...page('portal') },
          { path: 'portal/portals/:id', ...page('portalDetail') },
          { path: 'portal/vouchers', ...page('portalVouchers') },
          { path: 'portal/vouchers/:id', ...page('portalVoucherBatch') },
          { path: 'portal/payments', ...page('portalPayments') },
          { path: 'portal/terminals', ...page('portalTerminals') },
          { path: 'portal/price-tables', ...page('portalPriceTables') },
          { path: 'portal/users', ...page('portalUsers') },
          { path: 'portal/api-clients', ...page('portalApiClients') },
          { path: 'portal/templates', ...page('portalTemplates') },
          { path: 'portal/templates/:id', ...page('portalTemplate') },
          { path: 'networks', ...page('networks') },
          { path: 'groups', ...page('deviceGroups') },
          { path: 'groups/:id', ...page('deviceGroup') },
          { path: 'networks/:gatewayId/:networkId', ...page('network') },
          { path: 'firewall', ...page('firewall') },
          { path: 'settings', ...page('settings') },
          { path: 'settings/collectors', ...page('settingsCollectors') },
          { path: 'settings/users', ...page('settingsUsers') },
          { path: 'settings/hostname-enrichment', ...page('settingsHostnameEnrichment') },
          { path: 'settings/presence', ...page('settingsPresence') },
          { path: 'settings/charts', ...page('settingsCharts') },
          { path: 'settings/gateway-observation', ...page('settingsGatewayObservation') },
          { path: 'settings/wifi-sources', ...page('settingsWifiSources') },
          { path: 'settings/portal', ...page('settingsPortal') },
          { path: 'settings/device-groups', ...page('settingsDeviceGroups') },
          { path: 'shaping', ...page('shaping') },
          { path: 'settings/traffic-shaping', ...page('settingsTrafficShaping') },
          { path: 'gateway/config', ...page('gatewayConfig') },
          { path: 'gateway/config/:id', ...page('gatewayConfigDetail') },
          { path: 'gateway/dhcp', ...page('gatewayDhcp') },
          { path: 'gateway/dns', ...page('gatewayDns') },
          { path: 'gateway/routing', ...page('gatewayRouting') },
          { path: 'gateway/system', ...page('gatewaySystem') },
          { path: 'gateway/internet', ...page('gatewayInternet') },
          { path: 'gateway/vpn', ...page('gatewayVpn') },
          { path: 'gateway/ipv6', ...page('gatewayIpv6') },
          { path: 'settings/gateway-config', ...page('settingsGatewayConfig') },
          { path: 'alerts', ...page('alerts') },
          { path: 'alerts/:id', ...page('alert') },
          { path: 'settings/alerts', ...page('settingsAlerts') },
          { path: 'settings/notifications', ...page('settingsNotifications') },
          { path: 'settings/gateway-sync', ...page('settingsGatewaySync') },
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
