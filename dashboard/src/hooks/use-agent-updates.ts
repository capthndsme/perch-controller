import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { API_URL, ApiError, apiFetch } from '@/lib/api'
import { isOpenJob, isOpenRollout, secondsUntil } from '@/lib/agent-updates'
import { useNow } from '@/hooks/use-now'
import { useAuthStore } from '@/stores/auth-store'
import type {
  AgentArtefact,
  AgentFleet,
  AgentProduct,
  AgentRelease,
  AgentReleaseDetail,
  AgentRollout,
  AgentUpdateDevice,
  AgentUpdateJob,
  AgentUpdateSettings,
  AgentUpdateSettingsView,
  CreateRolloutRequest,
  DeviceKind,
  DeviceSettingsPatch,
  EventsPage,
  EventsQuery,
  JobsPage,
  JobsQuery,
  PreflightRequest,
  PreflightResponse,
  ReleaseCheckResult,
  UpdateRequest,
} from '@/types/agent-updates'

/**
 * Settings → Updates (controller.md sections 9 and 10). Every key starts with
 * `['agent-updates']`, so a write refreshes the whole page at once.
 */
export const agentUpdatesQueryKey = ['agent-updates'] as const

const BASE = '/api/v1/agent-updates'
const SETTINGS = '/api/v1/settings/agent-updates'

/** While something moves (an open job or rollout) the page polls every 5 s, else every 30 s. */
const LIVE_MS = 5_000
const IDLE_MS = 30_000

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function fleetIsLive(fleet: AgentFleet | undefined): boolean {
  return Boolean(fleet && (fleet.openRollouts.length > 0 || fleet.devices.some((d) => d.activeJob !== null)))
}

export function useAgentFleet(product?: AgentProduct | null) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'fleet', product ?? null],
    queryFn: () => apiFetch<AgentFleet>(`${BASE}/fleet${qs({ product })}`),
    refetchInterval: (query) => (fleetIsLive(query.state.data) ? LIVE_MS : IDLE_MS),
  })
}

export function useAgentJobs(query: JobsQuery, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'jobs', query],
    queryFn: () => apiFetch<JobsPage>(`${BASE}/jobs${qs(query)}`),
    enabled: options.enabled !== false,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => isOpenJob(j.state)) ? LIVE_MS : IDLE_MS),
  })
}

export function useAgentJob(id: number | null) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'job', id],
    queryFn: () => apiFetch<AgentUpdateJob>(`${BASE}/jobs/${id}`),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data && isOpenJob(q.state.data.state) ? LIVE_MS : false),
  })
}

export function useAgentReleases(product?: AgentProduct | null, includeWithdrawn = false) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'releases', product ?? null, includeWithdrawn],
    queryFn: () =>
      apiFetch<{ releases: AgentRelease[] }>(`${BASE}/releases${qs({ product, includeWithdrawn })}`).then(
        (r) => r.releases,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: IDLE_MS,
  })
}

export function useAgentRelease(id: number | null) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'release', id],
    queryFn: () => apiFetch<AgentReleaseDetail>(`${BASE}/releases/${id}`),
    enabled: id !== null,
  })
}

export function useAgentRollouts(state: 'open' | 'all' = 'all', product?: AgentProduct | null) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'rollouts', state, product ?? null],
    queryFn: () =>
      apiFetch<{ rollouts: AgentRollout[] }>(`${BASE}/rollouts${qs({ state, product })}`).then((r) => r.rollouts),
    refetchInterval: (q) => (q.state.data?.some((r) => isOpenRollout(r.state)) ? LIVE_MS : IDLE_MS),
  })
}

export function useAgentRollout(id: number | null) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'rollout', id],
    queryFn: () => apiFetch<AgentRollout>(`${BASE}/rollouts/${id}`),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data && !isOpenRollout(q.state.data.state) ? IDLE_MS : LIVE_MS),
  })
}

export type RolloutMember = { rolloutId: number; state: 'pending' | 'running'; isCanary: boolean }

/**
 * Which devices an open rollout still has to update: device key → its
 * rollout, from the fleet rows' `rollout` (no request per rollout). `ids`
 * limits it to those rollouts.
 */
export function useOpenRolloutMembers(ids: number[]): Map<string, RolloutMember> {
  const fleet = useAgentFleet()
  const members = new Map<string, RolloutMember>()
  for (const device of fleet.data?.devices ?? []) {
    const r = device.rollout
    if (!r || !isOpenRollout(r.state) || !ids.includes(r.id)) continue
    members.set(device.key, { rolloutId: r.id, state: r.deviceState, isCanary: r.isCanary })
  }
  return members
}

/** The audit trail, newest first, a page at a time (`nextBefore`). */
export function useAgentUpdateEvents(filters: EventsQuery, options: { enabled?: boolean; live?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: [...agentUpdatesQueryKey, 'events', filters],
    queryFn: ({ pageParam }) =>
      apiFetch<EventsPage>(`${BASE}/events${qs({ ...filters, before: pageParam ?? undefined })}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: options.enabled !== false,
    placeholderData: keepPreviousData,
    refetchInterval: options.live ? LIVE_MS : IDLE_MS,
  })
}

export function useAgentUpdateSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...agentUpdatesQueryKey, 'settings'],
    queryFn: () => apiFetch<AgentUpdateSettingsView>(SETTINGS),
    enabled: options.enabled !== false,
  })
}

/** Seconds left to an ISO deadline, re-read every second while `active`. */
export function useSecondsLeft(deadline: string | null, active = true): number | null {
  const now = useNow(1000, active && deadline !== null)
  return secondsUntil(deadline, now)
}

// ── Writes (admin) ─────────────────────────────────────────────────────────

function useAgentUpdatesMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: agentUpdatesQueryKey })
    },
  })
}

type DeviceTarget = { kind: DeviceKind; id: number }

const devicePath = ({ kind, id }: DeviceTarget) => `${BASE}/devices/${kind}/${id}`

export function useUpdateAgentDevice() {
  return useAgentUpdatesMutation(({ kind, id, ...patch }: DeviceTarget & DeviceSettingsPatch) =>
    apiFetch<AgentUpdateDevice>(devicePath({ kind, id }), json('PATCH', patch)),
  )
}

export function useRefreshAgentDevice() {
  return useAgentUpdatesMutation((target: DeviceTarget) =>
    apiFetch<AgentUpdateDevice>(`${devicePath(target)}/refresh`, json('POST', {})),
  )
}

/** A dry run: the device verifies and measures without downloading or installing. Writes nothing but an event. */
export function useAgentPreflight() {
  return useMutation({
    mutationFn: ({ kind, id, ...request }: DeviceTarget & PreflightRequest) =>
      apiFetch<PreflightResponse>(`${devicePath({ kind, id })}/preflight`, json('POST', request)),
  })
}

export function useStartAgentUpdate() {
  return useAgentUpdatesMutation(({ kind, id, ...request }: DeviceTarget & UpdateRequest) =>
    apiFetch<AgentUpdateJob>(`${devicePath({ kind, id })}/update`, json('POST', request)),
  )
}

export function useRollbackAgent() {
  return useAgentUpdatesMutation(({ kind, id, acceptUnrecoverable }: DeviceTarget & { acceptUnrecoverable?: boolean }) =>
    apiFetch<AgentUpdateJob>(`${devicePath({ kind, id })}/rollback`, json('POST', { acceptUnrecoverable })),
  )
}

export function useAbortAgentJob() {
  return useAgentUpdatesMutation((jobId: number) =>
    apiFetch<AgentUpdateJob>(`${BASE}/jobs/${jobId}/abort`, json('POST', {})),
  )
}

export function useCheckReleases() {
  return useAgentUpdatesMutation(() => apiFetch<ReleaseCheckResult>(`${BASE}/releases/check`, json('POST', {})))
}

export function useWithdrawRelease() {
  return useAgentUpdatesMutation(({ id, withdrawn }: { id: number; withdrawn: boolean }) =>
    apiFetch<AgentRelease>(`${BASE}/releases/${id}`, json('PATCH', { withdrawn })),
  )
}

export function useDeleteRelease() {
  return useAgentUpdatesMutation((id: number) => apiFetch<void>(`${BASE}/releases/${id}`, json('DELETE')))
}

export function useCreateRollout() {
  return useAgentUpdatesMutation((request: CreateRolloutRequest) =>
    apiFetch<AgentRollout>(`${BASE}/rollouts`, json('POST', request)),
  )
}

export function useRolloutAction() {
  return useAgentUpdatesMutation(
    ({ id, action, skipFailed }: { id: number; action: 'pause' | 'resume' | 'cancel'; skipFailed?: boolean }) =>
      apiFetch<AgentRollout>(
        `${BASE}/rollouts/${id}/${action}`,
        json('POST', action === 'resume' ? { skipFailed: skipFailed ?? false } : {}),
      ),
  )
}

export function useUpdateAgentUpdateSettings() {
  return useAgentUpdatesMutation((patch: Partial<AgentUpdateSettings>) =>
    apiFetch<AgentUpdateSettingsView>(SETTINGS, json('PATCH', patch)),
  )
}

// ── Uploads (a local build) ────────────────────────────────────────────────

/** Base64 of the manifest's exact bytes: the controller stores and serves them unchanged. */
export async function base64OfFile(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Step one: the manifest and its signature (201 new, 200 when the identical manifest exists). */
export function createRelease(manifest: string, signature: string) {
  return apiFetch<AgentRelease>(`${BASE}/releases`, json('POST', { manifest, signature }))
}

/**
 * Step two, once per file: `PUT /releases/:id/files/:file`, multipart with
 * one part `file`. XMLHttpRequest rather than fetch, for the upload progress.
 */
export function uploadArtefact(
  releaseId: number,
  file: File,
  onProgress: (sentBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<AgentArtefact> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${API_URL}${BASE}/releases/${releaseId}/files/${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('Accept', 'application/json')
    const token = useAuthStore.getState().token
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size)
    xhr.onerror = () => reject(new ApiError(0, 'The upload was interrupted.', null))
    xhr.onabort = () => reject(new ApiError(0, 'The upload was cancelled.', null))
    xhr.onload = () => {
      let parsed: unknown
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        parsed = xhr.responseText
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = (parsed as { data?: AgentArtefact } | null)?.data
        resolve(data ?? (parsed as AgentArtefact))
        return
      }
      const message =
        typeof parsed === 'object' && parsed !== null && typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : `API ${xhr.status}: ${xhr.statusText}`
      reject(new ApiError(xhr.status, message, parsed))
    }
    signal?.addEventListener('abort', () => xhr.abort())
    const form = new FormData()
    form.append('file', file, file.name)
    xhr.send(form)
  })
}
