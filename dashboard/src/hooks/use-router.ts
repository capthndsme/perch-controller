import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import {
  applyWindowToParams,
  shouldAutoRefresh,
  windowKey,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import type { RouterResolutionRequest, RouterResponse } from '@/types/api'

/**
 * Gateway health as the collector on the edge router reports it, one sample
 * every 30 s: conntrack table fill, established TCP, load, memory and the WAN
 * rate as the router itself sees it. `source: null` / `latest: null` are
 * normal states (no collector on the router, nothing reported yet), not errors.
 */
export function useRouter(options: {
  window: TimeWindow
  resolution?: RouterResolutionRequest
  refreshInterval?: RefreshInterval
  enabled?: boolean
}) {
  const params = new URLSearchParams({ resolution: options.resolution ?? 'auto' })
  applyWindowToParams(params, options.window)

  const refetchInterval =
    !shouldAutoRefresh(options.window) || options.refreshInterval === null
      ? false
      : Math.max(options.refreshInterval ?? 30_000, 30_000)

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['router', windowKey(options.window), options.resolution ?? 'auto'] as const,
    queryFn: () => apiFetch<RouterResponse>(`/api/v1/router?${params}`),
    // A new sample lands every 30 s; polling faster only re-reads the same row.
    refetchInterval,
    enabled: options.enabled ?? true,
  })
}
