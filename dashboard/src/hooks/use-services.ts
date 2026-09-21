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
  DeviceServicesResponse,
  ServicesResponse,
  ServiceTrafficResponse,
  TrafficResolution,
} from '@/types/api'

/**
 * "How many GB have my servers pushed" — server-side traffic grouped by TLS
 * SNI / server name. The backend endpoints may not exist yet on an older
 * API build: a 404 is normalised to `null` so pages render an empty state
 * instead of an error.
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

export function useServices(options: {
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
      'services',
      windowKey(options.window),
      options.limit ?? 'default',
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () => fetchOrNull<ServicesResponse>(`/api/v1/services?${params}`),
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
    enabled: options.enabled ?? true,
  })
}

export function useDeviceServices(
  mac: string | undefined,
  options: { window: TimeWindow; limit?: number; refreshInterval?: RefreshInterval },
) {
  const params = new URLSearchParams()
  applyWindowToParams(params, options.window)
  if (options.limit) params.set('limit', String(options.limit))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['devices', mac ?? '', 'services', windowKey(options.window), options.limit ?? 'default'] as const,
    queryFn: () =>
      fetchOrNull<DeviceServicesResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/services?${params}`,
      ),
    enabled: Boolean(mac),
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
  })
}

export function useServiceTraffic(
  serverName: string | undefined,
  options: { window: TimeWindow; resolution: TrafficResolution; refreshInterval?: RefreshInterval },
) {
  const params = new URLSearchParams({ resolution: options.resolution })
  applyWindowToParams(params, options.window)

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'services',
      serverName ?? '',
      'traffic',
      windowKey(options.window),
      options.resolution,
    ] as const,
    queryFn: () =>
      fetchOrNull<ServiceTrafficResponse>(
        `/api/v1/services/${encodeURIComponent(serverName!)}/traffic?${params}`,
      ),
    enabled: Boolean(serverName),
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
  })
}
