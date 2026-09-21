import { isRelativeRange, type TimeWindow } from '@/lib/time-window'
import type {
  TrafficRange,
  UsageBucket,
  UsageIntervalRequest,
  UsagePeriod,
  UsageScope,
} from '@/types/api'

/**
 * Helpers for the vnstat-style Usage page: period / preset definitions,
 * URL-friendly windows, and label formatting that works from the API's
 * bucket labels (already in the instance timezone) rather than from the
 * UTC `bucketStart`, so a browser in another zone never shifts a day.
 */

export const USAGE_PERIODS: Array<{ id: UsagePeriod; label: string; title: string }> = [
  { id: 'day', label: 'Daily', title: 'One row per local day' },
  { id: 'week', label: 'Weekly', title: 'One row per ISO week (Monday to Sunday)' },
  { id: 'month', label: 'Monthly', title: 'One row per calendar month' },
]

export const USAGE_SCOPES: Array<{ id: UsageScope; label: string; title: string }> = [
  { id: 'all', label: 'All', title: 'WAN + LAN combined' },
  { id: 'wan', label: 'WAN', title: 'Only traffic that crossed the gateway' },
  { id: 'lan', label: 'LAN', title: 'Only LAN-to-LAN flows' },
]

export type UsagePreset = { id: string; label: string; range: string; title: string }

export const USAGE_PRESETS: Record<UsagePeriod, UsagePreset[]> = {
  day: [
    { id: '7d', label: '7 days', range: '7d', title: 'The last 7 days' },
    { id: '30d', label: '30 days', range: '30d', title: 'The last 30 days' },
    { id: '90d', label: '90 days', range: '90d', title: 'The last 90 days' },
  ],
  week: [
    { id: '12w', label: '12 weeks', range: '84d', title: 'The last 12 weeks' },
    { id: '26w', label: '26 weeks', range: '182d', title: 'The last 26 weeks' },
    { id: '52w', label: '52 weeks', range: '364d', title: 'The last 52 weeks' },
  ],
  month: [
    { id: '6m', label: '6 months', range: '183d', title: 'The last 6 months' },
    { id: '12m', label: '12 months', range: '365d', title: 'The last 12 months' },
    { id: '24m', label: '24 months', range: '730d', title: 'The last 24 months' },
  ],
}

export const DEFAULT_USAGE_PRESET: Record<UsagePeriod, string> = {
  day: '30d',
  week: '26w',
  month: '12m',
}

export const USAGE_PERIOD_VALUES: UsagePeriod[] = ['day', 'week', 'month']
export const USAGE_SCOPE_VALUES: UsageScope[] = ['all', 'wan', 'lan']

/** Main chart: the down / up stack, or two stacks per bucket by application. */
export type UsageChartMode = 'bytes' | 'apps'
export const USAGE_CHART_MODES: Array<{ id: UsageChartMode; label: string; title: string }> = [
  { id: 'bytes', label: 'Down / Up', title: 'One column per bucket: download at the baseline, upload on top' },
  { id: 'apps', label: 'Applications', title: 'Two columns per bucket (download, upload), each stacked by application category' },
]

export function parseUsageChartMode(value: string | null): UsageChartMode | null {
  return value === 'apps' || value === 'bytes' ? value : null
}

export const USAGE_INTERVAL_OPTIONS: Array<{ id: UsageIntervalRequest; label: string; title: string }> = [
  { id: 'auto', label: 'Auto', title: '1 h up to a week, 4 h up to two, 8 h up to a month, else 12 h' },
  { id: '1h', label: '1h', title: 'One column per hour' },
  { id: '4h', label: '4h', title: 'One column per 4 hours (00–04, 04–08, …)' },
  { id: '8h', label: '8h', title: 'One column per 8 hours (00–08, 08–16, 16–24)' },
  { id: '12h', label: '12h', title: 'One column per 12 hours' },
]

export function parseUsagePeriod(value: string | null): UsagePeriod | null {
  return value && (USAGE_PERIOD_VALUES as string[]).includes(value) ? (value as UsagePeriod) : null
}

export function parseUsageScope(value: string | null): UsageScope | null {
  return value && (USAGE_SCOPE_VALUES as string[]).includes(value) ? (value as UsageScope) : null
}

/** Relative window from any `\d+[smhd]` string; falls back to 30 days. */
export function relativeWindow(range: string): TimeWindow {
  const safe: TrafficRange = isRelativeRange(range) ? range : '30d'
  return { kind: 'relative', range: safe }
}

export function defaultUsageWindow(period: UsagePeriod): TimeWindow {
  const preset = USAGE_PRESETS[period].find((p) => p.id === DEFAULT_USAGE_PRESET[period])
  return relativeWindow(preset?.range ?? '30d')
}

/** The preset a window corresponds to, or null for anything custom. */
export function presetForWindow(period: UsagePeriod, window: TimeWindow): UsagePreset | null {
  if (window.kind !== 'relative') return null
  return USAGE_PRESETS[period].find((p) => p.range === window.range) ?? null
}

/** `yyyy-mm-dd` in the browser's zone, for `<input type="date">`. */
export function localDateInput(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The date inputs a window implies (relative windows resolve against now). */
export function dateInputsForWindow(window: TimeWindow, nowMs = Date.now()): { from: string; to: string } {
  if (window.kind === 'absolute') {
    // `to` is an exclusive end at local midnight; show the last included day.
    return { from: localDateInput(Date.parse(window.from)), to: localDateInput(Date.parse(window.to) - 1) }
  }
  const seconds = relativeSeconds(window.range)
  return { from: localDateInput(nowMs - seconds * 1000), to: localDateInput(nowMs) }
}

/**
 * Two local calendar dates (inclusive) → absolute window ending at local
 * midnight after `to`. Null when either is missing or the order is wrong.
 */
export function windowFromDates(from: string, to: string): TimeWindow | null {
  const start = parseLocalDate(from)
  const end = parseLocalDate(to)
  if (!start || !end) return null
  const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
  if (endExclusive.getTime() <= start.getTime()) return null
  return { kind: 'absolute', from: start.toISOString(), to: endExclusive.toISOString() }
}

function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function relativeSeconds(range: string): number {
  const m = /^(\d{1,6})(s|m|h|d)$/.exec(range)
  if (!m) return 30 * 86_400
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 }
  return Number(m[1]) * unit[m[2]]
}

// ── Bucket labels ─────────────────────────────────────────────────────

type DateParts = { y: number; m: number; d: number }

/** Local calendar date the bucket starts on, read from the API label. */
export function bucketDateParts(period: UsagePeriod, label: string): DateParts | null {
  if (period === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label)
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null
  }
  if (period === 'week') {
    const m = /^(\d{4})-W(\d{2})$/.exec(label)
    if (!m) return null
    const monday = isoWeekStart(Number(m[1]), Number(m[2]))
    return { y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() }
  }
  const m = /^(\d{4})-(\d{2})$/.exec(label)
  return m ? { y: Number(m[1]), m: Number(m[2]), d: 1 } : null
}

/** Monday of ISO week `week` in `year`, as a UTC-midnight Date (calendar arithmetic only). */
function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const dow = jan4.getUTCDay() || 7
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - dow + 1 + (week - 1) * 7)
  return monday
}

function utcDate(parts: DateParts, addDays = 0): Date {
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d + addDays))
}

function fmt(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' })
}

/** Friendly secondary line: `Fri, Sep 18` · `Sep 14 – Sep 20` · `September 2026`. */
export function bucketTitle(period: UsagePeriod, label: string, nowYear = new Date().getFullYear()): string {
  const parts = bucketDateParts(period, label)
  if (!parts) return label
  const yearSuffix = parts.y === nowYear ? '' : `, ${parts.y}`
  if (period === 'day') {
    return `${fmt(utcDate(parts), { weekday: 'short', month: 'short', day: 'numeric' })}${yearSuffix}`
  }
  if (period === 'week') {
    const start = fmt(utcDate(parts), { month: 'short', day: 'numeric' })
    const end = fmt(utcDate(parts, 6), { month: 'short', day: 'numeric' })
    return `${start} – ${end}${yearSuffix}`
  }
  return fmt(utcDate(parts), { month: 'long', year: 'numeric' })
}

/** Short x-axis tick: `Sep 18` · `W38` · `Sep ’26`. */
export function bucketTick(period: UsagePeriod, label: string): string {
  const parts = bucketDateParts(period, label)
  if (!parts) return label
  if (period === 'day') return fmt(utcDate(parts), { month: 'short', day: 'numeric' })
  if (period === 'week') return label.replace(/^\d{4}-/, '')
  return `${fmt(utcDate(parts), { month: 'short' })} ’${String(parts.y).slice(-2)}`
}

/** True while the bucket is the one currently running. */
export function isRunningBucket(bucket: UsageBucket, nowMs = Date.now()): boolean {
  return bucket.partial && Date.parse(bucket.bucketEnd) > nowMs
}

/** `today` / `this week` / `this month` for the running bucket, `partial` when cut by `to`. */
export function bucketHint(period: UsagePeriod, bucket: UsageBucket, nowMs = Date.now()): string | null {
  if (!bucket.partial) return null
  if (!isRunningBucket(bucket, nowMs)) return 'partial'
  if (period === 'day') return 'today'
  if (period === 'week') return 'this week'
  return 'this month'
}

export function periodNoun(period: UsagePeriod, count: number): string {
  const noun = period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'
  return count === 1 ? noun : `${noun}s`
}

const SLOT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
const SLOT_TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

/** `Tue 18 Sep · 08:00–12:00` in the browser's zone (slots are local-midnight aligned). */
export function slotTitle(startMs: number, endMs: number): string {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const sameDay = start.toDateString() === end.toDateString()
  const endLabel = sameDay ? SLOT_TIME.format(end) : `${SLOT_DAY.format(end)} ${SLOT_TIME.format(end)}`
  return `${SLOT_DAY.format(start)} · ${SLOT_TIME.format(start)}–${endLabel}`
}

/** Local time for a UTC ISO instant (peak slots, etc.). */
export function formatLocalInstant(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
