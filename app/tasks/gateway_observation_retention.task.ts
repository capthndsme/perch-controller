import { pruneGatewayObservations } from '#services/gateway_observation_retention'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Daily retention of the gateway observation channel
 * (`gateway_observation_retention.ts`; numbers in Settings → Gateway
 * observation). Runs at 03:50, after the bucket prune.
 */
export default class GatewayObservationRetentionTask extends Task {
  static options: TaskOptions = {
    schedule: '0 50 3 * * *', // 03:50 every day (croner 6-field cron)
  }

  async run(): Promise<void> {
    try {
      const result = await pruneGatewayObservations()
      const total = result.hosts + result.upnpMappings + result.upnpEvents + result.backups
      if (total > 0) {
        logger.info(result, 'gateway_observation_retention: pruned rows past retention')
      }
    } catch (err) {
      logger.error({ err }, 'gateway_observation_retention: sweep failed')
    }
  }
}
