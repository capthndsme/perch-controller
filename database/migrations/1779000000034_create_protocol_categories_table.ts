import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Protocol label → nDPI application category ("youtube" → "media", "https" →
 * "web", "ssh" → "remote-access"). Filled by the collector poller from
 * `GET /api/v1/protocols` on the collector (about once an hour per
 * collector); read by the protocol endpoints so the *existing* protocol
 * bucket history can be grouped by category for every window and every
 * rollup tier without a new time series.
 *
 * Deliberately a lookup and not a column on the bucket tables: the category is
 * a property of the protocol label, and the one place it is flow-specific
 * (an ad domain over plain TLS) is covered by the per-name `category` on
 * `device_destination_buckets_hourly`.
 */
export default class extends BaseSchema {
  protected tableName = 'protocol_categories'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')
      table.string('protocol', 30).primary()
      table.string('category', 40).notNullable()
      table.timestamp('updated_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
