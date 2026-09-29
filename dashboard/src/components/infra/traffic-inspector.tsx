import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { Warning } from '@phosphor-icons/react'
import type { InfraSelection } from '@/components/infra/infra-canvas'
import { Section } from '@/components/infra/inspector-parts'
import type { TrafficChartPoint } from '@/components/infra/traffic-chart'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Segmented } from '@/components/ui/segmented'
import { useInfraLinkTraffic, useInfraNodeTraffic, useInfraPortTraffic } from '@/hooks/use-infra'
import { describePort, otherEnd, portDisplayName, portStateText, type LayoutIndex, type StateIndex } from '@/lib/infra'
import {
  cableDirections,
  CPU_ONLY_EXPLANATION,
  directionBps,
  endNodeName,
  formatTrafficBytes,
  formatTrafficRate,
  nodeDepths,
  SCOPE_LABELS,
  TRAFFIC_SPANS,
  type TrafficSpan,
} from '@/lib/infra-traffic'
import { formatTooltipTimestamp } from '@/lib/time-window'
import { cn } from '@/lib/utils'
import type {
  InfraLink,
  InfraLinkEndRate,
  InfraNode,
  InfraPort,
  InfraTrafficScope,
  InfraTrafficWindow,
} from '@/types/api'

/**
 * The inspector's traffic parts (docs/infrastructure-view.md A6.5): a port's
 * rate now and its accounting, a cable's two directions, a box's per-port
 * totals. The accounting reads run only while these are on screen; the chart
 * comes in its own chunk (Recharts stays out of the map's).
 */

const TrafficChart = lazy(() => import('@/components/infra/traffic-chart'))

const SPAN_KEY = 'perch-infra-traffic-span'

function readSpan(): TrafficSpan {
  try {
    const saved = localStorage.getItem(SPAN_KEY)
    return TRAFFIC_SPANS.some((entry) => entry.id === saved) ? (saved as TrafficSpan) : '24h'
  } catch {
    return '24h'
  }
}

/** The accounting window, remembered per browser across selections (storage may be unavailable). */
function useTrafficSpan(): [TrafficSpan, (next: TrafficSpan) => void] {
  const [span, setSpan] = useState(readSpan)
  return [
    span,
    (next) => {
      setSpan(next)
      try {
        localStorage.setItem(SPAN_KEY, next)
      } catch {
        // Per-viewer convenience only.
      }
    },
  ]
}

function SpanPicker({ value, onChange }: { value: TrafficSpan; onChange: (next: TrafficSpan) => void }) {
  return (
    <Segmented
      ariaLabel="Accounting window"
      size="xs"
      value={value}
      onChange={onChange}
      options={TRAFFIC_SPANS.map(({ id, label, title }) => ({ id, label, title }))}
    />
  )
}

function Swatch({ tone }: { tone: 'down' | 'up' }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-[2px]"
      style={{ backgroundColor: tone === 'down' ? 'var(--chart-download)' : 'var(--chart-upload)' }}
    />
  )
}

/** One direction: swatch, words, value (rate or bytes). */
function DirectionRow({ tone, label, value }: { tone: 'down' | 'up'; label: ReactNode; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <Swatch tone={tone} />
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums">{value}</span>
    </div>
  )
}

function ScopeNote({ scope }: { scope: InfraTrafficScope | null }) {
  if (scope !== 'cpu') return null
  return (
    <Alert className="rounded-md border-status-warning/40 bg-status-warning/5">
      <Warning className="size-4 text-status-warning!" />
      <AlertDescription className="text-[11px]">
        <span className="font-medium text-foreground">{SCOPE_LABELS.cpu}.</span> {CPU_ONLY_EXPLANATION}
      </AlertDescription>
    </Alert>
  )
}

function ChartBox({
  points,
  window,
  downLabel,
  upLabel,
}: {
  points: TrafficChartPoint[]
  window: InfraTrafficWindow
  downLabel: string
  upLabel: string
}) {
  return (
    <Suspense fallback={<div className="h-36 w-full animate-pulse rounded-md bg-muted/40 motion-reduce:animate-none" aria-hidden />}>
      <TrafficChart
        points={points}
        range={window}
        downLabel={downLabel}
        upLabel={upLabel}
        className="aspect-auto h-36 w-full"
      />
    </Suspense>
  )
}

/** "Recording since Sep 30, 12:05", or why there is nothing. */
function SinceLine({ since }: { since: string | null }) {
  return (
    <p className="text-[11px] text-muted-foreground" data-traffic-since>
      {since ? `Recording since ${formatTooltipTimestamp(Date.parse(since))}.` : 'Nothing recorded yet.'}
    </p>
  )
}

/**
 * While another span loads, the last one stays in place, dimmed, instead of
 * the block collapsing to a placeholder and growing back.
 */
const STALE_FADE = 'transition-opacity duration-fast ease-out'

function ReadError({ message }: { message: string }) {
  return <p className="text-[11px] text-status-warning">Could not load the accounting ({message}).</p>
}

// ── Port ─────────────────────────────────────────────────────────────────

/** Why a port has no rate right now. */
function noReadingText(port: InfraPort, index: LayoutIndex, stateIndex: StateIndex): string {
  const state = stateIndex.ports.get(port.id)
  if (port.origin === 'manual') {
    return index.linkByPort.has(port.id)
      ? 'No reading: the port at the other end of its cable is not one a Perch agent measures right now.'
      : 'No reading: a port added by hand is measured through a cable to a port a Perch agent reports.'
  }
  if (!state?.live) return `No reading: ${portStateText(port, state).replace(/^Unknown: /, '')}.`
  if (state.up === false) return 'No reading: the port has no link.'
  return 'No reading yet. Byte counters come with perch-apd 1.1.0-pre.2 and perch-collector 1.1.0-pre.3 or newer; the first rate needs two reports.'
}

/** A port picked on the map or in the list: its rate now and its accounting. */
export function PortTrafficPanel({
  node,
  port,
  index,
  stateIndex,
}: {
  node: InfraNode
  port: InfraPort
  index: LayoutIndex
  stateIndex: StateIndex
}) {
  const [span, setSpan] = useTrafficSpan()
  const traffic = stateIndex.ports.get(port.id)?.traffic ?? null
  const accounting = useInfraPortTraffic(port.id, span)
  const data = accounting.data
  const points = useMemo<TrafficChartPoint[]>(
    () =>
      (data?.points ?? []).map((point) => ({
        ts: Date.parse(point.bucketStart),
        down: point.rxBps / 1_000_000,
        up: point.txBps / 1_000_000,
        downBytes: point.rxBytes,
        upBytes: point.txBytes,
      })),
    [data],
  )
  const measuredElsewhere = data?.measuredBy && data.measuredBy.portId !== port.id ? data.measuredBy.portId : null
  const derivedLink = traffic?.derivedFrom !== null && traffic?.derivedFrom !== undefined ? index.links.get(traffic.derivedFrom) : undefined
  const farPortId = derivedLink ? otherEnd(derivedLink, port.id).portId : measuredElsewhere

  return (
    <Section
      title={`Traffic · ${portDisplayName(port)}`}
      action={<SpanPicker value={span} onChange={setSpan} />}
    >
      <div className="space-y-3" data-port-traffic={port.id}>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Now</p>
          {traffic ? (
            <>
              <DirectionRow tone="down" label="↓ Received" value={formatTrafficRate(traffic.rxBps)} />
              <DirectionRow tone="up" label="↑ Sent" value={formatTrafficRate(traffic.txBps)} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-no-reading>
              {noReadingText(port, index, stateIndex)}
            </p>
          )}
          {farPortId !== null ? (
            <p className="text-[11px] text-muted-foreground">
              Measured at {describePort(index, farPortId)}, the other end of the cable, and turned to this side.
            </p>
          ) : null}
        </div>
        {traffic ? <ScopeNote scope={traffic.scope} /> : null}

        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {TRAFFIC_SPANS.find((entry) => entry.id === span)?.title}
          </p>
          {accounting.error && !data ? <ReadError message={accounting.error.message} /> : null}
          {accounting.isPending ? <div className="h-36 w-full animate-pulse rounded-md bg-muted/40 motion-reduce:animate-none" aria-hidden /> : null}
          {data && data.measuredBy === null ? (
            <p className="text-xs text-muted-foreground">Nothing measures this port, so nothing is counted.</p>
          ) : null}
          {data && data.measuredBy !== null ? (
            <div
              className={cn('space-y-1.5', STALE_FADE, accounting.isPlaceholderData && 'opacity-60')}
              aria-busy={accounting.isPlaceholderData || undefined}
            >
              <DirectionRow tone="down" label="Received" value={formatTrafficBytes(data.totals.rxBytes)} />
              <DirectionRow tone="up" label="Sent" value={formatTrafficBytes(data.totals.txBytes)} />
              <ChartBox points={points} window={data.window} downLabel="Received" upLabel="Sent" />
              <SinceLine since={data.since} />
            </div>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {node.name}'s side: received is what came in over the cable, sent what went out.
        </p>
      </div>
    </Section>
  )
}

// ── Node ─────────────────────────────────────────────────────────────────

/** A box's per-port totals for the window, with each port's rate now. */
export function NodeTrafficTable({
  node,
  stateIndex,
  onSelect,
}: {
  node: InfraNode
  stateIndex: StateIndex
  onSelect: (selection: InfraSelection | null) => void
}) {
  const [span, setSpan] = useTrafficSpan()
  const totals = useInfraNodeTraffic(node.id, span)
  const byPort = new Map((totals.data?.ports ?? []).map((entry) => [entry.portId, entry]))
  const visible = node.ports.filter((port) => !port.hidden)
  if (visible.length === 0) return null
  const anyMeasured = totals.data ? totals.data.ports.some((entry) => entry.measuredBy !== null) : true
  return (
    <Section title="Traffic by port" action={<SpanPicker value={span} onChange={setSpan} />}>
      {totals.error && !totals.data ? <ReadError message={totals.error.message} /> : null}
      {!anyMeasured ? (
        <p className="text-xs text-muted-foreground">
          None of these ports is measured: byte counters come from Perch agents (perch-apd 1.1.0-pre.2, perch-collector
          1.1.0-pre.3 or newer), and a port added by hand through its cable to one.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className={cn('w-full text-xs', STALE_FADE, totals.isPlaceholderData && 'opacity-60')}
            data-node-traffic={node.id}
            aria-busy={totals.isPlaceholderData || undefined}
          >
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-1 pr-2 text-left font-normal">
                  Port
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-normal">
                  <span className="inline-flex items-center gap-1">
                    <Swatch tone="down" />
                    Received
                  </span>
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-normal">
                  <span className="inline-flex items-center gap-1">
                    <Swatch tone="up" />
                    Sent
                  </span>
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  Now ↓ / ↑
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((port) => {
                const entry = byPort.get(port.id)
                const now = stateIndex.ports.get(port.id)?.traffic ?? null
                const measured = entry ? entry.measuredBy !== null : false
                return (
                  <tr key={port.id}>
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        className="font-mono text-brand underline-offset-2 hover:underline"
                        onClick={() => onSelect({ type: 'node', id: node.id, portId: port.id })}
                      >
                        {port.label}
                      </button>
                    </td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">
                      {measured ? formatTrafficBytes(entry!.rxBytes) : totals.isPending ? '…' : '—'}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">
                      {measured ? formatTrafficBytes(entry!.txBytes) : totals.isPending ? '…' : '—'}
                    </td>
                    <td className="py-1 text-right font-mono whitespace-nowrap tabular-nums text-muted-foreground">
                      {now ? `${formatTrafficRate(now.rxBps)} / ${formatTrafficRate(now.txBps)}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// ── Cable ────────────────────────────────────────────────────────────────

function EndReading({
  end,
  rate,
  index,
}: {
  end: InfraLink['a']
  rate: InfraLinkEndRate | null
  index: LayoutIndex
}) {
  return (
    <div className="space-y-0.5 text-xs">
      <p className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{describePort(index, end.portId)}</span>
        {rate?.scope ? (
          <span
            className={cn(
              'shrink-0 rounded-sm px-1 text-[10px] font-medium',
              rate.scope === 'cpu' ? 'bg-status-warning/15 text-status-warning' : 'bg-muted text-muted-foreground',
            )}
          >
            {SCOPE_LABELS[rate.scope]}
          </span>
        ) : null}
      </p>
      <p className="font-mono tabular-nums text-muted-foreground">
        {rate
          ? `received ${formatTrafficRate(rate.rxBps)} · sent ${formatTrafficRate(rate.txBps)}`
          : 'not measured'}
      </p>
    </div>
  )
}

/** A cable's two directions now, both ends' readings, and its accounting. */
export function CableTrafficSection({ link, index, stateIndex }: { link: InfraLink; index: LayoutIndex; stateIndex: StateIndex }) {
  const [span, setSpan] = useTrafficSpan()
  const traffic = stateIndex.links.get(link.id)?.traffic ?? null
  const directions = useMemo(() => cableDirections(link, nodeDepths(index)), [link, index])
  const accounting = useInfraLinkTraffic(link.id, span)
  const data = accounting.data
  const downLabel = `${endNodeName(index, directions.down.from)} → ${endNodeName(index, directions.down.to)}`
  const upLabel = `${endNodeName(index, directions.up.from)} → ${endNodeName(index, directions.up.to)}`
  const points = useMemo<TrafficChartPoint[]>(
    () =>
      (data?.points ?? []).map((point) => {
        const downAToB = directions.down.key === 'aToB'
        return {
          ts: Date.parse(point.bucketStart),
          down: (downAToB ? point.aToBBps : point.bToABps) / 1_000_000,
          up: (downAToB ? point.bToABps : point.aToBBps) / 1_000_000,
          downBytes: downAToB ? point.aToBBytes : point.bToABytes,
          upBytes: downAToB ? point.bToABytes : point.aToBBytes,
        }
      }),
    [data, directions],
  )
  const measured = data ? data.measuredBy.a !== null || data.measuredBy.b !== null : false
  const downTotal = data ? (directions.down.key === 'aToB' ? data.totals.aToBBytes : data.totals.bToABytes) : 0
  const upTotal = data ? (directions.up.key === 'aToB' ? data.totals.aToBBytes : data.totals.bToABytes) : 0

  return (
    <Section title="Traffic" action={<SpanPicker value={span} onChange={setSpan} />}>
      <div className="space-y-3" data-link-traffic={link.id}>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Now</p>
          {traffic ? (
            <>
              <DirectionRow tone="down" label={downLabel} value={formatTrafficRate(directionBps(traffic, directions.down.key))} />
              <DirectionRow tone="up" label={upLabel} value={formatTrafficRate(directionBps(traffic, directions.up.key))} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-no-reading>
              No reading: neither end is a port a Perch agent measures right now.
            </p>
          )}
        </div>
        {traffic ? (
          <div className="space-y-2 rounded-md border border-border px-2.5 py-2">
            <EndReading end={link.a} rate={traffic.ends.a} index={index} />
            <EndReading end={link.b} rate={traffic.ends.b} index={index} />
            {traffic.ends.a && traffic.ends.b ? (
              <p className="text-[11px] text-muted-foreground">
                Each direction shows the larger of the two ends' readings: one end can miss frames the other counted.
              </p>
            ) : null}
          </div>
        ) : null}
        {traffic?.partial ? <ScopeNote scope="cpu" /> : null}

        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {TRAFFIC_SPANS.find((entry) => entry.id === span)?.title}
          </p>
          {accounting.error && !data ? <ReadError message={accounting.error.message} /> : null}
          {accounting.isPending ? <div className="h-36 w-full animate-pulse rounded-md bg-muted/40 motion-reduce:animate-none" aria-hidden /> : null}
          {data && !measured ? (
            <p className="text-xs text-muted-foreground">Neither end is measured, so nothing is counted.</p>
          ) : null}
          {data && measured ? (
            <div
              className={cn('space-y-1.5', STALE_FADE, accounting.isPlaceholderData && 'opacity-60')}
              aria-busy={accounting.isPlaceholderData || undefined}
            >
              <DirectionRow tone="down" label={downLabel} value={formatTrafficBytes(downTotal)} />
              <DirectionRow tone="up" label={upLabel} value={formatTrafficBytes(upTotal)} />
              <ChartBox points={points} window={data.window} downLabel={downLabel} upLabel={upLabel} />
              <SinceLine since={data.since} />
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  )
}
