import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Pre-aggregated distinct active-client counts per time slot, for the WiFi
 * "Client distribution" graph (`wifi_controller.clientsHistory`). Reading the
 * raw `wifi_station_snapshots` (5.4M rows) per request and doing
 * `COUNT(DISTINCT mac)` grouped on a derived `FROM_UNIXTIME(FLOOR())` was
 * 15 s @24h / 38 s @7d.
 *
 * `COUNT(DISTINCT)` is NOT additive across time buckets (a client seen in three
 * 5-min slots is one distinct client in the hour, not three), so this stores
 * the **exact** distinct count per offered grain independently — keyed by
 * `grain_seconds` (60 / 300 / 900 / 3600 = 1m / 5m / 15m / 1h). Maintained by
 * `recompute_client_distribution.task` + `#services/client_distribution_rollup`;
 * the read selects one grain's rows as a bare indexed range scan. Fine grains
 * (5s/15s, only used over short windows) stay on the raw query.
 *
 * `band` is nullable on the source; stored as '' here so it can sit in the PK.
 */
export default class extends BaseSchema {
  protected tableName = 'wifi_client_distribution'

  private grains = [60, 300, 900, 3600]
  private inactiveMs = 200000

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.integer('grain_seconds').unsigned().notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('band', 8).notNullable().defaultTo('')
      table.datetime('slot_start').notNullable()
      table.integer('client_count').unsigned().notNullable().defaultTo(0)
      table.timestamp('updated_at').notNullable()

      table.primary(['grain_seconds', 'ap_id', 'band', 'slot_start'])
      table.index(['grain_seconds', 'slot_start'], 'wifi_client_distribution_grain_time_idx')
    })

    this.defer(async (db) => {
      for (const grain of this.grains) {
        await db.rawQuery(
          `
          INSERT INTO wifi_client_distribution
            (grain_seconds, ap_id, band, slot_start, client_count, updated_at)
          SELECT
            ?, s.ap_id, COALESCE(s.band, ''),
            FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(s.recorded_at) / ?) * ?) AS slot_start,
            COUNT(DISTINCT s.mac), UTC_TIMESTAMP()
          FROM wifi_station_snapshots s
          WHERE s.inactive_ms < ?
          GROUP BY s.ap_id, COALESCE(s.band, ''), slot_start
          ON DUPLICATE KEY UPDATE
            client_count = VALUES(client_count), updated_at = VALUES(updated_at)
        `,
          [grain, grain, grain, this.inactiveMs]
        )
      }
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
