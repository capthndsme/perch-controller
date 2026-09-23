import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesQueryKey } from '@/hooks/use-devices'
import { ApiError, apiFetch, apiFetchBlob } from '@/lib/api'
import type {
  CreateGatewayBackupPayload,
  DeviceNetworkResponse,
  GatewayBackupSummary,
  GatewayInterfacesResponse,
  GatewayLeasesResponse,
  GatewayNeighborsResponse,
  GatewayObservationOverview,
  GatewayObservationPart,
  GatewayObserveResult,
  GatewaySystem,
  GatewayUpnpResponse,
  GatewayWanStatus,
  RouterResponse,
} from '@/types/api'

/**
 * The gateway observation channel (docs/gateway/observation.md §7): the
 * router's runtime state as its Gateway agent reports it. Read-only, except
 * the admin's on-demand refresh and backups.
 */

export const gatewayQueryKey = ['gateway'] as const

function gatewayKey(gatewayId: number | null, ...rest: unknown[]) {
  return [...gatewayQueryKey, gatewayId, ...rest] as const
}

/** `/api/v1/gateways/:gatewayId/<suffix>`. */
export function gatewayApiPath(gatewayId: number, suffix: string): string {
  return `/api/v1/gateways/${gatewayId}/${suffix}`
}

/** A missing gateway (404) or a missing role (403) will not change by asking again. */
function retryUnlessDefinite(count: number, error: Error): boolean {
  if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return false
  return count < 2
}

/**
 * The gateway the Gateway page shows when the URL names none. `:gatewayId`
 * is today the collector id of the Gateway agent, and `/api/v1/router`'s
 * `source` names that collector (docs/gateway/observation.md §7). When the
 * config plane's `gateways` table takes over the ids, the `select` below is
 * the one line to switch (to its own list endpoint). `null` = no collector
 * reports gateway stats.
 */
export function useDefaultGatewayId() {
  return useQuery({
    queryKey: [...gatewayQueryKey, 'default-id'] as const,
    queryFn: () => apiFetch<RouterResponse>('/api/v1/router?range=5m&resolution=1m'),
    select: (router): number | null => router.source?.collectorId ?? null,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
}

export function useGatewayObservation(gatewayId: number | null) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'observation'),
    queryFn: () => apiFetch<GatewayObservationOverview>(gatewayApiPath(gatewayId!, 'observation')),
    enabled: gatewayId !== null,
    refetchInterval: 30_000,
    retry: retryUnlessDefinite,
  })
}

export function useGatewayLeases(gatewayId: number | null, options: { network?: string; enabled?: boolean } = {}) {
  const params = new URLSearchParams()
  if (options.network) params.set('network', options.network)
  const query = params.toString() ? `?${params}` : ''
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: gatewayKey(gatewayId, 'leases', options.network ?? 'all'),
    queryFn: () => apiFetch<GatewayLeasesResponse>(gatewayApiPath(gatewayId!, `dhcp/leases${query}`)),
    enabled: gatewayId !== null && (options.enabled ?? true),
    refetchInterval: 60_000,
    retry: retryUnlessDefinite,
  })
}

export function useGatewayNeighbors(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'neighbors'),
    queryFn: () => apiFetch<GatewayNeighborsResponse>(gatewayApiPath(gatewayId!, 'neighbors')),
    enabled: gatewayId !== null && (options.enabled ?? true),
    refetchInterval: 60_000,
    retry: retryUnlessDefinite,
  })
}

export function useGatewayInterfaces(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'interfaces'),
    queryFn: () => apiFetch<GatewayInterfacesResponse>(gatewayApiPath(gatewayId!, 'interfaces')),
    enabled: gatewayId !== null && (options.enabled ?? true),
    refetchInterval: 60_000,
    retry: retryUnlessDefinite,
  })
}

export function useGatewayUpnp(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'upnp'),
    queryFn: () => apiFetch<GatewayUpnpResponse>(gatewayApiPath(gatewayId!, 'upnp')),
    enabled: gatewayId !== null && (options.enabled ?? true),
    refetchInterval: 60_000,
    retry: retryUnlessDefinite,
  })
}

export function useGatewayWanStatus(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'wan-status'),
    queryFn: () => apiFetch<GatewayWanStatus>(gatewayApiPath(gatewayId!, 'wan-status')),
    enabled: gatewayId !== null && (options.enabled ?? true),
    refetchInterval: 30_000,
    retry: retryUnlessDefinite,
  })
}

/** Admin only (the route answers 403 to others): pass `enabled: isAdmin`. */
export function useGatewaySystem(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'system'),
    queryFn: () => apiFetch<GatewaySystem>(gatewayApiPath(gatewayId!, 'system')),
    enabled: gatewayId !== null && (options.enabled ?? true),
    refetchInterval: 120_000,
    retry: retryUnlessDefinite,
  })
}

/** Admin only. Newest first, never the content. */
export function useGatewayBackups(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayKey(gatewayId, 'backups'),
    queryFn: () => apiFetch<GatewayBackupSummary[]>(gatewayApiPath(gatewayId!, 'backups')),
    enabled: gatewayId !== null && (options.enabled ?? true),
    retry: retryUnlessDefinite,
  })
}

/**
 * Admin: asks the router for a fresh report now (`gateway.observe`, up to
 * 20 s). Every part it answers is written before this resolves, so the
 * gateway's queries (and the device list, whose presence may read the new
 * sightings) are refetched afterwards.
 */
export function useRefreshGatewayObservation(gatewayId: number | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (parts?: GatewayObservationPart[]) =>
      apiFetch<GatewayObserveResult>(gatewayApiPath(gatewayId!, 'observe'), {
        method: 'POST',
        body: JSON.stringify(parts ? { parts } : {}),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKey(gatewayId) })
      void queryClient.invalidateQueries({ queryKey: devicesQueryKey })
    },
  })
}

/** Admin: `sysupgrade -b` on the router, stored encrypted on the controller (up to 60 s). */
export function useCreateGatewayBackup(gatewayId: number | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateGatewayBackupPayload) =>
      apiFetch<GatewayBackupSummary>(gatewayApiPath(gatewayId!, 'backups'), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKey(gatewayId, 'backups') })
    },
  })
}

/** Fetches a backup with the bearer token and hands it to the browser as a download. */
export async function downloadGatewayBackup(gatewayId: number, backup: GatewayBackupSummary): Promise<void> {
  const { blob, filename } = await apiFetchBlob(gatewayApiPath(gatewayId, `backups/${backup.id}/download`))
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename ?? backup.filename ?? `backup-${backup.id}.tar.gz`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Give the browser a moment to start the download before the URL goes.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

/** What the gateway knows of one device: lease, neighbour entry, network, UPnP mappings. */
export function useDeviceNetwork(mac: string | undefined) {
  return useQuery({
    queryKey: [...devicesQueryKey, 'network', mac ?? ''] as const,
    queryFn: () => apiFetch<DeviceNetworkResponse>(`/api/v1/devices/${encodeURIComponent(mac!)}/network`),
    enabled: Boolean(mac),
    refetchInterval: 60_000,
    retry: retryUnlessDefinite,
  })
}
