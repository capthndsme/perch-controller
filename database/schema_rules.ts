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
      skipColumns: ['pinned_hashes', 'capabilities', 'observed_hashes', 'management_path'],
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
      skipColumns: ['ops', 'base_hashes', 'perch_ids', 'outcome', 'replaced_router_content'],
    },
    gateway_revisions: {
      skipColumns: ['router_author', 'snapshot', 'diff', 'hashes'],
    },
    gateway_config_events: {
      skipColumns: ['detail'],
    },
    // Guest portal (docs/gateway/portal.md section 5): JSON text columns
    // parsed by their models, the APP_KEY-encrypted voucher code, the
    // template file bytes (Buffer) and the generated uniqueness column.
    portals: {
      skipColumns: ['methods', 'csp_connect_src', 'status', 'active_network'],
    },
    portal_template_files: {
      skipColumns: ['content'],
    },
    vouchers: {
      skipColumns: ['code_encrypted', 'code_hash'],
    },
    portal_users: {
      // password → scrypt hash set by the model, never serialized.
      skipColumns: ['portal_ids', 'password'],
    },
    portal_api_clients: {
      skipColumns: ['scopes', 'portal_ids', 'token_hash'],
    },
    portal_events: {
      skipColumns: ['detail'],
    },
    // REST layer (migration 076): the outbox's grant id list.
    portal_outbox: {
      skipColumns: ['grant_ids'],
    },
    // QoS (docs/gateway/qos.md section 4): the queue's full UCI option map,
    // parsed by app/models/qos_wan_queue.ts.
    qos_wan_queues: {
      skipColumns: ['options'],
    },
  },
} satisfies SchemaRules
