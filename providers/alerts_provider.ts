import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Starts the alerts area (docs/design/alerts/README.md §2.1): the engine
 * worker, the delivery worker, the VAPID keys and the controller lifecycle,
 * all through `app/services/alerts/boot.ts`. Web environment only, in
 * `ready()` like `agent_gateway_provider.ts`: single instance, in-process,
 * like the scheduler. The `terminating` hook writes the clean-shutdown marker
 * and drains the queues for at most 2 s.
 */
export default class AlertsProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() !== 'web') return
    const { bootAlerts, shutdownAlerts } = await import('#services/alerts/boot')
    await bootAlerts()
    this.app.terminating(async () => {
      await shutdownAlerts()
    })
  }
}
