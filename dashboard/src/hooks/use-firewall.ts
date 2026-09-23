import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useDevices } from '@/hooks/use-devices'
import { ApiError, apiFetch } from '@/lib/api'
import { deviceDisplayName } from '@/lib/device-labels'
import { useAuthStore } from '@/stores/auth-store'
import type {
  FirewallOrderWrite,
  FirewallOverview,
  FirewallRule,
  FirewallRuleInput,
  FirewallRulePatch,
  FirewallWrite,
  FwGateway,
  PortForward,
  PortForwardInput,
  PortForwardPatch,
  WanAccess,
  WanAccessWrite,
} from '@/types/firewall'

/**
 * The gateway firewall (metrics-be docs/gateway/firewall.md section 6). The
 * reads hang under the config plane's `gateways` query tree, so every config
 * plane write (apply, confirm, revert) refreshes them too; a firewall write in
 * turn invalidates the whole tree, which also wakes the app-wide apply banner.
 */
const gatewaysKey = ['gateways'] as const
const firewallKey = (gatewayId: number) => [...gatewaysKey, gatewayId, 'firewall'] as const
const wanAccessKey = (mac: string, gatewayId: number | null) =>
  [...gatewaysKey, 'wan-access', mac.toLowerCase(), gatewayId ?? 0] as const

function base(gatewayId: number) {
  return `/api/v1/gateways/${gatewayId}/firewall`
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

function applyQuery(apply: boolean) {
  return apply ? '' : '?apply=0'
}

export function invalidateFirewall(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: gatewaysKey })
}

/**
 * Every gateway (`GET /gateways`): same request and cache entry as the config
 * plane's pages and the apply banner. A controller without the config plane
 * answers 404; the page then says so instead of retrying.
 */
export function useFirewallGateways() {
  const token = useAuthStore((state) => state.token)
  return useQuery({
    queryKey: gatewaysKey,
    queryFn: () => apiFetch<FwGateway[]>('/api/v1/gateways'),
    enabled: Boolean(token),
    refetchInterval: (query) => ((query.state.data ?? []).some((g) => g.pendingApply) ? 2_000 : 15_000),
    retry: false,
  })
}

/** `GET /gateways/:id/firewall` (admin-only: a viewer gets 403 `admin_required`). */
export function useFirewall(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: firewallKey(gatewayId ?? 0),
    queryFn: () => apiFetch<FirewallOverview>(base(gatewayId!)),
    enabled: gatewayId !== null && options.enabled !== false,
    refetchInterval: 15_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  })
}

// ── port forwards ────────────────────────────────────────────────────────

export function useCreatePortForward(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body, apply = true }: { body: PortForwardInput; apply?: boolean }) =>
      apiFetch<FirewallWrite<PortForward>>(`${base(gatewayId)}/port-forwards${applyQuery(apply)}`, json('POST', body)),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

export function useUpdatePortForward(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body, apply = true }: { id: string; body: PortForwardPatch; apply?: boolean }) =>
      apiFetch<FirewallWrite<PortForward>>(
        `${base(gatewayId)}/port-forwards/${encodeURIComponent(id)}${applyQuery(apply)}`,
        json('PATCH', body),
      ),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

export function useDeletePortForward(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, apply = true }: { id: string; apply?: boolean }) =>
      apiFetch<FirewallWrite<null>>(
        `${base(gatewayId)}/port-forwards/${encodeURIComponent(id)}${applyQuery(apply)}`,
        json('DELETE'),
      ),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

// ── rules ────────────────────────────────────────────────────────────────

export function useCreateRule(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body, apply = true }: { body: FirewallRuleInput; apply?: boolean }) =>
      apiFetch<FirewallWrite<FirewallRule>>(`${base(gatewayId)}/rules${applyQuery(apply)}`, json('POST', body)),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

export function useUpdateRule(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body, apply = true }: { id: string; body: FirewallRulePatch; apply?: boolean }) =>
      apiFetch<FirewallWrite<FirewallRule>>(
        `${base(gatewayId)}/rules/${encodeURIComponent(id)}${applyQuery(apply)}`,
        json('PATCH', body),
      ),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

export function useDeleteRule(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, apply = true }: { id: string; apply?: boolean }) =>
      apiFetch<FirewallWrite<null>>(`${base(gatewayId)}/rules/${encodeURIComponent(id)}${applyQuery(apply)}`, json('DELETE')),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

// ── order ────────────────────────────────────────────────────────────────

/** `PUT …/rules/order` or `…/port-forwards/order`: every synced member once. */
export function useReorder(gatewayId: number, type: 'rule' | 'redirect') {
  const queryClient = useQueryClient()
  const path = type === 'rule' ? 'rules/order' : 'port-forwards/order'
  return useMutation({
    mutationFn: ({ ids, apply = true }: { ids: string[]; apply?: boolean }) =>
      apiFetch<FirewallOrderWrite>(`${base(gatewayId)}/${path}${applyQuery(apply)}`, json('PUT', { ids })),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

/** `POST …/order/resolve`: an order conflict (or order drift) settled one way. */
export function useResolveOrder(gatewayId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      type,
      take,
      apply = true,
    }: {
      type: 'rule' | 'redirect'
      take: 'router' | 'controller'
      apply?: boolean
    }) => apiFetch<FirewallOrderWrite>(`${base(gatewayId)}/order/resolve${applyQuery(apply)}`, json('POST', { type, take })),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

// ── the per-device WAN block ─────────────────────────────────────────────

/**
 * `GET /devices/:mac/wan-access` (any signed-in user). Without `gatewayId`
 * the server picks the only managed gateway: 404 `gateway_not_found` when
 * there is none, 409 `gateway_ambiguous` {gatewayIds} when several are.
 */
export function useDeviceWanAccess(mac: string | undefined, gatewayId: number | null) {
  const token = useAuthStore((state) => state.token)
  return useQuery({
    queryKey: wanAccessKey(mac ?? '', gatewayId),
    queryFn: () =>
      apiFetch<WanAccess>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/wan-access${gatewayId ? `?gatewayId=${gatewayId}` : ''}`,
      ),
    enabled: Boolean(mac) && Boolean(token),
    // The conntrack flush lands a few seconds after the apply went live.
    refetchInterval: (query) => (query.state.data && !query.state.data.applied ? 3_000 : 20_000),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  })
}

export function usePutWanAccess(mac: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      gatewayId,
      blocked,
      note,
      apply = true,
    }: {
      gatewayId?: number
      blocked: boolean
      note?: string | null
      apply?: boolean
    }) =>
      apiFetch<WanAccessWrite>(
        `/api/v1/devices/${encodeURIComponent(mac)}/wan-access${applyQuery(apply)}`,
        json('PUT', { gatewayId, blocked, note }),
      ),
    onSettled: () => invalidateFirewall(queryClient),
  })
}

// ── devices, to name forward targets ─────────────────────────────────────

export type FirewallDevice = { mac: string; name: string; ips: string[]; online: boolean }

/**
 * The devices the dashboard knows (`GET /devices`, same cache entry as the
 * Devices page), indexed by MAC and by address: a forward names its target
 * by the device's label, and the dialog picks a device instead of an address.
 */
export function useFirewallDevices() {
  const devices = useDevices()
  return useMemo(() => {
    const list: FirewallDevice[] = (devices.data ?? []).map((d) => ({
      mac: d.mac.toLowerCase(),
      name: deviceDisplayName(d),
      ips: d.ips.length > 0 ? d.ips : d.primaryIp ? [d.primaryIp] : [],
      online: d.presence ? d.presence.status === 'connected' : true,
    }))
    const byMac = new Map(list.map((d) => [d.mac, d]))
    const byIp = new Map<string, FirewallDevice>()
    for (const d of list) for (const ip of d.ips) if (!byIp.has(ip)) byIp.set(ip, d)
    return { list: list.sort((a, b) => a.name.localeCompare(b.name)), byMac, byIp, isPending: devices.isPending }
  }, [devices.data, devices.isPending])
}
