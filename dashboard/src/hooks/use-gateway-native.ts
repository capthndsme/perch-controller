import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { gatewaysQueryKey } from '@/hooks/use-gateways'
import { gatewayQueryKey } from '@/hooks/use-gateway-observation'
import { ApiError, apiFetch } from '@/lib/api'
import type {
  DhcpPool,
  DhcpReservation,
  DhcpTag,
  DnsSettingsPatch,
  DnsSettingsWrite,
  GatewayDhcp,
  GatewayDnsFull,
  GatewayRouting,
  NativeWrite,
  PoolPatch,
  ReservationPatch,
  RouteInput,
  StaticRoute,
  SystemConfig,
  SystemPatch,
  TagInput,
} from '@/types/gateway-native'

/**
 * The rest of native OpenWrt sync (docs/gateway/native-sync.md): DHCP, DNS
 * settings, routing and the system section. Reads hang under the config
 * plane's `['gateways', id]` tree, so an apply, confirm or revert anywhere
 * refreshes them; every write invalidates that tree (the apply banner wakes)
 * and the observation's `['gateway']` tree (the system facts).
 */

const base = (id: number) => `/api/v1/gateways/${id}`
const key = (id: number, part: string) => [...gatewaysQueryKey, id, part] as const

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

function stage(apply: boolean): string {
  return apply ? '' : '?apply=0'
}

/** 403/404 do not change by asking again. */
function retry(count: number, error: Error): boolean {
  if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return false
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

// ── DHCP ────────────────────────────────────────────────────────────────────

export function useGatewayDhcp(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0, 'dhcp'),
    queryFn: () => apiFetch<GatewayDhcp>(`${base(id!)}/dhcp`),
    enabled: id !== null,
    refetchInterval: 30_000,
    retry,
  })
}

export function useUpdatePool(id: number) {
  return useWrite((vars: { network: string; patch: PoolPatch; apply?: boolean }) =>
    apiFetch<NativeWrite<DhcpPool | null>>(
      `${base(id)}/dhcp/pools/${encodeURIComponent(vars.network)}${stage(vars.apply !== false)}`,
      json('PATCH', vars.patch),
    ),
  )
}

export function useCreateTag(id: number) {
  return useWrite((vars: { input: TagInput; apply?: boolean }) =>
    apiFetch<NativeWrite<DhcpTag | null>>(`${base(id)}/dhcp/tags${stage(vars.apply !== false)}`, json('POST', vars.input)),
  )
}

export function useUpdateTag(id: number) {
  return useWrite((vars: { perchId: string; input: TagInput; apply?: boolean }) =>
    apiFetch<NativeWrite<DhcpTag | null>>(
      `${base(id)}/dhcp/tags/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
      json('PATCH', { options: vars.input.options, force: vars.input.force }),
    ),
  )
}

export function useDeleteTag(id: number) {
  return useWrite((vars: { perchId: string; apply?: boolean }) =>
    apiFetch<NativeWrite<null>>(
      `${base(id)}/dhcp/tags/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
      json('DELETE'),
    ),
  )
}

export function useUpdateReservation(id: number) {
  return useWrite((vars: { perchId: string; patch: ReservationPatch; apply?: boolean }) =>
    apiFetch<NativeWrite<DhcpReservation | null>>(
      `${base(id)}/dhcp/reservations/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
      json('PATCH', vars.patch),
    ),
  )
}

// ── DNS ─────────────────────────────────────────────────────────────────────

export function useGatewayDnsFull(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0, 'dns'),
    queryFn: () => apiFetch<GatewayDnsFull>(`${base(id!)}/dns`),
    enabled: id !== null,
    retry,
  })
}

export function useUpdateDnsSettings(id: number) {
  return useWrite((vars: { patch: DnsSettingsPatch; apply?: boolean }) =>
    apiFetch<DnsSettingsWrite>(`${base(id)}/dns${stage(vars.apply !== false)}`, json('PATCH', vars.patch)),
  )
}

// ── Routing ─────────────────────────────────────────────────────────────────

export function useGatewayRouting(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0, 'routing'),
    queryFn: () => apiFetch<GatewayRouting>(`${base(id!)}/routing`),
    enabled: id !== null,
    refetchInterval: 30_000,
    retry,
  })
}

export function useSaveRoute(id: number) {
  return useWrite((vars: { perchId: string | null; input: RouteInput; apply?: boolean }) =>
    vars.perchId
      ? apiFetch<NativeWrite<StaticRoute | null>>(
          `${base(id)}/routing/routes/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
          json('PATCH', { ...vars.input, family: undefined }),
        )
      : apiFetch<NativeWrite<StaticRoute | null>>(
          `${base(id)}/routing/routes${stage(vars.apply !== false)}`,
          json('POST', vars.input),
        ),
  )
}

export function useDeleteRoute(id: number) {
  return useWrite((vars: { perchId: string; apply?: boolean }) =>
    apiFetch<NativeWrite<null>>(
      `${base(id)}/routing/routes/${encodeURIComponent(vars.perchId)}${stage(vars.apply !== false)}`,
      json('DELETE'),
    ),
  )
}

// ── System ──────────────────────────────────────────────────────────────────

export function useUpdateSystem(id: number) {
  return useWrite((vars: { patch: SystemPatch; apply?: boolean }) =>
    apiFetch<NativeWrite<SystemConfig>>(`${base(id)}/system${stage(vars.apply !== false)}`, json('PATCH', vars.patch)),
  )
}
