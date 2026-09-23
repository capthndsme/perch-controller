import type Gateway from '#models/gateway'
import GatewayApply, { type GatewayApplyPostActions } from '#models/gateway_apply'
import GatewayHost from '#models/gateway_host'
import GatewayWanBlock, { type WanBlockFlush } from '#models/gateway_wan_block'
import WifiAccessPoint from '#models/wifi_access_point'
import { normalizeMac } from '#services/device_labels'
import { lanNetworks, requestApply } from '#services/gateway_config/apply_lifecycle'
import type { SectionEdit, SyncedSection } from '#services/gateway_config/domain'
import {
  dhcpHostsDomain,
  macsOf,
  type DhcpReservation,
} from '#services/gateway_config/domains/dhcp_hosts'
import {
  addNetworkToZone,
  BLOCK_RULE_PREFIX,
  BLOCK_SET_NAME,
  checkRulePath,
  cloneOptions,
  familyOf,
  FIREWALL_DOMAIN_KEY,
  firewallDomain,
  ipInCidr,
  isIpv4,
  parsePorts,
  portText,
  protocolsOf,
  redirectMatch,
  redirectShadows,
  redirectsOverlap,
  removeNetworkFromZone,
  ruleMatch,
  ruleShadows,
  truthy,
  wanZones,
  wordsOf,
  zoneInfo,
  zoneOfNetwork,
  zoneObjectsForNetwork,
  zonesOf,
  type FirewallObject,
  type NetworkPurpose,
  type ZoneInfo,
} from '#services/gateway_config/domains/firewall'
import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import {
  editSections,
  findGateway,
  resolveSectionOrder,
  setSectionOrder,
} from '#services/gateway_config/gateway_config_service'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import { findOrder, loadOrders, saveOrder } from '#services/gateway_config/order_store'
import {
  orderMembers,
  routerOrder,
  setDesiredOrder,
  type OrderKey,
  type OrderState,
} from '#services/gateway_config/section_order'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { Issue, PlaneActor, UciOptions } from '#services/gateway_config/types'
import { resolveManagedGateway } from '#services/gateway_config/device_names'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The firewall's REST layer (docs/gateway/firewall.md; plan 2 sections 4.3
 * and 5): the overview, port forwards, Perch rules and their order, and the
 * per-device WAN block with its conntrack flush. Every write goes into the
 * draft through `editSections` and, unless `?apply=0`, straight into an
 * apply of the touched sections (the response carries it, or `applyError`).
 */

const RULE_KEY: OrderKey = { config: 'firewall', type: 'rule' }
const REDIRECT_KEY: OrderKey = { config: 'firewall', type: 'redirect' }

// ── views ────────────────────────────────────────────────────────────────

export type FirewallSync = {
  perchId: string
  section: string
  owner: 'perch' | 'router'
  scope: SectionState['scope']
  issue: SectionState['issue']
  status: SectionState['status']
  applied: boolean
  conflict: boolean
  driftSince: string | null
}

export type ZoneView = ZoneInfo & { wan: boolean; management: boolean; sync: FirewallSync }
export type ForwardingView = {
  src: string
  dest: string
  family: string
  enabled: boolean
  sync: FirewallSync
}
export type FirewallRuleView = {
  id: string
  name: string | null
  enabled: boolean
  position: number | null
  src: string | null
  dest: string | null
  proto: string[]
  srcIp: string[]
  srcMac: string[]
  destIp: string[]
  srcPort: string | null
  destPort: string | null
  family: string | null
  target: string
  ipset: string | null
  /** A rule of the per-device WAN block. */
  perchBlock: boolean
  shadowedBy: string | null
  pathIssue: string | null
  sync: FirewallSync
}
export type PortForwardView = {
  id: string
  name: string | null
  enabled: boolean
  position: number | null
  proto: string[]
  srcZone: string | null
  externalPort: string | null
  destZone: string | null
  destIp: string | null
  destPort: string | null
  reflection: boolean
  family: string | null
  srcIp: string[]
  device: { mac: string; name: string | null } | null
  shadowedBy: string | null
  sync: FirewallSync
}
export type IncludeView = {
  perchId: string
  section: string
  type: string | null
  path: string | null
  position: string | null
  owner: 'package' | 'perch' | 'operator'
  /** The file's hash is not read by the plane (null); the section is observed only. */
  sha256: null
}
export type IpsetView = {
  perchId: string
  section: string
  name: string | null
  match: string[]
  entries: number
  family: string | null
  managed: boolean
}
export type OrderView = {
  status: OrderState['status']
  desired: string[]
  router: string[]
  conflict: OrderState['conflict']
  driftSince: string | null
}
export type FirewallOverview = {
  gatewayId: number
  mode: string
  authoritative: boolean
  zones: ZoneView[]
  forwardings: ForwardingView[]
  rules: FirewallRuleView[]
  portForwards: PortForwardView[]
  ipsets: IpsetView[]
  includes: IncludeView[]
  /** Other sections Perch only observes (`nat`, SNAT redirects), by type. */
  observed: Array<{ perchId: string; section: string; type: string }>
  defaults: UciOptions | null
  flowOffloading: boolean
  flowOffloadingHw: boolean
  wanZones: string[]
  managementZone: string | null
  orders: { rule: OrderView | null; redirect: OrderView | null }
  issues: Issue[]
}

function contentOf(s: SectionState) {
  return s.desired ?? s.router
}

function fwStates(states: SectionState[]): SectionState[] {
  return states
    .filter((s) => s.config === 'firewall' && contentOf(s) !== null)
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.perchId.localeCompare(b.perchId)
    )
}

function syncOf(s: SectionState): FirewallSync {
  return {
    perchId: s.perchId,
    section: s.name,
    owner: s.scope === 'synced' ? 'perch' : 'router',
    scope: s.scope,
    issue: s.issue,
    status: s.status,
    applied: s.router !== null && s.status === 'in_sync',
    conflict: s.conflict !== null,
    driftSince: s.driftSince,
  }
}

function scalar(options: UciOptions, key: string): string | null {
  const v = options[key]
  if (v === undefined) return null
  return Array.isArray(v) ? v.join(' ') : v
}

/** Zones of the firewall (every scope, the desired side of synced ones). */
function allZones(states: SectionState[]): ZoneInfo[] {
  return zonesOf(
    fwStates(states)
      .filter((s) => contentOf(s)!.type === 'zone')
      .map((s) => ({ type: 'zone', options: contentOf(s)!.options }))
  )
}

function managementZoneOf(gateway: Gateway, zones: ZoneInfo[]): string | null {
  return zoneOfNetwork(zones, gateway.managementPath?.network ?? null)
}

function isBlockRule(options: UciOptions): boolean {
  return scalar(options, 'ipset')?.replace(/^!/, '').trim() === BLOCK_SET_NAME
}

export function ruleView(
  s: SectionState,
  extra: { position: number | null; shadowedBy: string | null; pathIssue: string | null }
): FirewallRuleView {
  const o = contentOf(s)!.options
  const m = ruleMatch(o)
  return {
    id: s.perchId,
    name: scalar(o, 'name'),
    enabled: m.enabled,
    position: extra.position,
    src: m.src,
    dest: m.dest,
    proto: m.proto,
    srcIp: m.srcIp,
    srcMac: m.srcMac,
    destIp: m.destIp,
    srcPort: portText(o.src_port),
    destPort: portText(o.dest_port),
    family: scalar(o, 'family'),
    target: m.target,
    ipset: m.ipset,
    perchBlock: isBlockRule(o),
    shadowedBy: extra.shadowedBy,
    pathIssue: extra.pathIssue,
    sync: syncOf(s),
  }
}

function hostDevice(states: SectionState[], ip: string | null) {
  if (!ip) return null
  for (const s of states) {
    const c = contentOf(s)
    if (s.config !== 'dhcp' || !c || c.type !== 'host') continue
    if (scalar(c.options, 'ip') !== ip) continue
    const mac = macsOf(c.options.mac)[0]
    if (mac) return { mac, name: scalar(c.options, 'name') }
  }
  return null
}

export function portForwardView(
  s: SectionState,
  states: SectionState[],
  extra: { position: number | null; shadowedBy: string | null }
): PortForwardView {
  const o = contentOf(s)!.options
  const m = redirectMatch(o)
  const destIp = scalar(o, 'dest_ip')
  return {
    id: s.perchId,
    name: scalar(o, 'name'),
    enabled: m.enabled,
    position: extra.position,
    proto: protocolsOf(o.proto).length > 0 ? protocolsOf(o.proto) : ['tcp', 'udp'],
    srcZone: m.src,
    externalPort: portText(o.src_dport),
    destZone: scalar(o, 'dest'),
    destIp,
    destPort: portText(o.dest_port),
    reflection: truthy(scalar(o, 'reflection'), true),
    family: scalar(o, 'family'),
    srcIp: m.srcIp,
    device: hostDevice(states, destIp),
    shadowedBy: extra.shadowedBy,
    sync: syncOf(s),
  }
}

function includeOwner(path: string | null): IncludeView['owner'] {
  if (!path) return 'operator'
  if (/perch/i.test(path)) return 'perch'
  if (/^\/(usr\/share|usr\/lib|lib|etc\/hotplug\.d)\//.test(path)) return 'package'
  return 'operator'
}

function orderView(order: OrderState | null, states: SectionState[]): OrderView | null {
  if (!order) return null
  const members = orderMembers(states, order)
  return {
    status: order.status,
    desired: order.desired,
    router: routerOrder(states, order).filter((id) => members.includes(id)),
    conflict: order.conflict,
    driftSince: order.driftSince,
  }
}

/** `GET /gateways/:id/firewall` (plan 2 section 5). */
export async function firewallOverview(
  gatewayId: number,
  options: { validate?: (gateway: Gateway, states: SectionState[]) => Issue[] } = {}
): Promise<FirewallOverview> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const orders = await loadOrders(gateway.id)
  const fw = fwStates(states)
  const zones = allZones(states)
  const wans = wanZones(zones)
  const mgmt = managementZoneOf(gateway, zones)
  const pathCtx = {
    managementZone: mgmt,
    controllerAddress: gateway.managementPath?.controllerAddress ?? null,
  }

  const view: FirewallOverview = {
    gatewayId: gateway.id,
    mode: normalizeMode(gateway.mode),
    authoritative: Boolean(gateway.authoritative),
    zones: [],
    forwardings: [],
    rules: [],
    portForwards: [],
    ipsets: [],
    includes: [],
    observed: [],
    defaults: null,
    flowOffloading: false,
    flowOffloadingHw: false,
    wanZones: wans,
    managementZone: mgmt,
    orders: {
      rule: orderView(orders.find((o) => o.type === 'rule') ?? null, states),
      redirect: orderView(orders.find((o) => o.type === 'redirect') ?? null, states),
    },
    issues: [],
  }
  const rules = fw.filter((s) => contentOf(s)!.type === 'rule')
  const ruleShadow = ruleShadows(
    rules.map((s) => ({ id: s.perchId, options: contentOf(s)!.options }))
  )
  const redirects = fw.filter(
    (s) =>
      contentOf(s)!.type === 'redirect' &&
      firewallDomain.claims({ ...asUci(s), config: 'firewall' }, {})
  )
  const redirectShadow = redirectShadows(
    redirects.map((s) => ({ id: s.perchId, options: contentOf(s)!.options }))
  )
  for (const s of fw) {
    const c = contentOf(s)!
    switch (c.type) {
      case 'zone': {
        const z = zoneInfo(c.options)
        view.zones.push({
          ...z,
          wan: wans.includes(z.name),
          management: z.name === mgmt,
          sync: syncOf(s),
        })
        break
      }
      case 'forwarding':
        view.forwardings.push({
          src: scalar(c.options, 'src') ?? '',
          dest: scalar(c.options, 'dest') ?? '',
          family: familyOf(scalar(c.options, 'family')),
          enabled: truthy(scalar(c.options, 'enabled'), true),
          sync: syncOf(s),
        })
        break
      case 'rule':
        view.rules.push(
          ruleView(s, {
            position: rules.indexOf(s),
            shadowedBy: ruleShadow.get(s.perchId) ?? null,
            pathIssue: checkRulePath(c.options, pathCtx)?.code ?? null,
          })
        )
        break
      case 'redirect':
        if (redirects.includes(s)) {
          view.portForwards.push(
            portForwardView(s, states, {
              position: redirects.indexOf(s),
              shadowedBy: redirectShadow.get(s.perchId) ?? null,
            })
          )
        } else {
          view.observed.push({ perchId: s.perchId, section: s.name, type: c.type })
        }
        break
      case 'ipset':
        view.ipsets.push({
          perchId: s.perchId,
          section: s.name,
          name: scalar(c.options, 'name'),
          match: wordsOf(c.options.match),
          entries: wordsOf(c.options.entry).length,
          family: scalar(c.options, 'family'),
          managed: s.scope === 'synced',
        })
        break
      case 'include': {
        const path = scalar(c.options, 'path')
        view.includes.push({
          perchId: s.perchId,
          section: s.name,
          type: scalar(c.options, 'type'),
          path,
          position: scalar(c.options, 'position'),
          owner: includeOwner(path),
          sha256: null,
        })
        break
      }
      case 'defaults':
        view.defaults = { ...c.options }
        view.flowOffloading = truthy(scalar(c.options, 'flow_offloading'))
        view.flowOffloadingHw = truthy(scalar(c.options, 'flow_offloading_hw'))
        break
      default:
        view.observed.push({ perchId: s.perchId, section: s.name, type: c.type })
    }
  }
  if (options.validate) {
    const firewallIds = new Set(fw.map((s) => s.perchId))
    view.issues = options
      .validate(gateway, states)
      .filter((i) => i.config === 'firewall' || (i.perchId && firewallIds.has(i.perchId)))
  }
  return view
}

function asUci(s: SectionState) {
  const c = contentOf(s)!
  return {
    name: s.name,
    type: c.type,
    anonymous: s.anonymous,
    index: s.position ?? 0,
    options: c.options,
  }
}

// ── writes: shared ───────────────────────────────────────────────────────

export type FirewallWriteResult<T> = {
  gatewayId: number
  object: T
  issues: Issue[]
  apply: unknown | null
  applyError: { error: string; message: string } | null
}

async function applyNow(
  gateway: Gateway,
  userId: number | null,
  perchIds: string[],
  wanted: boolean,
  postActions?: GatewayApplyPostActions
): Promise<{ apply: unknown | null; applyError: FirewallWriteResult<unknown>['applyError'] }> {
  if (!wanted || perchIds.length === 0) return { apply: null, applyError: null }
  try {
    const apply = await requestApply(gateway.id, {
      userId,
      ...(userId === null ? { actor: { system: 'system' as const } } : {}),
      perchIds,
      postActions,
    })
    return { apply, applyError: null }
  } catch (error) {
    if (error instanceof GatewayPlaneError) {
      return { apply: null, applyError: { error: error.code, message: error.message } }
    }
    throw error
  }
}

function requireManaged(gateway: Gateway) {
  if (normalizeMode(gateway.mode) !== 'managed') {
    throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
  }
}

function asSynced(s: SectionState): SyncedSection[] {
  const c = contentOf(s)
  return c
    ? [
        {
          perchId: s.perchId,
          config: s.config,
          name: s.name,
          type: c.type,
          anonymous: s.anonymous,
          options: c.options,
          ...(c.secrets ? { secrets: c.secrets } : {}),
        },
      ]
    : []
}

function objectOf(s: SectionState): FirewallObject {
  return firewallDomain.parse(asSynced(s))[0]
}

function findSection(states: SectionState[], perchId: string, type: string) {
  const s = states.find((x) => x.perchId === perchId && x.config === 'firewall')
  const c = s ? contentOf(s) : null
  if (!s || !c || c.type !== type) return null
  return s
}

function requireSynced(s: SectionState) {
  if (s.scope !== 'synced') {
    throw planeError(409, 'not_synced', 'This section is the router’s; include it first.', {
      perchId: s.perchId,
      issue: s.issue,
    })
  }
}

function checkZone(zones: ZoneInfo[], zone: string, field: string, allowAny = false) {
  if (allowAny && zone === '*') return
  if (!zones.some((z) => z.name === zone)) {
    throw planeError(422, 'firewall_zone_unknown', `No firewall zone "${zone}".`, { field })
  }
}

function checkPorts(value: string | null | undefined, field: string, single = false): void {
  if (value === null || value === undefined) return
  const ports = parsePorts(value)
  if (ports === null || ports.length === 0 || (single && ports.length !== 1)) {
    throw planeError(422, 'firewall_port_invalid', `"${value}" is not a port or port range.`, {
      field,
    })
  }
}

/** The zone of an IPv4 address (the LAN network whose subnet holds it). */
function zoneOfAddress(states: SectionState[], zones: ZoneInfo[], ip: string): string | null {
  for (const network of lanNetworks(states)) {
    if (network.ipv4.some((cidr) => ipInCidr(ip, cidr))) {
      return zoneOfNetwork(zones, network.name)
    }
  }
  return null
}

/** Places new members of an order (a Perch rule on top, the block rules first toward WAN). */
async function placeInOrder(
  gateway: Gateway,
  userId: number | null,
  key: OrderKey,
  ids: string[],
  where: (desired: string[], states: SectionState[]) => number
): Promise<void> {
  if (ids.length === 0) return
  await gatewayQueue.run(gateway.id, async () => {
    const { states } = await loadSections(gateway.id)
    const prev = await findOrder(gateway.id, key)
    const members = orderMembers(states, key)
    const current = (prev?.desired ?? routerOrder(states, key)).filter(
      (id) => members.includes(id) && !ids.includes(id)
    )
    const at = Math.max(0, Math.min(where(current, states), current.length))
    const next = [...current.slice(0, at), ...ids, ...current.slice(at)]
    await saveOrder(gateway.id, setDesiredOrder(prev, key, states, next), { userId })
  })
}

// ── port forwards ────────────────────────────────────────────────────────

export type PortForwardInput = {
  name?: string
  proto?: Array<'tcp' | 'udp'>
  externalPort?: string
  destIp?: string
  deviceMac?: string
  destPort?: string | null
  reflection?: boolean
  enabled?: boolean
  srcZone?: string
  destZone?: string
  /** Allow a destination no DHCP reservation holds (a static address). */
  allowUnreserved?: boolean
  apply?: boolean
}

type Destination = { ip: string; reservationEdits: SectionEdit[]; reservationId: string | null }

/**
 * A port forward must target a reserved address (plan 2 section 4.3): with
 * `deviceMac`, the device's reservation, else one is created from its
 * current lease in the same job (`dhcp` before `firewall`).
 */
async function resolveDestination(
  gateway: Gateway,
  states: SectionState[],
  input: PortForwardInput
): Promise<Destination> {
  if (input.deviceMac) {
    const mac = normalizeMac(input.deviceMac)
    if (!mac) throw planeError(400, 'invalid_mac', `"${input.deviceMac}" is not a MAC address.`)
    const host = states.find((s) => {
      const c = contentOf(s)
      return (
        s.config === 'dhcp' &&
        c?.type === 'host' &&
        macsOf(c.options.mac).includes(mac) &&
        isIpv4(scalar(c.options, 'ip') ?? '')
      )
    })
    if (host) {
      return {
        ip: scalar(contentOf(host)!.options, 'ip')!,
        reservationEdits: [],
        reservationId: null,
      }
    }
    const lease = await GatewayHost.query()
      .where('collector_id', gateway.collectorId ?? 0)
      .where('mac', mac)
      .first()
    const ip = lease?.ipv4?.split(',')[0].trim() ?? null
    if (!ip || !isIpv4(ip)) {
      throw planeError(
        409,
        'device_no_lease',
        'The device has no reservation and no current lease.'
      )
    }
    const own = states.find((s) => {
      const c = contentOf(s)
      return (
        s.config === 'dhcp' &&
        s.scope === 'synced' &&
        c?.type === 'host' &&
        macsOf(c.options.mac).includes(mac)
      )
    })
    if (
      !own &&
      states.some((s) => {
        const c = contentOf(s)
        return s.config === 'dhcp' && c?.type === 'host' && macsOf(c.options.mac).includes(mac)
      })
    ) {
      throw planeError(
        409,
        'dhcp_host_exists',
        'The router has its own host entry for this device.'
      )
    }
    const current: DhcpReservation | null = own ? dhcpHostsDomain.parse(asSynced(own))[0] : null
    const obj: DhcpReservation = current
      ? { ...current, ip }
      : {
          perchId: null,
          section: '',
          macs: [mac],
          macForm: 'string',
          ip,
          name: null,
          dns: null,
          leasetime: null,
          extra: {},
          secretNames: [],
          macRaw: null,
        }
    return {
      ip,
      reservationEdits: dhcpHostsDomain.render(obj, own ? asSynced(own) : []),
      reservationId: own?.perchId ?? null,
    }
  }
  const ip = input.destIp ?? ''
  if (!isIpv4(ip)) throw planeError(422, 'firewall_ip_invalid', `"${ip}" is not an IPv4 address.`)
  if (!input.allowUnreserved && !hostDevice(states, ip)) {
    throw planeError(
      422,
      'firewall_dest_not_reserved',
      `No DHCP reservation holds ${ip}. Reserve the device's address first (or name the device).`,
      { destIp: ip }
    )
  }
  return { ip, reservationEdits: [], reservationId: null }
}

function checkOverlap(states: SectionState[], options: UciOptions, exceptId: string | null) {
  const mine = redirectMatch(options)
  if (!mine.enabled) return
  for (const s of fwStates(states)) {
    const c = contentOf(s)!
    if (s.perchId === exceptId || c.type !== 'redirect') continue
    if (!firewallDomain.claims({ ...asUci(s), config: 'firewall' }, {})) continue
    if (redirectsOverlap(redirectMatch(c.options), mine)) {
      throw planeError(
        409,
        'firewall_port_taken',
        `Port forward ${scalar(c.options, 'name') ?? s.name} already takes that port.`,
        { id: s.perchId }
      )
    }
  }
}

function forwardOptions(
  base: UciOptions,
  input: PortForwardInput,
  dest: { ip: string; zone: string }
): UciOptions {
  const o = cloneOptions(base)
  if (input.name !== undefined) o.name = input.name
  if (input.srcZone !== undefined || o.src === undefined) o.src = input.srcZone ?? 'wan'
  if (input.proto !== undefined) {
    const proto = [...new Set(input.proto)].sort()
    o.proto = proto.length === 1 ? proto[0] : proto
  }
  if (input.externalPort !== undefined) o.src_dport = input.externalPort.replace(':', '-')
  o.dest = dest.zone
  o.dest_ip = dest.ip
  if (input.destPort !== undefined) {
    if (input.destPort === null) delete o.dest_port
    else o.dest_port = input.destPort.replace(':', '-')
  }
  if (input.reflection !== undefined) {
    if (input.reflection) delete o.reflection
    else o.reflection = '0'
  }
  if (input.enabled !== undefined) {
    if (input.enabled) delete o.enabled
    else o.enabled = '0'
  }
  if (o.target === undefined) o.target = 'DNAT'
  // New port forwards are IPv4 DNAT (fw4 has no NAT66 by default).
  if (Object.keys(base).length === 0) o.family = 'ipv4'
  return o
}

async function writePortForward(
  gatewayId: number,
  userId: number,
  perchId: string | null,
  input: PortForwardInput
): Promise<FirewallWriteResult<PortForwardView | null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const zones = allZones(states)
  const existing = perchId ? findSection(states, perchId, 'redirect') : null
  if (perchId && !existing) {
    throw planeError(404, 'port_forward_not_found', `No port forward ${perchId}.`)
  }
  if (existing) requireSynced(existing)
  checkPorts(input.externalPort, 'externalPort')
  checkPorts(input.destPort, 'destPort', true)
  if (input.srcZone !== undefined) checkZone(zones, input.srcZone, 'srcZone')
  else if (!existing) checkZone(zones, 'wan', 'srcZone')

  const base = existing ? contentOf(existing)!.options : {}
  let dest: Destination
  if (input.destIp !== undefined || input.deviceMac !== undefined || !existing) {
    dest = await resolveDestination(gateway, states, input)
  } else {
    dest = { ip: scalar(base, 'dest_ip') ?? '', reservationEdits: [], reservationId: null }
  }
  const destZone =
    input.destZone ??
    (input.destIp !== undefined || input.deviceMac !== undefined || !existing
      ? (zoneOfAddress(states, zones, dest.ip) ?? scalar(base, 'dest') ?? 'lan')
      : (scalar(base, 'dest') ?? 'lan'))
  checkZone(zones, destZone, 'destZone')
  const options = forwardOptions(base, input, { ip: dest.ip, zone: destZone })
  if (!options.src_dport) {
    throw planeError(422, 'firewall_port_invalid', 'Name the external port.', {
      field: 'externalPort',
    })
  }
  if (options.dest_port !== undefined) {
    const ext = parsePorts(options.src_dport)!
    const int = parsePorts(options.dest_port)!
    const width = (r: { from: number; to: number }) => r.to - r.from
    if (
      ext.length === 1 &&
      int.length === 1 &&
      width(int[0]) !== 0 &&
      width(int[0]) !== width(ext[0])
    ) {
      throw planeError(
        422,
        'firewall_port_invalid',
        'The internal range must match the external one.',
        {
          field: 'destPort',
        }
      )
    }
  }
  checkOverlap(states, options, existing?.perchId ?? null)

  let reservationIds: string[] = []
  if (dest.reservationEdits.length > 0) {
    const outcome = await editSections(gateway.id, userId, 'dhcp_hosts', dest.reservationEdits)
    reservationIds = dest.reservationId ? [dest.reservationId] : outcome.perchIds
  }
  const obj: FirewallObject = existing
    ? { ...objectOf(existing), options }
    : { perchId: null, section: '', type: 'redirect', options, secretNames: [] }
  const outcome = await editSections(
    gateway.id,
    userId,
    FIREWALL_DOMAIN_KEY,
    firewallDomain.render(obj, existing ? asSynced(existing) : [])
  )
  const id = existing?.perchId ?? outcome.perchIds[0]
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    [...reservationIds, id],
    input.apply !== false
  )
  return {
    gatewayId: gateway.id,
    object: await portForwardById(gateway.id, id),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

async function portForwardById(gatewayId: number, id: string): Promise<PortForwardView | null> {
  const { states } = await loadSections(gatewayId)
  const s = findSection(states, id, 'redirect')
  if (!s) return null
  const redirects = fwStates(states).filter((x) => contentOf(x)!.type === 'redirect')
  const shadows = redirectShadows(
    redirects.map((x) => ({ id: x.perchId, options: contentOf(x)!.options }))
  )
  return portForwardView(s, states, {
    position: redirects.indexOf(s),
    shadowedBy: shadows.get(id) ?? null,
  })
}

export async function createPortForward(
  gatewayId: number,
  userId: number,
  input: PortForwardInput
) {
  if (!input.name) throw planeError(422, 'firewall_name_required', 'Name the port forward.')
  if (!input.proto || input.proto.length === 0) {
    throw planeError(422, 'firewall_proto_required', 'Pick TCP, UDP or both.')
  }
  if (!input.destIp && !input.deviceMac) {
    throw planeError(422, 'firewall_dest_required', 'Name the destination: destIp or deviceMac.')
  }
  return writePortForward(gatewayId, userId, null, input)
}

export async function updatePortForward(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: PortForwardInput
) {
  return writePortForward(gatewayId, userId, perchId, input)
}

export async function deletePortForward(
  gatewayId: number,
  userId: number,
  perchId: string,
  options: { apply?: boolean } = {}
): Promise<FirewallWriteResult<null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const s = findSection(states, perchId, 'redirect')
  if (!s) throw planeError(404, 'port_forward_not_found', `No port forward ${perchId}.`)
  requireSynced(s)
  const outcome = await editSections(gateway.id, userId, FIREWALL_DOMAIN_KEY, [
    { op: 'delete', perchId },
  ])
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    outcome.deleted.includes(perchId) ? [] : [perchId],
    options.apply !== false
  )
  return { gatewayId: gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

// ── rules ────────────────────────────────────────────────────────────────

export type RuleInput = {
  name?: string
  src?: string
  dest?: string | null
  proto?: string[] | null
  srcMac?: string[] | null
  srcIp?: string[] | null
  destIp?: string[] | null
  destPort?: string | null
  target?: 'ACCEPT' | 'REJECT' | 'DROP'
  family?: 'ipv4' | 'ipv6' | 'any' | null
  enabled?: boolean
  /** New rules: `top` puts it first in the rule order (default `bottom`). */
  placement?: 'top' | 'bottom'
  /** The admin's client address, for the admin-path guard (set by the controller). */
  clientIp?: string | null
  apply?: boolean
}

function listOption(o: UciOptions, key: string, value: string[] | null | undefined) {
  if (value === undefined) return
  if (value === null || value.length === 0) delete o[key]
  else o[key] = value.length === 1 ? value[0] : [...value]
}

function ruleOptions(base: UciOptions, input: RuleInput): UciOptions {
  const o = cloneOptions(base)
  if (input.name !== undefined) o.name = input.name
  if (input.src !== undefined) o.src = input.src
  if (input.dest !== undefined) {
    if (input.dest === null) delete o.dest
    else o.dest = input.dest
  }
  listOption(
    o,
    'proto',
    input.proto?.map((p) => p.toLowerCase())
  )
  listOption(
    o,
    'src_mac',
    input.srcMac?.map((m) => m.toLowerCase())
  )
  listOption(o, 'src_ip', input.srcIp)
  listOption(o, 'dest_ip', input.destIp)
  if (input.destPort !== undefined) {
    if (input.destPort === null) delete o.dest_port
    else o.dest_port = input.destPort.replace(':', '-')
  }
  if (input.target !== undefined) o.target = input.target
  if (input.family !== undefined) {
    if (input.family === null || input.family === 'any') delete o.family
    else o.family = input.family
  }
  if (input.enabled !== undefined) {
    if (input.enabled) delete o.enabled
    else o.enabled = '0'
  }
  return o
}

/** The zone of the admin's client (its address inside a LAN network). */
function adminZoneOf(
  states: SectionState[],
  zones: ZoneInfo[],
  clientIp: string | null | undefined
) {
  if (!clientIp) return null
  const ip = clientIp.replace(/^::ffff:/, '')
  return isIpv4(ip) ? zoneOfAddress(states, zones, ip) : null
}

function checkRule(
  gateway: Gateway,
  states: SectionState[],
  options: UciOptions,
  clientIp?: string | null
) {
  const zones = allZones(states)
  // The lockout guard first (plan 2 section 4.3, T-F3): a rule that would
  // cut the controller or the admin is refused as such, output rule or not.
  const verdict = checkRulePath(options, {
    managementZone: managementZoneOf(gateway, zones),
    controllerAddress: gateway.managementPath?.controllerAddress ?? null,
    adminZone: adminZoneOf(states, zones, clientIp),
  })
  if (verdict) throw planeError(422, verdict.code, verdict.message)
  const src = scalar(options, 'src')
  if (src === null || src === '') {
    throw planeError(
      422,
      'firewall_rule_unsupported',
      'Perch rules match traffic from a zone (no output rules).',
      { field: 'src' }
    )
  }
  checkZone(zones, src, 'src', true)
  const dest = scalar(options, 'dest')
  if (dest !== null) checkZone(zones, dest, 'dest', true)
  checkPorts(scalar(options, 'dest_port'), 'destPort')
  const proto = protocolsOf(options.proto)
  if (
    options.dest_port !== undefined &&
    proto.length > 0 &&
    !proto.every((p) => p === 'tcp' || p === 'udp')
  ) {
    throw planeError(422, 'firewall_rule_unsupported', 'Ports need TCP or UDP.', {
      field: 'destPort',
    })
  }
  for (const mac of wordsOf(options.src_mac)) {
    if (!normalizeMac(mac)) throw planeError(422, 'invalid_mac', `"${mac}" is not a MAC address.`)
  }
}

async function ruleById(
  gatewayId: number,
  id: string,
  gateway: Gateway
): Promise<FirewallRuleView | null> {
  const { states } = await loadSections(gatewayId)
  const s = findSection(states, id, 'rule')
  if (!s) return null
  const rules = fwStates(states).filter((x) => contentOf(x)!.type === 'rule')
  const shadows = ruleShadows(rules.map((x) => ({ id: x.perchId, options: contentOf(x)!.options })))
  const zones = allZones(states)
  return ruleView(s, {
    position: rules.indexOf(s),
    shadowedBy: shadows.get(id) ?? null,
    pathIssue:
      checkRulePath(contentOf(s)!.options, {
        managementZone: managementZoneOf(gateway, zones),
        controllerAddress: gateway.managementPath?.controllerAddress ?? null,
      })?.code ?? null,
  })
}

export async function createRule(gatewayId: number, userId: number, input: RuleInput) {
  return writeRule(gatewayId, userId, null, input)
}

export async function updateRule(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: RuleInput
) {
  return writeRule(gatewayId, userId, perchId, input)
}

async function writeRule(
  gatewayId: number,
  userId: number,
  perchId: string | null,
  input: RuleInput
): Promise<FirewallWriteResult<FirewallRuleView | null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const existing = perchId ? findSection(states, perchId, 'rule') : null
  if (perchId && !existing) throw planeError(404, 'firewall_rule_not_found', `No rule ${perchId}.`)
  if (existing) {
    requireSynced(existing)
    if (isBlockRule(contentOf(existing)!.options)) {
      throw planeError(
        409,
        'firewall_rule_perch_block',
        'The WAN block rules follow the device page.'
      )
    }
  }
  const options = ruleOptions(existing ? contentOf(existing)!.options : {}, input)
  if (!existing && !options.name) throw planeError(422, 'firewall_name_required', 'Name the rule.')
  if (!existing && !options.target) {
    throw planeError(422, 'firewall_target_required', 'Pick ACCEPT, REJECT or DROP.')
  }
  checkRule(gateway, states, options, input.clientIp)
  const obj: FirewallObject = existing
    ? { ...objectOf(existing), options }
    : { perchId: null, section: '', type: 'rule', options, secretNames: [] }
  const outcome = await editSections(
    gateway.id,
    userId,
    FIREWALL_DOMAIN_KEY,
    firewallDomain.render(obj, existing ? asSynced(existing) : [])
  )
  const id = existing?.perchId ?? outcome.perchIds[0]
  if (!existing && input.placement === 'top') {
    await placeInOrder(gateway, userId, RULE_KEY, [id], () => 0)
  }
  const { apply, applyError } = await applyNow(gateway, userId, [id], input.apply !== false)
  return {
    gatewayId: gateway.id,
    object: await ruleById(gateway.id, id, gateway),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

export async function deleteRule(
  gatewayId: number,
  userId: number,
  perchId: string,
  options: { apply?: boolean } = {}
): Promise<FirewallWriteResult<null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const s = findSection(states, perchId, 'rule')
  if (!s) throw planeError(404, 'firewall_rule_not_found', `No rule ${perchId}.`)
  requireSynced(s)
  if (isBlockRule(contentOf(s)!.options)) {
    throw planeError(
      409,
      'firewall_rule_perch_block',
      'The WAN block rules follow the device page.'
    )
  }
  const outcome = await editSections(gateway.id, userId, FIREWALL_DOMAIN_KEY, [
    { op: 'delete', perchId },
  ])
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    outcome.deleted.includes(perchId) ? [] : [perchId],
    options.apply !== false
  )
  return { gatewayId: gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

// ── order ────────────────────────────────────────────────────────────────

function keyOf(type: 'rule' | 'redirect'): OrderKey {
  return type === 'rule' ? RULE_KEY : REDIRECT_KEY
}

/**
 * `PUT /gateways/:id/firewall/rules/order` (and `…/port-forwards/order`):
 * the synced rules in the wanted order (router-owned ones keep their slots).
 */
export async function reorder(
  gatewayId: number,
  userId: number,
  type: 'rule' | 'redirect',
  ids: string[],
  options: { apply?: boolean } = {}
) {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  let order: OrderState
  try {
    order = await setSectionOrder(gateway.id, userId, keyOf(type), ids)
  } catch (error) {
    if (error instanceof GatewayPlaneError && error.code === 'order_incomplete') {
      throw planeError(422, 'firewall_order_incomplete', error.message, error.data)
    }
    throw error
  }
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    order.status === 'in_sync' ? [] : order.desired,
    options.apply !== false
  )
  const overview = await firewallOverview(gateway.id)
  return {
    gatewayId: gateway.id,
    order: overview.orders[type],
    rules: type === 'rule' ? overview.rules : undefined,
    portForwards: type === 'redirect' ? overview.portForwards : undefined,
    apply,
    applyError,
  }
}

/** `POST /gateways/:id/firewall/order/resolve {type, take}`. */
export async function resolveFirewallOrder(
  gatewayId: number,
  userId: number,
  type: 'rule' | 'redirect',
  take: 'router' | 'controller',
  options: { apply?: boolean } = {}
) {
  const gateway = await findGateway(gatewayId)
  const order = await resolveSectionOrder(gateway.id, userId, keyOf(type), take)
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    take === 'controller' && order.status !== 'in_sync' ? order.desired : [],
    options.apply !== false
  )
  const { states } = await loadSections(gateway.id)
  return { gatewayId: gateway.id, order: orderView(order, states), apply, applyError }
}

// ── the per-device WAN block (plan 2 section 4.3) ───────────────────────

export type WanAccessView = {
  mac: string
  blocked: boolean
  /** The MAC is in the set Perch wants; `applied`: the router has it too. */
  applied: boolean
  since: string | null
  by: number | null
  note: string | null
  /** false: a block rule is disabled on the router ("blocked (rule disabled on router)"). */
  ruleEnabled: boolean | null
  /** The set is the router's (unmodeled/excluded): Perch cannot change it. */
  routerOwned: boolean
  lastFlush: WanBlockFlush | null
}

function blockSet(states: SectionState[]): SectionState | null {
  return (
    fwStates(states).find((s) => {
      const c = contentOf(s)!
      return c.type === 'ipset' && scalar(c.options, 'name') === BLOCK_SET_NAME
    }) ?? null
  )
}

function blockRules(states: SectionState[]): SectionState[] {
  return fwStates(states).filter((s) => {
    const c = contentOf(s)!
    return c.type === 'rule' && isBlockRule(c.options)
  })
}

function wanAccessOf(
  states: SectionState[],
  mac: string,
  meta: GatewayWanBlock | null
): WanAccessView {
  const set = blockSet(states)
  const desired = set?.desired ? wordsOf(set.desired.options.entry).map((m) => m.toLowerCase()) : []
  const router = set?.router ? wordsOf(set.router.options.entry).map((m) => m.toLowerCase()) : []
  const blocked = desired.includes(mac)
  const rules = blockRules(states)
  return {
    mac,
    blocked,
    applied: blocked ? router.includes(mac) : !router.includes(mac),
    since: meta?.blockedAt?.toISO() ?? null,
    by: meta?.blockedByUserId ?? null,
    note: meta?.note ?? null,
    ruleEnabled:
      rules.length === 0
        ? null
        : rules.every((r) => truthy(scalar(contentOf(r)!.options, 'enabled'), true)),
    routerOwned: set !== null && set.scope !== 'synced',
    lastFlush: meta?.lastFlush ?? null,
  }
}

/**
 * The block state of a device on a gateway, for `GET
 * /devices/:mac/wan-access` and the device page's network card
 * (`/devices/:mac/network` → `wanBlocked`).
 */
export async function deviceWanBlock(gateway: Gateway, mac: string): Promise<WanAccessView> {
  const { states } = await loadSections(gateway.id)
  const meta = await GatewayWanBlock.query()
    .where('gateway_id', gateway.id)
    .where('mac', mac)
    .first()
  return wanAccessOf(states, mac, meta)
}

export async function getDeviceWanAccess(macRaw: string, gatewayId?: number) {
  const mac = normalizeMac(macRaw)
  if (!mac) throw planeError(400, 'invalid_mac', `"${macRaw}" is not a MAC address.`)
  const gateway = await resolveManagedGateway(gatewayId)
  return { gatewayId: gateway.id, ...(await deviceWanBlock(gateway, mac)) }
}

/** Addresses of a device the gateway knows: leases, host entries, traffic. */
export async function deviceAddresses(gateway: Gateway, mac: string, states?: SectionState[]) {
  const out = new Set<string>()
  const lease = await GatewayHost.query()
    .where('collector_id', gateway.collectorId ?? 0)
    .where('mac', mac)
    .first()
  for (const field of [lease?.ipv4, lease?.ipv6]) {
    for (const ip of (field ?? '').split(',')) if (ip.trim()) out.add(ip.trim())
  }
  const rows = await db
    .from('device_identities')
    .where('collector_id', gateway.collectorId ?? 0)
    .where('mac', mac)
    .select('ips', 'primary_ip')
  for (const row of rows) {
    if (row.primary_ip) out.add(String(row.primary_ip))
    try {
      const ips = JSON.parse(row.ips ?? '[]')
      if (Array.isArray(ips)) for (const ip of ips) if (typeof ip === 'string') out.add(ip)
    } catch {
      // not JSON
    }
  }
  let sections = states
  if (!sections) {
    const loaded = await loadSections(gateway.id)
    sections = loaded.states
  }
  for (const s of sections) {
    const c = contentOf(s)
    if (s.config !== 'dhcp' || c?.type !== 'host') continue
    if (!macsOf(c.options.mac).includes(mac)) continue
    const ip = scalar(c.options, 'ip')
    if (ip && isIpv4(ip)) out.add(ip)
  }
  return [...out].filter((ip) => ip.length <= 45)
}

/**
 * `wan_block_self` (plan 2 section 5): never block the controller's host,
 * an access point Perch runs, or the admin's own client.
 */
async function checkBlockSelf(
  gateway: Gateway,
  ips: string[],
  clientIp: string | null | undefined
) {
  const refuse = (what: string) =>
    planeError(422, 'wan_block_self', `This device is ${what}; blocking it would cut Perch off.`)
  const controller = gateway.managementPath?.controllerAddress
  if (controller && ips.includes(controller)) throw refuse('the controller')
  const client = clientIp?.replace(/^::ffff:/, '')
  if (client && ips.includes(client)) throw refuse('your own client')
  if (ips.length > 0) {
    const aps = await WifiAccessPoint.query().select('agent_last_address', 'ssh_host')
    for (const ap of aps) {
      if ([ap.agentLastAddress, ap.sshHost].some((a) => a && ips.includes(a))) {
        throw refuse('an access point')
      }
    }
  }
}

export type WanAccessInput = {
  gatewayId?: number
  blocked: boolean
  note?: string | null
  clientIp?: string | null
  apply?: boolean
}

/**
 * `PUT /devices/:mac/wan-access {blocked}` (plan 2 sections 4.3 and 5):
 * the MAC goes into (or out of) the `perch_block_wan` set; the set and one
 * REJECT rule per WAN zone (`perch_block_wan_<zone>`, placed first among the
 * rules toward WAN zones) are created on the first block. After the apply
 * is live, the device's conntrack entries are flushed so the block bites at
 * once (`flushed` in `GET …/wan-access` → `lastFlush`). A household
 * control, not a security boundary (a random or spoofed MAC evades it).
 */
export async function setDeviceWanAccess(
  macRaw: string,
  userId: number,
  input: WanAccessInput
): Promise<FirewallWriteResult<WanAccessView> & { flushed: boolean | null; perchIds: string[] }> {
  const mac = normalizeMac(macRaw)
  if (!mac) throw planeError(400, 'invalid_mac', `"${macRaw}" is not a MAC address.`)
  const gateway = await resolveManagedGateway(input.gatewayId)
  const { states } = await loadSections(gateway.id)
  const ips = await deviceAddresses(gateway, mac, states)
  if (input.blocked) await checkBlockSelf(gateway, ips, input.clientIp)

  const set = blockSet(states)
  if (set && set.scope !== 'synced') {
    throw planeError(
      409,
      'wan_block_router_owned',
      'The router’s perch_block_wan set is excluded or unmodeled; include it first.',
      { perchId: set.perchId }
    )
  }
  const zones = allZones(states)
  const wans = wanZones(zones)
  const edits: SectionEdit[] = []
  const touched: string[] = []
  const entries = set ? wordsOf(contentOf(set)!.options.entry).map((m) => m.toLowerCase()) : []
  const has = entries.includes(mac)

  if (input.blocked && !has) {
    if (wans.length === 0) {
      throw planeError(409, 'firewall_no_wan_zone', 'The firewall has no WAN zone to block.')
    }
    const next = [...entries, mac]
    const options: UciOptions = set
      ? { ...cloneOptions(contentOf(set)!.options), entry: next }
      : { name: BLOCK_SET_NAME, match: 'src_mac', entry: next }
    edits.push(
      ...firewallDomain.render(
        set
          ? { ...objectOf(set), options }
          : { perchId: null, section: BLOCK_SET_NAME, type: 'ipset', options, secretNames: [] },
        set ? asSynced(set) : []
      )
    )
    if (set) touched.push(set.perchId)
  } else if (!input.blocked && has && set) {
    const options = cloneOptions(contentOf(set)!.options)
    const rest = entries.filter((m) => m !== mac)
    if (rest.length === 0) delete options.entry
    else options.entry = rest
    edits.push(...firewallDomain.render({ ...objectOf(set), options }, asSynced(set)))
    touched.push(set.perchId)
  }

  const newRules: string[] = []
  if (input.blocked) {
    const rules = blockRules(states)
    for (const zone of wans) {
      const rule = rules.find((r) => scalar(contentOf(r)!.options, 'dest') === zone)
      if (rule) {
        if (rule.scope === 'synced') touched.push(rule.perchId)
        continue
      }
      const section = `${BLOCK_RULE_PREFIX}${zone}`.slice(0, 64)
      if (states.some((s) => s.config === 'firewall' && s.name === section)) continue
      edits.push(
        ...firewallDomain.render(
          {
            perchId: null,
            section,
            type: 'rule',
            options: {
              name: `Perch: block internet (${zone})`,
              src: '*',
              dest: zone,
              ipset: BLOCK_SET_NAME,
              proto: 'all',
              target: 'REJECT',
            },
            secretNames: [],
          },
          []
        )
      )
      newRules.push(section)
    }
  }

  let issues: Issue[] = []
  let created: string[] = []
  if (edits.length > 0) {
    const outcome = await editSections(gateway.id, userId, FIREWALL_DOMAIN_KEY, edits)
    issues = outcome.issues
    created = outcome.perchIds.filter((id) => !touched.includes(id))
    touched.push(...created)
  }
  // New block rules go first among the rules toward WAN zones.
  const { states: after } = await loadSections(gateway.id)
  const createdRules = after
    .filter((s) => created.includes(s.perchId) && newRules.includes(s.name))
    .map((s) => s.perchId)
  await placeInOrder(gateway, userId, RULE_KEY, createdRules, (desired, now) =>
    firstTowardWan(desired, now, wans)
  )

  if (input.blocked) {
    const meta =
      (await GatewayWanBlock.query().where('gateway_id', gateway.id).where('mac', mac).first()) ??
      new GatewayWanBlock()
    if (!meta.id) {
      meta.gatewayId = gateway.id
      meta.mac = mac
      meta.blockedAt = DateTime.utc()
      meta.blockedByUserId = userId
      meta.createdAt = DateTime.utc()
    }
    if (input.note !== undefined) meta.note = input.note ? input.note.slice(0, 200) : null
    meta.updatedAt = DateTime.utc()
    await meta.save()
  } else {
    await GatewayWanBlock.query().where('gateway_id', gateway.id).where('mac', mac).delete()
  }
  if (edits.length > 0) {
    await recordGatewayEvent(gateway.id, input.blocked ? 'wan_blocked' : 'wan_unblocked', {
      userId,
      detail: { mac, perchIds: touched },
    })
  }

  const perchIds = [...new Set(touched)]
  const postActions: GatewayApplyPostActions | undefined =
    input.blocked && perchIds.length > 0
      ? {
          conntrackFlush: {
            mac,
            ips: ips.filter((ip) => ip !== gateway.managementPath?.controllerAddress),
            perchIds,
          },
        }
      : undefined
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    perchIds,
    input.apply !== false,
    postActions
  )
  const meta = await GatewayWanBlock.query()
    .where('gateway_id', gateway.id)
    .where('mac', mac)
    .first()
  let flushed: boolean | null = null
  if (apply instanceof GatewayApply) {
    await apply.refresh()
    const result = apply.postActions?.conntrackFlush?.result as
      | { flushed?: boolean | null }
      | undefined
    flushed = result?.flushed ?? null
  }
  const { states: final } = await loadSections(gateway.id)
  return {
    gatewayId: gateway.id,
    object: wanAccessOf(final, mac, meta),
    flushed,
    perchIds,
    issues,
    apply,
    applyError,
  }
}

/** Index in `desired` of the first rule toward a WAN zone (or any zone), else the end. */
function firstTowardWan(desired: string[], states: SectionState[], wans: string[]): number {
  const index = desired.findIndex((id) => {
    const s = states.find((x) => x.perchId === id)
    const c = s ? contentOf(s) : null
    if (!c) return false
    const dest = scalar(c.options, 'dest')
    return dest !== null && (dest === '*' || wans.includes(dest))
  })
  return index === -1 ? desired.length : index
}

// ── zone membership of networks (docs/gateway/networks.md 1.3) ────────────

/**
 * What a network write asks of the firewall: `zone` names the zone the
 * network should be in (null = in none), `createZone` makes a new zone of
 * that name with the purpose's defaults (`zoneObjectsForNetwork`: zone, a
 * forwarding to each WAN zone, DHCP/DNS input rules on guest/IoT).
 */
export type NetworkZoneRequest = {
  network: string
  purpose: NetworkPurpose
  zone: string | null
  createZone?: boolean
}

/**
 * The firewall edits that put `network` into the requested zone (and out of
 * any other), for the same `editDomainSections` call as the network's own
 * sections, so a new network, its pool and its zone go in one apply. Pure
 * over the gateway's section states. A zone Perch does not sync (the
 * router's) cannot be edited: 409 `not_synced`. No edits when the network
 * is already where it should be.
 */
export function networkZoneEdits(
  states: SectionState[],
  request: NetworkZoneRequest
): SectionEdit[] {
  const zoneStates = fwStates(states).filter((s) => contentOf(s)!.type === 'zone')
  const zones = allZones(states)
  const target = request.zone
  const edits: SectionEdit[] = []
  const put = (s: SectionState, obj: FirewallObject): SectionEdit => ({
    op: 'put',
    perchId: s.perchId,
    config: 'firewall',
    type: 'zone',
    options: obj.options,
  })

  if (target !== null && request.createZone) {
    if (zones.some((z) => z.name === target)) {
      throw planeError(409, 'firewall_zone_exists', `A firewall zone "${target}" exists already.`, {
        field: 'firewallZone',
      })
    }
    try {
      for (const obj of zoneObjectsForNetwork({
        network: request.network,
        purpose: request.purpose,
        zoneName: target,
        wanZones: wanZones(zones),
        existingZones: zones.map((z) => z.name),
      })) {
        edits.push({
          op: 'put',
          perchId: null,
          config: 'firewall',
          type: obj.type,
          options: obj.options,
        })
      }
    } catch (error) {
      throw planeError(422, 'firewall_zone_invalid', (error as Error).message, {
        field: 'firewallZone',
      })
    }
  } else if (target !== null) {
    checkZone(zones, target, 'firewallZone')
  }

  for (const s of zoneStates) {
    const obj = objectOf(s)
    const info = zoneInfo(obj.options)
    const listed = info.networks.includes(request.network)
    if (info.name === target && !request.createZone) {
      if (listed) continue
      requireZoneSynced(s, info.name)
      edits.push(put(s, addNetworkToZone(obj, request.network)))
    } else if (listed) {
      requireZoneSynced(s, info.name)
      edits.push(put(s, removeNetworkFromZone(obj, request.network)))
    }
  }
  return edits
}

function requireZoneSynced(s: SectionState, zone: string) {
  if (s.scope !== 'synced') {
    throw planeError(
      409,
      'not_synced',
      `Firewall zone "${zone}" is the router’s: include it in Perch first.`,
      { perchId: s.perchId, issue: s.issue, field: 'firewallZone' }
    )
  }
}

/** The zone a network is in now (desired side), or null. */
export function currentZoneOf(states: SectionState[], network: string): string | null {
  return zoneOfNetwork(allZones(states), network)
}

// ── device groups: internet access (docs/gateway/device-groups.md section 5) ──

/** Section names of a group's internet block: `perch_g<id>` (ipset), `perch_g<id>_<zone>` (rules). */
export const GROUP_SECTION_PREFIX = 'perch_g'
const GROUP_SECTION = /^perch_g(\d+)(?:_.+)?$/

export type GroupFirewallSpec = {
  groupId: number
  name: string
  /** No internet for the group's members. */
  blocked: boolean
  /** The bound members (groups without a network). */
  macs: string[]
  /** The group's network: its traffic is matched by zone or prefixes, not by MAC. */
  network: { name: string; zone: string | null; ipv4: string[] } | null
}

type GroupSection = { section: string; type: 'ipset' | 'rule'; options: UciOptions }

/** The sections one group's block needs (none while it may use the internet). */
export function groupFirewallSections(spec: GroupFirewallSpec, zones: ZoneInfo[]): GroupSection[] {
  if (!spec.blocked) return []
  const wans = wanZones(zones)
  const out: GroupSection[] = []
  const setName = `${GROUP_SECTION_PREFIX}${spec.groupId}`
  let match: UciOptions
  if (spec.network) {
    const zone = spec.network.zone ? zones.find((z) => z.name === spec.network!.zone) : undefined
    if (zone && zone.networks.length === 1 && zone.networks[0] === spec.network.name) {
      // The zone is the group's network alone: it names IPv4 and IPv6 alike.
      match = { src: zone.name }
    } else if (spec.network.ipv4.length > 0) {
      match = { src: '*', src_ip: spec.network.ipv4.map((cidr) => networkPrefix(cidr)) }
    } else {
      return []
    }
  } else {
    if (spec.macs.length === 0) return []
    out.push({
      section: setName,
      type: 'ipset',
      options: { name: setName, match: 'src_mac', entry: [...spec.macs].sort() },
    })
    match = { src: '*', ipset: setName }
  }
  for (const zone of wans) {
    out.push({
      section: `${setName}_${zone}`.slice(0, 64),
      type: 'rule',
      options: {
        name: `Perch: ${spec.name.slice(0, 40)}, no internet (${zone})`,
        ...match,
        dest: zone,
        proto: 'all',
        target: 'REJECT',
      },
    })
  }
  return out
}

/** `192.168.20.1/24` (a router address) → `192.168.20.0/24`. */
function networkPrefix(cidr: string): string {
  const [ip, lenText] = cidr.split('/')
  const len = Number(lenText)
  if (!isIpv4(ip) || !Number.isInteger(len) || len < 0 || len > 32) return cidr
  const n = ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0
  const net = (n & mask) >>> 0
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 0xff).join('.')}/${len}`
}

function sameOptions(a: UciOptions, b: UciOptions): boolean {
  const norm = (o: UciOptions) =>
    JSON.stringify(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]])
    )
  return norm(a) === norm(b)
}

/**
 * Brings every group's internet block of a gateway to what the specs want:
 * missing sections are created (the rules first among the rules toward WAN
 * zones), changed ones edited, those of blocked-no-more or deleted groups
 * removed, all in one apply. The flush afterwards cuts the members' running
 * connections (fw4 accepts established traffic before any rule).
 */
export async function reconcileGroupFirewall(
  gatewayId: number,
  userId: number | null,
  specs: GroupFirewallSpec[],
  options: { apply?: boolean } = {}
): Promise<{
  issues: Issue[]
  apply: unknown | null
  applyError: FirewallWriteResult<unknown>['applyError']
}> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const zones = allZones(states)
  const wanted = new Map<string, GroupSection>()
  for (const spec of specs) {
    for (const s of groupFirewallSections(spec, zones)) wanted.set(s.section, s)
  }
  const current = fwStates(states).filter((s) => GROUP_SECTION.test(s.name))
  const edits: SectionEdit[] = []
  const touched: string[] = []
  const newRules: string[] = []
  for (const s of current) {
    const want = wanted.get(s.name)
    const content = contentOf(s)!
    if (!want) {
      if (s.scope === 'synced') {
        edits.push({ op: 'delete', perchId: s.perchId })
        touched.push(s.perchId)
      }
      continue
    }
    wanted.delete(s.name)
    if (content.type === want.type && sameOptions(content.options, want.options)) continue
    if (s.scope !== 'synced') continue
    edits.push(...firewallDomain.render({ ...objectOf(s), options: want.options }, asSynced(s)))
    touched.push(s.perchId)
  }
  // Sets before the rules that use them.
  const fresh = [...wanted.values()].sort((a, b) =>
    a.type === b.type ? 0 : a.type === 'ipset' ? -1 : 1
  )
  for (const s of fresh) {
    edits.push(
      ...firewallDomain.render(
        { perchId: null, section: s.section, type: s.type, options: s.options, secretNames: [] },
        []
      )
    )
    if (s.type === 'rule') newRules.push(s.section)
  }
  const actor: PlaneActor = userId ?? { system: 'system' }
  // Sections already drafted but not on the router yet (an earlier apply was
  // refused while another ran) are applied along.
  const waiting = current
    .filter((s) => s.scope === 'synced' && s.status === 'ahead' && !touched.includes(s.perchId))
    .map((s) => s.perchId)
  if (edits.length === 0) {
    if (waiting.length === 0) return { issues: [], apply: null, applyError: null }
    const { apply, applyError } = await applyNow(gateway, userId, waiting, options.apply !== false)
    return { issues: [], apply, applyError }
  }
  const outcome = await editSections(gateway.id, actor, FIREWALL_DOMAIN_KEY, edits)
  const created = outcome.perchIds.filter((id) => !touched.includes(id))
  const { states: after } = await loadSections(gateway.id)
  const createdRules = after
    .filter((s) => created.includes(s.perchId) && newRules.includes(s.name))
    .map((s) => s.perchId)
  const wans = wanZones(zones)
  await placeInOrder(gateway, userId, RULE_KEY, createdRules, (desired, now) =>
    firstTowardWan(desired, now, wans)
  )
  const perchIds = [
    ...new Set([...touched.filter((id) => !outcome.deleted.includes(id)), ...created, ...waiting]),
  ]
  // The members of newly blocked groups lose their running connections.
  const ips = new Set<string>()
  for (const spec of specs) {
    if (!spec.blocked || spec.network) continue
    for (const mac of spec.macs)
      for (const ip of await deviceAddresses(gateway, mac, after)) ips.add(ip)
  }
  const controller = gateway.managementPath?.controllerAddress
  const flushIps = [...ips].filter((ip) => ip !== controller)
  const postActions: GatewayApplyPostActions | undefined =
    flushIps.length > 0 && created.length > 0
      ? { conntrackFlush: { mac: 'device-groups', ips: flushIps, perchIds: created } }
      : undefined
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    perchIds,
    options.apply !== false,
    postActions
  )
  if (created.length > 0 || touched.length > 0) {
    await recordGatewayEvent(gateway.id, 'group_firewall', { actor, detail: { perchIds } })
  }
  return { issues: outcome.issues, apply, applyError }
}
