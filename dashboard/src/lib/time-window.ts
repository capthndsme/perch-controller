import type { TrafficRange, TrafficResolution } from '@/types/api'

/**
 * Two-shape time window the whole dashboard speaks. `relative` is the
 * "last N" buttons (auto-updating to "now"); `absolute` is what a custom
 * range picker or a chart drag-zoom produces — frozen ISO endpoints.
 *
 * Keeping these in one discriminated union lets every hook take a single
 * `window` prop and lets `TimePicker` round-trip between both forms
 * without duplicating state.
 */
export type TimeWindow =
  | { kind: 'relative'; range: TrafficRange }
  | { kind: 'absolute'; from: string; to: string }

export const DEFAULT_AGGREGATE_WINDOW: TimeWindow = { kind: 'relative', range: '1h' }
export const DEFAULT_DEVICE_WINDOW: TimeWindow = { kind: 'relative', range: '1h' }

/**
 * Translate a window into URLSearchParams entries the backend
 * validator accepts. Relative windows ride on `?range=`; absolute on
 * `?from=&to=`. The backend treats `from`/`to` as authoritative when
 * both are present, so we never send both forms at once.
 */
export function applyWindowToParams(params: URLSearchParams, window: TimeWindow): void {
  if (window.kind === 'absolute') {
    params.set('from', window.from)
    params.set('to', window.to)
  } else {
    params.set('range', window.range)
  }
}

const RELATIVE_RANGE_REGEX = /^\d{1,6}(s|m|h|d)$/

/**
 * Loose validity check for a relative range string arriving from the URL
 * (someone may hand-edit `?range=45d`). Anything matching the backend's
 * `\d+[smhd]` grammar is accepted, not just the preset list.
 */
export function isRelativeRange(value: string): value is TrafficRange {
  return RELATIVE_RANGE_REGEX.test(value)
}

/**
 * Reconstruct a `TimeWindow` from URL search params. Absolute
 * (`from`+`to`) wins over relative (`range`), matching the backend's
 * precedence. Invalid or missing params yield `null` so the caller can
 * fall back to a persisted or default window.
 */
export function parseWindowFromParams(params: URLSearchParams): TimeWindow | null {
  const from = params.get('from')
  const to = params.get('to')
  if (from && to) {
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && toMs > fromMs) {
      return {
        kind: 'absolute',
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      }
    }
  }
  const range = params.get('range')
  if (range && isRelativeRange(range)) {
    return { kind: 'relative', range: range as TrafficRange }
  }
  return null
}

/**
 * Write a window into a mutable `URLSearchParams`, first clearing whichever
 * form doesn't apply so a relative→absolute switch (e.g. drag-to-zoom)
 * never leaves a stale `range=` sitting next to `from=/to=`.
 */
export function setWindowParams(params: URLSearchParams, window: TimeWindow): void {
  params.delete('range')
  params.delete('from')
  params.delete('to')
  applyWindowToParams(params, window)
}

/**
 * Cache key fragment for react-query. Different shapes must produce
 * different keys so a relative→absolute transition (drag-to-zoom)
 * triggers a refetch instead of returning stale cached data.
 */
export function windowKey(window: TimeWindow): string {
  return window.kind === 'absolute'
    ? `abs:${window.from}:${window.to}`
    : `rel:${window.range}`
}

/**
 * Pick the context range for the overview mini-map: wide enough to give
 * the detail window roughly 1/6 of the strip (so the brush is grabbable)
 * but bounded by the 2-year retention ceiling. Snapped to a preset so the
 * context query hits the rollup tiers cleanly.
 */
export function contextRangeForWindow(window: TimeWindow): TrafficRange {
  const target = windowSpanSeconds(window) * 6
  const DAY = 86400
  const ladder: Array<[number, TrafficRange]> = [
    [DAY, '24h'],
    [7 * DAY, '7d'],
    [30 * DAY, '30d'],
    [90 * DAY, '90d'],
    [180 * DAY, '180d'],
    [365 * DAY, '365d'],
    [730 * DAY, '730d'],
  ]
  for (const [seconds, range] of ladder) {
    if (target <= seconds) return range
  }
  return '730d'
}

/** Width of the window in seconds — used to clamp resolution. */
export function windowSpanSeconds(window: TimeWindow): number {
  if (window.kind === 'absolute') {
    return Math.max(1, (Date.parse(window.to) - Date.parse(window.from)) / 1000)
  }
  return parseRelativeSeconds(window.range)
}

/** Auto-refresh cadence in milliseconds. `null` = off. */
export type RefreshInterval = null | 5_000 | 15_000 | 30_000 | 60_000 | 300_000

export const REFRESH_OPTIONS: Array<{ value: RefreshInterval; label: string }> = [
  { value: null, label: 'Off' },
  { value: 5_000, label: '5s' },
  { value: 15_000, label: '15s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
]

/**
 * Whether a window should auto-poll. Absolute windows are frozen by
 * definition, so we suppress react-query's refetch interval for them
 * — otherwise drag-to-zoom would be a moving target.
 */
export function shouldAutoRefresh(window: TimeWindow): boolean {
  return window.kind === 'relative'
}

const RANGE_REGEX = /^(\d{1,6})(s|m|h|d)$/
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

export function parseRelativeSeconds(range: string): number {
  const m = RANGE_REGEX.exec(range)
  if (!m) return 3600
  return Number(m[1]) * UNIT_SECONDS[m[2]]
}

/**
 * Cap chart point count by picking the densest resolution whose bucket
 * count still fits in a reasonable budget. Replaces the old
 * `clampResolutionForRange` which was hard-coded to a fixed range list.
 * 2000 buckets is roughly where Recharts starts to drop frames on
 * mid-range hardware.
 */
const RESOLUTION_ORDER: TrafficResolution[] = ['5s', '15s', '1m', '5m', '15m', '1h', '1d']
const RESOLUTION_SECONDS: Record<TrafficResolution, number> = {
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
}

export function clampResolutionForWindow(
  window: TimeWindow,
  preferred: TrafficResolution,
  maxPoints = 2000,
): TrafficResolution {
  const span = windowSpanSeconds(window)
  const startIdx = RESOLUTION_ORDER.indexOf(preferred)
  for (let i = startIdx; i < RESOLUTION_ORDER.length; i += 1) {
    const res = RESOLUTION_ORDER[i]
    if (span / RESOLUTION_SECONDS[res] <= maxPoints) {
      return res
    }
  }
  return '1d'
}

/**
 * Suggest a sensible default resolution for a window when the user
 * hasn't explicitly picked one. Mirrors the Grafana heuristic of
 * "smooth chart, not a forest of points" — biased a touch coarser than
 * mathematically optimal so a 1h view shows ~60 minute-buckets instead
 * of 240 fifteen-second-buckets. Returns one of the supported
 * `TrafficResolution` values.
 */
export function suggestResolutionForWindow(window: TimeWindow): TrafficResolution {
  const span = windowSpanSeconds(window)
  if (span <= 5 * 60) return '5s'
  if (span <= 30 * 60) return '15s'
  if (span <= 6 * 3600) return '1m'
  if (span <= 24 * 3600) return '5m'
  // Two days is where the backend switches aggregate reads to the hourly
  // tier; asking for 1h here keeps the protocol chart on that tier too
  // (a 7 d protocol view at 15 m was a 17 s temp+filesort on the 5 m tier).
  if (span <= 2 * 86400) return '15m'
  if (span <= 90 * 86400) return '1h'
  return '1d'
}

/**
 * "Auto" lets the resolution follow the window via
 * `suggestResolutionForWindow`; a concrete `TrafficResolution` is the
 * user's explicit override and stays put across window changes (just
 * clamped if it would blow past the chart point budget).
 */
export type ResolutionMode = TrafficResolution | 'auto'

/**
 * Resolve a `ResolutionMode` against a window into the concrete
 * resolution that gets sent to the backend. Single source of truth so
 * the page state (mode) and the picker label (effective resolution)
 * never disagree.
 */
export function resolveResolution(
  window: TimeWindow,
  mode: ResolutionMode,
): TrafficResolution {
  if (mode === 'auto') return suggestResolutionForWindow(window)
  return clampResolutionForWindow(window, mode)
}

/**
 * Parse a `res` URL param into a `ResolutionMode`, reusing
 * `RESOLUTION_ORDER` (plus `'auto'`) as the allow-list. Unknown values
 * return `null` so the caller falls back to the persisted/default mode.
 */
export function parseResolutionMode(value: string | null): ResolutionMode | null {
  if (value === 'auto') return 'auto'
  if (value && (RESOLUTION_ORDER as string[]).includes(value)) {
    return value as ResolutionMode
  }
  return null
}

/**
 * Human description of the storage tier serving a given effective
 * resolution — mirrors the backend's read routing (`rollup_tiers.ts`):
 * sub-minute grains come from native 5-second data, 5m/15m from the
 * 5-minute rollup, 1h from the hourly rollup, 1d from the daily rollup. Surfaced as a small badge so
 * users understand the granularity/freshness tradeoff of wide windows.
 */
export type ResolutionTier = { label: string; hint: string; live: boolean }

export function describeResolutionTier(resolution: TrafficResolution): ResolutionTier {
  switch (resolution) {
    case '5s':
    case '15s':
      return { label: `Live · ${resolution}`, hint: 'Native 5-second samples', live: true }
    case '1m':
      return { label: 'Live · 1m', hint: 'Native 5-second samples grouped to 1 minute', live: true }
    case '5m':
    case '15m':
      return {
        label: `${resolution} rollup`,
        hint: 'Served from the 5-minute rollup table',
        live: false,
      }
    case '1h':
      return { label: 'Hourly rollup', hint: 'Served from the hourly rollup table', live: false }
    case '1d':
      return { label: 'Daily rollup', hint: 'Served from the daily rollup table', live: false }
  }
}

const TIME_FORMATTER = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
})
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat([], {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/**
 * Tick formatter that switches to a date prefix once a window crosses
 * the multi-day boundary. Keeps short ranges (1h, 6h) terse but
 * disambiguates a 7d window where two midnights look identical.
 */
export function formatAxisTick(ts: number, spanSeconds: number): string {
  if (spanSeconds > 24 * 3600) return DATE_TIME_FORMATTER.format(ts)
  return TIME_FORMATTER.format(ts)
}

const LONG_TIME_FORMATTER = new Intl.DateTimeFormat([], {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function formatTooltipTimestamp(ts: number): string {
  return LONG_TIME_FORMATTER.format(ts)
}

/**
 * Friendly label for a relative range. The long presets are stored in
 * days (the backend grammar has no month/year unit) but read better as
 * `6mo`/`1y`/`2y`; everything else shows its raw token.
 */
const RANGE_LABEL: Partial<Record<TrafficRange, string>> = {
  '180d': '6mo',
  '365d': '1y',
  '730d': '2y',
}

export function formatRangeLabel(range: string): string {
  return RANGE_LABEL[range as TrafficRange] ?? range
}

/** Label rendered on the floating time-picker trigger button. */
export function formatWindowLabel(window: TimeWindow): string {
  if (window.kind === 'relative') return `Last ${formatRangeLabel(window.range)}`
  const span = windowSpanSeconds(window) * 1000
  const formatter =
    span > 24 * 3600 * 1000 ? DATE_TIME_FORMATTER : TIME_FORMATTER
  return `${formatter.format(Date.parse(window.from))} → ${formatter.format(
    Date.parse(window.to),
  )}`
}

/**
 * Snap an absolute window to second precision (avoids sub-second
 * drift from `<input type="datetime-local">` parsing) and convert it
 * to ISO UTC. Used by both the picker and the drag-to-zoom handler.
 */
export function absoluteWindow(fromMs: number, toMs: number): TimeWindow {
  const fromSec = Math.floor(fromMs / 1000) * 1000
  const toSec = Math.ceil(toMs / 1000) * 1000
  return {
    kind: 'absolute',
    from: new Date(fromSec).toISOString(),
    to: new Date(toSec).toISOString(),
  }
}

/** The window a series response says it read (`from` / `to`, UTC ISO). */
export type ChartRange = { from?: string | null; to?: string | null }

/**
 * X-axis domain of a time chart: the window the API read, so a quiet start
 * or end of the window stays on the axis instead of the axis shrinking to
 * the first and last point. Falls back to the data's extent when the
 * response names no window.
 */
export function chartTimeDomain(
  points: ReadonlyArray<{ ts: number }>,
  range?: ChartRange,
): { domain: [number, number] | ['auto', 'auto']; spanSeconds: number } {
  const from = range?.from ? Date.parse(range.from) : Number.NaN
  const to = range?.to ? Date.parse(range.to) : Number.NaN
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    return { domain: [from, to], spanSeconds: (to - from) / 1000 }
  }
  if (points.length === 0) return { domain: ['auto', 'auto'], spanSeconds: 0 }
  const min = points[0].ts
  const max = points[points.length - 1].ts
  return { domain: [min, max], spanSeconds: (max - min) / 1000 }
}

/**
 * For series whose missing bucket means "not reported" rather than zero
 * (client counts, signal, gateway gauges): insert a row with every value
 * `null` into each gap longer than `maxGapMs`, so a line breaks there instead
 * of bridging it (Recharts breaks at an explicit null when `connectNulls` is
 * off). `stepMs` places the null right after the last reported bucket.
 */
export function breakGaps<T extends { ts: number }>(
  points: readonly T[],
  stepMs: number,
  maxGapMs = stepMs * 2,
): T[] {
  if (points.length < 2 || !(stepMs > 0)) return [...points]
  const out: T[] = [points[0]]
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    if (points[i].ts - prev.ts > maxGapMs) {
      const gap: Record<string, unknown> = { ts: prev.ts + stepMs }
      for (const key of Object.keys(prev)) if (key !== 'ts') gap[key] = null
      out.push(gap as T)
    }
    out.push(points[i])
  }
  return out
}
