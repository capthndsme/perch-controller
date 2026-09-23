import { lazyPage } from '@/app/lazy-page'

/**
 * Every page is its own chunk, fetched when its route first renders or earlier
 * (see prefetch.ts). The shell (setup and session gates, layout, sidebar, top
 * bar) stays in the entry chunk. Shared vendor code (React and the router,
 * TanStack Query, Radix, Recharts with d3) is split into long-cached chunks in
 * vite.config.ts, so Recharts only loads with pages that draw charts, and
 * @xyflow/react with dagre only with the infrastructure page.
 */
export const pages = {
  login: lazyPage(() => import('@/pages/login-page').then((m) => m.LoginPage)),
  setup: lazyPage(() => import('@/pages/setup-page').then((m) => m.SetupPage)),
  dashboard: lazyPage(() => import('@/pages/dashboard-page').then((m) => m.DashboardPage)),
  traffic: lazyPage(() => import('@/pages/traffic-page').then((m) => m.TrafficPage)),
  usage: lazyPage(() => import('@/pages/usage-page').then((m) => m.UsagePage)),
  devices: lazyPage(() => import('@/pages/devices-page').then((m) => m.DevicesPage)),
  device: lazyPage(() => import('@/pages/device-page').then((m) => m.DevicePage)),
  servers: lazyPage(() => import('@/pages/servers-page').then((m) => m.ServersPage)),
  wifi: lazyPage(() => import('@/pages/wifi-page').then((m) => m.WifiPage)),
  wifiSsid: lazyPage(() => import('@/pages/wifi-ssid-page').then((m) => m.WifiSsidPage)),
  wifiClient: lazyPage(() => import('@/pages/wifi-client-page').then((m) => m.WifiClientPage)),
  wifiAp: lazyPage(() => import('@/pages/wifi-ap-page').then((m) => m.WifiApPage)),
  infrastructure: lazyPage(() => import('@/pages/infrastructure-page').then((m) => m.InfrastructurePage)),
  settings: lazyPage(() => import('@/pages/settings-page').then((m) => m.SettingsPage)),
  settingsCollectors: lazyPage(() =>
    import('@/pages/collectors-settings-page').then((m) => m.CollectorsSettingsPage),
  ),
  settingsUsers: lazyPage(() => import('@/pages/settings-users-page').then((m) => m.SettingsUsersPage)),
  settingsHostnameEnrichment: lazyPage(() =>
    import('@/pages/hostname-enrichment-settings-page').then((m) => m.HostnameEnrichmentSettingsPage),
  ),
  settingsPresence: lazyPage(() => import('@/pages/presence-settings-page').then((m) => m.PresenceSettingsPage)),
  settingsWifiSources: lazyPage(() =>
    import('@/pages/wifi-sources-settings-page').then((m) => m.WifiSourcesSettingsPage),
  ),
  notFound: lazyPage(() => import('@/pages/not-found-page').then((m) => m.NotFoundPage)),
}

export type PageName = keyof typeof pages
