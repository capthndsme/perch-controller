import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type {
  ApGroupState,
  DeviceGroup,
  DeviceGroupDetail,
  DeviceGroupKey,
  DeviceGroupOf,
  DeviceGroupPayload,
  DeviceGroupSettings,
  DeviceGroupSettingsView,
} from '@/types/device-groups'

/** Device groups (controller docs/gateway/device-groups.md section 3). */
export const deviceGroupsQueryKey = ['device-groups'] as const

const BASE = '/api/v1/device-groups'

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

export function useDeviceGroups(gatewayId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...deviceGroupsQueryKey, 'list', gatewayId],
    queryFn: () => apiFetch<DeviceGroup[]>(`${BASE}${gatewayId ? `?gatewayId=${gatewayId}` : ''}`),
    enabled: options.enabled !== false,
    refetchInterval: 30_000,
  })
}

export function useDeviceGroup(id: number | null) {
  return useQuery({
    queryKey: [...deviceGroupsQueryKey, 'one', id],
    queryFn: () => apiFetch<DeviceGroupDetail>(`${BASE}/${id}`),
    enabled: id !== null,
    refetchInterval: 15_000,
  })
}

export function useApGroupStates(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...deviceGroupsQueryKey, 'aps'],
    queryFn: () => apiFetch<ApGroupState[]>(`${BASE}/aps`),
    enabled: options.enabled !== false,
    refetchInterval: 10_000,
  })
}

export function useDeviceGroupOf(mac: string, gatewayId: number | null = null) {
  return useQuery({
    queryKey: [...deviceGroupsQueryKey, 'of', mac, gatewayId],
    queryFn: () =>
      apiFetch<DeviceGroupOf>(`/api/v1/devices/${encodeURIComponent(mac)}/group${gatewayId ? `?gatewayId=${gatewayId}` : ''}`),
    enabled: Boolean(mac),
  })
}

function useGroupsMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceGroupsQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['qos'] })
    },
  })
}

export function useCreateDeviceGroup() {
  return useGroupsMutation((payload: DeviceGroupPayload & { name: string }) =>
    apiFetch<DeviceGroupDetail>(BASE, json('POST', payload)),
  )
}

export function useUpdateDeviceGroup() {
  return useGroupsMutation(({ id, ...payload }: DeviceGroupPayload & { id: number }) =>
    apiFetch<DeviceGroupDetail>(`${BASE}/${id}`, json('PATCH', payload)),
  )
}

export function useDeleteDeviceGroup() {
  return useGroupsMutation((id: number) => apiFetch<void>(`${BASE}/${id}`, json('DELETE')))
}

export function useAddDeviceGroupMember() {
  return useGroupsMutation(({ id, mac, move }: { id: number; mac: string; move?: boolean }) =>
    apiFetch<{ moved: boolean; fromGroupId: number | null }>(`${BASE}/${id}/members`, json('POST', { mac, move })),
  )
}

export function useRemoveDeviceGroupMember() {
  return useGroupsMutation(({ id, mac }: { id: number; mac: string }) =>
    apiFetch<void>(`${BASE}/${id}/members/${encodeURIComponent(mac)}`, json('DELETE')),
  )
}

export function useCreateDeviceGroupKey() {
  return useGroupsMutation(({ id, label, passphrase }: { id: number; label: string; passphrase?: string | null }) =>
    apiFetch<{ key: DeviceGroupKey; passphrase: string }>(`${BASE}/${id}/keys`, json('POST', { label, passphrase })),
  )
}

export function useDeleteDeviceGroupKey() {
  return useGroupsMutation(({ id, keyId }: { id: number; keyId: number }) =>
    apiFetch<void>(`${BASE}/${id}/keys/${keyId}`, json('DELETE')),
  )
}

/** Reveals a key's passphrase (admin); not cached. */
export function revealDeviceGroupKey(id: number, keyId: number) {
  return apiFetch<{ passphrase: string }>(`${BASE}/${id}/keys/${keyId}/passphrase`)
}

export function useSetApTrunk() {
  return useGroupsMutation(({ apId, trunk }: { apId: number; trunk: string | null }) =>
    apiFetch<ApGroupState>(`${BASE}/aps/${apId}`, json('PATCH', { trunk })),
  )
}

export function useDeviceGroupSettings() {
  return useQuery({
    queryKey: [...deviceGroupsQueryKey, 'settings'],
    queryFn: () => apiFetch<DeviceGroupSettingsView>('/api/v1/settings/device-groups'),
  })
}

export function useUpdateDeviceGroupSettings() {
  return useGroupsMutation((payload: Partial<DeviceGroupSettings>) =>
    apiFetch<DeviceGroupSettingsView>('/api/v1/settings/device-groups', json('PATCH', payload)),
  )
}
