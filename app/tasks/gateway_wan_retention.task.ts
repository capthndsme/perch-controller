import { pruneWanTransitions } from '#services/gateway_config/gateway_wan_transitions'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Daily retention of the WAN transitions (gateway sync README 7:
 * `gateway_wan_transitions` older than Settings → Gateway sync
 * `transitionRetentionDays`). Runs at 03:55, after the observation sweep.
 */
export default class GatewayWanRetentionTask extends Task {
  static options: TaskOptions = {
    schedule: '0 55 3 * * *', // 03:55 every day (croner 6-field cron)
  }

  async run(): Promise<void> {
    try {
      const pruned = await pruneWanTransitions()
      if (pruned > 0) logger.info({ pruned }, 'gateway_wan_retention: pruned WAN transitions')
    } catch (err) {
      logger.error({ err }, 'gateway_wan_retention: sweep failed')
    }
  }
}
