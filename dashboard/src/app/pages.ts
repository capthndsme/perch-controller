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
  gateway: lazyPage(() => import('@/pages/gateway-page').then((m) => m.GatewayPage)),
  infrastructure: lazyPage(() => import('@/pages/infrastructure-page').then((m) => m.InfrastructurePage)),
  networks: lazyPage(() => import('@/pages/networks-page').then((m) => m.NetworksPage)),
  network: lazyPage(() => import('@/pages/network-page').then((m) => m.NetworkPage)),
  firewall: lazyPage(() => import('@/pages/firewall-page').then((m) => m.FirewallPage)),
  settings: lazyPage(() => import('@/pages/settings-page').then((m) => m.SettingsPage)),
  settingsCollectors: lazyPage(() =>
    import('@/pages/collectors-settings-page').then((m) => m.CollectorsSettingsPage),
  ),
  settingsUsers: lazyPage(() => import('@/pages/settings-users-page').then((m) => m.SettingsUsersPage)),
  settingsHostnameEnrichment: lazyPage(() =>
    import('@/pages/hostname-enrichment-settings-page').then((m) => m.HostnameEnrichmentSettingsPage),
  ),
  settingsPresence: lazyPage(() => import('@/pages/presence-settings-page').then((m) => m.PresenceSettingsPage)),
  settingsGatewayObservation: lazyPage(() =>
    import('@/pages/gateway-observation-settings-page').then((m) => m.GatewayObservationSettingsPage),
  ),
  settingsCharts: lazyPage(() => import('@/pages/chart-settings-page').then((m) => m.ChartSettingsPage)),
  settingsWifiSources: lazyPage(() =>
    import('@/pages/wifi-sources-settings-page').then((m) => m.WifiSourcesSettingsPage),
  ),
  portal: lazyPage(() => import('@/pages/portal-page').then((m) => m.PortalPage)),
  portalDetail: lazyPage(() => import('@/pages/portal-detail-page').then((m) => m.PortalDetailPage)),
  portalVouchers: lazyPage(() => import('@/pages/portal-vouchers-page').then((m) => m.PortalVouchersPage)),
  portalVoucherBatch: lazyPage(() =>
    import('@/pages/portal-voucher-batch-page').then((m) => m.PortalVoucherBatchPage),
  ),
  portalVoucherPrint: lazyPage(() =>
    import('@/pages/portal-voucher-print-page').then((m) => m.PortalVoucherPrintPage),
  ),
  portalPayments: lazyPage(() => import('@/pages/portal-payments-page').then((m) => m.PortalPaymentsPage)),
  portalTerminals: lazyPage(() => import('@/pages/portal-terminals-page').then((m) => m.PortalTerminalsPage)),
  portalPriceTables: lazyPage(() => import('@/pages/portal-price-tables-page').then((m) => m.PortalPriceTablesPage)),
  portalUsers: lazyPage(() => import('@/pages/portal-users-page').then((m) => m.PortalUsersPage)),
  deviceGroups: lazyPage(() => import('@/pages/device-groups-page').then((m) => m.DeviceGroupsPage)),
  deviceGroup: lazyPage(() => import('@/pages/device-group-page').then((m) => m.DeviceGroupPage)),
  settingsDeviceGroups: lazyPage(() =>
    import('@/pages/device-groups-settings-page').then((m) => m.DeviceGroupsSettingsPage),
  ),
  portalApiClients: lazyPage(() => import('@/pages/portal-api-clients-page').then((m) => m.PortalApiClientsPage)),
  portalTemplates: lazyPage(() => import('@/pages/portal-templates-page').then((m) => m.PortalTemplatesPage)),
  portalTemplate: lazyPage(() => import('@/pages/portal-template-page').then((m) => m.PortalTemplatePage)),
  settingsPortal: lazyPage(() => import('@/pages/portal-settings-page').then((m) => m.PortalSettingsPage)),
  shaping: lazyPage(() => import('@/pages/shaping-page').then((m) => m.ShapingPage)),
  settingsTrafficShaping: lazyPage(() => import('@/pages/qos-settings-page').then((m) => m.QosSettingsPage)),
  gatewayConfig: lazyPage(() => import('@/pages/gateway-config-page').then((m) => m.GatewayConfigPage)),
  gatewayConfigDetail: lazyPage(() =>
    import('@/pages/gateway-config-detail-page').then((m) => m.GatewayConfigDetailPage),
  ),
  settingsGatewayConfig: lazyPage(() =>
    import('@/pages/gateway-config-settings-page').then((m) => m.GatewayConfigSettingsPage),
  ),
  gatewayDhcp: lazyPage(() => import('@/pages/gateway-dhcp-page').then((m) => m.GatewayDhcpPage)),
  gatewayDns: lazyPage(() => import('@/pages/gateway-dns-page').then((m) => m.GatewayDnsPage)),
  gatewayRouting: lazyPage(() => import('@/pages/gateway-routing-page').then((m) => m.GatewayRoutingPage)),
  gatewaySystem: lazyPage(() => import('@/pages/gateway-system-page').then((m) => m.GatewaySystemPage)),
  gatewayInternet: lazyPage(() => import('@/pages/gateway-internet-page').then((m) => m.GatewayInternetPage)),
  gatewayVpn: lazyPage(() => import('@/pages/gateway-vpn-page').then((m) => m.GatewayVpnPage)),
  gatewayIpv6: lazyPage(() => import('@/pages/gateway-ipv6-page').then((m) => m.GatewayIpv6Page)),
  settingsGatewaySync: lazyPage(() =>
    import('@/pages/gateway-sync-settings-page').then((m) => m.GatewaySyncSettingsPage),
  ),
  notFound: lazyPage(() => import('@/pages/not-found-page').then((m) => m.NotFoundPage)),
}

export type PageName = keyof typeof pages
