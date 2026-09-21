import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Wide time-series rows written by the poller. Each row is the SUM of the
 * deltas observed for one MAC inside one fixed-width bucket
 * (`bucket_start` aligned to the collector's poll interval).
 *
 * The UNIQUE (collector_id, mac, bucket_start) constraint is what makes
 * the poller's ON DUPLICATE KEY UPDATE merge work — if two ticks land in
 * the same bucket (e.g. clock skew, retry, or two writers on the same
 * collector), their deltas SUM into one row instead of producing
 * duplicates or losing data.
 *
 * Indices:
 *   - (mac, bucket_start)        → GET /devices/:mac/traffic?range=...
 *   - (collector_id, bucket_start) → admin sweeps / retention pruning
 */
export default class extends BaseSchema {
  protected tableName = 'device_traffic_buckets'

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
      table.datetime('bucket_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['collector_id', 'mac', 'bucket_start'], 'device_traffic_buckets_unique_idx')
      table.index(['mac', 'bucket_start'], 'device_traffic_buckets_mac_time_idx')
      table.index(['collector_id', 'bucket_start'], 'device_traffic_buckets_collector_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
