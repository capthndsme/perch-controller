import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Boot-time registration of the collector named by COLLECTOR_URL (see
 * `#services/default_collector`). Web environment only, and a no-op unless
 * the variable is set, so development, tests and ace commands are untouched.
 *
 * The row it manages is marked `source = 'env'`, which is what keeps it from
 * yanking a collector that announced itself and was adopted by an admin.
 */
export default class DefaultCollectorProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() !== 'web') return
    const { default: env } = await import('#start/env')
    const baseUrl = env.get('COLLECTOR_URL')
    if (!baseUrl) return

    const { ensureDefaultCollector } = await import('#services/default_collector')
    const logger = await this.app.container.make('logger')
    try {
      const result = await ensureDefaultCollector({
        baseUrl,
        apiKey: env.get('COLLECTOR_API_KEY') ?? null,
      })
      if (result.action === 'created') {
        logger.info(
          { baseUrl, ok: result.ok, error: result.error },
          'default_collector: registered collector from COLLECTOR_URL'
        )
      } else if (result.action === 'updated') {
        logger.info(
          { baseUrl, previousBaseUrl: result.previousBaseUrl },
          'default_collector: updated collector address from COLLECTOR_URL'
        )
      }
    } catch (err) {
      logger.warn({ err, baseUrl }, 'default_collector: registration failed')
    }
  }
}
