import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import {
  applyWindowToParams,
  shouldAutoRefresh,
  windowKey,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import type { DevicePeerHistoryResponse, PeerScope, TopPeersResponse } from '@/types/api'

function effectiveRefreshInterval(
  window: TimeWindow,
  override: RefreshInterval | undefined,
  fallback: number,
): number | false {
  if (!shouldAutoRefresh(window)) return false
  if (override === null) return false
  return override ?? fallback
}

/**
 * Network-wide "where is the traffic going": top peer IPs (and ASNs for WAN)
 * across every device inside the window, from the hourly peer history.
 */
export function useTopPeers(options: {
  window: TimeWindow
  scope: PeerScope
  limit?: number
  collectorId?: number
  refreshInterval?: RefreshInterval
  enabled?: boolean
}) {
  const params = new URLSearchParams({ scope: options.scope })
  applyWindowToParams(params, options.window)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'peers',
      'top',
      options.scope,
      windowKey(options.window),
      options.limit ?? 'default',
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () => apiFetch<TopPeersResponse>(`/api/v1/peers/top?${params}`),
    // Hourly history only changes once an hour; a minute is plenty.
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
    enabled: options.enabled ?? true,
  })
}

/** The same view for one device: who it talked to inside the window. */
export function useDevicePeerHistory(
  mac: string | undefined,
  options: {
    window: TimeWindow
    scope: PeerScope
    limit?: number
    collectorId?: number
    refreshInterval?: RefreshInterval
    enabled?: boolean
  },
) {
  const params = new URLSearchParams({ scope: options.scope })
  applyWindowToParams(params, options.window)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.collectorId) params.set('collectorId', String(options.collectorId))

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'devices',
      mac ?? '',
      'peers-history',
      options.scope,
      windowKey(options.window),
      options.limit ?? 'default',
      options.collectorId ?? 'all',
    ] as const,
    queryFn: () =>
      apiFetch<DevicePeerHistoryResponse>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/peers/history?${params}`,
      ),
    enabled: Boolean(mac) && (options.enabled ?? true),
    refetchInterval: effectiveRefreshInterval(options.window, options.refreshInterval, 60_000),
  })
}
