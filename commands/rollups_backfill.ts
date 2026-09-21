import { backfillRollups, ROLLUP_SPECS } from '#services/rollup_maintainer'
import { rebuildWifiLatestTables } from '#services/wifi_bucket_writer'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { DateTime } from 'luxon'

/**
 * `node ace rollups:backfill --since=<ISO> [--until=<ISO>] [--only=<spec name>]`
 * `node ace rollups:backfill --wifi-latest`
 *
 * Rebuilds the rollup tiers over an arbitrary window from the tier below
 * (repair after an outage, after changing a spec, or after a manual import).
 * Specs run in ladder order so each chained tier sees its rebuilt source.
 * `--wifi-latest` rebuilds the three WiFi "latest" tables from the snapshots.
 */
export default class RollupsBackfill extends BaseCommand {
  static commandName = 'rollups:backfill'
  static description = 'Rebuild rollup tiers (or the WiFi latest tables) over a time window'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Window start (ISO-8601, UTC)' })
  declare since: string

  @flags.string({ description: 'Window end (ISO-8601, UTC); defaults to now' })
  declare until: string

  @flags.string({ description: 'Only run the spec with this name (e.g. traffic:native→5m)' })
  declare only: string

  @flags.boolean({
    description: 'Rebuild wifi_station_latest / wifi_network_latest / ap_system_latest',
  })
  declare wifiLatest: boolean

  async run() {
    if (this.wifiLatest) {
      await rebuildWifiLatestTables()
      this.logger.success('Rebuilt the WiFi latest tables from the snapshot history')
      if (!this.since) return
    }

    if (!this.since) {
      this.logger.error('--since is required (ISO-8601), e.g. --since=2026-06-01T00:00:00Z')
      this.exitCode = 1
      return
    }
    const since = DateTime.fromISO(this.since, { zone: 'utc' })
    const until = this.until ? DateTime.fromISO(this.until, { zone: 'utc' }) : DateTime.utc()
    if (!since.isValid || !until.isValid || until <= since) {
      this.logger.error('Invalid window: --since must be a valid ISO timestamp before --until')
      this.exitCode = 1
      return
    }

    const specs = this.only ? ROLLUP_SPECS.filter((s) => s.name === this.only) : ROLLUP_SPECS
    if (specs.length === 0) {
      this.logger.error(
        `No spec named "${this.only}". Known: ${ROLLUP_SPECS.map((s) => s.name).join(', ')}`
      )
      this.exitCode = 1
      return
    }

    this.logger.info(
      `Backfilling ${specs.length} spec(s) from ${since.toISO()} to ${until.toISO()}`
    )
    const results = await backfillRollups(since, until, specs)
    const table = this.ui.table()
    table.head(['spec', 'affected rows'])
    for (const r of results) table.row([r.name, String(r.affected)])
    table.render()
    this.logger.success('Backfill complete')
  }
}
