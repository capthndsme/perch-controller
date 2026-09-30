import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { alertsKey, invalidateAlertViews, json, retryUnless404 } from '@/hooks/use-alert-summary'
import type {
  AlertCatalogue,
  AlertDetailView,
  AlertListFilters,
  AlertListResponse,
  AlertView,
  DeliveryDetailView,
  DeliveryListResponse,
  MuteInput,
  MuteView,
  WatchView,
} from '@/types/alerts'

/**
 * Alerts inbox REST (design api.md §3.1–§3.3). Everything lives under the `['alerts', …]` key; the service
 * worker's "a push arrived" message refreshes summary, list and detail (lib/push.ts). The bell's part is in
 * `use-alert-summary.ts` (entry chunk).
 */

const BASE = '/api/v1/alerts'

// ── Inbox ────────────────────────────────────────────────────────────────

function listQuery(filters: AlertListFilters, before: string | null): string {
  const params = new URLSearchParams()
  if (filters.view) params.set('view', filters.view)
  if (filters.blips) params.set('blips', '1')
  if (filters.minSeverity && filters.minSeverity !== 'info') params.set('minSeverity', filters.minSeverity)
  if (filters.categories?.length) params.set('category', filters.categories.join(','))
  if (filters.types?.length) params.set('type', filters.types.join(','))
  if (filters.subject) params.set('subject', filters.subject)
  if (filters.limit) params.set('limit', String(filters.limit))
  if (before) params.set('before', before)
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function useAlertList(filters: AlertListFilters) {
  return useInfiniteQuery({
    queryKey: [...alertsKey, 'list', filters] as const,
    queryFn: ({ pageParam }) => apiFetch<AlertListResponse>(`${BASE}${listQuery(filters, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: retryUnless404,
  })
}

export function useAlertCatalogue(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...alertsKey, 'catalogue'] as const,
    queryFn: () => apiFetch<AlertCatalogue>(`${BASE}/catalogue`),
    enabled: options.enabled,
    staleTime: 10 * 60_000,
    retry: retryUnless404,
  })
}

export function useAlert(id: number | null) {
  return useQuery({
    queryKey: [...alertsKey, 'detail', id] as const,
    queryFn: () => apiFetch<AlertDetailView>(`${BASE}/${id}`),
    enabled: id !== null,
    refetchInterval: 30_000,
    retry: retryUnless404,
  })
}

function useAlertMutation<TInput>(fn: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => invalidateAlertViews(queryClient),
  })
}

export function useAcknowledgeAlert() {
  return useAlertMutation(({ id, note }: { id: number; note?: string }) =>
    apiFetch<AlertView>(`${BASE}/${id}/acknowledge`, json('POST', note ? { note } : {})),
  )
}

export function useResolveAlert() {
  return useAlertMutation(({ id, note }: { id: number; note?: string }) =>
    apiFetch<AlertView>(`${BASE}/${id}/resolve`, json('POST', note ? { note } : {})),
  )
}

// ── Mutes ────────────────────────────────────────────────────────────────

export function useAlertMutes(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...alertsKey, 'mutes'] as const,
    queryFn: () => apiFetch<MuteView[]>(`${BASE}/mutes`),
    enabled: options.enabled,
    retry: retryUnless404,
  })
}

export function useCreateMute() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MuteInput) => apiFetch<MuteView>(`${BASE}/mutes`, json('POST', input)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [...alertsKey, 'mutes'] })
      void invalidateAlertViews(queryClient)
    },
  })
}

export function useDeleteMute() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch<void>(`${BASE}/mutes/${id}`, { method: 'DELETE' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [...alertsKey, 'mutes'] })
      void invalidateAlertViews(queryClient)
    },
  })
}

// ── Watched devices ──────────────────────────────────────────────────────

export function useDeviceWatch(mac: string) {
  return useQuery({
    queryKey: [...alertsKey, 'watches', mac] as const,
    queryFn: () => apiFetch<WatchView[]>(`${BASE}/watches?mac=${encodeURIComponent(mac)}`),
    enabled: mac !== '',
    retry: retryUnless404,
    select: (rows) => rows.find((row) => row.mac === mac) ?? { mac, label: null, offline: false, arrival: false },
  })
}

export function useUpdateDeviceWatch(mac: string) {
  const queryClient = useQueryClient()
  const key = [...alertsKey, 'watches', mac] as const
  return useMutation({
    mutationFn: (input: { offline: boolean; arrival: boolean }) =>
      apiFetch<WatchView>(`${BASE}/watches/devices/${encodeURIComponent(mac)}`, json('PUT', input)),
    // The switch moves at once; a failure puts it back.
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<WatchView[]>(key)
      queryClient.setQueryData<WatchView[]>(key, [{ mac, label: previous?.[0]?.label ?? null, ...input }])
      return { previous }
    },
    onError: (_error, _input, context) => queryClient.setQueryData(key, context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })
}

// ── Deliveries (admin) ───────────────────────────────────────────────────

export function useDeliveries(params: { destination?: string; alertId?: number; limit?: number }, options: { enabled?: boolean } = {}) {
  const search = new URLSearchParams()
  if (params.destination) search.set('destination', params.destination)
  if (params.alertId) search.set('alertId', String(params.alertId))
  search.set('limit', String(params.limit ?? 20))
  return useQuery({
    queryKey: [...alertsKey, 'deliveries', params] as const,
    queryFn: () => apiFetch<DeliveryListResponse>(`${BASE}/deliveries?${search}`),
    enabled: options.enabled,
    retry: retryUnless404,
  })
}

export function useDelivery(id: number | null) {
  return useQuery({
    queryKey: [...alertsKey, 'delivery', id] as const,
    queryFn: () => apiFetch<DeliveryDetailView>(`${BASE}/deliveries/${id}`),
    enabled: id !== null,
  })
}
