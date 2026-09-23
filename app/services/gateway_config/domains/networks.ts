import { itemsOf } from '#services/gateway_config/canonical'
import type {
  ConfigDomain,
  SectionEdit,
  SecretEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type {
  Issue,
  UciConfigSet,
  UciOptions,
  UciSection,
  UciValue,
} from '#services/gateway_config/types'

/**
 * Networks: OpenWrt's native `network` config, 1:1 (plan 1 section 8.1,
 * docs/gateway/networks.md). A network is one LAN-side `interface` section
 * plus the L2 sections it rides on:
 *
 * - `config device` of type `bridge` (`name`, `list ports`), `8021q` or
 *   `8021ad` (`name`, `ifname`, `vid`);
 * - `config bridge-vlan` (`device`, `vlan`, `list ports 'lan1:t' 'lan3:u*'`)
 *   on a VLAN-filtering bridge: native VLAN creation, never reinvented.
 *
 * The domain claims those sections one by one (the engine checks the round
 * trip per section on import), models a few options of each and carries
 * every other option verbatim (`extra`). How the sections form a network is
 * `network_model.ts`; the REST writes go through it.
 *
 * Not claimed (they stay unmodeled, mirrored and logged): WAN-side
 * interfaces (any proto other than `static`/`none`, a static one with a
 * `gateway`, or one in a firewall zone with `masq`), `loopback`, `globals`,
 * swconfig `switch`/`switch_vlan` (pre-DSA targets), plain `device`
 * sections (MAC or MTU overrides of a port), routes and rules. WAN
 * protocols belong to the routing sibling.
 */

export const NETWORK_SECTION_TYPES = ['interface', 'device', 'bridge-vlan'] as const
export const L2_DEVICE_TYPES = ['bridge', '8021q', '8021ad'] as const

/** Options the domain reads and writes, per section type; the rest ride along. */
export const MODELED_OPTIONS: Record<(typeof NETWORK_SECTION_TYPES)[number], readonly string[]> = {
  'interface': ['proto', 'device', 'ifname', 'ipaddr', 'netmask', 'ip6assign'],
  'device': ['name', 'type', 'ports', 'ifname', 'vid'],
  'bridge-vlan': ['device', 'vlan', 'ports'],
}

export type NetworkSectionKind = 'interface' | 'device' | 'bridge_vlan'

/** One claimed section as the domain models it. */
export interface NetworkSection {
  kind: NetworkSectionKind
  perchId: string | null
  /** UCI section name. */
  section: string
  type: string
  /** The modeled options present on the section (spelling kept). */
  fields: UciOptions
  /** Every other option, verbatim. */
  extra: UciOptions
  /** Secret slots the section carries (none expected; kept as the router's). */
  secretNames: string[]
}

// ── small helpers ────────────────────────────────────────────────────────

export function scalarOf(options: UciOptions, key: string): string | null {
  const value = options[key]
  if (value === undefined) return null
  return Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export function isIpv4(value: string): boolean {
  return IPV4.test(value)
}

export function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0
}

export function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.')
}

/** `255.255.255.0` → 24; null when it is not a contiguous mask. */
export function maskBits(mask: string): number | null {
  if (!IPV4.test(mask)) return null
  const n = ipv4ToInt(mask)
  let bits = 0
  while (bits < 32 && (n & (0x80000000 >>> bits)) !== 0) bits++
  const rebuilt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return rebuilt === n ? bits : null
}

export function bitsToMask(bits: number): string {
  return intToIpv4(bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)
}

/** `192.168.1.1/24` → address and prefix; null when malformed. */
export function parseCidr(cidr: string): { address: string; prefix: number } | null {
  const [address, prefixText, rest] = cidr.trim().split('/')
  if (rest !== undefined || !IPV4.test(address)) return null
  if (prefixText === undefined) return { address, prefix: 32 }
  if (!/^\d{1,2}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  if (prefix < 0 || prefix > 32) return null
  return { address, prefix }
}

/** Network address of a CIDR as an integer, with its prefix. */
function networkOf(cidr: { address: string; prefix: number }): { base: number; prefix: number } {
  const mask = cidr.prefix === 0 ? 0 : (0xffffffff << (32 - cidr.prefix)) >>> 0
  return { base: (ipv4ToInt(cidr.address) & mask) >>> 0, prefix: cidr.prefix }
}

/** Do two IPv4 CIDRs share any address? */
export function cidrsOverlap(a: string, b: string): boolean {
  const pa = parseCidr(a)
  const pb = parseCidr(b)
  if (!pa || !pb) return false
  const na = networkOf(pa)
  const nb = networkOf(pb)
  const prefix = Math.min(na.prefix, nb.prefix)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (na.base & mask) >>> 0 === (nb.base & mask) >>> 0
}

/**
 * The IPv4 CIDRs of an interface: `ipaddr` (scalar or list, each with or
 * without a prefix) with `netmask` for bare addresses (OpenWrt's default /32
 * without one... LuCI always writes one; a bare address without netmask is
 * taken as /32 like netifd). Malformed entries are skipped.
 */
export function interfaceCidrs(options: UciOptions): string[] {
  const mask = scalarOf(options, 'netmask')
  const bits = mask ? maskBits(mask) : null
  const out: string[] = []
  for (const raw of itemsOf(options.ipaddr).flatMap((v) => v.split(/\s+/))) {
    if (!raw) continue
    if (raw.includes('/')) {
      const parsed = parseCidr(raw)
      if (parsed) out.push(`${parsed.address}/${parsed.prefix}`)
      continue
    }
    if (!IPV4.test(raw)) continue
    out.push(`${raw}/${bits ?? 32}`)
  }
  return out
}

/** One member of a bridge VLAN: `lan1`, `lan1:t`, `lan1:u*`, `lan1:*`, `lan1:t*`. */
export type PortSpec = { port: string; tagged: boolean; pvid: boolean }

const PORT_SPEC = /^([A-Za-z0-9_.@-]{1,15})(?::([tu]?)(\*?))?$/

export function parsePortSpec(item: string): PortSpec | null {
  const m = PORT_SPEC.exec(item.trim())
  if (!m) return null
  return { port: m[1], tagged: m[2] === 't', pvid: m[3] === '*' }
}

export function portSpecText(spec: PortSpec): string {
  return `${spec.port}:${spec.tagged ? 't' : 'u'}${spec.pvid ? '*' : ''}`
}

export function portOf(item: string): string {
  return item.trim().split(':')[0]
}

/**
 * Networks in a firewall zone with masquerading: the WAN side (plan 1
 * section 8.3 uses the same rule on the router).
 */
export function masqNetworks(firewall: Array<{ type: string; options: UciOptions }>): Set<string> {
  const out = new Set<string>()
  for (const s of firewall) {
    if (s.type !== 'zone') continue
    const masq = scalarOf(s.options, 'masq')
    if (masq !== '1' && masq !== 'true' && masq !== 'on' && masq !== 'yes') continue
    for (const name of itemsOf(s.options.network).flatMap((v) => v.split(/\s+/))) {
      if (name) out.add(name)
    }
  }
  return out
}

export type InterfaceSide = 'lan' | 'wan' | 'loopback'

/**
 * Which side an `interface` section is on: `loopback` (the name, or device
 * `lo`), `wan` (a proto other than `static`/`none`, a static address with a
 * `gateway`, or a network in a masquerading zone), else `lan`.
 */
export function interfaceSide(
  name: string,
  options: UciOptions,
  wanNetworks: ReadonlySet<string>
): InterfaceSide {
  const device = scalarOf(options, 'device') ?? scalarOf(options, 'ifname')
  if (name === 'loopback' || device === 'lo') return 'loopback'
  const proto = scalarOf(options, 'proto') ?? 'none'
  if (proto !== 'static' && proto !== 'none') return 'wan'
  if (scalarOf(options, 'gateway') !== null) return 'wan'
  if (wanNetworks.has(name)) return 'wan'
  return 'lan'
}

function wanNetworksOf(all: UciConfigSet): Set<string> {
  return masqNetworks(all.firewall?.sections ?? [])
}

function kindOf(type: string): NetworkSectionKind | null {
  if (type === 'interface') return 'interface'
  if (type === 'device') return 'device'
  if (type === 'bridge-vlan') return 'bridge_vlan'
  return null
}

/** Modeled options must be plain strings, except the `ports` lists. */
function modeledShapesOk(type: string, options: UciOptions): boolean {
  const modeled = MODELED_OPTIONS[type as keyof typeof MODELED_OPTIONS] ?? []
  return modeled.every((key) => {
    const value = options[key]
    if (value === undefined) return true
    if (key === 'ports' || key === 'ipaddr') return true
    return typeof value === 'string'
  })
}

/** Does the domain claim this `network` section? */
export function claimsNetworkSection(
  section: { name: string; type: string; options: UciOptions },
  wanNetworks: ReadonlySet<string>
): boolean {
  const o = section.options
  if (!modeledShapesOk(section.type, o)) return false
  switch (section.type) {
    case 'interface':
      return interfaceSide(section.name, o, wanNetworks) === 'lan'
    case 'device': {
      const type = scalarOf(o, 'type')
      return (
        type !== null &&
        (L2_DEVICE_TYPES as readonly string[]).includes(type) &&
        scalarOf(o, 'name') !== null
      )
    }
    case 'bridge-vlan':
      return scalarOf(o, 'device') !== null && scalarOf(o, 'vlan') !== null
    default:
      return false
  }
}

// ── the domain ───────────────────────────────────────────────────────────

export const networksDomain: ConfigDomain<NetworkSection> = {
  key: 'networks',
  configs: ['network'],
  types: [...NETWORK_SECTION_TYPES],

  claims(section: UciSection & { config: string }, all: UciConfigSet) {
    if (section.config !== 'network') return false
    return claimsNetworkSection(section, wanNetworksOf(all))
  },

  listSemantics: {
    // Bridge membership has no order; a port added on each side merges.
    'device.ports': 'set',
    // One entry per port: the same port changed differently on both sides
    // (tagged here, untagged there) is a conflict, other ports merge.
    'bridge-vlan.ports': { keyed: portOf },
  },

  normalize(type, option, value) {
    if (type === 'bridge-vlan' && option === 'vlan' && typeof value === 'string') {
      const n = Number(value.trim())
      return Number.isInteger(n) ? String(n) : value
    }
    if (type === 'device' && option === 'vid' && typeof value === 'string') {
      const n = Number(value.trim())
      return Number.isInteger(n) ? String(n) : value
    }
    if (option === 'ports') {
      return itemsOf(value)
        .flatMap((v) => v.split(/\s+/))
        .filter((v) => v.length > 0)
    }
    return value
  },

  identityKeys(section) {
    const o = section.options
    if (section.type === 'device') {
      const name = scalarOf(o, 'name')
      return name ? [`device:${name}`] : []
    }
    if (section.type === 'bridge-vlan') {
      const device = scalarOf(o, 'device')
      const vlan = scalarOf(o, 'vlan')
      return device && vlan ? [`bridge-vlan:${device}.${Number(vlan)}`] : []
    }
    return []
  },

  parse(sections) {
    const out: NetworkSection[] = []
    for (const s of sections) {
      if (s.config !== 'network') continue
      const kind = kindOf(s.type)
      if (!kind) continue
      const modeled = MODELED_OPTIONS[s.type as keyof typeof MODELED_OPTIONS]
      const fields: UciOptions = {}
      const extra: UciOptions = {}
      for (const [key, value] of Object.entries(s.options)) {
        const copy = Array.isArray(value) ? [...value] : value
        if (modeled.includes(key)) fields[key] = copy
        else extra[key] = copy
      }
      out.push({
        kind,
        perchId: s.perchId,
        section: s.name,
        type: s.type,
        fields,
        extra,
        secretNames: Object.keys(s.secrets ?? {}),
      })
    }
    return out
  },

  render(obj, current) {
    const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
    const options: UciOptions = { ...obj.extra }
    for (const [key, value] of Object.entries(obj.fields)) {
      options[key] = Array.isArray(value) ? [...value] : value
    }
    const secrets: Record<string, SecretEdit> = {}
    for (const name of obj.secretNames) {
      if (existing?.secrets?.[name]) secrets[name] = { keep: true }
    }
    const edit: SectionEdit = {
      op: 'put',
      perchId: obj.perchId,
      config: 'network',
      type: obj.type,
      ...(obj.perchId ? {} : { name: obj.section }),
      options,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    }
    return [edit]
  },

  validate(desired, ctx) {
    return validateNetworks(desired, ctx)
  },
}

// ── validation ───────────────────────────────────────────────────────────

/**
 * Cross-section checks (plan 1 section 8.1). Errors: VIDs outside 1–4094,
 * a VID used twice on one bridge, a port that is the PVID (`*`) of more
 * than one VLAN on a bridge, a malformed address, overlapping IPv4 subnets
 * between two interfaces (static WAN addresses included). Warnings: an
 * interface on `<bridge>.<vid>` of a VLAN-filtering bridge without that
 * `bridge-vlan`, a bridge VLAN member that is not a port of its bridge.
 */
export function validateNetworks(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const mine = desired.filter((s) => s.config === 'network')
  const minePerch = new Set(mine.map((s) => s.perchId))
  const others = [
    ...ctx.all.filter((s) => s.config === 'network' && !minePerch.has(s.perchId)),
    ...(ctx.unmanaged ?? []).filter((s) => s.config === 'network'),
  ]
  const everything = [...mine, ...others]
  const issue = (
    s: SyncedSection,
    severity: Issue['severity'],
    code: string,
    message: string,
    option?: string
  ) =>
    issues.push({
      severity,
      code,
      message,
      perchId: s.perchId,
      config: s.config,
      section: s.name,
      ...(option ? { option } : {}),
    })

  const bridges = new Map<string, SyncedSection>()
  for (const s of everything) {
    if (s.type === 'device' && scalarOf(s.options, 'type') === 'bridge') {
      const name = scalarOf(s.options, 'name')
      if (name) bridges.set(name, s)
    }
  }
  const vlansByBridge = new Map<string, SyncedSection[]>()
  for (const s of everything) {
    if (s.type !== 'bridge-vlan') continue
    const device = scalarOf(s.options, 'device')
    if (!device) continue
    const list = vlansByBridge.get(device) ?? []
    list.push(s)
    vlansByBridge.set(device, list)
  }

  // bridge-vlan: VID range, unique per bridge, one PVID per port.
  for (const s of mine) {
    if (s.type !== 'bridge-vlan') continue
    const device = scalarOf(s.options, 'device') ?? ''
    const vlanText = scalarOf(s.options, 'vlan') ?? ''
    const vid = Number(vlanText)
    if (!/^\d+$/.test(vlanText.trim()) || vid < 1 || vid > 4094) {
      issue(s, 'error', 'invalid_vlan', `VLAN "${vlanText}" is outside 1–4094`, 'vlan')
      continue
    }
    const siblings = (vlansByBridge.get(device) ?? []).filter((x) => x !== s)
    const twin = siblings.find((x) => Number(scalarOf(x.options, 'vlan')) === vid)
    if (twin) {
      issue(s, 'error', 'vlan_in_use', `VLAN ${vid} is already on ${device} (${twin.name})`, 'vlan')
    }
    const bridge = bridges.get(device)
    const members = bridge ? itemsOf(bridge.options.ports).flatMap((v) => v.split(/\s+/)) : null
    for (const item of itemsOf(s.options.ports).flatMap((v) => v.split(/\s+/))) {
      if (!item) continue
      const spec = parsePortSpec(item)
      if (!spec) {
        issue(s, 'error', 'invalid_port', `"${item}" is not a bridge VLAN port`, 'ports')
        continue
      }
      if (members && !members.includes(spec.port)) {
        issue(
          s,
          'warning',
          'port_not_in_bridge',
          `${spec.port} is not a port of ${device}`,
          'ports'
        )
      }
      if (!spec.pvid) continue
      const clash = siblings.find((x) =>
        itemsOf(x.options.ports)
          .flatMap((v) => v.split(/\s+/))
          .some((other) => {
            const o = parsePortSpec(other)
            return o !== null && o.port === spec.port && o.pvid
          })
      )
      if (clash) {
        issue(
          s,
          'error',
          'port_pvid_conflict',
          `${spec.port} is already the untagged (PVID) port of VLAN ${scalarOf(clash.options, 'vlan')} on ${device}`,
          'ports'
        )
      }
    }
  }

  // 802.1q devices.
  for (const s of mine) {
    if (s.type !== 'device') continue
    const type = scalarOf(s.options, 'type')
    if (type !== '8021q' && type !== '8021ad') continue
    const vidText = scalarOf(s.options, 'vid') ?? ''
    const vid = Number(vidText)
    if (!/^\d+$/.test(vidText.trim()) || vid < 1 || vid > 4094) {
      issue(s, 'error', 'invalid_vlan', `VLAN "${vidText}" is outside 1–4094`, 'vid')
    }
    if (!scalarOf(s.options, 'ifname')) {
      issue(
        s,
        'error',
        'vlan_parent_required',
        'An 802.1q device needs its parent device',
        'ifname'
      )
    }
  }

  // Interfaces: addresses, overlaps, VLAN devices without their bridge-vlan.
  const wanNetworks = new Set<string>()
  const addressed = everything
    .filter((s) => s.type === 'interface')
    .filter((s) => interfaceSide(s.name, s.options, wanNetworks) !== 'loopback')
    .map((s) => ({ s, cidrs: interfaceCidrs(s.options) }))
  for (const s of mine) {
    if (s.type !== 'interface') continue
    const raw = itemsOf(s.options.ipaddr).flatMap((v) => v.split(/\s+/))
    const cidrs = interfaceCidrs(s.options)
    if (raw.filter((v) => v.length > 0).length !== cidrs.length) {
      issue(s, 'error', 'invalid_ipaddr', `An address of ${s.name} is not valid IPv4`, 'ipaddr')
    }
    const mask = scalarOf(s.options, 'netmask')
    if (mask !== null && maskBits(mask) === null) {
      issue(s, 'error', 'invalid_netmask', `"${mask}" is not a netmask`, 'netmask')
    }
    for (const cidr of cidrs) {
      const other = addressed.find(
        (x) => x.s !== s && x.s.name !== s.name && x.cidrs.some((c) => cidrsOverlap(c, cidr))
      )
      if (other) {
        issue(
          s,
          'error',
          'subnet_overlap',
          `${cidr} overlaps ${other.cidrs.join(', ')} of ${other.s.name}`,
          'ipaddr'
        )
        break
      }
    }
    const device = scalarOf(s.options, 'device')
    const dot = device ? device.lastIndexOf('.') : -1
    if (device && dot > 0) {
      const bridge = device.slice(0, dot)
      const vid = Number(device.slice(dot + 1))
      const vlans = vlansByBridge.get(bridge)
      if (
        bridges.has(bridge) &&
        vlans &&
        vlans.length > 0 &&
        !vlans.some((v) => Number(scalarOf(v.options, 'vlan')) === vid)
      ) {
        issue(
          s,
          'warning',
          'vlan_missing',
          `${bridge} has no bridge VLAN ${vid} for ${device}`,
          'device'
        )
      }
    }
  }
  return issues
}

/** The value of a list option as items (space-separated strings split). */
export function listItems(value: UciValue | undefined): string[] {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter((v) => v.length > 0)
}
