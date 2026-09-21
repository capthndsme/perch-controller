import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, fieldErrorsFromApi } from '@/lib/api'
import type { HostnameEnrichmentSettings } from '@/types/settings'

export const hostnameEnrichmentSettingsQueryKey = ['settings', 'hostname-enrichment'] as const

export function useHostnameEnrichmentSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hostnameEnrichmentSettingsQueryKey,
    queryFn: () =>
      apiFetch<HostnameEnrichmentSettings>('/api/v1/settings/hostname-enrichment'),
    enabled: options?.enabled,
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
    },
  })
}

export { fieldErrorsFromApi }
