import type { SyncedSection } from '#services/gateway_config/domain'
import { reconcileRead, type SectionState } from '#services/gateway_config/sync_engine'
import { apRegistry, type ApRegistryOptions } from '#services/wifi_config/domains/index'
import type { ApCapabilities, ApReadConfig } from '#services/wifi_config/types'
import {
  AX23_CAPS,
  LAB_AP_CAPS,
  RAX3000M_CAPS,
  WRX36_CAPS,
} from '#tests/unit/services/fixtures/wifi/capabilities'
import {
  AX23_CONFIGS,
  LAB_AP_CONFIGS,
  RAX3000M_CONFIGS,
  WRX36_CONFIGS,
} from '#tests/unit/services/fixtures/wifi/live_configs'

export const NOW = '2026-10-02T10:00:00.000Z'

export type FixtureAp = {
  id: number
  name: string
  caps: ApCapabilities
  configs: ApReadConfig[]
}

/** The three live APs (ids as their rows) and the lab AP. */
export const WRX36: FixtureAp = { id: 2, name: 'WRX36', caps: WRX36_CAPS, configs: WRX36_CONFIGS }
export const RAX3000M: FixtureAp = {
  id: 3,
  name: 'RAX3000M',
  caps: RAX3000M_CAPS,
  configs: RAX3000M_CONFIGS,
}
export const AX23: FixtureAp = { id: 4, name: 'AX23', caps: AX23_CAPS, configs: AX23_CONFIGS }
export const LAB_AP: FixtureAp = { id: 9, name: 'lab', caps: LAB_AP_CAPS, configs: LAB_AP_CONFIGS }

export const LIVE_APS = [WRX36, RAX3000M, AX23]
export const ALL_APS = [WRX36, RAX3000M, AX23, LAB_AP]

/** A deep copy of a fixture's configs (tests edit them). */
export function configsOf(ap: FixtureAp): ApReadConfig[] {
  return JSON.parse(JSON.stringify(ap.configs))
}

/** The rows a first read of the AP creates (observe mode), with stable perch ids. */
export function importAp(
  ap: FixtureAp,
  options: ApRegistryOptions & { configs?: ApReadConfig[] } = {}
) {
  const registry = apRegistry(ap.caps, options)
  let n = 0
  const result = reconcileRead({
    rows: [],
    read: { configs: options.configs ?? configsOf(ap), ledger: [] },
    registry,
    mode: 'observe',
    authoritative: false,
    now: NOW,
    newPerchId: () => `a${ap.id}p${++n}`,
  })
  const rows = result.changes.map((c) => c.after).filter((r): r is SectionState => r !== null)
  return { registry, rows, result }
}

/** A row's desired side as a domain sees it. */
export function desiredOf(rows: SectionState[]): Array<SyncedSection & { domain: string | null }> {
  return rows
    .filter((r) => r.scope === 'synced' && r.desired !== null)
    .map((r) => ({
      perchId: r.perchId,
      config: r.config,
      name: r.name,
      type: r.desired!.type,
      anonymous: r.anonymous,
      options: { ...r.desired!.options },
      ...(r.desired!.secrets ? { secrets: { ...r.desired!.secrets } } : {}),
      domain: r.domain,
    }))
}

/** Rows not managed by any domain (for validation's collision checks). */
export function unmanagedOf(rows: SectionState[]): SyncedSection[] {
  return rows
    .filter((r) => r.scope !== 'synced' && r.router !== null)
    .map((r) => ({
      perchId: r.perchId,
      config: r.config,
      name: r.name,
      type: r.router!.type,
      anonymous: r.anonymous,
      options: { ...r.router!.options },
    }))
}

export function rowNamed(rows: SectionState[], name: string, config = 'wireless'): SectionState {
  const row = rows.find((r) => r.name === name && r.config === config)
  if (!row) throw new Error(`no row ${config}.${name}`)
  return row
}
