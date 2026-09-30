import type { SectionState } from '#services/gateway_config/sync_engine'
import {
  planAdoption,
  proposeAdoption,
  type AdoptionAp,
  type AdoptionRequestItem,
} from '#services/wifi_config/fleet/adoption'
import type { FleetAp } from '#services/wifi_config/fleet/model'
import type {
  ApMode,
  ApReadConfig,
  CountryMode,
  IfaceLink,
  WifiNetworkApSpec,
  WifiNetworkSpec,
} from '#services/wifi_config/types'
import { importAp, LIVE_APS, type FixtureAp } from '#tests/unit/services/fixtures/wifi/helpers'

/** The three live APs as the fleet sees them, with rows from a first read. */
export function fleetAps(
  options: {
    mode?: ApMode
    configs?: Record<number, ApReadConfig[]>
    country?: { mode: CountryMode; code: string | null }
    aps?: FixtureAp[]
  } = {}
): Array<{ fixture: FixtureAp; fleet: FleetAp; rows: SectionState[] }> {
  const mode = options.mode ?? 'observe'
  return (options.aps ?? LIVE_APS).map((fixture) => ({
    fixture,
    fleet: {
      id: fixture.id,
      name: fixture.name,
      mode,
      managed: mode === 'managed',
      caps: fixture.caps,
      management: { network: fixture.caps.management?.network ?? null },
      country: options.country ?? { mode: 'router', code: null },
    },
    rows: importAp(fixture, { configs: options.configs?.[fixture.id] }).rows,
  }))
}

export function adoptionInput(
  aps: ReturnType<typeof fleetAps>,
  links: IfaceLink[] = [],
  timeZone: string | null = 'Asia/Manila'
) {
  return {
    aps: aps.map(
      (a): AdoptionAp => ({
        id: a.fleet.id,
        name: a.fleet.name,
        mode: a.fleet.mode,
        caps: a.fleet.caps,
        management: a.fleet.management,
        rows: a.rows,
      })
    ),
    links,
    timeZone,
  }
}

/** Accepts proposals (all but the ones named in `exclude`) and numbers the networks from 1. */
export function adopt(
  aps: ReturnType<typeof fleetAps>,
  items?: (keys: Array<{ key: string; name: string }>) => AdoptionRequestItem[]
): { networks: WifiNetworkSpec[]; memberships: WifiNetworkApSpec[]; links: IfaceLink[] } {
  const input = adoptionInput(aps)
  const proposals = proposeAdoption(input).proposals
  const request = items
    ? items(proposals.map((p) => ({ key: p.key, name: p.name })))
    : proposals.map((p) => ({ key: p.key, exclude: p.exclude }))
  const plan = planAdoption(input, request)
  if (!plan.ok) throw new Error(`adoption refused: ${plan.error}`)
  const networks: WifiNetworkSpec[] = []
  const memberships: WifiNetworkApSpec[] = []
  const links: IfaceLink[] = []
  // Left-out proposals become router-only sections (their scope `excluded`).
  for (const { apId, perchId } of plan.excluded) {
    const row = aps.find((a) => a.fleet.id === apId)?.rows.find((r) => r.perchId === perchId)
    if (row) row.scope = 'excluded'
  }
  plan.networks.forEach((n, i) => {
    const id = i + 1
    networks.push({ ...n.spec, id, revision: 1 })
    memberships.push(...n.memberships.map((m) => ({ ...m, networkId: id })))
    links.push(...n.links.map((l) => ({ ...l, networkId: id })))
  })
  return { networks, memberships, links }
}
