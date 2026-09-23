import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useGateways } from '@/hooks/use-gateways'
import { ApiError, apiFetch } from '@/lib/api'
import { applyWindowToParams, shouldAutoRefresh, windowKey, type RefreshInterval, type TimeWindow } from '@/lib/time-window'
import type {
  DeviceNetworks,
  GatewayBrief,
  GatewayNetwork,
  NetworkCreate,
  NetworkHistory,
  NetworkHistoryResolution,
  NetworkPatch,
  NetworkSummary,
  NetworkWrite,
  ScopeChange,
} from '@/types/networks'

/**
 * Networks of the managed gateways (metrics-be docs/gateway/networks.md
 * section 3). The per-gateway reads hang under the config plane's `gateways`
 * query tree, so every config plane write (apply, confirm, revert) refreshes
 * them too; a network write in turn invalidates the whole tree, which also
 * wakes the app-wide apply banner.
 */
const gatewaysKey = ['gateways'] as const
const networksOfKey = (gatewayId: number) => [...gatewaysKey, gatewayId, 'networks'] as const
export const allNetworksQueryKey = ['networks'] as const

function base(gatewayId: number) {
  return `/api/v1/gateways/${gatewayId}/networks`
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

/** Live counters come every 30 s; a 10 s poll shows a new sample soon enough. */
const LIVE_POLL_MS = 10_000

export function invalidateNetworks(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: gatewaysKey }),
    queryClient.invalidateQueries({ queryKey: allNetworksQueryKey }),
  ])
}

/**
 * Every gateway (`GET /gateways`): the shared `['gateways']` query of the
 * config plane's pages and apply banner (`useGateways`). A controller without
 * the config plane answers 404; the page then says so instead of retrying.
 */
export function useNetworkGateways(): UseQueryResult<GatewayBrief[], Error> {
  return useGateways()
}

export function useGatewayNetworks(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: networksOfKey(gatewayId ?? 0),
    queryFn: () => apiFetch<GatewayNetwork[]>(base(gatewayId!)),
    enabled: gatewayId !== null && options.enabled !== false,
    refetchInterval: LIVE_POLL_MS,
  })
}

/** The network lists of several gateways at once (the Networks page). */
export function useGatewayNetworkLists(gatewayIds: number[]) {
  return useQueries({
    queries: gatewayIds.map((id) => ({
      queryKey: networksOfKey(id),
      queryFn: () => apiFetch<GatewayNetwork[]>(base(id)),
      refetchInterval: LIVE_POLL_MS,
    })),
  })
}

export function useGatewayNetwork(gatewayId: number | null, networkId: number | null) {
  return useQuery({
    queryKey: [...networksOfKey(gatewayId ?? 0), networkId ?? 0] as const,
    queryFn: () => apiFetch<GatewayNetwork>(`${base(gatewayId!)}/${networkId}`),
    enabled: gatewayId !== null && networkId !== null,
    refetchInterval: LIVE_POLL_MS,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  })
}

/** `GET /networks`: every gateway's networks in one list (compact). */
export function useAllNetworks(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: allNetworksQueryKey,
    queryFn: () => apiFetch<NetworkSummary[]>('/api/v1/networks'),
    enabled: options.enabled !== false,
    refetchInterval: LIVE_POLL_MS,
  })
}

/** `GET /networks/scope-changes`: when each gateway's WAN/LAN rule changed (decision 8). */
export function useScopeChanges(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...allNetworksQueryKey, 'scope-changes'] as const,
    queryFn: () => apiFetch<ScopeChange[]>('/api/v1/networks/scope-changes'),
    enabled: options.enabled !== false,
    staleTime: 5 * 60_000,
  })
}

/** Per-network rates over a window, with the scope changes inside it. */
export function useNetworkHistory(options: {
  gatewayId: number | null
  network?: string
  window: TimeWindow
  resolution?: NetworkHistoryResolution
  refreshInterval?: RefreshInterval
}) {
  const params = new URLSearchParams({ resolution: options.resolution ?? 'auto' })
  applyWindowToParams(params, options.window)
  if (options.network) params.set('network', options.network)
  const refetchInterval =
    !shouldAutoRefresh(options.window) || options.refreshInterval === null
      ? false
      : Math.max(options.refreshInterval ?? 30_000, 30_000)
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      ...networksOfKey(options.gatewayId ?? 0),
      'history',
      windowKey(options.window),
      options.resolution ?? 'auto',
      options.network ?? '*',
    ] as const,
    queryFn: () => apiFetch<NetworkHistory>(`${base(options.gatewayId!)}/history?${params}`),
    enabled: options.gatewayId !== null,
    // A sample lands every 30 s; polling faster re-reads the same rows.
    refetchInterval,
  })
}

/** `GET /devices/:mac/networks`: the capture network now and the intervals before. */
export function useDeviceNetworks(mac: string | undefined) {
  return useQuery({
    queryKey: ['devices', 'networks', mac ?? ''] as const,
    queryFn: () => apiFetch<DeviceNetworks>(`/api/v1/devices/${encodeURIComponent(mac!)}/networks`),
    enabled: Boolean(mac),
    refetchInterval: 60_000,
    // A controller before networks answers 404: the line just stays away.
    retry: false,
  })
}

// ── Writes (admin) ──────────────────────────────────────────────────────────

function applyQuery(apply: boolean) {
  return apply ? '' : '?apply=0'
}

export function useCreateNetwork(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { body: NetworkCreate; apply?: boolean }) =>
      apiFetch<NetworkWrite>(`${base(gatewayId)}${applyQuery(input.apply ?? true)}`, json('POST', input.body)),
    onSettled: () => invalidateNetworks(queryClient),
  })
}

export function useUpdateNetwork(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { networkId: number; patch: NetworkPatch; apply?: boolean }) =>
      apiFetch<NetworkWrite>(
        `${base(gatewayId)}/${input.networkId}${applyQuery(input.apply ?? true)}`,
        json('PATCH', input.patch),
      ),
    onSettled: () => invalidateNetworks(queryClient),
  })
}

export function useDeleteNetwork(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { networkId: number; apply?: boolean }) =>
      apiFetch<NetworkWrite>(`${base(gatewayId)}/${input.networkId}${applyQuery(input.apply ?? true)}`, json('DELETE')),
    onSettled: () => invalidateNetworks(queryClient),
  })
}

/**
 * The capture toggle (decision 21): metadata only, any gateway mode, no apply.
 * Optimistic, so the switch moves at once; rolled back on a refusal.
 */
export function useSetNetworkCapture(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { networkId: number; capture: boolean }) =>
      apiFetch<NetworkWrite>(`${base(gatewayId)}/${input.networkId}`, json('PATCH', { capture: input.capture })),
    onMutate: async ({ networkId, capture }) => {
      const listKey = networksOfKey(gatewayId)
      await queryClient.cancelQueries({ queryKey: listKey })
      const previousList = queryClient.getQueryData<GatewayNetwork[]>(listKey)
      const previousOne = queryClient.getQueryData<GatewayNetwork>([...listKey, networkId])
      if (previousList) {
        queryClient.setQueryData<GatewayNetwork[]>(
          listKey,
          previousList.map((n) => (n.id === networkId ? { ...n, capture } : n)),
        )
      }
      if (previousOne) queryClient.setQueryData<GatewayNetwork>([...listKey, networkId], { ...previousOne, capture })
      return { previousList, previousOne }
    },
    onError: (_error, { networkId }, context) => {
      const listKey = networksOfKey(gatewayId)
      if (context?.previousList) queryClient.setQueryData(listKey, context.previousList)
      if (context?.previousOne) queryClient.setQueryData([...listKey, networkId], context.previousOne)
    },
    onSettled: () => invalidateNetworks(queryClient),
  })
}
