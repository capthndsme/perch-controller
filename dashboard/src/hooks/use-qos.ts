import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { devicesQueryKey } from '@/hooks/use-devices'
import { apiFetch } from '@/lib/api'
import { recordQosSample } from '@/lib/qos-live'
import type {
  DeviceShaping,
  QosAssignment,
  QosAssignmentInput,
  QosGroup,
  QosGroupCreate,
  QosGroupPatch,
  QosOverview,
  QosPolicy,
  QosPolicyInput,
  QosSchedule,
  QosScheduleInput,
  QosSettings,
  QosSettingsView,
  QosWanQueueDelete,
  QosWanQueueInput,
  QosWanQueueWrite,
} from '@/types/api'

/**
 * Traffic shaping (metrics-be/docs/gateway/qos.md section 5). Reads are open to
 * every signed-in user (owner decision 16); writes are admin-only and need the
 * gateway in managed mode (409 `qos_not_managed`). A gateway is named by
 * `gatewayId`; with one gateway it may be left out (the page's `?gateway=N`).
 */
export const qosQueryKey = ['qos'] as const
export const qosSettingsQueryKey = ['settings', 'qos'] as const

/** Key of a gateway's live-sample history (lib/qos-live.ts). */
export function qosSampleKey(gatewayId: number | null): string {
  return gatewayId ? String(gatewayId) : 'only'
}

/** The page's gateway: `?gateway=N`, else null (the only one). */
export function useQosGatewayId(): number | null {
  const [params] = useSearchParams()
  const raw = Number(params.get('gateway'))
  return Number.isInteger(raw) && raw > 0 ? raw : null
}

function qs(gatewayId: number | null, extra: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams()
  if (gatewayId) params.set('gatewayId', String(gatewayId))
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) params.set(k, String(v))
  const s = params.toString()
  return s ? `?${s}` : ''
}

function withGateway<T extends object>(gatewayId: number | null, body: T): T & { gatewayId?: number } {
  return gatewayId ? { ...body, gatewayId } : body
}

const noRetryOn4xx = (count: number, error: unknown) => {
  const status = (error as { status?: number }).status
  if (status && status >= 400 && status < 500) return false
  return count < 2
}

/** `GET /qos`: status, delivery, WAN queues with live counters, policies with live rates, events. Every 5 s. */
export function useQosOverview(gatewayId: number | null) {
  return useQuery({
    queryKey: [...qosQueryKey, gatewayId, 'overview'],
    queryFn: async () => {
      const overview = await apiFetch<QosOverview>(`/api/v1/qos${qs(gatewayId)}`)
      // The page's live chart draws from this short in-browser history.
      recordQosSample(qosSampleKey(gatewayId), overview)
      return overview
    },
    refetchInterval: 5_000,
    retry: noRetryOn4xx,
  })
}

export function useQosPolicies(gatewayId: number | null, enabled = true) {
  return useQuery({
    queryKey: [...qosQueryKey, gatewayId, 'policies'],
    queryFn: () => apiFetch<QosPolicy[]>(`/api/v1/qos/policies${qs(gatewayId)}`),
    refetchInterval: 30_000,
    retry: noRetryOn4xx,
    enabled,
  })
}

export function useQosGroups(gatewayId: number | null, enabled = true) {
  return useQuery({
    queryKey: [...qosQueryKey, gatewayId, 'groups'],
    queryFn: () => apiFetch<QosGroup[]>(`/api/v1/qos/groups${qs(gatewayId)}`),
    refetchInterval: 30_000,
    retry: noRetryOn4xx,
    enabled,
  })
}

export function useQosAssignments(gatewayId: number | null, enabled = true) {
  return useQuery({
    queryKey: [...qosQueryKey, gatewayId, 'assignments'],
    queryFn: () => apiFetch<QosAssignment[]>(`/api/v1/qos/assignments${qs(gatewayId)}`),
    // Quota usage moves with the router's reports.
    refetchInterval: 15_000,
    retry: noRetryOn4xx,
    enabled,
  })
}

export function useQosSchedules(gatewayId: number | null, enabled = true) {
  return useQuery({
    queryKey: [...qosQueryKey, gatewayId, 'schedules'],
    queryFn: () => apiFetch<QosSchedule[]>(`/api/v1/qos/schedules${qs(gatewayId)}`),
    // `active` is a preview of now.
    refetchInterval: 30_000,
    retry: noRetryOn4xx,
    enabled,
  })
}

/** `GET /qos/devices`: every shaped MAC with its state and live usage. Every 5 s while shown. */
export function useQosDevices(gatewayId: number | null, enabled = true) {
  return useQuery({
    queryKey: [...qosQueryKey, gatewayId, 'devices'],
    queryFn: () => apiFetch<DeviceShaping[]>(`/api/v1/qos/devices${qs(gatewayId)}`),
    refetchInterval: 5_000,
    retry: noRetryOn4xx,
    enabled,
  })
}

/** `GET /devices/:mac/shaping`: `null` when no gateway shapes it (never a 404). */
export function useDeviceShaping(mac: string | undefined, collectorId?: number) {
  return useQuery({
    queryKey: [...qosQueryKey, 'device', mac ?? '', collectorId ?? null],
    queryFn: () =>
      apiFetch<DeviceShaping | null>(
        `/api/v1/devices/${encodeURIComponent(mac!)}/shaping${collectorId ? `?collectorId=${collectorId}` : ''}`,
      ),
    enabled: Boolean(mac),
    refetchInterval: 10_000,
    retry: noRetryOn4xx,
  })
}

/** Every write drops every QoS read (the plan behind them changed) and the device rows' `shaping`. */
function useQosMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qosQueryKey })
      void queryClient.invalidateQueries({ queryKey: devicesQueryKey })
    },
  })
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

export function useQosWrites(gatewayId: number | null) {
  return {
    createWanQueue: useQosMutation((body: QosWanQueueInput) =>
      apiFetch<QosWanQueueWrite>('/api/v1/qos/wan-queues', json('POST', withGateway(gatewayId, body))),
    ),
    updateWanQueue: useQosMutation(({ id, patch }: { id: number; patch: QosWanQueueInput }) =>
      apiFetch<QosWanQueueWrite>(`/api/v1/qos/wan-queues/${id}`, json('PATCH', patch)),
    ),
    /** 200 with the queue still listed (`pending_delete`) until the router's apply confirms. */
    deleteWanQueue: useQosMutation((id: number) =>
      apiFetch<QosWanQueueDelete>(`/api/v1/qos/wan-queues/${id}`, json('DELETE')),
    ),
    createPolicy: useQosMutation((body: QosPolicyInput) =>
      apiFetch<QosPolicy>('/api/v1/qos/policies', json('POST', withGateway(gatewayId, body))),
    ),
    updatePolicy: useQosMutation(({ id, patch }: { id: number; patch: QosPolicyInput }) =>
      apiFetch<QosPolicy>(`/api/v1/qos/policies/${id}`, json('PATCH', patch)),
    ),
    deletePolicy: useQosMutation((id: number) => apiFetch<void>(`/api/v1/qos/policies/${id}`, json('DELETE'))),
    createGroup: useQosMutation((body: QosGroupCreate) =>
      apiFetch<QosGroup>('/api/v1/qos/groups', json('POST', withGateway(gatewayId, body))),
    ),
    updateGroup: useQosMutation(({ id, patch }: { id: number; patch: QosGroupPatch }) =>
      apiFetch<QosGroup>(`/api/v1/qos/groups/${id}`, json('PATCH', patch)),
    ),
    deleteGroup: useQosMutation((id: number) => apiFetch<void>(`/api/v1/qos/groups/${id}`, json('DELETE'))),
    createAssignment: useQosMutation((body: QosAssignmentInput) =>
      apiFetch<QosAssignment>('/api/v1/qos/assignments', json('POST', withGateway(gatewayId, body))),
    ),
    updateAssignment: useQosMutation(({ id, patch }: { id: number; patch: QosAssignmentInput }) =>
      apiFetch<QosAssignment>(`/api/v1/qos/assignments/${id}`, json('PATCH', patch)),
    ),
    deleteAssignment: useQosMutation((id: number) =>
      apiFetch<void>(`/api/v1/qos/assignments/${id}`, json('DELETE')),
    ),
    resetQuota: useQosMutation((id: number) =>
      apiFetch<QosAssignment>(`/api/v1/qos/assignments/${id}/quota/reset`, json('POST', {})),
    ),
    createSchedule: useQosMutation((body: QosScheduleInput) =>
      apiFetch<QosSchedule>('/api/v1/qos/schedules', json('POST', withGateway(gatewayId, body))),
    ),
    updateSchedule: useQosMutation(({ id, patch }: { id: number; patch: QosScheduleInput }) =>
      apiFetch<QosSchedule>(`/api/v1/qos/schedules/${id}`, json('PATCH', patch)),
    ),
    deleteSchedule: useQosMutation((id: number) => apiFetch<void>(`/api/v1/qos/schedules/${id}`, json('DELETE'))),
    pause: useQosMutation(() => apiFetch<QosOverview>('/api/v1/qos/pause', json('POST', withGateway(gatewayId, {})))),
    resume: useQosMutation((overrideRouter: boolean) =>
      apiFetch<QosOverview>(
        '/api/v1/qos/resume',
        json('POST', withGateway(gatewayId, overrideRouter ? { overrideRouter: true } : {})),
      ),
    ),
  }
}

export type QosWrites = ReturnType<typeof useQosWrites>

/** Admin-only on the server; pass `enabled: false` for other roles. */
export function useQosSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qosSettingsQueryKey,
    queryFn: () => apiFetch<QosSettingsView>('/api/v1/settings/qos'),
    enabled: options.enabled ?? true,
  })
}

/** Fields left out keep their stored value. */
export function useUpdateQosSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: Partial<QosSettings>) =>
      apiFetch<QosSettingsView>('/api/v1/settings/qos', json('PATCH', payload)),
    onSuccess: (data) => {
      queryClient.setQueryData(qosSettingsQueryKey, data)
      void queryClient.invalidateQueries({ queryKey: qosQueryKey })
    },
  })
}
