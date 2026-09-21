import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Discovery + lifecycle columns for `collectors`.
 *
 * A collector now has a stable identity of its own (`instance_id`, generated
 * and persisted by the daemon) so the server can recognise the same daemon
 * across address changes, restarts and reinstalls. `source` records who put
 * the row there, `lifecycle` gates what the poller is allowed to touch.
 *
 * Every pre-existing row is a collector an admin configured by hand (wizard
 * or COLLECTOR_URL) and is already being polled, so the defaults
 * ('manual' / 'adopted') keep it working with no data migration.
 */
export default class extends BaseSchema {
  protected tableName = 'collectors'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Daemon-generated, persisted across restarts. 32 hex chars today;
      // sized for a UUID or a longer scheme later. NULL for rows created
      // before the daemon that announces itself, and for manual rows whose
      // collector never announced — MySQL allows many NULLs in a UNIQUE.
      table.string('instance_id', 64).nullable().after('name')

      // Self-reported metadata, refreshed on every announce and on every
      // successful probe (capture_interface already arrives in the probe,
      // see app/services/collector_probe.ts).
      table.string('hostname', 255).nullable().after('instance_id')
      table.string('version', 64).nullable().after('hostname')
      table.string('capture_interface', 64).nullable().after('version')

      // 'manual'    — wizard or Settings → Collectors
      // 'env'       — providers/default_collector_provider.ts (COLLECTOR_URL)
      // 'announced' — created by POST /api/v1/collectors/announce
      table.string('source', 16).notNullable().defaultTo('manual')

      // 'pending'   — announced, awaiting an admin decision. Never polled.
      // 'adopted'   — in service. Polled when `enabled` is also true.
      // 'dismissed' — admin said no. Never polled, hidden by default, kept
      //               so re-announces don't resurrect it in the UI.
      table.string('lifecycle', 16).notNullable().defaultTo('adopted')

      table.timestamp('last_announce_at').nullable()

      // What the daemon claimed its address was. `base_url` is what the
      // server actually polls and is derived from the announce source IP;
      // keeping both makes "it says br-lan/192.168.1.1, we reach it at
      // 192.168.1.1" debuggable.
      table.string('announced_base_url', 500).nullable()

      // First 8 hex chars of sha256(api_key). Safe to display: lets the
      // admin compare against `uci get metricslite-collector.main.api_key`
      // before adopting, and lets the server reject a mistyped key without
      // a round trip. Recomputed whenever the key is set.
      table.string('api_key_fingerprint', 16).nullable()

      table.unique(['instance_id'], 'collectors_instance_id_unique_idx')
      // The poller's per-tick scan is now
      // WHERE enabled = true AND lifecycle = 'adopted'.
      table.index(['lifecycle', 'enabled'], 'collectors_lifecycle_enabled_idx')
      // Announce claim-by-address lookup; mirrors
      // wifi_access_points_metrics_url_idx (migration …0011).
      table.index(['base_url'], 'collectors_base_url_idx')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropUnique(['instance_id'], 'collectors_instance_id_unique_idx')
      table.dropIndex(['lifecycle', 'enabled'], 'collectors_lifecycle_enabled_idx')
      table.dropIndex(['base_url'], 'collectors_base_url_idx')
      table.dropColumn('instance_id')
      table.dropColumn('hostname')
      table.dropColumn('version')
      table.dropColumn('capture_interface')
      table.dropColumn('source')
      table.dropColumn('lifecycle')
      table.dropColumn('last_announce_at')
      table.dropColumn('announced_base_url')
      table.dropColumn('api_key_fingerprint')
    })
  }
}
