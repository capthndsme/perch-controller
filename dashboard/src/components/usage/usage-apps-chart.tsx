import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip } from '@/components/ui/chart'
import { Row } from '@/components/usage/usage-bar-chart'
import { buildCategoryChartConfig, categoryColor, categoryLabel, OTHER_CATEGORY } from '@/lib/categories'
import { formatBytes } from '@/lib/format-bytes'
import { bucketHint, bucketTick, bucketTitle } from '@/lib/usage'
import type { UsageBucket, UsagePeriod, UsageTotals } from '@/types/api'

/** Categories that get their own colour; everything else folds into "other". */
const TOP_CATEGORIES = 8

type AppPoint = {
  key: string
  tick: string
  title: string
  hint: string | null
  partial: boolean
  bytesIn: number
  bytesOut: number
  totalBytes: number
  /** `in:<category>` and `out:<category>` stack keys. */
  values: Record<string, number>
  /** Per-category split for the tooltip, sorted by total desc. */
  breakdown: Array<{ category: string; bytesIn: number; bytesOut: number; totalBytes: number }>
}

type UsageAppsChartProps = {
  period: UsagePeriod
  buckets: UsageBucket[]
  totals: UsageTotals
  className?: string
}

function stackKey(direction: 'in' | 'out', category: string): string {
  return `${direction}:${category}`
}

/**
 * Applications mode: two columns per bucket, side by side — Download on the
 * left, Upload on the right — each stacked by application category. The
 * stack uses one fixed key set (the window's top categories plus "other")
 * so a category keeps its position and colour from bucket to bucket.
 */
export function UsageAppsChart({ period, buckets, totals, className }: UsageAppsChartProps) {
  const categories = useMemo(() => {
    const top = totals.categories
      .filter((c) => c.category !== OTHER_CATEGORY)
      .slice(0, TOP_CATEGORIES)
      .map((c) => c.category)
    const needsOther =
      totals.categories.some((c) => c.category === OTHER_CATEGORY) || totals.categories.length > top.length
    return needsOther ? [...top, OTHER_CATEGORY] : top
  }, [totals])
  const known = useMemo(() => new Set(categories.filter((c) => c !== OTHER_CATEGORY)), [categories])

  const points = useMemo<AppPoint[]>(
    () =>
      buckets.map((b) => {
        const values: Record<string, number> = {}
        for (const c of categories) {
          values[stackKey('in', c)] = 0
          values[stackKey('out', c)] = 0
        }
        const split = new Map<string, { bytesIn: number; bytesOut: number }>()
        for (const c of b.categories) {
          const key = known.has(c.category) ? c.category : OTHER_CATEGORY
          const acc = split.get(key) ?? { bytesIn: 0, bytesOut: 0 }
          acc.bytesIn += c.bytesIn
          acc.bytesOut += c.bytesOut
          split.set(key, acc)
          values[stackKey('in', key)] = (values[stackKey('in', key)] ?? 0) + c.bytesIn
          values[stackKey('out', key)] = (values[stackKey('out', key)] ?? 0) + c.bytesOut
        }
        return {
          key: b.bucketStart,
          tick: bucketTick(period, b.label),
          title: bucketTitle(period, b.label),
          hint: bucketHint(period, b),
          partial: b.partial,
          bytesIn: b.bytesIn,
          bytesOut: b.bytesOut,
          totalBytes: b.totalBytes,
          values,
          breakdown: [...split.entries()]
            .map(([category, v]) => ({ category, ...v, totalBytes: v.bytesIn + v.bytesOut }))
            .sort((a, x) => x.totalBytes - a.totalBytes),
        }
      }),
    [buckets, categories, known, period],
  )
  const chartConfig = useMemo(() => buildCategoryChartConfig(categories), [categories])

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChartContainer config={chartConfig} className={className}>
        <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="24%" barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="tick"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={64}
            allowDecimals={false}
            tickFormatter={(value: number) => formatBytes(value, 0)}
          />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)', fillOpacity: 0.5 }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as AppPoint | undefined
              if (!active || !point) return null
              return (
                <div className="min-w-64 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-xl">
                  <p className="mb-1.5 font-medium">
                    {point.title}
                    {point.hint ? <span className="ml-1 text-muted-foreground">· {point.hint}</span> : null}
                    <span className="ml-1 text-muted-foreground">· ↓ down · ↑ up</span>
                  </p>
                  <table className="w-full">
                    <tbody>
                      {point.breakdown.map((row) => (
                        <tr key={row.category}>
                          <td className="py-px pr-3 text-muted-foreground">
                            <span className="flex items-center gap-1.5">
                              <span
                                aria-hidden
                                className="size-2 rounded-[2px]"
                                style={{ backgroundColor: categoryColor(row.category) }}
                              />
                              {categoryLabel(row.category)}
                            </span>
                          </td>
                          <td className="py-px pr-2 text-right font-mono tabular-nums text-muted-foreground">
                            ↓ {formatBytes(row.bytesIn)}
                          </td>
                          <td className="py-px pr-2 text-right font-mono tabular-nums text-muted-foreground">
                            ↑ {formatBytes(row.bytesOut)}
                          </td>
                          <td className="py-px text-right font-mono tabular-nums">{formatBytes(row.totalBytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-1.5 border-t border-border/60 pt-1.5">
                    <Row swatch="var(--chart-download)" label="Download" value={formatBytes(point.bytesIn)} />
                    <Row swatch="var(--chart-upload)" label="Upload" value={formatBytes(point.bytesOut)} />
                    <Row label={point.partial ? 'Total so far' : 'Total'} value={formatBytes(point.totalBytes)} strong />
                  </div>
                </div>
              )
            }}
          />
          {categories.map((category, index) => {
            const last = index === categories.length - 1
            return (
              <Bar
                key={stackKey('in', category)}
                dataKey={`values.${stackKey('in', category)}`}
                name={`in:${category}`}
                stackId="in"
                fill={categoryColor(category)}
                stroke="var(--card)"
                strokeWidth={1}
                radius={last ? [3, 3, 0, 0] : undefined}
                maxBarSize={18}
                isAnimationActive={false}
              >
                {points.map((p) => (
                  <Cell key={p.key} fillOpacity={p.partial ? 0.45 : 1} />
                ))}
              </Bar>
            )
          })}
          {categories.map((category, index) => {
            const last = index === categories.length - 1
            return (
              <Bar
                key={stackKey('out', category)}
                dataKey={`values.${stackKey('out', category)}`}
                name={`out:${category}`}
                stackId="out"
                fill={categoryColor(category)}
                stroke="var(--card)"
                strokeWidth={1}
                radius={last ? [3, 3, 0, 0] : undefined}
                maxBarSize={18}
                isAnimationActive={false}
              >
                {points.map((p) => (
                  <Cell key={p.key} fillOpacity={p.partial ? 0.45 : 1} />
                ))}
              </Bar>
            )
          })}
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
        <span className="font-medium">↓ down · ↑ up</span>
        <span aria-hidden>·</span>
        {categories.map((category) => (
          <span key={category} className="flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ backgroundColor: categoryColor(category) }} />
            {categoryLabel(category)}
          </span>
        ))}
      </div>
    </div>
  )
}
