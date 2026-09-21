import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Network-wide distinct active-client count per slot, alongside the per-AP /
 * per-band `wifi_client_distribution`. Summing the per-AP counts overcounts a
 * client that roamed between APs inside one slot, so the "peak clients" tiles
 * (today / 7 d / all time) read this exact global series instead. Maintained
 * by the same `recompute_client_distribution` task.
 *
 * The all-time peak is kept in `system_settings` (`wifi_peak_clients_all_time`)
 * and bumped by the recompute task, so it never needs a history scan at read
 * time. It is seeded here from the backfilled series.
 */
export default class extends BaseSchema {
  protected tableName = 'wifi_client_totals'

  private grains = [60, 300, 900, 3600]
  private inactiveMs = 200000

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.integer('grain_seconds').unsigned().notNullable()
      table.datetime('slot_start').notNullable()
      table.integer('client_count').unsigned().notNullable().defaultTo(0)
      table.timestamp('updated_at').notNullable()

      table.primary(['grain_seconds', 'slot_start'])
    })

    this.defer(async (db) => {
      for (const grain of this.grains) {
        await db.rawQuery(
          `
          INSERT INTO wifi_client_totals (grain_seconds, slot_start, client_count, updated_at)
          SELECT
            ?,
            DATE_SUB(recorded_at, INTERVAL MOD(TO_SECONDS(recorded_at), ?) SECOND) AS slot_start,
            COUNT(DISTINCT mac), UTC_TIMESTAMP()
          FROM wifi_station_snapshots
          WHERE inactive_ms < ?
          GROUP BY slot_start
          ON DUPLICATE KEY UPDATE
            client_count = VALUES(client_count), updated_at = VALUES(updated_at)
        `,
          [grain, grain, this.inactiveMs]
        )
      }

      const peak = await db.rawQuery(
        `SELECT client_count AS count, slot_start AS slotStart
         FROM wifi_client_totals WHERE grain_seconds = 300
         ORDER BY client_count DESC, slot_start DESC LIMIT 1`
      )
      const row = (Array.isArray(peak) ? peak[0]?.[0] : null) as
        | { count: number; slotStart: Date | string }
        | null
        | undefined
      if (row) {
        const slotStart =
          row.slotStart instanceof Date ? row.slotStart.toISOString() : String(row.slotStart)
        await db.rawQuery(
          `INSERT INTO system_settings (\`key\`, value, updated_at)
           VALUES (?, ?, UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
          ['wifi_peak_clients_all_time', JSON.stringify({ count: Number(row.count), slotStart })]
        )
      }
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
