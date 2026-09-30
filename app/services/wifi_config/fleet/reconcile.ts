import { entriesEqual, entriesOf } from '#services/gateway_config/canonical'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { RouterAuthor, UciValue } from '#services/gateway_config/types'
import { apRegistry } from '#services/wifi_config/domains/index'
import {
  IFACE_OWNED_OPTIONS,
  ifaceFields,
  securityNeedsKey,
  securityOfEncryption,
  WIFI_IFACES_DOMAIN,
} from '#services/wifi_config/domains/wifi_ifaces'
import { radioFields, WIFI_RADIOS_DOMAIN } from '#services/wifi_config/domains/wifi_radios'
import { scalarOf } from '#services/wifi_config/domains/normalize'
import {
  DEFAULT_ADVANCED,
  presentRadios,
  sortBands,
  type FleetAp,
} from '#services/wifi_config/fleet/model'
import { planSlots, type RenderInput, type SlotPlan } from '#services/wifi_config/fleet/render'
import type {
  ApFleetState,
  IfaceLink,
  OpenDivergence,
  WifiBand,
  WifiNetworkSpec,
} from '#services/wifi_config/types'

/**
 * Reconcile (docs/design/wifi controller.md section 5.3): after every merged
 * read, compare the AP's interface sections (C, after the merge) with what
 * the fleet renders for them, and link new router interfaces to networks.
 * Pure: the caller stores the link changes, the new networks and the
 * divergences, and re-renders.
 *
 * | Situation | Result |
 * |---|---|
 * | linked, C equals the slot render on every template-owned option | its open divergences close (`auto`) |
 * | linked, option o differs (a two-way import) | divergence `option` o (opened or refreshed) |
 * | linked slot, row gone | divergence `removed` |
 * | not linked, one network with the same SSID and security | linked; not in scope → divergence `added` |
 * | not linked, none | two-way (managed): a new network `origin: router` for this AP; observe: left for adoption |
 * | not linked, several | divergence `unassigned` |
 * | a present radio's country ≠ the AP's policy | divergence `country` |
 *
 * Authoritative Mode never reaches this table: router edits stay drift in
 * the core and C keeps the render. Observe mode imports every router value,
 * so differences show as divergences without any hold effect.
 */

export interface ReconcileInput extends Omit<RenderInput, 'holds'> {
  /** This AP's open divergences (to refresh or close). */
  open: OpenDivergence[]
  /** The key fingerprint each network's slots should carry (`expectedKeyFingerprints`). */
  expectedKeys?: Record<number, string | null>
  /** Who last changed each section on the AP, by perch id. */
  authors?: Record<string, RouterAuthor | null>
}

/** A network the AP created in LuCI (decision D6), to be stored with `origin: router`. */
export interface RouterNetwork {
  perchId: string
  radio: string
  band: WifiBand | null
  spec: Omit<WifiNetworkSpec, 'id' | 'revision'>
}

export interface ReconcileResult {
  links: { add: IfaceLink[]; remove: string[] }
  /** Two-way only: networks to create for new router SSIDs (then link `perchId` to each). */
  newNetworks: RouterNetwork[]
  /** Divergences to open (`id: null`) or refresh (`id` set, values changed). */
  open: OpenDivergence[]
  /** Open divergences that no longer hold: resolve with `auto`. */
  close: number[]
  /** Synced interfaces no network claims (observe: adoption proposals cover them). */
  unlinked: string[]
  fleetState: ApFleetState
}

/** Options the slot render sets, compared option by option. */
const TEMPLATE_OPTIONS = IFACE_OWNED_OPTIONS.filter((o) => o !== 'key')

type Key = string
function keyOf(
  d: Pick<OpenDivergence, 'kind' | 'perchId' | 'option' | 'radio' | 'networkId'>
): Key {
  return [d.kind, d.perchId ?? '', d.option ?? '', d.radio ?? '', d.networkId ?? ''].join('|')
}

function display(value: UciValue | undefined): unknown {
  return value === undefined ? null : value
}

/** The network the AP would carry a router interface in, when one matches by SSID and security. */
function matchNetworks(networks: WifiNetworkSpec[], row: SectionState): WifiNetworkSpec[] {
  const content = row.desired ?? row.router
  if (!content) return []
  const ssid = scalarOf(content.options, 'ssid')
  const security = securityOfEncryption(scalarOf(content.options, 'encryption'))
  return networks.filter((n) => n.ssid === ssid && n.security === security)
}

/** Reconcile one AP (see the module comment). */
export function reconcileAp(input: ReconcileInput): ReconcileResult {
  const { ap } = input
  const registry = apRegistry(ap.caps, { vlans: input.vlans, trunkOverride: input.trunkOverride })
  const rules = registry.rules(WIFI_IFACES_DOMAIN)
  const found = new Map<Key, OpenDivergence>()
  const add = (d: OpenDivergence) => found.set(keyOf(d), d)
  const result: ReconcileResult = {
    links: { add: [], remove: [] },
    newNetworks: [],
    open: [],
    close: [],
    unlinked: [],
    fleetState: 'unknown',
  }
  const author = (perchId: string | null) => (perchId ? (input.authors?.[perchId] ?? null) : null)
  const existingLinks = input.links.filter((l) => l.apId === ap.id)
  const rowsById = new Map(input.rows.map((r) => [r.perchId, r]))

  // 1. Router interfaces no link claims: link them by SSID and security.
  const known = new Set(existingLinks.map((l) => l.perchId))
  for (const row of input.rows) {
    if (row.scope !== 'synced' || row.domain !== WIFI_IFACES_DOMAIN || row.desired === null)
      continue
    if (known.has(row.perchId)) continue
    const fields = ifaceFields(row.desired.options)
    const radio = (ap.caps?.radios ?? []).find((r) => r.section === fields.radio) ?? null
    const matches = matchNetworks(input.networks, row)
    if (matches.length === 1) {
      result.links.add.push({
        apId: ap.id,
        perchId: row.perchId,
        networkId: matches[0].id,
        radio: fields.radio,
        origin: 'router',
      })
      continue
    }
    if (matches.length > 1) {
      add({
        id: null,
        apId: ap.id,
        networkId: null,
        perchId: row.perchId,
        radio: fields.radio,
        kind: 'unassigned',
        option: null,
        fleetValue: matches.map((n) => n.id),
        apValue: fields.ssid,
        routerAuthor: author(row.perchId),
      })
      continue
    }
    // Two-way (decision D6). Before the fleet has any network (adoption not
    // done yet) nothing is created: adoption proposals cover the AP instead.
    if (ap.mode === 'managed' && input.networks.length > 0) {
      const band = (radio?.band as WifiBand | null) ?? null
      result.newNetworks.push({
        perchId: row.perchId,
        radio: fields.radio,
        band,
        spec: {
          name: fields.ssid,
          ssid: fields.ssid,
          enabled: true,
          security: fields.security,
          passphraseRef: null,
          hidden: fields.hidden,
          isolate: fields.isolate,
          binding:
            ap.management.network !== null && fields.networks.join(' ') === ap.management.network
              ? { kind: 'lan' }
              : { kind: 'ap_network' },
          bands: band ? sortBands([band]) : [],
          apScope: 'selected',
          roaming: {
            ft: fields.ft,
            mobilityDomain: fields.mobilityDomain,
            rrm: fields.rrm,
            btm: fields.btm,
          },
          advanced: {
            ...DEFAULT_ADVANCED,
            pmf: fields.pmf,
            multicastToUnicast: fields.multicastToUnicast,
            maxClients: fields.maxClients,
            dtimPeriod: fields.dtimPeriod,
          },
          groups: false,
          origin: 'router',
        },
      })
      continue
    }
    result.unlinked.push(row.perchId)
  }

  // 2. The slots with every link, old and new.
  const links = [...existingLinks, ...result.links.add]
  const { slots } = planSlots({ ...input, links, holds: [] })
  const slotByPerch = new Map(
    slots.filter((s) => s.perchId !== null).map((s) => [s.perchId!, s] as [string, SlotPlan])
  )

  // 3. Linked slots whose row is gone on the AP; links of rows gone and not carried.
  for (const slot of slots) {
    if (slot.state !== 'missing') continue
    add({
      id: null,
      apId: ap.id,
      networkId: slot.networkId,
      perchId: slot.perchId,
      radio: slot.radio,
      kind: 'removed',
      option: null,
      fleetValue: null,
      apValue: null,
      routerAuthor: author(slot.perchId),
    })
  }
  for (const link of existingLinks) {
    const row = rowsById.get(link.perchId)
    if ((!row || row.desired === null) && !slotByPerch.has(link.perchId)) {
      result.links.remove.push(link.perchId)
    }
  }

  // 4. Linked rows against the slot render.
  for (const link of links) {
    const row = rowsById.get(link.perchId)
    if (!row || row.scope !== 'synced' || row.desired === null) continue
    const slot = slotByPerch.get(link.perchId)
    if (!slot) {
      if (link.networkId === null) continue
      add({
        id: null,
        apId: ap.id,
        networkId: link.networkId,
        perchId: link.perchId,
        radio: link.radio,
        kind: 'added',
        option: null,
        fleetValue: null,
        apValue: null,
        routerAuthor: author(link.perchId),
      })
      continue
    }
    if (!slot.target) continue
    const want = entriesOf(slot.target)
    const have = entriesOf(row.desired)
    for (const option of TEMPLATE_OPTIONS) {
      if (entriesEqual('wifi-iface', option, want.get(option), have.get(option), rules)) continue
      add({
        id: null,
        apId: ap.id,
        networkId: slot.networkId,
        perchId: link.perchId,
        radio: slot.radio,
        kind: 'option',
        option,
        fleetValue: display(slot.target.options[option]),
        apValue: display(row.desired.options[option]),
        routerAuthor: author(link.perchId),
      })
    }
    const network = input.networks.find((n) => n.id === slot.networkId)
    const expected =
      input.expectedKeys?.[slot.networkId] ?? slot.target.secrets?.key?.fingerprint ?? null
    const actual = row.desired.secrets?.key?.fingerprint ?? null
    if (network && securityNeedsKey(network.security) && expected !== null && expected !== actual) {
      add({
        id: null,
        apId: ap.id,
        networkId: slot.networkId,
        perchId: link.perchId,
        radio: slot.radio,
        kind: 'option',
        option: 'key',
        fleetValue: { fingerprint: expected },
        apValue: actual === null ? null : { fingerprint: actual },
        routerAuthor: author(link.perchId),
      })
    }
  }

  // Countries (decision D10).
  const code = ap.country.code
  if (ap.country.mode !== 'router' && ap.caps?.regulatory?.settable !== false && code !== null) {
    for (const radio of presentRadios(ap.caps)) {
      const row = input.rows.find(
        (r) =>
          r.config === 'wireless' &&
          r.name === radio.section &&
          r.scope === 'synced' &&
          r.domain === WIFI_RADIOS_DOMAIN
      )
      if (!row || row.desired === null) continue
      const country = radioFields(row.desired.options, radio.band).country
      if (country === code) continue
      add({
        id: null,
        apId: ap.id,
        networkId: null,
        perchId: row.perchId,
        radio: radio.section,
        kind: 'country',
        option: 'country',
        fleetValue: code,
        apValue: country,
        routerAuthor: author(row.perchId),
      })
    }
  }

  // Open, refresh, close.
  const openByKey = new Map(input.open.filter((d) => d.apId === ap.id).map((d) => [keyOf(d), d]))
  for (const [key, d] of found) {
    const existing = openByKey.get(key)
    if (!existing) {
      result.open.push(d)
      continue
    }
    if (
      JSON.stringify([existing.fleetValue, existing.apValue]) !==
      JSON.stringify([d.fleetValue, d.apValue])
    ) {
      result.open.push({
        ...d,
        id: existing.id,
        routerAuthor: d.routerAuthor ?? existing.routerAuthor,
      })
    }
  }
  for (const [key, d] of openByKey) {
    if (!found.has(key) && d.id !== null) result.close.push(d.id)
  }

  result.fleetState = fleetStateOf({
    mode: ap.mode,
    openDivergences: found.size,
    unlinked: result.unlinked.length + result.newNetworks.length,
    rows: input.rows.filter(
      (r) =>
        (r.domain === WIFI_IFACES_DOMAIN && links.some((l) => l.perchId === r.perchId)) ||
        (r.domain === WIFI_RADIOS_DOMAIN && r.scope === 'synced')
    ),
  })
  return result
}

/**
 * `ap_configs.fleet_state`: `unknown` (mode off), `diverged` (open
 * divergences), `unassigned` (interfaces no network claims), `behind`
 * (the fleet's version is not on the AP yet: a linked section ahead or in
 * flight), else `in_line`.
 */
export function fleetStateOf(input: {
  mode: FleetAp['mode']
  openDivergences: number
  unlinked: number
  rows: Array<Pick<SectionState, 'status'>>
}): ApFleetState {
  if (input.mode === 'off') return 'unknown'
  if (input.openDivergences > 0) return 'diverged'
  if (input.unlinked > 0) return 'unassigned'
  if (input.rows.some((r) => r.status !== 'in_sync')) return 'behind'
  return 'in_line'
}
