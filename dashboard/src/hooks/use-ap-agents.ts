import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'
import { wifiQueryKey, wifiSourcesQueryKey } from '@/hooks/use-wifi'
import type {
  ApAgentInstallInfo,
  ApAgentPingResponse,
  ApJoinToken,
  CreateApJoinTokenResponse,
  WifiSource,
} from '@/types/api'

/**
 * Perch AP Daemon agents (docs/ap-controller.md §4): join tokens, the install
 * commands' URLs, and per-source agent actions. All admin-only.
 */

export const apJoinTokensQueryKey = ['settings', 'ap-join-tokens'] as const
export const apAgentInstallQueryKey = ['settings', 'ap-agent', 'install'] as const

export function useApJoinTokens(options: { refreshInterval?: number | false } = {}) {
  return useQuery({
    queryKey: apJoinTokensQueryKey,
    queryFn: () => apiFetch<ApJoinToken[]>('/api/v1/settings/ap-join-tokens'),
    refetchInterval: options.refreshInterval ?? false,
  })
}

/** Controller URL + release assets; only changes with the server's env. */
export function useApAgentInstallInfo() {
  return useQuery({
    queryKey: apAgentInstallQueryKey,
    queryFn: () => apiFetch<ApAgentInstallInfo>('/api/v1/settings/ap-agent/install'),
    staleTime: 5 * 60_000,
  })
}

export type CreateApJoinTokenPayload = {
  label?: string | null
  /** `null` = never expires. */
  expiresInHours?: number | null
  /** `null` = unlimited. */
  maxUses?: number | null
}

export function useCreateApJoinToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateApJoinTokenPayload) =>
      apiFetch<CreateApJoinTokenResponse>('/api/v1/settings/ap-join-tokens', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apJoinTokensQueryKey })
    },
  })
}

/** Plaintext of an active token; 410 `join_token_inactive` otherwise. */
export function useRevealApJoinToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ token: string }>(`/api/v1/settings/ap-join-tokens/${id}/reveal`, {
        method: 'POST',
      }),
    onError: (error) => {
      // The token expired, ran out or was revoked since the list loaded.
      if (error instanceof ApiError && error.status === 410) {
        queryClient.invalidateQueries({ queryKey: apJoinTokensQueryKey })
      }
    },
  })
}

export function useRevokeApJoinToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/v1/settings/ap-join-tokens/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apJoinTokensQueryKey })
    },
  })
}

/** Round trip to the agent; 409 `agent_offline` when it is not connected. */
export function usePingApAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sourceId: number) =>
      apiFetch<ApAgentPingResponse>(`/api/v1/settings/wifi-sources/${sourceId}/agent/ping`, {
        method: 'POST',
      }),
    onError: (error) => {
      // The list still says "online": refresh it so the badge catches up.
      if (error instanceof ApiError && error.status === 409) {
        queryClient.invalidateQueries({ queryKey: wifiSourcesQueryKey })
      }
    },
  })
}

/**
 * Forget the agent: revokes its credentials and closes its session. The
 * source falls back to HTTP scraping when it has a metrics URL, otherwise it
 * is disabled; its AP controls change either way.
 */
export function useForgetApAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sourceId: number) =>
      apiFetch<WifiSource>(`/api/v1/settings/wifi-sources/${sourceId}/agent`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: wifiSourcesQueryKey })
      queryClient.invalidateQueries({ queryKey: wifiQueryKey })
    },
  })
}
