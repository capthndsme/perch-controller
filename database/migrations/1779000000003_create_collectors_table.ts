import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'collectors'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('name').notNullable()

      // base_url is the go-collector HTTP root, e.g. http://127.0.0.1:9800.
      // Sized generously so reverse-proxy + subpath deployments fit.
      table.string('base_url', 500).notNullable()

      // AES-encrypted (Adonis `encryption` service, keyed by APP_KEY) when
      // the collector requires a Bearer token; nullable for local instances.
      table.text('api_key').nullable()

      table.integer('poll_interval_seconds').notNullable().defaultTo(5)
      table.boolean('enabled').notNullable().defaultTo(true)

      // Result of the most recent probe (live or scheduled). Stored as JSON
      // text so the schema doesn't shift when the probe result shape grows.
      table.timestamp('last_seen_at').nullable()
      table.text('last_status').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      // The future poller scans `WHERE enabled = true` on every tick.
      table.index(['enabled'], 'collectors_enabled_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
