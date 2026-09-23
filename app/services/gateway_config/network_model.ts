import type { SectionEdit } from '#services/gateway_config/domain'
import { poolEnabled } from '#services/gateway_config/domains/dhcp_pools'
import {
  bitsToMask,
  cidrsOverlap,
  interfaceCidrs,
  interfaceSide,
  ipv4ToInt,
  listItems,
  masqNetworks,
  parseCidr,
  parsePortSpec,
  portSpecText,
  scalarOf,
  type PortSpec,
} from '#services/gateway_config/domains/networks'
import { planeError } from '#services/gateway_config/errors'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type {
  Issue,
  ManagementPath,
  SectionScope,
  SectionStatus,
  UciOptions,
} from '#services/gateway_config/types'

/**
 * How `network` sections form networks, and how a network edit becomes
 * section edits (plan 1 section 8.1, docs/gateway/networks.md). Pure: the
 * REST service (`networks_service.ts`) loads the rows, calls these and
 * writes the edits through `editDomainSections` (networks + dhcp_pools in
 * one draft, one apply request).
 *
 * | `l2Mode` | UCI |
 * |---|---|
 * | `bridge` | `config device` (type bridge, `name br-<key>`, `list ports`) + `interface` on it |
 * | `bridge_vlan` | `config bridge-vlan` (device, vlan, `list ports 'lan1:t' 'lan3:u*'`) on a VLAN-filtering bridge + `interface` on `<bridge>.<vid>` |
 * | `8021q` | `config device` (type 8021q, `ifname`, `vid`, `name`) + `interface` |
 * | `device` | `interface` with a plain `device` |
 */

export const L2_MODES = ['bridge', 'bridge_vlan', '8021q', 'device'] as const
export type L2Mode = (typeof L2_MODES)[number]

export const NETWORK_KEY = /^[a-z][a-z0-9_]{0,14}$/
/** Linux netdev names (IFNAMSIZ - 1). */
const MAX_DEVICE_NAME = 15

export type NetworkPort = PortSpec

export type DhcpPoolView = {
  perchId: string
  section: string
  enabled: boolean
  start: number | null
  limit: number | null
  leaseTime: string | null
  owner: 'perch' | 'router'
  status: SectionStatus
}

/** A network as the config plane sees it (desired state for synced sections). */
export interface ComposedNetwork {
  /** Interface section name = network name (netifd, capture, firewall zones). */
  key: string
  /** The interface section's perch id. */
  perchId: string
  owner: 'perch' | 'router'
  scope: SectionScope
  proto: string
  /** The interface's L3 device (`br-lan`, `br-trunk.110`, `eth1`). */
  device: string | null
  l2Mode: L2Mode
  bridge: string | null
  vlanId: number | null
  /** 8021q: the parent device; device mode: the device itself. */
  parentDevice: string | null
  ports: NetworkPort[]
  /** First IPv4 CIDR (router address/prefix), and all of them. */
  ipv4: string | null
  ipv4All: string[]
  /** Perch ids of the interface and the L2 sections that belong to this network alone. */
  sections: string[]
  /** Worst status among `sections` (conflict > drift > reverting > pending > ahead > in_sync). */
  status: SectionStatus
  /** The draft removes it (synced, C = null, still on the router). */
  deleting: boolean
  dhcp: DhcpPoolView | null
  /** The firewall zone that lists the network (read-only until a firewall domain exists). */
  firewallZone: string | null
  /** The network the agent reaches the controller through (README 3.8). */
  management: boolean
}

type ModelSection = {
  perchId: string
  config: string
  name: string
  type: string
  scope: SectionScope
  domain: string | null
  status: SectionStatus
  options: UciOptions
  deleting: boolean
}

/** The content a view shows: C for synced sections, else the router's. */
function modelSections(states: SectionState[]): ModelSection[] {
  const out: ModelSection[] = []
  for (const s of states) {
    const synced = s.scope === 'synced'
    const content = synced ? (s.desired ?? s.router) : s.router
    if (!content) continue
    out.push({
      perchId: s.perchId,
      config: s.config,
      name: s.name,
      type: content.type,
      scope: s.scope,
      domain: s.domain,
      status: s.status,
      options: content.options,
      deleting: synced && s.desired === null,
    })
  }
  return out
}

const STATUS_RANK: Record<SectionStatus, number> = {
  in_sync: 0,
  ahead: 1,
  pending: 2,
  reverting: 3,
  drift: 4,
  conflict: 5,
}

function worst(statuses: SectionStatus[]): SectionStatus {
  return statuses.reduce<SectionStatus>(
    (acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc),
    'in_sync'
  )
}

function num(value: string | null): number | null {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return null
  return Number(value)
}

function isBridge(s: ModelSection): boolean {
  return s.config === 'network' && s.type === 'device' && scalarOf(s.options, 'type') === 'bridge'
}

function isVlanDevice(s: ModelSection): boolean {
  const type = scalarOf(s.options, 'type')
  return s.config === 'network' && s.type === 'device' && (type === '8021q' || type === '8021ad')
}

type Index = {
  all: ModelSection[]
  interfaces: ModelSection[]
  lan: ModelSection[]
  devicesByName: Map<string, ModelSection>
  bridgeVlans: ModelSection[]
  pools: ModelSection[]
  zones: ModelSection[]
}

function index(states: SectionState[]): Index {
  const all = modelSections(states)
  const network = all.filter((s) => s.config === 'network')
  const zones = all.filter((s) => s.config === 'firewall' && s.type === 'zone')
  const wan = masqNetworks(zones)
  const interfaces = network.filter((s) => s.type === 'interface')
  const devicesByName = new Map<string, ModelSection>()
  for (const s of network) {
    if (s.type !== 'device') continue
    const name = scalarOf(s.options, 'name')
    if (name && !devicesByName.has(name)) devicesByName.set(name, s)
  }
  return {
    all,
    interfaces,
    lan: interfaces.filter((s) => interfaceSide(s.name, s.options, wan) === 'lan'),
    devicesByName,
    bridgeVlans: network.filter((s) => s.type === 'bridge-vlan'),
    pools: all.filter((s) => s.config === 'dhcp' && s.type === 'dhcp'),
    zones,
  }
}

function vlansOn(ix: Index, bridge: string): ModelSection[] {
  return ix.bridgeVlans.filter((v) => scalarOf(v.options, 'device') === bridge)
}

function interfaceDevice(s: ModelSection): string | null {
  return scalarOf(s.options, 'device') ?? scalarOf(s.options, 'ifname')
}

/** Interfaces (any side) whose device is `device`. */
function usersOf(ix: Index, device: string): ModelSection[] {
  return ix.interfaces.filter((s) => interfaceDevice(s) === device)
}

function compose(
  ix: Index,
  iface: ModelSection,
  management: ManagementPath | null
): ComposedNetwork {
  const device = interfaceDevice(iface)
  let l2Mode: L2Mode = 'device'
  let bridge: string | null = null
  let vlanId: number | null = null
  let parentDevice: string | null = device
  let ports: NetworkPort[] = []
  const l2: ModelSection[] = []

  const dot = device ? device.lastIndexOf('.') : -1
  const exact = device ? ix.devicesByName.get(device) : undefined
  if (exact && isVlanDevice(exact)) {
    l2Mode = '8021q'
    vlanId = num(scalarOf(exact.options, 'vid'))
    parentDevice = scalarOf(exact.options, 'ifname')
    l2.push(exact)
  } else if (exact && isBridge(exact)) {
    l2Mode = 'bridge'
    bridge = device
    parentDevice = null
    ports = listItems(exact.options.ports).map((port) => ({ port, tagged: false, pvid: true }))
    // The bridge belongs to this network when nothing else rides on it.
    if (usersOf(ix, device!).length === 1 && vlansOn(ix, device!).length === 0) l2.push(exact)
  } else if (device && dot > 0) {
    const parent = device.slice(0, dot)
    const vid = num(device.slice(dot + 1))
    const parentSection = ix.devicesByName.get(parent)
    const bv = vlansOn(ix, parent).find((v) => num(scalarOf(v.options, 'vlan')) === vid)
    if (bv || (parentSection && isBridge(parentSection) && vlansOn(ix, parent).length > 0)) {
      l2Mode = 'bridge_vlan'
      bridge = parent
      vlanId = vid
      parentDevice = null
      if (bv) {
        ports = listItems(bv.options.ports)
          .map(parsePortSpec)
          .filter((p): p is PortSpec => p !== null)
        if (usersOf(ix, device).length === 1) l2.push(bv)
      }
    } else {
      // A kernel VLAN device netifd creates from the name (`eth1.30`).
      l2Mode = '8021q'
      vlanId = vid
      parentDevice = parent
    }
  }

  const pool = ix.pools.find((p) => scalarOf(p.options, 'interface') === iface.name)
  const zone = ix.zones.find((z) => listItems(z.options.network).includes(iface.name))
  const cidrs = interfaceCidrs(iface.options)
  const sections = [iface, ...l2]
  return {
    key: iface.name,
    perchId: iface.perchId,
    owner: iface.scope === 'synced' ? 'perch' : 'router',
    scope: iface.scope,
    proto: scalarOf(iface.options, 'proto') ?? 'none',
    device,
    l2Mode,
    bridge,
    vlanId,
    parentDevice,
    ports,
    ipv4: cidrs[0] ?? null,
    ipv4All: cidrs,
    sections: sections.map((s) => s.perchId),
    status: worst(sections.map((s) => s.status)),
    deleting: iface.deleting,
    dhcp: pool
      ? {
          perchId: pool.perchId,
          section: pool.name,
          enabled: poolEnabled(pool.options),
          start: num(scalarOf(pool.options, 'start')),
          limit: num(scalarOf(pool.options, 'limit')),
          leaseTime: scalarOf(pool.options, 'leasetime'),
          owner: pool.scope === 'synced' ? 'perch' : 'router',
          status: pool.status,
        }
      : null,
    firewallZone: zone ? (scalarOf(zone.options, 'name') ?? zone.name) : null,
    management:
      management !== null &&
      ((management.network !== null && management.network === iface.name) ||
        (device !== null && management.device === device)),
  }
}

/** Every LAN-side network of the gateway's rows, in the router's order. */
export function composeNetworks(
  states: SectionState[],
  management: ManagementPath | null = null
): ComposedNetwork[] {
  const ix = index(states)
  return ix.lan.map((iface) => compose(ix, iface, management))
}

// ── planning edits ───────────────────────────────────────────────────────

export type DhcpInput = { enabled?: boolean; start: number; limit: number; leaseTime: string }

export interface NetworkCreate {
  key: string
  l2Mode: L2Mode
  bridge?: string | null
  vlanId?: number | null
  parentDevice?: string | null
  ports?: NetworkPort[]
  /** Router address with prefix (`192.168.30.1/24`); null = proto none (no address). */
  ipv4?: string | null
  dhcp?: DhcpInput | null
  /**
   * The VLAN the bridge's existing members get when this is the first
   * bridge VLAN on an untagged bridge (plan 1 section 8.1 conversion).
   */
  untaggedVlan?: number
}

export interface NetworkPatch {
  ipv4?: string | null
  ports?: NetworkPort[]
  vlanId?: number
  dhcp?: DhcpInput | null
}

export interface NetworkPlan {
  /** Edits of the `networks` domain. */
  network: SectionEdit[]
  /** Edits of the `dhcp_pools` domain. */
  pools: SectionEdit[]
  /** Things the plan leaves on the router, or cannot check. */
  warnings: Issue[]
  /** The first bridge VLAN on an untagged bridge: its members move to `untaggedVlan`. */
  converted: { bridge: string; untaggedVlan: number; moved: string[] } | null
}

function refuse(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
  return planeError(status, code, message, data)
}

function checkVid(vid: number | null | undefined): number {
  if (vid === null || vid === undefined || !Number.isInteger(vid) || vid < 1 || vid > 4094) {
    throw refuse(422, 'vlan_invalid', 'A VLAN id is a whole number from 1 to 4094.')
  }
  return vid
}

function checkDeviceName(name: string) {
  if (name.length > MAX_DEVICE_NAME) {
    throw refuse(
      422,
      'device_name_too_long',
      `"${name}" is longer than ${MAX_DEVICE_NAME} characters.`
    )
  }
}

/** A router address: a host of its subnet, not the network or broadcast address. */
export function parseRouterAddress(value: string): { address: string; prefix: number } {
  const parsed = parseCidr(value)
  if (!parsed || !value.includes('/') || parsed.prefix < 8 || parsed.prefix > 30) {
    throw refuse(422, 'ipv4_invalid', `"${value}" is not an address with a prefix (/8–/30).`)
  }
  const size = 2 ** (32 - parsed.prefix)
  const offset = ipv4ToInt(parsed.address) % size
  if (offset === 0 || offset === size - 1) {
    throw refuse(422, 'ipv4_invalid', `${parsed.address} is the network or broadcast address.`)
  }
  return parsed
}

function checkOverlap(ix: Index, cidr: string, except: string | null) {
  for (const s of ix.interfaces) {
    if (s.name === except) continue
    if (interfaceSide(s.name, s.options, new Set()) === 'loopback') continue
    const hit = interfaceCidrs(s.options).find((c) => cidrsOverlap(c, cidr))
    if (hit) {
      throw refuse(422, 'subnet_overlap', `${cidr} overlaps ${hit} of ${s.name}.`, {
        network: s.name,
        cidr: hit,
      })
    }
  }
}

/** Address options of an interface, keeping the section's spelling (list/CIDR vs ipaddr+netmask). */
function addressOptions(
  current: UciOptions | null,
  ipv4: string | null
): { set: UciOptions; remove: string[] } {
  if (ipv4 === null) return { set: { proto: 'none' }, remove: ['ipaddr', 'netmask'] }
  const parsed = parseRouterAddress(ipv4)
  const cidr = `${parsed.address}/${parsed.prefix}`
  const listForm =
    current !== null &&
    (Array.isArray(current.ipaddr) ||
      (typeof current.ipaddr === 'string' && current.ipaddr.includes('/')))
  if (listForm) {
    return { set: { proto: 'static', ipaddr: [cidr] }, remove: ['netmask'] }
  }
  return {
    set: { proto: 'static', ipaddr: parsed.address, netmask: bitsToMask(parsed.prefix) },
    remove: [],
  }
}

function withOptions(base: UciOptions, set: UciOptions, remove: string[] = []): UciOptions {
  const out: UciOptions = {}
  for (const [k, v] of Object.entries(base)) {
    if (!remove.includes(k)) out[k] = Array.isArray(v) ? [...v] : v
  }
  for (const [k, v] of Object.entries(set)) out[k] = Array.isArray(v) ? [...v] : v
  return out
}

function requireSynced(s: ModelSection, domain: string, code: string, what: string) {
  if (s.scope !== 'synced' || s.domain !== domain) {
    throw refuse(409, code, `${what} (${s.name}) is not managed by Perch.`, { perchId: s.perchId })
  }
}

function put(
  s: ModelSection | null,
  config: string,
  type: string,
  options: UciOptions,
  name?: string
): SectionEdit {
  return {
    op: 'put',
    perchId: s ? s.perchId : null,
    config,
    type,
    ...(s === null && name ? { name } : {}),
    options,
  }
}

function checkPorts(ports: NetworkPort[]) {
  const seen = new Set<string>()
  for (const p of ports) {
    if (!parsePortSpec(p.port) || p.port.includes(':')) {
      throw refuse(422, 'port_invalid', `"${p.port}" is not a port name.`)
    }
    if (seen.has(p.port)) throw refuse(422, 'port_invalid', `${p.port} is listed twice.`)
    seen.add(p.port)
  }
}

/** The bridge whose `ports` has `port` (other than `except`). */
function bridgeHolding(ix: Index, port: string, except: string | null): string | null {
  for (const [name, s] of ix.devicesByName) {
    if (name === except || !isBridge(s)) continue
    if (listItems(s.options.ports).includes(port)) return name
  }
  return null
}

function poolEdit(
  ix: Index,
  key: string,
  input: DhcpInput,
  existing: ModelSection | null
): SectionEdit {
  if (
    !Number.isInteger(input.start) ||
    input.start < 1 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1
  ) {
    throw refuse(422, 'dhcp_range_invalid', 'start and limit are positive whole numbers.')
  }
  if (!/^(\d+[smhdw]?|infinite)$/i.test(input.leaseTime)) {
    throw refuse(422, 'dhcp_leasetime_invalid', `"${input.leaseTime}" is not a lease time.`)
  }
  const set: UciOptions = {
    interface: key,
    start: String(input.start),
    limit: String(input.limit),
    leasetime: input.leaseTime,
  }
  const enabled = input.enabled !== false
  if (existing) {
    const remove = enabled ? ['ignore'] : []
    if (!enabled) set.ignore = '1'
    if (enabled && scalarOf(existing.options, 'dhcpv4') === 'disabled') set.dhcpv4 = 'server'
    return put(existing, 'dhcp', 'dhcp', withOptions(existing.options, set, remove))
  }
  if (!enabled) set.ignore = '1'
  const nameTaken = ix.all.some((s) => s.config === 'dhcp' && s.name === key)
  return put(null, 'dhcp', 'dhcp', set, nameTaken ? undefined : key)
}

function checkPoolFits(input: DhcpInput, ipv4: string | null) {
  if (!ipv4 || input.enabled === false) return
  const parsed = parseCidr(ipv4)
  if (!parsed) return
  const size = 2 ** (32 - parsed.prefix)
  if (input.start + input.limit - 1 > size - 2) {
    throw refuse(422, 'dhcp_range_outside_subnet', `The pool does not fit ${ipv4}.`)
  }
}

/**
 * A new network (`POST /gateways/:id/networks`). The interface is created
 * under its key (`config interface '<key>'`), the pool as `config dhcp
 * '<key>'`, L2 sections under `perch_<id>`.
 */
export function planCreateNetwork(states: SectionState[], input: NetworkCreate): NetworkPlan {
  const ix = index(states)
  const key = input.key
  if (!NETWORK_KEY.test(key)) {
    throw refuse(
      422,
      'network_key_invalid',
      'A network key is a-z, 0-9 and _, 1–15 characters, starting with a letter.'
    )
  }
  if (ix.all.some((s) => s.config === 'network' && s.name === key)) {
    throw refuse(409, 'network_key_taken', `The router already has a network section "${key}".`)
  }
  if (ix.pools.some((p) => scalarOf(p.options, 'interface') === key)) {
    throw refuse(409, 'dhcp_pool_exists', `The router already has a DHCP pool for "${key}".`)
  }
  const ipv4 = input.ipv4 ?? null
  if (ipv4 !== null) {
    const parsed = parseRouterAddress(ipv4)
    checkOverlap(ix, `${parsed.address}/${parsed.prefix}`, null)
  }
  if (input.dhcp) {
    if (ipv4 === null)
      throw refuse(422, 'dhcp_needs_address', 'A DHCP pool needs the network’s address.')
    checkPoolFits(input.dhcp, ipv4)
  }
  const ports = input.ports ?? []
  checkPorts(ports)
  const address = addressOptions(null, ipv4).set
  const network: SectionEdit[] = []
  const warnings: Issue[] = []
  let converted: NetworkPlan['converted'] = null
  let device: string

  switch (input.l2Mode) {
    case 'bridge': {
      device = input.bridge ?? `br-${key}`
      checkDeviceName(device)
      if (ix.devicesByName.has(device)) {
        throw refuse(409, 'bridge_exists', `The router already has a device "${device}".`)
      }
      for (const p of ports) {
        const holder = bridgeHolding(ix, p.port, null)
        if (holder)
          throw refuse(409, 'port_in_use', `${p.port} is a port of ${holder}.`, {
            port: p.port,
            bridge: holder,
          })
      }
      network.push(
        put(null, 'network', 'device', {
          name: device,
          type: 'bridge',
          ...(ports.length > 0 ? { ports: ports.map((p) => p.port) } : { bridge_empty: '1' }),
        })
      )
      break
    }
    case 'bridge_vlan': {
      const bridgeName = input.bridge ?? null
      const vid = checkVid(input.vlanId)
      const bridge = bridgeName ? ix.devicesByName.get(bridgeName) : undefined
      if (!bridgeName || !bridge || !isBridge(bridge)) {
        throw refuse(
          422,
          'bridge_not_found',
          `There is no bridge "${bridgeName ?? ''}" to add a VLAN to.`
        )
      }
      device = `${bridgeName}.${vid}`
      checkDeviceName(device)
      const existing = vlansOn(ix, bridgeName)
      if (
        existing.some((v) => num(scalarOf(v.options, 'vlan')) === vid) ||
        ix.devicesByName.has(device)
      ) {
        throw refuse(422, 'vlan_in_use', `VLAN ${vid} is already on ${bridgeName}.`, {
          vlanId: vid,
        })
      }
      const members = listItems(bridge.options.ports)
      const added = ports.map((p) => p.port).filter((p) => !members.includes(p))
      if (added.length > 0) {
        for (const port of added) {
          const holder = bridgeHolding(ix, port, bridgeName)
          if (holder)
            throw refuse(409, 'port_in_use', `${port} is a port of ${holder}.`, {
              port,
              bridge: holder,
            })
        }
        requireSynced(bridge, 'networks', 'bridge_not_managed', `The bridge ${bridgeName}`)
        network.push(
          put(
            bridge,
            'network',
            'device',
            withOptions(bridge.options, { ports: [...members, ...added] })
          )
        )
      }
      const pvidPorts = new Set(ports.filter((p) => p.pvid).map((p) => p.port))
      if (existing.length === 0) {
        // The first VLAN on an untagged bridge: its members keep their
        // untagged traffic on `untaggedVlan`, and every interface on the
        // bare bridge moves to `<bridge>.<untaggedVlan>`, in the same apply.
        const untagged = checkVid(input.untaggedVlan ?? 1)
        if (untagged === vid) {
          throw refuse(422, 'vlan_in_use', `VLAN ${vid} is the bridge’s untagged VLAN.`, {
            vlanId: vid,
          })
        }
        const onBridge = usersOf(ix, bridgeName)
        const unmanaged = onBridge.filter((s) => s.scope !== 'synced' || s.domain !== 'networks')
        if (unmanaged.length > 0) {
          throw refuse(
            409,
            'conversion_needs_sync',
            `Converting ${bridgeName} to VLAN filtering needs its interfaces managed by Perch.`,
            {
              perchIds: unmanaged.map((s) => s.perchId),
            }
          )
        }
        const target = `${bridgeName}.${untagged}`
        for (const s of onBridge) {
          const option = scalarOf(s.options, 'device') !== null ? 'device' : 'ifname'
          network.push(put(s, 'network', 'interface', withOptions(s.options, { [option]: target })))
        }
        network.push(
          put(null, 'network', 'bridge-vlan', {
            device: bridgeName,
            vlan: String(untagged),
            ports: members.filter((p) => !pvidPorts.has(p)).map((p) => `${p}:u*`),
          })
        )
        converted = {
          bridge: bridgeName,
          untaggedVlan: untagged,
          moved: onBridge.map((s) => s.name),
        }
      } else {
        for (const p of pvidPorts) {
          const clash = existing.find((v) =>
            listItems(v.options.ports).some((item) => {
              const spec = parsePortSpec(item)
              return spec !== null && spec.port === p && spec.pvid
            })
          )
          if (clash) {
            throw refuse(
              422,
              'port_pvid_conflict',
              `${p} is already the untagged port of VLAN ${scalarOf(clash.options, 'vlan')}.`,
              {
                port: p,
                vlanId: num(scalarOf(clash.options, 'vlan')),
              }
            )
          }
        }
      }
      network.push(
        put(null, 'network', 'bridge-vlan', {
          device: bridgeName,
          vlan: String(vid),
          ports: ports.map(portSpecText),
        })
      )
      break
    }
    case '8021q': {
      const parent = input.parentDevice ?? null
      const vid = checkVid(input.vlanId)
      if (!parent)
        throw refuse(422, 'parent_device_required', 'An 802.1q network needs its parent device.')
      device = `${parent}.${vid}`
      checkDeviceName(device)
      if (
        ix.devicesByName.has(device) ||
        ix.interfaces.some((s) => interfaceDevice(s) === device)
      ) {
        throw refuse(422, 'vlan_in_use', `VLAN ${vid} is already on ${parent}.`, { vlanId: vid })
      }
      network.push(
        put(null, 'network', 'device', {
          type: '8021q',
          ifname: parent,
          vid: String(vid),
          name: device,
        })
      )
      break
    }
    case 'device': {
      const parent = input.parentDevice ?? null
      if (!parent) throw refuse(422, 'parent_device_required', 'The network needs its device.')
      checkDeviceName(parent)
      const holder = bridgeHolding(ix, parent, null)
      if (holder)
        throw refuse(409, 'port_in_use', `${parent} is a port of ${holder}.`, {
          port: parent,
          bridge: holder,
        })
      device = parent
      break
    }
    default:
      throw refuse(422, 'l2mode_invalid', 'Unknown l2Mode.')
  }

  network.push(put(null, 'network', 'interface', { device, ...address }, key))
  const pools = input.dhcp ? [poolEdit(ix, key, input.dhcp, null)] : []
  return { network, pools, warnings, converted }
}

function findNetwork(ix: Index, key: string): ModelSection {
  const iface = ix.lan.find((s) => s.name === key)
  if (!iface) throw refuse(404, 'network_not_found', `No network "${key}".`)
  return iface
}

/**
 * An edit of a network (`PATCH /gateways/:id/networks/:networkId`): its
 * address, ports, VLAN id and DHCP pool. The L2 mode and the key are fixed
 * (delete and re-create instead).
 */
export function planUpdateNetwork(
  states: SectionState[],
  key: string,
  patch: NetworkPatch
): NetworkPlan {
  const ix = index(states)
  const iface = findNetwork(ix, key)
  const current = compose(ix, iface, null)
  const network: SectionEdit[] = []
  const pools: SectionEdit[] = []
  const warnings: Issue[] = []
  const touchesNetwork =
    patch.ipv4 !== undefined || patch.ports !== undefined || patch.vlanId !== undefined
  if (touchesNetwork) requireSynced(iface, 'networks', 'network_not_managed', `The network ${key}`)
  let ifaceOptions = iface.options
  let ifaceChanged = false

  if (patch.ipv4 !== undefined && patch.ipv4 !== current.ipv4) {
    if (patch.ipv4 !== null) {
      const parsed = parseRouterAddress(patch.ipv4)
      checkOverlap(ix, `${parsed.address}/${parsed.prefix}`, key)
    }
    const { set, remove } = addressOptions(iface.options, patch.ipv4)
    ifaceOptions = withOptions(ifaceOptions, set, remove)
    ifaceChanged = true
  }

  if (patch.vlanId !== undefined && patch.vlanId !== current.vlanId) {
    const vid = checkVid(patch.vlanId)
    if (current.l2Mode === 'bridge_vlan' && current.bridge) {
      const bv = vlansOn(ix, current.bridge).find(
        (v) => num(scalarOf(v.options, 'vlan')) === current.vlanId
      )
      if (!bv) throw refuse(409, 'network_not_managed', `The bridge VLAN of ${key} is missing.`)
      requireSynced(bv, 'networks', 'network_not_managed', `The bridge VLAN of ${key}`)
      if (vlansOn(ix, current.bridge).some((v) => num(scalarOf(v.options, 'vlan')) === vid)) {
        throw refuse(422, 'vlan_in_use', `VLAN ${vid} is already on ${current.bridge}.`, {
          vlanId: vid,
        })
      }
      const device = `${current.bridge}.${vid}`
      checkDeviceName(device)
      network.push(
        put(bv, 'network', 'bridge-vlan', withOptions(bv.options, { vlan: String(vid) }))
      )
      ifaceOptions = withOptions(ifaceOptions, { device })
      ifaceChanged = true
    } else if (current.l2Mode === '8021q' && current.parentDevice) {
      const dev = current.device ? ix.devicesByName.get(current.device) : undefined
      const device = `${current.parentDevice}.${vid}`
      checkDeviceName(device)
      if (ix.devicesByName.has(device)) {
        throw refuse(422, 'vlan_in_use', `VLAN ${vid} is already on ${current.parentDevice}.`, {
          vlanId: vid,
        })
      }
      if (dev) {
        requireSynced(dev, 'networks', 'network_not_managed', `The VLAN device of ${key}`)
        network.push(
          put(
            dev,
            'network',
            'device',
            withOptions(dev.options, { vid: String(vid), name: device })
          )
        )
      }
      ifaceOptions = withOptions(ifaceOptions, { device })
      ifaceChanged = true
    } else {
      throw refuse(422, 'vlan_not_applicable', `${key} is not a VLAN network.`)
    }
  }

  if (patch.ports !== undefined) {
    checkPorts(patch.ports)
    if (current.l2Mode === 'bridge_vlan' && current.bridge) {
      const bridge = ix.devicesByName.get(current.bridge)!
      const vid = patch.vlanId ?? current.vlanId
      const siblings = vlansOn(ix, current.bridge).filter(
        (v) => num(scalarOf(v.options, 'vlan')) !== current.vlanId
      )
      const bv = vlansOn(ix, current.bridge).find(
        (v) => num(scalarOf(v.options, 'vlan')) === current.vlanId
      )
      if (!bv) throw refuse(409, 'network_not_managed', `The bridge VLAN of ${key} is missing.`)
      requireSynced(bv, 'networks', 'network_not_managed', `The bridge VLAN of ${key}`)
      for (const p of patch.ports.filter((x) => x.pvid)) {
        const clash = siblings.find((v) =>
          listItems(v.options.ports).some((item) => {
            const spec = parsePortSpec(item)
            return spec !== null && spec.port === p.port && spec.pvid
          })
        )
        if (clash) {
          throw refuse(
            422,
            'port_pvid_conflict',
            `${p.port} is already the untagged port of VLAN ${scalarOf(clash.options, 'vlan')}.`,
            {
              port: p.port,
              vlanId: num(scalarOf(clash.options, 'vlan')),
            }
          )
        }
      }
      const members = listItems(bridge.options.ports)
      const added = patch.ports.map((p) => p.port).filter((p) => !members.includes(p))
      if (added.length > 0) {
        for (const port of added) {
          const holder = bridgeHolding(ix, port, current.bridge)
          if (holder)
            throw refuse(409, 'port_in_use', `${port} is a port of ${holder}.`, {
              port,
              bridge: holder,
            })
        }
        requireSynced(bridge, 'networks', 'bridge_not_managed', `The bridge ${current.bridge}`)
        network.push(
          put(
            bridge,
            'network',
            'device',
            withOptions(bridge.options, { ports: [...members, ...added] })
          )
        )
      }
      const existingEdit = network.find((e) => e.op === 'put' && e.perchId === bv.perchId)
      const baseOptions =
        existingEdit && existingEdit.op === 'put' ? existingEdit.options : bv.options
      const next = put(
        bv,
        'network',
        'bridge-vlan',
        withOptions(baseOptions, {
          ports: patch.ports.map(portSpecText),
          ...(vid !== null ? { vlan: String(vid) } : {}),
        })
      )
      const i = network.indexOf(existingEdit!)
      if (i >= 0) network[i] = next
      else network.push(next)
    } else if (current.l2Mode === 'bridge' && current.bridge) {
      const bridge = ix.devicesByName.get(current.bridge)!
      requireSynced(bridge, 'networks', 'bridge_not_managed', `The bridge ${current.bridge}`)
      for (const p of patch.ports) {
        const holder = bridgeHolding(ix, p.port, current.bridge)
        if (holder)
          throw refuse(409, 'port_in_use', `${p.port} is a port of ${holder}.`, {
            port: p.port,
            bridge: holder,
          })
      }
      const names = patch.ports.map((p) => p.port)
      network.push(
        put(
          bridge,
          'network',
          'device',
          names.length > 0
            ? withOptions(bridge.options, { ports: names }, ['bridge_empty'])
            : withOptions(bridge.options, { bridge_empty: '1' }, ['ports'])
        )
      )
    } else {
      throw refuse(422, 'ports_not_applicable', `${key} has no bridge ports to set.`)
    }
  }

  if (ifaceChanged) network.push(put(iface, 'network', 'interface', ifaceOptions))

  if (patch.dhcp !== undefined) {
    const pool = ix.pools.find((p) => scalarOf(p.options, 'interface') === key) ?? null
    if (pool) requireSynced(pool, 'dhcp_pools', 'dhcp_pool_not_managed', `The DHCP pool of ${key}`)
    if (patch.dhcp === null) {
      if (pool) pools.push({ op: 'delete', perchId: pool.perchId })
    } else {
      const address = interfaceCidrs(ifaceOptions)[0] ?? null
      if (address === null && patch.dhcp.enabled !== false) {
        throw refuse(422, 'dhcp_needs_address', 'A DHCP pool needs the network’s address.')
      }
      checkPoolFits(patch.dhcp, address)
      pools.push(poolEdit(ix, key, patch.dhcp, pool))
    }
  }
  return { network, pools, warnings, converted: null }
}

/**
 * Removes a network: its interface, the L2 sections only it used, and its
 * pool. The management network is refused (it would cut the agent off).
 */
export function planDeleteNetwork(
  states: SectionState[],
  key: string,
  management: ManagementPath | null
): NetworkPlan {
  const ix = index(states)
  const iface = findNetwork(ix, key)
  const current = compose(ix, iface, management)
  requireSynced(iface, 'networks', 'network_not_managed', `The network ${key}`)
  if (current.management) {
    throw refuse(409, 'management_network', `${key} carries the connection to the controller.`)
  }
  const network: SectionEdit[] = [{ op: 'delete', perchId: iface.perchId }]
  const pools: SectionEdit[] = []
  const warnings: Issue[] = []
  const keep = (s: ModelSection, what: string) =>
    warnings.push({
      severity: 'warning',
      code: 'section_kept',
      message: `${what} (${s.name}) is the router's and stays.`,
      perchId: s.perchId,
      config: s.config,
      section: s.name,
    })
  for (const perchId of current.sections.slice(1)) {
    const s = ix.all.find((x) => x.perchId === perchId)!
    if (s.scope === 'synced' && s.domain === 'networks') network.push({ op: 'delete', perchId })
    else keep(s, 'An L2 section')
  }
  if (current.dhcp) {
    const pool = ix.all.find((x) => x.perchId === current.dhcp!.perchId)!
    if (pool.scope === 'synced' && pool.domain === 'dhcp_pools')
      pools.push({ op: 'delete', perchId: pool.perchId })
    else keep(pool, 'The DHCP pool')
  }
  return { network, pools, warnings, converted: null }
}
