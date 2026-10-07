import { useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useProfile } from '@/hooks/use-auth'
import { useGateways } from '@/hooks/use-gateways'
import { useGatewayNetworks } from '@/hooks/use-networks'
import { sellQueryKey } from '@/hooks/use-sell-mode'
import { API_URL, ApiError, apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type {
  CreateVoucherBatchPayload,
  Portal,
  PortalApiClient,
  PortalApiClientPayload,
  PortalAuthorizePayload,
  PortalAuthorizeResult,
  PortalDelivery,
  PortalGatewayOption,
  PortalGrant,
  PortalGrantStateFilter,
  PortalNetworkOption,
  PortalPage,
  PortalPayload,
  PortalSession,
  PortalSettings,
  PortalSettingsView,
  PortalTemplate,
  PortalTemplatePreview,
  PortalUser,
  PortalUserPayload,
  Voucher,
  VoucherBatch,
  VoucherLookup,
} from '@/types/api'

/**
 * Guest portal REST (docs/gateway/portal.md §11–12). Every write invalidates
 * the whole `portal` key: the lists are small admin catalogs, and a write
 * (a revoke that promotes a queued grant, a batch revoke that ends grants)
 * often changes more than the row it names.
 */
export const portalQueryKey = ['portal'] as const
export const portalSettingsQueryKey = ['settings', 'portal'] as const

const BASE = '/api/v1/portal'

/**
 * Portal writes and the admin catalogs (vouchers, users, API clients,
 * templates, settings) are admin-only (403 `admin_required`); portals, grants
 * and sessions are readable by every signed-in user.
 */
export function useIsPortalAdmin(): { isAdmin: boolean; isPending: boolean } {
  const profile = useProfile()
  return { isAdmin: profile.data?.role === 'admin', isPending: profile.isPending }
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

export function usePortalMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: portalQueryKey })
      // Desk sales and price tables shape Sell Mode's menu (and whether it is offered).
      void queryClient.invalidateQueries({ queryKey: sellQueryKey })
    },
  })
}

// ── Portals ──────────────────────────────────────────────────────────────

export function usePortals(options: { gatewayId?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'portals', options.gatewayId ?? 'all'] as const,
    queryFn: () => apiFetch<Portal[]>(`${BASE}/portals${qs({ gatewayId: options.gatewayId })}`),
    enabled: options.enabled,
    refetchInterval: 15_000,
  })
}

export function usePortal(id: number | null) {
  return useQuery({
    queryKey: [...portalQueryKey, 'portal', id] as const,
    queryFn: () => apiFetch<Portal>(`${BASE}/portals/${id}`),
    enabled: id !== null,
    refetchInterval: 10_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  })
}

export function useCreatePortal() {
  return usePortalMutation((payload: PortalPayload) =>
    apiFetch<{ portal: Portal; delivery: PortalDelivery }>(`${BASE}/portals`, json('POST', payload)),
  )
}

export function useUpdatePortal() {
  return usePortalMutation(({ id, ...payload }: PortalPayload & { id: number }) =>
    apiFetch<{ portal: Portal; delivery: PortalDelivery }>(`${BASE}/portals/${id}`, json('PATCH', payload)),
  )
}

export function useDeletePortal() {
  return usePortalMutation(({ id, force }: { id: number; force?: boolean }) =>
    apiFetch<void>(`${BASE}/portals/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' }),
  )
}

// ── Gateways and networks (config plane, docs/gateway/config-plane.md §10) ─

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404

/**
 * The gateways a portal can be created on, from the shared `['gateways']`
 * query. `null` data = the controller has no gateway list (a build without
 * the config plane's REST): the create form then offers the gateways of
 * existing portals and a typed id.
 */
export function usePortalGateways(): { data: PortalGatewayOption[] | null | undefined; isPending: boolean } {
  const gateways = useGateways()
  const data = useMemo(() => {
    if (notFound(gateways.error)) return null
    return gateways.data?.map((g) => ({
      id: g.id,
      collectorId: g.collectorId,
      name: g.name,
      online: g.online,
      mode: g.mode,
    }))
  }, [gateways.data, gateways.error])
  return { data, isPending: gateways.isPending && !gateways.error }
}

/**
 * The gateway's networks that have an interface section (what a portal
 * stores), from the networks REST; `null` = not available (see above).
 */
export function usePortalNetworks(gatewayId: number | null): {
  data: PortalNetworkOption[] | null | undefined
  isPending: boolean
} {
  const networks = useGatewayNetworks(gatewayId)
  const data = useMemo(() => {
    if (notFound(networks.error)) return null
    return networks.data
      ?.filter((n) => n.perchId !== null && !n.deleting)
      .map((n) => ({
        perchId: n.perchId!,
        name: n.key,
        label: n.label,
        purpose: n.purpose,
        proto: n.proto,
        ipaddr: n.ipv4,
        management: n.management,
      }))
  }, [networks.data, networks.error])
  return { data, isPending: gatewayId !== null && networks.isPending && !networks.error }
}

// ── Grants and sessions ──────────────────────────────────────────────────

export type GrantFilters = {
  portalId?: number
  gatewayId?: number
  voucherId?: number
  state?: PortalGrantStateFilter
  mac?: string
  source?: string
  limit?: number
  offset?: number
}

export function usePortalGrants(filters: GrantFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'grants', filters] as const,
    queryFn: () => apiFetch<PortalPage<PortalGrant>>(`${BASE}/grants${qs(filters)}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled,
    refetchInterval: 10_000,
  })
}

export function useExtendGrant() {
  return usePortalMutation(({ id, minutes, bytes }: { id: number; minutes?: number; bytes?: number }) =>
    apiFetch<{ grant: PortalGrant; delivery: PortalDelivery }>(
      `${BASE}/grants/${id}/extend`,
      json('POST', { minutes, bytes }),
    ),
  )
}

export function useRevokeGrant() {
  return usePortalMutation((id: number) =>
    apiFetch<{ grant: PortalGrant; delivery: PortalDelivery }>(`${BASE}/grants/${id}/revoke`, json('POST')),
  )
}

/** Admin grant through the authorize API (an admin's dashboard token is accepted there). */
export function useAuthorizeDevice() {
  return usePortalMutation((payload: PortalAuthorizePayload) =>
    apiFetch<PortalAuthorizeResult>(`${BASE}/authorizations`, json('POST', payload)),
  )
}

export type SessionFilters = {
  portalId?: number
  gatewayId?: number
  grantId?: number
  mac?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export function usePortalSessions(filters: SessionFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'sessions', filters] as const,
    queryFn: () => apiFetch<PortalPage<PortalSession>>(`${BASE}/sessions${qs(filters)}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled,
    refetchInterval: 30_000,
  })
}

// ── Vouchers ─────────────────────────────────────────────────────────────

export function useVoucherBatches(options: { portalId?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'batches', options.portalId ?? 'all'] as const,
    queryFn: () => apiFetch<VoucherBatch[]>(`${BASE}/voucher-batches${qs({ portalId: options.portalId })}`),
    enabled: options.enabled,
    refetchInterval: 30_000,
  })
}

export function useVoucherBatch(id: number | null) {
  return useQuery({
    queryKey: [...portalQueryKey, 'batch', id] as const,
    queryFn: () => apiFetch<{ batch: VoucherBatch; vouchers: Voucher[] }>(`${BASE}/voucher-batches/${id}`),
    enabled: id !== null,
    refetchInterval: 30_000,
  })
}

/**
 * The batch with its codes (print sheet, code list). Codes are secrets: never
 * refetched in the background and dropped from the cache once unused.
 */
export function useVoucherCodes(id: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'batch-codes', id] as const,
    queryFn: () =>
      apiFetch<{ batch: VoucherBatch; vouchers: Voucher[] }>(`${BASE}/voucher-batches/${id}/codes`),
    enabled: id !== null && options.enabled !== false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
  })
}

export function useCreateVoucherBatch() {
  return usePortalMutation((payload: CreateVoucherBatchPayload) =>
    apiFetch<{ batch: VoucherBatch; codes: string[]; delivery: PortalDelivery }>(
      `${BASE}/voucher-batches`,
      json('POST', payload),
    ),
  )
}

export function useRevokeVoucherBatch() {
  return usePortalMutation((id: number) =>
    apiFetch<{ batch: VoucherBatch; delivery: PortalDelivery }>(`${BASE}/voucher-batches/${id}/revoke`, json('POST')),
  )
}

export function useDeleteVoucherBatch() {
  return usePortalMutation((id: number) =>
    apiFetch<void>(`${BASE}/voucher-batches/${id}`, { method: 'DELETE' }),
  )
}

export function useRevokeVoucher() {
  return usePortalMutation((id: number) =>
    apiFetch<{ voucher: Voucher; delivery: PortalDelivery }>(`${BASE}/vouchers/${id}/revoke`, json('POST')),
  )
}

export function useLookupVoucher() {
  return useMutation({
    mutationFn: (code: string) => apiFetch<VoucherLookup>(`${BASE}/vouchers/lookup`, json('POST', { code })),
  })
}

/** Saves the batch's server-side CSV (a bearer-authenticated download, so no plain link). */
export async function downloadVoucherCsv(batchId: number): Promise<void> {
  const token = useAuthStore.getState().token
  const response = await fetch(`${API_URL}${BASE}/voucher-batches/${batchId}/codes.csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(response.status, body?.message ?? `API ${response.status}`, body)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `perch-vouchers-batch-${batchId}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// ── Portal users ─────────────────────────────────────────────────────────

export function usePortalUsers(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'users'] as const,
    queryFn: () => apiFetch<PortalUser[]>(`${BASE}/users`),
    enabled: options.enabled,
  })
}

export function useCreatePortalUser() {
  return usePortalMutation((payload: PortalUserPayload) =>
    apiFetch<PortalUser>(`${BASE}/users`, json('POST', payload)),
  )
}

export function useUpdatePortalUser() {
  return usePortalMutation(({ id, ...payload }: PortalUserPayload & { id: number }) =>
    apiFetch<PortalUser>(`${BASE}/users/${id}`, json('PATCH', payload)),
  )
}

export function useSetPortalUserPassword() {
  return usePortalMutation(({ id, password }: { id: number; password: string }) =>
    apiFetch<void>(`${BASE}/users/${id}/password`, json('PUT', { password })),
  )
}

export function useDeletePortalUser() {
  return usePortalMutation((id: number) => apiFetch<void>(`${BASE}/users/${id}`, { method: 'DELETE' }))
}

// ── API clients ──────────────────────────────────────────────────────────

export function usePortalApiClients(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'api-clients'] as const,
    queryFn: () => apiFetch<PortalApiClient[]>(`${BASE}/api-clients`),
    enabled: options.enabled,
  })
}

export function useCreatePortalApiClient() {
  return usePortalMutation((payload: PortalApiClientPayload) =>
    apiFetch<{ client: PortalApiClient; token: string }>(`${BASE}/api-clients`, json('POST', payload)),
  )
}

export function useUpdatePortalApiClient() {
  return usePortalMutation(({ id, ...payload }: PortalApiClientPayload & { id: number }) =>
    apiFetch<PortalApiClient>(`${BASE}/api-clients/${id}`, json('PATCH', payload)),
  )
}

export function useRotatePortalApiClient() {
  return usePortalMutation((id: number) =>
    apiFetch<{ client: PortalApiClient; token: string }>(`${BASE}/api-clients/${id}/rotate`, json('POST')),
  )
}

export function useRevokePortalApiClient() {
  return usePortalMutation((id: number) => apiFetch<void>(`${BASE}/api-clients/${id}`, { method: 'DELETE' }))
}

// ── Templates ────────────────────────────────────────────────────────────

export function usePortalTemplates(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'templates'] as const,
    queryFn: () => apiFetch<PortalTemplate[]>(`${BASE}/templates`),
    enabled: options.enabled,
  })
}

export function usePortalTemplate(id: number | null) {
  return useQuery({
    queryKey: [...portalQueryKey, 'template', id] as const,
    queryFn: () => apiFetch<PortalTemplate>(`${BASE}/templates/${id}`),
    enabled: id !== null,
  })
}

export type TemplatePreviewParams = { page: 'login' | 'status'; message?: string; portalId?: number }

/** The preview as JSON `{html}` for a sandboxed iframe (never served as a document). */
export function usePortalTemplatePreview(id: number | null, params: TemplatePreviewParams) {
  return useQuery({
    queryKey: [...portalQueryKey, 'template-preview', id, params] as const,
    queryFn: () => apiFetch<PortalTemplatePreview>(`${BASE}/templates/${id}/preview${qs(params)}`),
    enabled: id !== null,
    placeholderData: keepPreviousData,
  })
}

function filesForm(fields: Record<string, string>, files: Array<{ field: string; file: File; name?: string }>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  for (const { field, file, name } of files) form.append(field, file, name ?? file.name)
  return form
}

export function useCreatePortalTemplate() {
  return usePortalMutation(({ name, files }: { name: string; files: File[] }) =>
    apiFetch<PortalTemplate>(`${BASE}/templates`, {
      method: 'POST',
      body: filesForm({ name }, files.map((file) => ({ field: 'files', file }))),
    }),
  )
}

export function useDuplicatePortalTemplate() {
  return usePortalMutation(({ id, name }: { id: number; name: string }) =>
    apiFetch<PortalTemplate>(`${BASE}/templates/${id}/duplicate`, json('POST', { name })),
  )
}

export function useRenamePortalTemplate() {
  return usePortalMutation(({ id, name }: { id: number; name: string }) =>
    apiFetch<PortalTemplate>(`${BASE}/templates/${id}`, json('PATCH', { name })),
  )
}

export function useDeletePortalTemplate() {
  return usePortalMutation((id: number) => apiFetch<void>(`${BASE}/templates/${id}`, { method: 'DELETE' }))
}

export function usePutPortalTemplateFile() {
  return usePortalMutation(({ id, name, file }: { id: number; name: string; file: File }) =>
    apiFetch<PortalTemplate>(`${BASE}/templates/${id}/files/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: filesForm({}, [{ field: 'file', file, name }]),
    }),
  )
}

export function useDeletePortalTemplateFile() {
  return usePortalMutation(({ id, name }: { id: number; name: string }) =>
    apiFetch<PortalTemplate>(`${BASE}/templates/${id}/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  )
}

// ── Settings → Guest portal ──────────────────────────────────────────────

export function usePortalSettings() {
  return useQuery({
    queryKey: portalSettingsQueryKey,
    queryFn: () => apiFetch<PortalSettingsView>('/api/v1/settings/portal'),
  })
}

export function useUpdatePortalSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: Partial<PortalSettings>) =>
      apiFetch<PortalSettingsView>('/api/v1/settings/portal', json('PATCH', payload)),
    onSuccess: (data) => {
      queryClient.setQueryData(portalSettingsQueryKey, data)
    },
  })
}
