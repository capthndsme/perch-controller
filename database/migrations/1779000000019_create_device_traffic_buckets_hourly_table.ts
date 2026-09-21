import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Hourly pre-aggregation of `device_traffic_buckets`. One row per
 * (collector, mac, hour) holding the SUM of every native bucket that falls
 * inside that hour. Wide-window reads (multi-day / multi-week) hit this
 * table instead of re-summing millions of native ~5 s rows on every poll —
 * see the June 2026 follow-up in `docs/query-optimization-findings.md`.
 *
 * Maintained two ways:
 *   - Incrementally: `bucket_writer.writeBuckets` upserts the same delta
 *     into this table (hour-aligned) inside the same transaction as the
 *     native write, so the rollup is always exact and current.
 *   - Backfilled once below from existing native rows.
 *
 * Indices mirror the native table's read patterns:
 *   - PK (collector_id, mac, hour_start) — the upsert merge key.
 *   - (hour_start)        → all-device window scans (home chart, top talkers)
 *   - (mac, hour_start)   → single-device window scans
 *
 * The `GROUP BY hour_start` reads against this table group on a *bare
 * indexed column*, so unlike the native path they avoid the
 * "Using temporary; Using filesort" the derived-expression grouping forced.
 */
export default class extends BaseSchema {
  protected tableName = 'device_traffic_buckets_hourly'

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
      table.datetime('hour_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)

      table.bigInteger('bytes_in_wan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out_wan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in_wan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out_wan').unsigned().notNullable().defaultTo(0)

      table.bigInteger('bytes_in_lan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out_lan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in_lan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out_lan').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'hour_start'])
      table.index(['hour_start'], 'device_traffic_buckets_hourly_time_idx')
      table.index(['mac', 'hour_start'], 'device_traffic_buckets_hourly_mac_time_idx')
    })

    // One-time backfill from the native table. Runs outside dry-run mode.
    // On a fresh (test) database the source table is empty, so this is a
    // no-op; on an existing deployment it aggregates all history once.
    //
    // ON DUPLICATE KEY UPDATE = VALUES makes the backfill idempotent and
    // safe to run while the poller is live: each hour row is set to the
    // authoritative SUM over the native table, overwriting (not adding to)
    // any partial current-hour row the poller already wrote.
    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO device_traffic_buckets_hourly
          (collector_id, mac, hour_start,
           bytes_in, bytes_out, packets_in, packets_out,
           bytes_in_wan, bytes_out_wan, packets_in_wan, packets_out_wan,
           bytes_in_lan, bytes_out_lan, packets_in_lan, packets_out_lan,
           updated_at)
        SELECT
          collector_id, mac,
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(bucket_start) / 3600) * 3600) AS hour_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          SUM(bytes_in_wan), SUM(bytes_out_wan), SUM(packets_in_wan), SUM(packets_out_wan),
          SUM(bytes_in_lan), SUM(bytes_out_lan), SUM(packets_in_lan), SUM(packets_out_lan),
          UTC_TIMESTAMP()
        FROM device_traffic_buckets
        GROUP BY collector_id, mac, hour_start
        ON DUPLICATE KEY UPDATE
          bytes_in = VALUES(bytes_in), bytes_out = VALUES(bytes_out),
          packets_in = VALUES(packets_in), packets_out = VALUES(packets_out),
          bytes_in_wan = VALUES(bytes_in_wan), bytes_out_wan = VALUES(bytes_out_wan),
          packets_in_wan = VALUES(packets_in_wan), packets_out_wan = VALUES(packets_out_wan),
          bytes_in_lan = VALUES(bytes_in_lan), bytes_out_lan = VALUES(bytes_out_lan),
          packets_in_lan = VALUES(packets_in_lan), packets_out_lan = VALUES(packets_out_lan),
          updated_at = VALUES(updated_at)
      `)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
