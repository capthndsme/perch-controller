import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * 5-minute rollups of the three WiFi snapshot streams. The raw snapshot
 * tables now have a short retention (`WIFI_SNAPSHOT_RETENTION_DAYS`, default
 * 14 d) because they were the largest, fastest-growing, never-pruned tables
 * in the database (one row per station per AP per 5 s tick, forever). These
 * rollups keep the history the charts need — per-client signal, per-SSID
 * RF, per-AP load — at 1/60th the row count, for the same 2-year horizon the
 * traffic rollups have.
 *
 * Maintained by `rollup_maintainer` (recomputed every minute from the raw
 * rows still inside the lookback window). Signal/SNR are stored as weighted
 * averages (`avg_* × samples`) so a coarser read can re-average correctly.
 *
 * Grouping uses `TO_SECONDS()` arithmetic rather than `UNIX_TIMESTAMP()` so
 * the slot boundary is a pure calendar calculation, independent of the DB
 * session time zone (the stored timestamps are UTC wall times).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_station_buckets_5m', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.datetime('slot_start').notNullable()
      table.string('ifname', 32).nullable()
      table.string('ssid', 128).nullable()
      table.string('band', 8).nullable()
      table.float('avg_signal_dbm', 8, 2).nullable()
      table.smallint('min_signal_dbm').nullable()
      table.smallint('max_signal_dbm').nullable()
      table.float('avg_snr_db', 8, 2).nullable()
      table.integer('max_tx_rate_kbps').unsigned().nullable()
      table.integer('max_rx_rate_kbps').unsigned().nullable()
      table.integer('samples').unsigned().notNullable().defaultTo(0)
      table.integer('active_samples').unsigned().notNullable().defaultTo(0)
      table.timestamp('updated_at').notNullable()

      table.primary(['ap_id', 'mac', 'slot_start'])
      table.index(['mac', 'slot_start'], 'wifi_station_buckets_5m_mac_time_idx')
      table.index(['slot_start'], 'wifi_station_buckets_5m_time_idx')
    })

    this.schema.createTable('wifi_network_buckets_5m', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('ifname', 32).notNullable()
      table.datetime('slot_start').notNullable()
      table.string('ssid', 128).nullable()
      table.string('band', 8).nullable()
      table.float('avg_signal_dbm', 8, 2).nullable()
      table.float('avg_noise_dbm', 8, 2).nullable()
      table.float('avg_quality', 8, 2).nullable()
      table.integer('max_bitrate_kbps').unsigned().nullable()
      table.integer('samples').unsigned().notNullable().defaultTo(0)
      table.timestamp('updated_at').notNullable()

      table.primary(['ap_id', 'ifname', 'slot_start'])
      table.index(['slot_start'], 'wifi_network_buckets_5m_time_idx')
      table.index(['ssid', 'slot_start'], 'wifi_network_buckets_5m_ssid_time_idx')
    })

    this.schema.createTable('ap_system_buckets_5m', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.datetime('slot_start').notNullable()
      table.float('avg_load_1', 8, 2).nullable()
      table.float('avg_load_5', 8, 2).nullable()
      table.float('avg_load_15', 8, 2).nullable()
      table.bigInteger('max_mem_total').unsigned().nullable()
      table.bigInteger('max_mem_available').unsigned().nullable()
      table.integer('max_conntrack_entries').unsigned().nullable()
      table.integer('max_conntrack_limit').unsigned().nullable()
      table.integer('max_uptime_seconds').unsigned().nullable()
      table.integer('samples').unsigned().notNullable().defaultTo(0)
      table.timestamp('updated_at').notNullable()

      table.primary(['ap_id', 'slot_start'])
      table.index(['slot_start'], 'ap_system_buckets_5m_time_idx')
    })

    // One-time backfill over the full snapshot history. These are the same
    // statements `rollup_maintainer` runs every minute over a short lookback.
    this.defer(async (db) => {
      await db.rawQuery(`
        INSERT INTO wifi_station_buckets_5m
          (ap_id, mac, slot_start, ifname, ssid, band, avg_signal_dbm, min_signal_dbm,
           max_signal_dbm, avg_snr_db, max_tx_rate_kbps, max_rx_rate_kbps, samples,
           active_samples, updated_at)
        SELECT
          ap_id, mac,
          DATE_SUB(recorded_at, INTERVAL MOD(TO_SECONDS(recorded_at), 300) SECOND) AS slot_start,
          MAX(ifname), MAX(ssid), MAX(band),
          AVG(signal_dbm), MIN(signal_dbm), MAX(signal_dbm), AVG(snr_db),
          MAX(tx_rate_kbps), MAX(rx_rate_kbps), COUNT(*),
          SUM(CASE WHEN inactive_ms < 200000 THEN 1 ELSE 0 END), UTC_TIMESTAMP()
        FROM wifi_station_snapshots
        GROUP BY ap_id, mac, slot_start
        ON DUPLICATE KEY UPDATE samples = VALUES(samples), updated_at = VALUES(updated_at)
      `)

      await db.rawQuery(`
        INSERT INTO wifi_network_buckets_5m
          (ap_id, ifname, slot_start, ssid, band, avg_signal_dbm, avg_noise_dbm, avg_quality,
           max_bitrate_kbps, samples, updated_at)
        SELECT
          ap_id, ifname,
          DATE_SUB(recorded_at, INTERVAL MOD(TO_SECONDS(recorded_at), 300) SECOND) AS slot_start,
          MAX(ssid), MAX(band), AVG(signal_dbm), AVG(noise_dbm), AVG(quality),
          MAX(bitrate_kbps), COUNT(*), UTC_TIMESTAMP()
        FROM wifi_network_snapshots
        GROUP BY ap_id, ifname, slot_start
        ON DUPLICATE KEY UPDATE samples = VALUES(samples), updated_at = VALUES(updated_at)
      `)

      await db.rawQuery(`
        INSERT INTO ap_system_buckets_5m
          (ap_id, slot_start, avg_load_1, avg_load_5, avg_load_15, max_mem_total,
           max_mem_available, max_conntrack_entries, max_conntrack_limit, max_uptime_seconds,
           samples, updated_at)
        SELECT
          ap_id,
          DATE_SUB(recorded_at, INTERVAL MOD(TO_SECONDS(recorded_at), 300) SECOND) AS slot_start,
          AVG(load_1), AVG(load_5), AVG(load_15), MAX(mem_total), MAX(mem_available),
          MAX(conntrack_entries), MAX(conntrack_limit), MAX(uptime_seconds),
          COUNT(*), UTC_TIMESTAMP()
        FROM ap_system_snapshots
        GROUP BY ap_id, slot_start
        ON DUPLICATE KEY UPDATE samples = VALUES(samples), updated_at = VALUES(updated_at)
      `)
    })
  }

  async down() {
    this.schema.dropTable('ap_system_buckets_5m')
    this.schema.dropTable('wifi_network_buckets_5m')
    this.schema.dropTable('wifi_station_buckets_5m')
  }
}
