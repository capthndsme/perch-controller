import ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import type ApConfigEvent from '#models/ap_config_event'
import type ApConfigRevision from '#models/ap_config_revision'
import type ApConfigSection from '#models/ap_config_section'
import WifiAccessPoint from '#models/wifi_access_point'
import WifiDivergence from '#models/wifi_divergence'
import WifiIfaceLink from '#models/wifi_iface_link'
import type WifiNetwork from '#models/wifi_network'
import type WifiRollout from '#models/wifi_rollout'
import WifiRolloutStep from '#models/wifi_rollout_step'
import WifiSecret from '#models/wifi_secret'
import { revertDueAt } from '#services/gateway_config/sync_engine'
import type { SecretSlot, SectionContent, UciOptions } from '#services/gateway_config/types'
import {
  connectedStations,
  countClients,
  type ConnectedStation,
} from '#services/wifi_config/clients'
import { WIFI_IFACES_DOMAIN, WIFI_RADIOS_DOMAIN } from '#services/wifi_config/domains/index'
import { scalarOf } from '#services/wifi_config/domains/normalize'
import { radioFields } from '#services/wifi_config/domains/wifi_radios'
import { carries } from '#services/wifi_config/fleet/model'
import { planSlots, type SlotPlan } from '#services/wifi_config/fleet/render'
import {
  countryPolicyOf,
  loadFleet,
  networkSpecOf,
  openDivergenceRows,
  renderInputOf,
  resolutionsFor,
  type FleetData,
} from '#services/wifi_config/fleet_service'
import {
  apDisplayName,
  apSession,
  normalizeApMode,
  writeAccess,
  WIFI_CONFIG_CAPABILITY,
} from '#services/wifi_config/registry'
import { openApApplies, apSectionState, loadApSections } from '#services/wifi_config/store'
import type { WifiConfigSettings } from '#services/wifi_config/settings'
import type { SectionState } from '#services/gateway_config/sync_engine'
import { actorRef, userRefs } from '#transformers/gateway_transformer'
import type { DateTime } from 'luxon'

/**
 * Wire shapes of the Wi-Fi REST API (docs/design/wifi controller.md section
 * 7.1; `dashboard/src/types/wifi-config.ts` mirrors them): `ApConfig`,
 * `ApApply`, the per-AP plane's sections, revisions and events (the
 * gateway's shapes), `WifiNetwork`, `WifiRadio`, `WifiDivergence`,
 * `WifiRollout`. Secrets never appear: a secret option is its fingerprint.
 */

type UserRef = { id: number; email: string } | null

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}

// ── ApApply ──────────────────────────────────────────────────────────────

export function apApplyView(
  apply: ApConfigApply,
  users: Map<number, UserRef>,
  options: { changes?: boolean } = {}
) {
  const o = apply.outcome
  const outcome = o
    ? {
        ...(o.reason ? { reason: String(o.reason) } : {}),
        ...(o.error ? { error: String(o.error) } : {}),
        ...(o.message ? { message: String(o.message) } : {}),
        ...(o.discardedConfigs ? { discardedConfigs: o.discardedConfigs } : {}),
        ...(o.assumed ? { assumed: true } : {}),
        ...(o.data && typeof o.data === 'object'
          ? { data: o.data as Record<string, unknown> }
          : {}),
      }
    : null
  return {
    id: apply.applyKey,
    kind: apply.kind,
    state: apply.state,
    confirmMode: apply.confirmMode,
    confirmTimeoutSeconds: apply.confirmTimeoutSeconds,
    protected: Boolean(apply.protected),
    signed: Boolean(apply.signed),
    deadlineAt: iso(apply.deadlineAt),
    confirmations: { agent: iso(apply.agentConfirmedAt), admin: iso(apply.adminConfirmedAt) },
    agentReconnectedAt: iso(apply.agentReconnectedAt),
    requestedBy: actorRef(apply.requestedByUserId, apply.systemActor, users),
    requestedAt: iso(apply.requestedAt),
    sentAt: iso(apply.sentAt),
    finishedAt: iso(apply.finishedAt),
    queueExpiresAt: apply.state === 'queued' ? iso(apply.queueExpiresAt) : null,
    note: apply.note,
    outcome: outcome && Object.keys(outcome).length > 0 ? outcome : null,
    revision: apply.revisionNumber,
    perchIds: apply.perchIds,
    configs: apply.configs ?? [],
    health: apply.health ?? null,
    cacAllowanceSeconds: apply.cacAllowanceSeconds ?? 0,
    rolloutId: apply.rolloutId === null ? null : Number(apply.rolloutId),
    ...(options.changes ? { changes: apply.changes ?? [] } : {}),
  }
}

export async function apApplyViews(applies: ApConfigApply[], options: { changes?: boolean } = {}) {
  const users = await userRefs(applies.map((a) => a.requestedByUserId))
  return applies.map((a) => apApplyView(a, users, options))
}

export async function apApplyViewOf(apply: ApConfigApply, options: { changes?: boolean } = {}) {
  const [view] = await apApplyViews([apply], options)
  return view
}

// ── sections, revisions, events (the gateway's shapes) ───────────────────

function contentView(content: SectionContent | null) {
  if (!content) return null
  const secrets: Record<string, { fingerprint: string; setByController: boolean }> = {}
  for (const [name, slot] of Object.entries(content.secrets ?? {}) as Array<[string, SecretSlot]>) {
    secrets[name] = { fingerprint: slot.fingerprint, setByController: Boolean(slot.ref) }
  }
  return { type: content.type, options: content.options as UciOptions, secrets }
}

export function apSectionView(
  row: ApConfigSection,
  context: { authoritative: boolean; revertDelaySeconds: number }
) {
  const state = apSectionState(row)
  return {
    perchId: row.perchId,
    config: row.config,
    section: row.sectionName,
    type: row.sectionType,
    anonymous: Boolean(row.anonymous),
    scope: state.scope,
    domain: row.domain,
    issue: state.issue,
    ownership: row.ownership && row.ownership.kind === 'options' ? row.ownership : null,
    status: state.status,
    router: contentView(row.routerContent),
    desired: contentView(row.desiredContent),
    base: contentView(row.baseContent),
    baseRevision: row.baseRevision,
    routerAuthor: row.routerAuthor,
    routerChangedAt: iso(row.routerChangedAt),
    conflict: row.conflict,
    driftSince: iso(row.driftSince),
    revertAt: context.authoritative ? revertDueAt(state, context.revertDelaySeconds) : null,
    position: row.position,
    updatedByUserId: row.updatedByUserId,
    updatedAt: iso(row.updatedAt),
  }
}

export function apRevisionView(
  revision: ApConfigRevision,
  users: Map<number, UserRef>,
  applyKeys: Map<number, string>,
  options: { diff?: boolean; snapshot?: boolean } = {}
) {
  return {
    number: revision.number,
    source: revision.source,
    author: actorRef(revision.authorUserId, revision.systemActor, users),
    routerAuthor: revision.routerAuthor,
    summary: revision.summary,
    note: revision.note,
    createdAt: iso(revision.createdAt),
    confirmedAt: iso(revision.confirmedAt),
    applyId: revision.applyId !== null ? (applyKeys.get(Number(revision.applyId)) ?? null) : null,
    rolloutId: revision.rolloutId === null ? null : Number(revision.rolloutId),
    ...(options.diff ? { diff: revision.diff } : {}),
    ...(options.snapshot
      ? { snapshot: revision.snapshot.map((e) => ({ ...e, content: contentView(e.content) })) }
      : {}),
  }
}

export function apEventView(
  event: ApConfigEvent,
  users: Map<number, UserRef>,
  applyKeys: Map<number, string>
) {
  return {
    id: Number(event.id),
    event: event.event,
    user: actorRef(event.userId, event.systemActor, users),
    applyId: event.applyId !== null ? (applyKeys.get(Number(event.applyId)) ?? null) : null,
    revision: event.revisionNumber,
    detail: event.detail,
    createdAt: iso(event.createdAt),
  }
}

export async function applyKeysFor(
  ids: Array<bigint | number | null>
): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter((id) => id !== null).map((id) => Number(id)))]
  if (wanted.length === 0) return new Map()
  const rows = await ApConfigApply.query().whereIn('id', wanted).select('id', 'apply_key')
  return new Map(rows.map((r) => [Number(r.id), r.applyKey]))
}

// ── ApConfig ─────────────────────────────────────────────────────────────

type Counts = {
  synced: number
  excluded: number
  unmodeled: number
  ahead: number
  conflicts: number
  drift: number
  divergences: number
  orphans: number
}

function countsOf(states: SectionState[], divergences: number): Counts {
  const counts: Counts = {
    synced: 0,
    excluded: 0,
    unmodeled: 0,
    ahead: 0,
    conflicts: 0,
    drift: 0,
    divergences,
    orphans: 0,
  }
  const radios = new Set(
    states.filter((s) => s.config === 'wireless' && s.type === 'wifi-device').map((s) => s.name)
  )
  for (const s of states) {
    if (s.scope === 'synced') {
      counts.synced++
      if (s.status === 'ahead') counts.ahead++
      if (s.status === 'conflict') counts.conflicts++
      if (s.status === 'drift' || s.status === 'reverting') counts.drift++
    } else if (s.scope === 'excluded') counts.excluded++
    else counts.unmodeled++
    if (s.scope !== 'synced' && s.type === 'wifi-iface') {
      const device = scalarOf((s.router ?? s.desired)?.options ?? {}, 'device')
      if (device && !radios.has(device)) counts.orphans++
    }
  }
  return counts
}

/**
 * `ApConfig` (controller.md 7.1) for every agent AP (scraped rows are not
 * listed; an agent without the plane is listed as not `capable`). `detail`
 * adds capabilities and the management path; `features` (the hostapd
 * build's) rides on every row so the network editor can check each AP.
 */
export async function apConfigViews(
  settings: WifiConfigSettings,
  options: { apIds?: number[]; detail?: boolean } = {}
) {
  const query = WifiAccessPoint.query().where('transport', 'agent').orderBy('id')
  if (options.apIds) query.whereIn('id', options.apIds)
  const aps = await query
  const configs = await ApConfig.query().whereIn(
    'ap_id',
    aps.map((a) => a.id)
  )
  const divergences = await WifiDivergence.query()
    .whereNull('resolved_at')
    .whereIn(
      'ap_id',
      aps.map((a) => a.id)
    )
  const out = []
  for (const row of aps) {
    const ap = configs.find((c) => c.apId === row.id) ?? null
    const session = apSession(row.id)
    const capable = session
      ? session.capabilities.includes(WIFI_CONFIG_CAPABILITY) && session.block !== null
      : ap !== null
    const loaded = ap ? await loadApSections(row.id) : null
    const states = loaded ? loaded.states : []
    const open = ap ? await openApApplies(row.id) : []
    const pending = open.length > 0 ? await apApplyViewOf(open[0]) : null
    const access = ap ? writeAccess(ap, settings) : null
    const caps = ap?.capabilities ?? null
    const policy = ap ? countryPolicyOf(ap, settings) : { mode: 'fleet' as const, code: null }
    const groups = session?.block?.groups ?? caps?.groups ?? null
    out.push({
      apId: row.id,
      name: apDisplayName(row),
      online: session !== null,
      secure: session ? session.secure : null,
      agentVersion: session?.agentVersion ?? row.agentVersion ?? null,
      capable,
      access:
        session?.block?.access ?? (ap?.agentAccess as 'none' | 'read' | 'write' | null) ?? null,
      transportOk: session?.block?.transportOk ?? ap?.transportOk ?? null,
      allowInsecure: session?.block?.allowInsecure ?? ap?.allowInsecure ?? null,
      mode: ap ? normalizeApMode(ap.mode) : ('off' as const),
      authoritative: Boolean(ap?.authoritative),
      authoritativeSince: iso(ap?.authoritativeSince),
      enforcement: ap?.enforcement === 'suspended' ? ('suspended' as const) : ('active' as const),
      writable: access ? access.writable : false,
      writeBlockedReason: access
        ? access.writable
          ? null
          : access.reason
        : session
          ? ('no_capability' as const)
          : ('offline' as const),
      signedWrites: false,
      pairing: ap?.pairing ?? null,
      syncState: ap?.syncState ?? 'unknown',
      fleetState: ap?.fleetState ?? 'unknown',
      counts: countsOf(states, divergences.filter((d) => d.apId === row.id).length),
      country: {
        mode: policy.mode,
        effective: policy.code,
        settable: caps?.regulatory?.settable !== false,
        selfManaged: (caps?.regulatory?.selfManaged ?? []).length > 0,
      },
      health: ap?.health ?? null,
      healthAt: iso(ap?.healthAt),
      pendingApply: pending,
      rejoinOffer: ap?.rejoinOffer
        ? {
            revision: ap.rejoinOffer.revision,
            reason: ap.rejoinOffer.reason,
            detectedAt: ap.rejoinOffer.detectedAt,
          }
        : null,
      groups: {
        engine: groups?.engine ?? false,
        enabled: groups?.enabled ?? false,
        handedOver: groups?.handedOver ?? false,
      },
      headRevision: ap?.headRevision ?? 0,
      observedAt: iso(ap?.observedAt),
      luciPending: ap?.observedState?.luciPending ?? false,
      uncommitted: ap?.observedState?.uncommitted ?? [],
      features: caps?.hostapd?.features ?? null,
      ...(options.detail ? { capabilities: caps, managementPath: ap?.managementPath ?? null } : {}),
    })
  }
  return out
}

export type ApConfigView = Awaited<ReturnType<typeof apConfigViews>>[number]

// ── networks ─────────────────────────────────────────────────────────────

type SlotView = {
  radio: string
  band: string | null
  perchId: string | null
  section: string | null
  state:
    | 'in_sync'
    | 'ahead'
    | 'pending'
    | 'conflict'
    | 'drift'
    | 'diverged'
    | 'missing'
    | 'unsupported'
    | 'offline'
  bssid: string | null
  clients: number | null
}

type ApSnapshot = {
  ap: ApConfig
  name: string
  online: boolean
  mode: 'off' | 'observe' | 'managed'
  rows: SectionState[]
  slots: SlotPlan[]
  issues: Array<{
    severity: 'error' | 'warning'
    code: string
    message: string
    networkId?: number
    apId?: number
    radio?: string
  }>
  divergedPerchIds: Set<string>
  interfaces: Array<{ ifname?: string; radio?: string; ssid?: string; bssid?: string }>
}

async function apSnapshots(fleet: FleetData, settings: WifiConfigSettings): Promise<ApSnapshot[]> {
  const aps = await ApConfig.query().whereIn('mode', ['observe', 'managed']).orderBy('ap_id')
  const rows = await WifiAccessPoint.query().whereIn(
    'id',
    aps.map((a) => a.apId)
  )
  const divergences = await openDivergenceRows()
  const out: ApSnapshot[] = []
  for (const ap of aps) {
    const row = rows.find((r) => r.id === ap.apId)
    const input = await renderInputOf(ap, fleet, settings)
    const planned = planSlots({ ...input, holds: [] })
    const diverged = new Set(
      divergences
        .filter((d) => d.apId === ap.apId && d.perchId !== null)
        .map((d) => d.perchId as string)
    )
    const interfaces = Array.isArray(row?.agentInfo?.interfaces)
      ? (row!.agentInfo!.interfaces as Array<Record<string, unknown>>).map((i) => ({
          ifname: typeof i.ifname === 'string' ? i.ifname : undefined,
          radio: typeof i.radio === 'string' ? i.radio : undefined,
          ssid: typeof i.ssid === 'string' ? i.ssid : undefined,
          bssid: typeof i.bssid === 'string' ? i.bssid : undefined,
        }))
      : []
    out.push({
      ap,
      name: row ? apDisplayName(row) : `AP ${ap.apId}`,
      online: apSession(ap.apId) !== null,
      mode: normalizeApMode(ap.mode),
      rows: input.rows,
      slots: planned.slots,
      issues: planned.issues,
      divergedPerchIds: diverged,
      interfaces,
    })
  }
  return out
}

function slotState(snap: ApSnapshot, slot: SlotPlan): SlotView['state'] {
  if (slot.state === 'blocked') return 'unsupported'
  if (slot.state === 'missing') return 'missing'
  if (slot.state === 'held') return 'diverged'
  if (slot.state === 'create')
    return snap.mode === 'managed' ? (snap.online ? 'ahead' : 'offline') : 'missing'
  const row = snap.rows.find((r) => r.perchId === slot.perchId)
  if (!row) return 'missing'
  if (slot.perchId && snap.divergedPerchIds.has(slot.perchId)) return 'diverged'
  switch (row.status) {
    case 'conflict':
      return 'conflict'
    case 'pending':
    case 'reverting':
      return 'pending'
    case 'drift':
      return 'drift'
    case 'ahead':
      return snap.online ? 'ahead' : 'offline'
    default:
      return 'in_sync'
  }
}

async function passphraseState(
  network: WifiNetwork,
  snaps: ApSnapshot[],
  links: WifiIfaceLink[]
): Promise<{ state: 'set' | 'unknown' | 'mixed' | 'none'; updatedAt: string | null }> {
  if (network.security === 'open' || network.security === 'owe')
    return { state: 'none', updatedAt: null }
  if (network.passphraseRef) {
    const secret = await WifiSecret.findBy('ref', network.passphraseRef)
    return { state: 'set', updatedAt: iso(secret?.updatedAt ?? secret?.createdAt ?? null) }
  }
  const fingerprints = new Set<string>()
  for (const link of links.filter((l) => l.networkId === network.id)) {
    const snap = snaps.find((s) => s.ap.apId === link.apId)
    const row = snap?.rows.find((r) => r.perchId === link.perchId)
    const fp = (row?.router ?? row?.desired)?.secrets?.key?.fingerprint
    if (fp) fingerprints.add(fp)
  }
  return { state: fingerprints.size > 1 ? 'mixed' : 'unknown', updatedAt: null }
}

/** `WifiNetwork` (controller.md 7.1) for the given networks (all when omitted). */
export async function networkViews(
  settings: WifiConfigSettings,
  options: { ids?: number[]; fleet?: FleetData; stations?: ConnectedStation[] } = {}
) {
  const fleet = options.fleet ?? (await loadFleet())
  const snaps = await apSnapshots(fleet, settings)
  const stations = options.stations ?? (await connectedStations(snaps.map((s) => s.ap.apId)))
  const links = await WifiIfaceLink.query()
  const networks = fleet.networks.filter((n) => !options.ids || options.ids.includes(n.id))
  const out = []
  for (const network of networks) {
    const spec = networkSpecOf(network)
    const aps = []
    const statuses: SlotView['state'][] = []
    let clients = 0
    let apsCarrying = 0
    let slotCount = 0
    const issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }> = []
    for (const snap of snaps) {
      const membership =
        fleet.memberships.find((m) => m.networkId === network.id && m.apId === snap.ap.apId) ?? null
      const carried = carries(spec, membership)
      const slots: SlotView[] = []
      for (const slot of snap.slots.filter((s) => s.networkId === network.id)) {
        const n = countClients(stations, {
          apId: snap.ap.apId,
          ssid: network.ssid,
          radio: slot.radio,
        })
        const iface = snap.interfaces.find((i) => i.ssid === network.ssid && i.radio === slot.radio)
        const state = slotState(snap, slot)
        slots.push({
          radio: slot.radio,
          band: slot.band,
          perchId: slot.perchId,
          section: slot.state === 'blocked' ? null : slot.section,
          state,
          bssid: iface?.bssid ?? null,
          clients: n,
        })
        clients += n
        if (snap.mode === 'managed') statuses.push(state)
      }
      // Linked interfaces the fleet no longer carries here (an `added` divergence).
      for (const link of links.filter(
        (l) =>
          l.apId === snap.ap.apId &&
          l.networkId === network.id &&
          !slots.some((s) => s.perchId === l.perchId)
      )) {
        const row = snap.rows.find((r) => r.perchId === link.perchId)
        if (!row) continue
        slots.push({
          radio: link.radio,
          band:
            (snap.ap.capabilities?.radios ?? []).find((r) => r.section === link.radio)?.band ??
            null,
          perchId: link.perchId,
          section: row.name,
          state: 'diverged',
          bssid: null,
          clients: null,
        })
        statuses.push('diverged')
      }
      const unsupported = snap.issues
        .filter((i) => i.networkId === network.id)
        .concat(snap.slots.filter((s) => s.networkId === network.id).flatMap((s) => s.issues))
        .map((i) => ({ code: i.code, message: i.message }))
      issues.push(
        ...snap.issues
          .filter((i) => i.networkId === network.id)
          .concat(snap.slots.filter((s) => s.networkId === network.id).flatMap((s) => s.issues))
          .map((i) => ({ severity: i.severity, code: i.code, message: i.message }))
      )
      if (!carried && slots.length === 0 && !membership) continue
      if (
        slots.some((s) => s.state === 'in_sync' || s.state === 'ahead' || s.state === 'pending')
      ) {
        apsCarrying++
      }
      slotCount += slots.length
      aps.push({
        apId: snap.ap.apId,
        apName: snap.name,
        online: snap.online,
        mode: snap.mode,
        included: membership?.included ?? null,
        carried,
        bands: membership?.bands ?? null,
        radios: membership?.radios ?? null,
        overrides: membership?.overrides ?? {},
        radioOverrides: membership?.radioOverrides ?? {},
        slots,
        unsupported: dedupe(unsupported),
      })
    }
    out.push({
      id: network.id,
      name: network.name,
      ssid: network.ssid,
      enabled: spec.enabled,
      security: spec.security,
      passphrase: await passphraseState(network, snaps, links),
      hidden: spec.hidden,
      isolate: spec.isolate,
      binding: { ...spec.binding, label: null, purpose: null, portal: null },
      bands: spec.bands,
      apScope: spec.apScope,
      roaming: spec.roaming,
      advanced: spec.advanced,
      groups: spec.groups,
      origin: spec.origin,
      revision: spec.revision,
      status: networkStatus(statuses),
      counts: { aps: aps.filter((a) => a.carried).length, apsCarrying, slots: slotCount, clients },
      aps,
      issues: dedupe(issues),
      createdAt: iso(network.createdAt),
      updatedAt: iso(network.updatedAt ?? network.createdAt),
    })
  }
  return out
}

function dedupe<T extends { code: string; message: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((i) => {
    const key = `${i.code}|${i.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A network's rollup over its managed slots (controller.md 7.1 `status`). */
export function networkStatus(states: SlotView['state'][]) {
  const relevant = states.filter((s) => s !== 'unsupported')
  if (relevant.length === 0) return 'unmanaged' as const
  if (relevant.includes('conflict')) return 'conflict' as const
  if (relevant.includes('pending')) return 'applying' as const
  if (relevant.includes('diverged')) return 'diverged' as const
  if (relevant.includes('drift')) return 'drift' as const
  const behind = relevant.filter((s) => s === 'ahead' || s === 'offline' || s === 'missing').length
  if (behind === 0) return 'in_sync' as const
  return behind === relevant.length ? ('ahead' as const) : ('partial' as const)
}

// ── radios ───────────────────────────────────────────────────────────────

/** `WifiRadio` (controller.md 7.1), with the connected clients per radio. */
export async function radioViews(options: { apId?: number } = {}) {
  const query = ApConfig.query().whereIn('mode', ['observe', 'managed']).orderBy('ap_id')
  if (options.apId !== undefined) query.where('ap_id', options.apId)
  const aps = await query
  const stations = await connectedStations(aps.map((a) => a.apId))
  const links = await WifiIfaceLink.query().whereIn(
    'ap_id',
    aps.map((a) => a.apId)
  )
  const fleet = links.length > 0 ? await loadFleet() : null
  const out = []
  for (const ap of aps) {
    const { states } = await loadApSections(ap.apId)
    const protectedRadios = new Set(ap.managementPath?.radios ?? [])
    for (const row of states) {
      if (row.domain !== WIFI_RADIOS_DOMAIN || row.scope !== 'synced') continue
      const content = row.desired ?? row.router
      if (!content) continue
      const caps = (ap.capabilities?.radios ?? []).find((r) => r.section === row.name) ?? null
      const band = caps?.band ?? (scalarOf(content.options, 'band') as never) ?? null
      const f = radioFields(content.options, band)
      const networks = links
        .filter((l) => l.radio === row.name && l.apId === ap.apId && l.networkId !== null)
        .map((l) => fleet?.networks.find((n) => n.id === l.networkId))
        .filter((n): n is WifiNetwork => Boolean(n))
      out.push({
        apId: ap.apId,
        perchId: row.perchId,
        section: row.name,
        band: band === '2g' || band === '5g' || band === '6g' ? band : null,
        present: caps?.present ?? true,
        up: caps ? caps.up : null,
        channelMode: f.channelMode === 'fixed' ? ('fixed' as const) : ('auto' as const),
        channel: f.channel,
        allowed: f.allowed,
        width: f.width,
        htmode: scalarOf(content.options, 'htmode'),
        txpower: f.txpower,
        enabled: f.enabled,
        country: f.country,
        current: {
          channel: caps?.current?.channel ?? null,
          htmode: caps?.current?.htmode ?? null,
          txpowerDbm: caps?.current?.txpowerDbm ?? null,
          utilization: null,
        },
        options: {
          channels: (caps?.channels ?? [])
            .filter((c) => !c.disabled)
            .map((c) => ({
              channel: c.channel,
              dfs: c.dfs,
              maxDbm: c.maxDbm,
              cacSeconds: c.cacSeconds ?? null,
            })),
          widths: caps?.widths ?? [],
          txpowerMaxDbm: caps?.txpowerMaxDbm ?? null,
        },
        status: row.status,
        protected: protectedRadios.has(row.name),
        networks: [...new Map(networks.map((n) => [n.id, n])).values()].map((n) => ({
          id: n.id,
          name: n.name,
          ssid: n.ssid,
        })),
        clients: countClients(stations, { apId: ap.apId, radio: row.name }),
      })
    }
  }
  return out
}

// ── divergences ──────────────────────────────────────────────────────────

export async function divergenceViews(filter: {
  apId?: number
  networkId?: number
  open?: boolean
}) {
  const query = WifiDivergence.query().orderBy('id', 'desc').limit(1000)
  if (filter.apId !== undefined) query.where('ap_id', filter.apId)
  if (filter.networkId !== undefined) query.where('network_id', filter.networkId)
  if (filter.open !== false) query.whereNull('resolved_at')
  const rows = await query
  const apIds = [...new Set(rows.map((r) => r.apId))]
  const aps = apIds.length > 0 ? await WifiAccessPoint.query().whereIn('id', apIds) : []
  const fleet = rows.some((r) => r.networkId !== null) ? await loadFleet() : null
  return rows.map((d) => ({
    id: d.id,
    apId: d.apId,
    apName: (() => {
      const row = aps.find((a) => a.id === d.apId)
      return row ? apDisplayName(row) : `AP ${d.apId}`
    })(),
    networkId: d.networkId,
    networkName: fleet?.networks.find((n) => n.id === d.networkId)?.name ?? null,
    radio: d.radio,
    kind: d.kind,
    option: d.option,
    fleetValue: d.fleetValue ?? null,
    apValue: d.apValue ?? null,
    routerAuthor: d.routerAuthor,
    detectedAt: iso(d.detectedAt),
    resolvedAt: iso(d.resolvedAt),
    resolution: d.resolution,
    resolutions: d.resolvedAt ? [] : resolutionsFor(d),
  }))
}

// ── rollouts ─────────────────────────────────────────────────────────────

export async function rolloutViews(rollouts: WifiRollout[]) {
  if (rollouts.length === 0) return []
  const steps = await WifiRolloutStep.query()
    .whereIn(
      'rollout_id',
      rollouts.map((r) => Number(r.id))
    )
    .orderBy('position')
  const applyIds = steps.map((s) => s.applyId).filter((id): id is number => id !== null)
  const applies =
    applyIds.length > 0 ? await ApConfigApply.query().whereIn('id', applyIds.map(Number)) : []
  const viewsOfApplies = await apApplyViews(applies)
  const applyViewsById = new Map(viewsOfApplies.map((v, i) => [Number(applies[i].id), v]))
  const apIds = [...new Set(steps.map((s) => s.apId))]
  const aps = apIds.length > 0 ? await WifiAccessPoint.query().whereIn('id', apIds) : []
  const users = await userRefs(rollouts.map((r) => r.requestedByUserId))
  return rollouts.map((r) => {
    const actor = actorRef(r.requestedByUserId, r.systemActor, users)
    return {
      id: Number(r.id),
      kind: r.kind,
      state: r.state,
      requestedBy: actor
        ? actor.id === null
          ? { id: null, email: null, system: true as const }
          : { id: actor.id, email: actor.email }
        : null,
      note: r.note,
      confirmMode: r.confirmMode,
      offlinePolicy: r.offlinePolicy,
      networkIds: r.networkIds ?? [],
      steps: steps
        .filter((s) => Number(s.rolloutId) === Number(r.id))
        .map((s) => {
          const ap = aps.find((a) => a.id === s.apId)
          const outcome = s.outcome
            ? {
                ...(s.outcome.reason ? { reason: s.outcome.reason } : {}),
                ...(s.outcome.error ? { error: s.outcome.error } : {}),
                ...(s.outcome.message ? { message: s.outcome.message } : {}),
              }
            : null
          return {
            apId: s.apId,
            apName: ap ? apDisplayName(ap) : `AP ${s.apId}`,
            position: s.position,
            state: s.state,
            apply: s.applyId !== null ? (applyViewsById.get(Number(s.applyId)) ?? null) : null,
            startedAt: iso(s.startedAt),
            finishedAt: iso(s.finishedAt),
            outcome: outcome && Object.keys(outcome).length > 0 ? outcome : null,
          }
        }),
      stop: r.stop,
      impact: r.impact,
      createdAt: iso(r.createdAt),
      finishedAt: iso(r.finishedAt),
    }
  })
}

export async function rolloutViewOf(rollout: WifiRollout) {
  const [view] = await rolloutViews([rollout])
  return view
}

/** Sections filter for `GET …/sections` (domain names are the AP registry's). */
export const AP_DOMAINS = [WIFI_RADIOS_DOMAIN, WIFI_IFACES_DOMAIN]
