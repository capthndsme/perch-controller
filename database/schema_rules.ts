import { type SchemaRules } from '@adonisjs/lucid/types/schema_generator'

/**
 * Columns declared here are skipped during automatic schema generation so the
 * owning Lucid model can attach custom prepare/consume/serializeAs behaviour
 * without TypeScript redeclaration conflicts. The DB column itself is still
 * present and migrated normally; this only controls the generated TS shape.
 */
export default {
  tables: {
    collectors: {
      // api_key   → AES-encrypted at rest via Adonis encryption (APP_KEY).
      // last_status → JSON-encoded structured probe result.
      // Both are declared on `Collector` (app/models/collector.ts).
      skipColumns: ['api_key', 'last_status'],
    },
    system_settings: {
      // value → JSON-encoded; declared on `SystemSetting`
      // (app/models/system_setting.ts) with typed get/set helpers.
      skipColumns: ['value'],
    },
  },
} satisfies SchemaRules
