import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiErrorCode, apiFetch } from '@/lib/api'
import { alertsKey, json, retryUnless404 } from '@/hooks/use-alert-summary'
import { pushSupport, unsubscribeThisBrowser, type PushSupport } from '@/lib/push'
import {
  browserSubscription,
  platformLabel,
  requestNotificationPermission,
  subscribeThisBrowser,
} from '@/lib/push-subscribe'
import type {
  DestinationTestResponse,
  PushConfig,
  PushSubscriptionPatch,
  PushSubscriptionView,
} from '@/types/alerts'

/** Web Push devices (design api.md §3.4, delivery.md §1.6). */

const BASE = '/api/v1/alerts/push'
const pushKey = [...alertsKey, 'push'] as const

export function usePushConfig(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...pushKey, 'config'] as const,
    queryFn: () => apiFetch<PushConfig>(`${BASE}/config`),
    enabled: options.enabled,
    staleTime: 5 * 60_000,
    retry: retryUnless404,
  })
}

/** The caller's devices; `all` (admin) lists everyone's. */
export function usePushSubscriptions(all = false, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...pushKey, 'subscriptions', all ? 'all' : 'mine'] as const,
    queryFn: () => apiFetch<PushSubscriptionView[]>(`${BASE}/subscriptions${all ? '?all=1' : ''}`),
    enabled: options.enabled,
    retry: retryUnless404,
  })
}

function usePushMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...pushKey, 'subscriptions'] }),
  })
}

export function useUpdatePushSubscription() {
  return usePushMutation(({ id, ...patch }: PushSubscriptionPatch & { id: number }) =>
    apiFetch<PushSubscriptionView>(`${BASE}/subscriptions/${id}`, json('PATCH', patch)),
  )
}

export function useDeletePushSubscription() {
  return usePushMutation((id: number) => apiFetch<void>(`${BASE}/subscriptions/${id}`, { method: 'DELETE' }))
}

/** Synchronous test push; the answer says whether the push service took it. */
export function useTestPushSubscription() {
  return usePushMutation((id: number) =>
    apiFetch<DestinationTestResponse>(`${BASE}/subscriptions/${id}/test`, { method: 'POST' }),
  )
}

export type ThisDevice =
  | { kind: 'insecure' | 'ios_needs_install' | 'unsupported' }
  | { kind: 'loading' }
  /** The controller has no alerts API (an older version). */
  | { kind: 'no_alerts' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; reason: PushConfig['reason'] }
  | { kind: 'denied' }
  | { kind: 'off'; config: PushConfig }
  | { kind: 'on'; config: PushConfig; row: PushSubscriptionView }

/** Why subscribing failed, in words. */
export function subscribeErrorText(error: unknown): string {
  const code = apiErrorCode(error)
  if (code === 'push_service_not_allowed')
    return "This browser's push service is not on the controller's list of known services. An admin can allow any push service in Settings → Alerts."
  if (code === 'push_unavailable') return 'Push is not available on this controller right now: its keys cannot be read.'
  if (error instanceof ApiError) return error.message
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'The browser did not allow notifications for this site.'
    if (error.name === 'AbortError')
      return "The browser could not reach its push service. Check this device's internet connection (Brave: turn on “Use Google services for push messaging”)."
  }
  return error instanceof Error ? error.message : 'Could not turn on notifications.'
}

/**
 * This browser's push state and its two actions. `enable` must run straight from the tap (it asks for
 * permission before anything else awaits: iOS only prompts then).
 */
export function useThisDevice() {
  const queryClient = useQueryClient()
  const [support, setSupport] = useState<PushSupport>(pushSupport)
  const usable = support === 'default' || support === 'granted' || support === 'denied'
  const config = usePushConfig({ enabled: usable })
  const subscriptions = usePushSubscriptions(false, { enabled: usable })
  // undefined while reading the browser's own subscription.
  const [browser, setBrowser] = useState<{ endpoint: string; hash: string } | null | undefined>(usable ? undefined : null)
  const [busy, setBusy] = useState<'enable' | 'disable' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const readBrowser = useCallback(() => {
    browserSubscription().then(setBrowser, () => setBrowser(null))
  }, [])

  useEffect(() => {
    if (usable) readBrowser()
  }, [usable, readBrowser])

  const state = ((): ThisDevice => {
    if (support === 'insecure' || support === 'ios_needs_install' || support === 'unsupported') return { kind: support }
    const failed = config.error ?? subscriptions.error
    if (failed) {
      return failed instanceof ApiError && failed.status === 404
        ? { kind: 'no_alerts' }
        : { kind: 'error', message: failed.message }
    }
    if (!config.data || !subscriptions.data || browser === undefined) return { kind: 'loading' }
    if (!config.data.available) return { kind: 'unavailable', reason: config.data.reason }
    if (support === 'denied') return { kind: 'denied' }
    const row = browser ? subscriptions.data.find((item) => item.endpointHash === browser.hash) : undefined
    return row ? { kind: 'on', config: config.data, row } : { kind: 'off', config: config.data }
  })()

  const refreshList = () => queryClient.invalidateQueries({ queryKey: [...pushKey, 'subscriptions'] })

  const enable = () => {
    const loaded = config.data
    if (!loaded || busy) return
    // First, synchronously in the tap.
    const permission: Promise<NotificationPermission> =
      Notification.permission === 'granted' ? Promise.resolve('granted') : requestNotificationPermission()
    setBusy('enable')
    setActionError(null)
    void (async () => {
      try {
        const answer = await permission
        if (answer !== 'granted') {
          setSupport(answer)
          return
        }
        setSupport('granted')
        if (state.kind === 'on') {
          // A row the push service dropped: a new subscription, same name and filters.
          await subscribeThisBrowser(loaded, { label: state.row.label, filters: state.row.filters, fresh: true })
        } else {
          await subscribeThisBrowser(loaded, { label: platformLabel() })
        }
        await refreshList()
        readBrowser()
      } catch (error) {
        setActionError(subscribeErrorText(error))
      } finally {
        setBusy(null)
      }
    })()
  }

  const disable = () => {
    if (busy) return
    setBusy('disable')
    setActionError(null)
    void unsubscribeThisBrowser()
      .then(() => {
        setBrowser(null)
        return refreshList()
      })
      .finally(() => setBusy(null))
  }

  return { state, enable, disable, busy, actionError, thisHash: browser?.hash ?? null, subscriptions }
}
