import { useEffect, useMemo, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowSquareOut, PlugsConnected } from '@phosphor-icons/react'
import { CategoryChip } from '@/components/destinations/category-chip'
import { Section } from '@/components/infra/inspector-parts'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import {
  useSummaryNowRate,
  useSummaryProtocols,
  useSummarySignal,
  useSummaryTraffic,
  type SummaryWindow,
} from '@/hooks/use-device-summary'
import { useInstanceTimezone } from '@/hooks/use-usage'
import { useWifiClient } from '@/hooks/use-wifi'
import { ApiError } from '@/lib/api'
import { formatLastSeen } from '@/lib/collectors'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { signalStroke } from '@/lib/infra-overlay'
import { formatProtocolLabel, protocolColor } from '@/lib/protocols'
import { guessTimezone } from '@/lib/timezones'
import { downsampleTimeSeries, macPath } from '@/lib/traffic'
import { parseUsagePeriod, periodStart, RUNNING_PERIOD_LABELS, USAGE_PERIOD_VALUES } from '@/lib/usage'
import { cn } from '@/lib/utils'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass, wifiSignalQualityLabel } from '@/lib/wifi'
import type {
  DeviceTrafficResponse,
  ProtocolBreakdown,
  TrafficResolution,
  UsagePeriod,
  WifiClientDetailResponse,
  WifiClientSignalResponse,
  WifiClientSummary,
  WifiSignalQuality,
} from '@/types/api'

/**
 * The device summary in the Infrastructure page's side panel, for a box bound
 * to a device and for a chip of the Wi-Fi overlay: speed, top applications and
 * the Wi-Fi signal and roams (or where its cable goes) for Today, This week or
 * This month, calendar periods in the instance timezone like the Usage page's.
 * Mounted only while that device's panel is open, so it fetches only then.
 * The sparklines are inline SVG: Recharts stays out of this page's chunk.
 */

// ── Period ───────────────────────────────────────────────────────────────

/** Remembered per browser; without storage it lasts for this visit. */
const PERIOD_KEY = 'perch-infra-summary-period'
let periodThisVisit: UsagePeriod | null = null

function readPeriod(): UsagePeriod {
  try {
    const stored = parseUsagePeriod(localStorage.getItem(PERIOD_KEY))
    if (stored) return stored
  } catch {
    // Storage blocked: fall back below.
  }
  return periodThisVisit ?? 'day'
}

function rememberPeriod(period: UsagePeriod) {
  periodThisVisit = period
  try {
    localStorage.setItem(PERIOD_KEY, period)
  } catch {
    // Per-viewer convenience only.
  }
}

const PERIOD_OPTIONS = USAGE_PERIOD_VALUES.map((id) => ({ id, label: RUNNING_PERIOD_LABELS[id] }))

/** Series grain: at most 96 points for a day, 168 for a week, 744 for a month. */
const RESOLUTION: Record<UsagePeriod, TrafficResolution> = { day: '15m', week: '1h', month: '1h' }
const RESOLUTION_MS: Record<UsagePeriod, number> = { day: 900_000, week: 3_600_000, month: 3_600_000 }
const GRAIN_WORDS: Record<UsagePeriod, string> = { day: '15-min avg', week: 'hourly avg', month: 'hourly avg' }

/** The rollups are rebuilt every minute: a bucket is taken as complete this long after it ends. */
const SETTLE_MS = 2 * 60_000
/** A month is 744 hourly points; drawing keeps this many (LTTB keeps the peaks). */
const MAX_DRAWN = 240
/** The API sends a client's 30 latest roams. */
const ROAMS_SENT = 30

/** Wall time, a minute at a time: where "now" is, and which day, week or month it is in. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

type Formats = {
  /** Where the period starts: "00:00", "Mon 21", "Sep 1". */
  start: string
  /** A moment in the period: "14:15", "Tue 14:00", "Sep 3, 14:00". */
  point: (ts: number) => string
}

function periodFormats(period: UsagePeriod, timeZone: string, fromMs: number): Formats {
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  const point: Intl.DateTimeFormatOptions =
    period === 'day' ? time : period === 'week' ? { weekday: 'short', ...time } : { month: 'short', day: 'numeric', ...time }
  const start: Intl.DateTimeFormatOptions =
    period === 'day' ? time : period === 'week' ? { weekday: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' }
  const pointFormat = new Intl.DateTimeFormat([], { ...point, timeZone })
  return {
    start: new Intl.DateTimeFormat([], { ...start, timeZone }).format(fromMs),
    point: (ts) => pointFormat.format(ts),
  }
}

// ── Numbers ──────────────────────────────────────────────────────────────

type RatePoint = { ts: number; down: number; up: number }

type SpeedStats = {
  bytesIn: number
  bytesOut: number
  /** Mbps of every complete bucket from the start of the period, 0 where there was no traffic. */
  points: RatePoint[]
  peakDown: RatePoint | null
  peakUp: RatePoint | null
  resolutionMs: number
  fromMs: number
  toMs: number
}

function speedStats(data: DeviceTrafficResponse, fallbackFromMs: number): SpeedStats {
  const resolutionMs = data.resolutionSeconds * 1000
  const fromMs = data.from ? Date.parse(data.from) : fallbackFromMs
  const toMs = data.to ? Date.parse(data.to) : Number.NaN
  const byStart = new Map<number, { bytesIn: number; bytesOut: number }>()
  let bytesIn = 0
  let bytesOut = 0
  for (const bucket of data.buckets) {
    bytesIn += bucket.bytesIn
    bytesOut += bucket.bytesOut
    const ts = Date.parse(bucket.bucketStart)
    if (Number.isNaN(ts)) continue
    // One row per collector that saw the device: add them up.
    const sum = byStart.get(ts) ?? { bytesIn: 0, bytesOut: 0 }
    sum.bytesIn += bucket.bytesIn
    sum.bytesOut += bucket.bytesOut
    byStart.set(ts, sum)
  }
  const points: RatePoint[] = []
  if (resolutionMs >= 60_000 && Number.isFinite(fromMs) && Number.isFinite(toMs)) {
    for (let ts = Math.floor(fromMs / resolutionMs) * resolutionMs; ts + resolutionMs + SETTLE_MS <= toMs; ts += resolutionMs) {
      const sum = byStart.get(ts)
      // The first hourly bucket can start before the period (a half-hour timezone).
      const seconds = (ts + resolutionMs - Math.max(ts, fromMs)) / 1000
      points.push({
        ts,
        down: sum ? (sum.bytesIn * 8) / seconds / 1_000_000 : 0,
        up: sum ? (sum.bytesOut * 8) / seconds / 1_000_000 : 0,
      })
    }
  }
  let peakDown: RatePoint | null = null
  let peakUp: RatePoint | null = null
  for (const point of points) {
    if (point.down > 0 && (!peakDown || point.down > peakDown.down)) peakDown = point
    if (point.up > 0 && (!peakUp || point.up > peakUp.up)) peakUp = point
  }
  return { bytesIn, bytesOut, points, peakDown, peakUp, resolutionMs, fromMs, toMs }
}

/** Mbps over the last minute that ended at least 10 s ago (its last reports are in); 0 without traffic. */
function currentRate(data: DeviceTrafficResponse | undefined): { down: number; up: number } | null {
  if (!data?.to) return null
  const resolutionMs = data.resolutionSeconds * 1000
  const toMs = Date.parse(data.to)
  if (!(resolutionMs > 0) || Number.isNaN(toMs)) return null
  const start = Math.floor((toMs - 10_000) / resolutionMs) * resolutionMs - resolutionMs
  let bytesIn = 0
  let bytesOut = 0
  for (const bucket of data.buckets) {
    if (Date.parse(bucket.bucketStart) !== start) continue
    bytesIn += bucket.bytesIn
    bytesOut += bucket.bytesOut
  }
  const seconds = resolutionMs / 1000
  return { down: (bytesIn * 8) / seconds / 1_000_000, up: (bytesOut * 8) / seconds / 1_000_000 }
}

type AppRow = { protocol: string; category: string | undefined; bytes: number; share: number }

const TOP_APPS = 5

function topApps(protocols: ProtocolBreakdown[]): { top: AppRow[]; other: { count: number; bytes: number; share: number } | null } {
  const rows = protocols
    .map((entry) => ({ protocol: entry.protocol, category: entry.category, bytes: entry.bytesIn + entry.bytesOut, share: 0 }))
    .filter((row) => row.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
  const total = rows.reduce((sum, row) => sum + row.bytes, 0)
  for (const row of rows) row.share = total > 0 ? (row.bytes / total) * 100 : 0
  const rest = rows.slice(TOP_APPS)
  const restBytes = rest.reduce((sum, row) => sum + row.bytes, 0)
  const restShare = total > 0 ? (restBytes / total) * 100 : 0
  // The rest earns a row once it is worth reading.
  return { top: rows.slice(0, TOP_APPS), other: restShare >= 1 ? { count: rest.length, bytes: restBytes, share: restShare } : null }
}

function formatShare(share: number): string {
  if (share >= 10) return `${Math.round(share)}%`
  if (share >= 1) return `${share.toFixed(1)}%`
  return '<1%'
}

type SignalPoint = { ts: number; dbm: number; quality: WifiSignalQuality | null }

function signalPoints(data: WifiClientSignalResponse): SignalPoint[] {
  return data.buckets
    .flatMap((bucket) => {
      const ts = Date.parse(bucket.bucketStart)
      return Number.isNaN(ts) || bucket.signalDbm === null ? [] : [{ ts, dbm: bucket.signalDbm, quality: bucket.signalQuality }]
    })
    .sort((a, b) => a.ts - b.ts)
}

type Roam = WifiClientDetailResponse['roamingEvents'][number]

/** The roams since `fromMs`, newest first; `atLeast` when the API's 30 are all in it and there may be more. */
function roamsSince(events: Roam[], fromMs: number): { roams: Roam[]; atLeast: boolean } {
  const roams = events
    .filter((event) => event.detectedAt !== null && Date.parse(event.detectedAt) >= fromMs)
    .sort((a, b) => Date.parse(b.detectedAt!) - Date.parse(a.detectedAt!))
  return { roams, atLeast: events.length >= ROAMS_SENT && roams.length === events.length }
}

/** "Office AP → Garage AP", or on one AP "Office AP · 2.4 GHz → 5 GHz". */
function roamWords(roam: Roam): string {
  const from = roam.from.apName ?? 'Unknown AP'
  const to = roam.to.apName ?? 'Unknown AP'
  if (roam.from.apId !== roam.to.apId || from !== to) return `${from} → ${to}`
  if (roam.from.band !== roam.to.band) return `${to} · ${formatWifiBand(roam.from.band)} → ${formatWifiBand(roam.to.band)}`
  if (roam.from.ssid !== roam.to.ssid) return `${to} · ${roam.from.ssid ?? '?'} → ${roam.to.ssid ?? '?'}`
  return `${to} · ${roam.from.ifname ?? '?'} → ${roam.to.ifname ?? '?'}`
}

// ── Pieces ───────────────────────────────────────────────────────────────

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-medium text-muted-foreground">{title}</h4>
        {aside}
      </div>
      {children}
    </div>
  )
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-3.5" />
      Loading…
    </p>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

function Failed({ what, error }: { what: string; error: Error }) {
  return (
    <p className="text-[11px] text-destructive" role="alert">
      Could not load {what}: {error.message}
    </p>
  )
}

/** Legend key: the mark's own shape, never coloured text. Download also wears its wash. */
function SeriesKey({ series }: { series: 'download' | 'upload' }) {
  const color = series === 'download' ? 'var(--chart-download)' : 'var(--chart-upload)'
  return (
    <svg aria-hidden viewBox="0 0 12 8" className="h-2 w-3 shrink-0">
      {series === 'download' ? <rect x="0" y="2" width="12" height="6" fill={color} fillOpacity={0.18} /> : null}
      <line x1="1" x2="11" y1="2" y2="2" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}

// ── Sparkline ────────────────────────────────────────────────────────────

/** viewBox width; the SVG stretches to the panel (non-scaling strokes keep lines at their px width). */
const VIEW_W = 300

type SparklineProps<T extends { ts: number }> = {
  points: T[]
  /** Time span across the width (UTC ms). */
  domain: [number, number]
  height: number
  /** What the chart shows, for screen readers. */
  label: string
  /** The marks, in viewBox units (x from `x(ts)`, y in px from the top). */
  marks: (x: (ts: number) => number) => ReactNode
  /** The line under the chart for the point under the pointer (or the arrow keys). */
  readout: (point: T) => ReactNode
  /** The line under the chart otherwise. */
  axis: ReactNode
}

/**
 * A small time-series chart with a crosshair: the pointer (or a tap, or the
 * arrow keys once focused) picks the nearest point and the line under the
 * chart reads its values out.
 */
function Sparkline<T extends { ts: number }>({ points, domain, height, label, marks, readout, axis }: SparklineProps<T>) {
  const [active, setActive] = useState<number | null>(null)
  const [x0, x1] = domain
  const span = Math.max(1, x1 - x0)
  const x = (ts: number) => Math.min(VIEW_W, Math.max(0, ((ts - x0) / span) * VIEW_W))
  const point = active !== null && points.length > 0 ? points[Math.min(active, points.length - 1)] : undefined

  function nearest(ts: number): number {
    let lo = 0
    let hi = points.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (points[mid].ts < ts) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && ts - points[lo - 1].ts < points[lo].ts - ts ? lo - 1 : lo
  }

  function onPointer(event: PointerEvent<SVGSVGElement>) {
    if (points.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
    setActive(nearest(x0 + fraction * span))
  }

  function onFocus(event: FocusEvent<SVGSVGElement>) {
    // Keyboard focus starts at the latest point; a click already picked one.
    if (points.length > 0 && event.currentTarget.matches(':focus-visible')) setActive(points.length - 1)
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (points.length === 0) return
    const last = points.length - 1
    if (event.key === 'ArrowLeft') setActive((current) => Math.max(0, (current ?? last + 1) - 1))
    else if (event.key === 'ArrowRight') setActive((current) => Math.min(last, (current ?? last - 1) + 1))
    else if (event.key === 'Home') setActive(0)
    else if (event.key === 'End') setActive(last)
    else if (event.key === 'Escape') setActive(null)
    else return
    event.preventDefault()
  }

  return (
    <div className="space-y-0.5">
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        preserveAspectRatio="none"
        className="block w-full rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
        style={{ height, touchAction: 'pan-y' }}
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onFocus={onFocus}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        <line x1={0} x2={VIEW_W} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
        {marks(x)}
        {point ? (
          <line
            x1={x(point.ts)}
            x2={x(point.ts)}
            y1={0}
            y2={height}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.7}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="flex min-h-4 items-center justify-between gap-2 text-[10px] leading-4 text-muted-foreground tabular-nums">
        {point ? readout(point) : axis}
      </div>
    </div>
  )
}

function Axis({ start, middle }: { start: string; middle?: ReactNode }) {
  return (
    <>
      <span>{start}</span>
      {middle ? <span className="min-w-0 truncate">{middle}</span> : null}
      <span>now</span>
    </>
  )
}

const RATE_HEIGHT = 40
const SIGNAL_HEIGHT = 32

function RateSparkline({ stats, formats, periodWord }: { stats: SpeedStats; formats: Formats; periodWord: string }) {
  const drawn = useMemo(
    () => (stats.points.length > MAX_DRAWN ? downsampleTimeSeries(stats.points, MAX_DRAWN, (p) => p.down + p.up) : stats.points),
    [stats.points],
  )
  if (drawn.length < 2) return null
  const top = Math.max(stats.peakDown?.down ?? 0, stats.peakUp?.up ?? 0) || 1
  const half = stats.resolutionMs / 2
  const y = (mbps: number) => RATE_HEIGHT - 1 - (mbps / top) * (RATE_HEIGHT - 4)
  return (
    <Sparkline
      points={drawn}
      domain={[stats.fromMs, stats.toMs]}
      height={RATE_HEIGHT}
      label={`Download and upload rate ${periodWord}, peak ${formatMbps(top)}`}
      marks={(x) => {
        const line = (key: 'down' | 'up') =>
          drawn.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts + half).toFixed(2)},${y(p[key]).toFixed(2)}`).join('')
        const down = line('down')
        const first = x(drawn[0].ts + half).toFixed(2)
        const last = x(drawn[drawn.length - 1].ts + half).toFixed(2)
        return (
          <>
            <path d={`${down}L${last},${RATE_HEIGHT}L${first},${RATE_HEIGHT}Z`} fill="var(--chart-download)" fillOpacity={0.1} />
            <path
              d={down}
              fill="none"
              stroke="var(--chart-download)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={line('up')}
              fill="none"
              stroke="var(--chart-upload)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )
      }}
      readout={(p) => (
        <>
          <span>{formats.point(p.ts)}</span>
          <span className="flex items-center gap-2">
            <span>
              ↓ <span className="text-foreground">{formatMbps(p.down)}</span>
            </span>
            <span>
              ↑ <span className="text-foreground">{formatMbps(p.up)}</span>
            </span>
          </span>
        </>
      )}
      axis={<Axis start={formats.start} />}
    />
  )
}

/** Lines between points no more than 1.5 buckets apart, each stretch in the colour of its signal quality. */
function signalMarks(points: SignalPoint[], gapMs: number) {
  const lines: Array<{ color: string; points: SignalPoint[] }> = []
  const lone: SignalPoint[] = []
  let current: { color: string; points: SignalPoint[] } | null = null
  points.forEach((point, i) => {
    const prev = points[i - 1]
    const next = points[i + 1]
    const joinsPrev = prev !== undefined && point.ts - prev.ts <= gapMs
    const joinsNext = next !== undefined && next.ts - point.ts <= gapMs
    if (!joinsPrev) {
      current = null
      if (!joinsNext) lone.push(point)
      return
    }
    const color = signalStroke(point.quality)
    if (current && current.color === color) {
      current.points.push(point)
    } else {
      current = { color, points: [prev, point] }
      lines.push(current)
    }
  })
  return { lines, lone }
}

function SignalSparkline({
  points,
  domain,
  resolutionMs,
  formats,
  periodWord,
}: {
  points: SignalPoint[]
  domain: [number, number]
  resolutionMs: number
  formats: Formats
  periodWord: string
}) {
  let lo = Math.min(...points.map((p) => p.dbm))
  let hi = Math.max(...points.map((p) => p.dbm))
  const range = `${formatSignal(lo)} to ${formatSignal(hi)}`
  // At least 12 dB tall, so a steady signal reads as steady.
  const middle = (lo + hi) / 2
  lo = Math.min(lo - 2, middle - 6)
  hi = Math.max(hi + 2, middle + 6)
  const y = (dbm: number) => SIGNAL_HEIGHT - 2 - ((dbm - lo) / (hi - lo)) * (SIGNAL_HEIGHT - 4)
  const { lines, lone } = signalMarks(points, resolutionMs * 1.5)
  return (
    <Sparkline
      points={points}
      domain={domain}
      height={SIGNAL_HEIGHT}
      label={`Wi-Fi signal ${periodWord}, ${range}`}
      marks={(x) => {
        const half = resolutionMs / 2
        return (
          <>
            {lines.map((line, i) => (
              <path
                key={i}
                d={line.points.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.ts + half).toFixed(2)},${y(p.dbm).toFixed(2)}`).join('')}
                fill="none"
                stroke={line.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {lone.map((p) => (
              <path
                key={p.ts}
                d={`M${(x(p.ts + half) - 1.5).toFixed(2)},${y(p.dbm).toFixed(2)}L${(x(p.ts + half) + 1.5).toFixed(2)},${y(p.dbm).toFixed(2)}`}
                stroke={signalStroke(p.quality)}
                strokeWidth={3}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </>
        )
      }}
      readout={(p) => (
        <>
          <span>{formats.point(p.ts)}</span>
          <span>
            <span className="text-foreground">{formatSignal(p.dbm)}</span> · {wifiSignalQualityLabel(p.quality)}
          </span>
        </>
      )}
      axis={<Axis start={formats.start} middle={range} />}
    />
  )
}

// ── The summary ──────────────────────────────────────────────────────────

export type DeviceSummaryProps = {
  /** The device's MAC, lower case. */
  mac: string
  /**
   * Where a wired device plugs in ("Ethernet · Garage switch · port 3 · 1 Gb/s"): shown
   * in place of the Wi-Fi block when the device has never been on Wi-Fi.
   */
  wired?: string | null
  /** It is on Wi-Fi right now: its signal is asked for without waiting for the Wi-Fi lookup. */
  onWifi?: boolean
}

export function DeviceSummary({ mac, wired = null, onWifi = false }: DeviceSummaryProps) {
  const [period, setPeriod] = useState<UsagePeriod>(readPeriod)
  const now = useMinuteClock()
  const timezone = useInstanceTimezone()
  const browserZone = useMemo(() => guessTimezone(), [])
  // The instance's calendar; the browser's when it cannot be read (said under the toggle).
  const timeZone = timezone.data ?? (timezone.isError ? browserZone : null)
  const from = timeZone ? new Date(periodStart(period, timeZone, now)).toISOString() : null
  const span = useMemo<SummaryWindow | null>(
    () => (from ? { period, from, resolution: RESOLUTION[period] } : null),
    [period, from],
  )
  const fromMs = from ? Date.parse(from) : now
  const periodWord = RUNNING_PERIOD_LABELS[period].toLowerCase()

  const traffic = useSummaryTraffic(mac, span)
  // A MAC with no traffic at all answers 404 everywhere: say so once, and stop asking.
  const neverSeen = isNotFound(traffic.error)
  const protocols = useSummaryProtocols(mac, span)
  const nowRate = useSummaryNowRate(mac, !neverSeen)
  const wifi = useWifiClient(mac, { refetchInterval: 60_000, retryNotFound: false })
  const signalWanted = onWifi || wifi.isSuccess
  const signal = useSummarySignal(mac, span, signalWanted)

  const formats = useMemo(() => (timeZone ? periodFormats(period, timeZone, fromMs) : null), [period, timeZone, fromMs])
  const stats = useMemo(() => (traffic.data ? speedStats(traffic.data, fromMs) : null), [traffic.data, fromMs])
  const current = currentRate(nowRate.data)
  const switching = traffic.isPlaceholderData || protocols.isPlaceholderData || signal.isPlaceholderData

  function choose(next: UsagePeriod) {
    setPeriod(next)
    rememberPeriod(next)
  }

  // The device page with the same window: the period from its start to now.
  const pageTo = new Date(Math.max(now, Date.parse(traffic.data?.to ?? '') || 0)).toISOString()
  const devicePage = `/devices/${macPath(mac)}${from ? `?${new URLSearchParams({ from, to: pageTo })}` : ''}`

  return (
    <Section
      title="Activity"
      action={<Segmented size="xs" ariaLabel="Period" value={period} onChange={choose} options={PERIOD_OPTIONS} />}
    >
      <div className="relative space-y-4" data-device-summary={period}>
        {timeZone && timezone.isError ? (
          <p className="text-[11px] text-muted-foreground">
            Periods follow this browser&rsquo;s timezone ({timeZone}): the site&rsquo;s could not be read.
          </p>
        ) : timeZone && timeZone !== browserZone ? (
          <p className="text-[11px] text-muted-foreground">Periods follow the site&rsquo;s timezone, {timeZone}.</p>
        ) : null}

        {neverSeen ? (
          <Muted>No traffic has been recorded for this device.</Muted>
        ) : (
          <>
            <Block title="Speed">
              {!span || !formats || traffic.isPending ? (
                <Loading />
              ) : traffic.error ? (
                <Failed what="the traffic" error={traffic.error} />
              ) : !stats || stats.bytesIn + stats.bytesOut === 0 ? (
                <Muted>No traffic {periodWord}.</Muted>
              ) : (
                <>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4 gap-y-1 text-xs" data-speed>
                    <span />
                    <span className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                      <SeriesKey series="download" />
                      Download
                    </span>
                    <span className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                      <SeriesKey series="upload" />
                      Upload
                    </span>
                    <span className="text-muted-foreground">Total</span>
                    <span className="text-right tabular-nums">{formatBytes(stats.bytesIn)}</span>
                    <span className="text-right tabular-nums">{formatBytes(stats.bytesOut)}</span>
                    <span className="text-muted-foreground" title="Average over the last complete minute">
                      Now
                    </span>
                    {current ? (
                      <>
                        <span className="text-right tabular-nums">{formatMbps(current.down)}</span>
                        <span className="text-right tabular-nums">{formatMbps(current.up)}</span>
                      </>
                    ) : (
                      <span className="col-span-2 flex justify-end text-muted-foreground" title={nowRate.error?.message}>
                        {nowRate.isPending ? <Spinner className="size-3" /> : '—'}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-muted-foreground">
                      Peak <span className="text-[10px]">({GRAIN_WORDS[period]})</span>
                    </span>
                    <span
                      className="text-right tabular-nums"
                      title={stats.peakDown ? `${formats.point(stats.peakDown.ts)}` : undefined}
                    >
                      {stats.peakDown ? formatMbps(stats.peakDown.down) : '—'}
                    </span>
                    <span
                      className="text-right tabular-nums"
                      title={stats.peakUp ? `${formats.point(stats.peakUp.ts)}` : undefined}
                    >
                      {stats.peakUp ? formatMbps(stats.peakUp.up) : '—'}
                    </span>
                  </div>
                  <RateSparkline stats={stats} formats={formats} periodWord={periodWord} />
                </>
              )}
            </Block>

            <Block title="Top applications">
              {!span || protocols.isPending ? (
                <Loading />
              ) : protocols.error ? (
                <Failed what="the applications" error={protocols.error} />
              ) : (
                <AppList protocols={protocols.data.protocols} periodWord={periodWord} />
              )}
            </Block>
          </>
        )}

        <ConnectionBlock
          wired={wired}
          onWifi={onWifi}
          wifi={wifi}
          signal={signalWanted ? signal : null}
          formats={formats}
          fromMs={fromMs}
          now={now}
          periodWord={periodWord}
          resolutionMs={RESOLUTION_MS[period]}
        />

        <Link
          to={devicePage}
          className="inline-flex items-center gap-1 text-xs text-brand underline-offset-2 hover:underline"
          data-open-device
        >
          Open device page
          <ArrowSquareOut aria-hidden className="size-3" />
        </Link>

        <PanelOverlay show={switching} />
      </div>
    </Section>
  )
}

function AppList({ protocols, periodWord }: { protocols: ProtocolBreakdown[]; periodWord: string }) {
  const { top, other } = topApps(protocols)
  if (top.length === 0) return <Muted>No application traffic {periodWord}.</Muted>
  return (
    <ul className="space-y-2" data-apps>
      {top.map((app) => (
        <AppItem
          key={app.protocol}
          name={formatProtocolLabel(app.protocol)}
          category={<CategoryChip category={app.category} className="shrink-0" />}
          bytes={app.bytes}
          share={app.share}
          color={protocolColor(app.protocol)}
        />
      ))}
      {other ? (
        <AppItem
          name={`${other.count} other ${other.count === 1 ? 'application' : 'applications'}`}
          muted
          bytes={other.bytes}
          share={other.share}
          color="var(--series-other)"
        />
      ) : null}
    </ul>
  )
}

function AppItem({
  name,
  category,
  bytes,
  share,
  color,
  muted = false,
}: {
  name: string
  category?: ReactNode
  bytes: number
  share: number
  color: string
  muted?: boolean
}) {
  return (
    <li>
      <div className={cn('flex items-center gap-2 text-xs', muted && 'text-muted-foreground')}>
        <span className={cn('min-w-0 truncate', !muted && 'font-medium')} title={name}>
          {name}
        </span>
        {category}
        <span className="ml-auto shrink-0 tabular-nums">{formatBytes(bytes)}</span>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{formatShare(share)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full min-w-0.5 rounded-full" style={{ width: `${Math.min(100, share)}%`, backgroundColor: color }} />
      </div>
    </li>
  )
}

type WifiQuery = ReturnType<typeof useWifiClient>
type SignalQuery = ReturnType<typeof useSummarySignal>

/** Where it plugs in, or its Wi-Fi: the AP it is on (or was last on), the signal and the roams of the period. */
function ConnectionBlock({
  wired,
  onWifi,
  wifi,
  signal,
  formats,
  fromMs,
  now,
  periodWord,
  resolutionMs,
}: {
  wired: string | null
  onWifi: boolean
  wifi: WifiQuery
  /** Null while the signal is not asked for (not known to have been on Wi-Fi). */
  signal: SignalQuery | null
  formats: Formats | null
  fromMs: number
  now: number
  periodWord: string
  resolutionMs: number
}) {
  const neverOnWifi = isNotFound(wifi.error)
  if (neverOnWifi && !wired) return null
  const title = !wired && (onWifi || wifi.data) ? 'Wi-Fi' : 'Connection'
  return (
    <Block title={title}>
      {wired ? (
        <p className="flex items-center gap-1.5 text-xs" data-wired-line>
          <PlugsConnected aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">{wired}</span>
        </p>
      ) : null}
      {neverOnWifi ? null : wifi.isPending ? (
        <Loading />
      ) : wifi.error ? (
        <Failed what="the Wi-Fi details" error={wifi.error} />
      ) : wifi.data ? (
        <WifiDetails
          detail={wifi.data}
          signal={signal}
          formats={formats}
          fromMs={fromMs}
          now={now}
          periodWord={periodWord}
          resolutionMs={resolutionMs}
        />
      ) : null}
    </Block>
  )
}

function WifiDetails({
  detail,
  signal,
  formats,
  fromMs,
  now,
  periodWord,
  resolutionMs,
}: {
  detail: WifiClientDetailResponse
  signal: SignalQuery | null
  formats: Formats | null
  fromMs: number
  now: number
  periodWord: string
  resolutionMs: number
}) {
  const signalData = signal?.data
  const points = useMemo(() => (signalData ? signalPoints(signalData) : []), [signalData])
  const { roams, atLeast } = roamsSince(detail.roamingEvents, fromMs)
  const latest = detail.latest
  const settled = signal !== null && formats !== null && !signal.isPending
  const failed = signal?.error && !isNotFound(signal.error) ? signal.error : null
  // Not on Wi-Fi now, and not in the period either: its last AP says it all.
  const absent = settled && !failed && !latest.active && points.length === 0 && roams.length === 0
  return (
    <div className="space-y-3" data-wifi>
      <WifiNow latest={latest} now={now} />
      {!settled ? (
        <Loading />
      ) : failed ? (
        <Failed what="the signal" error={failed} />
      ) : absent ? (
        <Muted>Not on Wi-Fi {periodWord}.</Muted>
      ) : points.length === 0 || !signal?.data ? (
        <Muted>No signal readings {periodWord} yet.</Muted>
      ) : (
        <div data-signal>
          <SignalSparkline
            points={points}
            domain={[Date.parse(signal.data.from), Date.parse(signal.data.to)]}
            resolutionMs={signal.data.resolutionSeconds * 1000 || resolutionMs}
            formats={formats!}
            periodWord={periodWord}
          />
        </div>
      )}
      {absent || !formats ? null : roams.length === 0 ? (
        <Muted>No roams in this period.</Muted>
      ) : (
        <div className="space-y-1" data-roams>
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
            <span>Roams</span>
            <span className="tabular-nums">
              {roams.length}
              {atLeast ? '+' : ''} {periodWord}
              {roams.length > 5 ? ', latest 5' : ''}
            </span>
          </div>
          <ul className="space-y-0.5">
            {roams.slice(0, 5).map((roam) => (
              <li key={roam.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formats.point(Date.parse(roam.detectedAt!))}
                </span>
                <span className="min-w-0 truncate" title={roamWords(roam)}>
                  {roamWords(roam)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function WifiNow({ latest, now }: { latest: WifiClientSummary; now: number }) {
  if (latest.active) {
    const words = `${latest.ap} · ${formatWifiBand(latest.band)} · ${formatSignal(latest.signalDbm)} · ${wifiSignalQualityLabel(latest.signalQuality)}`
    return (
      <p className="flex items-center gap-1.5 text-xs" data-wifi-now>
        <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', wifiSignalQualityDotClass(latest.signalQuality))} />
        <span className="min-w-0 truncate" title={words}>
          {words}
        </span>
      </p>
    )
  }
  const words = `Last on ${latest.ap} · ${formatWifiBand(latest.band)} · ${formatLastSeen(latest.lastSeenAt, now)}`
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-wifi-now>
      <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/40" />
      <span className="min-w-0 truncate" title={words}>
        {words}
      </span>
    </p>
  )
}
