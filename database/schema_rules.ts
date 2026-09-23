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
    // Managed gateway (docs/gateway/config-plane.md section 9): JSON text
    // columns parsed by their models (app/models/gateway*.ts), and the
    // APP_KEY-encrypted secret value.
    gateways: {
      skipColumns: [
        'pinned_hashes',
        'capabilities',
        'observed_hashes',
        'management_path',
        'observed_ledger',
        'observed_state',
        'rejoin_offer',
      ],
    },
    gateway_sections: {
      skipColumns: [
        'ownership',
        'base_content',
        'router_content',
        'router_author',
        'desired_content',
        'conflict',
      ],
    },
    gateway_secrets: {
      skipColumns: ['value'],
    },
    gateway_applies: {
      skipColumns: [
        'ops',
        'base_hashes',
        'perch_ids',
        'outcome',
        'replaced_router_content',
        'written',
        'ledger',
        'secret_refs',
        'configs',
        'changes',
        'chain_perch_ids',
      ],
    },
    gateway_revisions: {
      skipColumns: ['router_author', 'snapshot', 'diff', 'hashes'],
    },
    gateway_config_events: {
      skipColumns: ['detail'],
    },
  },
} satisfies SchemaRules
