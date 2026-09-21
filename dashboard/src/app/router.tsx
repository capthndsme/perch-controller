import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AuthGate } from '@/components/auth/auth-gate'
import { SetupGate } from '@/components/setup/setup-gate'
import { AppLayout } from '@/components/layout/app-layout'
import { CollectorsSettingsPage } from '@/pages/collectors-settings-page'
import { DashboardPage } from '@/pages/dashboard-page'
import { DevicePage } from '@/pages/device-page'
import { DevicesPage } from '@/pages/devices-page'
import { HostnameEnrichmentSettingsPage } from '@/pages/hostname-enrichment-settings-page'
import { LoginRoute } from '@/pages/login-page'
import { NotFoundPage } from '@/pages/not-found-page'
import { ServersPage } from '@/pages/servers-page'
import { SettingsPage } from '@/pages/settings-page'
import { SettingsUsersPage } from '@/pages/settings-users-page'
import { SetupPage } from '@/pages/setup-page'
import { TrafficPage } from '@/pages/traffic-page'
import { UsagePage } from '@/pages/usage-page'
import { WifiApPage } from '@/pages/wifi-ap-page'
import { WifiClientPage } from '@/pages/wifi-client-page'
import { WifiPage } from '@/pages/wifi-page'
import { WifiSourcesSettingsPage } from '@/pages/wifi-sources-settings-page'
import { WifiSsidPage } from '@/pages/wifi-ssid-page'

export const router = createBrowserRouter([
  {
    path: '/setup',
    element: <SetupPage />,
  },
  {
    path: '/login',
    element: (
      <SetupGate>
        <LoginRoute />
      </SetupGate>
    ),
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
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'traffic', element: <TrafficPage /> },
      { path: 'usage', element: <UsagePage /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'devices/:mac', element: <DevicePage /> },
      { path: 'servers', element: <ServersPage /> },
      { path: 'wifi', element: <WifiPage /> },
      { path: 'wifi/ssids/:ssid', element: <WifiSsidPage /> },
      { path: 'wifi/clients/:mac', element: <WifiClientPage /> },
      { path: 'wifi/aps/:id', element: <WifiApPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/collectors', element: <CollectorsSettingsPage /> },
      { path: 'settings/users', element: <SettingsUsersPage /> },
      { path: 'settings/hostname-enrichment', element: <HostnameEnrichmentSettingsPage /> },
      { path: 'settings/wifi-sources', element: <WifiSourcesSettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])
