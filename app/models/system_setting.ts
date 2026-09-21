import { SystemSettingSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'

/**
 * Key/value store for instance-wide settings (site name, timezone, etc.).
 * Values are JSON-encoded so any scalar/object shape fits without per-key
 * migrations. Prefer the typed `get`/`set` helpers over direct model use.
 */
export default class SystemSetting extends SystemSettingSchema {
  @column({
    columnName: 'value',
    prepare: (value: unknown) => JSON.stringify(value ?? null),
    consume: (value: string | null) => {
      if (value === null) return null
      try {
        return JSON.parse(value)
      } catch {
        // Pre-existing rows that pre-date JSON encoding (none expected, but
        // defensive): hand the raw string back rather than throwing inside
        // the ORM hydration path.
        return value
      }
    },
  })
  declare value: unknown

  static async get<T = unknown>(key: string): Promise<T | null> {
    const row = await this.find(key)
    return (row?.value as T) ?? null
  }

  static async set<T = unknown>(key: string, value: T): Promise<SystemSetting> {
    return this.updateOrCreate({ key }, { value })
  }
}
