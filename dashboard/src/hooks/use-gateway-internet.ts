import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gatewayQueryKey } from '@/hooks/use-gateway-observation'
import { gatewaysQueryKey } from '@/hooks/use-gateways'
import { ApiError, apiFetch } from '@/lib/api'
import type {
  DdnsOverview,
  DdnsServiceInput,
  DdnsServicePatch,
  DdnsServiceView,
  MultiwanView,
  WanAlias,
  WanHistory,
  WanOverview,
  WanPatch,
  WanView,
  WriteAnswer,
} from '@/types/gateway-sync'

/**
 * The Internet page (design gateway-sync dashboard.md 2, rest.md 3, 9, 10):
 * WAN uplinks and their order, extra addresses, dynamic DNS and the
 * read-only multi-WAN view. The WAN overview polls every 10 s while the page
 * is visible (TanStack stops in the background). Writes stage with `apply`
 * false so the review dialog shows the diff and checks before anything runs.
 */

const base = (id: number) => `/api/v1/gateways/${id}`
const key = (id: number, ...rest: string[]) => [...gatewaysQueryKey, id, 'sync', ...rest] as const
const stage = (apply: boolean | undefined) => (apply === false ? '?apply=0' : '')

function retry(count: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  return count < 2
}

function send(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

function useWrite<Vars, Result>(fn: (vars: Vars) => Promise<Result>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: gatewaysQueryKey }),
        queryClient.invalidateQueries({ queryKey: gatewayQueryKey }),
      ]),
  })
}

export function useWanOverview(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0, 'wan'),
    queryFn: () => apiFetch<WanOverview>(`${base(id!)}/wan`),
    enabled: id !== null,
    refetchInterval: 10_000,
    retry,
  })
}

export function useWanHistory(id: number | null, range: '24h' | '7d' | '30d') {
  return useQuery({
    queryKey: key(id ?? 0, 'wan', 'history', range),
    queryFn: () => apiFetch<WanHistory>(`${base(id!)}/wan/history?range=${range}`),
    enabled: id !== null,
    refetchInterval: 60_000,
    retry,
  })
}

export function useUpdateWan(id: number) {
  return useWrite((vars: { perchId: string; patch: WanPatch; apply?: boolean }) =>
    apiFetch<WriteAnswer<WanView>>(
      `${base(id)}/wan/${encodeURIComponent(vars.perchId)}${stage(vars.apply)}`,
      send('PATCH', vars.patch),
    ),
  )
}

export function useOrderWans(id: number) {
  return useWrite((vars: { ids: string[]; apply?: boolean }) =>
    apiFetch<WriteAnswer<WanOverview>>(`${base(id)}/wan/order${stage(vars.apply)}`, send('PUT', { ids: vars.ids })),
  )
}

export function useCreateWanAlias(id: number) {
  return useWrite((vars: { wanId: string; network: string; addresses: string[]; apply?: boolean }) =>
    apiFetch<WriteAnswer<WanAlias>>(
      `${base(id)}/wan/${encodeURIComponent(vars.wanId)}/aliases${stage(vars.apply)}`,
      send('POST', { network: vars.network, addresses: vars.addresses }),
    ),
  )
}

export function useUpdateWanAlias(id: number) {
  return useWrite((vars: { perchId: string; addresses: string[]; apply?: boolean }) =>
    apiFetch<WriteAnswer<WanAlias>>(
      `${base(id)}/wan/aliases/${encodeURIComponent(vars.perchId)}${stage(vars.apply)}`,
      send('PATCH', { addresses: vars.addresses }),
    ),
  )
}

export function useDeleteWanAlias(id: number) {
  return useWrite((vars: { perchId: string; apply?: boolean }) =>
    apiFetch<WriteAnswer<null>>(
      `${base(id)}/wan/aliases/${encodeURIComponent(vars.perchId)}${stage(vars.apply)}`,
      send('DELETE'),
    ),
  )
}

export function useMultiwan(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0, 'multiwan'),
    queryFn: () => apiFetch<MultiwanView>(`${base(id!)}/multiwan`),
    enabled: id !== null,
    refetchInterval: 30_000,
    retry,
  })
}

export function useDdns(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0, 'ddns'),
    queryFn: () => apiFetch<DdnsOverview>(`${base(id!)}/ddns`),
    enabled: id !== null,
    refetchInterval: 30_000,
    retry,
  })
}

export function useSaveDdnsService(id: number) {
  return useWrite(
    (vars: { perchId: string | null; input: DdnsServiceInput | DdnsServicePatch; apply?: boolean }) =>
      apiFetch<WriteAnswer<DdnsServiceView>>(
        vars.perchId
          ? `${base(id)}/ddns/services/${encodeURIComponent(vars.perchId)}${stage(vars.apply)}`
          : `${base(id)}/ddns/services${stage(vars.apply)}`,
        send(vars.perchId ? 'PATCH' : 'POST', vars.input),
      ),
  )
}

export function useDeleteDdnsService(id: number) {
  return useWrite((vars: { perchId: string }) =>
    apiFetch<WriteAnswer<null>>(`${base(id)}/ddns/services/${encodeURIComponent(vars.perchId)}`, send('DELETE')),
  )
}

export function useDdnsUpdateNow(id: number) {
  return useWrite((vars: { perchId: string }) =>
    apiFetch<{ started: boolean }>(
      `${base(id)}/ddns/services/${encodeURIComponent(vars.perchId)}/update-now`,
      send('POST'),
    ),
  )
}
