import { column } from '@adonisjs/lucid/orm'

/**
 * Column options for a JSON document stored in a text column: `null` stays
 * NULL, anything else is `JSON.stringify`d, and unparseable stored text reads
 * as null rather than crashing the ORM's hydration. The column must be in
 * `database/schema_rules.ts` `skipColumns` so the model owns its type.
 */
export function jsonColumn(columnName: string, options: { serializeAs?: string | null } = {}) {
  return column({
    columnName,
    serializeAs: options.serializeAs,
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
