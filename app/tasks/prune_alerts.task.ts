import { pruneAlerts } from '#services/alerts/retention'
import { getAlertsSettings } from '#services/alerts/settings'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Daily retention of the alerts tables (`app/services/alerts/retention.ts`,
 * Settings → Alerts `retention`). 03:55, after the 03:30, 03:45 and 03:50
 * sweeps.
 */
export default class PruneAlertsTask extends Task {
  static options: TaskOptions = {
    schedule: '0 55 3 * * *',
  }

  async run(): Promise<void> {
    try {
      const result = await pruneAlerts(await getAlertsSettings())
      if (Object.values(result).some((n) => n > 0)) {
        logger.info(result, 'prune_alerts: pruned alert history')
      }
    } catch (err) {
      logger.error({ err }, 'prune_alerts: sweep failed')
    }
  }
}
