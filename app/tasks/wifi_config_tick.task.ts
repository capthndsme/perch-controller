import { wifiConfigTick } from '#services/wifi_config/tick'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * The Wi-Fi plane's timers every 5 s (docs/design/wifi controller.md
 * section 4.3): queued jobs, confirm retries while an AP's health check
 * runs, confirm deadlines, Authoritative Mode's enforcement, re-renders and
 * the rollouts' next steps.
 */
export default class WifiConfigTickTask extends Task {
  static options: TaskOptions = {
    schedule: '*/5 * * * * *',
  }

  async run(): Promise<void> {
    try {
      await wifiConfigTick()
    } catch (err) {
      logger.error({ err }, 'wifi_config: tick failed')
    }
  }
}
