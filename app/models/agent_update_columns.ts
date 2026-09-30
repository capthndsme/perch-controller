import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Column helpers of the agent-updates models.
 *
 * Every DATETIME here holds a UTC wall time. mysql2 hands a DATETIME back as
 * a JS Date built in the *process* zone (this host runs UTC+8, the container
 * UTC), so reading it with `DateTime.fromJSDate` would shift it by the host's
 * offset. These columns read the Date's local wall-clock fields back as UTC,
 * which is right in either zone, and write `toUTC()` wall times.
 */

export function dbTimeToUtc(value: unknown): DateTime | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return DateTime.fromObject(
      {
        year: value.getFullYear(),
        month: value.getMonth() + 1,
        day: value.getDate(),
        hour: value.getHours(),
        minute: value.getMinutes(),
        second: value.getSeconds(),
      },
      { zone: 'utc' }
    )
  }
  if (typeof value === 'string') {
    const parsed = DateTime.fromSQL(value, { zone: 'utc' })
    return parsed.isValid ? parsed : null
  }
  if (DateTime.isDateTime(value)) return value.toUTC()
  return null
}

export function utcToDb(value: DateTime | null | undefined): string | null {
  if (!value) return null
  return value.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

/** A nullable UTC DATETIME column (see the module comment). */
export function utcColumn(columnName?: string) {
  return column({
    columnName,
    prepare: (value: DateTime | null | undefined) => utcToDb(value),
    consume: (value: unknown) => dbTimeToUtc(value),
  })
}

/** A JSON document in a text column; unparseable text reads as null. */
export function jsonTextColumn(columnName?: string) {
  return column({
    columnName,
    prepare: (value: unknown) =>
      value === null || value === undefined ? null : JSON.stringify(value),
    consume: (value: string | null) => {
      if (value === null || value === undefined) return null
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    },
  })
}

/** A boolean stored as tinyint (mysql2 returns 0/1). */
export function boolColumn(columnName?: string) {
  return column({
    columnName,
    prepare: (value: boolean) => (value ? 1 : 0),
    consume: (value: unknown) => value === true || value === 1 || value === '1',
  })
}
