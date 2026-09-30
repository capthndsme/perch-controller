import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The Wi-Fi plane's per-AP row (docs/design/wifi controller.md section 2):
 * one row per perch-apd access point whose `system.info` carries the
 * `wifiConfig` block, created in mode `off`. It is the AP's counterpart of
 * `gateways`; every per-AP plane table hangs off it with ON DELETE CASCADE,
 * and it hangs off `wifi_access_points` the same way (deleting the AP row
 * drops its plane state; "Forget agent" keeps the row and the state).
 *
 * - `mode` off | observe | managed; `authoritative` only in managed;
 *   `enforcement` active | suspended (Authoritative Mode's revert guard).
 * - `agent_access` (none | read | write), `transport_ok`, `allow_insecure`:
 *   the AP's opt-ins as its last hello reported them.
 * - JSON (text, parsed by the model): `capabilities` (`wifi.capabilities`),
 *   `observed_hashes`, `observed_ledger`, `observed_state` ({luciPending,
 *   uncommitted, readAt}), `pinned_hashes`, `management_path` (with the
 *   uplink radios), `rejoin_offer`, `pairing`, `health`.
 * - `sync_state` is the rollup of the sections, `fleet_state` how the AP
 *   stands against the fleet render (unknown | in_line | diverged | behind |
 *   unassigned); `render_fingerprint` the SHA-256 of the last render's inputs.
 * - `country_mode` fleet | fixed | router and `country` (decision D10);
 *   `trunk_override` wins over the trunk port the AP detects.
 * - `pairing_key` APP_KEY-encrypted, never serialised; `guard` the boot
 *   guard's state (installed | self_installed | missing).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ap_configs', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .primary()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('mode', 16).notNullable().defaultTo('off')
      table.boolean('authoritative').notNullable().defaultTo(false)
      table.datetime('authoritative_since').nullable()
      table
        .integer('authoritative_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('enforcement', 16).notNullable().defaultTo('active')
      table.datetime('enforcement_changed_at').nullable()
      table.string('agent_access', 8).nullable()
      table.boolean('transport_ok').nullable()
      table.boolean('allow_insecure').nullable()
      table.text('capabilities', 'mediumtext').nullable()
      table.datetime('capabilities_at').nullable()
      table.text('observed_hashes').nullable()
      table.datetime('observed_at').nullable()
      table.text('observed_ledger', 'mediumtext').nullable()
      table.text('observed_state').nullable()
      table.text('pinned_hashes').nullable()
      table.text('management_path').nullable()
      table.integer('head_revision').unsigned().notNullable().defaultTo(0)
      table.string('sync_state', 16).notNullable().defaultTo('unknown')
      table.string('fleet_state', 16).notNullable().defaultTo('unknown')
      table.string('render_fingerprint', 64).nullable()
      table.string('country_mode', 8).notNullable().defaultTo('fleet')
      table.string('country', 2).nullable()
      table.string('trunk_override', 15).nullable()
      table.text('rejoin_offer').nullable()
      table.text('pairing').nullable()
      table.text('pairing_key').nullable()
      table.string('guard', 16).nullable()
      table.text('health').nullable()
      table.datetime('health_at').nullable()
      table.integer('neighbors_revision').unsigned().nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.index(['mode'], 'ap_configs_mode_idx')
    })
  }

  async down() {
    this.schema.dropTable('ap_configs')
  }
}
