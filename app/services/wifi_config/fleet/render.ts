import { contentsEqual } from '#services/gateway_config/canonical'
import type { SecretEdit, SectionEdit, SyncedSection } from '#services/gateway_config/domain'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { SecretSlot, SectionContent, UciOptions } from '#services/gateway_config/types'
import {
  AP_VLANS_DOMAIN,
  planVlanPlumbing,
  trunkOf,
  type NetworkRow,
} from '#services/wifi_config/domains/ap_vlans'
import { apRegistry } from '#services/wifi_config/domains/index'
import {
  ifaceFields,
  ifaceOptions,
  securityNeedsKey,
  WIFI_IFACES_DOMAIN,
  type IfaceObject,
} from '#services/wifi_config/domains/wifi_ifaces'
import { radioFields, WIFI_RADIOS_DOMAIN } from '#services/wifi_config/domains/wifi_radios'
import { withOptions } from '#services/wifi_config/domains/normalize'
import {
  canonicalJson,
  carries,
  effectiveMobilityDomain,
  presentRadios,
  sha256Hex,
  slotRadios,
  slotSectionName,
  type FleetAp,
  type FleetIssue,
} from '#services/wifi_config/fleet/model'
import { supportsSecurity } from '#services/wifi_config/fleet/security'
import type {
  ApRadioCaps,
  IfaceLink,
  OpenDivergence,
  WifiBand,
  WifiNetworkApSpec,
  WifiNetworkSpec,
} from '#services/wifi_config/types'

/**
 * Render (docs/design/wifi controller.md section 5.2): the fleet's networks
 * turned into one AP's desired sections. Pure: the caller (the Wi-Fi plane,
 * S2) writes the edits through the core's `editSections` path inside the
 * AP's queue, creates link rows for the slots it created (matched by
 * section name), and stores `fingerprint` as `ap_configs.render_fingerprint`.
 *
 * - One `wifi-iface` per carried network × radio slot; created slots are
 *   named `perch_n<networkId>_<radio>`; slots no longer carried are deleted.
 * - Only template-owned options are set; router-owned options and every
 *   unchanged spelling are kept (a render never churns).
 * - An open divergence holds its option (or the whole slot for `removed`,
 *   `added` and `unassigned`) at the AP's current value (decision D5).
 * - Radios: only the country follows the fleet (decision D10).
 * - VLAN-bound networks get their plumbing through `planVlanPlumbing`
 *   (phase 3, `vlans: true`).
 */

export interface RenderInput {
  ap: FleetAp
  networks: WifiNetworkSpec[]
  /** Memberships of any AP (this AP's are used). */
  memberships: WifiNetworkApSpec[]
  /** Links of any AP (this AP's are used). */
  links: IfaceLink[]
  /** This AP's section rows (C is the current desired state). */
  rows: SectionState[]
  /** This AP's open divergences. */
  holds: OpenDivergence[]
  /** Known passphrases by ref, with their unbound fingerprints. */
  secrets: Record<string, { fingerprint: string }>
  /** `ap_vlans` is registered for this AP (phase 3). */
  vlans?: boolean
  trunkOverride?: string | null
}

export type SlotState =
  /** Linked to an existing row. */
  | 'linked'
  /** No row yet: rendered as a new section. */
  | 'create'
  /** Linked, but the row is gone on the AP (a `removed` divergence decides). */
  | 'missing'
  /** Held by an open slot-level divergence. */
  | 'held'
  /** Cannot be rendered (see `issues`). */
  | 'blocked'

export interface SlotPlan {
  networkId: number
  radio: string
  band: WifiBand | null
  perchId: string | null
  section: string
  state: SlotState
  /** The slot as the fleet wants it (before holds), null when not renderable. */
  target: SectionContent | null
  issues: FleetIssue[]
}

export interface DomainEdits {
  domain: string
  edits: SectionEdit[]
}

export interface RenderResult {
  /** Per domain, in apply order (`ap_vlans` first: the VLAN before the SSID on it). */
  edits: DomainEdits[]
  slots: SlotPlan[]
  issues: FleetIssue[]
  fingerprint: string
}

/** A synced row's desired side as a domain section, or null. */
export function syncedSection(row: SectionState): SyncedSection | null {
  if (row.scope !== 'synced' || row.desired === null) return null
  return {
    perchId: row.perchId,
    config: row.config,
    name: row.name,
    type: row.desired.type,
    anonymous: row.anonymous,
    options: { ...row.desired.options },
    ...(row.desired.secrets ? { secrets: { ...row.desired.secrets } } : {}),
  }
}

/** The `network` value of a slot, or null with the reason. */
export function bindingNetwork(
  network: WifiNetworkSpec,
  membership: WifiNetworkApSpec | null,
  ap: FleetAp,
  vlanNetworkFor: Record<number, string>
): { network: string } | { issue: FleetIssue } {
  const where = { networkId: network.id, apId: ap.id }
  if (network.binding.kind === 'lan') {
    return ap.management.network
      ? { network: ap.management.network }
      : {
          issue: {
            severity: 'error',
            code: 'lan_unknown',
            message: `${ap.name} reaches the controller through a device no network names`,
            ...where,
          },
        }
  }
  if (network.binding.kind === 'ap_network') {
    const name = membership?.overrides.apNetwork
    return name
      ? { network: name }
      : {
          issue: {
            severity: 'error',
            code: 'ap_network_unknown',
            message: `No network is set for ${network.name} on ${ap.name}`,
            ...where,
          },
        }
  }
  const name = vlanNetworkFor[network.binding.vlanId]
  return name
    ? { network: name }
    : {
        issue: {
          severity: 'error',
          code: 'vlan_unsupported',
          message: `VLAN ${network.binding.vlanId} cannot be carried by ${ap.name}`,
          ...where,
        },
      }
}

/**
 * The interface object a slot should be (controller.md 5.2 step 3), built
 * on the current section (its router-owned options and spellings), or the
 * refusal. `key` is `{ref, fingerprint}` for a known passphrase, `{keep}`
 * for an existing slot of an unknown one (or `keepKey`), null for open/OWE.
 */
export function slotObject(input: {
  network: WifiNetworkSpec
  membership: WifiNetworkApSpec | null
  ap: FleetAp
  radio: ApRadioCaps
  current: SyncedSection | null
  section: string
  networkName: string
  secrets: Record<string, { fingerprint: string }>
}): { obj: IfaceObject; issues: FleetIssue[] } | { obj: null; issues: FleetIssue[] } {
  const { network, membership, ap, radio, current } = input
  const ov = membership?.overrides ?? {}
  const base = current ? ifaceFields(current.options) : ifaceFields({})
  const where = { networkId: network.id, apId: ap.id, radio: radio.section }
  let key: SecretEdit | null = null
  if (securityNeedsKey(network.security)) {
    const known = network.passphraseRef ? input.secrets[network.passphraseRef] : undefined
    const hasKey = Boolean(current?.secrets?.key)
    if (known && !ov.keepKey) key = { ref: network.passphraseRef!, fingerprint: known.fingerprint }
    else if (hasKey) key = { keep: true }
    else {
      return {
        obj: null,
        issues: [
          {
            severity: 'error',
            code: 'passphrase_unknown',
            message: `${network.name} needs its passphrase before it can go to ${ap.name} (${radio.section})`,
            ...where,
          },
        ],
      }
    }
  }
  const ft = network.roaming.ft
  const enabled =
    network.enabled &&
    (ov.enabled ?? true) &&
    (membership?.radioOverrides[radio.section]?.enabled ?? true)
  const obj: IfaceObject = {
    ...base,
    perchId: current?.perchId ?? null,
    section: current?.name ?? input.section,
    radio: radio.section,
    ssid: network.ssid,
    security: network.security,
    hidden: ov.hidden ?? network.hidden,
    isolate: ov.isolate ?? network.isolate,
    networks: [input.networkName],
    enabled,
    ft,
    mobilityDomain: ft ? effectiveMobilityDomain(network) : network.roaming.mobilityDomain,
    ftOverDs: ft ? false : base.ftOverDs,
    ftPskGenerateLocal: ft && network.security === 'wpa2' ? true : base.ftPskGenerateLocal,
    rrm: network.roaming.rrm,
    btm: network.roaming.btm,
    pmf: network.advanced.pmf,
    multicastToUnicast: network.advanced.multicastToUnicast,
    maxClients: ov.maxClients ?? network.advanced.maxClients,
    dtimPeriod: ov.dtimPeriod ?? network.advanced.dtimPeriod,
    key,
    options: current ? withOptions(current.options, {}) : {},
    secretNames: Object.keys(current?.secrets ?? {}).filter((n) => n !== 'key'),
  }
  return { obj, issues: [] }
}

/** The content an interface object stands for (secrets as slots). */
export function objectContent(obj: IfaceObject, current: SyncedSection | null): SectionContent {
  const secrets: Record<string, SecretSlot> = {}
  if (obj.key && 'ref' in obj.key)
    secrets.key = { ref: obj.key.ref, fingerprint: obj.key.fingerprint }
  else if (obj.key && current?.secrets?.key) secrets.key = { ...current.secrets.key }
  for (const name of obj.secretNames) {
    if (current?.secrets?.[name]) secrets[name] = { ...current.secrets[name] }
  }
  const options = ifaceOptions(obj)
  return Object.keys(secrets).length > 0
    ? { type: 'wifi-iface', options, secrets }
    : { type: 'wifi-iface', options }
}

/** A put that sets `content` on a section (secrets as refs or keeps). */
function putOf(
  perchId: string | null,
  name: string,
  content: SectionContent,
  current: SyncedSection | null
): SectionEdit {
  const secrets: Record<string, SecretEdit> = {}
  for (const [option, slot] of Object.entries(content.secrets ?? {})) {
    if (slot.ref) secrets[option] = { ref: slot.ref, fingerprint: slot.fingerprint }
    else if (current?.secrets?.[option]) secrets[option] = { keep: true }
  }
  return {
    op: 'put',
    perchId,
    config: 'wireless',
    type: content.type,
    ...(perchId === null ? { name } : {}),
    options: content.options,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  }
}

/** Applies option holds: a held option keeps the section's current value. */
function applyHolds(
  target: SectionContent,
  current: SyncedSection,
  held: string[]
): SectionContent {
  if (held.length === 0) return target
  const options: UciOptions = { ...target.options }
  const secrets: Record<string, SecretSlot> = { ...(target.secrets ?? {}) }
  for (const option of held) {
    if (current.secrets?.[option] || target.secrets?.[option]) {
      if (current.secrets?.[option]) secrets[option] = { ...current.secrets[option] }
      else delete secrets[option]
      continue
    }
    const value = current.options[option]
    if (value === undefined) delete options[option]
    else options[option] = Array.isArray(value) ? [...value] : value
  }
  return Object.keys(secrets).length > 0
    ? { type: target.type, options, secrets }
    : { type: target.type, options }
}

function sameSecretRefs(a: SectionContent | null, b: SectionContent | null): boolean {
  const refs = (c: SectionContent | null) =>
    JSON.stringify(
      Object.entries(c?.secrets ?? {})
        .map(([k, v]) => [k, v.ref ?? null])
        .sort()
    )
  return refs(a) === refs(b)
}

/**
 * Every slot of the AP (controller.md 5.2 steps 1–3), matched to its link
 * and row, without holds. Used by `renderAp` and by reconcile (which
 * compares the AP's sections with these targets).
 */
export function planSlots(
  input: RenderInput,
  vlanNetworkFor: Record<number, string> = {}
): {
  slots: SlotPlan[]
  issues: FleetIssue[]
} {
  const { ap } = input
  const rowsById = new Map(input.rows.map((r) => [r.perchId, r]))
  const links = input.links.filter((l) => l.apId === ap.id)
  const slots: SlotPlan[] = []
  const issues: FleetIssue[] = []
  const takenNames = new Set(input.rows.filter((r) => r.config === 'wireless').map((r) => r.name))
  for (const network of [...input.networks].sort((a, b) => a.id - b.id)) {
    const membership =
      input.memberships.find((m) => m.networkId === network.id && m.apId === ap.id) ?? null
    if (!carries(network, membership)) continue
    const supported = supportsSecurity(ap.caps, network.security)
    if (supported === false) {
      issues.push({
        severity: 'warning',
        code: 'security_unsupported',
        message: `${ap.name} cannot carry ${network.security} networks`,
        networkId: network.id,
        apId: ap.id,
      })
      continue
    }
    const { radios, issues: radioIssues } = slotRadios(network, membership, ap.caps, ap.id)
    issues.push(...radioIssues)
    const binding = bindingNetwork(network, membership, ap, vlanNetworkFor)
    for (const radio of radios) {
      const link = links.find((l) => l.networkId === network.id && l.radio === radio.section)
      const row = link ? rowsById.get(link.perchId) : undefined
      const current = row ? syncedSection(row) : null
      const section = row?.name ?? slotSectionName(network.id, radio.section)
      const slot: SlotPlan = {
        networkId: network.id,
        radio: radio.section,
        band: (radio.band as WifiBand | null) ?? null,
        perchId: link?.perchId ?? null,
        section,
        state: link ? (current ? 'linked' : 'missing') : 'create',
        target: null,
        issues: [],
      }
      if (slot.state === 'create' && takenNames.has(section)) {
        slot.state = 'blocked'
        slot.issues.push({
          severity: 'error',
          code: 'name_taken',
          message: `${section} exists on ${ap.name} and is not this network's`,
          networkId: network.id,
          apId: ap.id,
          radio: radio.section,
        })
      }
      if ('issue' in binding) {
        slot.state = slot.state === 'missing' ? 'missing' : 'blocked'
        slot.issues.push({ ...binding.issue, radio: radio.section })
      } else if (slot.state === 'linked' || slot.state === 'create') {
        const made = slotObject({
          network,
          membership,
          ap,
          radio,
          current,
          section,
          networkName: binding.network,
          secrets: input.secrets,
        })
        slot.issues.push(...made.issues)
        if (made.obj) slot.target = objectContent(made.obj, current)
        else slot.state = 'blocked'
      }
      slots.push(slot)
    }
  }
  return { slots, issues }
}

/** Render one AP (see the module comment). */
export function renderAp(input: RenderInput): RenderResult {
  const { ap } = input
  const registry = apRegistry(ap.caps, { vlans: input.vlans, trunkOverride: input.trunkOverride })
  const ifaceRules = registry.rules(WIFI_IFACES_DOMAIN)
  const radioRules = registry.rules(WIFI_RADIOS_DOMAIN)
  const issues: FleetIssue[] = []
  const vlanEdits: SectionEdit[] = []
  let vlanNetworkFor: Record<number, string> = {}

  // Step 7 first: the interface names VLAN-bound slots use.
  const carried = input.networks.filter((n) =>
    carries(n, input.memberships.find((m) => m.networkId === n.id && m.apId === ap.id) ?? null)
  )
  const vids = carried.flatMap((n) => (n.binding.kind === 'vlan' ? [n.binding.vlanId] : []))
  if (input.vlans) {
    const networkRows: NetworkRow[] = input.rows
      .filter((r) => r.config === 'network' && (r.desired ?? r.router) !== null)
      .map((r) => ({
        perchId: r.perchId,
        name: r.name,
        type: (r.desired ?? r.router)!.type,
        options: { ...(r.scope === 'synced' ? (r.desired ?? r.router)! : r.router!).options },
        domain: r.scope === 'synced' ? r.domain : null,
        groups: /^perch_(v|bv|dv|bd|bvu)\d*$/.test(r.name),
      }))
    const plan = planVlanPlumbing({
      vids,
      rows: networkRows,
      trunk: trunkOf(ap.caps, input.trunkOverride),
    })
    vlanEdits.push(...plan.edits)
    vlanNetworkFor = plan.networkFor
    issues.push(...plan.issues.map((i) => ({ ...i, apId: ap.id })))
  }

  const { slots, issues: slotIssues } = planSlots(input, vlanNetworkFor)
  issues.push(...slotIssues)
  const holdsByPerch = new Map<string, OpenDivergence[]>()
  for (const h of input.holds) {
    if (h.apId !== ap.id || !h.perchId) continue
    holdsByPerch.set(h.perchId, [...(holdsByPerch.get(h.perchId) ?? []), h])
  }
  const rowsById = new Map(input.rows.map((r) => [r.perchId, r]))
  const ifaceEdits: SectionEdit[] = []

  for (const slot of slots) {
    issues.push(...slot.issues)
    const holds = slot.perchId ? (holdsByPerch.get(slot.perchId) ?? []) : []
    if (holds.some((h) => h.kind !== 'option' && h.kind !== 'country')) {
      slot.state = 'held'
      continue
    }
    if (!slot.target) continue
    if (slot.state === 'create') {
      ifaceEdits.push(putOf(null, slot.section, slot.target, null))
      continue
    }
    if (slot.state !== 'linked') continue
    const current = syncedSection(rowsById.get(slot.perchId!)!)!
    const held = holds.filter((h) => h.kind === 'option' && h.option).map((h) => h.option!)
    const target = applyHolds(slot.target, current, held)
    const now = rowsById.get(slot.perchId!)!.desired
    if (contentsEqual(target, now, ifaceRules) && sameSecretRefs(target, now)) continue
    ifaceEdits.push(putOf(slot.perchId, slot.section, target, current))
  }

  // Step 5: links whose slot is no longer carried go (unless an `added` hold keeps them).
  const slotPerchIds = new Set(slots.map((s) => s.perchId).filter((p): p is string => p !== null))
  for (const link of input.links.filter((l) => l.apId === ap.id)) {
    if (slotPerchIds.has(link.perchId)) continue
    const row = rowsById.get(link.perchId)
    if (!row || row.scope !== 'synced' || row.desired === null) continue
    if ((holdsByPerch.get(link.perchId) ?? []).length > 0) continue
    ifaceEdits.push({ op: 'delete', perchId: link.perchId })
  }

  // Step 6: the country of every present radio.
  const radioEdits: SectionEdit[] = []
  const settable = ap.caps?.regulatory?.settable !== false
  const code = ap.country.code
  if (ap.country.mode !== 'router' && settable && code !== null) {
    const countryHolds = new Set(
      input.holds.filter((h) => h.apId === ap.id && h.kind === 'country').map((h) => h.radio)
    )
    for (const radio of presentRadios(ap.caps)) {
      const row = input.rows.find(
        (r) =>
          r.config === 'wireless' &&
          r.name === radio.section &&
          r.scope === 'synced' &&
          r.domain === WIFI_RADIOS_DOMAIN
      )
      if (!row || row.desired === null || countryHolds.has(radio.section)) continue
      const fields = radioFields(row.desired.options, radio.band)
      if (fields.country === code) continue
      const options = { ...row.desired.options, country: code }
      if (contentsEqual({ ...row.desired, options }, row.desired, radioRules)) continue
      radioEdits.push({
        op: 'put',
        perchId: row.perchId,
        config: 'wireless',
        type: 'wifi-device',
        options,
      })
    }
  }

  const edits: DomainEdits[] = []
  if (vlanEdits.length > 0) edits.push({ domain: AP_VLANS_DOMAIN, edits: vlanEdits })
  if (radioEdits.length > 0) edits.push({ domain: WIFI_RADIOS_DOMAIN, edits: radioEdits })
  if (ifaceEdits.length > 0) edits.push({ domain: WIFI_IFACES_DOMAIN, edits: ifaceEdits })
  return { edits, slots, issues, fingerprint: renderFingerprint(input) }
}

/**
 * SHA-256 of what a render depends on (controller.md 5.2 step 8): the tick
 * re-renders a managed AP whose fingerprint moved (a network edit, a new
 * radio fact, a resolved divergence), so a crash between two APs' writes
 * heals by itself. Section contents are not part of it: router edits reach
 * the render through reconcile's divergences (holds).
 */
export function renderFingerprint(input: RenderInput): string {
  const { ap } = input
  const networkIds = new Set(input.networks.map((n) => n.id))
  const refs = new Set(input.networks.map((n) => n.passphraseRef).filter(Boolean) as string[])
  return sha256Hex(
    canonicalJson({
      v: 1,
      ap: {
        id: ap.id,
        managed: ap.managed,
        management: ap.management.network,
        country: ap.country,
        radios: (ap.caps?.radios ?? []).map((r) => [r.section, r.present, r.band]),
        features: ap.caps?.hostapd?.features ?? null,
        settable: ap.caps?.regulatory?.settable ?? null,
      },
      networks: [...input.networks].sort((a, b) => a.id - b.id),
      memberships: input.memberships
        .filter((m) => m.apId === ap.id && networkIds.has(m.networkId))
        .sort((a, b) => a.networkId - b.networkId),
      links: input.links
        .filter((l) => l.apId === ap.id)
        .map((l) => [l.perchId, l.networkId, l.radio])
        .sort(),
      rows: input.rows
        .filter((r) => r.config === 'wireless')
        .map((r) => [r.perchId, r.name, r.scope])
        .sort(),
      holds: input.holds
        .filter((h) => h.apId === ap.id)
        .map((h) => [h.kind, h.perchId, h.option, h.radio])
        .sort(),
      secrets: [...refs].sort().map((ref) => [ref, input.secrets[ref]?.fingerprint ?? null]),
      vlans: input.vlans ?? false,
      trunk: input.trunkOverride ?? null,
    })
  )
}
