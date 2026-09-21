import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Latest identity facts learned from the collector for each device. The
 * collector already reports `ips[]`; this table keeps that identity separate
 * from traffic buckets so the dashboard can render IP-first rows without
 * duplicating identity JSON into every time-series bucket.
 */
export default class extends BaseSchema {
  protected tableName = 'device_identities'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.bigIncrements('id').notNullable()

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')

      table.string('mac', 17).notNullable()
      table.string('primary_ip', 45).nullable()
      table.text('ips').notNullable()
      table.timestamp('first_seen_at').nullable()
      table.timestamp('last_seen_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['collector_id', 'mac'], 'device_identities_unique_idx')
      table.index(['mac'], 'device_identities_mac_idx')
      table.index(['primary_ip'], 'device_identities_primary_ip_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
