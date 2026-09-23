import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type {
  ConfirmMode,
  DeviceReservationView,
  DhcpReservation,
  DnsRecord,
  DomainWriteResult,
  DryRunResult,
  Gateway,
  GatewayApply,
  GatewayConfigSettings,
  GatewayConfigSettingsView,
  GatewayDns,
  GatewayDraft,
  GatewayEvent,
  GatewayMode,
  GatewayPairing,
  GatewayRevision,
  GatewaySection,
  PackageDryRun,
  Paged,
  PendingLabelName,
  SectionDetail,
  SectionScope,
  SyncStatus,
  UciValue,
} from '@/types/gateway-config'

/**
 * The managed gateway's config plane (metrics-be docs/gateway/config-plane.md
 * section 10). Every write invalidates the whole `gateways` tree: one write
 * moves the list's badges, the sections, the draft and the history together.
 */
export const gatewaysQueryKey = ['gateways'] as const
const gatewayKey = (id: number) => [...gatewaysQueryKey, id] as const

export function invalidateGateways(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: gatewaysQueryKey })
}

const base = (id: number) => `/api/v1/gateways/${id}`

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

// ── Gateways ────────────────────────────────────────────────────────────────

/**
 * The one `GET /api/v1/gateways` query every page shares (key `['gateways']`):
 * the config plane, the apply banner, the Gateway overview, networks, shaping
 * and the guest portal all read this cache entry. Polls faster while any
 * gateway has a job open, so the app-wide apply banner follows the confirm
 * steps. A controller without the config plane answers 404: no retry.
 */
function gatewaysQueryOptions(enabled: boolean) {
  return {
    queryKey: gatewaysQueryKey,
    queryFn: () => apiFetch<Gateway[]>('/api/v1/gateways'),
    enabled,
    refetchInterval: (query: { state: { data?: Gateway[] } }) =>
      (query.state.data ?? []).some((g) => g.pendingApply) ? 2_000 : 15_000,
    retry: false,
  } as const
}

/** All gateways. */
export function useGateways(options: { enabled?: boolean } = {}) {
  const token = useAuthStore((state) => state.token)
  return useQuery(gatewaysQueryOptions(Boolean(token) && options.enabled !== false))
}

/** The parts of a gateway row the default pick needs. */
export type DefaultGatewayCandidate = { id: number; collectorId: number | null; online: boolean }

/**
 * The gateway a page shows when the URL names none (`?gateway=N` wins):
 * `gateways.id`, the first gateway bound to a collector, an online one first.
 * `null` = no gateway yet (no adopted collector on a router). The one rule
 * for the Gateway overview, configuration, networks, shaping and the portal.
 */
export function pickDefaultGateway(rows: DefaultGatewayCandidate[]): number | null {
  const bound = rows.filter((g) => g.collectorId !== null)
  return (bound.find((g) => g.online) ?? bound[0])?.id ?? null
}

/** `pickDefaultGateway` over the shared gateways query. */
export function useDefaultGatewayId(options: { enabled?: boolean } = {}) {
  const token = useAuthStore((state) => state.token)
  return useQuery({
    ...gatewaysQueryOptions(Boolean(token) && options.enabled !== false),
    select: pickDefaultGateway,
  })
}

/** `?gateway=N` from the URL, else null. */
export function gatewayIdFromParams(params: URLSearchParams): number | null {
  const raw = params.get('gateway')
  if (!raw) return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * The page's gateway: `?gateway=N`, else the default pick. `settled` turns
 * true once the choice is final (the URL names one, or the list has loaded
 * or failed), so pages hold their reads instead of asking twice.
 */
export function usePageGatewayId(): { gatewayId: number | null; settled: boolean; error: Error | null } {
  const [params] = useSearchParams()
  const explicit = gatewayIdFromParams(params)
  const fallback = useDefaultGatewayId({ enabled: explicit === null })
  if (explicit !== null) return { gatewayId: explicit, settled: true, error: null }
  return {
    gatewayId: fallback.data ?? null,
    settled: !fallback.isPending,
    error: fallback.error,
  }
}

export function useGateway(id: number | null) {
  return useQuery({
    queryKey: gatewayKey(id ?? 0),
    queryFn: () => apiFetch<Gateway>(base(id!)),
    enabled: id !== null,
    refetchInterval: (query) => {
      const g = query.state.data
      if (!g) return 15_000
      if (g.pendingApply) return 2_000
      const p = g.pairing?.state
      if (p === 'awaiting_confirmation' || p === 'awaiting_router') return 3_000
      return 10_000
    },
  })
}

export type GatewayPatch = {
  mode?: GatewayMode
  authoritative?: boolean
  expectRevision?: number
  currentPassword?: string
}

export function usePatchGateway(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: GatewayPatch) => apiFetch<Gateway>(base(id), json('PATCH', patch)),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useRefreshGateway(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ capabilities: unknown; observedAt: string | null; changedConfigs: string[] }>(
        `${base(id)}/refresh`,
        json('POST'),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useSyncStatus(id: number, options: { fresh: boolean; enabled?: boolean }) {
  return useQuery({
    queryKey: [...gatewayKey(id), 'sync-status', options.fresh ? 'fresh' : 'stored'] as const,
    queryFn: () => apiFetch<SyncStatus>(`${base(id)}/sync-status?fresh=${options.fresh ? 1 : 0}`),
    enabled: options.enabled !== false,
    // A fresh read asks the router: never in the background.
    staleTime: options.fresh ? Infinity : 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// ── Sections ───────────────────────────────────────────────────────────────

export type SectionFilter = { config?: string; scope?: SectionScope; status?: string; domain?: string }

export function useSections(id: number, filter: SectionFilter = {}, options: { enabled?: boolean } = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value)
  const qs = params.toString()
  return useQuery({
    queryKey: [...gatewayKey(id), 'sections', qs] as const,
    queryFn: () => apiFetch<GatewaySection[]>(`${base(id)}/sections${qs ? `?${qs}` : ''}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled !== false,
    refetchInterval: 10_000,
  })
}

export function useSectionDetail(id: number, perchId: string | null) {
  return useQuery({
    queryKey: [...gatewayKey(id), 'section', perchId] as const,
    queryFn: () =>
      apiFetch<SectionDetail>(`${base(id)}/sections/${encodeURIComponent(perchId!)}?limit=20`),
    enabled: perchId !== null,
  })
}

export function useSetSectionScope(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { perchId: string; scope: 'synced' | 'excluded' }) =>
      apiFetch<GatewaySection>(
        `${base(id)}/sections/${encodeURIComponent(input.perchId)}`,
        json('PATCH', { scope: input.scope }),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export type ResolveItem = {
  perchId: string
  take: 'router' | 'controller' | 'custom'
  options?: Record<string, UciValue | null>
}

export function useResolveSections(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (items: ResolveItem[]) =>
      apiFetch<{ sections: GatewaySection[] }>(`${base(id)}/sections/resolve`, json('POST', { items })),
    onSettled: () => invalidateGateways(queryClient),
  })
}

// ── Draft and applies ───────────────────────────────────────────────────────

export function useDraft(id: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...gatewayKey(id), 'draft'] as const,
    queryFn: () => apiFetch<GatewayDraft>(`${base(id)}/draft`),
    enabled: options.enabled !== false,
    refetchInterval: 10_000,
  })
}

export function useDiscardDraft(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (perchIds?: string[]) =>
      apiFetch<{ discarded: number }>(`${base(id)}/draft`, json('DELETE', perchIds ? { perchIds } : {})),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export type ApplyRequest = {
  perchIds?: string[]
  confirmMode?: ConfirmMode
  note?: string
}

export function useCreateApply(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ApplyRequest) =>
      apiFetch<GatewayApply>(`${base(id)}/applies`, json('POST', input)),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useDryRunApply(id: number) {
  return useMutation({
    mutationFn: (input: ApplyRequest) =>
      apiFetch<DryRunResult>(`${base(id)}/applies`, json('POST', { ...input, dryRun: true })),
  })
}

export function useApplies(id: number) {
  return useInfiniteQuery({
    queryKey: [...gatewayKey(id), 'applies'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<GatewayApply>>(
        `${base(id)}/applies?limit=20${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: 10_000,
  })
}

export function useApply(id: number, applyId: string | null) {
  return useQuery({
    queryKey: [...gatewayKey(id), 'apply', applyId] as const,
    queryFn: () => apiFetch<GatewayApply>(`${base(id)}/applies/${encodeURIComponent(applyId!)}`),
    enabled: applyId !== null,
  })
}

/** One apply, fetched outside a component (the banner's outcome after a job leaves `pendingApply`). */
export function fetchApply(id: number, applyId: string) {
  return apiFetch<GatewayApply>(`${base(id)}/applies/${encodeURIComponent(applyId)}`)
}

export function useConfirmApply() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { gatewayId: number; applyId: string }) =>
      apiFetch<GatewayApply>(
        `${base(input.gatewayId)}/applies/${encodeURIComponent(input.applyId)}/confirm`,
        json('POST'),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useRevertApply() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { gatewayId: number; applyId: string }) =>
      apiFetch<GatewayApply>(
        `${base(input.gatewayId)}/applies/${encodeURIComponent(input.applyId)}/revert`,
        json('POST'),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

// ── History and events ──────────────────────────────────────────────────────

export function useRevisions(id: number) {
  return useInfiniteQuery({
    queryKey: [...gatewayKey(id), 'revisions'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<GatewayRevision>>(
        `${base(id)}/revisions?limit=25${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  })
}

export function useRevision(id: number, number: number | null) {
  return useQuery({
    queryKey: [...gatewayKey(id), 'revision', number] as const,
    queryFn: () => apiFetch<GatewayRevision>(`${base(id)}/revisions/${number}`),
    enabled: number !== null,
    staleTime: Infinity,
  })
}

export function useRestoreRevision(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (number: number) =>
      apiFetch<{ perchIds: string[]; changes: unknown[] }>(
        `${base(id)}/revisions/${number}/restore`,
        json('POST'),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useDismissRejoin(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<Gateway>(`${base(id)}/rejoin/dismiss`, json('POST')),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useEvents(id: number) {
  return useInfiniteQuery({
    queryKey: [...gatewayKey(id), 'events'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<GatewayEvent>>(
        `${base(id)}/events?limit=50${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: 15_000,
  })
}

// ── Drift and enforcement (Authoritative Mode) ──────────────────────────────

export function useAcceptDrift(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (perchIds?: string[]) =>
      apiFetch<{ accepted: string[] }>(`${base(id)}/drift/accept`, json('POST', perchIds ? { perchIds } : {})),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useRevertDriftNow(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (perchIds?: string[]) =>
      apiFetch<GatewayApply>(`${base(id)}/drift/revert-now`, json('POST', perchIds ? { perchIds } : {})),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useResumeEnforcement(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<Gateway>(`${base(id)}/enforcement/resume`, json('POST')),
    onSettled: () => invalidateGateways(queryClient),
  })
}

// ── Packages ────────────────────────────────────────────────────────────────

export function usePackageDryRun(id: number) {
  return useMutation({
    mutationFn: (packages: string[]) =>
      apiFetch<PackageDryRun>(`${base(id)}/packages`, json('POST', { packages, dryRun: true })),
  })
}

export function useInstallPackages(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { packages: string[]; note?: string }) =>
      apiFetch<GatewayApply>(`${base(id)}/packages`, json('POST', input)),
    onSettled: () => invalidateGateways(queryClient),
  })
}

// ── Pairing and the sign key ────────────────────────────────────────────────

export function useStartPairing(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (currentPassword: string) =>
      apiFetch<{ pairing: GatewayPairing }>(`${base(id)}/pairing`, json('POST', { currentPassword })),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useConfirmPairing(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (code: string) =>
      apiFetch<{ pairing: GatewayPairing }>(`${base(id)}/pairing/confirm`, json('POST', { code })),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useUnpair(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<{ pairing: null }>(`${base(id)}/pairing`, json('DELETE')),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useSetSignKey(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; currentPassword: string }) =>
      apiFetch<Gateway>(`${base(id)}/sign-key`, json('PUT', input)),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useClearSignKey(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<Gateway>(`${base(id)}/sign-key`, json('DELETE')),
    onSettled: () => invalidateGateways(queryClient),
  })
}

// ── DNS (section 10.3) ──────────────────────────────────────────────────────

export function useGatewayDns(id: number) {
  return useQuery({
    queryKey: [...gatewayKey(id), 'dns'] as const,
    queryFn: () => apiFetch<GatewayDns>(`${base(id)}/dns`),
  })
}

export function useSetDnsLabelPolicy(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (labelNames: 'off' | 'review') =>
      apiFetch<GatewayDns>(`${base(id)}/dns`, json('PATCH', { labelNames })),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useCreateDnsRecord(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { type: 'a' | 'cname'; name: string; value: string }) =>
      apiFetch<DomainWriteResult<DnsRecord>>(`${base(id)}/dns/records`, json('POST', input)),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useUpdateDnsRecord(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { perchId: string; name?: string; value?: string }) =>
      apiFetch<DomainWriteResult<DnsRecord>>(
        `${base(id)}/dns/records/${encodeURIComponent(input.perchId)}`,
        json('PATCH', { name: input.name, value: input.value }),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useDeleteDnsRecord(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (perchId: string) =>
      apiFetch<DomainWriteResult<null>>(`${base(id)}/dns/records/${encodeURIComponent(perchId)}`, json('DELETE')),
    onSettled: () => invalidateGateways(queryClient),
  })
}

export function useApplyLabelNames(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (macs?: string[]) =>
      apiFetch<{ applied: PendingLabelName[]; issues: unknown[]; apply: GatewayApply | null; applyError: unknown }>(
        `${base(id)}/dns/label-names/apply`,
        json('POST', macs ? { macs } : {}),
      ),
    onSettled: () => invalidateGateways(queryClient),
  })
}

// ── Device reservation (section 10.3) ───────────────────────────────────────

const reservationKey = (mac: string, gatewayId: number | null) =>
  ['device-reservation', mac, gatewayId ?? 'default'] as const

export function useDeviceReservation(mac: string, gatewayId: number | null) {
  return useQuery({
    queryKey: reservationKey(mac, gatewayId),
    queryFn: () =>
      apiFetch<DeviceReservationView>(
        `/api/v1/devices/${encodeURIComponent(mac)}/reservation${gatewayId ? `?gatewayId=${gatewayId}` : ''}`,
      ),
    enabled: mac !== '',
    retry: false,
    // An apply started from the card moves its status: follow it for a while.
    refetchInterval: (query) =>
      query.state.data?.reservation && !query.state.data.reservation.applied ? 3_000 : false,
  })
}

export type ReservationInput = {
  gatewayId?: number
  ip: 'current' | string | null
  hostname?: string | null
  publishDns?: boolean
  leaseTime?: string | null
}

export function usePutReservation(mac: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReservationInput) =>
      apiFetch<DomainWriteResult<DhcpReservation>>(
        `/api/v1/devices/${encodeURIComponent(mac)}/reservation`,
        json('PUT', input),
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['device-reservation', mac] })
      return invalidateGateways(queryClient)
    },
  })
}

export function useDeleteReservation(mac: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (gatewayId?: number) =>
      apiFetch<DomainWriteResult<null>>(
        `/api/v1/devices/${encodeURIComponent(mac)}/reservation`,
        json('DELETE', gatewayId ? { gatewayId } : {}),
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['device-reservation', mac] })
      return invalidateGateways(queryClient)
    },
  })
}

// ── Settings → Gateway config (section 11) ──────────────────────────────────

export const gatewayConfigSettingsKey = ['settings', 'gateway'] as const

export function useGatewayConfigSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gatewayConfigSettingsKey,
    queryFn: () => apiFetch<GatewayConfigSettingsView>('/api/v1/settings/gateway'),
    enabled: options.enabled !== false,
    retry: false,
  })
}

export function useUpdateGatewayConfigSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<GatewayConfigSettings>) =>
      apiFetch<GatewayConfigSettingsView>('/api/v1/settings/gateway', json('PATCH', patch)),
    onSuccess: (data) => {
      queryClient.setQueryData(gatewayConfigSettingsKey, data)
      return invalidateGateways(queryClient)
    },
  })
}
