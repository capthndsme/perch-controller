import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'
import type { AlertSummary } from '@/types/alerts'

/**
 * The part of the alerts REST the shell needs (the bell, in the entry chunk): the summary poll and "mark
 * read", plus the shared query-key helpers. Everything else is in `use-alerts.ts`, loaded with the pages.
 */

const BASE = '/api/v1/alerts'

export const alertsKey = ['alerts'] as const

/** No retry on 404: an older controller has no alerts, and the callers hide themselves. */
export function retryUnless404(count: number, error: Error): boolean {
  return !(error instanceof ApiError && error.status === 404) && count < 1
}

export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) }
}

/** Inbox, bell and the open alert: what changes when an alert does. */
export function invalidateAlertViews(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'alerts' && ['summary', 'list', 'detail'].includes(String(query.queryKey[1])),
  })
}

// ── Bell ─────────────────────────────────────────────────────────────────

/** The bell: polled every 30 s and on focus (an ETag makes an idle poll a 304). */
export function useAlertSummary(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...alertsKey, 'summary'] as const,
    queryFn: () => apiFetch<AlertSummary>(`${BASE}/summary`),
    enabled: options.enabled,
    refetchInterval: (query) => (query.state.error ? false : 30_000),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    retry: retryUnless404,
  })
}

/** Marks everything bumped up to `through` (default now) as read for this user. */
export function useMarkAlertsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (through?: string) =>
      apiFetch<{ readAt: string; unread: number }>(`${BASE}/read`, json('POST', through ? { through } : {})),
    onSuccess: (result) => {
      // The rows keep their dots until the next refresh, so what was new stays visible for now.
      queryClient.setQueryData<AlertSummary>([...alertsKey, 'summary'], (summary) =>
        summary ? { ...summary, unread: result.unread } : summary,
      )
    },
  })
}
