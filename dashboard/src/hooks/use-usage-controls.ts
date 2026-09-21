import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { applyWindowToParams, parseWindowFromParams, type TimeWindow } from '@/lib/time-window'
import {
  defaultUsageWindow,
  parseUsageChartMode,
  parseUsagePeriod,
  parseUsageScope,
  type UsageChartMode,
} from '@/lib/usage'
import type { UsagePeriod, UsageScope } from '@/types/api'

export type UsageControls = {
  period: UsagePeriod
  window: TimeWindow
  scope: UsageScope
  /** `bytes` (down / up stack) or `apps` (two stacks by application category). */
  mode: UsageChartMode
  setPeriod: (period: UsagePeriod) => void
  setWindow: (window: TimeWindow) => void
  setScope: (scope: UsageScope) => void
  setMode: (mode: UsageChartMode) => void
}

/**
 * URL-backed state for the Usage page (`?period=` · `?range=` or
 * `?from&to` · `?scope=`), so a view is shareable and survives reload —
 * the same contract `useDashboardTime` uses for the window. Changing the
 * period swaps a *relative* window for that period's default preset (a
 * 30-day daily view has no meaning as "weekly"); an absolute custom range
 * is kept and simply re-bucketed.
 */
export function useUsageControls(): UsageControls {
  const [searchParams, setSearchParams] = useSearchParams()

  const period = parseUsagePeriod(searchParams.get('period')) ?? 'day'
  const window = parseWindowFromParams(searchParams) ?? defaultUsageWindow(period)
  const scope = parseUsageScope(searchParams.get('scope')) ?? 'all'
  // `?mode=` is optional: absent means the down / up stack.
  const mode = parseUsageChartMode(searchParams.get('mode')) ?? 'bytes'

  // Seed missing params on mount so the address bar reproduces the view.
  useEffect(() => {
    const hasPeriod = Boolean(parseUsagePeriod(searchParams.get('period')))
    const hasWindow = Boolean(parseWindowFromParams(searchParams))
    const hasScope = Boolean(parseUsageScope(searchParams.get('scope')))
    if (hasPeriod && hasWindow && hasScope) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (!hasPeriod) next.set('period', period)
        if (!hasWindow) applyWindowToParams(next, window)
        if (!hasScope) next.set('scope', scope)
        return next
      },
      { replace: true },
    )
    // Mount-only seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setWindow = useCallback(
    (next: TimeWindow) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        params.delete('range')
        params.delete('from')
        params.delete('to')
        applyWindowToParams(params, next)
        return params
      })
    },
    [setSearchParams],
  )

  const setPeriod = useCallback(
    (next: UsagePeriod) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        params.set('period', next)
        const current = parseWindowFromParams(params)
        if (!current || current.kind === 'relative') {
          params.delete('range')
          params.delete('from')
          params.delete('to')
          applyWindowToParams(params, defaultUsageWindow(next))
        }
        return params
      })
    },
    [setSearchParams],
  )

  const setScope = useCallback(
    (next: UsageScope) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('scope', next)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const setMode = useCallback(
    (next: UsageChartMode) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next === 'bytes') params.delete('mode')
          else params.set('mode', next)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  return { period, window, scope, mode, setPeriod, setWindow, setScope, setMode }
}
