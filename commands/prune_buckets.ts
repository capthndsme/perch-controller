import {
  nativeRetentionDaysFromEnv,
  pruneOldBuckets,
  retentionOptionsFromEnv,
} from '#services/bucket_retention'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace buckets:prune [--dry-run] [--native-days=N]`
 *
 * Runs the same tiered retention sweep the 03:30 scheduler task runs, on
 * demand. `--dry-run` only counts. Useful right after changing a retention
 * horizon, or to reclaim space without waiting for the nightly run.
 */
export default class PruneBuckets extends BaseCommand {
  static commandName = 'buckets:prune'
  static description = 'Delete bucket/snapshot rows past their tiered retention horizons'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Count rows that would be deleted without deleting' })
  declare dryRun: boolean

  @flags.number({ description: 'Override BUCKET_RETENTION_DAYS for this run' })
  declare nativeDays: number

  async run() {
    const retentionDays = this.nativeDays ?? nativeRetentionDaysFromEnv()
    const options = { ...retentionOptionsFromEnv(), dryRun: this.dryRun ?? false }

    this.logger.info(
      `${this.dryRun ? 'Counting' : 'Pruning'} rows older than the retention ladder (native ${retentionDays} d)`
    )
    const result = await pruneOldBuckets(retentionDays, options)

    const table = this.ui.table()
    table.head(['table', this.dryRun ? 'would delete' : 'deleted'])
    for (const row of result.tables) table.row([row.table, String(row.deleted)])
    table.render()

    const total = result.tables.reduce((sum, t) => sum + t.deleted, 0)
    this.logger.success(`${this.dryRun ? 'Would delete' : 'Deleted'} ${total} rows`)
  }
}
