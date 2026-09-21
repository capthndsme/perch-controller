import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Hourly pre-aggregation of `device_protocol_buckets`, the largest and
 * fastest-growing time-series table (12M rows / ~3 GB in ~3 weeks of
 * captures). One row per (collector, mac, protocol, hour) holding the SUM
 * of the native buckets in that hour. Same rationale and maintenance model
 * as `device_traffic_buckets_hourly` — see that migration and the June 2026
 * follow-up in `docs/query-optimization-findings.md`.
 *
 * Indices:
 *   - PK (collector_id, mac, protocol, hour_start) — the upsert merge key.
 *   - (hour_start, protocol) → all-device protocol time series / breakdown
 *   - (mac, hour_start)      → single-device protocol queries
 */
export default class extends BaseSchema {
  protected tableName = 'device_protocol_buckets_hourly'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')

      table.string('mac', 17).notNullable()
      table.string('protocol', 30).notNullable()
      table.datetime('hour_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'protocol', 'hour_start'])
      table.index(['hour_start', 'protocol'], 'device_protocol_buckets_hourly_time_proto_idx')
      table.index(['mac', 'hour_start'], 'device_protocol_buckets_hourly_mac_time_idx')
    })

    // Idempotent / live-poller-safe backfill — see the traffic migration.
    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO device_protocol_buckets_hourly
          (collector_id, mac, protocol, hour_start,
           bytes_in, bytes_out, packets_in, packets_out, updated_at)
        SELECT
          collector_id, mac, protocol,
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(bucket_start) / 3600) * 3600) AS hour_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          UTC_TIMESTAMP()
        FROM device_protocol_buckets
        GROUP BY collector_id, mac, protocol, hour_start
        ON DUPLICATE KEY UPDATE
          bytes_in = VALUES(bytes_in), bytes_out = VALUES(bytes_out),
          packets_in = VALUES(packets_in), packets_out = VALUES(packets_out),
          updated_at = VALUES(updated_at)
      `)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
