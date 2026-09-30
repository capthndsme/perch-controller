import type { SectionState } from '#services/gateway_config/sync_engine'
import {
  ifaceFields,
  WIFI_IFACES_DOMAIN,
  type IfaceFields,
} from '#services/wifi_config/domains/wifi_ifaces'
import { radioFields } from '#services/wifi_config/domains/wifi_radios'
import { scalarOf } from '#services/wifi_config/domains/normalize'
import {
  canonicalJson,
  DEFAULT_ADVANCED,
  presentRadios,
  sha256Hex,
  sortBands,
} from '#services/wifi_config/fleet/model'
import { supportsSecurity } from '#services/wifi_config/fleet/security'
import type {
  Advanced,
  ApCapabilities,
  ApMode,
  ApScope,
  IfaceLink,
  NetworkOverrides,
  RadioOverrides,
  Roaming,
  WifiBand,
  WifiBinding,
  WifiNetworkApSpec,
  WifiNetworkSpec,
  WifiSecurity,
} from '#services/wifi_config/types'

/**
 * Adoption (docs/design/wifi controller.md section 5.4, decisions D13, D15):
 * what the APs run today becomes fleet networks with zero functional change
 * and without Perch ever reading a key. Every AP in observe or managed mode
 * contributes its synced, unlinked `wifi_ifaces` rows; rows are grouped by
 * (SSID, security, key fingerprint) and each group is a proposal:
 *
 * - template values are the majority across members; minority values on
 *   overridable fields become per-AP overrides (hidden, isolate, apNetwork,
 *   maxClients, dtimPeriod) or per-radio ones (enabled); on the others
 *   (802.11r/k/v, PMF, multicast-to-unicast) a `choices` entry;
 * - scope `all` when every AP carries it on every band it names (bands the
 *   AP has, securities it supports), else `selected`, with per-AP band or
 *   radio narrowing where an AP carries less;
 * - binding `lan` when every member is bridged into its AP's management
 *   network, else `ap_network` with each AP's network as an override.
 *
 * `planAdoption` turns the admin's answers into network specs, memberships
 * and links; storing them (one transaction) and the adopt jobs on entering
 * managed are the caller's. The render of an accepted proposal over the same
 * rows writes nothing (the S4 fixture test pins it on the live APs).
 */

export interface AdoptionAp {
  id: number
  name: string
  mode: ApMode
  caps: ApCapabilities | null
  management: { network: string | null }
  /** The AP's section rows after the last merged read. */
  rows: SectionState[]
}

export interface AdoptionInput {
  aps: AdoptionAp[]
  /** Existing links of every AP: linked rows are not proposed again. */
  links: IfaceLink[]
  /** Settings → time zone (suggests the fleet country). */
  timeZone: string | null
}

export interface AdoptionMember {
  apId: number
  perchId: string
  section: string
  radio: string
  band: WifiBand | null
  overrides: NetworkOverrides
  radioEnabled: boolean
}

/** One `wifi_network_aps` row the proposal would create. */
export interface AdoptionMembership {
  apId: number
  included: boolean | null
  bands: WifiBand[] | null
  radios: string[] | null
  overrides: NetworkOverrides
  radioOverrides: RadioOverrides
}

export type AdoptionWarning =
  | 'ssid_key_mismatch'
  | 'open_on_lan'
  | 'owe_unsupported_elsewhere'
  | 'orphans_skipped'

export interface AdoptionTemplate {
  hidden: boolean
  isolate: boolean
  roaming: Roaming
  advanced: Advanced
  enabled: boolean
}

export interface AdoptionProposal {
  /** Stable id of the group: SSID, security and key fingerprint. */
  key: string
  name: string
  ssid: string
  security: WifiSecurity
  keyFingerprint: string | null
  binding: WifiBinding
  bands: WifiBand[]
  apScope: ApScope
  template: AdoptionTemplate
  members: AdoptionMember[]
  memberships: AdoptionMembership[]
  /** Majority taken, minority listed: the admin settles these. */
  choices: Array<{ field: string; values: Array<{ value: unknown; apIds: number[] }> }>
  warnings: AdoptionWarning[]
  /** Informational: "VLAN 30" when an AP network sits on `<bridge>.<vid>`. */
  hints: string[]
  /** Suggested: leave it out (every member is disabled). */
  exclude: boolean
}

export interface AdoptionResult {
  proposals: AdoptionProposal[]
  countries: Array<{ apId: number; values: string[]; unset: boolean; suggested: string | null }>
  /** The fleet default the time zone suggests (else the most common one). */
  suggestedCountry: string | null
  skipped: Array<{ apId: number; section: string; reason: 'orphan' | 'unmodeled' | 'ambiguous' }>
}

/** Time zone → country for the fleet default suggestion (a small table; unknown zones suggest nothing). */
const ZONE_COUNTRY: Record<string, string> = {
  'Asia/Manila': 'PH',
  'Asia/Taipei': 'TW',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Kolkata': 'IN',
  'Asia/Dubai': 'AE',
  'Asia/Karachi': 'PK',
  'Asia/Dhaka': 'BD',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Lisbon': 'PT',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Kyiv': 'UA',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Phoenix': 'US',
  'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Santiago': 'CL',
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ',
  'Africa/Johannesburg': 'ZA',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Cairo': 'EG',
}

/** The country a time zone suggests, or null. */
export function countryForTimeZone(timeZone: string | null | undefined): string | null {
  return timeZone ? (ZONE_COUNTRY[timeZone] ?? null) : null
}

type Candidate = {
  ap: AdoptionAp
  row: SectionState
  fields: IfaceFields
  band: WifiBand | null
  fingerprint: string | null
}

function eligible(ap: AdoptionAp): boolean {
  return ap.mode === 'observe' || ap.mode === 'managed'
}

function contentOf(row: SectionState) {
  return row.desired ?? row.router
}

function apBands(ap: AdoptionAp): WifiBand[] {
  return sortBands(
    presentRadios(ap.caps)
      .map((r) => r.band)
      .filter((b): b is WifiBand => b === '2g' || b === '5g' || b === '6g')
  )
}

/** The value most members have; ties go to the first seen (members sorted by AP, radio). */
function majority<T>(values: T[]): T {
  const counts = new Map<string, { value: T; n: number; first: number }>()
  values.forEach((value, i) => {
    const k = canonicalJson(value)
    const entry = counts.get(k)
    if (entry) entry.n++
    else counts.set(k, { value, n: 1, first: i })
  })
  return [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0].value
}

function groupsByValue<T>(pairs: Array<{ value: T; apId: number }>) {
  const map = new Map<string, { value: T; apIds: number[] }>()
  for (const p of pairs) {
    const k = canonicalJson(p.value)
    const entry = map.get(k) ?? { value: p.value, apIds: [] }
    if (!entry.apIds.includes(p.apId)) entry.apIds.push(p.apId)
    map.set(k, entry)
  }
  return [...map.values()]
}

/** The VID of an AP network on `<bridge>.<vid>`, from the AP's network rows. */
function vlanOf(ap: AdoptionAp, network: string): number | null {
  const row = ap.rows.find((r) => r.config === 'network' && r.name === network)
  const device = row ? scalarOf(contentOf(row)?.options ?? {}, 'device') : null
  const m = device ? /\.(\d{1,4})$/.exec(device) : null
  return m ? Number(m[1]) : null
}

function candidatesOf(input: AdoptionInput): Candidate[] {
  const linked = new Set(input.links.map((l) => `${l.apId}|${l.perchId}`))
  const out: Candidate[] = []
  for (const ap of input.aps.filter(eligible)) {
    for (const row of ap.rows) {
      if (row.scope !== 'synced' || row.domain !== WIFI_IFACES_DOMAIN) continue
      if (linked.has(`${ap.id}|${row.perchId}`)) continue
      const content = contentOf(row)
      if (!content) continue
      const fields = ifaceFields(content.options)
      const radio = ap.caps?.radios?.find((r) => r.section === fields.radio) ?? null
      const band =
        radio?.band === '2g' || radio?.band === '5g' || radio?.band === '6g' ? radio.band : null
      out.push({
        ap,
        row,
        fields,
        band,
        fingerprint:
          fields.security === 'open' || fields.security === 'owe'
            ? null
            : (content.secrets?.key?.fingerprint ?? null),
      })
    }
  }
  return out.sort((a, b) => a.ap.id - b.ap.id || a.fields.radio.localeCompare(b.fields.radio))
}

function groupKey(ssid: string, security: WifiSecurity, fingerprint: string | null): string {
  return sha256Hex(`${ssid}\n${security}\n${fingerprint ?? ''}`).slice(0, 16)
}

const CHOICE_FIELDS: Array<{ field: string; get: (f: IfaceFields) => unknown }> = [
  { field: 'roaming.ft', get: (f) => f.ft },
  { field: 'roaming.mobilityDomain', get: (f) => f.mobilityDomain },
  { field: 'roaming.rrm', get: (f) => f.rrm },
  { field: 'roaming.btm', get: (f) => f.btm },
  { field: 'advanced.pmf', get: (f) => f.pmf },
  { field: 'advanced.multicastToUnicast', get: (f) => f.multicastToUnicast },
]

/** One proposal from a group of members (and the eligible APs, for scope). */
function buildProposal(
  group: Candidate[],
  input: AdoptionInput,
  fingerprint: string | null
): AdoptionProposal {
  const first = group[0]
  const ssid = first.fields.ssid
  const security = first.fields.security
  const apsAll = input.aps.filter(eligible)
  const fields = group.map((c) => c.fields)
  const template: AdoptionTemplate = {
    hidden: majority(fields.map((f) => f.hidden)),
    isolate: majority(fields.map((f) => f.isolate)),
    enabled: majority(fields.map((f) => f.enabled)),
    roaming: {
      ft: majority(fields.map((f) => f.ft)),
      mobilityDomain: majority(fields.map((f) => f.mobilityDomain)),
      rrm: majority(fields.map((f) => f.rrm)),
      btm: majority(fields.map((f) => f.btm)),
    },
    advanced: {
      ...DEFAULT_ADVANCED,
      pmf: majority(fields.map((f) => f.pmf)),
      multicastToUnicast: majority(fields.map((f) => f.multicastToUnicast)),
      maxClients: majority(fields.map((f) => f.maxClients)),
      dtimPeriod: majority(fields.map((f) => f.dtimPeriod)),
    },
  }

  const choices: AdoptionProposal['choices'] = []
  for (const { field, get } of CHOICE_FIELDS) {
    const values = groupsByValue(group.map((c) => ({ value: get(c.fields), apId: c.ap.id })))
    if (values.length > 1) choices.push({ field, values })
  }

  // Binding: every member in its AP's management network → lan.
  const isLan = group.every(
    (c) =>
      c.ap.management.network !== null &&
      c.fields.networks.length === 1 &&
      c.fields.networks[0] === c.ap.management.network
  )
  const binding: WifiBinding = isLan ? { kind: 'lan' } : { kind: 'ap_network' }
  const hints: string[] = []

  const byAp = new Map<number, Candidate[]>()
  for (const c of group) byAp.set(c.ap.id, [...(byAp.get(c.ap.id) ?? []), c])

  const bands = sortBands(group.map((c) => c.band).filter((b): b is WifiBand => b !== null))
  const covers = (ap: AdoptionAp) => {
    if (supportsSecurity(ap.caps, security) === false) return true
    const members = byAp.get(ap.id) ?? []
    return bands
      .filter((b) => apBands(ap).includes(b))
      .every((b) => members.some((m) => m.band === b))
  }
  const apScope: ApScope = apsAll.every(covers) ? 'all' : 'selected'

  const memberships: AdoptionMembership[] = []
  const members: AdoptionMember[] = []
  for (const [apId, list] of byAp) {
    const ap = list[0].ap
    const overrides: NetworkOverrides = {}
    const apFields = list.map((c) => c.fields)
    const hidden = majority(apFields.map((f) => f.hidden))
    if (hidden !== template.hidden) overrides.hidden = hidden
    const isolate = majority(apFields.map((f) => f.isolate))
    if (isolate !== template.isolate) overrides.isolate = isolate
    const maxClients = majority(apFields.map((f) => f.maxClients))
    if (maxClients !== template.advanced.maxClients && maxClients !== null) {
      overrides.maxClients = maxClients
    }
    const dtim = majority(apFields.map((f) => f.dtimPeriod))
    if (dtim !== template.advanced.dtimPeriod && dtim !== null) overrides.dtimPeriod = dtim
    if (!isLan) {
      const network = majority(apFields.map((f) => f.networks[0] ?? null))
      if (network) {
        overrides.apNetwork = network
        const vid = vlanOf(ap, network)
        if (vid !== null && !hints.includes(`VLAN ${vid}`)) hints.push(`VLAN ${vid}`)
      }
    }
    const radioOverrides: RadioOverrides = {}
    for (const c of list) {
      if (c.fields.enabled !== template.enabled)
        radioOverrides[c.fields.radio] = { enabled: c.fields.enabled }
    }
    const theirBands = sortBands(list.map((c) => c.band).filter((b): b is WifiBand => b !== null))
    const expected = bands.filter((b) => apBands(ap).includes(b))
    const bandOverride =
      theirBands.length > 0 && canonicalJson(theirBands) !== canonicalJson(expected)
        ? theirBands
        : null
    // Two working radios on one band and the network on only some of them: name the radios.
    const present = presentRadios(ap.caps)
    const radiosNeeded = theirBands.some((b) => {
      const onBand = present.filter((r) => r.band === b).map((r) => r.section)
      const used = list.filter((c) => c.band === b).map((c) => c.fields.radio)
      return onBand.some((r) => !used.includes(r))
    })
    memberships.push({
      apId,
      included: apScope === 'all' ? null : true,
      bands: bandOverride,
      radios: radiosNeeded ? [...new Set(list.map((c) => c.fields.radio))].sort() : null,
      overrides,
      radioOverrides,
    })
    for (const c of list) {
      members.push({
        apId,
        perchId: c.row.perchId,
        section: c.row.name,
        radio: c.fields.radio,
        band: c.band,
        overrides,
        radioEnabled: c.fields.enabled,
      })
    }
  }

  const warnings: AdoptionWarning[] = []
  if (security === 'open' && isLan) warnings.push('open_on_lan')
  if (security === 'owe' && apsAll.some((ap) => supportsSecurity(ap.caps, 'owe') === false)) {
    warnings.push('owe_unsupported_elsewhere')
  }
  const orphaned = apsAll.some((ap) =>
    ap.rows.some(
      (r) =>
        r.type === 'wifi-iface' &&
        r.scope !== 'synced' &&
        scalarOf(contentOf(r)?.options ?? {}, 'ssid') === ssid &&
        skipReason(ap, r) === 'orphan'
    )
  )
  if (orphaned) warnings.push('orphans_skipped')

  return {
    key: groupKey(ssid, security, fingerprint),
    name: ssid,
    ssid,
    security,
    keyFingerprint: fingerprint,
    binding,
    bands,
    apScope,
    template,
    members,
    memberships: memberships.sort((a, b) => a.apId - b.apId),
    choices,
    warnings,
    hints,
    exclude: members.every((m) => !m.radioEnabled),
  }
}

function skipReason(ap: AdoptionAp, row: SectionState): 'orphan' | 'unmodeled' | 'ambiguous' {
  if (row.issue === 'ambiguous') return 'ambiguous'
  const device = scalarOf(contentOf(row)?.options ?? {}, 'device')
  const radios = ap.rows.filter((r) => r.config === 'wireless' && r.type === 'wifi-device')
  return device !== null && !radios.some((r) => r.name === device) ? 'orphan' : 'unmodeled'
}

/** The proposals for every AP in observe or managed mode (see the module comment). */
export function proposeAdoption(input: AdoptionInput): AdoptionResult {
  const candidates = candidatesOf(input)
  const groups = new Map<string, { fingerprint: string | null; list: Candidate[] }>()
  for (const c of candidates) {
    const key = groupKey(c.fields.ssid, c.fields.security, c.fingerprint)
    const g = groups.get(key) ?? { fingerprint: c.fingerprint, list: [] }
    g.list.push(c)
    groups.set(key, g)
  }
  const proposals = [...groups.values()].map((g) => buildProposal(g.list, input, g.fingerprint))
  // The same SSID with different keys: separate proposals, both flagged, names told apart.
  const bySsid = new Map<string, AdoptionProposal[]>()
  for (const p of proposals) bySsid.set(p.ssid, [...(bySsid.get(p.ssid) ?? []), p])
  for (const same of bySsid.values()) {
    if (same.length < 2) continue
    same.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key))
    same.forEach((p, i) => {
      if (same.some((o) => o !== p && o.security === p.security))
        p.warnings.push('ssid_key_mismatch')
      if (i > 0) p.name = `${p.ssid} (${i + 1})`
    })
  }
  proposals.sort((a, b) => a.ssid.localeCompare(b.ssid) || a.name.localeCompare(b.name))

  const countries: AdoptionResult['countries'] = []
  const suggestedByZone = countryForTimeZone(input.timeZone)
  const tally = new Map<string, number>()
  for (const ap of input.aps.filter(eligible)) {
    const values = new Set<string>()
    let unset = false
    for (const radio of presentRadios(ap.caps)) {
      const row = ap.rows.find((r) => r.config === 'wireless' && r.name === radio.section)
      const content = row ? contentOf(row) : null
      const country = content ? radioFields(content.options, radio.band).country : null
      if (country) {
        values.add(country)
        tally.set(country, (tally.get(country) ?? 0) + 1)
      } else unset = true
    }
    countries.push({
      apId: ap.id,
      values: [...values].sort(),
      unset,
      suggested: suggestedByZone,
    })
  }
  const common = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const suggestedCountry = suggestedByZone ?? (common.length > 0 ? common[0][0] : null)
  for (const c of countries) c.suggested = suggestedCountry

  const skipped: AdoptionResult['skipped'] = []
  for (const ap of input.aps.filter(eligible)) {
    for (const row of ap.rows) {
      if (row.config !== 'wireless' || row.type !== 'wifi-iface' || row.scope === 'synced') continue
      skipped.push({ apId: ap.id, section: row.name, reason: skipReason(ap, row) })
    }
  }
  return { proposals, countries, suggestedCountry, skipped }
}

// ── acceptance (POST /wifi/adoption) ─────────────────────────────────────

export interface AdoptionRequestItem {
  key: string
  name?: string
  /** Other proposal keys folded into this one (same SSID and security). */
  merge?: string[]
  /** Settles `choices`: field → value (e.g. `{"roaming.ft": true}`). */
  choices?: Record<string, unknown>
  exclude?: boolean
}

export interface AdoptedNetwork {
  key: string
  spec: Omit<WifiNetworkSpec, 'id' | 'revision'>
  memberships: Array<Omit<WifiNetworkApSpec, 'networkId'>>
  links: Array<Omit<IfaceLink, 'networkId'>>
}

export type AdoptionPlan =
  | {
      ok: true
      networks: AdoptedNetwork[]
      /**
       * Sections of proposals the admin left out: the caller sets their
       * scope to `excluded` (router-only), so no later reconcile turns them
       * into networks.
       */
      excluded: Array<{ apId: number; perchId: string }>
    }
  | { ok: false; error: 'adoption_changed'; keys: string[] }
  | { ok: false; error: 'merge_incompatible'; key: string; with: string }

function applyChoice(template: AdoptionTemplate, field: string, value: unknown): AdoptionTemplate {
  const next: AdoptionTemplate = {
    ...template,
    roaming: { ...template.roaming },
    advanced: { ...template.advanced },
  }
  const [group, name] = field.split('.')
  if (group === 'roaming' && name in next.roaming) {
    next.roaming = { ...next.roaming, [name]: value } as Roaming
  }
  if (group === 'advanced' && name in next.advanced) {
    next.advanced = { ...next.advanced, [name]: value } as Advanced
  }
  return next
}

/**
 * The networks, memberships and links an adoption request creates, from
 * proposals recomputed on the same input (a proposal that is gone answers
 * `adoption_changed`: re-fetch). Proposals the request does not name stay
 * pending; `exclude: true` leaves one out.
 */
export function planAdoption(input: AdoptionInput, items: AdoptionRequestItem[]): AdoptionPlan {
  const result = proposeAdoption(input)
  const byKey = new Map(result.proposals.map((p) => [p.key, p]))
  const missing = items.flatMap((i) => [i.key, ...(i.merge ?? [])]).filter((k) => !byKey.has(k))
  if (missing.length > 0) return { ok: false, error: 'adoption_changed', keys: missing }
  const candidates = candidatesOf(input)
  const networks: AdoptedNetwork[] = []
  const excluded: Array<{ apId: number; perchId: string }> = []
  for (const item of items) {
    if (item.exclude) {
      for (const key of [item.key, ...(item.merge ?? [])]) {
        excluded.push(...byKey.get(key)!.members.map((m) => ({ apId: m.apId, perchId: m.perchId })))
      }
      continue
    }
    let proposal = byKey.get(item.key)!
    if (item.merge && item.merge.length > 0) {
      const others = item.merge.map((k) => byKey.get(k)!)
      const bad = others.find((o) => o.ssid !== proposal.ssid || o.security !== proposal.security)
      if (bad) return { ok: false, error: 'merge_incompatible', key: item.key, with: bad.key }
      const perchIds = new Set(
        [proposal, ...others].flatMap((p) => p.members.map((m) => `${m.apId}|${m.perchId}`))
      )
      const group = candidates.filter((c) => perchIds.has(`${c.ap.id}|${c.row.perchId}`))
      const fingerprints = new Set([proposal, ...others].map((p) => p.keyFingerprint))
      proposal = buildProposal(
        group,
        input,
        fingerprints.size === 1 ? proposal.keyFingerprint : null
      )
    }
    let template = proposal.template
    for (const [field, value] of Object.entries(item.choices ?? {})) {
      template = applyChoice(template, field, value)
    }
    networks.push({
      key: proposal.key,
      spec: {
        name: (item.name ?? proposal.name).slice(0, 64),
        ssid: proposal.ssid,
        enabled: template.enabled,
        security: proposal.security,
        passphraseRef: null,
        hidden: template.hidden,
        isolate: template.isolate,
        binding: proposal.binding,
        bands: proposal.bands,
        apScope: proposal.apScope,
        roaming: template.roaming,
        advanced: template.advanced,
        groups: false,
        origin: 'import',
      },
      memberships: proposal.memberships.map((m) => ({
        apId: m.apId,
        included: m.included,
        bands: m.bands,
        radios: m.radios,
        overrides: m.overrides,
        radioOverrides: m.radioOverrides,
      })),
      links: proposal.members.map((m) => ({
        apId: m.apId,
        perchId: m.perchId,
        radio: m.radio,
        origin: 'adopted' as const,
      })),
    })
  }
  return { ok: true, networks, excluded }
}
