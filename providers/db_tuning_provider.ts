import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Applies the runtime MariaDB tuning (`#services/db_tuning`) once the HTTP
 * server is up, so a fresh boot after a MariaDB restart gets the right
 * buffer pool without waiting for the 15-minute task. Registered for the
 * `web` environment only — ace commands and tests never touch it.
 */
export default class DbTuningProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() !== 'web') return
    // Providers are loaded before the container is booted, so app code that
    // touches `db`/`env` services must be imported lazily here (the one
    // provider-level exception to the no-await-import rule).
    const { applyDatabaseTuning } = await import('#services/db_tuning')
    const logger = await this.app.container.make('logger')
    try {
      const result = await applyDatabaseTuning()
      logger.info({ result }, 'db_tuning: boot-time tuning applied')
    } catch (err) {
      logger.warn({ err }, 'db_tuning: boot-time tuning failed')
    }
  }
}
