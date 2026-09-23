import { prunePortalHistory } from '#services/portal_retention'
import { getPortalSettings } from '#services/portal_settings'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Daily retention sweep of guest portal history (sessions, ended grants,
 * portal events) past Settings → Guest portal → `sessionRetentionDays`.
 * 03:45, after the bucket sweep.
 */
export default class PrunePortalHistoryTask extends Task {
  static options: TaskOptions = {
    schedule: '0 45 3 * * *',
  }

  async run(): Promise<void> {
    try {
      const { sessionRetentionDays } = await getPortalSettings()
      const result = await prunePortalHistory(sessionRetentionDays)
      if (
        result.sessions +
          result.grants +
          result.events +
          result.authorizations +
          result.checkoutsAnonymized >
        0
      ) {
        logger.info(
          { sessionRetentionDays, ...result },
          'prune_portal_history: pruned guest history'
        )
      }
    } catch (err) {
      logger.error({ err }, 'prune_portal_history: sweep failed')
    }
  }
}
