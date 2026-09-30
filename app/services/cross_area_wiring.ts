import { deviceUpdateInFlight } from '#services/agent_updates/state'
import { setCollectorUpdateHold } from '#services/gateway_config/apply_lifecycle'
import { installWifiAlerts } from '#services/wifi_config/alerts'
import { setDeviceUpdateHold } from '#services/wifi_config/registry'

/**
 * The seams between the four 2026-09-30 areas (docs/design/BUILD-PLAN,
 * agreements 4 and 5), installed once at boot:
 * - the Wi-Fi plane and the gateway apply queue hold their sends to a device
 *   while agent-updates updates it (`deviceUpdateInFlight`);
 * - the Wi-Fi plane's events go to the alerts area (S9).
 * Agent updates call the alerts area directly (events and the maintenance
 * window), and gateway sync emits its own alert events.
 */
export function installCrossAreaWiring(): void {
  setDeviceUpdateHold((kind, id) => deviceUpdateInFlight(kind, id))
  setCollectorUpdateHold((collectorId) => deviceUpdateInFlight('collector', collectorId))
  installWifiAlerts()
}
