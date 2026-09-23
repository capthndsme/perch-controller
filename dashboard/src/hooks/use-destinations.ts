import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'
import {
  applyWindowToParams,
  shouldAutoRefresh,
  windowKey,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import type {
  DestinationsResponse,
  DestinationTrafficResponse,
  DeviceDestinationsResponse,
} from '@/types/api'

/**
 * "Where is the traffic going", by name: WAN destinations keyed by the TLS
 * SNI / HTTP Host a device asked for, grouped by registered domain, with
 * nDPI's application category. Hourly history, like peers and services.
 *
 * A 404 (older API build, or a MAC that never had a destination row) is
 * normalised to `null` so pages render an empty state instead of an error.
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

async function fetchOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export function useDestinations(options: {
  window: TimeWindow
  limit?: number
  collectorId?: number
  refreshInterval?: RefreshInterval
  enabled?: boolean
}) {
  const params = new URLSearchParams()
  applyWindowToParams(params, options.window)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'destinations',
      windowKey(options.window),
      options.limit ?? 'default',
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () => fetchOrNull<DestinationsResponse>(`/api/v1/destinations?${params}`),
    // Hourly history only changes once an hour; a minute is plenty.
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
    enabled: options.enabled ?? true,
  })
}

export function useDeviceDestinations(
  mac: string | undefined,
  options: {
    window: TimeWindow
    limit?: number
    collectorId?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  },
) {
  const params = new URLSearchParams()
  applyWindowToParams(params, options.window)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'devices',
      mac ?? '',
      'destinations',
      windowKey(options.window),
      options.limit ?? 'default',
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () =>
      fetchOrNull<DeviceDestinationsResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/destinations?${params}`,
      ),
    enabled: Boolean(mac) && (options.enabled ?? true),
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
  })
}

export function useDestinationTraffic(
  serverName: string | undefined,
  options: {
    window: TimeWindow
    /** Finest bucket wanted; omitted = the server's automatic choice (hourly at best). */
    resolution?: string
    collectorId?: number
    refreshInterval?: RefreshInterval
  },
) {
  const params = new URLSearchParams()
  if (options.resolution) params.set('resolution', options.resolution)
  applyWindowToParams(params, options.window)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'destinations',
      serverName ?? '',
      'traffic',
      windowKey(options.window),
      options.resolution ?? 'auto',
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () =>
      fetchOrNull<DestinationTrafficResponse>(
        `/api/v1/destinations/${encodeURIComponent(serverName!)}/traffic?${params}`,
      ),
    enabled: Boolean(serverName),
    // Hourly data: the open bucket moves at most once a minute.
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
  })
}
