import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The managed gateway's controller-side row (docs/gateway/config-plane.md
 * section 9). One row per collector whose hello carries the `gateway_config`
 * capability. It is the only gateway table that references `collectors`;
 * every other gateway table hangs off `gateways` with ON DELETE CASCADE.
 *
 * - `collector_id` is SET NULL on delete (a detached gateway keeps its
 *   history and can be re-bound, like `infra_nodes`), unique so a collector
 *   has at most one gateway. `collectors:merge` lists the table in
 *   `NON_HISTORY_TABLES` and moves it by its own rule.
 * - `mode` off | observe | managed, `authoritative` only meaningful in
 *   `managed`; `enforcement` active | suspended (Authoritative Mode's revert
 *   loop guard); `sync_state` is the rollup of the sections
 *   (unknown | in_sync | ahead | conflict | drift | applying).
 * - `management_path`: how the agent reaches the controller (README 3.8:
 *   `ip route get <controller>` on the router), JSON; changes to that network
 *   go into an apply of their own with a longer confirm window.
 * - `local_state_path` / `local_state_flush_seconds`: per-gateway overrides of
 *   the router-side state store (README 7.18); null = the controller setting,
 *   resolved against the storage type the agent reports.
 *
 * Unions are plain strings enforced in the app layer (house style). JSON is
 * stored as text and parsed by the model.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('gateways', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('collector_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('collectors')
        .onDelete('SET NULL')
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
      // Router file hashes pinned when Authoritative Mode was enabled (JSON).
      table.text('pinned_hashes').nullable()
      // The router's `config_access` (none | read | write) from its last hello.
      table.string('agent_access', 8).nullable()
      table.text('capabilities').nullable()
      table.datetime('capabilities_at').nullable()
      table.text('observed_hashes').nullable()
      table.datetime('observed_at').nullable()
      table.text('management_path').nullable()
      table.string('local_state_path', 255).nullable()
      table.integer('local_state_flush_seconds').unsigned().nullable()
      table.integer('head_revision').unsigned().notNullable().defaultTo(0)
      table.string('sync_state', 16).notNullable().defaultTo('unknown')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      // Many NULLs are allowed in a unique index: detached gateways.
      table.unique(['collector_id'], 'gateways_collector_id_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('gateways')
  }
}
