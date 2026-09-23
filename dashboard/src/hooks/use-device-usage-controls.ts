import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  deviceUsagePreset,
  parseDeviceUsagePeriod,
  type DeviceUsagePeriod,
  type DeviceUsagePreset,
} from '@/lib/usage'

export type DeviceUsageControls = {
  period: DeviceUsagePeriod
  preset: DeviceUsagePreset
  setPeriod: (period: DeviceUsagePeriod) => void
  setPreset: (id: string) => void
}

/**
 * State of the device page's Usage card, kept in the URL under its own keys
 * (`?usagePeriod=day|month`, `?usageRange=<preset id>`) so a copied link
 * reproduces it. It never touches the page's `?range` / `?from&to`: the card
 * has its own span, and the page window only moves when a column is clicked.
 * Absent keys mean the defaults (Daily, 30 days); changes replace the history
 * entry, so Back still walks the page's window changes.
 */
export function useDeviceUsageControls(): DeviceUsageControls {
  const [searchParams, setSearchParams] = useSearchParams()
  const period = parseDeviceUsagePeriod(searchParams.get('usagePeriod')) ?? 'day'
  const preset = deviceUsagePreset(period, searchParams.get('usageRange'))

  const setPeriod = useCallback(
    (next: DeviceUsagePeriod) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('usagePeriod', next)
          // A day preset means nothing monthly: fall back to the period's default.
          params.delete('usageRange')
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const setPreset = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('usagePeriod', period)
          params.set('usageRange', id)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams, period],
  )

  return { period, preset, setPeriod, setPreset }
}
