import ApConfig from '#models/ap_config'
import SystemSetting from '#models/system_setting'
import type User from '#models/user'
import WifiAccessPoint from '#models/wifi_access_point'
import WifiDivergence from '#models/wifi_divergence'
import WifiIfaceLink from '#models/wifi_iface_link'
import WifiNetwork from '#models/wifi_network'
import WifiNetworkAp from '#models/wifi_network_ap'
import WifiSecret from '#models/wifi_secret'
import {
  EditRefusedError,
  planSectionEdits,
  type EditSectionsResult,
} from '#services/gateway_config/apply_plan'
import { cloneContent } from '#services/gateway_config/canonical'
import { SectionEditError } from '#services/gateway_config/domain'
import { deriveStatus, type SectionState } from '#services/gateway_config/sync_engine'
import { actorColumns, type PlaneActor, type RouterAuthor } from '#services/gateway_config/types'
import { WIFI_IFACES_DOMAIN } from '#services/wifi_config/domains/index'
import { flagText, intOf } from '#services/wifi_config/domains/normalize'
import { ifaceFields, securityOfEncryption } from '#services/wifi_config/domains/wifi_ifaces'
import { wifiError, WifiPlaneError } from '#services/wifi_config/errors'
import { emitWifiAlert, recordApEvent } from '#services/wifi_config/events'
import {
  planAdoption,
  proposeAdoption,
  type AdoptionAp,
  type AdoptionInput,
  type AdoptionRequestItem,
  type AdoptionResult,
} from '#services/wifi_config/fleet/adoption'
import {
  DEFAULT_ADVANCED,
  defaultRoaming,
  presentRadios,
  sortBands,
  type FleetAp,
  type FleetIssue,
} from '#services/wifi_config/fleet/model'
import { reconcileAp } from '#services/wifi_config/fleet/reconcile'
import {
  planSlots,
  renderAp,
  type RenderInput,
  type RenderResult,
  type SlotPlan,
} from '#services/wifi_config/fleet/render'
import {
  expectedKeyFingerprints,
  isOfferedSecurity,
  passphraseError,
  passphraseMatches,
  pmfError,
  supportsSecurity,
} from '#services/wifi_config/fleet/security'
import { registryFor } from '#services/wifi_config/lifecycle'
import { apDisplayName, apSession, normalizeApMode } from '#services/wifi_config/registry'
import { createRollout, planRollout, type RolloutTargets } from '#services/wifi_config/rollouts'
import {
  dropSecretIfUnused,
  passphraseFingerprint,
  secretFingerprints,
  storeWifiSecret,
} from '#services/wifi_config/secrets'
import {
  getWifiConfigSettings,
  normalizeCountry,
  updateWifiConfigSettings,
  type WifiConfigSettings,
} from '#services/wifi_config/settings'
import {
  apConfigQueue,
  apPerchIdFactory,
  FLEET,
  fleetQueue,
  inFlightApApply,
  loadApSections,
  refreshApSyncState,
  saveApStates,
} from '#services/wifi_config/store'
import type {
  Advanced,
  ApScope,
  ImpactPreview,
  CountryMode,
  DivergenceResolution,
  IfaceLink,
  NetworkOverrides,
  OfferedSecurity,
  OpenDivergence,
  RadioOverrides,
  Roaming,
  WifiBand,
  WifiBinding,
  WifiNetworkApSpec,
  WifiNetworkSpec,
  WifiSecurity,
} from '#services/wifi_config/types'
import hash from '@adonisjs/core/services/hash'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The fleet layer's database half (docs/design/wifi controller.md section
 * 5, work package S4 `fleet_service.ts`): loading networks, memberships,
 * links and divergences for the pure fleet modules; writing a render into
 * an AP's draft (through the core's `planSectionEdits`); storing what a
 * reconcile found; networks CRUD, passphrases, per-AP overrides, divergence
 * resolution and adoption acceptance.
 *
 * Fleet writes run in the fleet queue and touch each AP inside its own
 * queue (lock order fleet → AP). Writes that change what APs run start a
 * rollout unless `?apply=0`; the change is kept either way (`rolloutError`
 * says why none started).
 */

// ── loading ──────────────────────────────────────────────────────────────

export type FleetData = {
  networks: WifiNetwork[]
  specs: WifiNetworkSpec[]
  memberships: WifiNetworkApSpec[]
  links: IfaceLink[]
  secrets: Record<string, { fingerprint: string }>
}

export function networkSpecOf(row: WifiNetwork): WifiNetworkSpec {
  return {
    id: row.id,
    name: row.name,
    ssid: row.ssid,
    enabled: Boolean(row.enabled),
    security: row.security,
    passphraseRef: row.passphraseRef,
    hidden: Boolean(row.hidden),
    isolate: Boolean(row.isolate),
    binding: row.binding ?? { kind: 'lan' },
    bands: sortBands(row.bands ?? []),
    apScope: row.apScope === 'selected' ? 'selected' : 'all',
    roaming: { ...defaultRoaming(), ...(row.roaming ?? {}) },
    advanced: { ...DEFAULT_ADVANCED, ...(row.advanced ?? {}) },
    groups: Boolean(row.groups),
    origin: row.origin,
    revision: row.revision,
  }
}

export function membershipSpecOf(row: WifiNetworkAp): WifiNetworkApSpec {
  return {
    networkId: row.networkId,
    apId: row.apId,
    included: row.included === null || row.included === undefined ? null : Boolean(row.included),
    bands: row.bands ?? null,
    radios: row.radios ?? null,
    overrides: row.overrides ?? {},
    radioOverrides: row.radioOverrides ?? {},
  }
}

export function linkSpecOf(row: WifiIfaceLink): IfaceLink {
  return {
    apId: row.apId,
    perchId: row.perchId,
    networkId: row.networkId,
    radio: row.radio,
    origin: row.origin,
  }
}

export async function loadFleet(): Promise<FleetData> {
  const [networks, memberships, links] = await Promise.all([
    WifiNetwork.query().orderBy('id'),
    WifiNetworkAp.query().orderBy('id'),
    WifiIfaceLink.query().orderBy('id'),
  ])
  const refs = networks.map((n) => n.passphraseRef).filter((r): r is string => r !== null)
  return {
    networks,
    specs: networks.map(networkSpecOf),
    memberships: memberships.map(membershipSpecOf),
    links: links.map(linkSpecOf),
    secrets: await secretFingerprints(refs),
  }
}

export function openDivergenceOf(row: WifiDivergence): OpenDivergence {
  return {
    id: row.id,
    apId: row.apId,
    networkId: row.networkId,
    perchId: row.perchId,
    radio: row.radio,
    kind: row.kind,
    option: row.option,
    fleetValue: row.fleetValue,
    apValue: row.apValue,
    routerAuthor: row.routerAuthor,
  }
}

export async function openDivergenceRows(filter: { apId?: number } = {}) {
  const query = WifiDivergence.query().whereNull('resolved_at').orderBy('id')
  if (filter.apId !== undefined) query.where('ap_id', filter.apId)
  return query
}

/** The AP's country policy with the effective code (decision D10). */
export function countryPolicyOf(
  ap: Pick<ApConfig, 'countryMode' | 'country'>,
  settings: Pick<WifiConfigSettings, 'countryDefault'>
): { mode: CountryMode; code: string | null } {
  const mode: CountryMode =
    ap.countryMode === 'fixed' || ap.countryMode === 'router' ? ap.countryMode : 'fleet'
  if (mode === 'fleet') return { mode, code: settings.countryDefault }
  if (mode === 'fixed') return { mode, code: normalizeCountry(ap.country) }
  return { mode, code: null }
}

export function fleetApOf(
  ap: ApConfig,
  name: string,
  settings: Pick<WifiConfigSettings, 'countryDefault'>
): FleetAp {
  const mode = normalizeApMode(ap.mode)
  return {
    id: ap.apId,
    name,
    mode,
    managed: mode === 'managed',
    caps: ap.capabilities,
    management: {
      network: ap.managementPath?.network ?? ap.capabilities?.management?.network ?? null,
    },
    country: countryPolicyOf(ap, settings),
  }
}

async function apNames(apIds: number[]): Promise<Map<number, string>> {
  if (apIds.length === 0) return new Map()
  const rows = await WifiAccessPoint.query().whereIn('id', apIds)
  return new Map(rows.map((r) => [r.id, apDisplayName(r)]))
}

/** The render input of one AP (controller.md 5.2) from loaded data. */
export async function renderInputOf(
  ap: ApConfig,
  fleet: FleetData,
  settings: WifiConfigSettings,
  rows?: SectionState[]
): Promise<RenderInput> {
  const names = await apNames([ap.apId])
  const open = await openDivergenceRows({ apId: ap.apId })
  const holds = open.map(openDivergenceOf)
  let current = rows
  if (!current) {
    const loaded = await loadApSections(ap.apId)
    current = loaded.states
  }
  return {
    ap: fleetApOf(ap, names.get(ap.apId) ?? `AP ${ap.apId}`, settings),
    networks: fleet.specs,
    memberships: fleet.memberships,
    links: fleet.links,
    rows: current,
    holds,
    secrets: fleet.secrets,
    trunkOverride: ap.trunkOverride,
  }
}

// ── render into an AP's draft ────────────────────────────────────────────

export type RenderOutcome = {
  /** Rows whose C changed or that were created. */
  changed: string[]
  created: string[]
  issues: FleetIssue[]
  slots: SlotPlan[]
  /** Every edit went in (else: conflicted or in-flight sections waited). */
  complete: boolean
}

/**
 * A render's edits applied to an AP's rows in memory (the core's
 * `planSectionEdits` per domain, against the evolving rows): sections in
 * conflict or carried by a job in flight are left for later (`complete`
 * false). Pure apart from the id factory.
 */
export function applyRenderEdits(
  ap: ApConfig,
  states: SectionState[],
  result: RenderResult,
  inFlight: string[]
): {
  candidate: Map<string, SectionState>
  upserted: Map<string, SectionState>
  deleted: Set<string>
  created: string[]
  complete: boolean
} {
  const waiting = new Set([
    ...states.filter((s) => s.conflict !== null).map((s) => s.perchId),
    ...inFlight,
  ])
  const registry = registryFor(ap)
  const authoritative = Boolean(ap.authoritative)
  const newPerchId = apPerchIdFactory(states.map((s) => s.perchId))
  const candidate = new Map(states.map((s) => [s.perchId, s]))
  const upserted = new Map<string, SectionState>()
  const deleted = new Set<string>()
  const created: string[] = []
  let complete = true
  for (const batch of result.edits) {
    const edits = batch.edits.filter((e) => {
      const id = e.op === 'order' ? null : e.perchId
      if (id && waiting.has(id)) {
        complete = false
        return false
      }
      return true
    })
    if (edits.length === 0) continue
    let planned: EditSectionsResult
    const before = new Set(candidate.keys())
    try {
      planned = planSectionEdits({
        rows: [...candidate.values()],
        edits,
        domain: batch.domain,
        registry,
        authoritative,
        newPerchId,
      })
    } catch (error) {
      if (error instanceof EditRefusedError || error instanceof SectionEditError) {
        logger.warn(
          { apId: ap.apId, domain: batch.domain, error: error.message },
          'wifi_config: render edit refused'
        )
        complete = false
        continue
      }
      throw error
    }
    for (const u of planned.upserts) {
      candidate.set(u.perchId, u)
      upserted.set(u.perchId, u)
      if (!before.has(u.perchId)) created.push(u.perchId)
    }
    for (const id of planned.deleted) {
      candidate.delete(id)
      upserted.delete(id)
      deleted.add(id)
    }
  }
  return { candidate, upserted, deleted, created, complete }
}

/**
 * Writes the fleet's render into a managed AP's draft (controller.md 5.2):
 * the core's `planSectionEdits` per domain against the evolving rows
 * (sections in conflict or carried by a job in flight are left for later),
 * a link row for each created slot (matched by section name), and the
 * render fingerprint once every edit went in. Nothing is sent. Runs in the
 * AP's queue.
 */
export async function renderApDraft(
  apId: number,
  options: { actor?: PlaneActor | null; fleet?: FleetData; settings?: WifiConfigSettings } = {}
): Promise<RenderOutcome | null> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.find(apId)
    if (!ap || normalizeApMode(ap.mode) !== 'managed') return null
    const settings = options.settings ?? (await getWifiConfigSettings())
    const fleet = options.fleet ?? (await loadFleet())
    const loaded = await loadApSections(apId)
    const input = await renderInputOf(ap, fleet, settings, loaded.states)
    const result: RenderResult = renderAp(input)
    const outcome: RenderOutcome = {
      changed: [],
      created: [],
      issues: result.issues,
      slots: result.slots,
      complete: true,
    }
    if (result.edits.length === 0) {
      if (ap.renderFingerprint !== result.fingerprint) {
        ap.renderFingerprint = result.fingerprint
        await ap.save()
      }
      return outcome
    }
    const flight = await inFlightApApply(apId)
    const applied = applyRenderEdits(ap, loaded.states, result, flight?.perchIds ?? [])
    outcome.complete = applied.complete
    outcome.created.push(...applied.created)
    const { candidate, upserted, deleted } = applied
    const existing = new Set(loaded.states.map((s) => s.perchId))
    const changes = [
      ...[...upserted.values()].map((s) => ({
        perchId: s.perchId,
        after: s as SectionState | null,
      })),
      ...[...deleted].filter((id) => existing.has(id)).map((id) => ({ perchId: id, after: null })),
    ]
    const actor = options.actor ?? { system: 'system' as const }
    const { userId } = actorColumns(actor)
    await db.transaction(async (trx) => {
      await saveApStates(apId, loaded.rows, changes, { userId, trx })
      // Links for the slots render created (matched by section name).
      for (const id of outcome.created) {
        const row = candidate.get(id)
        const slot = result.slots.find((s) => s.state === 'create' && s.section === row?.name)
        if (!row || !slot) continue
        await WifiIfaceLink.create(
          {
            apId,
            perchId: id,
            networkId: slot.networkId,
            radio: slot.radio,
            origin: 'created',
          },
          { client: trx }
        )
      }
      if (changes.length > 0) {
        await recordApEvent(apId, 'draft_edited', {
          actor,
          detail: { source: 'fleet', perchIds: changes.map((c) => c.perchId) },
          trx,
        })
      }
      if (outcome.complete) {
        ap.useTransaction(trx)
        ap.renderFingerprint = result.fingerprint
        await ap.save()
      }
    })
    outcome.changed = changes.map((c) => c.perchId)
    await refreshApSyncState(ap)
    return outcome
  })
}

/** Renders every managed AP (a fleet change); returns what changed per AP. */
export async function renderManagedAps(
  actor: PlaneActor | null,
  apIds?: number[]
): Promise<Map<number, RenderOutcome>> {
  const settings = await getWifiConfigSettings()
  const managed = await ApConfig.query().where('mode', 'managed').orderBy('ap_id')
  const out = new Map<number, RenderOutcome>()
  for (const ap of managed) {
    if (apIds && !apIds.includes(ap.apId)) continue
    // Fresh fleet data per AP: an earlier AP's render may have added links.
    const outcome = await renderApDraft(ap.apId, { actor, settings, fleet: await loadFleet() })
    if (outcome) out.set(ap.apId, outcome)
  }
  return out
}

// ── reconcile after a read ───────────────────────────────────────────────

/** The key fingerprint of every linked `wifi_ifaces` row (all APs): expected keys. */
async function linkedKeyFingerprints(
  links: IfaceLink[]
): Promise<Array<{ networkId: number; fingerprint: string | null }>> {
  const linked = links.filter((l) => l.networkId !== null)
  if (linked.length === 0) return []
  const rows = await db
    .from('ap_config_sections')
    .where('domain', WIFI_IFACES_DOMAIN)
    .select('ap_id', 'perch_id', 'desired_content', 'router_content')
  const fp = new Map<string, string | null>()
  for (const row of rows as Array<Record<string, unknown>>) {
    const parse = (v: unknown) => {
      try {
        return typeof v === 'string'
          ? (JSON.parse(v) as { secrets?: Record<string, { fingerprint?: string }> })
          : null
      } catch {
        return null
      }
    }
    const content = parse(row.desired_content) ?? parse(row.router_content)
    fp.set(`${row.ap_id}|${row.perch_id}`, content?.secrets?.key?.fingerprint ?? null)
  }
  return linked.map((l) => ({
    networkId: l.networkId!,
    fingerprint: fp.get(`${l.apId}|${l.perchId}`) ?? null,
  }))
}

/**
 * The fleet reconcile after a merged read (controller.md 5.3): links router
 * interfaces to networks, creates `origin: router` networks for new SSIDs
 * in two-way mode, opens, refreshes and closes divergences, stores the AP's
 * fleet state; then renders a managed AP (holds may have changed). Runs in
 * the AP's queue (the read's task).
 */
export async function reconcileApFleet(apId: number): Promise<void> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.find(apId)
    if (!ap || normalizeApMode(ap.mode) === 'off') return
    const settings = await getWifiConfigSettings()
    const fleet = await loadFleet()
    const loaded = await loadApSections(apId)
    const openRows = await openDivergenceRows({ apId })
    const open = openRows.map(openDivergenceOf)
    const authors: Record<string, RouterAuthor | null> = {}
    for (const row of loaded.rows) authors[row.perchId] = row.routerAuthor ?? null
    const expectedKeys = expectedKeyFingerprints(
      fleet.specs,
      fleet.secrets,
      await linkedKeyFingerprints(fleet.links)
    )
    const names = await apNames([apId])
    const name = names.get(apId) ?? `AP ${apId}`
    const result = reconcileAp({
      ap: fleetApOf(ap, name, settings),
      networks: fleet.specs,
      memberships: fleet.memberships,
      links: fleet.links,
      rows: loaded.states,
      secrets: fleet.secrets,
      trunkOverride: ap.trunkOverride,
      open,
      expectedKeys,
      authors,
    })
    const now = DateTime.utc()
    const opened: number[] = []
    await db.transaction(async (trx) => {
      for (const link of result.links.add) {
        await WifiIfaceLink.updateOrCreate(
          { apId, perchId: link.perchId },
          { networkId: link.networkId, radio: link.radio, origin: link.origin },
          { client: trx }
        )
      }
      if (result.links.remove.length > 0) {
        await WifiIfaceLink.query({ client: trx })
          .where('ap_id', apId)
          .whereIn('perch_id', result.links.remove)
          .delete()
      }
      for (const created of result.newNetworks) {
        const network = new WifiNetwork()
        network.useTransaction(trx)
        fillNetwork(network, created.spec)
        network.revision = 1
        await network.save()
        await WifiNetworkAp.create(
          {
            networkId: network.id,
            apId,
            included: true,
            bands: null,
            radios: null,
            overrides: {},
            radioOverrides: {},
          },
          { client: trx }
        )
        await WifiIfaceLink.updateOrCreate(
          { apId, perchId: created.perchId },
          { networkId: network.id, radio: created.radio, origin: 'router' },
          { client: trx }
        )
        await recordApEvent(apId, 'network_created', {
          detail: { networkId: network.id, ssid: created.spec.ssid, origin: 'router' },
          trx,
        })
      }
      for (const d of result.open) {
        if (d.id !== null) {
          await WifiDivergence.query({ client: trx })
            .where('id', d.id)
            .update({
              fleet_value: JSON.stringify(d.fleetValue ?? null),
              ap_value: JSON.stringify(d.apValue ?? null),
              router_author: d.routerAuthor ? JSON.stringify(d.routerAuthor) : null,
            })
          continue
        }
        const row = new WifiDivergence()
        row.useTransaction(trx)
        row.apId = apId
        row.networkId = d.networkId
        row.perchId = d.perchId
        row.radio = d.radio
        row.kind = d.kind
        row.option = d.option
        row.fleetValue = d.fleetValue ?? null
        row.apValue = d.apValue ?? null
        row.routerAuthor = d.routerAuthor
        row.detectedAt = now
        row.resolvedAt = null
        row.resolution = null
        await row.save()
        opened.push(row.id)
        await recordApEvent(apId, 'divergence_opened', {
          detail: {
            divergenceId: row.id,
            kind: d.kind,
            option: d.option,
            networkId: d.networkId,
            radio: d.radio,
            ...(d.routerAuthor ? { author: d.routerAuthor } : {}),
          },
          trx,
        })
      }
      if (result.close.length > 0) {
        await WifiDivergence.query({ client: trx })
          .whereIn('id', result.close)
          .whereNull('resolved_at')
          .update({ resolved_at: now.toFormat('yyyy-MM-dd HH:mm:ss'), resolution: 'auto' })
      }
      ap.useTransaction(trx)
      ap.fleetState = result.fleetState
      await ap.save()
    })
    for (const d of result.open.filter((x) => x.id === null)) {
      emitWifiAlert({
        name: 'wifi.divergence.opened',
        severity: 'info',
        source: { kind: 'ap', id: apId },
        dedupeKey: `wifi.divergence.opened:${apId}:${d.kind}:${d.perchId ?? ''}:${d.option ?? ''}`,
        payload: { apId, networkId: d.networkId, option: d.option, author: d.routerAuthor },
      })
    }
    if (normalizeApMode(ap.mode) === 'managed') {
      await renderApDraft(apId, { settings })
    }
  })
}

// ── networks ─────────────────────────────────────────────────────────────

export type NetworkInput = {
  name?: string
  ssid?: string
  enabled?: boolean
  security?: OfferedSecurity
  passphrase?: string
  hidden?: boolean
  isolate?: boolean
  binding?: WifiBinding
  bands?: WifiBand[]
  apScope?: ApScope
  apIds?: number[]
  roaming?: Partial<Roaming>
  advanced?: Partial<Advanced>
  groups?: boolean
}

export type WriteOutcome<T> = {
  object: T
  issues: FleetIssue[]
  rollout: import('#models/wifi_rollout').default | null
  rolloutError: { error: string; message: string } | null
}

function fillNetwork(row: WifiNetwork, spec: Omit<WifiNetworkSpec, 'id' | 'revision'>) {
  row.name = spec.name.slice(0, 64)
  row.ssid = spec.ssid
  row.enabled = spec.enabled
  row.security = spec.security
  row.passphraseRef = spec.passphraseRef
  row.hidden = spec.hidden
  row.isolate = spec.isolate
  row.binding = spec.binding
  row.bands = sortBands(spec.bands)
  row.apScope = spec.apScope
  row.roaming = spec.roaming
  row.advanced = spec.advanced
  row.groups = spec.groups
  row.origin = spec.origin
}

export async function findNetwork(id: number): Promise<WifiNetwork> {
  const row = await WifiNetwork.find(id)
  if (!row) throw wifiError(404, 'network_not_found', `No network with id ${id}.`)
  return row
}

const SECURITY_RANK: Record<WifiSecurity, number> = {
  open: 0,
  owe: 1,
  wpa_wpa2: 2,
  wpa2: 3,
  wpa2_wpa3: 4,
  wpa3: 5,
}

/** A security change that weakens the network (the step-up rule, operations.md 1). */
export function isSecurityDowngrade(from: WifiSecurity, to: WifiSecurity): boolean {
  return SECURITY_RANK[to] < SECURITY_RANK[from]
}

async function verifyPassword(user: User, password: string | undefined): Promise<boolean> {
  if (!password) return false
  return hash.verify(user.password, password)
}

function validateBinding(binding: WifiBinding | undefined) {
  if (!binding) return
  if (binding.kind === 'vlan') {
    // Phase 3 (the `ap_vlans` domain): VLAN-bound SSIDs are not built yet.
    throw wifiError(422, 'vlan_unknown', 'VLAN-bound networks come with a later release.')
  }
  if (binding.kind !== 'lan' && binding.kind !== 'ap_network') {
    throw wifiError(422, 'binding_invalid', 'That network binding is not valid.')
  }
}

function checkSsid(ssid: string) {
  const bytes = Buffer.byteLength(ssid, 'utf8')
  if (bytes < 1 || bytes > 32) throw wifiError(422, 'ssid_invalid', 'An SSID is 1 to 32 bytes.')
}

/**
 * The APs that would carry a network and cannot run its security; refused
 * when none of the managed carriers can (else they are warnings: "2 of 3").
 */
async function checkSecuritySupport(
  spec: Pick<WifiNetworkSpec, 'security' | 'apScope'> & { id: number },
  memberships: WifiNetworkApSpec[]
) {
  const aps = await ApConfig.query().where('mode', 'managed')
  const carrying = aps.filter((ap) => {
    const m = memberships.find((x) => x.networkId === spec.id && x.apId === ap.apId) ?? null
    return spec.apScope === 'all' ? m?.included !== false : m?.included === true
  })
  const lacking = carrying.filter(
    (ap) => supportsSecurity(ap.capabilities, spec.security) === false
  )
  if (carrying.length > 0 && lacking.length === carrying.length) {
    throw wifiError(
      422,
      'security_unsupported',
      'None of the access points can run that security.',
      {
        apIds: lacking.map((ap) => ap.apId),
      }
    )
  }
}

/** Issues of a network after a render (per AP, the render's). */
async function networkIssues(networkId: number): Promise<FleetIssue[]> {
  const settings = await getWifiConfigSettings()
  const fleet = await loadFleet()
  const aps = await ApConfig.query().whereIn('mode', ['observe', 'managed'])
  const out: FleetIssue[] = []
  for (const ap of aps) {
    const input = await renderInputOf(ap, fleet, settings)
    const { issues } = planSlots({ ...input, holds: [] })
    out.push(...issues.filter((i) => i.networkId === networkId))
  }
  return out
}

/**
 * Starts the rollout a write asks for (`?apply`, default on): the APs the
 * renders changed, restricted to those sections. A refusal (another
 * rollout, nothing to do) keeps the change and says why.
 */
async function rolloutFor(
  renders: Map<number, RenderOutcome>,
  options: {
    apply: boolean
    actor: PlaneActor | null
    networkIds: number[]
    kind?: 'change' | 'radios'
    adminAddress?: string | null
    extra?: RolloutTargets
  }
): Promise<Pick<WriteOutcome<unknown>, 'rollout' | 'rolloutError'>> {
  if (!options.apply) return { rollout: null, rolloutError: null }
  const targets: RolloutTargets = new Map(options.extra ?? [])
  for (const [apId, outcome] of renders) {
    const ids = new Set([...(targets.get(apId) ?? []), ...outcome.changed])
    const links = await WifiIfaceLink.query()
      .where('ap_id', apId)
      .whereIn('network_id', options.networkIds.length > 0 ? options.networkIds : [-1])
    for (const l of links) ids.add(l.perchId)
    if (ids.size > 0) targets.set(apId, [...ids])
  }
  if (targets.size === 0) {
    return {
      rollout: null,
      rolloutError: { error: 'nothing_to_apply', message: 'Nothing changes on the access points.' },
    }
  }
  try {
    const rollout = await createRollout({
      kind: options.kind ?? 'change',
      actor: options.actor,
      targets,
      networkIds: options.networkIds,
      adminAddress: options.adminAddress,
    })
    return { rollout, rolloutError: null }
  } catch (error) {
    if (error instanceof WifiPlaneError) {
      return { rollout: null, rolloutError: { error: error.code, message: error.message } }
    }
    throw error
  }
}

async function recordOnCarriers(
  networkId: number,
  event: Parameters<typeof recordApEvent>[1],
  options: { actor: PlaneActor | null; detail: Record<string, unknown> }
) {
  const links = await WifiIfaceLink.query().where('network_id', networkId).select('ap_id')
  const memberships = await WifiNetworkAp.query().where('network_id', networkId).select('ap_id')
  const managed = await ApConfig.query().whereIn('mode', ['observe', 'managed']).select('ap_id')
  const ids = new Set([
    ...links.map((l) => l.apId),
    ...memberships.map((m) => m.apId),
    ...managed.map((a) => a.apId),
  ])
  for (const apId of ids) {
    await recordApEvent(apId, event, { actor: options.actor, detail: options.detail })
  }
}

/** `POST /wifi/networks` (controller.md 7.2). */
export async function createNetwork(
  input: NetworkInput & { name: string; ssid: string; security: OfferedSecurity },
  user: User,
  options: { apply: boolean; adminAddress?: string | null }
): Promise<WriteOutcome<WifiNetwork>> {
  return fleetQueue.run(FLEET, async () => {
    const settings = await getWifiConfigSettings()
    checkSsid(input.ssid)
    if (!isOfferedSecurity(input.security)) {
      throw wifiError(422, 'security_unsupported', 'That security mode is not offered.')
    }
    const needsKey = input.security !== 'open' && input.security !== 'owe'
    if (needsKey && !input.passphrase) {
      throw wifiError(422, 'passphrase_required', 'This security mode needs a passphrase.')
    }
    if (needsKey && passphraseError(input.passphrase)) {
      throw wifiError(
        422,
        'passphrase_invalid',
        'The passphrase must be 8–63 printable characters, or 64 hex digits.'
      )
    }
    validateBinding(input.binding)
    const advanced: Advanced = { ...DEFAULT_ADVANCED, ...(input.advanced ?? {}) }
    if (pmfError(input.security, advanced.pmf)) {
      throw wifiError(422, 'invalid_config', 'WPA3 needs protected management frames.', {
        issues: [
          {
            severity: 'error',
            code: 'pmf_required',
            message: 'WPA3 needs protected management frames.',
          },
        ],
      })
    }
    const apScope: ApScope = input.apScope === 'selected' ? 'selected' : 'all'
    const bands = sortBands(input.bands && input.bands.length > 0 ? input.bands : ['2g', '5g'])
    const roaming: Roaming = {
      ...defaultRoaming(settings.newNetworkFastRoaming),
      ...(input.roaming ?? {}),
      mobilityDomain: input.roaming?.mobilityDomain ?? null,
    }
    await checkSecuritySupport(
      { id: -1, security: input.security, apScope },
      (input.apIds ?? []).map((apId) => ({
        networkId: -1,
        apId,
        included: true,
        bands: null,
        radios: null,
        overrides: {},
        radioOverrides: {},
      }))
    )
    const network = new WifiNetwork()
    await db.transaction(async (trx) => {
      let ref: string | null = null
      if (needsKey) {
        const secret = await storeWifiSecret(input.passphrase!, user.id, trx)
        ref = secret.ref
      }
      network.useTransaction(trx)
      fillNetwork(network, {
        name: input.name,
        ssid: input.ssid,
        enabled: input.enabled ?? true,
        security: input.security,
        passphraseRef: ref,
        hidden: input.hidden ?? false,
        isolate: input.isolate ?? false,
        binding: input.binding ?? { kind: 'lan' },
        bands,
        apScope,
        roaming,
        advanced,
        groups: false,
        origin: 'perch',
      })
      network.revision = 1
      network.createdByUserId = user.id
      network.updatedByUserId = user.id
      await network.save()
      if (apScope === 'selected') {
        for (const apId of [...new Set(input.apIds ?? [])]) {
          await WifiNetworkAp.create(
            {
              networkId: network.id,
              apId,
              included: true,
              bands: null,
              radios: null,
              overrides: {},
              radioOverrides: {},
            },
            { client: trx }
          )
        }
      }
    })
    const renders = await renderManagedAps(user.id)
    await recordOnCarriers(network.id, 'network_created', {
      actor: user.id,
      detail: { networkId: network.id, ssid: network.ssid },
    })
    const issues = await networkIssues(network.id)
    const started = await rolloutFor(renders, {
      apply: options.apply,
      actor: user.id,
      networkIds: [network.id],
      adminAddress: options.adminAddress,
    })
    await network.refresh()
    return { object: network, issues, ...started }
  })
}

/** Sets the fields of a patch on a spec (the draft the render sees). */
function patchedSpec(spec: WifiNetworkSpec, patch: NetworkInput): WifiNetworkSpec {
  return {
    ...spec,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.ssid !== undefined ? { ssid: patch.ssid } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.security !== undefined ? { security: patch.security } : {}),
    ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
    ...(patch.isolate !== undefined ? { isolate: patch.isolate } : {}),
    ...(patch.binding !== undefined ? { binding: patch.binding } : {}),
    ...(patch.bands !== undefined ? { bands: sortBands(patch.bands) } : {}),
    ...(patch.apScope !== undefined ? { apScope: patch.apScope } : {}),
    ...(patch.roaming !== undefined ? { roaming: { ...spec.roaming, ...patch.roaming } } : {}),
    ...(patch.advanced !== undefined ? { advanced: { ...spec.advanced, ...patch.advanced } } : {}),
  }
}

/**
 * The slots a spec would get that cannot be created because its passphrase
 * is unknown (controller.md 4.4: an unknown-key network cannot be extended).
 */
async function unknownKeyExtensions(
  spec: WifiNetworkSpec,
  memberships: WifiNetworkApSpec[]
): Promise<Array<{ apId: number; radio: string }>> {
  const settings = await getWifiConfigSettings()
  const fleet = await loadFleet()
  const aps = await ApConfig.query().where('mode', 'managed')
  const out: Array<{ apId: number; radio: string }> = []
  for (const ap of aps) {
    const input = await renderInputOf(ap, fleet, settings)
    const others = input.memberships.filter((m) => m.networkId !== spec.id)
    const { slots } = planSlots({
      ...input,
      networks: [...input.networks.filter((n) => n.id !== spec.id), spec],
      memberships: [...others, ...memberships.filter((m) => m.networkId === spec.id)],
      holds: [],
    })
    for (const slot of slots) {
      if (slot.networkId !== spec.id) continue
      if (slot.issues.some((i) => i.code === 'passphrase_unknown')) {
        out.push({ apId: ap.apId, radio: slot.radio })
      }
    }
  }
  return out
}

/** `PATCH /wifi/networks/:id` (controller.md 7.2). */
export async function updateNetwork(
  id: number,
  patch: NetworkInput & { currentPassword?: string },
  user: User,
  options: { apply: boolean; adminAddress?: string | null }
): Promise<WriteOutcome<WifiNetwork>> {
  return fleetQueue.run(FLEET, async () => {
    const network = await findNetwork(id)
    const spec = networkSpecOf(network)
    if (patch.ssid !== undefined) checkSsid(patch.ssid)
    if (patch.security !== undefined && !isOfferedSecurity(patch.security)) {
      throw wifiError(422, 'security_unsupported', 'That security mode is not offered.')
    }
    validateBinding(patch.binding)
    const next = patchedSpec(spec, patch)
    const needsKey = next.security !== 'open' && next.security !== 'owe'
    if (patch.passphrase !== undefined && passphraseError(patch.passphrase)) {
      throw wifiError(
        422,
        'passphrase_invalid',
        'The passphrase must be 8–63 printable characters, or 64 hex digits.'
      )
    }
    if (pmfError(next.security, next.advanced.pmf)) {
      throw wifiError(422, 'invalid_config', 'WPA3 needs protected management frames.', {
        issues: [
          {
            severity: 'error',
            code: 'pmf_required',
            message: 'WPA3 needs protected management frames.',
          },
        ],
      })
    }
    // Operations.md 1: weakening a network fleet-wide needs the password.
    const downgrade =
      (patch.security !== undefined && isSecurityDowngrade(spec.security, patch.security)) ||
      (patch.isolate === false && spec.isolate)
    if (downgrade && !(await verifyPassword(user, patch.currentPassword))) {
      throw wifiError(403, 'invalid_password', 'Weakening a network needs your current password.', {
        stepUp: true,
      })
    }
    // A key-less network becoming WPA needs one now.
    if (needsKey && !spec.passphraseRef && patch.passphrase === undefined) {
      if (spec.security === 'open' || spec.security === 'owe') {
        throw wifiError(422, 'passphrase_required', 'This security mode needs a passphrase.')
      }
    }
    const membershipRows = await WifiNetworkAp.query().where('network_id', id)
    const memberships = membershipRows.map(membershipSpecOf)
    if (needsKey && !spec.passphraseRef && patch.passphrase === undefined) {
      const extensions = await unknownKeyExtensions(
        next,
        applyApIds(memberships, next, patch.apIds)
      )
      if (extensions.length > 0) {
        throw wifiError(
          409,
          'passphrase_unknown',
          'Enter this network’s passphrase before extending it.',
          {
            slots: extensions,
          }
        )
      }
    }
    await checkSecuritySupport(next, applyApIds(memberships, next, patch.apIds))
    let oldRef: string | null = null
    await db.transaction(async (trx) => {
      let ref = spec.passphraseRef
      if (patch.passphrase !== undefined && needsKey) {
        oldRef = spec.passphraseRef
        const secret = await storeWifiSecret(patch.passphrase, user.id, trx)
        ref = secret.ref
      }
      if (!needsKey) {
        oldRef = spec.passphraseRef
        ref = null
      }
      network.useTransaction(trx)
      fillNetwork(network, { ...next, passphraseRef: ref })
      network.revision = spec.revision + 1
      network.updatedByUserId = user.id
      await network.save()
      if (patch.apIds !== undefined && next.apScope === 'selected') {
        const wanted = new Set(patch.apIds)
        const rows = await WifiNetworkAp.query({ client: trx }).where('network_id', id)
        for (const row of rows) {
          if (!wanted.has(row.apId) && row.included !== false) {
            row.included = false
            await row.save()
          }
        }
        for (const apId of wanted) {
          const row = rows.find((r) => r.apId === apId)
          if (row) {
            if (row.included !== true) {
              row.included = true
              await row.save()
            }
          } else {
            await WifiNetworkAp.create(
              {
                networkId: id,
                apId,
                included: true,
                bands: null,
                radios: null,
                overrides: {},
                radioOverrides: {},
              },
              { client: trx }
            )
          }
        }
      }
    })
    const renders = await renderManagedAps(user.id)
    await dropSecretIfUnused(oldRef)
    await recordOnCarriers(
      id,
      patch.passphrase !== undefined ? 'passphrase_changed' : 'network_changed',
      {
        actor: user.id,
        detail: {
          networkId: id,
          fields: Object.keys(patch).filter((k) => k !== 'passphrase' && k !== 'currentPassword'),
        },
      }
    )
    if (patch.passphrase !== undefined) {
      emitWifiAlert({
        name: 'wifi.passphrase.changed',
        severity: 'info',
        source: { kind: 'wifi_network', id },
        dedupeKey: `wifi.passphrase.changed:${id}:${network.revision}`,
        payload: { networkId: id, userId: user.id },
      })
    }
    const issues = await networkIssues(id)
    const started = await rolloutFor(renders, {
      apply: options.apply,
      actor: user.id,
      networkIds: [id],
      adminAddress: options.adminAddress,
    })
    await network.refresh()
    return { object: network, issues, ...started }
  })
}

function applyApIds(
  memberships: WifiNetworkApSpec[],
  spec: WifiNetworkSpec,
  apIds: number[] | undefined
): WifiNetworkApSpec[] {
  if (apIds === undefined || spec.apScope !== 'selected') return memberships
  const wanted = new Set(apIds)
  const out = memberships.map((m) => ({ ...m, included: wanted.has(m.apId) ? true : false }))
  for (const apId of wanted) {
    if (!out.some((m) => m.apId === apId)) {
      out.push({
        networkId: spec.id,
        apId,
        included: true,
        bands: null,
        radios: null,
        overrides: {},
        radioOverrides: {},
      })
    }
  }
  return out
}

/**
 * `DELETE /wifi/networks/:id` (controller.md 7.2): the network goes; its
 * slots are deleted on the APs by the render (their links stay, with no
 * network, until the delete is confirmed) and a rollout removes them.
 */
export async function deleteNetwork(
  id: number,
  user: User,
  options: { apply: boolean; adminAddress?: string | null }
): Promise<WriteOutcome<null>> {
  return fleetQueue.run(FLEET, async () => {
    const network = await findNetwork(id)
    if (network.groups) {
      throw wifiError(409, 'network_carries_groups', 'Device group keys still use this network.')
    }
    const links = await WifiIfaceLink.query().where('network_id', id)
    const extra: RolloutTargets = new Map()
    for (const l of links) extra.set(l.apId, [...(extra.get(l.apId) ?? []), l.perchId])
    await recordOnCarriers(id, 'network_deleted', {
      actor: user.id,
      detail: { networkId: id, ssid: network.ssid },
    })
    const ref = network.passphraseRef
    await network.delete()
    const renders = await renderManagedAps(user.id)
    await dropSecretIfUnused(ref)
    const started = await rolloutFor(renders, {
      apply: options.apply,
      actor: user.id,
      networkIds: [],
      adminAddress: options.adminAddress,
      extra,
    })
    return { object: null, issues: [], ...started }
  })
}

/** The router fingerprints of every linked slot of a network (passphrase checks). */
async function slotFingerprints(
  networkId: number
): Promise<Array<{ apId: number; radio: string; fingerprint: string | null }>> {
  const links = await WifiIfaceLink.query().where('network_id', networkId)
  const out: Array<{ apId: number; radio: string; fingerprint: string | null }> = []
  for (const link of links) {
    const { states } = await loadApSections(link.apId)
    const row = states.find((s) => s.perchId === link.perchId)
    if (!row || row.router === null) continue
    out.push({
      apId: link.apId,
      radio: link.radio,
      fingerprint: row.router.secrets?.key?.fingerprint ?? null,
    })
  }
  return out
}

export type PassphraseOutcome = {
  network: WifiNetwork
  matches: Array<{ apId: number; radio: string; match: boolean }>
  rollout: import('#models/wifi_rollout').default | null
  rolloutError: { error: string; message: string } | null
}

/**
 * `POST /wifi/networks/:id/passphrase` (controller.md 5.5): an adopted
 * network's passphrase, typed once and verified against every AP's
 * fingerprint. All match (or no slot yet): stored, nothing to apply.
 * Some differ: 409 `passphrase_mismatch` with the ticks; `force` stores it
 * anyway and the mismatching APs get it by a rollout.
 */
export async function setPassphrase(
  id: number,
  passphrase: string,
  user: User,
  options: { force?: boolean; apply: boolean; adminAddress?: string | null }
): Promise<PassphraseOutcome> {
  return fleetQueue.run(FLEET, async () => {
    const network = await findNetwork(id)
    if (network.security === 'open' || network.security === 'owe') {
      throw wifiError(422, 'passphrase_invalid', 'This network has no passphrase.')
    }
    if (passphraseError(passphrase)) {
      throw wifiError(
        422,
        'passphrase_invalid',
        'The passphrase must be 8–63 printable characters, or 64 hex digits.'
      )
    }
    const fingerprint = await passphraseFingerprint(passphrase)
    const verdict = passphraseMatches(fingerprint, await slotFingerprints(id))
    if (!verdict.all && !options.force) {
      throw wifiError(
        409,
        'passphrase_mismatch',
        'That passphrase does not match what the access points use.',
        {
          matches: verdict.matches,
        }
      )
    }
    const oldRef = network.passphraseRef
    const secret = await storeWifiSecret(passphrase, user.id)
    network.passphraseRef = secret.ref
    network.revision = network.revision + 1
    network.updatedByUserId = user.id
    await network.save()
    const renders = await renderManagedAps(user.id)
    await dropSecretIfUnused(oldRef)
    await recordOnCarriers(id, oldRef ? 'passphrase_changed' : 'passphrase_set', {
      actor: user.id,
      detail: { networkId: id, matched: verdict.all },
    })
    let started: Pick<PassphraseOutcome, 'rollout' | 'rolloutError'> = {
      rollout: null,
      rolloutError: null,
    }
    if (!verdict.all) {
      started = await rolloutFor(renders, {
        apply: options.apply,
        actor: user.id,
        networkIds: [id],
        adminAddress: options.adminAddress,
      })
    }
    await network.refresh()
    return { network, matches: verdict.matches, ...started }
  })
}

/** `GET /wifi/networks/:id/passphrase`: reveal (admin, audited). */
export async function revealPassphrase(id: number, user: User): Promise<string> {
  const network = await findNetwork(id)
  const secret = network.passphraseRef
    ? await WifiSecret.findBy('ref', network.passphraseRef)
    : null
  if (!secret || secret.value === null) {
    throw wifiError(404, 'passphrase_unknown', 'Perch does not know this network’s passphrase.')
  }
  await recordOnCarriers(id, 'passphrase_revealed', {
    actor: user.id,
    detail: { networkId: id },
  })
  emitWifiAlert({
    name: 'wifi.passphrase.revealed',
    severity: 'info',
    source: { kind: 'wifi_network', id },
    dedupeKey: `wifi.passphrase.revealed:${id}:${Date.now()}`,
    payload: { networkId: id, userId: user.id },
  })
  return secret.value
}

export type NetworkApInput = {
  included?: boolean | null
  bands?: WifiBand[] | null
  radios?: string[] | null
  overrides?: NetworkOverrides
  radioOverrides?: RadioOverrides
}

/** `PUT /wifi/networks/:id/aps/:apId` (controller.md 7.2): this AP's membership. */
export async function putNetworkAp(
  id: number,
  apId: number,
  input: NetworkApInput,
  user: User,
  options: { apply: boolean; reset?: boolean; adminAddress?: string | null }
): Promise<WriteOutcome<WifiNetwork>> {
  return fleetQueue.run(FLEET, async () => {
    const network = await findNetwork(id)
    const ap = await ApConfig.find(apId)
    if (!ap) throw wifiError(404, 'ap_not_found', `No access point with id ${apId}.`)
    const present = presentRadios(ap.capabilities)
    for (const radio of input.radios ?? []) {
      if (!present.some((r) => r.section === radio)) {
        throw wifiError(
          422,
          'radio_unknown',
          `${radio} is not a working radio of this access point.`
        )
      }
    }
    for (const band of input.bands ?? []) {
      if (ap.capabilities?.radios && !present.some((r) => r.band === band)) {
        throw wifiError(422, 'band_unsupported', `This access point has no ${band} radio.`)
      }
    }
    const apNetwork = input.overrides?.apNetwork
    if (apNetwork !== undefined) {
      const known = new Set((ap.capabilities?.networks ?? []).map((n) => n.name))
      const { states } = await loadApSections(apId)
      for (const s of states)
        if (s.config === 'network' && s.type === 'interface') known.add(s.name)
      if (known.size > 0 && !known.has(apNetwork)) {
        throw wifiError(
          422,
          'ap_network_unknown',
          `The access point has no network "${apNetwork}".`
        )
      }
    }
    let row = await WifiNetworkAp.query().where('network_id', id).where('ap_id', apId).first()
    if (!row) {
      row = new WifiNetworkAp()
      row.networkId = id
      row.apId = apId
      row.included = null
      row.bands = null
      row.radios = null
      row.overrides = {}
      row.radioOverrides = {}
    }
    if (options.reset) {
      row.overrides = {}
      row.radioOverrides = {}
      row.bands = null
      row.radios = null
    } else {
      if (input.included !== undefined) row.included = input.included
      if (input.bands !== undefined)
        row.bands = input.bands === null ? null : sortBands(input.bands)
      if (input.radios !== undefined) row.radios = input.radios
      if (input.overrides !== undefined) row.overrides = cleanOverrides(input.overrides)
      if (input.radioOverrides !== undefined) row.radioOverrides = input.radioOverrides
    }
    await row.save()
    network.revision = network.revision + 1
    network.updatedByUserId = user.id
    await network.save()
    const spec = networkSpecOf(network)
    if (spec.passphraseRef === null && spec.security !== 'open' && spec.security !== 'owe') {
      const membershipRows = await WifiNetworkAp.query().where('network_id', id)
      const memberships = membershipRows.map(membershipSpecOf)
      const extensions = await unknownKeyExtensions(spec, memberships)
      if (extensions.length > 0) {
        throw wifiError(
          409,
          'passphrase_unknown',
          'Enter this network’s passphrase before extending it.',
          {
            slots: extensions,
          }
        )
      }
    }
    const renders = await renderManagedAps(user.id, [apId])
    await recordApEvent(apId, 'network_changed', {
      actor: user.id,
      detail: { networkId: id, membership: true },
    })
    const started = await rolloutFor(renders, {
      apply: options.apply,
      actor: user.id,
      networkIds: [id],
      adminAddress: options.adminAddress,
    })
    await network.refresh()
    return { object: network, issues: await networkIssues(id), ...started }
  })
}

function cleanOverrides(overrides: NetworkOverrides): NetworkOverrides {
  const out: NetworkOverrides = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value
  }
  return out
}

// ── divergences (controller.md 5.3 resolutions) ──────────────────────────

/** Options the template models, and how an AP value maps onto it. */
function flag(value: unknown): boolean {
  return typeof value === 'string' && flagText(value) === '1'
}

/** Which resolutions a divergence offers (the table of controller.md 5.3). */
export function resolutionsFor(
  d: Pick<OpenDivergence, 'kind' | 'option'>
): Array<Exclude<DivergenceResolution, 'auto'>> {
  switch (d.kind) {
    case 'removed':
      return ['override', 'revert']
    case 'added':
      return ['fleet', 'override', 'revert']
    case 'unassigned':
      return ['split']
    case 'country':
      return ['fleet', 'override', 'revert']
    default:
      break
  }
  switch (d.option) {
    case 'ssid':
    case 'encryption':
      return ['fleet', 'revert', 'split']
    case 'key':
      return ['fleet', 'override', 'revert']
    case 'hidden':
    case 'isolate':
    case 'disabled':
    case 'maxassoc':
    case 'dtim_period':
      return ['fleet', 'override', 'revert']
    case 'network':
      return ['fleet', 'override', 'revert']
    case 'ieee80211r':
    case 'mobility_domain':
    case 'ieee80211k':
    case 'bss_transition':
    case 'ieee80211w':
    case 'multicast_to_unicast_all':
      return ['fleet', 'revert']
    default:
      return ['revert']
  }
}

export type ResolveItem = { id: number; resolution: DivergenceResolution; passphrase?: string }

export type ResolveOutcome = {
  resolved: number[]
  rollout: import('#models/wifi_rollout').default | null
  rolloutError: { error: string; message: string } | null
}

const PMF_OF: Record<string, Advanced['pmf']> = {
  '0': 'disabled',
  '1': 'optional',
  '2': 'required',
}

/**
 * `POST /wifi/divergences/resolve` (controller.md 5.3): per item `fleet`
 * (the AP's value becomes the network's: other APs change), `override`
 * (this AP keeps it as an override), `revert` (the fleet value goes back to
 * this AP), `split` (a network of its own). Then the affected APs are
 * rendered and, unless `?apply=0`, a rollout starts. Weakening a network
 * fleet-wide (security down, isolation off, another key) needs the
 * password.
 */
export async function resolveDivergences(
  items: ResolveItem[],
  user: User,
  options: { apply: boolean; currentPassword?: string; adminAddress?: string | null }
): Promise<ResolveOutcome> {
  return fleetQueue.run(FLEET, async () => {
    const rows = await WifiDivergence.query().whereIn(
      'id',
      items.map((i) => i.id)
    )
    const closed = items.filter((i) => {
      const row = rows.find((r) => r.id === i.id)
      return !row || row.resolvedAt !== null
    })
    if (closed.length > 0) {
      throw wifiError(409, 'divergence_closed', 'Someone resolved that already.', {
        ids: closed.map((c) => c.id),
      })
    }
    for (const item of items) {
      const row = rows.find((r) => r.id === item.id)!
      if (!resolutionsFor(row).includes(item.resolution as never)) {
        throw wifiError(
          409,
          'resolution_not_allowed',
          'That choice does not apply to this change.',
          {
            id: item.id,
          }
        )
      }
    }
    // Operations.md 1: a weakening applied fleet-wide (another key, isolation
    // off, a weaker security) needs the password: a forged read must never be
    // one click away from opening every AP.
    let weakening = false
    for (const item of items) {
      const row = rows.find((r) => r.id === item.id)!
      if (item.resolution !== 'fleet' || row.kind !== 'option' || row.networkId === null) continue
      if (row.option === 'key') weakening = true
      if (row.option === 'isolate' && !flag(row.apValue)) weakening = true
      if (row.option === 'encryption') {
        const network = await WifiNetwork.find(row.networkId)
        const to = securityOfEncryption(typeof row.apValue === 'string' ? row.apValue : null)
        if (network && to && isSecurityDowngrade(network.security, to)) weakening = true
      }
    }
    if (weakening && !(await verifyPassword(user, options.currentPassword))) {
      throw wifiError(
        403,
        'invalid_password',
        'Applying a weaker setting to every AP needs your current password.',
        { stepUp: true }
      )
    }
    const affected = new Set<number>()
    const networkIds = new Set<number>()
    let fleetWide = false
    const now = DateTime.utc()
    for (const item of items) {
      const row = rows.find((r) => r.id === item.id)!
      const effect = await resolveOne(row, item, user)
      affected.add(row.apId)
      if (row.networkId !== null) networkIds.add(row.networkId)
      if (effect.fleetWide) fleetWide = true
      row.resolvedAt = now
      row.resolution = item.resolution
      row.resolvedByUserId = user.id
      await row.save()
      await recordApEvent(row.apId, 'divergence_resolved', {
        userId: user.id,
        detail: {
          divergenceId: row.id,
          kind: row.kind,
          option: row.option,
          resolution: item.resolution,
        },
      })
    }
    const renders = await renderManagedAps(user.id, fleetWide ? undefined : [...affected])
    const started = await rolloutFor(renders, {
      apply: options.apply,
      actor: user.id,
      networkIds: [...networkIds],
      adminAddress: options.adminAddress,
    })
    return { resolved: items.map((i) => i.id), ...started }
  })
}

async function membershipRow(networkId: number, apId: number): Promise<WifiNetworkAp> {
  const row = await WifiNetworkAp.query()
    .where('network_id', networkId)
    .where('ap_id', apId)
    .first()
  if (row) return row
  const created = new WifiNetworkAp()
  created.networkId = networkId
  created.apId = apId
  created.included = null
  created.bands = null
  created.radios = null
  created.overrides = {}
  created.radioOverrides = {}
  return created
}

/** Other radios of this AP that carry the network (links). */
async function otherLinkedRadios(networkId: number, apId: number, radio: string | null) {
  const links = await WifiIfaceLink.query().where('network_id', networkId).where('ap_id', apId)
  return [...new Set(links.map((l) => l.radio).filter((r) => r !== radio))]
}

async function resolveOne(
  row: WifiDivergence,
  item: ResolveItem,
  user: User
): Promise<{ fleetWide: boolean }> {
  const resolution = item.resolution
  if (row.kind === 'country') {
    const ap = await ApConfig.findOrFail(row.apId)
    const code = normalizeCountry(row.apValue)
    if (resolution === 'fleet') {
      if (!code)
        throw wifiError(409, 'resolution_not_allowed', 'The AP has no country to take.', {
          id: row.id,
        })
      await updateWifiConfigSettings({ countryDefault: code })
      await recordApEvent(row.apId, 'country_changed', { userId: user.id, detail: { fleet: code } })
      return { fleetWide: true }
    }
    if (resolution === 'override') {
      if (!code)
        throw wifiError(409, 'resolution_not_allowed', 'The AP has no country to keep.', {
          id: row.id,
        })
      ap.countryMode = 'fixed'
      ap.country = code
      await ap.save()
      await recordApEvent(row.apId, 'country_changed', { userId: user.id, detail: { fixed: code } })
    }
    return { fleetWide: false }
  }
  if (row.kind === 'removed') {
    // The stale link goes either way: `revert` lets the render put the slot
    // back (a new section), `override` drops this AP/radio from the network.
    if (row.perchId) {
      await WifiIfaceLink.query().where('ap_id', row.apId).where('perch_id', row.perchId).delete()
    }
    if (resolution === 'override' && row.networkId !== null) {
      await excludeRadio(row.networkId, row.apId, row.radio)
    }
    return { fleetWide: false }
  }
  if (row.kind === 'added') {
    if (row.networkId === null) return { fleetWide: false }
    const network = await findNetwork(row.networkId)
    const ap = await ApConfig.findOrFail(row.apId)
    const band = (ap.capabilities?.radios ?? []).find((r) => r.section === row.radio)?.band ?? null
    if (resolution === 'fleet') {
      if (
        band &&
        (band === '2g' || band === '5g' || band === '6g') &&
        !network.bands.includes(band)
      ) {
        network.bands = sortBands([...network.bands, band])
      }
      const m = await membershipRow(network.id, row.apId)
      if (network.apScope === 'selected') m.included = true
      else if (m.included === false) m.included = null
      await m.save()
      network.revision++
      await network.save()
      return { fleetWide: true }
    }
    if (resolution === 'override') {
      const m = await membershipRow(network.id, row.apId)
      m.included = true
      if (row.radio) {
        const linked = await otherLinkedRadios(network.id, row.apId, null)
        m.radios = [...new Set([...(m.radios ?? linked), row.radio])].sort()
      }
      await m.save()
    }
    return { fleetWide: false }
  }
  if (row.kind === 'unassigned') {
    await splitSlot(row, user)
    return { fleetWide: false }
  }
  // kind option
  if (row.networkId === null) return { fleetWide: false }
  const network = await findNetwork(row.networkId)
  const option = row.option ?? ''
  const value = row.apValue
  if (resolution === 'revert') {
    if (option === 'key' && network.passphraseRef === null) {
      throw wifiError(409, 'passphrase_unknown', 'Enter this network’s passphrase first.', {
        id: row.id,
      })
    }
    return { fleetWide: false }
  }
  if (resolution === 'split') {
    await splitSlot(row, user)
    return { fleetWide: false }
  }
  if (resolution === 'override') {
    const m = await membershipRow(network.id, row.apId)
    const overrides: NetworkOverrides = { ...(m.overrides ?? {}) }
    const radioOverrides: RadioOverrides = { ...(m.radioOverrides ?? {}) }
    switch (option) {
      case 'hidden':
        overrides.hidden = flag(value)
        break
      case 'isolate':
        overrides.isolate = flag(value)
        break
      case 'disabled': {
        const others = await otherLinkedRadios(network.id, row.apId, row.radio)
        if (others.length === 0) overrides.enabled = !flag(value)
        else if (row.radio) radioOverrides[row.radio] = { enabled: !flag(value) }
        break
      }
      case 'network': {
        const name = Array.isArray(value) ? value[0] : value
        if (typeof name !== 'string') {
          throw wifiError(409, 'resolution_not_allowed', 'No network name to keep.', { id: row.id })
        }
        overrides.apNetwork = name
        break
      }
      case 'maxassoc': {
        const n = intOf(typeof value === 'string' ? value : null)
        if (n === null) delete overrides.maxClients
        else overrides.maxClients = n
        break
      }
      case 'dtim_period': {
        const n = intOf(typeof value === 'string' ? value : null)
        if (n === null) delete overrides.dtimPeriod
        else overrides.dtimPeriod = n
        break
      }
      case 'key':
        overrides.keepKey = true
        break
      default:
        throw wifiError(
          409,
          'resolution_not_allowed',
          'That choice does not apply to this change.',
          { id: row.id }
        )
    }
    m.overrides = overrides
    m.radioOverrides = radioOverrides
    await m.save()
    return { fleetWide: false }
  }
  // fleet: the AP's value becomes the network's.
  const scalar = typeof value === 'string' ? value : null
  switch (option) {
    case 'ssid':
      if (!scalar)
        throw wifiError(409, 'resolution_not_allowed', 'No SSID to take.', { id: row.id })
      checkSsid(scalar)
      network.ssid = scalar
      break
    case 'encryption': {
      const security = securityOfEncryption(scalar)
      if (!security || security === 'wpa_wpa2') {
        throw wifiError(409, 'resolution_not_allowed', 'That security mode is not offered.', {
          id: row.id,
        })
      }
      network.security = security
      break
    }
    case 'hidden':
      network.hidden = flag(value)
      break
    case 'isolate':
      network.isolate = flag(value)
      break
    case 'disabled':
      network.enabled = !flag(value)
      break
    case 'network': {
      const ap = await ApConfig.findOrFail(row.apId)
      const name = Array.isArray(value) ? value[0] : value
      if (name !== (ap.managementPath?.network ?? null)) {
        throw wifiError(
          409,
          'resolution_not_allowed',
          'Only the AP’s own LAN maps to a fleet binding.',
          {
            id: row.id,
          }
        )
      }
      network.binding = { kind: 'lan' }
      break
    }
    case 'ieee80211r':
      network.roaming = { ...network.roaming, ft: flag(value) }
      break
    case 'mobility_domain':
      network.roaming = { ...network.roaming, mobilityDomain: scalar ? scalar.toLowerCase() : null }
      break
    case 'ieee80211k':
      network.roaming = { ...network.roaming, rrm: flag(value) }
      break
    case 'bss_transition':
      network.roaming = { ...network.roaming, btm: flag(value) }
      break
    case 'ieee80211w':
      network.advanced = {
        ...network.advanced,
        pmf: scalar === null ? 'default' : (PMF_OF[scalar.trim()] ?? 'default'),
      }
      break
    case 'multicast_to_unicast_all':
      network.advanced = {
        ...network.advanced,
        multicastToUnicast: scalar === null ? null : flag(value),
      }
      break
    case 'maxassoc':
      network.advanced = { ...network.advanced, maxClients: intOf(scalar) }
      break
    case 'dtim_period':
      network.advanced = { ...network.advanced, dtimPeriod: intOf(scalar) }
      break
    case 'key': {
      if (!item.passphrase) {
        throw wifiError(422, 'passphrase_required', 'Type the passphrase this AP uses.', {
          id: row.id,
        })
      }
      if (passphraseError(item.passphrase)) {
        throw wifiError(
          422,
          'passphrase_invalid',
          'The passphrase must be 8–63 printable characters, or 64 hex digits.'
        )
      }
      const apFingerprint =
        typeof value === 'object' && value !== null
          ? (value as { fingerprint?: string }).fingerprint
          : null
      if ((await passphraseFingerprint(item.passphrase)) !== apFingerprint) {
        throw wifiError(422, 'passphrase_mismatch', 'That is not the passphrase this AP uses.', {
          id: row.id,
        })
      }
      const oldRef = network.passphraseRef
      const secret = await storeWifiSecret(item.passphrase, user.id)
      network.passphraseRef = secret.ref
      network.revision++
      await network.save()
      await dropSecretIfUnused(oldRef)
      return { fleetWide: true }
    }
    default:
      throw wifiError(409, 'resolution_not_allowed', 'That choice does not apply to this change.', {
        id: row.id,
      })
  }
  network.revision++
  network.updatedByUserId = user.id
  await network.save()
  return { fleetWide: true }
}

/** Takes one AP radio out of a network (`removed` → override). */
async function excludeRadio(networkId: number, apId: number, radio: string | null) {
  const m = await membershipRow(networkId, apId)
  const others = await otherLinkedRadios(networkId, apId, radio)
  if (others.length === 0 || radio === null) m.included = false
  else m.radios = others.sort()
  await m.save()
}

/**
 * `split` (controller.md 5.3): this AP's slot becomes a network of its own
 * (origin `router`, scoped to this AP), leaving the old network there.
 */
async function splitSlot(row: WifiDivergence, user: User) {
  if (!row.perchId) {
    throw wifiError(409, 'resolution_not_allowed', 'Nothing to split.', { id: row.id })
  }
  const { states } = await loadApSections(row.apId)
  const section = states.find((s) => s.perchId === row.perchId)
  const content = section?.desired ?? section?.router
  if (!section || !content) {
    throw wifiError(409, 'resolution_not_allowed', 'The interface is gone.', { id: row.id })
  }
  const ap = await ApConfig.findOrFail(row.apId)
  const f = ifaceFields(content.options)
  const band = (ap.capabilities?.radios ?? []).find((r) => r.section === f.radio)?.band ?? null
  const network = new WifiNetwork()
  fillNetwork(network, {
    name: f.ssid,
    ssid: f.ssid,
    enabled: true,
    security: f.security,
    passphraseRef: null,
    hidden: f.hidden,
    isolate: f.isolate,
    binding:
      ap.managementPath?.network && f.networks.join(' ') === ap.managementPath.network
        ? { kind: 'lan' }
        : { kind: 'ap_network' },
    bands: band === '2g' || band === '5g' || band === '6g' ? [band] : [],
    apScope: 'selected',
    roaming: { ft: f.ft, mobilityDomain: f.mobilityDomain, rrm: f.rrm, btm: f.btm },
    advanced: {
      ...DEFAULT_ADVANCED,
      pmf: f.pmf,
      multicastToUnicast: f.multicastToUnicast,
      maxClients: f.maxClients,
      dtimPeriod: f.dtimPeriod,
    },
    groups: false,
    origin: 'router',
  })
  network.revision = 1
  network.createdByUserId = user.id
  await network.save()
  const overrides: NetworkOverrides = {}
  if (network.binding.kind === 'ap_network' && f.networks[0]) overrides.apNetwork = f.networks[0]
  await WifiNetworkAp.create({
    networkId: network.id,
    apId: row.apId,
    included: true,
    bands: null,
    radios: [f.radio],
    overrides,
    radioOverrides: {},
  })
  const oldNetworkId = row.networkId
  await WifiIfaceLink.updateOrCreate(
    { apId: row.apId, perchId: row.perchId },
    { networkId: network.id, radio: f.radio, origin: 'router' }
  )
  if (oldNetworkId !== null) await excludeRadio(oldNetworkId, row.apId, f.radio)
  // The other divergences of that slot belong to the old network: closed.
  await WifiDivergence.query()
    .where('ap_id', row.apId)
    .where('perch_id', row.perchId)
    .whereNull('resolved_at')
    .whereNot('id', row.id)
    .update({ resolved_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'), resolution: 'split' })
}

// ── adoption (controller.md 5.4) ─────────────────────────────────────────

/** Every AP in observe or managed mode with its rows (adoption's input). */
export async function adoptionInput(): Promise<AdoptionInput> {
  const aps = await ApConfig.query().whereIn('mode', ['observe', 'managed']).orderBy('ap_id')
  const names = await apNames(aps.map((a) => a.apId))
  const list: AdoptionAp[] = []
  for (const ap of aps) {
    const loaded = await loadApSections(ap.apId)
    list.push({
      id: ap.apId,
      name: names.get(ap.apId) ?? `AP ${ap.apId}`,
      mode: normalizeApMode(ap.mode),
      caps: ap.capabilities,
      management: { network: ap.managementPath?.network ?? null },
      rows: loaded.states,
    })
  }
  const linkRows = await WifiIfaceLink.query()
  const links = linkRows.map(linkSpecOf)
  const timeZone = await SystemSetting.get<string>('timezone')
  return { aps: list, links, timeZone: typeof timeZone === 'string' ? timeZone : null }
}

export async function adoptionProposals(): Promise<AdoptionResult> {
  return proposeAdoption(await adoptionInput())
}

export type AdoptionAcceptItem = AdoptionRequestItem & { passphrase?: string }

export type AdoptionOutcome = {
  networks: WifiNetwork[]
  divergences: number
  passphrases: Array<{
    key: string
    networkId: number
    stored: boolean
    matches: Array<{ apId: number; radio: string; match: boolean }>
  }>
}

/**
 * `POST /wifi/adoption` (controller.md 5.4): networks, memberships and links
 * from the accepted proposals in one transaction; left-out proposals'
 * sections become router-only (`excluded`); the fleet and per-AP country
 * policies; nothing is written to any AP (the ledger entries go out as
 * adopt jobs when each AP enters managed). A passphrase given with a
 * proposal is verified against every member's fingerprint and stored when
 * all match.
 */
export async function acceptAdoption(
  input: {
    proposals: AdoptionAcceptItem[]
    countryDefault?: string | null
    countries?: Record<string, { mode: CountryMode; code?: string | null }>
  },
  user: User
): Promise<AdoptionOutcome> {
  return fleetQueue.run(FLEET, async () => {
    const adoption = await adoptionInput()
    const plan = planAdoption(
      adoption,
      input.proposals.map(({ passphrase: _p, ...rest }) => rest)
    )
    if (!plan.ok) {
      if (plan.error === 'adoption_changed') {
        throw wifiError(
          409,
          'adoption_changed',
          'The access points changed: review the list again.',
          {
            keys: plan.keys,
          }
        )
      }
      throw wifiError(422, 'merge_incompatible', 'Those networks cannot be merged.', {
        key: plan.key,
        with: plan.with,
      })
    }
    const created: Array<{ key: string; network: WifiNetwork }> = []
    const now = DateTime.utc()
    await db.transaction(async (trx) => {
      for (const adopted of plan.networks) {
        const network = new WifiNetwork()
        network.useTransaction(trx)
        fillNetwork(network, adopted.spec)
        network.revision = 1
        network.createdByUserId = user.id
        network.updatedByUserId = user.id
        await network.save()
        for (const m of adopted.memberships) {
          await WifiNetworkAp.create(
            {
              networkId: network.id,
              apId: m.apId,
              included: m.included,
              bands: m.bands,
              radios: m.radios,
              overrides: m.overrides,
              radioOverrides: m.radioOverrides,
            },
            { client: trx }
          )
        }
        for (const l of adopted.links) {
          await WifiIfaceLink.updateOrCreate(
            { apId: l.apId, perchId: l.perchId },
            { networkId: network.id, radio: l.radio, origin: l.origin },
            { client: trx }
          )
        }
        created.push({ key: adopted.key, network })
      }
      // Left out: router-only (excluded), so no reconcile turns them into networks.
      const byAp = new Map<number, string[]>()
      for (const e of plan.excluded) byAp.set(e.apId, [...(byAp.get(e.apId) ?? []), e.perchId])
      for (const [apId, perchIds] of byAp) {
        const loaded = await loadApSections(apId, trx)
        const changes = loaded.states
          .filter((s) => perchIds.includes(s.perchId) && s.router !== null)
          .map((s) => {
            const next: SectionState = {
              ...s,
              scope: 'excluded',
              base: cloneContent(s.router),
              desired: cloneContent(s.router),
              conflict: null,
              driftSince: null,
              status: 'in_sync',
            }
            next.status = deriveStatus(next, { authoritative: false })
            return { perchId: s.perchId, after: next }
          })
        await saveApStates(apId, loaded.rows, changes, { userId: user.id, trx })
      }
    })
    if (input.countryDefault !== undefined) {
      await updateWifiConfigSettings({ countryDefault: normalizeCountry(input.countryDefault) })
    }
    for (const [apIdText, policy] of Object.entries(input.countries ?? {})) {
      const ap = await ApConfig.find(Number(apIdText))
      if (!ap) continue
      ap.countryMode = policy.mode
      ap.country = policy.mode === 'fixed' ? normalizeCountry(policy.code ?? null) : null
      await ap.save()
    }
    for (const ap of adoption.aps) {
      await recordApEvent(ap.id, 'adopted', {
        userId: user.id,
        detail: {
          networks: created.map((c) => c.network.id),
          excluded: plan.excluded.filter((e) => e.apId === ap.id).length,
          at: now.toISO(),
        },
      })
      try {
        await reconcileApFleet(ap.id)
      } catch (error) {
        logger.warn(
          { apId: ap.id, error: (error as Error).message },
          'wifi_config: reconcile after adoption failed'
        )
      }
    }
    const passphrases: AdoptionOutcome['passphrases'] = []
    for (const item of input.proposals) {
      if (!item.passphrase) continue
      const entry = created.find((c) => c.key === item.key)
      if (!entry || passphraseError(item.passphrase)) continue
      const fingerprint = await passphraseFingerprint(item.passphrase)
      const verdict = passphraseMatches(fingerprint, await slotFingerprints(entry.network.id))
      if (verdict.all) {
        const secret = await storeWifiSecret(item.passphrase, user.id)
        entry.network.passphraseRef = secret.ref
        await entry.network.save()
      }
      passphrases.push({
        key: item.key,
        networkId: entry.network.id,
        stored: verdict.all,
        matches: verdict.matches,
      })
    }
    if (passphrases.some((p) => p.stored)) await renderManagedAps(user.id)
    const divergences = await WifiDivergence.query().whereNull('resolved_at').count('* as total')
    for (const c of created) await c.network.refresh()
    return {
      networks: created.map((c) => c.network),
      divergences: Number(divergences[0].$extras.total),
      passphrases,
    }
  })
}

/** The number of proposals adoption would show now (the overview's `adoptionPending`). */
export async function adoptionPendingCount(): Promise<number> {
  const input = await adoptionInput()
  if (input.aps.length === 0) return 0
  return proposeAdoption(input).proposals.length
}

// ── a preview of unsaved edits ───────────────────────────────────────────

export type NetworkDraft = {
  network: NetworkInput & { id?: number | null }
  aps?: Array<NetworkApInput & { apId: number }>
}

/**
 * `POST /wifi/rollouts/preview {draft}`: what a network edit the admin has
 * not saved yet would do (controller.md 6.3), from an in-memory render:
 * nothing is stored, so closing the editor leaves no draft behind.
 */
export async function previewNetworkDraft(
  draft: NetworkDraft,
  options: { adminAddress?: string | null } = {}
): Promise<ImpactPreview> {
  const settings = await getWifiConfigSettings()
  const fleet = await loadFleet()
  const id = draft.network.id ?? 0
  const base = id ? fleet.specs.find((n) => n.id === id) : null
  if (id && !base) throw wifiError(404, 'network_not_found', `No network with id ${id}.`)
  const input = draft.network
  if (input.ssid !== undefined) checkSsid(input.ssid)
  validateBinding(input.binding)
  let spec: WifiNetworkSpec = base
    ? patchedSpec(base, input)
    : {
        id: 0,
        name: input.name ?? input.ssid ?? 'New network',
        ssid: input.ssid ?? '',
        enabled: input.enabled ?? true,
        security: input.security ?? 'wpa2',
        passphraseRef: null,
        hidden: input.hidden ?? false,
        isolate: input.isolate ?? false,
        binding: input.binding ?? { kind: 'lan' },
        bands: sortBands(input.bands && input.bands.length > 0 ? input.bands : ['2g', '5g']),
        apScope: input.apScope === 'selected' ? 'selected' : 'all',
        roaming: {
          ...defaultRoaming(settings.newNetworkFastRoaming),
          ...(input.roaming ?? {}),
          mobilityDomain: input.roaming?.mobilityDomain ?? null,
        },
        advanced: { ...DEFAULT_ADVANCED, ...(input.advanced ?? {}) },
        groups: false,
        origin: 'perch',
        revision: 0,
      }
  const secrets = { ...fleet.secrets }
  if (input.passphrase) {
    if (passphraseError(input.passphrase)) {
      throw wifiError(
        422,
        'passphrase_invalid',
        'The passphrase must be 8–63 printable characters, or 64 hex digits.'
      )
    }
    secrets.__draft = { fingerprint: await passphraseFingerprint(input.passphrase) }
    spec = { ...spec, passphraseRef: '__draft' }
  }
  let memberships = fleet.memberships.filter((m) => m.networkId === spec.id)
  memberships = applyApIds(memberships, spec, input.apIds)
  for (const edit of draft.aps ?? []) {
    const existing = memberships.find((m) => m.apId === edit.apId)
    const next: WifiNetworkApSpec = existing
      ? { ...existing }
      : {
          networkId: spec.id,
          apId: edit.apId,
          included: null,
          bands: null,
          radios: null,
          overrides: {},
          radioOverrides: {},
        }
    if (edit.included !== undefined) next.included = edit.included
    if (edit.bands !== undefined) next.bands = edit.bands === null ? null : sortBands(edit.bands)
    if (edit.radios !== undefined) next.radios = edit.radios
    if (edit.overrides !== undefined) next.overrides = cleanOverrides(edit.overrides)
    if (edit.radioOverrides !== undefined) next.radioOverrides = edit.radioOverrides
    memberships = [...memberships.filter((m) => m.apId !== edit.apId), next]
  }
  const draftFleet: FleetData = {
    ...fleet,
    specs: [...fleet.specs.filter((n) => n.id !== spec.id), spec],
    memberships: [...fleet.memberships.filter((m) => m.networkId !== spec.id), ...memberships],
    secrets,
  }
  const targets: RolloutTargets = new Map()
  const states = new Map<number, SectionState[]>()
  for (const ap of await ApConfig.query().where('mode', 'managed').orderBy('ap_id')) {
    const loaded = await loadApSections(ap.apId)
    const renderInput = await renderInputOf(ap, draftFleet, settings, loaded.states)
    const flight = await inFlightApApply(ap.apId)
    const applied = applyRenderEdits(
      ap,
      loaded.states,
      renderAp(renderInput),
      flight?.perchIds ?? []
    )
    const changed = new Set([...applied.upserted.keys(), ...applied.deleted])
    for (const link of fleet.links) {
      if (link.apId === ap.apId && link.networkId === spec.id && id !== 0) changed.add(link.perchId)
    }
    if (changed.size === 0) continue
    // Deleted controller-only rows vanish; everything else keeps its row.
    states.set(ap.apId, [...applied.candidate.values()])
    targets.set(
      ap.apId,
      [...changed].filter(
        (perchId) => applied.candidate.has(perchId) || !applied.deleted.has(perchId)
      )
    )
  }
  if (targets.size === 0)
    throw wifiError(409, 'nothing_to_apply', 'Nothing changes on the access points.')
  const plan = await planRollout({
    kind: 'change',
    actor: null,
    targets,
    states,
    adminAddress: options.adminAddress,
  })
  return plan.preview
}

// ── per-AP settings that change what the render writes ───────────────────

/**
 * An AP's country policy (decision D10): its open country divergences are
 * settled by the admin's explicit choice, and the render writes the policy.
 */
export async function setApCountry(
  apId: number,
  policy: { mode: CountryMode; code?: string | null },
  user: User
): Promise<void> {
  const ap = await ApConfig.findOrFail(apId)
  if (policy.mode === 'fixed') {
    const code = normalizeCountry(policy.code ?? null)
    if (!code) throw wifiError(422, 'country_invalid', 'That is not a country code.')
    ap.country = code
  } else {
    ap.country = null
  }
  ap.countryMode = policy.mode
  await ap.save()
  await WifiDivergence.query()
    .where('ap_id', apId)
    .where('kind', 'country')
    .whereNull('resolved_at')
    .update({
      resolved_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
      resolution: policy.mode === 'fixed' ? 'override' : 'revert',
      resolved_by_user_id: user.id,
    })
  await recordApEvent(apId, 'country_changed', {
    userId: user.id,
    detail: { mode: policy.mode, code: ap.country },
  })
}

/** Rolls out what the renders changed on one AP (the PATCH-with-`apply` helper). */
export async function rolloutRenders(
  renders: Map<number, RenderOutcome>,
  options: {
    apply: boolean
    actor: PlaneActor | null
    kind?: 'change' | 'radios'
    networkIds?: number[]
    adminAddress?: string | null
    extra?: RolloutTargets
  }
) {
  return rolloutFor(renders, { networkIds: [], ...options })
}

export { apSession }
