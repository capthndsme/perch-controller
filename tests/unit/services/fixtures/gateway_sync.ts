import type { SectionState } from '#services/gateway_config/sync_engine'
import type { UciConfig, UciConfigSet } from '#services/gateway_config/types'
import { parseUci } from '#tests/helpers/uci'
import { readFileSync } from 'node:fs'

/**
 * Gateway-sync fixtures (docs/design/gateway-sync/domains.md 12): configs shaped
 * like the live gateway's, placeholders only, in `fixtures/gateway_sync/`.
 * Anonymous sections get the names `uci` gives them (`cfg<hex index>3837`), as
 * the agent reads them, so renames to `perch_<id>` show up in the ops.
 */
export type GatewaySyncFixture = 'firewall' | 'dhcp' | 'mwan3' | 'network' | 'firewall_zones'

export function gatewaySyncConfig(name: GatewaySyncFixture): UciConfig {
  const text = readFileSync(new URL(`./gateway_sync/${name}`, import.meta.url), 'utf8')
  // `firewall_zones` is a second firewall fixture (the live zones).
  const config = parseUci(text, name === 'firewall_zones' ? 'firewall' : name)
  for (const section of config.sections) {
    if (section.anonymous) section.name = `cfg${section.index.toString(16).padStart(2, '0')}3837`
  }
  return config
}

export function gatewaySyncSet(...names: GatewaySyncFixture[]): UciConfigSet {
  return Object.fromEntries(
    names.map((n) => gatewaySyncConfig(n)).map((config) => [config.name, config])
  )
}

/** A section of a fixture by its name. */
export function sectionNamed(config: UciConfig, name: string) {
  const found = config.sections.find((s) => s.name === name)
  if (!found) throw new Error(`no section ${name} in ${config.name}`)
  return found
}

/** Rows of one read as the caller persists them (the rows' state after the changes). */
export function rowsAfter(
  rows: SectionState[],
  changes: Array<{ perchId: string; after: SectionState | null }>
): SectionState[] {
  const out = rows.filter((r) => !changes.some((c) => c.perchId === r.perchId))
  for (const change of changes) if (change.after) out.push(change.after)
  return out
}
