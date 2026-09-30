import { itemsOf } from '#services/gateway_config/canonical'
import type { UciConfigSet, UciOptions } from '#services/gateway_config/types'

/**
 * The side rule (docs/design/gateway-sync/domains.md 2): which side of the
 * router a `network` interface is on. One function for every domain
 * (`networks`, `dhcp_pools`, `wan`, `wireguard`) and the same rule, in the
 * same order, as the collector's capture (perch-collector
 * `internal/netcap/side.go`, protocol.md 8):
 *
 *  1. `loopback`: the network `loopback`, or the device `lo`;
 *  2. `vpn`: a tunnel proto (`TUNNEL_PROTOS`), whatever else is true of it;
 *  3. `wan`: a WAN proto (`WAN_PROTOS`), a default route, a masquerading
 *     firewall zone, a UCI `gateway`, or a configured WAN;
 *  4. `wan` (an alias on an uplink): proto `static` or `none` on a device
 *     that a rule-3 WAN uses (its UCI device or its L3 device), or on
 *     `@<that WAN>`: a modem's management subnet on the WAN port;
 *  5. `lan` otherwise (an unknown proto falls through 3–5 by its options).
 *
 * Rule 3's runtime facts come from the agent when the caller has them
 * (`SideFacts`: the `interfaces` observation's default routes and L3
 * devices, the collector's configured `wan_interfaces`); a default route a
 * UCI `route`/`route6` section sets (target `0.0.0.0/0`, `::/0`) counts
 * without them. Without facts the rule works from UCI alone, which classifies
 * every section of the live gateway the same (README section 2).
 *
 * Before this rule `networks` called a static network on a WAN device in no
 * zone (`globe_force`) a LAN, and every proto other than static/none (tunnels
 * included) a WAN.
 */

export type Side = 'loopback' | 'lan' | 'wan' | 'vpn'

/** netifd protos of an uplink (the collector's `WANProtos`). */
export const WAN_PROTOS: readonly string[] = Object.freeze([
  'dhcp',
  'dhcpv6',
  'pppoe',
  'pppoa',
  'pptp',
  'l2tp',
  '3g',
  'qmi',
  'ncm',
  'mbim',
  'modemmanager',
  'wwan',
  'directip',
  '6in4',
  '6to4',
  '6rd',
  'dslite',
  'map',
  '464xlat',
])

/** netifd protos of a tunnel (the collector's `TunnelProtos`). */
export const TUNNEL_PROTOS: readonly string[] = Object.freeze([
  'wireguard',
  'openvpn',
  'gre',
  'gretap',
  'grev6',
  'grev6tap',
  'vti',
  'vtiv6',
  'vxlan',
  'ipip',
  'xfrm',
])

export function isWanProto(proto: string | null | undefined): boolean {
  return proto !== null && proto !== undefined && WAN_PROTOS.includes(proto)
}

export function isTunnelProto(proto: string | null | undefined): boolean {
  return proto !== null && proto !== undefined && TUNNEL_PROTOS.includes(proto)
}

/**
 * What the agent reports that rule 3 uses beside UCI. Every field optional:
 * absent = unknown, and the rule works from UCI alone.
 */
export interface SideFacts {
  /** Networks netifd reports holding a default route now (`interfaces` observation). */
  defaultRoute?: readonly string[] | null
  /** The collector's configured `wan_interfaces` (network or device names). */
  configuredWan?: readonly string[] | null
  /** netifd's L3 device per network (`interfaces` observation). */
  l3Devices?: Readonly<Record<string, string>> | null
}

/** An `interface` (or any `network`) section as the rule reads it. */
export type SideSection = { name: string; type: string; anonymous?: boolean; options: UciOptions }
/** A firewall section as the rule reads it (`zone` with `masq`). */
export type ZoneSection = { type: string; options: UciOptions }

function scalar(options: UciOptions, key: string): string | null {
  const value = options[key]
  if (value === undefined) return null
  return Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value
}

function words(value: UciOptions[string] | undefined): string[] {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter((v) => v.length > 0)
}

function truthy(value: string | null): boolean {
  return value !== null && ['1', 'true', 'yes', 'on', 'enabled'].includes(value.toLowerCase())
}

/** Networks in a firewall zone with masquerading on. */
export function masqZoneNetworks(firewall: readonly ZoneSection[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const s of firewall ?? []) {
    if (s.type !== 'zone' || !truthy(scalar(s.options, 'masq'))) continue
    for (const name of words(s.options.network)) out.add(name)
  }
  return out
}

/** An interface's proto as netifd runs it (`none` when unset). */
export function protoOf(options: UciOptions): string {
  return scalar(options, 'proto') ?? 'none'
}

/**
 * An interface's UCI device, like the collector's `NetworkUCI`: `device`,
 * else `br-<name>` for a pre-21.02 bridge interface, else the first word of
 * `ifname`.
 */
export function uciDeviceOf(section: SideSection): string | null {
  const device = scalar(section.options, 'device')
  if (device) return device
  if (scalar(section.options, 'type') === 'bridge') return `br-${section.name}`
  return words(section.options.ifname)[0] ?? null
}

/** Networks a UCI route section gives a default route (`0.0.0.0/0`, `::/0`), not disabled. */
function uciDefaultRoutes(network: readonly SideSection[]): Set<string> {
  const out = new Set<string>()
  for (const s of network) {
    if (s.type !== 'route' && s.type !== 'route6') continue
    if (truthy(scalar(s.options, 'disabled'))) continue
    const iface = scalar(s.options, 'interface')
    const target = scalar(s.options, 'target')
    if (!iface || !target) continue
    const mask = scalar(s.options, 'netmask')
    const isDefault =
      target === '0.0.0.0/0' ||
      target === '::/0' ||
      target === '::' ||
      (target === '0.0.0.0' && (mask === '0.0.0.0' || mask === '0'))
    if (isDefault) out.add(iface)
  }
  return out
}

/**
 * Every named `interface` section's side, by network name. `network` and
 * `firewall` are the configs' sections (either may be absent: a read without
 * the firewall knows WANs by proto, route and gateway only).
 */
export function sidesOf(
  network: readonly SideSection[] | undefined,
  firewall: readonly ZoneSection[] | undefined,
  facts?: SideFacts | null
): Map<string, Side> {
  const sections = network ?? []
  const interfaces = sections.filter((s) => s.type === 'interface' && !s.anonymous)
  const masq = masqZoneNetworks(firewall)
  const routed = uciDefaultRoutes(sections)
  for (const n of facts?.defaultRoute ?? []) routed.add(n)
  const configured = new Set(facts?.configuredWan ?? [])
  const l3 = facts?.l3Devices ?? {}
  const devicesOf = (s: SideSection) => {
    const out: string[] = []
    const own = uciDeviceOf(s)
    if (own) out.push(own)
    const live = l3[s.name]
    if (live && live !== own) out.push(live)
    return out
  }

  const out = new Map<string, Side>()
  const wanDevices = new Set<string>()
  for (const s of interfaces) {
    const proto = protoOf(s.options)
    const devices = devicesOf(s)
    if (s.name === 'loopback' || devices.includes('lo')) {
      out.set(s.name, 'loopback')
    } else if (isTunnelProto(proto)) {
      out.set(s.name, 'vpn')
    } else if (
      isWanProto(proto) ||
      routed.has(s.name) ||
      masq.has(s.name) ||
      (scalar(s.options, 'gateway') ?? '') !== '' ||
      configured.has(s.name) ||
      (l3[s.name] !== undefined && configured.has(l3[s.name]))
    ) {
      out.set(s.name, 'wan')
      for (const d of devices) wanDevices.add(d)
      wanDevices.add(`@${s.name}`)
    }
  }
  for (const s of interfaces) {
    if (out.has(s.name)) continue
    const proto = protoOf(s.options)
    const alias =
      (proto === 'static' || proto === 'none') && devicesOf(s).some((d) => wanDevices.has(d))
    out.set(s.name, alias ? 'wan' : 'lan')
  }
  return out
}

// ── facts that ride with a read ───────────────────────────────────────────

const factsByRead = new WeakMap<object, SideFacts>()

/**
 * Attaches the agent's facts to a config set (a read being merged), so
 * domains' `claims(section, all)` classify with them. Returns `all`.
 */
export function attachSideFacts(all: UciConfigSet, facts: SideFacts | null | undefined) {
  if (facts) factsByRead.set(all, facts)
  else factsByRead.delete(all)
  return all
}

export function sideFactsOf(all: UciConfigSet): SideFacts | null {
  return factsByRead.get(all) ?? null
}

/** Sides of every interface of a config set (with its attached facts). */
export function sidesOfSet(all: UciConfigSet, facts?: SideFacts | null): Map<string, Side> {
  return sidesOf(all.network?.sections, all.firewall?.sections, facts ?? sideFactsOf(all))
}

/**
 * One network's side in a config set. A network the set does not hold (no
 * `network` config read) is `lan`: a pool of an interface the read does not
 * know was always taken as LAN.
 */
export function sideOf(name: string, all: UciConfigSet, facts?: SideFacts | null): Side {
  return sidesOfSet(all, facts).get(name) ?? 'lan'
}
