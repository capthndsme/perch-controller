import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { Collector, CollectorStatus, CollectorSummary } from '@/types/api'

/** Admin-only collector registry (`/api/v1/settings/collectors`). */
export const collectorsQueryKey = ['settings', 'collectors'] as const

/** Non-admin selector list (`/api/v1/collectors`) — no address, no key. */
export const collectorSummariesQueryKey = ['collectors', 'summary'] as const

/** The `collector_announce_enabled` feature switch. */
export const collectorDiscoveryQueryKey = ['settings', 'collectors', 'discovery'] as const

/**
 * Anything that changes a collector changes both the admin list and the
 * operator-facing summary list, so every mutation refreshes both rather than
 * leaving a selector elsewhere in the app stale for a refetch interval.
 */
function invalidateCollectors(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: collectorsQueryKey })
  queryClient.invalidateQueries({ queryKey: collectorSummariesQueryKey })
}

export function useCollectors(options: { includeDismissed?: boolean; enabled?: boolean } = {}) {
  const params = new URLSearchParams()
  if (options.includeDismissed) params.set('includeDismissed', 'true')
  const query = params.toString() ? `?${params}` : ''

  return useQuery({
    // Hold the current list on screen while a different variant loads, so
    // toggling "show dismissed" doesn't blank the page.
    placeholderData: keepPreviousData,
    queryKey: [
      ...collectorsQueryKey,
      options.includeDismissed ? 'with-dismissed' : 'default',
    ] as const,
    queryFn: () => apiFetch<Collector[]>(`/api/v1/settings/collectors${query}`),
    enabled: options.enabled,
    // A collector that announces while the admin is on this page should show
    // up without a reload; the API's ETag layer makes the repeat polls cheap.
    refetchInterval: 15_000,
  })
}

export type UpsertCollectorPayload = {
  name: string
  baseUrl: string
  /** Omitted keeps the stored key, `null` clears it. */
  apiKey?: string | null
  pollIntervalSeconds?: number
  enabled?: boolean
}

export type AdoptCollectorPayload = {
  name?: string
  apiKey?: string | null
  pollIntervalSeconds?: number
  enabled?: boolean
  /** Adopt even though the key's fingerprint differs from the announced one. */
  acceptKeyChange?: boolean
}

type CollectorMutationResult = {
  collector: Collector
  probe: CollectorStatus | null
  /** e.g. `announced_address_will_be_restored` after editing an announced row. */
  warnings?: string[]
}

type CollectorActionResult = {
  collector: Collector
}

type CollectorDraftProbeResult = {
  probe: CollectorStatus
  suggestedName: string | null
}

export function useCreateCollector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: UpsertCollectorPayload) =>
      apiFetch<CollectorMutationResult>('/api/v1/settings/collectors', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      invalidateCollectors(queryClient)
    },
  })
}

export function useUpdateCollector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
      probe,
    }: {
      id: number
      payload: Partial<UpsertCollectorPayload>
      /** `false` skips the re-probe the API runs after an update. */
      probe?: boolean
    }) =>
      apiFetch<CollectorMutationResult>(
        `/api/v1/settings/collectors/${id}${probe === false ? '?probe=false' : ''}`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      invalidateCollectors(queryClient)
    },
  })
}

export function useDeleteCollector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/v1/settings/collectors/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      invalidateCollectors(queryClient)
    },
  })
}

export function useProbeCollector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<CollectorMutationResult>(`/api/v1/settings/collectors/${id}/probe`, {
        method: 'POST',
      }),
    onSuccess: () => {
      invalidateCollectors(queryClient)
    },
  })
}

/** Tests an address the admin is still typing. Persists nothing. */
export function useProbeCollectorDraft() {
  return useMutation({
    mutationFn: (payload: { baseUrl: string; apiKey?: string | null }) =>
      apiFetch<CollectorDraftProbeResult>('/api/v1/settings/collectors/probe', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  })
}

export function useAdoptCollector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload?: AdoptCollectorPayload }) =>
      apiFetch<CollectorMutationResult>(`/api/v1/settings/collectors/${id}/adopt`, {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      }),
    onSuccess: () => {
      invalidateCollectors(queryClient)
    },
  })
}

export function useDismissCollector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<CollectorActionResult>(`/api/v1/settings/collectors/${id}/dismiss`, {
        method: 'POST',
      }),
    onSuccess: () => {
      invalidateCollectors(queryClient)
    },
  })
}

/**
 * The operator-safe list. Readable by any authenticated user, which is what
 * a collector picker outside Settings needs.
 */
export function useCollectorSummaries(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: collectorSummariesQueryKey,
    queryFn: () => apiFetch<CollectorSummary[]>('/api/v1/collectors'),
    enabled: options.enabled,
    refetchInterval: 60_000,
  })
}

export type CollectorDiscoverySettings = {
  /** While false, `POST /api/v1/collectors/announce` answers 403. */
  announceEnabled: boolean
}

/**
 * The announce feature switch. Read once when the Collectors page opens: it
 * only ever changes from this page, so it does not poll.
 */
export function useCollectorDiscovery() {
  return useQuery({
    queryKey: collectorDiscoveryQueryKey,
    queryFn: () =>
      apiFetch<CollectorDiscoverySettings>('/api/v1/settings/collectors/discovery'),
  })
}

export function useUpdateCollectorDiscovery() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CollectorDiscoverySettings) =>
      apiFetch<CollectorDiscoverySettings>('/api/v1/settings/collectors/discovery', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: collectorDiscoveryQueryKey })
    },
  })
}
