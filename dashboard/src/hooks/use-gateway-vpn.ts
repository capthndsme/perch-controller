import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gatewayQueryKey } from '@/hooks/use-gateway-observation'
import { gatewaysQueryKey } from '@/hooks/use-gateways'
import { ApiError, apiFetch } from '@/lib/api'
import type {
  WgInterfaceCreate,
  WgInterfacePatch,
  WgInterfaceView,
  WgOverview,
  WgPeerCreate,
  WgPeerCreateAnswer,
  WgPeerPatch,
  WgPeerView,
  WriteAnswer,
} from '@/types/gateway-sync'

/**
 * WireGuard on the managed gateway (design gateway-sync rest.md 4). A peer's
 * create answer may carry a one-time client config: the hook never caches
 * it (mutations are not kept by TanStack Query beyond the component that
 * reads them), and nothing can fetch it again.
 */

const base = (id: number) => `/api/v1/gateways/${id}/wireguard`
const key = (id: number) => [...gatewaysQueryKey, id, 'sync', 'wireguard'] as const
const stage = (apply: boolean | undefined) => (apply === false ? '?apply=0' : '')

function retry(count: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  return count < 2
}

function useWrite<Vars, Result>(fn: (vars: Vars) => Promise<Result>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    gcTime: 0,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: gatewaysQueryKey }),
        queryClient.invalidateQueries({ queryKey: gatewayQueryKey }),
      ]),
  })
}

function send(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

export function useWireguard(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0),
    queryFn: () => apiFetch<WgOverview>(`${base(id!)}/config`),
    enabled: id !== null,
    refetchInterval: 15_000,
    retry,
  })
}

export function useCreateWgInterface(id: number) {
  return useWrite((vars: { input: WgInterfaceCreate; apply?: boolean }) =>
    apiFetch<WriteAnswer<WgInterfaceView>>(`${base(id)}/interfaces${stage(vars.apply)}`, send('POST', vars.input)),
  )
}

export function useUpdateWgInterface(id: number) {
  return useWrite((vars: { perchId: string; patch: WgInterfacePatch; apply?: boolean }) =>
    apiFetch<WriteAnswer<WgInterfaceView>>(
      `${base(id)}/interfaces/${encodeURIComponent(vars.perchId)}${stage(vars.apply)}`,
      send('PATCH', vars.patch),
    ),
  )
}

export function useDeleteWgInterface(id: number) {
  return useWrite((vars: { perchId: string; confirm: string }) =>
    apiFetch<WriteAnswer<null>>(`${base(id)}/interfaces/${encodeURIComponent(vars.perchId)}`, send('DELETE', { confirm: vars.confirm })),
  )
}

export function useRotateWgKey(id: number) {
  return useWrite((vars: { perchId: string; confirm: string; currentPassword: string }) =>
    apiFetch<WriteAnswer<WgInterfaceView>>(
      `${base(id)}/interfaces/${encodeURIComponent(vars.perchId)}/rotate-key`,
      send('POST', { confirm: vars.confirm, currentPassword: vars.currentPassword }),
    ),
  )
}

export function useCreateWgPeer(id: number) {
  return useWrite((vars: { interfaceId: string; input: WgPeerCreate; apply?: boolean }) =>
    apiFetch<WgPeerCreateAnswer>(
      `${base(id)}/interfaces/${encodeURIComponent(vars.interfaceId)}/peers${stage(vars.apply)}`,
      send('POST', vars.input),
    ),
  )
}

export function useUpdateWgPeer(id: number) {
  return useWrite((vars: { perchId: string; patch: WgPeerPatch; apply?: boolean }) =>
    apiFetch<WriteAnswer<WgPeerView>>(
      `${base(id)}/peers/${encodeURIComponent(vars.perchId)}${stage(vars.apply)}`,
      send('PATCH', vars.patch),
    ),
  )
}

export function useDeleteWgPeer(id: number) {
  return useWrite((vars: { perchId: string }) =>
    apiFetch<WriteAnswer<null>>(`${base(id)}/peers/${encodeURIComponent(vars.perchId)}`, send('DELETE')),
  )
}
