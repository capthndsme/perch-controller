import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { alertsKey, invalidateAlertViews, json, retryUnless404 } from '@/hooks/use-alert-summary'
import type { AlertSettingsPatch, AlertSettingsView, Severity, VapidRotateResponse } from '@/types/alerts'

/** Settings → Alerts (design api.md §3.5), admin only. */

const BASE = '/api/v1/settings/alerts'
const settingsKey = [...alertsKey, 'settings'] as const

export function useAlertSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<AlertSettingsView>(BASE),
    enabled: options.enabled,
    retry: retryUnless404,
  })
}

/** PATCH answers with the whole GET body: it replaces the cache as is. */
export function useUpdateAlertSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: AlertSettingsPatch) => apiFetch<AlertSettingsView>(BASE, json('PATCH', patch)),
    onSuccess: (view) => {
      queryClient.setQueryData(settingsKey, view)
      // A rule switched off resolves its alerts quietly; the catalogue carries the effective rules too.
      void invalidateAlertViews(queryClient)
      void queryClient.invalidateQueries({ queryKey: [...alertsKey, 'catalogue'] })
    },
  })
}

export function useSendTestAlert() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { severity: Severity; title?: string }) =>
      apiFetch<{ alertId: number }>(`${BASE}/test`, json('POST', input)),
    onSuccess: () => invalidateAlertViews(queryClient),
  })
}

export function useRotateVapidKeys() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<VapidRotateResponse>(`${BASE}/vapid/rotate`, json('POST', { confirm: 'rotate' })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKey })
      void queryClient.invalidateQueries({ queryKey: [...alertsKey, 'push'] })
    },
  })
}
