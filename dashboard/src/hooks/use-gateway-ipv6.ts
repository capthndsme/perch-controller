import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gatewayQueryKey } from '@/hooks/use-gateway-observation'
import { gatewaysQueryKey } from '@/hooks/use-gateways'
import { ApiError, apiFetch } from '@/lib/api'
import type { Ipv6Lan, Ipv6LanPatch, Ipv6Overview, Ipv6Patch, WriteAnswer } from '@/types/gateway-sync'

/**
 * IPv6 on the managed gateway (design gateway-sync rest.md 5): the ULA, each
 * LAN's prefix assignment and RA/DHCPv6/NDP; the upstream is edited on the
 * Internet page. Reads hang under the config plane's `['gateways', id]` tree
 * so an apply anywhere refreshes them.
 */

const base = (id: number) => `/api/v1/gateways/${id}/ipv6`
const key = (id: number) => [...gatewaysQueryKey, id, 'sync', 'ipv6'] as const

function retry(count: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  return count < 2
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

export function useGatewayIpv6(id: number | null) {
  return useQuery({
    queryKey: key(id ?? 0),
    queryFn: () => apiFetch<Ipv6Overview>(base(id!)),
    enabled: id !== null,
    refetchInterval: 30_000,
    retry,
  })
}

export function useUpdateUla(id: number) {
  return useWrite((vars: { patch: Ipv6Patch; apply?: boolean }) =>
    apiFetch<WriteAnswer<Ipv6Overview>>(`${base(id)}${vars.apply === false ? '?apply=0' : ''}`, {
      method: 'PATCH',
      body: JSON.stringify(vars.patch),
    }),
  )
}

export function useUpdateIpv6Lan(id: number) {
  return useWrite((vars: { network: string; patch: Ipv6LanPatch; apply?: boolean }) =>
    apiFetch<WriteAnswer<Ipv6Lan>>(
      `${base(id)}/lans/${encodeURIComponent(vars.network)}${vars.apply === false ? '?apply=0' : ''}`,
      { method: 'PATCH', body: JSON.stringify(vars.patch) },
    ),
  )
}
