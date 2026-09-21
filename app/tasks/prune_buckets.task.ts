import {
  nativeRetentionDaysFromEnv,
  pruneOldBuckets,
  retentionOptionsFromEnv,
} from '#services/bucket_retention'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Daily tiered retention sweep — see `bucket_retention` for the ladder.
 * Runs at 03:30 (a quiet hour for a home network). Pruning is batched inside
 * the service so it never holds a long lock against the 5 s poller.
 */
export default class PruneBucketsTask extends Task {
  static options: TaskOptions = {
    schedule: '0 30 3 * * *', // 03:30 every day (croner 6-field cron)
  }

  async run(): Promise<void> {
    const retentionDays = nativeRetentionDaysFromEnv()
    if (!retentionDays || retentionDays < 1) {
      logger.info(
        { retentionDays },
        'prune_buckets: retention disabled (BUCKET_RETENTION_DAYS < 1); skipping'
      )
      return
    }

    const options = retentionOptionsFromEnv()
    try {
      const result = await pruneOldBuckets(retentionDays, options)
      const total = result.tables.reduce((sum, t) => sum + t.deleted, 0)
      if (total > 0) {
        logger.info(
          { retentionDays, ...options, cutoff: result.cutoff, tables: result.tables },
          'prune_buckets: pruned rows past tiered retention'
        )
      }
    } catch (err) {
      logger.error({ err, retentionDays }, 'prune_buckets: retention sweep failed')
    }
  }
}
