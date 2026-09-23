import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import {
  applyWindowToParams,
  shouldAutoRefresh,
  windowKey,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import type {
  UsageIntervalRequest,
  UsageIntervalsResponse,
  UsagePeriod,
  UsageResponse,
  UsageScope,
} from '@/types/api'

/**
 * vnstat-style usage buckets (per local day / week / month) with the
 * active-device count, Wi-Fi client avg/peak and top protocols in each.
 * Without a window the API applies its own default look-back per period
 * (day → 30d, week → 182d, month → 365d). With `mac` it is that device's
 * usage (the device page's Usage card): `activeDevices` / `wifiClients` are
 * then `null`.
 */
export function useUsage(options: {
  period: UsagePeriod
  window?: TimeWindow
  scope?: UsageScope
  collectorId?: number
  mac?: string
  protocols?: number
  refreshInterval?: RefreshInterval
  enabled?: boolean
}) {
  const params = new URLSearchParams({ period: options.period })
  if (options.window) applyWindowToParams(params, options.window)
  if (options.scope) params.set('scope', options.scope)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))
  if (options.protocols) params.set('protocols', String(options.protocols))
  if (options.mac) params.set('mac', options.mac)

  const autoRefresh = options.window ? shouldAutoRefresh(options.window) : true
  const refetchInterval =
    !autoRefresh || options.refreshInterval === null
      ? false
      : Math.max(options.refreshInterval ?? 60_000, 60_000)

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'usage',
      options.period,
      options.window ? windowKey(options.window) : 'default',
      options.scope ?? 'all',
      options.collectorId ?? 'all',
      options.protocols ?? 'default',
      options.mac ?? 'network',
    ] as const,
    queryFn: () => apiFetch<UsageResponse>(`/api/v1/usage?${params}`),
    // Buckets only move as the hourly rollup lands; a minute is plenty.
    refetchInterval,
    enabled: options.enabled ?? true,
  })
}

/**
 * The instance timezone (set up with the site name) that the usage buckets
 * follow, for pages that draw their own calendar periods (the Infrastructure
 * page's device summary). No endpoint serves it alone; the smallest usage
 * report, one hourly slot for the last minute, echoes it. Read once per visit.
 */
export function useInstanceTimezone(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['usage', 'timezone'] as const,
    queryFn: async () =>
      (await apiFetch<UsageIntervalsResponse>('/api/v1/usage/intervals?range=1m&interval=1h')).timezone,
    staleTime: Number.POSITIVE_INFINITY,
    enabled: options.enabled ?? true,
  })
}

/**
 * Sub-day slots for the hourly breakdown under the daily view (1 h / 4 h /
 * 8 h / 12 h, aligned to local midnight). `auto` lets the API pick by span
 * (1 h up to a week, then coarser); read `data.interval` for the result.
 */
export function useUsageIntervals(options: {
  window: TimeWindow
  scope?: UsageScope
  interval?: UsageIntervalRequest
  collectorId?: number
  /** One device's slots (`activeDevices` is then `null`). */
  mac?: string
  refreshInterval?: RefreshInterval
  enabled?: boolean
}) {
  const params = new URLSearchParams({ interval: options.interval ?? 'auto' })
  applyWindowToParams(params, options.window)
  if (options.scope) params.set('scope', options.scope)
  if (options.collectorId) params.set('collectorId', String(options.collectorId))
  if (options.mac) params.set('mac', options.mac)

  const refetchInterval =
    !shouldAutoRefresh(options.window) || options.refreshInterval === null
      ? false
      : Math.max(options.refreshInterval ?? 60_000, 60_000)

  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      'usage',
      'intervals',
      windowKey(options.window),
      options.interval ?? 'auto',
      options.scope ?? 'all',
      options.collectorId ?? 'all',
      options.mac ?? 'network',
    ] as const,
    queryFn: () => apiFetch<UsageIntervalsResponse>(`/api/v1/usage/intervals?${params}`),
    refetchInterval,
    enabled: options.enabled ?? true,
  })
}
