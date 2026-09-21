import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * ap-controller agent columns on `wifi_access_points`
 * (docs/ap-controller.md section 1.2).
 *
 * `transport` says where an AP's metrics come from: `scrape` is the HTTP
 * `/metrics` poll every existing row uses (the default keeps them working
 * with no data migration), `agent` means the ap-controller daemon holds a
 * WebSocket session and the poller asks it over JSON-RPC. An AP that joins
 * with a token may have no metrics URL at all, hence `metrics_url` becomes
 * nullable.
 */
export default class extends BaseSchema {
  protected tableName = 'wifi_access_points'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('metrics_url', 500).nullable().alter()

      // 'scrape' | 'agent' — plain string, union enforced in the app layer
      // (house style, see `users.role` and `collectors.source`).
      table.string('transport', 16).notNullable().defaultTo('scrape').after('metrics_url')

      // 32 hex chars today. MySQL allows many NULLs in a UNIQUE index.
      table.string('agent_id', 64).nullable()
      // SHA-256 hex of the agent secret; the secret itself is never stored.
      table.string('agent_secret_hash', 64).nullable()
      table.string('agent_version', 32).nullable()
      // JSON: identity from the join body merged with every `system.info`.
      table.text('agent_info').nullable()
      table.timestamp('agent_joined_at').nullable()
      table.timestamp('agent_connected_at').nullable()
      table.timestamp('agent_disconnected_at').nullable()
      table.string('agent_last_address', 64).nullable()
      table
        .integer('join_token_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ap_join_tokens')
        .onDelete('SET NULL')

      table.unique(['agent_id'], 'wifi_access_points_agent_id_unique_idx')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropForeign(['join_token_id'])
      table.dropUnique(['agent_id'], 'wifi_access_points_agent_id_unique_idx')
      table.dropColumn('transport')
      table.dropColumn('agent_id')
      table.dropColumn('agent_secret_hash')
      table.dropColumn('agent_version')
      table.dropColumn('agent_info')
      table.dropColumn('agent_joined_at')
      table.dropColumn('agent_connected_at')
      table.dropColumn('agent_disconnected_at')
      table.dropColumn('agent_last_address')
      table.dropColumn('join_token_id')
    })

    // Agent rows created by a join have no URL; give them an empty one so
    // the NOT NULL constraint can come back.
    this.defer(async (db) => {
      await db.from(this.tableName).whereNull('metrics_url').update({ metrics_url: '' })
    })
    this.schema.alterTable(this.tableName, (table) => {
      table.string('metrics_url', 500).notNullable().alter()
    })
  }
}
