import { DateTime } from 'luxon'

/**
 * The alerts area's clock. Every time the engine, routing and the delivery
 * worker compare against comes from `alertNow()`, and SQL gets it as a
 * parameter (never `UTC_TIMESTAMP()`), so tests can drive the whole pipeline
 * with a fake clock. Stored times are UTC wall times (the process runs with
 * `TZ=UTC`, `.env`), formatted without fractions like Lucid's own.
 */

let override: (() => DateTime) | null = null

export function alertNow(): DateTime {
  return (override ? override() : DateTime.utc()).toUTC()
}

/** Tests only: pin the clock (`null` = the real one). */
export function _setAlertClock(fn: (() => DateTime) | null): void {
  override = fn
}

/** A controllable clock for tests: `const clock = fakeAlertClock('2026-10-01T06:00:00Z')`. */
export function fakeAlertClock(start: string | DateTime) {
  let current = typeof start === 'string' ? DateTime.fromISO(start, { zone: 'utc' }) : start.toUTC()
  _setAlertClock(() => current)
  return {
    now: () => current,
    set(at: string | DateTime) {
      current = typeof at === 'string' ? DateTime.fromISO(at, { zone: 'utc' }) : at.toUTC()
    },
    advance(duration: { seconds?: number; minutes?: number; hours?: number; days?: number }) {
      current = current.plus(duration)
      return current
    },
    restore() {
      _setAlertClock(null)
    },
  }
}

/** `yyyy-MM-dd HH:mm:ss` in UTC, for SQL parameters. */
export function sqlTime(value: DateTime): string {
  return value.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

/** A DATETIME read by a raw query (a Date in the UTC process, or a string) as UTC. */
export function fromSqlTime(value: unknown): DateTime | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' })
  if (typeof value === 'string') {
    const parsed = DateTime.fromSQL(value, { zone: 'utc' })
    return parsed.isValid ? parsed : null
  }
  if (DateTime.isDateTime(value)) return value.toUTC()
  return null
}

export function isoOrNull(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO({ suppressMilliseconds: true }) : null
}
