import { applyDatabaseTuning } from '#services/db_tuning'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Re-applies the runtime MariaDB tuning (see `db_tuning`) every 15 minutes.
 * The boot-time application lives in `providers/api_provider.ts`; this task
 * only matters after a MariaDB restart while the app keeps running.
 */
export default class TuneDatabaseTask extends Task {
  static options: TaskOptions = {
    schedule: '0 */15 * * * *',
  }

  async run(): Promise<void> {
    try {
      await applyDatabaseTuning()
    } catch (err) {
      logger.warn({ err }, 'tune_database: tuning pass failed')
    }
  }
}
