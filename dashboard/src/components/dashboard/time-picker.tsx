import { useMemo, useState } from 'react'
import { ArrowsClockwise, CalendarBlank, CaretDown } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  REFRESH_OPTIONS,
  absoluteWindow,
  describeResolutionTier,
  formatRangeLabel,
  formatWindowLabel,
  resolveResolution,
  type RefreshInterval,
  type ResolutionMode,
  type TimeWindow,
} from '@/lib/time-window'
import { cn } from '@/lib/utils'
import type { TrafficRange } from '@/types/api'

/**
 * Quick ranges grouped by the storage tier that serves them — the rollup
 * work made the whole ladder fast, so the picker now exposes it: Live runs
 * on native 5-second data, Recent on the 5-minute rollup, Historical on the
 * hourly rollup (2 years of retention).
 */
const RANGE_GROUPS: Array<{ label: string; hint: string; ranges: TrafficRange[] }> = [
  { label: 'Live', hint: 'Native 5-second data', ranges: ['1m', '5m', '15m', '30m', '1h', '6h'] },
  { label: 'Recent', hint: '5-minute rollup', ranges: ['24h', '7d'] },
  { label: 'Historical', hint: 'Hourly rollup · up to 2 years', ranges: ['30d', '90d', '180d', '365d', '730d'] },
]
const RESOLUTION_MODES: ResolutionMode[] = ['auto', '5s', '15s', '1m', '5m', '15m', '1h', '1d']

type TimePickerProps = {
  window: TimeWindow
  /**
   * `'auto'` lets the resolution float with the selected range, the
   * default and the most common case. A concrete value is the user's
   * explicit override.
   */
  resolutionMode: ResolutionMode
  refreshInterval: RefreshInterval
  onWindowChange: (window: TimeWindow) => void
  onResolutionModeChange: (mode: ResolutionMode) => void
  onRefreshIntervalChange: (interval: RefreshInterval) => void
  onRefreshNow?: () => void
}

/**
 * Single floating control that replaces the inline range/resolution
 * button strips. Trigger button reads the current window in plain
 * English ("Last 1h" or "Apr 12, 14:30 → Apr 12, 15:45"); the popover
 * holds quick ranges, absolute from/to inputs, resolution buttons, and
 * a refresh interval. Modeled on Grafana's time picker — single mental
 * model for time across the whole dashboard.
 */
export function TimePicker({
  window,
  resolutionMode,
  refreshInterval,
  onWindowChange,
  onResolutionModeChange,
  onRefreshIntervalChange,
  onRefreshNow,
}: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const effectiveResolution = useMemo(
    () => resolveResolution(window, resolutionMode),
    [window, resolutionMode],
  )
  const tier = useMemo(() => describeResolutionTier(effectiveResolution), [effectiveResolution])
  const refreshLabel = useMemo(
    () => REFRESH_OPTIONS.find((opt) => opt.value === refreshInterval)?.label ?? 'Off',
    [refreshInterval],
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2 font-mono"
            title="Change time range"
          >
            <CalendarBlank className="size-3.5" />
            <span className="truncate">{formatWindowLabel(window)}</span>
            <span className="text-muted-foreground">·</span>
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title={tier.hint}
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  tier.live ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
              {effectiveResolution}
            </span>
            {resolutionMode === 'auto' ? (
              <span className="rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                auto
              </span>
            ) : null}
            <CaretDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-[420px] p-0">
          <TimePickerBody
            window={window}
            resolutionMode={resolutionMode}
            onWindowChange={(next) => {
              onWindowChange(next)
              setOpen(false)
            }}
            onResolutionModeChange={onResolutionModeChange}
          />
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            title="Auto-refresh interval"
          >
            <ArrowsClockwise className="size-3.5" />
            <span>{refreshLabel}</span>
            <CaretDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-44 p-2">
          <div className="space-y-1">
            <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Auto refresh
            </p>
            {REFRESH_OPTIONS.map((opt) => (
              <Button
                key={String(opt.value)}
                type="button"
                variant={refreshInterval === opt.value ? 'secondary' : 'ghost'}
                size="sm"
                className="w-full justify-start"
                onClick={() => onRefreshIntervalChange(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
            {onRefreshNow ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 w-full justify-start gap-2"
                onClick={onRefreshNow}
              >
                <ArrowsClockwise className="size-3.5" />
                Refresh now
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

type TimePickerBodyProps = {
  window: TimeWindow
  resolutionMode: ResolutionMode
  onWindowChange: (window: TimeWindow) => void
  onResolutionModeChange: (mode: ResolutionMode) => void
}

function TimePickerBody({
  window,
  resolutionMode,
  onWindowChange,
  onResolutionModeChange,
}: TimePickerBodyProps) {
  const effectiveResolution = useMemo(
    () => resolveResolution(window, resolutionMode),
    [window, resolutionMode],
  )
  const tier = describeResolutionTier(effectiveResolution)

  // Local state for the absolute pickers — only applied when the user
  // clicks "Apply". Stored as `datetime-local` strings so the inputs
  // round-trip cleanly (avoiding TZ surprises on Date.toISOString).
  const initial = useMemo(() => {
    if (window.kind === 'absolute') {
      return {
        from: toLocalInputValue(new Date(window.from)),
        to: toLocalInputValue(new Date(window.to)),
      }
    }
    const now = new Date()
    const past = new Date(now.getTime() - 60 * 60 * 1000)
    return { from: toLocalInputValue(past), to: toLocalInputValue(now) }
  }, [window])

  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  // Re-seed the inputs when the window changes (derived state during
  // render, per the React docs, rather than a setState-in-effect).
  const [seededFrom, setSeededFrom] = useState(initial)
  if (seededFrom !== initial) {
    setSeededFrom(initial)
    setFrom(initial.from)
    setTo(initial.to)
  }

  const applyAbsolute = () => {
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return
    onWindowChange(absoluteWindow(fromMs, toMs))
  }

  return (
    <div className="grid grid-cols-[160px_1fr] gap-0">
      <div className="space-y-2 border-r border-border bg-muted/30 p-2">
        {RANGE_GROUPS.map((group) => (
          <div key={group.label}>
            <p
              className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground"
              title={group.hint}
            >
              {group.label}
            </p>
            <div className="grid gap-0.5">
              {group.ranges.map((range) => (
                <Button
                  key={range}
                  type="button"
                  variant={
                    window.kind === 'relative' && window.range === range
                      ? 'secondary'
                      : 'ghost'
                  }
                  size="sm"
                  className="w-full justify-start font-mono"
                  onClick={() => onWindowChange({ kind: 'relative', range })}
                >
                  {formatRangeLabel(range)}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-4 p-3">
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Absolute range
          </p>
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">From</span>
              <Input
                type="datetime-local"
                step={1}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">To</span>
              <Input
                type="datetime-local"
                step={1}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={applyAbsolute}
            disabled={!from || !to || Date.parse(to) <= Date.parse(from)}
          >
            Apply absolute range
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Resolution
            </p>
            <span
              className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={tier.hint}
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  tier.live ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
              {tier.label}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {RESOLUTION_MODES.map((mode) => (
              <Button
                key={mode}
                type="button"
                variant={resolutionMode === mode ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('px-2 font-mono text-xs')}
                onClick={() => onResolutionModeChange(mode)}
                title={
                  mode === 'auto'
                    ? 'Pick a bucket size based on the selected range'
                    : `Force ${mode} buckets`
                }
              >
                {mode === 'auto' ? 'Auto' : mode}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * `datetime-local` inputs want `YYYY-MM-DDTHH:mm:ss` in the user's
 * local timezone (no `Z` suffix). The default `Date.toISOString` returns
 * UTC, which would shift the displayed value, so we hand-format it.
 */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
