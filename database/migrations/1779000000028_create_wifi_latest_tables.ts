import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * "Latest row per group" tables for the WiFi snapshot streams. Every WiFi
 * page starts by asking "what is the current state of each station / SSID
 * interface / AP", and answering that from the append-only snapshot tables
 * meant a `GROUP BY mac` over the entire history (9.7 M rows at the time of
 * this migration) on every request. These tables hold exactly one row per
 * key, upserted by the poller on every tick, so the same question is a
 * primary-key scan of a few hundred rows.
 *
 * They are *derived* state: the snapshot tables stay the source of truth for
 * history, and `wifi_bucket_writer.rebuildWifiLatestTables()` can rebuild
 * these from scratch (that is also what the backfill below does).
 *
 * `wifi_station_latest` is keyed on `mac` alone (not `(ap_id, mac)`): a
 * client is on one AP at a time and the UI wants "where is it now". The
 * poller's upsert only lets a *different* AP take over the row when its
 * report is fresher (lower `inactive_ms`) or the existing row has gone stale,
 * so two APs that both still list a roamed client don't flap the answer.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_station_latest', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.string('mac', 17).notNullable().primary()
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
      table.smallint('channel').unsigned().nullable()
      table.integer('frequency_mhz').unsigned().nullable()
      table.string('band', 8).nullable()
      table.smallint('signal_dbm').nullable()
      table.smallint('snr_db').nullable()
      table.integer('tx_rate_kbps').unsigned().nullable()
      table.integer('rx_rate_kbps').unsigned().nullable()
      table.integer('expected_throughput_kbps').unsigned().nullable()
      table.integer('inactive_ms').unsigned().nullable()
      table.bigInteger('tx_bytes').unsigned().nullable()
      table.bigInteger('rx_bytes').unsigned().nullable()
      table.bigInteger('tx_packets').unsigned().nullable()
      table.bigInteger('rx_packets').unsigned().nullable()
      table.datetime('recorded_at').notNullable()

      table.index(['ap_id', 'ifname'], 'wifi_station_latest_ap_ifname_idx')
      table.index(['recorded_at'], 'wifi_station_latest_recorded_at_idx')
    })

    this.schema.createTable('wifi_network_latest', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('ifname', 32).notNullable()
      table.string('ssid', 128).notNullable()
      table.string('bssid', 17).notNullable()
      table.string('radio', 32).notNullable()
      table.smallint('channel').unsigned().nullable()
      table.integer('frequency_mhz').unsigned().nullable()
      table.string('band', 8).nullable()
      table.smallint('quality').unsigned().nullable()
      table.smallint('signal_dbm').nullable()
      table.smallint('noise_dbm').nullable()
      table.integer('bitrate_kbps').unsigned().nullable()
      table.datetime('recorded_at').notNullable()

      table.primary(['ap_id', 'ifname'])
    })

    this.schema.createTable('ap_system_latest', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .primary()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.float('load_1', 8, 2).nullable()
      table.float('load_5', 8, 2).nullable()
      table.float('load_15', 8, 2).nullable()
      table.bigInteger('mem_total').unsigned().nullable()
      table.bigInteger('mem_available').unsigned().nullable()
      table.integer('conntrack_entries').unsigned().nullable()
      table.integer('conntrack_limit').unsigned().nullable()
      table.integer('uptime_seconds').unsigned().nullable()
      table.datetime('recorded_at').notNullable()
    })

    // Backfill from the snapshot history using the derived-table JOIN pattern
    // (one GROUP BY pass + a join back, never a correlated subquery).
    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO wifi_station_latest
          (mac, ap_id, ifname, ssid, radio, channel, frequency_mhz, band, signal_dbm, snr_db,
           tx_rate_kbps, rx_rate_kbps, expected_throughput_kbps, inactive_ms,
           tx_bytes, rx_bytes, tx_packets, rx_packets, recorded_at)
        SELECT
          s.mac, s.ap_id, s.ifname, s.ssid, s.radio, s.channel, s.frequency_mhz, s.band,
          s.signal_dbm, s.snr_db, s.tx_rate_kbps, s.rx_rate_kbps, s.expected_throughput_kbps,
          s.inactive_ms, s.tx_bytes, s.rx_bytes, s.tx_packets, s.rx_packets, s.recorded_at
        FROM wifi_station_snapshots s
        INNER JOIN (
          SELECT mac, MAX(id) AS max_id
          FROM wifi_station_snapshots
          GROUP BY mac
        ) latest ON latest.max_id = s.id
        ON DUPLICATE KEY UPDATE recorded_at = VALUES(recorded_at)
      `)

      await db.rawQuery(`
        INSERT INTO wifi_network_latest
          (ap_id, ifname, ssid, bssid, radio, channel, frequency_mhz, band, quality,
           signal_dbm, noise_dbm, bitrate_kbps, recorded_at)
        SELECT
          n.ap_id, n.ifname, n.ssid, n.bssid, n.radio, n.channel, n.frequency_mhz, n.band,
          n.quality, n.signal_dbm, n.noise_dbm, n.bitrate_kbps, n.recorded_at
        FROM wifi_network_snapshots n
        INNER JOIN (
          SELECT ap_id, ifname, MAX(id) AS max_id
          FROM wifi_network_snapshots
          GROUP BY ap_id, ifname
        ) latest ON latest.max_id = n.id
        ON DUPLICATE KEY UPDATE recorded_at = VALUES(recorded_at)
      `)

      await db.rawQuery(`
        INSERT INTO ap_system_latest
          (ap_id, load_1, load_5, load_15, mem_total, mem_available,
           conntrack_entries, conntrack_limit, uptime_seconds, recorded_at)
        SELECT
          s.ap_id, s.load_1, s.load_5, s.load_15, s.mem_total, s.mem_available,
          s.conntrack_entries, s.conntrack_limit, s.uptime_seconds, s.recorded_at
        FROM ap_system_snapshots s
        INNER JOIN (
          SELECT ap_id, MAX(id) AS max_id
          FROM ap_system_snapshots
          GROUP BY ap_id
        ) latest ON latest.max_id = s.id
        ON DUPLICATE KEY UPDATE recorded_at = VALUES(recorded_at)
      `)
    })
  }

  async down() {
    this.schema.dropTable('ap_system_latest')
    this.schema.dropTable('wifi_network_latest')
    this.schema.dropTable('wifi_station_latest')
  }
}
