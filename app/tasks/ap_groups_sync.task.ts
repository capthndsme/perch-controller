import { syncAllApGroups } from '#services/ap_groups'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Device groups on the access points (docs/gateway/device-groups.md
 * section 7), every two minutes: each connected agent's state is compared
 * with what it should hold, and a failed or missed apply is sent again.
 */
export default class ApGroupsSyncTask extends Task {
  static options: TaskOptions = {
    schedule: '0 */2 * * * *',
  }

  async run(): Promise<void> {
    try {
      await syncAllApGroups()
    } catch (err) {
      logger.error({ err }, 'ap_groups_sync: sweep failed')
    }
  }
}
