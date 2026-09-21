import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Collector transport (docs/collector-agent.md section 5.1).
 *
 * `transport` says how a collector's data reaches the server: `poll` is the
 * HTTP pull every existing row uses (the default keeps them working with no
 * data migration), `agent` means the daemon holds a WebSocket session
 * (`/api/v1/collector-agent/ws`) and pushes on the schedule the server sets.
 * The poll task only dispatches `poll` rows.
 *
 * A socket collector whose HTTP API answers on loopback only has nothing the
 * server could poll, hence `base_url` becomes nullable.
 */
export default class extends BaseSchema {
  protected tableName = 'collectors'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('base_url', 500).nullable().alter()
      // 'poll' | 'agent' — plain string, union enforced in the app layer
      // (house style, see `collectors.source` and `wifi_access_points.transport`).
      table.string('transport', 16).notNullable().defaultTo('poll').after('base_url')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('transport')
    })
    // Socket rows without an address get an empty one so NOT NULL can return.
    this.defer(async (db) => {
      await db.from(this.tableName).whereNull('base_url').update({ base_url: '' })
    })
    this.schema.alterTable(this.tableName, (table) => {
      table.string('base_url', 500).notNullable().alter()
    })
  }
}
