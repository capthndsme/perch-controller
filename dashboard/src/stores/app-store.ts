import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  DEFAULT_AGGREGATE_WINDOW,
  type RefreshInterval,
  type ResolutionMode,
  type TimeWindow,
} from '@/lib/time-window'
import type { DashboardScope } from '@/types/api'

export type Theme = 'light' | 'dark' | 'system'

interface AppState {
  theme: Theme
  /**
   * Dashboard-wide scope filter for traffic charts/tiles. Persisted so the
   * "WAN only" preference survives a refresh — it's typically a setting,
   * not a per-session toggle. `'overlay'` is the default because most
   * users want WAN-as-primary with the LAN context visible alongside.
   */
  dashboardScope: DashboardScope
  /**
   * Last time-selection the user looked at. The URL is the source of
   * truth for an open page (so views are shareable + survive reload), but
   * these mirror the last choice so a *fresh* param-less visit restores
   * it instead of snapping back to the page default. `useDashboardTime`
   * reads URL-first and falls back to these.
   */
  lastWindow: TimeWindow
  lastResolutionMode: ResolutionMode
  /** Auto-refresh cadence — a personal preference, kept out of the URL. */
  refreshInterval: RefreshInterval
  setTheme: (theme: Theme) => void
  setDashboardScope: (scope: DashboardScope) => void
  setLastWindow: (window: TimeWindow) => void
  setLastResolutionMode: (mode: ResolutionMode) => void
  setRefreshInterval: (interval: RefreshInterval) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'system',
      dashboardScope: 'overlay',
      lastWindow: DEFAULT_AGGREGATE_WINDOW,
      lastResolutionMode: 'auto',
      refreshInterval: 5_000,
      setTheme: (theme) => set({ theme }),
      setDashboardScope: (dashboardScope) => set({ dashboardScope }),
      setLastWindow: (lastWindow) => set({ lastWindow }),
      setLastResolutionMode: (lastResolutionMode) => set({ lastResolutionMode }),
      setRefreshInterval: (refreshInterval) => set({ refreshInterval }),
    }),
    {
      name: 'metricsfe-app',
      version: 2,
      // v1 stored `dashboardScope: TrafficScope` and a separate
      // `dashboardOverlayLan` boolean. v2 collapses them into a single
      // 4-way `DashboardScope`. If the persisted value is `'all' |
      // 'wan' | 'lan'`, keep it; if `dashboardOverlayLan` was on, the
      // user had effectively asked for overlay — promote them.
      migrate: (persisted: unknown, version) => {
        if (
          version < 2 &&
          persisted &&
          typeof persisted === 'object' &&
          'dashboardScope' in persisted
        ) {
          const legacy = persisted as {
            dashboardScope?: string
            dashboardOverlayLan?: boolean
          }
          if (legacy.dashboardOverlayLan && legacy.dashboardScope !== 'lan') {
            return { ...legacy, dashboardScope: 'overlay' as DashboardScope }
          }
        }
        return persisted as AppState
      },
    },
  ),
)
