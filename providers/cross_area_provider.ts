import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Installs the seams between the Wi-Fi plane, gateway sync, agent updates
 * and alerts (`app/services/cross_area_wiring.ts`). Web environment only, in
 * `ready()` like the QoS plane's writers (tests install what they need).
 */
export default class CrossAreaProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() !== 'web') return
    const { installCrossAreaWiring } = await import('#services/cross_area_wiring')
    installCrossAreaWiring()
  }
}
