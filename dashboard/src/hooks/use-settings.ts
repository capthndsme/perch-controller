import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesQueryKey } from '@/hooks/use-devices'
import { wifiQueryKey } from '@/hooks/use-wifi'
import { apiFetch, fieldErrorsFromApi } from '@/lib/api'
import type {
  ChartSettings,
  ChartSettingsView,
  HostnameEnrichmentSettings,
  HostnameEnrichmentSources,
  PresenceSettingsView,
  PresenceThresholds,
} from '@/types/settings'

export const hostnameEnrichmentSettingsQueryKey = ['settings', 'hostname-enrichment'] as const
export const hostnameEnrichmentSourcesQueryKey = ['settings', 'hostname-enrichment', 'sources'] as const
export const presenceSettingsQueryKey = ['settings', 'presence'] as const
export const chartSettingsQueryKey = ['settings', 'charts'] as const

export function useHostnameEnrichmentSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hostnameEnrichmentSettingsQueryKey,
    queryFn: () =>
      apiFetch<HostnameEnrichmentSettings>('/api/v1/settings/hostname-enrichment'),
    enabled: options?.enabled,
  })
}

export function useHostnameEnrichmentSources() {
  return useQuery({
    queryKey: hostnameEnrichmentSourcesQueryKey,
    queryFn: () =>
      apiFetch<HostnameEnrichmentSources>('/api/v1/settings/hostname-enrichment/sources'),
    refetchInterval: 30_000,
    retry: false,
  })
}

export function useUpdateHostnameEnrichmentSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: HostnameEnrichmentSettings) =>
      apiFetch<HostnameEnrichmentSettings>('/api/v1/settings/hostname-enrichment', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(hostnameEnrichmentSettingsQueryKey, data)
      void queryClient.invalidateQueries({ queryKey: hostnameEnrichmentSourcesQueryKey })
    },
  })
}

export function usePresenceSettings() {
  return useQuery({
    queryKey: presenceSettingsQueryKey,
    queryFn: () => apiFetch<PresenceSettingsView>('/api/v1/settings/presence'),
  })
}

/** Fields left out of the payload keep their stored value. */
export function useUpdatePresenceSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: Partial<PresenceThresholds>) =>
      apiFetch<PresenceSettingsView>('/api/v1/settings/presence', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(presenceSettingsQueryKey, data)
      // The server applies the thresholds when it reads: refetch the device and
      // WiFi answers they decide (connected, silent APs, "now" rates).
      queryClient.invalidateQueries({ queryKey: devicesQueryKey })
      queryClient.invalidateQueries({ queryKey: wifiQueryKey })
    },
  })
}

export function useChartSettings() {
  return useQuery({
    queryKey: chartSettingsQueryKey,
    queryFn: () => apiFetch<ChartSettingsView>('/api/v1/settings/charts'),
  })
}

/** Fields left out of the payload keep their stored value. */
export function useUpdateChartSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: Partial<ChartSettings>) =>
      apiFetch<ChartSettingsView>('/api/v1/settings/charts', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(chartSettingsQueryKey, data)
      // The floor and cap decide the bucket width of every per-name series.
      queryClient.invalidateQueries({ queryKey: ['services'] })
      queryClient.invalidateQueries({ queryKey: ['destinations'] })
    },
  })
}

export { fieldErrorsFromApi }
