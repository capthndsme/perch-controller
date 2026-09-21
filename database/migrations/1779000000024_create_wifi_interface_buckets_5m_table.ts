import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * 5-minute pre-aggregation of `wifi_interface_buckets` — the finer wifi rollup
 * tier for multi-day SSID throughput charts at `5m`/`15m`. Mirrors the device
 * 5-minute rollups (lean natural-key PK, no surrogate id) with a 300 s
 * `slot_start`. Maintained incrementally by `wifi_bucket_writer` and read via
 * `bucket_writer.ROLLUP_TIERS` (`wifiTable`).
 *
 * `ssid`/`radio`/`band` are interface attributes, not counters: the backfill
 * takes a representative value (MAX) and the live writer overwrites with the
 * latest, while the byte/packet/err/drop counters are SUMmed.
 */
export default class extends BaseSchema {
  protected tableName = 'wifi_interface_buckets_5m'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')

      table.string('ifname', 32).notNullable()
      table.string('ssid', 128).nullable()
      table.string('radio', 32).nullable()
      table.string('band', 8).nullable()
      table.datetime('slot_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('errs_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('errs_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('drops_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('drops_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['ap_id', 'ifname', 'slot_start'])
      table.index(['slot_start'], 'wifi_interface_buckets_5m_time_idx')
      table.index(['ssid', 'slot_start'], 'wifi_interface_buckets_5m_ssid_time_idx')
    })

    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO wifi_interface_buckets_5m
          (ap_id, ifname, ssid, radio, band, slot_start,
           bytes_in, bytes_out, packets_in, packets_out,
           errs_in, errs_out, drops_in, drops_out, updated_at)
        SELECT
          ap_id, ifname, MAX(ssid), MAX(radio), MAX(band),
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(bucket_start) / 300) * 300) AS slot_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          SUM(errs_in), SUM(errs_out), SUM(drops_in), SUM(drops_out),
          UTC_TIMESTAMP()
        FROM wifi_interface_buckets
        GROUP BY ap_id, ifname, slot_start
        ON DUPLICATE KEY UPDATE
          ssid = VALUES(ssid), radio = VALUES(radio), band = VALUES(band),
          bytes_in = VALUES(bytes_in), bytes_out = VALUES(bytes_out),
          packets_in = VALUES(packets_in), packets_out = VALUES(packets_out),
          errs_in = VALUES(errs_in), errs_out = VALUES(errs_out),
          drops_in = VALUES(drops_in), drops_out = VALUES(drops_out),
          updated_at = VALUES(updated_at)
      `)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
