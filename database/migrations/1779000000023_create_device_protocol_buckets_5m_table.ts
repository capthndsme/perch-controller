import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * 5-minute pre-aggregation of `device_protocol_buckets` — the finer protocol
 * rollup tier for multi-day protocol charts at `5m`/`15m`. Mirrors
 * `device_protocol_buckets_hourly` with a 300 s `slot_start`. See the traffic
 * 5-minute migration and `bucket_writer.ROLLUP_TIERS`.
 */
export default class extends BaseSchema {
  protected tableName = 'device_protocol_buckets_5m'

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
      table.datetime('slot_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'protocol', 'slot_start'])
      table.index(['slot_start', 'protocol'], 'device_protocol_buckets_5m_time_proto_idx')
      table.index(['mac', 'slot_start'], 'device_protocol_buckets_5m_mac_time_idx')
    })

    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO device_protocol_buckets_5m
          (collector_id, mac, protocol, slot_start,
           bytes_in, bytes_out, packets_in, packets_out, updated_at)
        SELECT
          collector_id, mac, protocol,
          FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(bucket_start) / 300) * 300) AS slot_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          UTC_TIMESTAMP()
        FROM device_protocol_buckets
        GROUP BY collector_id, mac, protocol, slot_start
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
