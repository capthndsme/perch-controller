import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type {
  GatewayDraft,
  GatewayEvent,
  GatewayPairing,
  GatewayRevision,
  GatewaySection,
  SectionDetail,
  SectionScope,
  SyncStatus,
  UciValue,
} from '@/types/gateway-config'
import type {
  AdoptionAccept,
  AdoptionResult,
  AdoptionView,
  ApApply,
  ApConfig,
  ApPatch,
  DivergenceResolution,
  ImpactPreview,
  NetworkApPut,
  NetworkCreate,
  NetworkPatch,
  Paged,
  PassphraseResult,
  RadioPatch,
  RestoreResult,
  ResolveDivergenceItem,
  ResolveDivergencesResult,
  RolloutAction,
  RolloutPreviewRequest,
  RolloutRequest,
  WifiConfigOverview,
  WifiConfigSettings,
  WifiConfigSettingsView,
  WifiDivergence,
  WifiHealth,
  WifiNetwork,
  WifiRadio,
  WifiRollout,
  WriteResult,
} from '@/types/wifi-config'

/**
 * Wi-Fi management (docs/design/wifi/controller.md section 7). Every query
 * key hangs under `['wifi-config']`; every write invalidates that tree and the
 * monitoring pages' `['wifi']` tree (SSIDs and radios they show can change).
 * A controller without the Wi-Fi plane answers 404: no retry.
 */
export const wifiConfigKey = ['wifi-config'] as const
const apKey = (apId: number) => [...wifiConfigKey, 'ap', apId] as const

/** The monitoring pages' tree (`hooks/use-wifi.ts` `wifiQueryKey`), named here so the shell's banner does not load that module. */
const monitoringKey = ['wifi'] as const

const V1 = '/api/v1'
/** The per-AP plane lives under `/wifi/config/aps` (`/wifi/aps` is the monitoring pages'). */
const apBase = (apId: number) => `${V1}/wifi/config/aps/${apId}`

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

function applyParam(apply: boolean | undefined): string {
  return apply === false ? '?apply=0' : ''
}

export function invalidateWifiConfig(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: wifiConfigKey }),
    queryClient.invalidateQueries({ queryKey: monitoringKey }),
  ])
}

function useSignedIn() {
  return Boolean(useAuthStore((state) => state.token))
}

/** Polls faster while a rollout is going, so pills and banners follow it. */
function overviewInterval(data: WifiConfigOverview | undefined): number {
  return data?.rollout && data.rollout.state === 'running' ? 3_000 : 15_000
}

// ── Overview and access points ──────────────────────────────────────────────

/** `GET /wifi/config`: APs, networks, open divergences, the rollout, pending adoption. */
export function useWifiConfig(options: { enabled?: boolean } = {}) {
  const signedIn = useSignedIn()
  return useQuery({
    queryKey: [...wifiConfigKey, 'overview'] as const,
    queryFn: () => apiFetch<WifiConfigOverview>(`${V1}/wifi/config`),
    enabled: signedIn && options.enabled !== false,
    refetchInterval: (query) => overviewInterval(query.state.data),
    retry: false,
  })
}

/** `GET /wifi/config/aps`: agent APs with their plane state (scraped rows omitted). */
export function useApConfigs(options: { enabled?: boolean } = {}) {
  const signedIn = useSignedIn()
  return useQuery({
    queryKey: [...wifiConfigKey, 'aps'] as const,
    queryFn: () => apiFetch<ApConfig[]>(`${V1}/wifi/config/aps`),
    enabled: signedIn && options.enabled !== false,
    refetchInterval: (query) => ((query.state.data ?? []).some((ap) => ap.pendingApply) ? 2_000 : 15_000),
    retry: false,
  })
}

function apConfigQuery(apId: number, enabled: boolean) {
  return {
    queryKey: apKey(apId),
    queryFn: () => apiFetch<ApConfig>(apBase(apId)),
    enabled,
    refetchInterval: (query: { state: { data?: ApConfig } }) => (query.state.data?.pendingApply ? 2_000 : 15_000),
  } as const
}

/** `GET /wifi/config/aps/:apId`, with capabilities and the management path. */
export function useApConfig(apId: number | null) {
  return useQuery(apConfigQuery(apId ?? 0, apId !== null))
}

/** Several APs' details at once (the editor reads each carrying AP's hostapd features). */
export function useApConfigDetails(apIds: number[]) {
  return useQueries({
    queries: apIds.map((apId) => ({ ...apConfigQuery(apId, true), refetchInterval: false as const })),
  })
}

/**
 * `PATCH /wifi/config/aps/:apId[?apply=0]` → `WriteResult<ApConfig>`: a
 * country change goes out by a one-AP rollout unless `apply: false`.
 */
export function useUpdateApConfig(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ apply, ...patch }: ApPatch & { apply?: boolean }) =>
      apiFetch<WriteResult<ApConfig>>(`${apBase(apId)}${applyParam(apply)}`, json('PATCH', patch)),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useRefreshApConfig(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ capabilities: unknown; observedAt: string | null; changedConfigs: string[]; health: WifiHealth | null }>(
        `${apBase(apId)}/refresh`,
        json('POST'),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

/** `GET /wifi/aps/:apId/health`; `fresh` asks the agent now. */
export function useApHealth(apId: number, options: { fresh: boolean; enabled?: boolean }) {
  return useQuery({
    queryKey: [...apKey(apId), 'health', options.fresh ? 'fresh' : 'stored'] as const,
    queryFn: () => apiFetch<WifiHealth | null>(`${apBase(apId)}/health${options.fresh ? '?fresh=1' : ''}`),
    enabled: options.enabled !== false,
    refetchInterval: options.fresh ? false : 15_000,
    retry: false,
  })
}

export function useApRejoin(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (use: 'fleet' | 'revision') => apiFetch<WifiRollout>(`${apBase(apId)}/rejoin`, json('POST', { use })),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useDismissApRejoin(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<ApConfig>(`${apBase(apId)}/rejoin/dismiss`, json('POST')),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

// ── Per-AP config plane (the gateway's shapes, config-plane.md 10.2) ────────

export function useApSyncStatus(apId: number, options: { fresh: boolean; enabled?: boolean }) {
  return useQuery({
    queryKey: [...apKey(apId), 'sync-status', options.fresh ? 'fresh' : 'stored'] as const,
    queryFn: () => apiFetch<SyncStatus>(`${apBase(apId)}/sync-status?fresh=${options.fresh ? 1 : 0}`),
    enabled: options.enabled !== false,
    staleTime: 0,
    retry: false,
  })
}

export type ApSectionFilter = { config?: string; scope?: SectionScope; status?: string; domain?: string }

export function useApSections(apId: number, filter: ApSectionFilter = {}, options: { enabled?: boolean } = {}) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v)
  const qs = params.toString()
  return useQuery({
    queryKey: [...apKey(apId), 'sections', qs] as const,
    queryFn: () => apiFetch<GatewaySection[]>(`${apBase(apId)}/sections${qs ? `?${qs}` : ''}`),
    enabled: options.enabled !== false,
    placeholderData: keepPreviousData,
  })
}

export function useApSectionDetail(apId: number, perchId: string | null) {
  return useQuery({
    queryKey: [...apKey(apId), 'section', perchId] as const,
    queryFn: () => apiFetch<SectionDetail>(`${apBase(apId)}/sections/${encodeURIComponent(perchId!)}?limit=20`),
    enabled: perchId !== null,
  })
}

export function useSetApSectionScope(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { perchId: string; scope: 'synced' | 'excluded' }) =>
      apiFetch<GatewaySection>(
        `${apBase(apId)}/sections/${encodeURIComponent(input.perchId)}`,
        json('PATCH', { scope: input.scope }),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export type ApResolveItem = {
  perchId: string
  take: 'router' | 'controller' | 'custom'
  options?: Record<string, UciValue | null>
}

export function useResolveApConflicts(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (items: ApResolveItem[]) =>
      apiFetch<{ sections: GatewaySection[] }>(`${apBase(apId)}/sections/resolve`, json('POST', { items })),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useApDraft(apId: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...apKey(apId), 'draft'] as const,
    queryFn: () => apiFetch<GatewayDraft>(`${apBase(apId)}/draft`),
    enabled: options.enabled !== false,
  })
}

export function useDiscardApDraft(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (perchIds?: string[]) =>
      apiFetch<{ discarded: number }>(`${apBase(apId)}/draft`, json('DELETE', perchIds ? { perchIds } : {})),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useApApplies(apId: number) {
  return useInfiniteQuery({
    queryKey: [...apKey(apId), 'applies'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<ApApply>>(`${apBase(apId)}/applies?limit=25${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  })
}

export function useConfirmApApply(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (applyId: string) =>
      apiFetch<ApApply>(`${apBase(apId)}/applies/${encodeURIComponent(applyId)}/confirm`, json('POST')),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useRevertApApply(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (applyId: string) =>
      apiFetch<ApApply>(`${apBase(apId)}/applies/${encodeURIComponent(applyId)}/revert`, json('POST')),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useApRevisions(apId: number) {
  return useInfiniteQuery({
    queryKey: [...apKey(apId), 'revisions'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<GatewayRevision>>(`${apBase(apId)}/revisions?limit=25${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  })
}

export function useApRevision(apId: number, number: number | null) {
  return useQuery({
    queryKey: [...apKey(apId), 'revision', number] as const,
    queryFn: () => apiFetch<GatewayRevision>(`${apBase(apId)}/revisions/${number}`),
    enabled: number !== null,
    staleTime: Infinity,
  })
}

/** Restore a revision into the draft; with `apply` (default) a one-AP rollout starts. */
export function useRestoreApRevision(apId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { number: number; apply?: boolean }) =>
      apiFetch<RestoreResult>(
        `${apBase(apId)}/revisions/${input.number}/restore${applyParam(input.apply)}`,
        json('POST'),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useApEvents(apId: number) {
  return useInfiniteQuery({
    queryKey: [...apKey(apId), 'events'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<GatewayEvent>>(`${apBase(apId)}/events?limit=50${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: 15_000,
  })
}

/** Drift under Authoritative Mode: accept the AP's version, revert now, or resume enforcement. */
export function useApDrift(apId: number) {
  const queryClient = useQueryClient()
  const settle = () => invalidateWifiConfig(queryClient)
  const accept = useMutation({
    mutationFn: (perchIds?: string[]) =>
      apiFetch<{ accepted: string[] }>(`${apBase(apId)}/drift/accept`, json('POST', perchIds ? { perchIds } : {})),
    onSettled: settle,
  })
  const revertNow = useMutation({
    mutationFn: (perchIds?: string[]) =>
      apiFetch<ApApply>(`${apBase(apId)}/drift/revert-now`, json('POST', perchIds ? { perchIds } : {})),
    onSettled: settle,
  })
  const resume = useMutation({
    mutationFn: () => apiFetch<ApConfig>(`${apBase(apId)}/enforcement/resume`, json('POST')),
    onSettled: settle,
  })
  return { accept, revertNow, resume }
}

/** Pairing for writes over plain HTTP (phase 3). */
export function useApPairing(apId: number, options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient()
  const settle = () => invalidateWifiConfig(queryClient)
  const query = useQuery({
    queryKey: [...apKey(apId), 'pairing'] as const,
    queryFn: () => apiFetch<{ pairing: GatewayPairing | null }>(`${apBase(apId)}/pairing`),
    enabled: options.enabled !== false,
    refetchInterval: (q) => {
      const state = q.state.data?.pairing?.state
      return state === 'awaiting_confirmation' || state === 'awaiting_router' ? 2_000 : false
    },
  })
  const start = useMutation({
    mutationFn: (currentPassword: string) =>
      apiFetch<{ pairing: GatewayPairing }>(`${apBase(apId)}/pairing`, json('POST', { currentPassword })),
    onSettled: settle,
  })
  const confirm = useMutation({
    mutationFn: (code: string) =>
      apiFetch<{ pairing: GatewayPairing }>(`${apBase(apId)}/pairing/confirm`, json('POST', { code })),
    onSettled: settle,
  })
  const unpair = useMutation({
    mutationFn: () => apiFetch<{ pairing: null }>(`${apBase(apId)}/pairing`, json('DELETE')),
    onSettled: settle,
  })
  return { query, start, confirm, unpair }
}

// ── Networks ────────────────────────────────────────────────────────────────

export function useWifiNetworks(options: { enabled?: boolean } = {}) {
  const signedIn = useSignedIn()
  return useQuery({
    queryKey: [...wifiConfigKey, 'networks'] as const,
    queryFn: () => apiFetch<WifiNetwork[]>(`${V1}/wifi/networks`),
    enabled: signedIn && options.enabled !== false,
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useWifiNetwork(id: number | null) {
  return useQuery({
    queryKey: [...wifiConfigKey, 'network', id ?? 0] as const,
    queryFn: () => apiFetch<WifiNetwork>(`${V1}/wifi/networks/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.status === 'applying' ? 3_000 : 15_000),
  })
}

export function useCreateNetwork() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { body: NetworkCreate; apply?: boolean }) =>
      apiFetch<WriteResult<WifiNetwork>>(`${V1}/wifi/networks${applyParam(input.apply)}`, json('POST', input.body)),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useUpdateNetwork() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; patch: NetworkPatch; apply?: boolean }) =>
      apiFetch<WriteResult<WifiNetwork>>(
        `${V1}/wifi/networks/${input.id}${applyParam(input.apply)}`,
        json('PATCH', input.patch),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useDeleteNetwork() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; apply?: boolean }) =>
      apiFetch<WriteResult<null>>(`${V1}/wifi/networks/${input.id}${applyParam(input.apply)}`, json('DELETE')),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

/** Enter (or verify) a network's passphrase once; `force` stores it despite mismatching APs. */
export function useSetPassphrase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; passphrase: string; force?: boolean }) =>
      apiFetch<PassphraseResult>(
        `${V1}/wifi/networks/${input.id}/passphrase`,
        json('POST', { passphrase: input.passphrase, ...(input.force ? { force: true } : {}) }),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

/** Admin-only, audited as `passphrase_revealed`; never cached. */
export function useRevealPassphrase() {
  return useMutation({
    mutationFn: (id: number) => apiFetch<{ passphrase: string }>(`${V1}/wifi/networks/${id}/passphrase`),
  })
}

export function useUpdateNetworkAp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; apId: number; body: NetworkApPut; apply?: boolean }) =>
      apiFetch<WriteResult<WifiNetwork>>(
        `${V1}/wifi/networks/${input.id}/aps/${input.apId}${applyParam(input.apply)}`,
        json('PUT', input.body),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useResetNetworkAp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; apId: number; apply?: boolean }) =>
      apiFetch<WriteResult<WifiNetwork>>(
        `${V1}/wifi/networks/${input.id}/aps/${input.apId}/overrides${applyParam(input.apply)}`,
        json('DELETE'),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

// ── Radios ──────────────────────────────────────────────────────────────────

export function useWifiRadios(apId?: number | null, options: { enabled?: boolean } = {}) {
  const signedIn = useSignedIn()
  return useQuery({
    queryKey: [...wifiConfigKey, 'radios', apId ?? 'all'] as const,
    queryFn: () => apiFetch<WifiRadio[]>(`${V1}/wifi/radios${apId ? `?apId=${apId}` : ''}`),
    enabled: signedIn && options.enabled !== false,
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useUpdateRadio() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { apId: number; section: string; patch: RadioPatch; apply?: boolean }) =>
      apiFetch<WriteResult<WifiRadio>>(
        `${apBase(input.apId)}/radios/${encodeURIComponent(input.section)}${applyParam(input.apply)}`,
        json('PATCH', input.patch),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

// ── Divergences ─────────────────────────────────────────────────────────────

export type DivergenceFilter = { apId?: number; networkId?: number; open?: boolean }

export function useDivergences(filter: DivergenceFilter = { open: true }, options: { enabled?: boolean } = {}) {
  const signedIn = useSignedIn()
  const params = new URLSearchParams()
  if (filter.apId) params.set('apId', String(filter.apId))
  if (filter.networkId) params.set('networkId', String(filter.networkId))
  if (filter.open !== false) params.set('open', '1')
  const qs = params.toString()
  return useQuery({
    queryKey: [...wifiConfigKey, 'divergences', qs] as const,
    queryFn: () => apiFetch<WifiDivergence[]>(`${V1}/wifi/divergences?${qs}`),
    enabled: signedIn && options.enabled !== false,
    refetchInterval: 15_000,
  })
}

export function useResolveDivergences() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { items: ResolveDivergenceItem[]; apply?: boolean; currentPassword?: string }) =>
      apiFetch<ResolveDivergencesResult>(
        `${V1}/wifi/divergences/resolve${applyParam(input.apply)}`,
        json('POST', {
          items: input.items,
          ...(input.currentPassword ? { currentPassword: input.currentPassword } : {}),
        }),
      ),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export type { DivergenceResolution }

// ── Adoption ────────────────────────────────────────────────────────────────

export function useAdoption(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...wifiConfigKey, 'adoption'] as const,
    queryFn: () => apiFetch<AdoptionView>(`${V1}/wifi/adoption`),
    enabled: options.enabled !== false,
    staleTime: 0,
  })
}

export function useAcceptAdoption() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: AdoptionAccept) => apiFetch<AdoptionResult>(`${V1}/wifi/adoption`, json('POST', body)),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

// ── Rollouts ────────────────────────────────────────────────────────────────

export function useRolloutPreview() {
  return useMutation({
    mutationFn: (request: RolloutPreviewRequest) =>
      apiFetch<ImpactPreview>(`${V1}/wifi/rollouts/preview`, json('POST', request)),
  })
}

export function useStartRollout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: RolloutRequest) => apiFetch<WifiRollout>(`${V1}/wifi/rollouts`, json('POST', request)),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

export function useRollouts(options: { limit?: number } = {}) {
  const limit = options.limit ?? 20
  return useInfiniteQuery({
    queryKey: [...wifiConfigKey, 'rollouts', limit] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<Paged<WifiRollout>>(`${V1}/wifi/rollouts?limit=${limit}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.items.some((r) => r.state === 'running') ? 3_000 : 15_000,
  })
}

/**
 * `GET /wifi/rollouts/current`: the active rollout (running, paused, or
 * stopped and waiting for Retry/Skip/Roll back/Cancel), or null. Only one
 * is active fleet-wide; `/wifi/config`'s `rollout` is the same one.
 */
export function useCurrentRollout(options: { enabled?: boolean } = {}) {
  const signedIn = useSignedIn()
  return useQuery({
    queryKey: [...wifiConfigKey, 'rollouts', 'current'] as const,
    queryFn: () => apiFetch<WifiRollout | null>(`${V1}/wifi/rollouts/current`),
    enabled: signedIn && options.enabled !== false,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 3_000 : 15_000),
    retry: false,
  })
}

/** The newest rollout for the app-wide banner lives in `components/wifi-config/rollout-banner.tsx` (key `['wifi-config', 'rollouts', 'latest']`), so the shell's entry chunk does not carry this module. */

export function useRollout(id: number | null) {
  return useQuery({
    queryKey: [...wifiConfigKey, 'rollout', id ?? 0] as const,
    queryFn: () => apiFetch<WifiRollout>(`${V1}/wifi/rollouts/${id}`),
    enabled: id !== null,
    // Running or paused: it moves (a stopped one waits for an admin).
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state === 'running' || state === 'paused' ? 2_000 : false
    },
  })
}

export function fetchRollout(id: number) {
  return apiFetch<WifiRollout>(`${V1}/wifi/rollouts/${id}`)
}

export function useRolloutAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; action: RolloutAction; apId?: number }) =>
      apiFetch<WifiRollout>(
        `${V1}/wifi/rollouts/${input.id}/${input.action}`,
        json('POST', input.apId !== undefined ? { apId: input.apId } : {}),
      ),
    onSuccess: (rollout) => {
      queryClient.setQueryData([...wifiConfigKey, 'rollout', rollout.id], rollout)
    },
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}

// ── Settings ────────────────────────────────────────────────────────────────

export const wifiConfigSettingsKey = ['settings', 'wifi-config'] as const

export function useWifiConfigSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: wifiConfigSettingsKey,
    queryFn: () => apiFetch<WifiConfigSettingsView>(`${V1}/settings/wifi-config`),
    enabled: options.enabled !== false,
    retry: false,
  })
}

export function useUpdateWifiConfigSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<WifiConfigSettings>) =>
      apiFetch<WifiConfigSettingsView>(`${V1}/settings/wifi-config`, json('PATCH', patch)),
    onSuccess: (view) => queryClient.setQueryData(wifiConfigSettingsKey, view),
    onSettled: () => invalidateWifiConfig(queryClient),
  })
}
