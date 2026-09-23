import { sweepQosSync } from '#services/qos_sync'
import { expireQosAssignments } from '#services/qos_writes'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Traffic shaping housekeeping every 30 s (docs/gateway/qos.md section 6.4):
 * deletes assignments expired longer than `expiredKeepMinutes`, then sweeps
 * every managed gateway: expired entries leave the device set, a delivery
 * that failed or found the agent inactive is retried, an online agent that
 * was never probed is probed.
 */
export default class QosExpireTask extends Task {
  static options: TaskOptions = {
    schedule: '*/30 * * * * *',
  }

  async run(): Promise<void> {
    try {
      const deleted = await expireQosAssignments()
      if (deleted.length > 0) {
        logger.info({ deleted }, 'qos_expire: removed expired assignments')
      }
      await sweepQosSync()
    } catch (err) {
      logger.error({ err }, 'qos_expire: sweep failed')
    }
  }
}
