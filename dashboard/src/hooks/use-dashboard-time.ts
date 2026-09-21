import { useCallback, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  parseResolutionMode,
  parseWindowFromParams,
  resolveResolution,
  setWindowParams,
  type RefreshInterval,
  type ResolutionMode,
  type TimeWindow,
} from '@/lib/time-window'
import { useAppStore } from '@/stores/app-store'
import {
  apiScopeForDashboard,
  type DashboardScope,
  type TrafficResolution,
  type TrafficScope,
} from '@/types/api'

/**
 * Single owner of the dashboard's time selection. The URL search params
 * (`?range` / `?from&to` / `?res`) are the source of truth so a view is
 * shareable and survives reload — which pairs with the backend's 6h
 * immutable-window cache (a shared absolute range loads from cache). The
 * persisted store mirrors the last choice so a *fresh*, param-less visit
 * restores it instead of snapping to the page default.
 *
 * Replaces the per-page `useState` trio (window / resolutionMode /
 * refreshInterval); `refreshInterval` stays a store-only preference
 * (a shared link shouldn't dictate someone's poll cadence).
 */
export type DashboardTime = {
  window: TimeWindow
  resolutionMode: ResolutionMode
  /** Concrete resolution sent to the API (mode resolved against the window). */
  resolution: TrafficResolution
  refreshInterval: RefreshInterval
  setWindow: (window: TimeWindow) => void
  setResolutionMode: (mode: ResolutionMode) => void
  setRefreshInterval: (interval: RefreshInterval) => void
}

export function useDashboardTime(defaultWindow: TimeWindow): DashboardTime {
  const [searchParams, setSearchParams] = useSearchParams()

  const lastWindow = useAppStore((s) => s.lastWindow)
  const lastResolutionMode = useAppStore((s) => s.lastResolutionMode)
  const refreshInterval = useAppStore((s) => s.refreshInterval)
  const setLastWindow = useAppStore((s) => s.setLastWindow)
  const setLastResolutionMode = useAppStore((s) => s.setLastResolutionMode)
  const setRefreshInterval = useAppStore((s) => s.setRefreshInterval)

  // URL wins; then the last persisted choice; then the page default.
  const window = parseWindowFromParams(searchParams) ?? lastWindow ?? defaultWindow
  const resolutionMode =
    parseResolutionMode(searchParams.get('res')) ?? lastResolutionMode ?? 'auto'

  const resolution = useMemo(
    () => resolveResolution(window, resolutionMode),
    [window, resolutionMode],
  )

  // Populate the URL on first mount (when arriving without params) so the
  // address bar always reproduces what's on screen. `replace` keeps it
  // out of history. Subsequent edits are handled by the setters below.
  useEffect(() => {
    const hasWindow = Boolean(parseWindowFromParams(searchParams))
    const hasRes = Boolean(parseResolutionMode(searchParams.get('res')))
    if (hasWindow && hasRes) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (!parseWindowFromParams(next)) setWindowParams(next, window)
        if (!parseResolutionMode(next.get('res'))) next.set('res', resolutionMode)
        return next
      },
      { replace: true },
    )
    // Mount-only seed — intentionally not reactive to later param changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setWindow = useCallback(
    (next: TimeWindow) => {
      setLastWindow(next)
      // Push (not replace): drag-to-zoom and range changes become
      // back-button-undoable, like Grafana.
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        setWindowParams(params, next)
        return params
      })
    },
    [setSearchParams, setLastWindow],
  )

  const setResolutionMode = useCallback(
    (mode: ResolutionMode) => {
      setLastResolutionMode(mode)
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('res', mode)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams, setLastResolutionMode],
  )

  return {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  }
}

const DASHBOARD_SCOPES: DashboardScope[] = ['all', 'overlay', 'wan', 'lan']

function parseDashboardScope(value: string | null): DashboardScope | null {
  if (value && (DASHBOARD_SCOPES as string[]).includes(value)) {
    return value as DashboardScope
  }
  return null
}

/**
 * Scope bridge: `?scope=` in the URL (for shareability) layered over the
 * sticky persisted preference. A shared link's scope is mirrored into the
 * store so components that read the store directly stay in sync and it
 * becomes the new default once the param is gone. Only the pages that
 * actually show a scope toggle (home, device) call this, so other pages'
 * URLs stay scope-free.
 */
export type DashboardScopeControl = {
  scope: DashboardScope
  apiScope: TrafficScope
  isOverlay: boolean
  setScope: (scope: DashboardScope) => void
}

export function useDashboardScope(): DashboardScopeControl {
  const [searchParams, setSearchParams] = useSearchParams()
  const storedScope = useAppStore((s) => s.dashboardScope)
  const setStoredScope = useAppStore((s) => s.setDashboardScope)

  const urlScope = parseDashboardScope(searchParams.get('scope'))
  const scope = urlScope ?? storedScope

  // Mirror a shared `?scope=` link into the sticky store so store-reading
  // components stay in sync and it becomes the new default.
  useEffect(() => {
    if (urlScope && urlScope !== storedScope) setStoredScope(urlScope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlScope])

  // Seed the param on mount (when arriving without one) so a copied link
  // from a scoped page reproduces the scope too. `replace` keeps history clean.
  useEffect(() => {
    if (urlScope) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('scope', scope)
        return next
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setScope = useCallback(
    (next: DashboardScope) => {
      setStoredScope(next)
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('scope', next)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams, setStoredScope],
  )

  return {
    scope,
    apiScope: apiScopeForDashboard(scope),
    isOverlay: scope === 'overlay',
    setScope,
  }
}
