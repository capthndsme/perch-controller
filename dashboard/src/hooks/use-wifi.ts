import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'
import {
  DEFAULT_DEVICE_WINDOW,
  applyWindowToParams,
  shouldAutoRefresh,
  windowKey,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import type {
  TrafficResolution,
  WifiApHealthResponse,
  WifiApThroughputResponse,
  WifiClientDetailResponse,
  WifiClientSignalResponse,
  WifiClientSummary,
  WifiOverviewResponse,
  WifiRfEntry,
  WifiRfHistoryResponse,
  WifiSsidClientsResponse,
  WifiSsidThroughputResponse,
  WifiSource,
  WifiSourceStatus,
  WifiSsidsResponse,
  WifiClientsHistoryResponse,
  WifiKickResponse,
  WifiLocateResponse,
  WifiRebootResponse,
  WifiSteerResponse,
} from '@/types/api'

/**
 * The wifi API's resolution ladder stops at `1h`; the page-level auto
 * resolution can reach `1d` on multi-month windows. Send `1h` instead (the
 * API coarsens as needed and echoes the grain it used).
 */
function toWifiResolution(resolution: TrafficResolution): TrafficResolution {
  return resolution === '1d' ? '1h' : resolution
}

export const wifiQueryKey = ['wifi'] as const
export const wifiSourcesQueryKey = ['settings', 'wifi-sources'] as const

function effectiveRefreshInterval(
  window: TimeWindow,
  override: RefreshInterval | undefined,
  fallback: number
): number | false {
  if (!shouldAutoRefresh(window)) return false
  if (override === null) return false
  return override ?? fallback
}

export function useWifiOverview(options: {
  window?: TimeWindow
  apId?: number
  refreshInterval?: RefreshInterval
  enabled?: boolean
} = {}) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const params = new URLSearchParams()
  applyWindowToParams(params, window)
  if (options.apId) params.set('apId', String(options.apId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'overview', windowKey(window), options.apId ?? 'all'] as const,
    queryFn: () => apiFetch<WifiOverviewResponse>(`/api/v1/wifi/overview?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
    enabled: options.enabled ?? true,
  })
}

export function useWifiSsids(options: {
  window?: TimeWindow
  apId?: number
  refreshInterval?: RefreshInterval
} = {}) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const params = new URLSearchParams()
  applyWindowToParams(params, window)
  if (options.apId) params.set('apId', String(options.apId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'ssids', windowKey(window), options.apId ?? 'all'] as const,
    queryFn: () => apiFetch<WifiSsidsResponse>(`/api/v1/wifi/ssids?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}

export function useWifiSsidClients(ssid: string | undefined, options: { apId?: number } = {}) {
  const params = new URLSearchParams()
  if (options.apId) params.set('apId', String(options.apId))
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'ssid-clients', ssid ?? '', options.apId ?? 'all'] as const,
    queryFn: () =>
      apiFetch<WifiSsidClientsResponse>(
        `/api/v1/wifi/ssids/${encodeURIComponent(ssid!)}/clients${query}`
      ),
    enabled: Boolean(ssid),
    refetchInterval: 10_000,
  })
}

export function useWifiSsidThroughput(
  ssid: string | undefined,
  options: {
    window?: TimeWindow
    apId?: number
    resolution?: TrafficResolution
    refreshInterval?: RefreshInterval
  } = {}
) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const resolution = toWifiResolution(options.resolution ?? '1m')
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)
  if (options.apId) params.set('apId', String(options.apId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [
      ...wifiQueryKey,
      'ssid-throughput',
      ssid ?? '',
      windowKey(window),
      resolution,
      options.apId ?? 'all',
    ] as const,
    queryFn: () =>
      apiFetch<WifiSsidThroughputResponse>(
        `/api/v1/wifi/ssids/${encodeURIComponent(ssid!)}/throughput?${params}`
      ),
    enabled: Boolean(ssid),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}

export function useWifiClients(options: {
  apId?: number
  activeOnly?: boolean
  refreshInterval?: RefreshInterval
  enabled?: boolean
} = {}) {
  const params = new URLSearchParams()
  if (options.apId) params.set('apId', String(options.apId))
  if (options.activeOnly) params.set('activeOnly', 'true')
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [
      ...wifiQueryKey,
      'clients',
      options.apId ?? 'all',
      options.activeOnly ? 'active' : 'all',
    ] as const,
    queryFn: () => apiFetch<WifiClientSummary[]>(`/api/v1/wifi/clients${query}`),
    refetchInterval: options.refreshInterval ?? 10_000,
    enabled: options.enabled ?? true,
  })
}

/**
 * Per-AP client throughput history. The wifi resolution ladder stops at
 * `1h`, so a `1d` page resolution is sent as `1h` (the API coarsens
 * further on its own and echoes what it used).
 */
export function useWifiApThroughput(options: {
  window?: TimeWindow
  resolution?: TrafficResolution
  refreshInterval?: RefreshInterval
} = {}) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const resolution = toWifiResolution(options.resolution ?? '1m')
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'ap-throughput', windowKey(window), resolution] as const,
    queryFn: () => apiFetch<WifiApThroughputResponse>(`/api/v1/wifi/aps/throughput?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}

export function useWifiClientsHistory(options: {
  window?: TimeWindow
  apId?: number
  resolution?: TrafficResolution
  refreshInterval?: RefreshInterval
} = {}) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const resolution = toWifiResolution(options.resolution ?? '5m')
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)
  if (options.apId) params.set('apId', String(options.apId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [
      ...wifiQueryKey,
      'clients-history',
      windowKey(window),
      resolution,
      options.apId ?? 'all',
    ] as const,
    queryFn: () =>
      apiFetch<WifiClientsHistoryResponse>(`/api/v1/wifi/clients/history?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}


/**
 * A client's last AP report and its 30 latest roams. A 404 means no AP has
 * listed the MAC (in the 14 days the latest reports are kept).
 * `refetchInterval` defaults to 10 s; `retryNotFound: false` takes the 404 as
 * the answer instead of asking again.
 */
export function useWifiClient(
  mac: string | undefined,
  options: { refetchInterval?: number | false; retryNotFound?: boolean } = {},
) {
  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'client', mac ?? ''] as const,
    queryFn: () => apiFetch<WifiClientDetailResponse>(`/api/v1/wifi/clients/${encodeURIComponent(mac!)}`),
    enabled: Boolean(mac),
    refetchInterval: options.refetchInterval ?? 10_000,
    ...(options.retryNotFound === false ? { retry: retryUnlessNotFound } : {}),
  })
}

/** For queries whose 404 is an answer ("never seen"): no second try on it, one on anything else. */
export function retryUnlessNotFound(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status === 404) return false
  return failureCount < 1
}

export function useWifiClientSignal(
  mac: string | undefined,
  options: {
    window?: TimeWindow
    apId?: number
    resolution?: TrafficResolution
    refreshInterval?: RefreshInterval
  } = {}
) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const resolution = toWifiResolution(options.resolution ?? '1m')
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)
  if (options.apId) params.set('apId', String(options.apId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [
      ...wifiQueryKey,
      'client-signal',
      mac ?? '',
      windowKey(window),
      resolution,
      options.apId ?? 'all',
    ] as const,
    queryFn: () =>
      apiFetch<WifiClientSignalResponse>(
        `/api/v1/wifi/clients/${encodeURIComponent(mac!)}/signal?${params}`
      ),
    enabled: Boolean(mac),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 10_000),
  })
}

export function useWifiRf(options: { apId?: number; refreshInterval?: RefreshInterval } = {}) {
  const params = new URLSearchParams()
  if (options.apId) params.set('apId', String(options.apId))
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'rf', options.apId ?? 'all'] as const,
    queryFn: () => apiFetch<WifiRfEntry[]>(`/api/v1/wifi/rf${query}`),
    refetchInterval: options.refreshInterval ?? 15_000,
  })
}

export function useWifiRfHistory(options: {
  window?: TimeWindow
  apId?: number
  refreshInterval?: RefreshInterval
} = {}) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const params = new URLSearchParams()
  applyWindowToParams(params, window)
  if (options.apId) params.set('apId', String(options.apId))

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'rf-history', windowKey(window), options.apId ?? 'all'] as const,
    queryFn: () => apiFetch<WifiRfHistoryResponse>(`/api/v1/wifi/rf/history?${params}`),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 15_000),
  })
}

export function useWifiAps(options: {
  includeDisabled?: boolean
  refreshInterval?: RefreshInterval
} = {}) {
  const params = new URLSearchParams()
  if (options.includeDisabled) params.set('includeDisabled', 'true')
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'aps', options.includeDisabled ? 'with-disabled' : 'enabled'] as const,
    queryFn: () => apiFetch<WifiOverviewResponse['accessPoints']>(`/api/v1/wifi/aps${query}`),
    refetchInterval: options.refreshInterval ?? 15_000,
  })
}

export function useWifiApHealth(
  apId: number | undefined,
  options: {
    window?: TimeWindow
    resolution?: TrafficResolution
    refreshInterval?: RefreshInterval
    enabled?: boolean
  } = {}
) {
  const window = options.window ?? DEFAULT_DEVICE_WINDOW
  const resolution = toWifiResolution(options.resolution ?? '1m')
  const params = new URLSearchParams({ resolution })
  applyWindowToParams(params, window)

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'ap-health', apId ?? 'none', windowKey(window), resolution] as const,
    queryFn: () => apiFetch<WifiApHealthResponse>(`/api/v1/wifi/aps/${apId}/health?${params}`),
    enabled: Boolean(apId) && (options.enabled ?? true),
    refetchInterval: effectiveRefreshInterval(window, options.refreshInterval, 15_000),
  })
}

export function useWifiSources(
  options: { includeDisabled?: boolean; refreshInterval?: number | false } = {}
) {
  const params = new URLSearchParams()
  if (options.includeDisabled) params.set('includeDisabled', 'true')
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the previous window's data on screen while the new window loads,
    // so changing range / dragging the mini-map doesn't blank the charts.
    placeholderData: keepPreviousData,
    queryKey: [...wifiSourcesQueryKey, options.includeDisabled ? 'with-disabled' : 'enabled'] as const,
    queryFn: () => apiFetch<WifiSource[]>(`/api/v1/settings/wifi-sources${query}`),
    refetchInterval: options.refreshInterval ?? false,
  })
}

export type UpsertWifiSourcePayload = {
  name: string
  friendlyName?: string | null
  metricsUrl: string
  pollIntervalSeconds?: number
  enabled?: boolean
  enableTwoWayCommands?: boolean
  sshHost?: string | null
  sshPort?: number
  sshUsername?: string | null
  sshPrivateKey?: string | null
}

type WifiSourceMutationResult = {
  source: WifiSource
  probe: WifiSourceStatus | null
}

type WifiSourceDraftProbeResult = {
  probe: WifiSourceStatus
  suggestedName: string | null
}

export function useCreateWifiSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: UpsertWifiSourcePayload) =>
      apiFetch<WifiSourceMutationResult>('/api/v1/settings/wifi-sources', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiSourcesQueryKey })
    },
  })
}

export function useUpdateWifiSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<UpsertWifiSourcePayload> }) =>
      apiFetch<WifiSourceMutationResult>(`/api/v1/settings/wifi-sources/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiSourcesQueryKey })
    },
  })
}

export function useDeleteWifiSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/v1/settings/wifi-sources/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiSourcesQueryKey })
    },
  })
}

export function useProbeWifiSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<WifiSourceMutationResult>(`/api/v1/settings/wifi-sources/${id}/probe`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiSourcesQueryKey })
    },
  })
}

export function useProbeWifiSourceDraft() {
  return useMutation({
    mutationFn: (payload: { metricsUrl: string }) =>
      apiFetch<WifiSourceDraftProbeResult>('/api/v1/settings/wifi-sources/probe', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  })
}

export function useKickWifiClient() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mac: string) =>
      apiFetch<WifiKickResponse>(`/api/v1/wifi/clients/${encodeURIComponent(mac)}/kick`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiQueryKey })
    },
  })
}

export function useSteerWifiClient() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ mac, banTimeMs }: { mac: string; banTimeMs?: number }) =>
      apiFetch<WifiSteerResponse>(`/api/v1/wifi/clients/${encodeURIComponent(mac)}/steer`, {
        method: 'POST',
        body: JSON.stringify(banTimeMs ? { banTimeMs } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiQueryKey })
    },
  })
}

export function useRebootWifiAp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (apId: number) =>
      apiFetch<WifiRebootResponse>(`/api/v1/wifi/aps/${apId}/reboot`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiQueryKey })
    },
  })
}

/**
 * `POST /wifi/aps/:id/locate`. Agent APs take `durationSeconds` (blink for
 * that long) or `stop`; SSH APs take `blinkTimes` / `blinkDurationMs`.
 * Undefined fields are dropped by `JSON.stringify`, so the server's
 * defaults apply.
 */
export type LocateWifiApInput = {
  apId: number
  durationSeconds?: number
  stop?: boolean
  blinkTimes?: number
  blinkDurationMs?: number
}

export function useLocateWifiAp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ apId, ...body }: LocateWifiApInput) =>
      apiFetch<WifiLocateResponse>(`/api/v1/wifi/aps/${apId}/locate`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiQueryKey })
    },
  })
}
