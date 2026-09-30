import type { AlertTypeDef } from '#services/alerts/model'
import agentUpdates from './agent_updates.js'
import agents from './agents.js'
import gateway from './gateway.js'
import gatewaySync from './gateway_sync.js'
import network from './network.js'
import portal from './portal.js'
import system from './system.js'
import wan from './wan.js'
import wifi from './wifi.js'

/**
 * The alert catalogue (events.md §1.4): every type of every area, in this
 * order: the alerts area's own files, then the other areas' (wifi,
 * gateway-sync, agent-updates). A duplicate type name throws at boot (a
 * programming error, caught by the unit suite).
 */
export function buildCatalogue(lists: AlertTypeDef[][]): Map<string, AlertTypeDef> {
  const byType = new Map<string, AlertTypeDef>()
  for (const list of lists) {
    for (const def of list) {
      if (byType.has(def.type)) throw new Error(`alert type "${def.type}" is defined twice`)
      byType.set(def.type, def)
    }
  }
  return byType
}

const catalogue = buildCatalogue([
  agents,
  wan,
  gateway,
  network,
  portal,
  system,
  wifi,
  gatewaySync,
  agentUpdates,
])

/** Types added by tests (`_registerTestAlertType`); never in production. */
const testTypes = new Map<string, AlertTypeDef>()

export function getAlertType(type: string): AlertTypeDef | null {
  return testTypes.get(type) ?? catalogue.get(type) ?? null
}

/** Every type, in catalogue order. */
export function listAlertTypes(): AlertTypeDef[] {
  return [...catalogue.values(), ...testTypes.values()]
}

/** Tests only: add (or replace) a type for the duration of a test. */
export function _registerTestAlertType(def: AlertTypeDef): void {
  testTypes.set(def.type, def)
}

export function _clearTestAlertTypes(): void {
  testTypes.clear()
}
