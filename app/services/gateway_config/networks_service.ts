import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayNetwork, {
  GATEWAY_NETWORK_PURPOSES,
  type GatewayNetworkPurpose,
} from '#models/gateway_network'
import { sendCollectorConfigure } from '#services/collector_agent'
import { requestApply } from '#services/gateway_config/apply_lifecycle'
import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { editDomainSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  composeNetworks,
  planCreateNetwork,
  planDeleteNetwork,
  planUpdateNetwork,
  type ComposedNetwork,
  type DhcpPoolView,
  type L2Mode,
  type NetworkCreate,
  type NetworkPatch,
  type NetworkPlan,
  type NetworkPort,
} from '#services/gateway_config/network_model'
import type { Issue, SectionStatus } from '#services/gateway_config/types'
import {
  latestNetworkSamples,
  liveNetworks,
  refreshCaptureExclusions,
  type CaptureCounters,
  type ReportedNetwork,
} from '#services/gateway_network_accounting'
import { DateTime } from 'luxon'

/**
 * Networks REST (docs/gateway/networks.md section 3; plan 1 sections 8.1
 * and 10): the gateway's LAN-side networks as the config plane models them
 * (`network_model.ts`) merged with what the collector on the router reports
 * (`gateway.networks`) and Perch's own metadata (`gateway_networks`: label,
 * purpose, capture flag). A gateway in mode `off` still lists the networks
 * its collector reports, so the capture toggle works without the config
 * plane (README 7.21).
 *
 * Writes of the network's config go through `editDomainSections` (the
 * `networks` and `dhcp_pools` domains in one draft change) and, unless the
 * caller says `apply: false`, straight into one apply request of the touched
 * sections. The apply planner splits it: sections on the management path
 * (README 3.8) go into a protected job of their own with the longer confirm
 * window, after the ordinary job.
 */

export type NetworkLive = {
  reportedAt: string
  up: boolean | null
  device: string | null
  proto: string | null
  ipv4: string[]
  ipv6: string[]
  /** Router-side counters of the L3 device (rx = received from the network). */
  rxBytes: number | null
  txBytes: number | null
  /** Bits per second, router side. */
  rxBps: number | null
  txBps: number | null
  /** The same in client terms: download = what the router sends into the network. */
  downloadBps: number | null
  uploadBps: number | null
  captured: boolean | null
  devices: number | null
  activeDevices: number | null
  capture: CaptureCounters | null
}

export type GatewayNetworkView = {
  /** `gateway_networks.id`: the `:networkId` of the routes. */
  id: number
  gatewayId: number
  key: string
  label: string
  purpose: GatewayNetworkPurpose
  capture: boolean
  captureChangedAt: string | null
  /** The interface section, when the config plane has read it. */
  perchId: string | null
  /** `perch` = synced (Perch writes it), `router` = mirrored only, null = known from the report alone. */
  owner: 'perch' | 'router' | null
  l2Mode: L2Mode | null
  bridge: string | null
  vlanId: number | null
  parentDevice: string | null
  device: string | null
  proto: string | null
  ports: NetworkPort[]
  ipv4: string | null
  ipv4All: string[]
  status: SectionStatus | null
  deleting: boolean
  management: boolean
  sections: string[]
  dhcp: DhcpPoolView | null
  firewallZone: string | null
  live: NetworkLive | null
}

export function guessPurpose(name: string): GatewayNetworkPurpose {
  if (name === 'lan') return 'lan'
  if (name.startsWith('guest')) return 'guest'
  if (name.startsWith('iot')) return 'iot'
  if (name === 'mgmt' || name.startsWith('manage')) return 'management'
  return 'custom'
}

function purposeOf(value: string): GatewayNetworkPurpose {
  return (GATEWAY_NETWORK_PURPOSES as readonly string[]).includes(value)
    ? (value as GatewayNetworkPurpose)
    : 'custom'
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ER_DUP_ENTRY'
}

/**
 * Keeps `gateway_networks` in step with the networks the gateway has: one
 * row per network (by interface perch id, else by name), created lazily
 * like the infrastructure view's agent nodes. Rows of networks gone from
 * both the config and the report are dropped (only when a report is at
 * hand: a restarted controller never forgets labels before the first push).
 */
async function syncMetadataRows(
  gateway: Gateway,
  composed: ComposedNetwork[],
  reported: ReportedNetwork[] | null,
  knownPerchIds: Set<string>
): Promise<Map<string, GatewayNetwork>> {
  const rows = await GatewayNetwork.query().where('gateway_id', gateway.id).orderBy('id')
  const byName = new Map<string, GatewayNetwork>()
  const out = new Map<string, GatewayNetwork>()
  const used = new Set<number>()
  for (const r of rows) if (r.network) byName.set(r.network, r)

  for (const c of composed) {
    let row = rows.find((r) => r.interfacePerchId === c.perchId) ?? null
    const named = byName.get(c.key) ?? null
    if (row && named && named !== row) {
      // A report-only row for the name the interface now has: the perch id wins.
      await named.delete()
      byName.delete(c.key)
    }
    row ??= named
    if (row) {
      if (row.interfacePerchId !== c.perchId || row.network !== c.key) {
        row.interfacePerchId = c.perchId
        row.network = c.key
        await row.save()
      }
    } else {
      row = await createRow(gateway.id, c.key, c.perchId)
    }
    if (row) {
      out.set(c.key, row)
      used.add(row.id)
    }
  }
  for (const n of reported ?? []) {
    if (out.has(n.name)) continue
    let row = byName.get(n.name) ?? null
    row ??= await createRow(gateway.id, n.name, null)
    if (row) {
      out.set(n.name, row)
      used.add(row.id)
    }
  }
  if (reported !== null) {
    for (const r of rows) {
      if (used.has(r.id)) continue
      if (r.interfacePerchId && knownPerchIds.has(r.interfacePerchId)) continue
      await r.delete()
    }
  } else {
    // Without a report, rows of networks the config no longer has stay.
    for (const r of rows) {
      if (!used.has(r.id) && r.network && !out.has(r.network)) out.set(r.network, r)
    }
  }
  return out
}

async function createRow(
  gatewayId: number,
  name: string,
  perchId: string | null
): Promise<GatewayNetwork | null> {
  try {
    return await GatewayNetwork.create({
      gatewayId,
      network: name,
      interfacePerchId: perchId,
      label: name,
      purpose: guessPurpose(name),
      capture: true,
    })
  } catch (error) {
    if (!isDuplicate(error)) throw error
    return GatewayNetwork.query().where('gateway_id', gatewayId).where('network', name).first()
  }
}

function liveOf(
  entry: ReportedNetwork | undefined,
  reportedAt: string | null,
  sample: { recordedAt: string; rxBps: number | null; txBps: number | null } | undefined
): NetworkLive | null {
  if (!entry && !sample) return null
  const rxBps =
    entry?.rxRate !== null && entry?.rxRate !== undefined
      ? Math.round(entry.rxRate * 8)
      : (sample?.rxBps ?? null)
  const txBps =
    entry?.txRate !== null && entry?.txRate !== undefined
      ? Math.round(entry.txRate * 8)
      : (sample?.txBps ?? null)
  return {
    reportedAt: entry ? reportedAt! : sample!.recordedAt,
    up: entry ? entry.up : null,
    device: entry?.device ?? null,
    proto: entry?.proto ?? null,
    ipv4: entry?.ipv4 ?? [],
    ipv6: entry?.ipv6 ?? [],
    rxBytes: entry?.rxBytes ?? null,
    txBytes: entry?.txBytes ?? null,
    rxBps,
    txBps,
    downloadBps: txBps,
    uploadBps: rxBps,
    captured: entry ? entry.captured : null,
    devices: entry ? entry.devices : null,
    activeDevices: entry ? entry.activeDevices : null,
    capture: entry?.capture ?? null,
  }
}

function viewOf(
  gateway: Gateway,
  row: GatewayNetwork,
  composed: ComposedNetwork | undefined,
  live: NetworkLive | null,
  name: string
): GatewayNetworkView {
  return {
    id: row.id,
    gatewayId: gateway.id,
    key: name,
    label: row.label,
    purpose: purposeOf(row.purpose),
    capture: Boolean(row.capture),
    captureChangedAt: row.captureChangedAt?.toUTC().toISO() ?? null,
    perchId: composed?.perchId ?? null,
    owner: composed?.owner ?? null,
    l2Mode: composed?.l2Mode ?? null,
    bridge: composed?.bridge ?? null,
    vlanId: composed?.vlanId ?? null,
    parentDevice: composed?.parentDevice ?? null,
    device: composed?.device ?? live?.device ?? null,
    proto: composed?.proto ?? live?.proto ?? null,
    ports: composed?.ports ?? [],
    ipv4: composed?.ipv4 ?? live?.ipv4[0] ?? null,
    ipv4All: composed?.ipv4All ?? live?.ipv4 ?? [],
    status: composed?.status ?? null,
    deleting: composed?.deleting ?? false,
    management:
      composed?.management ??
      (gateway.managementPath !== null &&
        (gateway.managementPath.network === name ||
          (live?.device !== null &&
            live?.device !== undefined &&
            gateway.managementPath.device === live.device))),
    sections: composed?.sections ?? [],
    dhcp: composed?.dhcp ?? null,
    firewallZone: composed?.firewallZone ?? null,
    live,
  }
}

/** Every network of a gateway: config ∪ report, in the router's order, report-only ones after. */
export async function listGatewayNetworks(gatewayId: number): Promise<GatewayNetworkView[]> {
  const gateway = await findGateway(gatewayId)
  return networksOf(gateway)
}

async function networksOf(gateway: Gateway): Promise<GatewayNetworkView[]> {
  const { states } = await loadSections(gateway.id)
  const composed = composeNetworks(states, gateway.managementPath)
  const report = liveNetworks(gateway.id)
  const samples = await latestNetworkSamples(gateway.id)
  const rows = await syncMetadataRows(
    gateway,
    composed,
    report?.networks ?? null,
    new Set(states.map((s) => s.perchId))
  )
  const names = [
    ...composed.map((c) => c.key),
    ...(report?.networks ?? [])
      .map((n) => n.name)
      .filter((n) => !composed.some((c) => c.key === n)),
  ]
  const out: GatewayNetworkView[] = []
  for (const name of names) {
    const row = rows.get(name)
    if (!row) continue
    const entry = report?.networks.find((n) => n.name === name)
    out.push(
      viewOf(
        gateway,
        row,
        composed.find((c) => c.key === name),
        liveOf(entry, report?.reportedAt ?? null, samples.get(name)),
        name
      )
    )
  }
  return out
}

async function networkById(gatewayId: number, networkId: number) {
  const gateway = await findGateway(gatewayId)
  const views = await networksOf(gateway)
  const view = views.find((v) => v.id === networkId)
  if (!view) throw planeError(404, 'network_not_found', `No network ${networkId} on this gateway.`)
  return { gateway, view }
}

export async function getGatewayNetwork(
  gatewayId: number,
  networkId: number
): Promise<GatewayNetworkView> {
  const { view } = await networkById(gatewayId, networkId)
  return view
}

/** `GET /api/v1/networks`: every gateway's networks in one list (any signed-in user). */
export async function allNetworks() {
  const gateways = await Gateway.query().orderBy('id')
  const out = []
  for (const gateway of gateways) {
    for (const v of await networksOf(gateway)) {
      out.push({
        gatewayId: gateway.id,
        id: v.id,
        key: v.key,
        label: v.label,
        purpose: v.purpose,
        vlanId: v.vlanId,
        ipv4: v.ipv4,
        capture: v.capture,
        captured: v.live?.captured ?? null,
        up: v.live?.up ?? null,
        rxBps: v.live?.rxBps ?? null,
        txBps: v.live?.txBps ?? null,
        downloadBps: v.live?.downloadBps ?? null,
        uploadBps: v.live?.uploadBps ?? null,
        devices: v.live?.devices ?? null,
        activeDevices: v.live?.activeDevices ?? null,
        management: v.management,
      })
    }
  }
  return out
}

// ── writes ───────────────────────────────────────────────────────────────

export type NetworkWriteResult = {
  object: GatewayNetworkView | null
  issues: Issue[]
  converted: NetworkPlan['converted']
  apply: unknown | null
  applyError: { error: string; message: string } | null
}

export type NetworkMeta = {
  label?: string
  purpose?: GatewayNetworkPurpose
  capture?: boolean
}

function requireManagedMode(gateway: Gateway) {
  if (normalizeMode(gateway.mode) !== 'managed') {
    throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
  }
}

/** Releases older than 21.02 have no `config device` syntax (plan 1 section 8.1). */
function requireDeviceSyntax(gateway: Gateway) {
  const release = gateway.capabilities?.openwrt?.release
  if (typeof release !== 'string') return
  const m = /^(\d+)\.(\d+)/.exec(release)
  if (!m) return
  const [major, minor] = [Number(m[1]), Number(m[2])]
  if (major < 21 || (major === 21 && minor < 2)) {
    throw planeError(
      409,
      'openwrt_too_old',
      `OpenWrt ${release} predates the device syntax (21.02).`
    )
  }
}

/**
 * Firewall zone membership needs a firewall domain, which the config plane
 * does not have yet (README M7). Until then a request naming a zone is
 * refused before anything changes; the network's zone is shown read-only
 * (`firewallZone`, from the router's config). TODO(M7): route this through
 * the firewall domain's `zone.network` list (set semantics) in the same
 * `editDomainSections` call.
 */
function refuseFirewallZone(zone: string | null | undefined) {
  if (zone === undefined || zone === null) return
  throw planeError(
    409,
    'firewall_not_managed',
    'Perch does not manage firewall zones yet: add the network to a zone on the router.'
  )
}

async function applyNow(
  gatewayId: number,
  userId: number,
  perchIds: string[],
  wanted: boolean
): Promise<{ apply: unknown | null; applyError: NetworkWriteResult['applyError'] }> {
  if (!wanted || perchIds.length === 0) return { apply: null, applyError: null }
  try {
    return { apply: await requestApply(gatewayId, { userId, perchIds }), applyError: null }
  } catch (error) {
    if (error instanceof GatewayPlaneError) {
      return { apply: null, applyError: { error: error.code, message: error.message } }
    }
    throw error
  }
}

async function writePlan(gatewayId: number, userId: number, plan: NetworkPlan) {
  return editDomainSections(gatewayId, userId, [
    { domain: 'networks', edits: plan.network },
    { domain: 'dhcp_pools', edits: plan.pools },
  ])
}

async function pushCapture(gateway: Gateway) {
  if (gateway.collectorId === null) return
  await refreshCaptureExclusions(gateway.collectorId)
  const collector = await Collector.find(gateway.collectorId)
  if (collector) sendCollectorConfigure(collector)
}

async function saveMeta(
  gateway: Gateway,
  row: GatewayNetwork,
  meta: NetworkMeta,
  userId: number
): Promise<boolean> {
  let captureChanged = false
  const labelled: Record<string, unknown> = {}
  if (meta.label !== undefined && meta.label !== row.label) {
    labelled.label = meta.label
    row.label = meta.label
  }
  if (meta.purpose !== undefined && meta.purpose !== row.purpose) {
    labelled.purpose = meta.purpose
    row.purpose = meta.purpose
  }
  if (meta.capture !== undefined && meta.capture !== Boolean(row.capture)) {
    row.capture = meta.capture
    row.captureChangedAt = DateTime.utc()
    row.captureChangedByUserId = userId
    captureChanged = true
  }
  if (!row.$isDirty) return false
  await row.save()
  if (Object.keys(labelled).length > 0) {
    await recordGatewayEvent(gateway.id, 'network_labelled', {
      userId,
      detail: { network: row.network, ...labelled },
    })
  }
  if (captureChanged) {
    await recordGatewayEvent(gateway.id, 'network_capture_changed', {
      userId,
      detail: { network: row.network, capture: row.capture },
    })
    await pushCapture(gateway)
  }
  return true
}

export type NetworkCreateInput = NetworkCreate &
  NetworkMeta & { firewallZone?: string | null; apply?: boolean }

/** `POST /gateways/:id/networks`. */
export async function createGatewayNetwork(
  gatewayId: number,
  userId: number,
  input: NetworkCreateInput
): Promise<NetworkWriteResult> {
  const gateway = await findGateway(gatewayId)
  requireManagedMode(gateway)
  refuseFirewallZone(input.firewallZone)
  requireDeviceSyntax(gateway)
  const { states } = await loadSections(gateway.id)
  const plan = planCreateNetwork(states, input)
  const outcome = await writePlan(gateway.id, userId, plan)

  const after = await loadSections(gateway.id)
  const iface = after.states.find(
    (s) => s.config === 'network' && s.name === input.key && s.type === 'interface'
  )
  let row: GatewayNetwork | null = null
  if (iface) {
    row =
      (await GatewayNetwork.query()
        .where('gateway_id', gateway.id)
        .where((q) => q.where('interface_perch_id', iface.perchId).orWhere('network', input.key))
        .first()) ?? (await createRow(gateway.id, input.key, iface.perchId))
    if (row) {
      row.interfacePerchId = iface.perchId
      row.network = input.key
      await row.save()
      await saveMeta(
        gateway,
        row,
        {
          label: input.label ?? input.key,
          purpose: input.purpose ?? guessPurpose(input.key),
          capture: input.capture,
        },
        userId
      )
    }
  }
  const { apply, applyError } = await applyNow(
    gateway.id,
    userId,
    outcome.perchIds,
    input.apply !== false
  )
  const views = await networksOf(gateway)
  return {
    object: views.find((v) => v.key === input.key) ?? null,
    issues: [...outcome.issues, ...plan.warnings],
    converted: plan.converted,
    apply,
    applyError,
  }
}

export type NetworkUpdateInput = NetworkPatch &
  NetworkMeta & { firewallZone?: string | null; apply?: boolean }

/** `PATCH /gateways/:id/networks/:networkId`: metadata alone works in any mode. */
export async function updateGatewayNetwork(
  gatewayId: number,
  networkId: number,
  userId: number,
  input: NetworkUpdateInput
): Promise<NetworkWriteResult> {
  const { gateway, view } = await networkById(gatewayId, networkId)
  refuseFirewallZone(input.firewallZone)
  const configChange =
    input.ipv4 !== undefined ||
    input.ports !== undefined ||
    input.vlanId !== undefined ||
    input.dhcp !== undefined
  let issues: Issue[] = []
  let perchIds: string[] = []
  if (configChange) {
    requireManagedMode(gateway)
    if (!view.perchId) {
      throw planeError(409, 'network_not_managed', `${view.key} is known from the report only.`)
    }
    requireDeviceSyntax(gateway)
    const { states } = await loadSections(gateway.id)
    const plan = planUpdateNetwork(states, view.key, input)
    if (plan.network.length + plan.pools.length > 0) {
      const outcome = await writePlan(gateway.id, userId, plan)
      issues = [...outcome.issues, ...plan.warnings]
      perchIds = outcome.perchIds
    }
  }
  const row = await GatewayNetwork.findOrFail(networkId)
  await saveMeta(gateway, row, input, userId)
  const { apply, applyError } = await applyNow(gateway.id, userId, perchIds, input.apply !== false)
  const views = await networksOf(gateway)
  return {
    object: views.find((v) => v.id === networkId) ?? null,
    issues,
    converted: null,
    apply,
    applyError,
  }
}

/** `DELETE /gateways/:id/networks/:networkId`. */
export async function deleteGatewayNetwork(
  gatewayId: number,
  networkId: number,
  userId: number,
  options: { apply?: boolean } = {}
): Promise<NetworkWriteResult> {
  const { gateway, view } = await networkById(gatewayId, networkId)
  requireManagedMode(gateway)
  if (!view.perchId) {
    throw planeError(409, 'network_not_managed', `${view.key} is known from the report only.`)
  }
  const { states } = await loadSections(gateway.id)
  const plan = planDeleteNetwork(states, view.key, gateway.managementPath)
  const outcome = await writePlan(gateway.id, userId, plan)
  const { apply, applyError } = await applyNow(
    gateway.id,
    userId,
    outcome.perchIds,
    options.apply !== false
  )
  const views = await networksOf(gateway)
  return {
    object: views.find((v) => v.id === networkId) ?? null,
    issues: [...outcome.issues, ...plan.warnings],
    converted: null,
    apply,
    applyError,
  }
}
