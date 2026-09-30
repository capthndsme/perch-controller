import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { alertsKey, json, retryUnless404 } from '@/hooks/use-alert-summary'
import type {
  DestinationTestResponse,
  WebhookCreateResponse,
  WebhookInput,
  WebhookView,
} from '@/types/alerts'

/** Webhook destinations (design api.md §3.6), admin only. */

const BASE = '/api/v1/settings/alerts/webhooks'
const webhooksKey = [...alertsKey, 'webhooks'] as const

export function useWebhooks(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: webhooksKey,
    queryFn: () => apiFetch<WebhookView[]>(BASE),
    enabled: options.enabled,
    retry: retryUnless404,
  })
}

function useWebhookMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: webhooksKey })
      void queryClient.invalidateQueries({ queryKey: [...alertsKey, 'deliveries'] })
    },
  })
}

/** The signing secret (format standard) comes back once, here. */
export function useCreateWebhook() {
  return useWebhookMutation((input: WebhookInput) => apiFetch<WebhookCreateResponse>(BASE, json('POST', input)))
}

export function useUpdateWebhook() {
  return useWebhookMutation(({ id, ...patch }: Partial<WebhookInput> & { id: number }) =>
    apiFetch<WebhookView>(`${BASE}/${id}`, json('PATCH', patch)),
  )
}

export function useDeleteWebhook() {
  return useWebhookMutation((id: number) => apiFetch<void>(`${BASE}/${id}`, { method: 'DELETE' }))
}

/** Synchronous: the answer carries the receiver's status. */
export function useTestWebhook() {
  return useWebhookMutation((id: number) => apiFetch<DestinationTestResponse>(`${BASE}/${id}/test`, { method: 'POST' }))
}

export function useRotateWebhookSecret() {
  return useWebhookMutation((id: number) =>
    apiFetch<WebhookCreateResponse>(`${BASE}/${id}/rotate-secret`, { method: 'POST' }),
  )
}
