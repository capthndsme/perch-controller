import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { gatewaysQueryKey } from '@/hooks/use-gateways'
import { gatewayQueryKey } from '@/hooks/use-gateway-observation'
import { ApiError, apiFetch } from '@/lib/api'
import type {
  AmbiguitiesView,
  AmbiguityResolveAnswer,
  AmbiguityResolveRequest,
  ConfirmApplyBody,
  FirewallDefaultsPatch,
  FirewallDefaultsView,
  GatewayApplyWithChecks,
  GatewaySyncSettingsPatch,
  GatewaySyncSettingsView,
  UpnpAclInput,
  UpnpAclPatch,
  UpnpAclRule,
  UpnpConfigPatch,
  UpnpConfigView,
  UpnpDeviceBlockAnswer,
  UpnpMappingRef,
  UpnpMappingsDeleteAnswer,
  WriteAnswer,
} from '@/types/gateway-sync'

/**
 * Gateway sync's shared hooks (the apply confirm with checks) and those of
 * work package D4: the ambiguity flow, firewall defaults, UPnP. Reads hang
 * under the config plane's `['gateways', id]` tree, so an apply, confirm or
 * revert anywhere refreshes them; every write invalidates that tree (the
 * apply banner wakes, the firewall page reloads) and the observation's
 * `['gateway']` tree (UPnP mappings). Contracts: rest.md 2, 6, 7, 8.
 */

const base = (id: number) => `/api/v1/gateways/${id}`
const key = (id: number, part: string) => [...gatewaysQueryKey, id, 'sync', part] as const

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

function stage(apply: boolean): string {
  return apply ? '' : '?apply=0'
}

/** A 4xx (or a 501 stub) does not change by asking again. */
function retry(count: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  if (error instanceof ApiError && error.status === 501) return false
  return count < 2
}

function invalidate(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: gatewaysQueryKey }),
    queryClient.invalidateQueries({ queryKey: gatewayQueryKey }),
  ])
}

function useWrite<Vars, Result>(fn: (vars: Vars) => Promise<Result>) {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: fn, onSettled: () => invalidate(queryClient) })
}

// ── Applies: confirm with checks (rest.md 2) ────────────────────────────────

/**
 * "Keep changes" with a body: `{ overrideChecks: true, confirm: <gateway name> }`
 * keeps a change whose checks cannot pass (an ISP outage). Refusals 409
 * `checks_pending` / `checks_failed`, 422 `confirm_mismatch`.
 */
export function useConfirmApplyWithChecks() {
  return useWrite((input: { gatewayId: number; applyId: string; body: ConfirmApplyBody }) =>
    apiFetch<GatewayApplyWithChecks>(
      `${base(input.gatewayId)}/applies/${encodeURIComponent(input.applyId)}/confirm`,
      json('POST', input.body),
    ),
  )
}

// ── Ambiguities (rest.md 6) ─────────────────────────────────────────────────

export function useAmbiguities(id: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: key(id ?? 0, 'ambiguities'),
    queryFn: () => apiFetch<AmbiguitiesView>(`${base(id!)}/ambiguities`),
    enabled: id !== null && options.enabled !== false,
    refetchInterval: 30_000,
    retry,
  })
}

export function useResolveAmbiguities(id: number) {
  return useWrite((vars: { request: AmbiguityResolveRequest; apply?: boolean }) =>
    apiFetch<AmbiguityResolveAnswer>(
      `${base(id)}/ambiguities/resolve${stage(vars.apply !== false)}`,
      json('POST', vars.request),
    ),
  )
}

// ── Firewall defaults (rest.md 7) ───────────────────────────────────────────

export function useFirewallDefaults(id: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: key(id ?? 0, 'firewall-defaults'),
    queryFn: () => apiFetch<FirewallDefaultsView>(`${base(id!)}/firewall/defaults`),
    enabled: id !== null && options.enabled !== false,
    refetchInterval: 30_000,
    retry,
  })
}

export function useUpdateFirewallDefaults(id: number) {
  return useWrite((vars: { patch: FirewallDefaultsPatch; apply?: boolean }) =>
    apiFetch<WriteAnswer<FirewallDefaultsView>>(
      `${base(id)}/firewall/defaults${stage(vars.apply !== false)}`,
      json('PATCH', vars.patch),
    ),
  )
}

// ── UPnP (rest.md 8) ────────────────────────────────────────────────────────

export function useUpnpConfig(id: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: key(id ?? 0, 'upnp'),
    queryFn: () => apiFetch<UpnpConfigView>(`${base(id!)}/upnp/config`),
    enabled: id !== null && options.enabled !== false,
    refetchInterval: 15_000,
    retry,
  })
}

export function useUpdateUpnpConfig(id: number) {
  return useWrite((vars: { patch: UpnpConfigPatch; apply?: boolean }) =>
    apiFetch<WriteAnswer<UpnpConfigView>>(`${base(id)}/upnp/config${stage(vars.apply !== false)}`, json('PATCH', vars.patch)),
  )
}

export function useSaveUpnpAcl(id: number) {
  return useWrite((vars: { perchId: string | null; input: UpnpAclInput | UpnpAclPatch; apply?: boolean }) =>
    vars.perchId
      ? apiFetch<WriteAnswer<UpnpAclRule>>(
          `${base(id)}/upnp/acl/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
          json('PATCH', vars.input),
        )
      : apiFetch<WriteAnswer<UpnpAclRule>>(`${base(id)}/upnp/acl${stage(vars.apply !== false)}`, json('POST', vars.input)),
  )
}

export function useDeleteUpnpAcl(id: number) {
  return useWrite((vars: { perchId: string; apply?: boolean }) =>
    apiFetch<WriteAnswer<null>>(
      `${base(id)}/upnp/acl/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
      json('DELETE'),
    ),
  )
}

export function useOrderUpnpAcl(id: number) {
  return useWrite((vars: { ids: string[]; apply?: boolean }) =>
    apiFetch<WriteAnswer<UpnpConfigView>>(`${base(id)}/upnp/acl/order${stage(vars.apply !== false)}`, json('PUT', { ids: vars.ids })),
  )
}

/** Runtime, no apply: the router drops the mappings now (clients may open them again). */
export function useDeleteUpnpMappings(id: number) {
  return useWrite((mappings: UpnpMappingRef[]) =>
    apiFetch<UpnpMappingsDeleteAnswer>(`${base(id)}/upnp/mappings/delete`, json('POST', { mappings })),
  )
}

export function useBlockUpnpDevice(id: number) {
  return useWrite((vars: { mac: string; blocked: boolean; apply?: boolean }) =>
    apiFetch<UpnpDeviceBlockAnswer>(
      `${base(id)}/upnp/devices/${encodeURIComponent(vars.mac)}${stage(vars.apply !== false)}`,
      json('PUT', { blocked: vars.blocked }),
    ),
  )
}

// ── Settings → Gateway sync (rest.md 11) ────────────────────────────────────

export const gatewaySyncSettingsKey = ['settings', 'gateway-sync'] as const

export function useGatewaySyncSettings() {
  return useQuery({
    queryKey: gatewaySyncSettingsKey,
    queryFn: () => apiFetch<GatewaySyncSettingsView>('/api/v1/settings/gateway-sync'),
    retry,
  })
}

/** Partial: fields left out keep their value. Turning multi-WAN writes on needs `currentPassword`. */
export function useUpdateGatewaySyncSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: GatewaySyncSettingsPatch) =>
      apiFetch<GatewaySyncSettingsView>('/api/v1/settings/gateway-sync', json('PATCH', patch)),
    onSuccess: (data) => {
      queryClient.setQueryData(gatewaySyncSettingsKey, data)
      void invalidate(queryClient)
    },
  })
}
