import { pruneWifiConfigHistory } from '#services/wifi_config/retention'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * The Wi-Fi plane's daily retention (docs/design/wifi controller.md section
 * 9): old events, revisions beyond `keepRevisions` per AP (the newest
 * confirmed one stays), old resolved divergences and finished rollouts, and
 * passphrases nothing references.
 */
export default class WifiConfigRetentionTask extends Task {
  static options: TaskOptions = {
    schedule: '0 40 3 * * *',
  }

  async run(): Promise<void> {
    try {
      const result = await pruneWifiConfigHistory(await getWifiConfigSettings())
      logger.info(result, 'wifi_config: retention pass')
    } catch (err) {
      logger.error({ err }, 'wifi_config: retention failed')
    }
  }
}
