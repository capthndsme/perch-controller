import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { retryUnlessNotFound, wifiQueryKey } from '@/hooks/use-wifi'
import { apiFetch } from '@/lib/api'
import type {
  DeviceTrafficResponse,
  ProtocolsResponse,
  TrafficResolution,
  UsagePeriod,
  WifiClientSignalResponse,
} from '@/types/api'

/**
 * The device summary on the Infrastructure page: Today, This week or This
 * month, calendar periods in the instance timezone, each running from its
 * start to now.
 *
 * The window hooks in use-devices / use-wifi do not fit a period that keeps
 * running: an absolute window never refetches there, and its `to` is part of
 * the key. These key on where the period starts (and the MAC) and send
 * `to` = now when they fetch, so a refetch brings the latest minutes into
 * the same cache entry, and a new day, week or month is a new key.
 */
export type SummaryWindow = {
  period: UsagePeriod
  /** UTC ISO start of the period. */
  from: string
  /** Grain of the rate and signal series. */
  resolution: TrafficResolution
}

/** Today moves by the minute; a week or a month barely does in five. */
const REFETCH_MS: Record<UsagePeriod, number> = { day: 60_000, week: 300_000, month: 300_000 }

/** `from`, `to` = now (never at or before `from`, which the API refuses), and `extra`. */
function windowParams(window: SummaryWindow, extra: Record<string, string>): URLSearchParams {
  const to = new Date(Math.max(Date.now(), Date.parse(window.from) + 1000)).toISOString()
  return new URLSearchParams({ from: window.from, to, ...extra })
}

function devicePath(mac: string): string {
  return `/api/v1/devices/${encodeURIComponent(mac)}`
}

/** Download / upload per bucket (device terms: `bytesIn` is download). 404: the MAC has no traffic at all. */
export function useSummaryTraffic(mac: string, window: SummaryWindow | null) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['devices', mac, 'summary', 'traffic', window?.from ?? '', window?.resolution ?? ''] as const,
    queryFn: () =>
      apiFetch<DeviceTrafficResponse>(
        `${devicePath(mac)}/traffic?${windowParams(window!, { resolution: window!.resolution, scope: 'all' })}`,
      ),
    enabled: window !== null,
    refetchInterval: window ? REFETCH_MS[window.period] : false,
    retry: retryUnlessNotFound,
  })
}

/**
 * The period's applications (nDPI protocols) with their category. Only the
 * summary is used: the time series comes along at one bucket a day, its
 * smallest form.
 */
export function useSummaryProtocols(mac: string, window: SummaryWindow | null) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['devices', mac, 'summary', 'protocols', window?.from ?? ''] as const,
    queryFn: () =>
      apiFetch<ProtocolsResponse>(`${devicePath(mac)}/protocols?${windowParams(window!, { resolution: '1d' })}`),
    enabled: window !== null,
    refetchInterval: window ? REFETCH_MS[window.period] : false,
    retry: retryUnlessNotFound,
  })
}

/** Signal per bucket while the device was on Wi-Fi in the period. */
export function useSummarySignal(mac: string, window: SummaryWindow | null, enabled: boolean) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...wifiQueryKey, 'client-signal', mac, 'summary', window?.from ?? '', window?.resolution ?? ''] as const,
    queryFn: () =>
      apiFetch<WifiClientSignalResponse>(
        `/api/v1/wifi/clients/${encodeURIComponent(mac)}/signal?${windowParams(window!, { resolution: window!.resolution })}`,
      ),
    enabled: enabled && window !== null,
    refetchInterval: window ? REFETCH_MS[window.period] : false,
    retry: retryUnlessNotFound,
  })
}

/**
 * The current rate: the last three minutes at 1 m, whatever the period (the
 * period's own buckets are 15 min or an hour wide). Polled every minute.
 */
export function useSummaryNowRate(mac: string, enabled: boolean) {
  return useQuery({
    queryKey: ['devices', mac, 'summary', 'now'] as const,
    queryFn: () => apiFetch<DeviceTrafficResponse>(`${devicePath(mac)}/traffic?range=3m&resolution=1m&scope=all`),
    enabled,
    refetchInterval: 60_000,
    retry: retryUnlessNotFound,
  })
}
