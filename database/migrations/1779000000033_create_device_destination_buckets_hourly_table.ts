import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Hourly "where did this device's WAN bytes go, by name": the mirror image of
 * `device_service_buckets_hourly`. The go-collector credits a row to the local
 * device that was the *client* of a WAN flow, keyed by the TLS SNI / HTTP Host
 * / QUIC SNI it asked for and the protocol label, and stamps nDPI's application
 * category on it. Flows nDPI labelled without ever seeing a name ("netflix"
 * from IP ranges) arrive with `server_name = ''` and pool per protocol, so the
 * per-app and per-category totals stay complete.
 *
 * Bytes are from the device's point of view: `bytes_in` downloaded from the
 * destination, `bytes_out` uploaded to it. Rows are deltas between poller
 * snapshots SUMmed into the hour via ON DUPLICATE KEY UPDATE
 * (`bucket_writer.writeDestinationBuckets`); `category` is overwritten by the
 * latest delta (it can only change when nDPI refines a flow).
 * Retention: `DESTINATION_HOURLY_RETENTION_DAYS` (default 365).
 */
export default class extends BaseSchema {
  protected tableName = 'device_destination_buckets_hourly'

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
      table.string('server_name', 255).notNullable().defaultTo('')
      table.string('protocol', 30).notNullable()
      table.string('category', 40).notNullable().defaultTo('')
      table.datetime('hour_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'server_name', 'protocol', 'hour_start'])
      table.index(['server_name', 'hour_start'], 'device_destination_buckets_hourly_name_time_idx')
      table.index(['hour_start'], 'device_destination_buckets_hourly_time_idx')
      table.index(['mac', 'hour_start'], 'device_destination_buckets_hourly_mac_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
