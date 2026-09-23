import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Installs the QoS feature's writers on the config plane at boot
 * (docs/gateway/qos.md sections 2.4 and 6.3): WAN queue writes and the
 * `perch-qos` package go through `editSections` and an apply instead of the
 * stubs' `plane_unavailable`, and the plane's apply and read listeners feed
 * the QoS state. Web environment only (tests install them themselves).
 */
export default class QosPlaneProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() !== 'web') return
    const { installPlaneWriters } = await import('#services/qos_plane_writers')
    installPlaneWriters()
  }
}
