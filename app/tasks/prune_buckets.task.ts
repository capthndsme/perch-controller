import {
  nativeRetentionDaysFromEnv,
  pruneOldBuckets,
  retentionOptionsFromEnv,
} from '#services/bucket_retention'
import { pruneGatewayConfigHistory } from '#services/gateway_config/config_retention'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
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
    await this.pruneGatewayConfig()

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

  /**
   * The managed gateway's audit log and revisions (settings `auditRetentionDays`,
   * `keepRevisions`). Independent of BUCKET_RETENTION_DAYS: it runs even when
   * the bucket ladder is switched off.
   */
  private async pruneGatewayConfig(): Promise<void> {
    try {
      const result = await pruneGatewayConfigHistory(await getGatewayConfigSettings())
      if (result.events > 0 || result.revisions > 0) {
        logger.info(result, 'prune_buckets: pruned gateway config history')
      }
    } catch (err) {
      logger.error({ err }, 'prune_buckets: gateway config history sweep failed')
    }
  }
}
