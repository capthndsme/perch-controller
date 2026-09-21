import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Daily rollup tier for the three bucket streams (device traffic, device
 * protocol, WiFi interface). Completes the ladder native → 5m → hourly → daily
 * so multi-month and multi-year views group on a bare indexed `day_start`
 * instead of re-summing hourly rows.
 *
 * Days are UTC calendar days (the DB session runs in UTC — see
 * `config/database.ts`). Maintained by `rollup_maintainer` from the hourly
 * tier; backfilled here from whatever hourly history already exists.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('device_traffic_buckets_daily', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.datetime('day_start').notNullable()

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

      table.primary(['collector_id', 'mac', 'day_start'])
      table.index(['day_start'], 'device_traffic_buckets_daily_time_idx')
      table.index(['mac', 'day_start'], 'device_traffic_buckets_daily_mac_time_idx')
    })

    this.schema.createTable('device_protocol_buckets_daily', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('protocol', 30).notNullable()
      table.datetime('day_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'protocol', 'day_start'])
      table.index(['day_start', 'protocol'], 'device_protocol_buckets_daily_time_proto_idx')
      table.index(['mac', 'day_start'], 'device_protocol_buckets_daily_mac_time_idx')
    })

    this.schema.createTable('wifi_interface_buckets_daily', (table) => {
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
      table.datetime('day_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('errs_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('errs_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('drops_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('drops_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['ap_id', 'ifname', 'day_start'])
      table.index(['day_start'], 'wifi_interface_buckets_daily_time_idx')
      table.index(['ssid', 'day_start'], 'wifi_interface_buckets_daily_ssid_time_idx')
    })

    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO device_traffic_buckets_daily
          (collector_id, mac, day_start, bytes_in, bytes_out, packets_in, packets_out,
           bytes_in_wan, bytes_out_wan, packets_in_wan, packets_out_wan,
           bytes_in_lan, bytes_out_lan, packets_in_lan, packets_out_lan, updated_at)
        SELECT
          collector_id, mac,
          DATE_SUB(hour_start, INTERVAL MOD(TO_SECONDS(hour_start), 86400) SECOND) AS day_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          SUM(bytes_in_wan), SUM(bytes_out_wan), SUM(packets_in_wan), SUM(packets_out_wan),
          SUM(bytes_in_lan), SUM(bytes_out_lan), SUM(packets_in_lan), SUM(packets_out_lan),
          UTC_TIMESTAMP()
        FROM device_traffic_buckets_hourly
        GROUP BY collector_id, mac, day_start
        ON DUPLICATE KEY UPDATE bytes_in = VALUES(bytes_in), updated_at = VALUES(updated_at)
      `)

      await db.rawQuery(`
        INSERT INTO device_protocol_buckets_daily
          (collector_id, mac, protocol, day_start, bytes_in, bytes_out, packets_in, packets_out,
           updated_at)
        SELECT
          collector_id, mac, protocol,
          DATE_SUB(hour_start, INTERVAL MOD(TO_SECONDS(hour_start), 86400) SECOND) AS day_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out), UTC_TIMESTAMP()
        FROM device_protocol_buckets_hourly
        GROUP BY collector_id, mac, protocol, day_start
        ON DUPLICATE KEY UPDATE bytes_in = VALUES(bytes_in), updated_at = VALUES(updated_at)
      `)

      await db.rawQuery(`
        INSERT INTO wifi_interface_buckets_daily
          (ap_id, ifname, ssid, radio, band, day_start, bytes_in, bytes_out, packets_in,
           packets_out, errs_in, errs_out, drops_in, drops_out, updated_at)
        SELECT
          ap_id, ifname, MAX(ssid), MAX(radio), MAX(band),
          DATE_SUB(hour_start, INTERVAL MOD(TO_SECONDS(hour_start), 86400) SECOND) AS day_start,
          SUM(bytes_in), SUM(bytes_out), SUM(packets_in), SUM(packets_out),
          SUM(errs_in), SUM(errs_out), SUM(drops_in), SUM(drops_out), UTC_TIMESTAMP()
        FROM wifi_interface_buckets_hourly
        GROUP BY ap_id, ifname, day_start
        ON DUPLICATE KEY UPDATE bytes_in = VALUES(bytes_in), updated_at = VALUES(updated_at)
      `)
    })
  }

  async down() {
    this.schema.dropTable('wifi_interface_buckets_daily')
    this.schema.dropTable('device_protocol_buckets_daily')
    this.schema.dropTable('device_traffic_buckets_daily')
  }
}
