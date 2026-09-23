import DeviceGroup from '#models/device_group'
import DeviceGroupKey from '#models/device_group_key'
import DeviceGroupMember, { type DeviceGroupMemberSource } from '#models/device_group_member'
import Gateway from '#models/gateway'
import Portal from '#models/portal'
import QosAssignment from '#models/qos_assignment'
import { requestApGroupsSync } from '#services/ap_groups'
export { portalBypassMacs } from '#services/device_group_bypass'
import { normalizeMac } from '#services/device_labels'
import {
  reconcileGroupFirewall,
  type GroupFirewallSpec,
} from '#services/gateway_config/firewall_service'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import type { SectionState } from '#services/gateway_config/sync_engine'
import { listGatewayNetworks } from '#services/gateway_config/networks_service'
import type { GatewayNetworkView } from '#services/gateway_config/networks_service'
import { configurePortals } from '#services/portal_hotspot'
import { resolveGateway, QosError, type GatewayRef } from '#services/qos_gateway'
import { wireRate, type QosRate } from '#services/qos_reads'
import { rateFromColumns } from '#services/qos_plan'
import { createAssignment, deleteAssignment, updateAssignment } from '#services/qos_writes'
import encryption from '@adonisjs/core/services/encryption'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHash, randomInt } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Device groups (docs/gateway/device-groups.md; owner decisions 30 and 31).
 *
 * The group rows are the source of truth; everything a group does is
 * derived from them and pushed where it acts:
 *
 * - speed limit: a QoS assignment with `source: 'group'`,
 *   `sourceRef: 'device-group:<id>'` (the network default of the group's
 *   network, else a group assignment over the bound members);
 * - internet access: firewall sections `perch_g<id>*` (reconcileGroupFirewall);
 * - portal bypass: the gateway's `portal.configure` (`bypass` per portal);
 * - Wi-Fi keys and bindings: the access points (`ap_groups.ts`).
 *
 * Reads are open to every signed-in user; writes are admin-only (routes).
 */

export class DeviceGroupError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.message === 'string' ? body.message : 'Device group request refused')
  }
}

function refuse(
  status: 400 | 404 | 409 | 422,
  error: string,
  message: string,
  extra: Record<string, unknown> = {}
): DeviceGroupError {
  return new DeviceGroupError(status, { error, message, ...extra })
}

export const GROUP_SOURCE_REF_PREFIX = 'device-group:'
export const groupSourceRef = (id: number) => `${GROUP_SOURCE_REF_PREFIX}${id}`

/** Devices seen on a group's network within this long count as on it. */
const ON_NETWORK_DAYS = 7

// ---------------------------------------------------------------------------
// Views

export type DeviceGroupNetwork = {
  perchId: string
  name: string
  label: string
  vlanId: number | null
  ipv4: string | null
  zone: string | null
}

export type DeviceGroupQos = {
  assignmentId: number
  policyId: number | null
  rate: QosRate | null
  /** `group`: over the bound members; `network`: the network's default. */
  via: 'group' | 'network'
  /** Who owns the assignment: this group, or an admin's own in QoS. */
  source: 'group' | 'admin'
}

export type DeviceGroupView = {
  id: number
  gatewayId: number
  name: string
  notes: string | null
  network: DeviceGroupNetwork | null
  qos: DeviceGroupQos | null
  internet: boolean
  portalBypass: boolean
  counts: { bound: number; onNetwork: number; keys: number }
  /**
   * The internet block on the router: `none` (not blocked, nothing there),
   * `pending` (drafted or applying), `applied`, `conflict` (the router
   * changed it).
   */
  firewall: { state: 'none' | 'pending' | 'applied' | 'conflict' }
  createdAt: string
  updatedAt: string
}

export type DeviceGroupMemberView = {
  mac: string
  name: string | null
  source: DeviceGroupMemberSource
  portalUserId: number | null
  portalUsername: string | null
  createdAt: string
}

export type DeviceGroupKeyView = { id: number; label: string; createdAt: string }

export type DeviceGroupDetail = DeviceGroupView & {
  members: DeviceGroupMemberView[]
  /** Devices the gateway saw on the group's network (not stored). */
  onNetwork: Array<{ mac: string; name: string | null; lastSeenAt: string | null }>
  keys: DeviceGroupKeyView[]
}

const iso = (d: DateTime | null | undefined) => (d ? d.toUTC().toISO() : null)

async function labelNames(macs: string[]): Promise<Map<string, string | null>> {
  if (macs.length === 0) return new Map()
  const rows = (await db
    .from('device_labels')
    .whereIn('mac', macs)
    .select('mac', 'name')) as Array<{ mac: string; name: string | null }>
  return new Map(rows.map((r) => [r.mac.toLowerCase(), r.name]))
}

function networkOf(views: GatewayNetworkView[], perchId: string | null): DeviceGroupNetwork | null {
  if (!perchId) return null
  const v = views.find((n) => n.perchId === perchId)
  if (!v) return null
  return {
    perchId,
    name: v.key,
    label: v.label,
    vlanId: v.vlanId,
    ipv4: v.ipv4,
    zone: v.firewallZone,
  }
}

async function gatewayNetworks(gatewayId: number): Promise<GatewayNetworkView[]> {
  try {
    return await listGatewayNetworks(gatewayId)
  } catch (error) {
    logger.debug({ gatewayId, err: error }, 'device_groups: networks unavailable')
    return []
  }
}

/** The group's QoS assignment: its own, else an admin's aimed at the group. */
async function qosOf(
  group: DeviceGroup,
  client?: TransactionClientContract
): Promise<QosAssignment | null> {
  const options = client ? { client } : undefined
  const own = await QosAssignment.query(options)
    .where('gatewayId', group.gatewayId)
    .where('source', 'group')
    .where('sourceRef', groupSourceRef(group.id))
    .first()
  if (own) return own
  return QosAssignment.query(options)
    .where('gatewayId', group.gatewayId)
    .where('targetType', 'group')
    .where('groupId', group.id)
    .first()
}

function qosView(a: QosAssignment | null): DeviceGroupQos | null {
  if (!a) return null
  return {
    assignmentId: a.id,
    policyId: a.policyId,
    rate: wireRate(rateFromColumns(a.downKbit, a.upKbit)),
    via: a.targetType === 'network' ? 'network' : 'group',
    source: a.source === 'group' ? 'group' : 'admin',
  }
}

/** MACs seen on a network of a gateway lately (captured traffic and DHCP). */
async function macsOnNetwork(
  gateway: Gateway,
  network: string
): Promise<Map<string, string | null>> {
  const since = DateTime.utc().minus({ days: ON_NETWORK_DAYS }).toSQL({ includeOffset: false })
  const out = new Map<string, string | null>()
  const seen = (await db
    .from('device_network_latest')
    .where('gateway_id', gateway.id)
    .where('network', network)
    .where('seen_at', '>=', since)
    .select('mac', 'seen_at')) as Array<{ mac: string; seen_at: Date | string }>
  const at = (v: Date | string | null) =>
    v === null ? null : DateTime.fromJSDate(new Date(v)).toUTC().toISO()
  for (const r of seen) out.set(r.mac.toLowerCase(), at(r.seen_at))
  if (gateway.collectorId !== null) {
    const hosts = (await db
      .from('gateway_hosts')
      .where('collector_id', gateway.collectorId)
      .where('network', network)
      .where('last_reported_at', '>=', since)
      .select('mac', 'last_reported_at')) as Array<{ mac: string; last_reported_at: Date | null }>
    for (const h of hosts) {
      const mac = h.mac.toLowerCase()
      if (!out.has(mac)) out.set(mac, at(h.last_reported_at))
    }
  }
  return out
}

async function sectionStates(gatewayId: number): Promise<SectionState[]> {
  try {
    const { states } = await loadSections(gatewayId)
    return states
  } catch {
    return []
  }
}

function firewallState(
  states: SectionState[],
  group: DeviceGroup
): DeviceGroupView['firewall']['state'] {
  const own = states.filter(
    (s) => s.config === 'firewall' && new RegExp(`^perch_g${group.id}(_|$)`).test(s.name)
  )
  const present = own.filter((s) => s.desired !== null || s.router !== null)
  if (present.some((s) => s.status === 'conflict' || s.status === 'drift')) return 'conflict'
  if (present.some((s) => s.status !== 'in_sync')) return 'pending'
  if (group.internet) return 'none'
  return present.some((s) => s.desired !== null) ? 'applied' : 'pending'
}

async function viewsOf(
  groups: DeviceGroup[],
  networksByGateway: Map<number, GatewayNetworkView[]>
): Promise<DeviceGroupView[]> {
  if (groups.length === 0) return []
  const statesByGateway = new Map<number, SectionState[]>()
  for (const gid of new Set(groups.map((g) => g.gatewayId))) {
    statesByGateway.set(gid, await sectionStates(gid))
  }
  const ids = groups.map((g) => g.id)
  const counts = (await db
    .from('device_group_members')
    .whereIn('group_id', ids)
    .groupBy('group_id')
    .select('group_id')
    .count('* as n')) as Array<{ group_id: number; n: number | string }>
  const keyCounts = (await db
    .from('device_group_keys')
    .whereIn('group_id', ids)
    .groupBy('group_id')
    .select('group_id')
    .count('* as n')) as Array<{ group_id: number; n: number | string }>
  const out: DeviceGroupView[] = []
  for (const g of groups) {
    const network = networkOf(networksByGateway.get(g.gatewayId) ?? [], g.networkPerchId)
    let onNetwork = 0
    if (network) {
      const gateway = await Gateway.find(g.gatewayId)
      if (gateway) {
        const seen = await macsOnNetwork(gateway, network.name)
        onNetwork = seen.size
      }
    }
    out.push({
      id: g.id,
      gatewayId: g.gatewayId,
      name: g.name,
      notes: g.notes,
      network,
      qos: qosView(await qosOf(g)),
      internet: Boolean(g.internet),
      portalBypass: Boolean(g.portalBypass),
      counts: {
        bound: Number(counts.find((c) => Number(c.group_id) === g.id)?.n ?? 0),
        onNetwork,
        keys: Number(keyCounts.find((c) => Number(c.group_id) === g.id)?.n ?? 0),
      },
      firewall: { state: firewallState(statesByGateway.get(g.gatewayId) ?? [], g) },
      createdAt: iso(g.createdAt)!,
      updatedAt: iso(g.updatedAt ?? g.createdAt)!,
    })
  }
  return out
}

/** GET /device-groups?gatewayId= (every gateway without one). */
export async function listDeviceGroups(filter: { gatewayId?: number }): Promise<DeviceGroupView[]> {
  const query = DeviceGroup.query().orderBy('gatewayId').orderBy('name')
  if (filter.gatewayId !== undefined) query.where('gatewayId', filter.gatewayId)
  const groups = await query
  const networks = new Map<number, GatewayNetworkView[]>()
  for (const id of new Set(groups.map((g) => g.gatewayId))) {
    networks.set(id, await gatewayNetworks(id))
  }
  return viewsOf(groups, networks)
}

async function findGroup(id: number): Promise<DeviceGroup> {
  const group = await DeviceGroup.find(id)
  if (!group) throw refuse(404, 'group_not_found', `There is no device group ${id}.`, { id })
  return group
}

/** GET /device-groups/:id */
export async function getDeviceGroup(id: number): Promise<DeviceGroupDetail> {
  const group = await findGroup(id)
  const networks = await gatewayNetworks(group.gatewayId)
  const [view] = await viewsOf([group], new Map([[group.gatewayId, networks]]))
  const members = await DeviceGroupMember.query().where('groupId', id).orderBy('mac')
  const userIds = [...new Set(members.map((m) => m.portalUserId).filter((u) => u !== null))]
  const users = userIds.length
    ? ((await db
        .from('portal_users')
        .whereIn('id', userIds as number[])
        .select('id', 'username')) as Array<{
        id: number
        username: string
      }>)
    : []
  const onNet = new Map<string, string | null>()
  if (view.network) {
    const gateway = await Gateway.find(group.gatewayId)
    if (gateway)
      for (const [mac, at] of await macsOnNetwork(gateway, view.network.name)) onNet.set(mac, at)
  }
  const names = await labelNames([...members.map((m) => m.mac), ...onNet.keys()])
  const keys = await DeviceGroupKey.query().where('groupId', id).orderBy('id')
  return {
    ...view,
    members: members.map((m) => ({
      mac: m.mac,
      name: names.get(m.mac) ?? null,
      source: m.source === 'portal' ? 'portal' : 'manual',
      portalUserId: m.portalUserId,
      portalUsername: users.find((u) => u.id === m.portalUserId)?.username ?? null,
      createdAt: iso(m.createdAt)!,
    })),
    onNetwork: [...onNet.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mac, lastSeenAt]) => ({ mac, name: names.get(mac) ?? null, lastSeenAt })),
    keys: keys.map((k) => ({ id: k.id, label: k.label, createdAt: iso(k.createdAt)! })),
  }
}

/** The group a device is in on a gateway: bound, or seen on a group's network. */
export async function deviceGroupOf(
  macRaw: string,
  gatewayId?: number
): Promise<{ group: DeviceGroupView; via: 'bound' | 'network' } | null> {
  const mac = normalizeMac(macRaw)
  if (!mac) throw refuse(400, 'invalid_mac', `"${macRaw}" is not a MAC address.`)
  const q = DeviceGroupMember.query().where('mac', mac)
  if (gatewayId !== undefined) q.where('gatewayId', gatewayId)
  const member = await q.first()
  if (member) {
    const group = await findGroup(member.groupId)
    const [view] = await viewsOf(
      [group],
      new Map([[group.gatewayId, await gatewayNetworks(group.gatewayId)]])
    )
    return { group: view, via: 'bound' }
  }
  const seen = (await db
    .from('device_network_latest')
    .where('mac', mac)
    .if(gatewayId !== undefined, (b) => b.where('gateway_id', gatewayId!))
    .orderBy('seen_at', 'desc')
    .select('gateway_id', 'network')) as Array<{ gateway_id: number; network: string }>
  for (const row of seen) {
    const networks = await gatewayNetworks(row.gateway_id)
    const net = networks.find((n) => n.key === row.network && n.perchId)
    if (!net) continue
    const group = await DeviceGroup.query()
      .where('gatewayId', row.gateway_id)
      .where('networkPerchId', net.perchId!)
      .first()
    if (group) {
      const [view] = await viewsOf([group], new Map([[group.gatewayId, networks]]))
      return { group: view, via: 'network' }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Writes

export type WriteContext = { userId: number | null }

export type GroupQosInput = {
  policyId?: number | null
  rate?: QosRate | null
} | null

export type DeviceGroupInput = {
  name?: string
  notes?: string | null
  networkPerchId?: string | null
  internet?: boolean
  portalBypass?: boolean
  qos?: GroupQosInput
}

async function writableGateway(ref: GatewayRef): Promise<Gateway> {
  const { gateway } = await resolveGateway(ref)
  return gateway
}

function requireManagedFor(gateway: Gateway, what: string) {
  if (normalizeMode(gateway.mode) !== 'managed') {
    throw refuse(409, 'not_managed', `${what} needs the gateway in managed mode.`)
  }
}

async function requireName(gatewayId: number, name: string, selfId: number | null) {
  const clash = await DeviceGroup.query()
    .where('gatewayId', gatewayId)
    .where('name', name)
    .if(selfId !== null, (q) => q.whereNot('id', selfId!))
    .first()
  if (clash) {
    throw refuse(409, 'group_name_taken', `A group is already called "${name}".`, {
      groupId: clash.id,
    })
  }
}

/** The network must exist on the gateway, and belong to no other group. */
async function requireNetwork(
  gatewayId: number,
  perchId: string,
  selfId: number | null
): Promise<DeviceGroupNetwork> {
  const network = networkOf(await gatewayNetworks(gatewayId), perchId)
  if (!network) {
    throw refuse(422, 'group_network_unknown', `The gateway has no network ${perchId}.`, {
      field: 'networkPerchId',
    })
  }
  const other = await DeviceGroup.query()
    .where('gatewayId', gatewayId)
    .where('networkPerchId', perchId)
    .if(selfId !== null, (q) => q.whereNot('id', selfId!))
    .first()
  if (other) {
    throw refuse(
      422,
      'group_network_taken',
      `${network.label} is already group "${other.name}"'s network.`,
      {
        field: 'networkPerchId',
        groupId: other.id,
      }
    )
  }
  return network
}

/**
 * Brings the group's QoS assignment in line: `qos` given = the wanted
 * policy / rate (null = none); undefined = keep it, but re-target it when
 * the group's network changed (network default ↔ group assignment).
 */
async function syncGroupQos(
  group: DeviceGroup,
  network: DeviceGroupNetwork | null,
  qos: GroupQosInput | undefined,
  ctx: WriteContext
): Promise<void> {
  const current = await qosOf(group)
  const wantTarget = network
    ? ({ type: 'network', network: network.name } as const)
    : ({ type: 'group', groupId: group.id } as const)
  const targetMatches =
    current !== null &&
    (network
      ? current.targetType === 'network' && current.network === network.name
      : current.targetType === 'group' && current.groupId === group.id)
  const context = {
    userId: ctx.userId,
    source: 'group' as const,
    sourceRef: groupSourceRef(group.id),
  }

  let wanted: { policyId: number | null; rate: QosRate | null } | null
  if (qos === undefined) {
    if (!current || targetMatches) return
    wanted = {
      policyId: current.policyId,
      rate: wireRate(rateFromColumns(current.downKbit, current.upKbit)),
    }
  } else if (qos === null || ((qos.policyId ?? null) === null && !qos.rate)) {
    wanted = null
  } else {
    wanted = { policyId: qos.policyId ?? null, rate: qos.rate ?? null }
  }

  if (wanted === null) {
    if (current) await deleteAssignment(current.id, context)
    return
  }
  if (current && targetMatches) {
    await updateAssignment(current.id, { policyId: wanted.policyId, rate: wanted.rate }, context)
    return
  }
  if (current) await deleteAssignment(current.id, context)
  await createAssignment(
    { gatewayId: group.gatewayId },
    { policyId: wanted.policyId, rate: wanted.rate, target: wantTarget },
    context
  )
}

function checkName(name: string | undefined) {
  if (name === undefined) return
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw refuse(422, 'group_name_invalid', 'A group name is 1 to 64 characters.', {
      field: 'name',
    })
  }
}

/** POST /device-groups */
export async function createDeviceGroup(
  ref: GatewayRef,
  input: DeviceGroupInput & { name: string },
  ctx: WriteContext
): Promise<DeviceGroupDetail> {
  const gateway = await writableGateway(ref)
  checkName(input.name)
  const name = input.name.trim()
  await requireName(gateway.id, name, null)
  const network = input.networkPerchId
    ? await requireNetwork(gateway.id, input.networkPerchId, null)
    : null
  if (input.portalBypass && network) {
    throw refuse(
      422,
      'group_bypass_with_network',
      'A group with its own network has no portal to pass.',
      {
        field: 'portalBypass',
      }
    )
  }
  if (input.internet === false) requireManagedFor(gateway, 'Blocking the internet')
  const group = await DeviceGroup.create({
    gatewayId: gateway.id,
    name,
    notes: input.notes ?? null,
    networkPerchId: network?.perchId ?? null,
    internet: input.internet ?? true,
    portalBypass: input.portalBypass ?? false,
  })
  try {
    if (input.qos) await syncGroupQos(group, network, input.qos, ctx)
  } catch (error) {
    await group.delete()
    throw error
  }
  await afterChange(gateway.id, ctx, {
    firewall: input.internet === false,
    portal: false,
    aps: Boolean(network),
  })
  return getDeviceGroup(group.id)
}

/** PATCH /device-groups/:id */
export async function updateDeviceGroup(
  id: number,
  input: DeviceGroupInput,
  ctx: WriteContext
): Promise<DeviceGroupDetail> {
  const group = await findGroup(id)
  const gateway = await writableGateway({ gatewayId: group.gatewayId })
  checkName(input.name)
  if (input.name !== undefined) await requireName(gateway.id, input.name.trim(), id)
  let network: DeviceGroupNetwork | null
  const networkChanged =
    input.networkPerchId !== undefined && (input.networkPerchId ?? null) !== group.networkPerchId
  if (input.networkPerchId !== undefined) {
    network = input.networkPerchId
      ? await requireNetwork(gateway.id, input.networkPerchId, id)
      : null
  } else {
    network = networkOf(await gatewayNetworks(gateway.id), group.networkPerchId)
  }
  const bypass = input.portalBypass ?? Boolean(group.portalBypass)
  if (bypass && (network || (input.networkPerchId === undefined && group.networkPerchId))) {
    throw refuse(
      422,
      'group_bypass_with_network',
      'A group with its own network has no portal to pass.',
      {
        field: 'portalBypass',
      }
    )
  }
  if (input.internet === false) requireManagedFor(gateway, 'Blocking the internet')
  if (networkChanged && !network) {
    const keys = await DeviceGroupKey.query().where('groupId', id).first()
    if (keys) {
      throw refuse(
        422,
        'group_keys_need_vlan',
        'Remove the Wi-Fi keys first: they need the group’s network.',
        {
          field: 'networkPerchId',
        }
      )
    }
  }
  const firewallChanged =
    (input.internet !== undefined && input.internet !== Boolean(group.internet)) ||
    (networkChanged && !group.internet)
  const portalChanged =
    input.portalBypass !== undefined && input.portalBypass !== Boolean(group.portalBypass)

  const before = { name: group.name, notes: group.notes, networkPerchId: group.networkPerchId }
  if (input.name !== undefined) group.name = input.name.trim()
  if (input.notes !== undefined) group.notes = input.notes
  if (input.networkPerchId !== undefined) group.networkPerchId = network?.perchId ?? null
  if (input.internet !== undefined) group.internet = input.internet
  if (input.portalBypass !== undefined) group.portalBypass = input.portalBypass
  await group.save()
  try {
    if (input.qos !== undefined || networkChanged)
      await syncGroupQos(group, network, input.qos, ctx)
  } catch (error) {
    group.merge(before)
    await group.save()
    throw error
  }
  await afterChange(gateway.id, ctx, {
    firewall: firewallChanged || (!group.internet && input.name !== undefined),
    portal: portalChanged,
    aps: networkChanged,
  })
  return getDeviceGroup(id)
}

/** DELETE /device-groups/:id */
export async function deleteDeviceGroup(id: number, ctx: WriteContext): Promise<void> {
  const group = await findGroup(id)
  const own = await QosAssignment.query()
    .where('gatewayId', group.gatewayId)
    .where('source', 'group')
    .where('sourceRef', groupSourceRef(id))
    .first()
  if (own) {
    await deleteAssignment(own.id, {
      userId: ctx.userId,
      source: 'group',
      sourceRef: groupSourceRef(id),
    })
  }
  const effects = {
    firewall: !group.internet,
    portal: Boolean(group.portalBypass),
    aps: Boolean(group.networkPerchId),
  }
  await group.delete()
  await afterChange(group.gatewayId, ctx, effects)
}

/** POST /device-groups/:id/members `{mac, move?}` */
export async function addDeviceGroupMember(
  id: number,
  macRaw: string,
  options: { move?: boolean; source?: DeviceGroupMemberSource; portalUserId?: number | null },
  ctx: WriteContext,
  client?: TransactionClientContract
): Promise<{ moved: boolean; fromGroupId: number | null }> {
  const mac = normalizeMac(macRaw)
  if (!mac) throw refuse(400, 'invalid_mac', `"${macRaw}" is not a MAC address.`, { field: 'mac' })
  const group = await DeviceGroup.query(client ? { client } : undefined)
    .where('id', id)
    .first()
  if (!group) throw refuse(404, 'group_not_found', `There is no device group ${id}.`, { id })
  const run = async (trx: TransactionClientContract) => {
    const existing = await DeviceGroupMember.query({ client: trx })
      .where('gatewayId', group.gatewayId)
      .where('mac', mac)
      .forUpdate()
      .first()
    if (existing && existing.groupId === id) {
      if (options.source === 'portal' && existing.portalUserId !== (options.portalUserId ?? null)) {
        existing.source = 'portal'
        existing.portalUserId = options.portalUserId ?? null
        await existing.save()
      }
      return { moved: false, fromGroupId: null }
    }
    if (existing && !options.move) {
      throw refuse(409, 'group_mac_taken', `${mac} is in another group.`, {
        mac,
        groupId: existing.groupId,
      })
    }
    const fromGroupId = existing ? existing.groupId : null
    if (existing) await existing.useTransaction(trx).delete()
    await DeviceGroupMember.create(
      {
        gatewayId: group.gatewayId,
        groupId: id,
        mac,
        source: options.source ?? 'manual',
        portalUserId: options.portalUserId ?? null,
        createdByUserId: ctx.userId,
      },
      { client: trx }
    )
    return { moved: existing !== null, fromGroupId }
  }
  const result = client ? await run(client) : await db.transaction(run)
  if (!client) await afterMembersChanged(group.gatewayId, [id, result.fromGroupId], ctx)
  return result
}

/** DELETE /device-groups/:id/members/:mac */
export async function removeDeviceGroupMember(id: number, macRaw: string, ctx: WriteContext) {
  const mac = normalizeMac(macRaw)
  if (!mac) throw refuse(400, 'invalid_mac', `"${macRaw}" is not a MAC address.`, { field: 'mac' })
  const group = await findGroup(id)
  const deleted = await DeviceGroupMember.query().where('groupId', id).where('mac', mac).delete()
  if (Number(Array.isArray(deleted) ? deleted[0] : deleted) === 0) {
    throw refuse(404, 'group_member_not_found', `${mac} is not a bound member of this group.`)
  }
  await afterMembersChanged(group.gatewayId, [id], ctx)
}

/** What a membership change touches: the group's firewall set, bypass, the APs. */
export async function afterMembersChanged(
  gatewayId: number,
  groupIds: Array<number | null>,
  ctx: WriteContext
): Promise<void> {
  const ids = groupIds.filter((g): g is number => g !== null)
  const groups = ids.length ? await DeviceGroup.query().whereIn('id', ids) : []
  await afterChange(gatewayId, ctx, {
    firewall: groups.some((g) => !g.internet && !g.networkPerchId),
    portal: groups.some((g) => g.portalBypass),
    aps: groups.some((g) => g.networkPerchId),
  })
}

// ---------------------------------------------------------------------------
// Wi-Fi keys

const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** A readable passphrase: three groups of four (about 59 bits). */
export function generatePassphrase(): string {
  const part = () =>
    Array.from({ length: 4 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join('')
  return `${part()}-${part()}-${part()}`
}

/** WPA-PSK: 8 to 63 printable ASCII characters. */
export function isValidPassphrase(value: string): boolean {
  return /^[\x20-\x7e]{8,63}$/.test(value)
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** POST /device-groups/:id/keys `{label, passphrase?}` */
export async function createDeviceGroupKey(
  id: number,
  input: { label: string; passphrase?: string | null },
  ctx: WriteContext
): Promise<{ key: DeviceGroupKeyView; passphrase: string }> {
  const group = await findGroup(id)
  const network = networkOf(await gatewayNetworks(group.gatewayId), group.networkPerchId)
  if (!network || network.vlanId === null) {
    throw refuse(
      422,
      'group_keys_need_vlan',
      'Wi-Fi keys put devices in the group’s VLAN: give the group a VLAN network first.'
    )
  }
  const label = input.label.trim()
  if (label.length < 1 || label.length > 64) {
    throw refuse(422, 'group_key_label_invalid', 'A key label is 1 to 64 characters.', {
      field: 'label',
    })
  }
  const passphrase = input.passphrase ?? generatePassphrase()
  if (!isValidPassphrase(passphrase)) {
    throw refuse(
      422,
      'group_passphrase_invalid',
      'A Wi-Fi passphrase is 8 to 63 printable ASCII characters.',
      {
        field: 'passphrase',
      }
    )
  }
  const digest = sha256(passphrase)
  const taken = await DeviceGroupKey.query()
    .where('gatewayId', group.gatewayId)
    .where('passphraseDigest', digest)
    .first()
  if (taken) {
    throw refuse(409, 'group_passphrase_taken', 'Another key already uses this passphrase.', {
      groupId: taken.groupId,
    })
  }
  const key = await DeviceGroupKey.create({
    gatewayId: group.gatewayId,
    groupId: id,
    label,
    passphraseEncrypted: encryption.encrypt(passphrase),
    passphraseDigest: digest,
    createdByUserId: ctx.userId,
  })
  requestApGroupsSync('key added')
  return { key: { id: key.id, label: key.label, createdAt: iso(key.createdAt)! }, passphrase }
}

/** GET /device-groups/:id/keys/:keyId/passphrase */
export async function revealDeviceGroupKey(
  id: number,
  keyId: number
): Promise<{ passphrase: string }> {
  const key = await DeviceGroupKey.query().where('id', keyId).where('groupId', id).first()
  if (!key) throw refuse(404, 'group_key_not_found', `There is no key ${keyId} in this group.`)
  const passphrase = encryption.decrypt<string>(key.passphraseEncrypted)
  if (typeof passphrase !== 'string') {
    throw refuse(409, 'group_key_unreadable', 'The key cannot be decrypted (APP_KEY changed).')
  }
  return { passphrase }
}

/** DELETE /device-groups/:id/keys/:keyId */
export async function deleteDeviceGroupKey(id: number, keyId: number, _ctx: WriteContext) {
  const deleted = await DeviceGroupKey.query().where('id', keyId).where('groupId', id).delete()
  if (Number(Array.isArray(deleted) ? deleted[0] : deleted) === 0) {
    throw refuse(404, 'group_key_not_found', `There is no key ${keyId} in this group.`)
  }
  requestApGroupsSync('key removed')
}

/** Every group key of every gateway, decrypted (the AP desired state). */
export async function allGroupKeys(): Promise<
  Array<{ groupId: number; gatewayId: number; passphrase: string }>
> {
  const out: Array<{ groupId: number; gatewayId: number; passphrase: string }> = []
  for (const k of await DeviceGroupKey.query().orderBy('id')) {
    const passphrase = encryption.decrypt<string>(k.passphraseEncrypted)
    if (typeof passphrase === 'string')
      out.push({ groupId: k.groupId, gatewayId: k.gatewayId, passphrase })
    else logger.warn({ keyId: k.id }, 'device_groups: a Wi-Fi key cannot be decrypted; skipped')
  }
  return out
}

// ---------------------------------------------------------------------------
// Effects

/** The firewall specs of a gateway's groups (every group; unblocked ones render nothing). */
export async function groupFirewallSpecs(gatewayId: number): Promise<GroupFirewallSpec[]> {
  const groups = await DeviceGroup.query().where('gatewayId', gatewayId).orderBy('id')
  const networks = await gatewayNetworks(gatewayId)
  const members = await DeviceGroupMember.query().where('gatewayId', gatewayId)
  return groups.map((g) => {
    const network = networkOf(networks, g.networkPerchId)
    return {
      groupId: g.id,
      name: g.name,
      blocked: !g.internet,
      macs: members
        .filter((m) => m.groupId === g.id)
        .map((m) => m.mac)
        .sort(),
      network: network
        ? {
            name: network.name,
            zone: network.zone,
            ipv4: networks.find((n) => n.perchId === g.networkPerchId)?.ipv4All ?? [],
          }
        : null,
    }
  })
}

type Effects = { firewall?: boolean; portal?: boolean; aps?: boolean }

/**
 * The firewall follows the groups through a per-gateway job: debounced,
 * one at a time, and retried while another apply holds the gateway (an
 * edit or apply refused with `pending_apply` / `apply_in_flight`), so quick
 * changes in a row all reach the router.
 */
type FirewallJob = {
  timer: NodeJS.Timeout | null
  userId: number | null
  attempts: number
  running: boolean
  again: boolean
}
const firewallJobs = new Map<number, FirewallJob>()
const FIREWALL_DEBOUNCE_MS = 200
const FIREWALL_RETRY_MS = 3000
const FIREWALL_MAX_ATTEMPTS = 200
const RETRYABLE = new Set(['pending_apply', 'apply_in_flight'])

export function scheduleGroupFirewall(gatewayId: number, userId: number | null): void {
  let job = firewallJobs.get(gatewayId)
  if (!job) {
    job = { timer: null, userId, attempts: 0, running: false, again: false }
    firewallJobs.set(gatewayId, job)
  }
  if (userId !== null) job.userId = userId
  job.attempts = 0
  if (job.running) {
    job.again = true
    return
  }
  if (job.timer) clearTimeout(job.timer)
  job.timer = setTimeout(() => void runFirewallJob(gatewayId), FIREWALL_DEBOUNCE_MS)
  job.timer.unref()
}

async function runFirewallJob(gatewayId: number): Promise<void> {
  const job = firewallJobs.get(gatewayId)
  if (!job) return
  job.timer = null
  job.running = true
  job.again = false
  let retry = false
  try {
    const gateway = await Gateway.find(gatewayId)
    if (gateway && normalizeMode(gateway.mode) === 'managed') {
      const result = await reconcileGroupFirewall(
        gatewayId,
        job.userId,
        await groupFirewallSpecs(gatewayId)
      )
      if (result.applyError && RETRYABLE.has(result.applyError.error)) retry = true
      else if (result.applyError) {
        logger.warn(
          { gatewayId, error: result.applyError },
          'device_groups: firewall apply refused'
        )
      }
    }
  } catch (error) {
    if (error instanceof GatewayPlaneError && RETRYABLE.has(error.code)) retry = true
    else logger.warn({ gatewayId, err: error }, 'device_groups: firewall not reconciled')
  } finally {
    job.running = false
  }
  if (job.again || (retry && ++job.attempts < FIREWALL_MAX_ATTEMPTS)) {
    job.timer = setTimeout(
      () => void runFirewallJob(gatewayId),
      job.again ? FIREWALL_DEBOUNCE_MS : FIREWALL_RETRY_MS
    )
    job.timer.unref()
  } else {
    firewallJobs.delete(gatewayId)
  }
}

/** Tests: forget the firewall jobs. */
export function _resetDeviceGroupsState(): void {
  for (const job of firewallJobs.values()) if (job.timer) clearTimeout(job.timer)
  firewallJobs.clear()
}

async function afterChange(gatewayId: number, ctx: WriteContext, effects: Effects) {
  if (effects.firewall) scheduleGroupFirewall(gatewayId, ctx.userId)
  if (effects.portal) {
    try {
      const portals = await Portal.query().where('gatewayId', gatewayId).whereNull('deletedAt')
      if (portals.length) await configurePortals(portals.map((p) => p.id))
    } catch (error) {
      logger.warn({ gatewayId, err: error }, 'device_groups: portal bypass not pushed')
    }
  }
  if (effects.aps) requestApGroupsSync('groups changed')
}

/**
 * After a portal sign-in bound a device (decision 31): the group's QoS,
 * firewall and bypass follow the new member, and on a group with its own
 * network the access points get the binding and kick the device so it
 * rejoins in the group's VLAN (evicted bindings leave the APs too).
 */
export async function onPortalBinding(
  gatewayId: number,
  bound: { groupId: number; moved: boolean; mac: string; evicted: string[] }
): Promise<void> {
  await afterMembersChanged(gatewayId, [bound.groupId], { userId: null })
  if (bound.moved) requestApGroupsSync('portal binding', { kick: [bound.mac] })
}

/** Refusals from the QoS side keep their own shape. */
export function isGroupRefusal(error: unknown): error is DeviceGroupError | QosError {
  return error instanceof DeviceGroupError || error instanceof QosError
}
