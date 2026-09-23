import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Native grain of the "bytes served per server name" history: one row per
 * (collector, server MAC, name, protocol) and poll (`bucket_start` aligned to
 * the collector's poll interval, ~5 s), written from the same poller deltas as
 * `device_service_buckets_5m` and `_hourly`. It gives a name's traffic chart
 * buckets down to the admin floor (Settings → Charts, default 15 s) so a
 * short burst reads as its real rate instead of a 5-minute average.
 *
 * Kept like the other native tables (`BUCKET_RETENTION_DAYS`, default 30):
 * rows exist only for polls that moved bytes, so the volume is roughly the
 * 5-minute table's times the share of busy polls.
 */
export default class extends BaseSchema {
  protected tableName = 'device_service_buckets'

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
      table.datetime('bucket_start').notNullable()

      table.bigInteger('bytes_served').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_received').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_served').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_received').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'server_name', 'protocol', 'bucket_start'])
      // Covering for the chart read (`series_buckets.querySeriesSums`): the
      // sums come from the index alone, no row lookups (half the time on a
      // name busy every poll: 2 days at 120 s ~75 ms instead of ~170 ms).
      table.index(
        ['server_name', 'bucket_start', 'bytes_served', 'bytes_received'],
        'device_service_buckets_name_time_idx'
      )
      table.index(['bucket_start'], 'device_service_buckets_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
