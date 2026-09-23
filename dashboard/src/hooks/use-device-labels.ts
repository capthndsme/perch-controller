import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { DeviceLabelPayload, DeviceLabelResponse, DeviceLabelsResponse } from '@/types/api'

export const deviceLabelsQueryKey = ['device-labels'] as const

export function deviceLabelQueryKey(mac: string) {
  return [...deviceLabelsQueryKey, mac] as const
}

/**
 * One device's stored label. The device read endpoints already carry the
 * label fields for *display*; this is the authoritative record the editor
 * round-trips (and it is keyed under `deviceLabelsQueryKey`, so a save
 * invalidates it along with the list).
 */
export function useDeviceLabel(mac: string | undefined) {
  return useQuery({
    queryKey: deviceLabelQueryKey(mac ?? ''),
    queryFn: () =>
      apiFetch<DeviceLabelResponse>(`/api/v1/devices/${encodeURIComponent(mac!)}/label`),
    enabled: Boolean(mac),
    staleTime: 60_000,
  })
}

/**
 * Every stored label plus the tags in use and the device-type catalog, in
 * one request. Small and slow-moving, so it is cached for a minute and used
 * for filter options and tag autocomplete.
 */
export function useDeviceLabels(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: deviceLabelsQueryKey,
    queryFn: () => apiFetch<DeviceLabelsResponse>('/api/v1/devices/labels'),
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  })
}

/**
 * Names, types, tags and notes ride along on the device, Wi-Fi, traffic,
 * service and network-map responses, so a write has to invalidate all of
 * them — otherwise a renamed device keeps its old name until the next poll.
 */
function invalidateLabelledViews(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of [
    deviceLabelsQueryKey,
    ['devices'],
    ['traffic'],
    ['protocols'],
    ['wifi'],
    ['services'],
    ['infra'],
  ]) {
    queryClient.invalidateQueries({ queryKey: key })
  }
}

/**
 * Merge semantics, matching the API: an omitted field keeps its stored
 * value, an explicit `null` clears it. A label with nothing left in it is
 * deleted server-side and comes back as `null`.
 */
export function useSaveDeviceLabel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ mac, payload }: { mac: string; payload: DeviceLabelPayload }) =>
      apiFetch<DeviceLabelResponse>(`/api/v1/devices/${encodeURIComponent(mac)}/label`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateLabelledViews(queryClient),
  })
}

export function useDeleteDeviceLabel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (mac: string) =>
      apiFetch<void>(`/api/v1/devices/${encodeURIComponent(mac)}/label`, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateLabelledViews(queryClient),
  })
}
