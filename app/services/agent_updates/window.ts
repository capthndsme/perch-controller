import type { AgentUpdateSettings } from '#services/agent_updates/settings'
import { DateTime } from 'luxon'

/**
 * The maintenance window (agent-updates controller.md section 6.2):
 * `windowDays` (0 = Sunday … 6) name the day a window **starts**,
 * `windowStart` / `windowEnd` are `HH:MM` in the instance time zone; an end
 * at or before the start crosses midnight (equal = 24 hours). A job or batch
 * only starts inside the window; nothing is interrupted when it closes.
 * With the window switched off every moment counts as open.
 */

export type WindowSettings = Pick<
  AgentUpdateSettings,
  'windowEnabled' | 'windowDays' | 'windowStart' | 'windowEnd'
>

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function windowsAround(settings: WindowSettings, local: DateTime) {
  const start = minutes(settings.windowStart)
  let end = minutes(settings.windowEnd)
  if (end <= start) end += 24 * 60
  const windows: Array<{ start: DateTime; end: DateTime }> = []
  for (let offset = -1; offset <= 8; offset++) {
    const day = local.startOf('day').plus({ days: offset })
    if (!settings.windowDays.includes(day.weekday % 7)) continue
    windows.push({ start: day.plus({ minutes: start }), end: day.plus({ minutes: end }) })
  }
  return windows
}

/** The window `now` is in, or null (also null when the window is off). */
export function currentWindow(
  settings: WindowSettings,
  timezone: string,
  now: DateTime = DateTime.utc()
): { start: DateTime; end: DateTime } | null {
  if (!settings.windowEnabled) return null
  const local = now.setZone(timezone)
  const hit = windowsAround(settings, local).find(
    (window) => window.start <= local && local < window.end
  )
  return hit ? { start: hit.start.toUTC(), end: hit.end.toUTC() } : null
}

export function isWindowOpen(
  settings: WindowSettings,
  timezone: string,
  now: DateTime = DateTime.utc()
): boolean {
  if (!settings.windowEnabled) return true
  return currentWindow(settings, timezone, now) !== null
}

/** The next window start after `now` (UTC), or null when off or no day is set. */
export function nextWindowStart(
  settings: WindowSettings,
  timezone: string,
  now: DateTime = DateTime.utc()
): DateTime | null {
  if (!settings.windowEnabled) return null
  const local = now.setZone(timezone)
  const next = windowsAround(settings, local).find((window) => window.start > local)
  return next ? next.start.toUTC() : null
}

/** When a job asked for "in the maintenance window" may start. */
export function windowNotBefore(
  settings: WindowSettings,
  timezone: string,
  now: DateTime = DateTime.utc()
): DateTime {
  if (isWindowOpen(settings, timezone, now)) return now
  return nextWindowStart(settings, timezone, now) ?? now
}

/**
 * `AgentFleet.window`: whether it is open, when it opens next (or, while
 * open, closes), and its days and hours, so a viewer who cannot read the
 * admin-only settings still sees the schedule.
 */
export function windowView(settings: WindowSettings, timezone: string, now = DateTime.utc()) {
  const current = currentWindow(settings, timezone, now)
  return {
    enabled: settings.windowEnabled,
    open: isWindowOpen(settings, timezone, now),
    nextStart: nextWindowStart(settings, timezone, now)?.toISO() ?? null,
    closesAt: current?.end.toISO() ?? null,
    days: [...settings.windowDays],
    start: settings.windowStart,
    end: settings.windowEnd,
    timezone,
  }
}
