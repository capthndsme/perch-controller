import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Hourly "bytes served per server name": how much each local *server* pushed
 * to (and received from) clients, per TLS SNI / HTTP Host / QUIC SNI and
 * protocol label. The go-collector learns the name from the ClientHello via
 * nDPI and only records it on the device that is the server side of the flow,
 * so a reverse proxy terminating twenty vhosts shows twenty rows on one MAC —
 * exactly the "how many GB did my servers push, by site" question.
 *
 * Rows are byte deltas between consecutive poller snapshots, SUMmed into the
 * hour via ON DUPLICATE KEY UPDATE (`bucket_writer.writeServiceBuckets`).
 * Retention: `SERVICE_HOURLY_RETENTION_DAYS` (default 365).
 */
export default class extends BaseSchema {
  protected tableName = 'device_service_buckets_hourly'

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
      table.datetime('hour_start').notNullable()

      table.bigInteger('bytes_served').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_received').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_served').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_received').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'server_name', 'protocol', 'hour_start'])
      table.index(['server_name', 'hour_start'], 'device_service_buckets_hourly_name_time_idx')
      table.index(['hour_start'], 'device_service_buckets_hourly_time_idx')
      table.index(['mac', 'hour_start'], 'device_service_buckets_hourly_mac_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
