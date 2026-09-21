import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Five-minute grain of the "bytes served per server name" history, written
 * alongside `device_service_buckets_hourly` from the same poller deltas. The
 * hourly table answers "how many GB did this vhost push"; this one answers
 * "when did it spike": a 5-minute average rate shows a burst that an hourly
 * average flattens away. Short retention on purpose
 * (`SERVICE_5M_RETENTION_DAYS`, default 14) — it exists for the recent view
 * of a name's traffic chart, not for history.
 */
export default class extends BaseSchema {
  protected tableName = 'device_service_buckets_5m'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('server_name', 255).notNullable()
      table.string('protocol', 30).notNullable()
      table.datetime('slot_start').notNullable()

      table.bigInteger('bytes_served').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_received').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_served').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_received').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'server_name', 'protocol', 'slot_start'])
      table.index(['server_name', 'slot_start'], 'device_service_buckets_5m_name_time_idx')
      table.index(['slot_start'], 'device_service_buckets_5m_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
