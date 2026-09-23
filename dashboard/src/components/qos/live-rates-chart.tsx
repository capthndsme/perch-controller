import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import type { QosLiveSample } from '@/lib/qos-live'
import type { QosPolicy, QosWanQueue } from '@/types/api'

/**
 * The last few minutes of live rates on this page (Recharts stays in this
 * page's chunk): the WAN line per direction, or each shared bucket's download.
 * One Mbit/s axis; the history is kept in the browser (lib/qos-live.ts), so it
 * starts empty when the page opens.
 */
type Props = {
  samples: QosLiveSample[]
  wan: QosWanQueue[]
  policies: QosPolicy[]
}

type View = 'wan' | 'buckets'

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)']

function timeLabel(t: number): string {
  return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(t)
}

export function LiveRatesChart({ samples, wan, policies }: Props) {
  const buckets = useMemo(() => policies.filter((p) => p.shared !== null).sort((a, b) => a.id - b.id), [policies])
  const [view, setView] = useState<View>('wan')
  const current: View = view === 'buckets' && buckets.length === 0 ? 'wan' : view

  const { data, config, keys } = useMemo(() => {
    const config: ChartConfig = {}
    const keys: { key: string; dashed: boolean }[] = []
    if (current === 'wan') {
      const multi = wan.length > 1
      wan.forEach((q, i) => {
        const down = `wan_down_${i}`
        const up = `wan_up_${i}`
        config[down] = { label: multi ? `${q.device} download` : 'Download', color: multi ? SERIES[(i * 2) % 8] : 'var(--chart-download)' }
        config[up] = { label: multi ? `${q.device} upload` : 'Upload', color: multi ? SERIES[(i * 2 + 1) % 8] : 'var(--chart-upload)' }
        keys.push({ key: down, dashed: false }, { key: up, dashed: false })
      })
    } else {
      // Colour follows the policy (by id order), never its rank; past eight they share the last slot.
      buckets.forEach((p, i) => {
        const key = `b_${p.id}`
        config[key] = { label: p.name, color: SERIES[Math.min(i, 7)] }
        keys.push({ key, dashed: false })
      })
    }
    const data = samples.map((s) => {
      const row: Record<string, number | null> = { t: s.t }
      if (current === 'wan') {
        wan.forEach((q, i) => {
          row[`wan_down_${i}`] = s.wan[q.device]?.down ?? null
          row[`wan_up_${i}`] = s.wan[q.device]?.up ?? null
        })
      } else {
        for (const p of buckets) row[`b_${p.id}`] = s.buckets[p.id]?.down ?? null
      }
      return row
    })
    return { data, config, keys }
  }, [samples, wan, buckets, current])
  const hasValues = data.some((row) => keys.some(({ key }) => typeof row[key] === 'number'))

  return (
    <Panel
      title="Live rates"
      description={
        current === 'wan'
          ? 'Mbit/s through each WAN queue, from the router’s reports while this page is open.'
          : 'Download Mbit/s through each shared bucket, while this page is open.'
      }
      actions={
        buckets.length ? (
          <Segmented
            ariaLabel="Live rates view"
            size="xs"
            value={current}
            onChange={setView}
            options={[
              { id: 'wan', label: 'WAN' },
              { id: 'buckets', label: 'Buckets' },
            ]}
          />
        ) : null
      }
    >
      {data.length < 2 || !hasValues ? (
        <p className="flex h-[220px] items-center justify-center text-center text-xs text-muted-foreground">
          {data.length === 0
            ? 'Waiting for the router’s first report…'
            : !hasValues
              ? 'The router reports no live rates for these queues right now.'
              : 'Collecting: the chart fills in every 5 seconds.'}
        </p>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={48} />
            <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${Number(v.toFixed(1))}`} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const t = payload?.[0]?.payload?.t
                    return typeof t === 'number' ? timeLabel(t) : ''
                  }}
                  formatter={(value, name) => (
                    <span className="flex w-full justify-between gap-3">
                      <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                      <span className="font-mono tabular-nums">{typeof value === 'number' ? `${value.toFixed(2)} Mbit/s` : '—'}</span>
                    </span>
                  )}
                />
              }
            />
            {keys.map(({ key, dashed }) => (
              <Line
                key={key}
                dataKey={key}
                type="monotone"
                stroke={`var(--color-${key})`}
                strokeWidth={2}
                strokeDasharray={dashed ? '4 3' : undefined}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {keys.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
          </LineChart>
        </ChartContainer>
      )}
    </Panel>
  )
}
