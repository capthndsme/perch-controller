import { useMemo, useState } from 'react'
import { ProtocolStackChart } from '@/components/charts/protocol-stack-chart'
import {
  ProtocolBreakdownPanel,
  type ProtocolTopDevicesOptions,
} from '@/components/devices/protocol-breakdown-panel'
import { Button } from '@/components/ui/button'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import {
  categoryColor,
  categoryFixedColor,
  categoryLabel,
  categoryPinnedSlot,
  foldTimeSeriesByCategory,
  groupProtocolsByCategory,
} from '@/lib/categories'
import {
  chartProtocolsFromBreakdown,
  formatProtocolLabel,
  protocolChartKey,
  protocolColor,
  protocolPinnedSlot,
  protocolTimeSeriesToChartPoints,
  type ProtocolStackSeries,
} from '@/lib/protocols'
import { SERIES_SLOT_COLORS } from '@/lib/rate-series'
import { useStableSeriesOrder, useStableSeriesSlots } from '@/lib/series-colors'
import type { TimeWindow } from '@/lib/time-window'
import type { ProtocolsResponse } from '@/types/api'

export type ProtocolGroupBy = 'protocol' | 'category'

const GROUP_OPTIONS: Array<{ id: ProtocolGroupBy; label: string; hint: string }> = [
  { id: 'protocol', label: 'Protocol', hint: 'One row per detected protocol' },
  { id: 'category', label: 'Category', hint: "Rolled up into nDPI's application categories (web, media, VPN, …)" },
]

type ProtocolsSectionProps = {
  title: string
  description?: string
  data: ProtocolsResponse | undefined
  isPending: boolean
  /**
   * True while a *different* window/scope is loading and we're still showing
   * the previous data (TanStack's `isPlaceholderData`). Drives the loading
   * overlay — note it's deliberately NOT the same as `isFetching`, so the
   * periodic auto-refresh poll doesn't flash the overlay.
   */
  isPlaceholderData?: boolean
  error: Error | null
  compact?: boolean
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
  topDevices?: ProtocolTopDevicesOptions
  /**
   * Show the Protocol | Category toggle. Category mode folds the breakdown
   * and the stacked chart client-side using each protocol's `category`
   * (drill-down to top devices is protocol-only, so it hides in that mode).
   */
  allowGroupBy?: boolean
  defaultGroupBy?: ProtocolGroupBy
}

export function ProtocolsSection({
  title,
  description,
  data,
  isPending,
  isPlaceholderData = false,
  error,
  compact = false,
  onZoom,
  onResetZoom,
  canResetZoom,
  topDevices,
  allowGroupBy = false,
  defaultGroupBy = 'protocol',
}: ProtocolsSectionProps) {
  const [groupBy, setGroupBy] = useState<ProtocolGroupBy>(defaultGroupBy)
  const byCategory = allowGroupBy && groupBy === 'category'

  const breakdown = useMemo(() => {
    const protocols = data?.protocols ?? []
    return byCategory ? groupProtocolsByCategory(protocols) : protocols
  }, [data?.protocols, byCategory])

  const chartKeys = useMemo(
    () => chartProtocolsFromBreakdown(breakdown, compact ? 5 : 8),
    [breakdown, compact],
  )

  // The named series (the rest is `other`): colours by key, distinct among
  // what is on screen, pinned ones first (HTTPS stays blue), and a stable
  // stacking order, so neither a refresh nor a rank swap repaints the chart.
  const named = useMemo(() => chartKeys.filter((name) => name !== 'other'), [chartKeys])
  const scope = byCategory ? 'category' : 'protocol'
  const slots = useStableSeriesSlots(
    named,
    byCategory ? categoryPinnedSlot : protocolPinnedSlot,
    scope,
  )
  const order = useStableSeriesOrder(named, scope)
  const colorOf = useMemo(() => {
    return (name: string): string => {
      const fixed = byCategory ? categoryFixedColor(name) : name === 'other' ? 'var(--series-other)' : undefined
      if (fixed) return fixed
      const slot = slots.get(name)
      if (slot !== undefined) return SERIES_SLOT_COLORS[slot]
      return byCategory ? categoryColor(name) : protocolColor(name)
    }
  }, [slots, byCategory])

  const stackSeries = useMemo<ProtocolStackSeries[]>(() => {
    const label = byCategory ? categoryLabel : formatProtocolLabel
    const list = order.map((name) => ({
      key: protocolChartKey(name),
      name,
      label: label(name),
      color: colorOf(name),
    }))
    if (chartKeys.includes('other')) {
      list.push({
        key: protocolChartKey('other'),
        name: 'other',
        label: 'Other',
        color: 'var(--series-other)',
      })
    }
    return list
  }, [order, chartKeys, colorOf, byCategory])

  const chartData = useMemo(() => {
    if (!data?.timeSeries.length || chartKeys.length === 0) return []
    const series = byCategory ? foldTimeSeriesByCategory(data.timeSeries, data.protocols) : data.timeSeries
    return protocolTimeSeriesToChartPoints(
      series,
      named,
      data.resolutionSeconds,
      chartKeys.includes('other'),
    )
  }, [data, chartKeys, named, byCategory])

  return (
    <section className="relative space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {allowGroupBy ? (
          <div
            className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
            role="radiogroup"
            aria-label="Group protocols by"
          >
            <span className="px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Group by</span>
            {GROUP_OPTIONS.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                role="radio"
                aria-checked={groupBy === option.id}
                variant={groupBy === option.id ? 'secondary' : 'ghost'}
                className="h-6 px-2 text-xs"
                title={option.hint}
                onClick={() => setGroupBy(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {!compact && chartData.length > 0 ? (
        <ProtocolStackChart
          data={chartData}
          series={stackSeries}
          range={data}
          className="h-[260px] w-full"
          onZoom={onZoom}
          onResetZoom={onResetZoom}
          canResetZoom={canResetZoom}
        />
      ) : null}

      <ProtocolBreakdownPanel
        protocols={breakdown}
        isPending={isPending}
        error={error}
        compact={compact}
        initialLimit={compact ? 5 : 8}
        topDevices={byCategory ? undefined : topDevices}
        keyHeading={byCategory ? 'Category' : 'Protocol'}
        labelFor={byCategory ? categoryLabel : undefined}
        colorFor={byCategory ? colorOf : undefined}
      />
      <PanelOverlay show={isPlaceholderData} label="Updating…" />
    </section>
  )
}
