import type { AlertsSettings, Severity } from '#services/alerts/model'
import { DateTime } from 'luxon'

/**
 * Quiet hours (docs/design/alerts/delivery.md §4): one global window in the
 * instance time zone (`system_settings.timezone`, via Luxon, so daylight
 * saving shifts are handled); a window whose end is not after its start
 * crosses midnight. Deliveries below `breakThrough` wait (`held`) until the
 * window ends, then go out as one digest.
 */

function hhmm(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null
}

function at(day: DateTime, time: { hour: number; minute: number }, zone: string): DateTime {
  return DateTime.fromObject(
    { year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute },
    { zone }
  )
}

/**
 * The end of the quiet window `now` falls in (UTC), or null when `now` is
 * outside it. `start === end` is an empty window.
 */
export function quietWindowEnd(
  now: DateTime,
  window: { start: string; end: string },
  zone: string
): DateTime | null {
  const start = hhmm(window.start)
  const end = hhmm(window.end)
  if (!start || !end) return null
  if (start.hour === end.hour && start.minute === end.minute) return null
  const local = now.setZone(zone)
  if (!local.isValid) return null
  const crossesMidnight = end.hour * 60 + end.minute <= start.hour * 60 + start.minute
  for (const offset of [-1, 0]) {
    const day = local.startOf('day').plus({ days: offset })
    const from = at(day, start, zone)
    const to = at(crossesMidnight ? day.plus({ days: 1 }) : day, end, zone)
    if (now >= from && now < to) return to.toUTC()
  }
  return null
}

/**
 * When a delivery of `severity` to a destination whose filter says
 * `quietHours` must wait: the end of the window, or null (send now).
 */
export function quietHoldUntil(
  settings: Pick<AlertsSettings, 'quietHours'>,
  destinationQuietHours: 'inherit' | 'ignore',
  severity: Severity,
  now: DateTime,
  zone: string
): DateTime | null {
  const qh = settings.quietHours
  if (!qh.enabled || destinationQuietHours === 'ignore') return null
  if (qh.breakThrough === 'critical' && severity === 'critical') return null
  return quietWindowEnd(now, qh, zone)
}
