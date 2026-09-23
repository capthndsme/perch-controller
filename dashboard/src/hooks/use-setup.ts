import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch, fieldErrorsFromApi } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type {
  SetupAdminPayload,
  SetupAdminResponse,
  SetupAdoptPayload,
  SetupAdoptResponse,
  SetupCandidatesResponse,
  SetupCollectorPayload,
  SetupCollectorResponse,
  SetupInstancePayload,
  SetupLoginPayload,
  SetupSkipResponse,
  SetupStatusResponse,
} from '@/types/setup'

export const setupStatusQueryKey = ['setup', 'status'] as const

/** Pending collectors the wizard offers for adoption. */
export const setupCandidatesQueryKey = ['setup', 'collector', 'candidates'] as const

export function useSetupStatus(options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: setupStatusQueryKey,
    queryFn: () => apiFetch<SetupStatusResponse>('/api/v1/setup/status', { auth: false }),
    refetchInterval: options?.refetchInterval,
  })
}

export function useSetupAdmin() {
  const queryClient = useQueryClient()
  const setSession = useAuthStore((state) => state.setSession)

  return useMutation({
    mutationFn: (payload: SetupAdminPayload) =>
      apiFetch<SetupAdminResponse>('/api/v1/setup/admin', {
        method: 'POST',
        body: JSON.stringify(payload),
        auth: false,
      }),
    onSuccess: (data) => {
      setSession(data.token, data.user)
      queryClient.invalidateQueries({ queryKey: setupStatusQueryKey })
    },
  })
}

/**
 * Signs the step-1 admin back in while setup is incomplete (tab closed, other
 * browser, cleared storage). Credentials are required: there is no
 * unauthenticated way to continue the wizard.
 */
export function useSetupLogin() {
  const queryClient = useQueryClient()
  const setSession = useAuthStore((state) => state.setSession)

  return useMutation({
    mutationFn: (payload: SetupLoginPayload) =>
      apiFetch<SetupAdminResponse>('/api/v1/setup/login', {
        method: 'POST',
        body: JSON.stringify(payload),
        auth: false,
      }),
    onSuccess: (data) => {
      setSession(data.token, data.user)
      queryClient.invalidateQueries({ queryKey: setupStatusQueryKey })
    },
  })
}

export function useSetupInstance() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: SetupInstancePayload) =>
      apiFetch<{ siteName: string; timezone: string }>('/api/v1/setup/instance', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: setupStatusQueryKey })
    },
  })
}

export function useSetupCollector() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: SetupCollectorPayload) =>
      apiFetch<SetupCollectorResponse>('/api/v1/setup/collector', {
        method: 'POST',
        body: JSON.stringify({
          ...payload,
          apiKey: payload.apiKey?.trim() ? payload.apiKey.trim() : null,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: setupStatusQueryKey })
    },
  })
}

/**
 * Collectors that announced themselves and wait for adoption. Polled every
 * 5 s so a router that is switched on while the admin watches shows up by
 * itself. A 401/403 is final (the setup session is gone), so it is not retried.
 */
export function useSetupCandidates(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: setupCandidatesQueryKey,
    queryFn: () => apiFetch<SetupCandidatesResponse>('/api/v1/setup/collector/candidates'),
    enabled: options.enabled,
    refetchInterval: 5_000,
    retry: (count, error) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
      return count < 2
    },
  })
}

export function useSetupAdoptCollector() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: SetupAdoptPayload }) =>
      apiFetch<SetupAdoptResponse>(`/api/v1/setup/collector/${id}/adopt`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: setupCandidatesQueryKey })
      queryClient.invalidateQueries({ queryKey: setupStatusQueryKey })
    },
  })
}

/** "Skip for now": finish setup with no collector. */
export function useSetupSkipCollector() {
  return useMutation({
    mutationFn: () =>
      apiFetch<SetupSkipResponse>('/api/v1/setup/collector/skip', { method: 'POST' }),
  })
}

export { fieldErrorsFromApi }
