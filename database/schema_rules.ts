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
        'config_sign_key',
        'pairing',
        'pairing_key',
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
    // `ipv4`/`ipv6`: the snake-case naming strategy would map them to
    // `ipv_4`/`ipv_6`; the model names the columns explicitly.
    gateway_hosts: {
      skipColumns: ['ipv4', 'ipv6'],
    },
    gateway_section_orders: {
      skipColumns: ['base_order', 'desired_order', 'conflict'],
    },
    gateway_wan_blocks: {
      skipColumns: ['last_flush'],
    },
    ap_group_states: {
      skipColumns: ['stations'],
    },
    gateway_applies: {
      skipColumns: [
        'post_actions',
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
        'packages',
        // Gateway sync (migration 140): the checks sent and the agent's report.
        'checks',
        'check_results',
      ],
    },
    // Gateway sync (migrations 141–142): JSON text columns parsed by the models.
    gateway_wans: {
      skipColumns: ['check_targets'],
    },
    gateway_wan_transitions: {
      skipColumns: ['detail'],
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
      skipColumns: [
        'methods',
        'csp_connect_src',
        'status',
        'active_network',
        'payment',
        'click_through',
      ],
    },
    // Paid Hotspot (migrations 100–101): JSON text columns and the
    // APP_KEY-encrypted terminal token.
    hotspot_price_tables: {
      skipColumns: ['entries'],
    },
    hotspot_price_revisions: {
      skipColumns: ['entries'],
    },
    hotspot_terminals: {
      skipColumns: ['token_hash', 'token_encrypted', 'status'],
    },
    hotspot_checkouts: {
      skipColumns: ['price_snapshot', 'coins'],
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
    // Collector socket (migration 077): the hello's portal object and the
    // last portal.configure result.
    portal_gateway_states: {
      skipColumns: ['capabilities', 'router_status'],
    },
    // Wi-Fi plane (docs/design/wifi controller.md section 2, migrations
    // 125–136): JSON text columns parsed by app/models/ap_config*.ts and
    // app/models/wifi_*.ts, the APP_KEY-encrypted pairing key and secret
    // value, and the SSID bytes (varbinary, read as a string).
    ap_configs: {
      skipColumns: [
        'capabilities',
        'observed_hashes',
        'observed_ledger',
        'observed_state',
        'pinned_hashes',
        'management_path',
        'rejoin_offer',
        'pairing',
        'pairing_key',
        'health',
      ],
    },
    ap_config_sections: {
      skipColumns: [
        'ownership',
        'base_content',
        'router_content',
        'router_author',
        'desired_content',
        'conflict',
      ],
    },
    ap_config_revisions: {
      skipColumns: ['router_author', 'snapshot', 'diff', 'hashes'],
    },
    ap_config_applies: {
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
        'health',
      ],
    },
    ap_config_events: {
      skipColumns: ['detail'],
    },
    wifi_secrets: {
      skipColumns: ['value'],
    },
    wifi_networks: {
      skipColumns: ['ssid', 'binding', 'bands', 'roaming', 'advanced'],
    },
    wifi_network_aps: {
      skipColumns: ['bands', 'radios', 'overrides', 'radio_overrides'],
    },
    wifi_divergences: {
      skipColumns: ['fleet_value', 'ap_value', 'router_author'],
    },
    wifi_rollouts: {
      skipColumns: ['network_ids', 'ap_order', 'stop', 'impact'],
    },
    wifi_rollout_steps: {
      skipColumns: ['perch_ids', 'outcome'],
    },
  },
} satisfies SchemaRules
