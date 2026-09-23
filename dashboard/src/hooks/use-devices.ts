import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import {
  DEFAULT_DEVICE_WINDOW,
  applyWindowToParams,
  shouldAutoRefresh,
  windowKey,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import type {
  AggregateTrafficResponse,
  DeviceOverviewResponse,
  DevicePeersResponse,
  DevicePresenceResponse,
  DeviceSummary,
  DeviceTrafficResponse,
  PeerScope,
  ProtocolsResponse,
  ProtocolTopDevicesResponse,
  TopTrafficRank,
  TopTrafficResponse,
  TrafficResolution,
  TrafficScope,
} from '@/types/api'

export const devicesQueryKey = ['devices'] as const

export function devicesIndexQueryKey(window: TimeWindow, collectorId?: number) {
  return [...devicesQueryKey, 'index', windowKey(window), collectorId ?? 'all'] as const
}

/**
 * Lists devices that had traffic in `window`, sorted by their windowed
 * byte total. The byte counters on each row are summed across the same
 * window so the "Total" column on the devices table is comparable to
 * `/api/v1/protocols` (which sums the same window); the `mbps*` columns
 * stay rate-like (latest in-window bucket / collector poll interval).
 *
 * Callers that omit `window` (e.g. legacy sidebars) get the default 1 h
 * range the backend falls back to.
 */
export function useDevices(
  options: {
    window?: TimeWindow
    collectorId?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  } = {},
) {
  const window = options.window
  const params = new URLSearchParams()
  if (window) applyWindowToParams(params, window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: devicesIndexQueryKey(window ?? DEFAULT_DEVICE_WINDOW, options.collectorId),
    queryFn: () => apiFetch<DeviceSummary[]>(`/api/v1/devices${query}`),
    refetchInterval: window
      ? effectiveRefreshInterval(window, options.refreshInterval, 15_000)
      : 15_000,
    enabled: options.enabled ?? true,
  })
}

/**
 * Pick a react-query `refetchInterval` for a given window + user
 * preference. Absolute windows pin to "no auto-refresh" because the
 * data they represent has already happened; nothing to update.
 * Relative windows honour the user's RefreshInterval (or fall back to
 * the supplied default when null).
 */
function effectiveRefreshInterval(
  window: TimeWindow,
  override: RefreshInterval | undefined,
  fallback: number,
): number | false {
  if (!shouldAutoRefresh(window)) return false
  if (override === null) return false
  return override ?? fallback
}

export function aggregateTrafficQueryKey(
  window: TimeWindow,
  resolution: TrafficResolution,
  scope: TrafficScope,
  collectorId?: number,
) {
  return ['traffic', windowKey(window), resolution, scope, collectorId ?? 'all'] as const
}

export function useAggregateTraffic(
  options: {
    window: TimeWindow
    resolution: TrafficResolution
    scope?: TrafficScope
    collectorId?: number
    refreshInterval?: RefreshInterval
    /**
     * When `false`, suppresses the network call entirely. Used by the
     * dashboard's LAN-overlay toggle so a second `?scope=lan` query is
     * only fired when the overlay is actually on screen.
     */
    enabled?: boolean
  },
) {
  const { window, resolution } = options
  const scope = options.scope ?? 'all'
  const params = new URLSearchParams({ resolution, scope })
  applyWindowToParams(params, window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: aggregateTrafficQueryKey(window, resolution, scope, options.collectorId),
    queryFn: () => apiFetch<AggregateTrafficResponse>(`/api/v1/traffic?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 5_000),
    enabled: options.enabled ?? true,
  })
}

/**
 * Top-N devices by bytes in the window as separate rate series, plus the
 * rest folded into one — the Devices page "top talkers over time" stack.
 */
export function useTopTraffic(options: {
  window: TimeWindow
  resolution: TrafficResolution
  scope?: TrafficScope
  limit?: number
  by?: TopTrafficRank
  collectorId?: number
  refreshInterval?: RefreshInterval
  enabled?: boolean
}) {
  const { window, resolution } = options
  const scope = options.scope ?? 'all'
  const limit = options.limit ?? 5
  const by = options.by ?? 'total'
  const params = new URLSearchParams({ resolution, scope, limit: String(limit), by })
  applyWindowToParams(params, window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'traffic',
      'top',
      windowKey(window),
      resolution,
      scope,
      limit,
      by,
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () => apiFetch<TopTrafficResponse>(`/api/v1/traffic/top?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 5_000),
    enabled: options.enabled ?? true,
  })
}

export function deviceTrafficQueryKey(
  mac: string,
  window: TimeWindow,
  resolution: TrafficResolution,
  scope: TrafficScope,
  collectorId?: number,
) {
  return [
    'devices',
    mac,
    'traffic',
    windowKey(window),
    resolution,
    scope,
    collectorId ?? 'all',
  ] as const
}

export function useDeviceTraffic(
  mac: string | undefined,
  options: {
    window: TimeWindow
    resolution: TrafficResolution
    scope?: TrafficScope
    collectorId?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  },
) {
  const { window, resolution } = options
  const scope = options.scope ?? 'all'
  const collectorId = options.collectorId

  const params = new URLSearchParams({ resolution, scope })
  applyWindowToParams(params, window)
  if (collectorId) params.set('collectorId', String(collectorId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: deviceTrafficQueryKey(mac ?? '', window, resolution, scope, collectorId),
    queryFn: () =>
      apiFetch<DeviceTrafficResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/traffic?${params}`,
      ),
    enabled: Boolean(mac) && (options.enabled ?? true),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}

export function deviceOverviewQueryKey(
  mac: string,
  window: TimeWindow,
  resolution: TrafficResolution,
  scope: TrafficScope,
  collectorId?: number,
) {
  return [
    'devices',
    mac,
    'overview',
    windowKey(window),
    resolution,
    scope,
    collectorId ?? 'all',
  ] as const
}

export function useDeviceOverview(
  mac: string | undefined,
  options: {
    window: TimeWindow
    resolution: TrafficResolution
    scope?: TrafficScope
    collectorId?: number
    refreshInterval?: RefreshInterval
    /**
     * Optional gate on top of `mac` presence. The hook always disables
     * itself when `mac` is undefined; passing `enabled: false` lets the
     * caller add an extra reason (e.g. "overlay toggle is off") without
     * setting `mac` to undefined and losing the cache entry.
     */
    enabled?: boolean
  },
) {
  const { window, resolution } = options
  const scope = options.scope ?? 'all'
  const params = new URLSearchParams({ resolution, scope })
  applyWindowToParams(params, window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: deviceOverviewQueryKey(mac ?? '', window, resolution, scope, options.collectorId),
    queryFn: () =>
      apiFetch<DeviceOverviewResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/overview?${params}`,
      ),
    enabled: Boolean(mac) && (options.enabled ?? true),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}

export function devicePresenceQueryKey(mac: string) {
  return ['devices', mac, 'presence'] as const
}

/**
 * Whether the device is connected right now, and how, whichever collector saw
 * it, plus where it is on the network map (A4 `attachment`). Presence
 * describes now, so it polls whatever window the page shows, including a
 * zoomed one that has stopped the window-bound queries.
 */
export function useDevicePresence(mac: string | undefined) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: devicePresenceQueryKey(mac ?? ''),
    queryFn: () =>
      apiFetch<DevicePresenceResponse>(`/api/v1/devices/${encodeURIComponent(mac!)}/presence`),
    enabled: Boolean(mac),
    refetchInterval: 10_000,
  })
}

export function devicePeersQueryKey(mac: string, scope: PeerScope, collectorId?: number) {
  return ['devices', mac, 'peers', scope, collectorId ?? 'all'] as const
}

export function useDevicePeers(
  mac: string | undefined,
  scope: PeerScope,
  collectorId?: number,
) {
  const params = new URLSearchParams({ scope })
  if (collectorId) params.set('collectorId', String(collectorId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: devicePeersQueryKey(mac ?? '', scope, collectorId),
    queryFn: () =>
      apiFetch<DevicePeersResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/peers?${params}`,
      ),
    enabled: Boolean(mac),
    refetchInterval: 30_000,
  })
}

export function aggregateProtocolsQueryKey(
  window: TimeWindow,
  resolution: TrafficResolution,
  collectorId?: number,
) {
  return ['protocols', windowKey(window), resolution, collectorId ?? 'all'] as const
}

export function useAggregateProtocols(
  options: {
    window: TimeWindow
    resolution: TrafficResolution
    collectorId?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  },
) {
  const { window, resolution } = options
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: aggregateProtocolsQueryKey(window, resolution, options.collectorId),
    queryFn: () => apiFetch<ProtocolsResponse>(`/api/v1/protocols?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
    enabled: options.enabled ?? true,
  })
}

export function protocolTopDevicesQueryKey(
  protocol: string,
  window: TimeWindow,
  collectorId?: number,
  limit?: number,
) {
  return [
    'protocols',
    protocol,
    'devices',
    windowKey(window),
    collectorId ?? 'all',
    limit ?? 'default',
  ] as const
}

export function useProtocolTopDevices(
  protocol: string,
  options: {
    window: TimeWindow
    collectorId?: number
    limit?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  },
) {
  const params = new URLSearchParams()
  applyWindowToParams(params, options.window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))
  if (options.limit) params.set('limit', String(options.limit))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: protocolTopDevicesQueryKey(
      protocol,
      options.window,
      options.collectorId,
      options.limit,
    ),
    queryFn: () =>
      apiFetch<ProtocolTopDevicesResponse>(
        `/api/v1/protocols/${encodeURIComponent(protocol)}/devices?${params}`,
      ),
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 10_000),
    enabled: options.enabled ?? true,
  })
}

export function deviceProtocolsQueryKey(
  mac: string,
  window: TimeWindow,
  resolution: TrafficResolution,
  collectorId?: number,
) {
  return [
    'devices',
    mac,
    'protocols',
    windowKey(window),
    resolution,
    collectorId ?? 'all',
  ] as const
}

export function useDeviceProtocols(
  mac: string | undefined,
  options: {
    window: TimeWindow
    resolution: TrafficResolution
    collectorId?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  },
) {
  const { window, resolution } = options
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: deviceProtocolsQueryKey(mac ?? '', window, resolution, options.collectorId),
    queryFn: () =>
      apiFetch<ProtocolsResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/protocols?${params}`,
      ),
    enabled: Boolean(mac) && (options.enabled ?? true),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}
