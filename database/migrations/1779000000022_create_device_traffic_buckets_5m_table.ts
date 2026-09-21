import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * 5-minute pre-aggregation of `device_traffic_buckets` — the finer rollup
 * tier that serves multi-day charts at `5m`/`15m` resolution (the 6 h–7 d
 * band) without re-summing the native ~5 s rows. Same maintenance model as
 * `device_traffic_buckets_hourly` (written in the same transaction as the
 * native row; see `bucket_writer.ROLLUP_TIERS`) and the same idempotent,
 * live-poller-safe backfill. `slot_start` is `bucket_start` floored to 300 s.
 */
export default class extends BaseSchema {
  protected tableName = 'device_traffic_buckets_5m'

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
      table.datetime('slot_start').notNullable()

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

      table.primary(['collector_id', 'mac', 'slot_start'])
      table.index(['slot_start'], 'device_traffic_buckets_5m_time_idx')
      table.index(['mac', 'slot_start'], 'device_traffic_buckets_5m_mac_time_idx')
    })

    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO device_traffic_buckets_5m
          (collector_id, mac, slot_start,
           bytes_in, bytes_out, packets_in, packets_out,
           bytes_in_wan, bytes_out_wan, packets_in_wan, packets_out_wan,
           bytes_in_lan, bytes_out_lan, packets_in_lan, packets_out_lan,
           updated_at)
        SELECT
          collector_id, mac,
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(bucket_start) / 300) * 300) AS slot_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          SUM(bytes_in_wan), SUM(bytes_out_wan), SUM(packets_in_wan), SUM(packets_out_wan),
          SUM(bytes_in_lan), SUM(bytes_out_lan), SUM(packets_in_lan), SUM(packets_out_lan),
          UTC_TIMESTAMP()
        FROM device_traffic_buckets
        GROUP BY collector_id, mac, slot_start
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
