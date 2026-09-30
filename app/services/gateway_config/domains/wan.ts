import type {
  ConfigDomain,
  FeatureSyncIssue,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import { deriveWanChecks } from '#services/gateway_config/wan_checks'
import {
  cidrsOverlap,
  interfaceCidrs,
  ipv4ToInt,
  parseCidr,
} from '#services/gateway_config/domains/networks'
import {
  isTunnelProto,
  isWanProto,
  masqZoneNetworks,
  protoOf,
  sidesOfSet,
  uciDeviceOf,
  type Side,
  type SideFacts,
} from '#services/gateway_config/domains/side'
import {
  flagValue,
  isIpv4Address,
  isIpv6Address,
  parsePrefix,
  parseVerbatim,
  renderVerbatim,
  scalarOption,
  wordsOf,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import {
  hasFeature,
  type GatewayCapabilities,
  type Issue,
  type SectionContent,
  type UciConfigSet,
  type UciOptions,
  type UciSection,
} from '#services/gateway_config/types'

/**
 * The WAN side of the router (docs/design/gateway-sync/domains.md 3, owner
 * decisions D1, D2, D8): internet uplinks (DHCP, static, PPPoE, mobile, …),
 * their IPv6 companions, aliases on an uplink's device (a modem's management
 * subnet: live `ADDR`, `globe_force`), NAT links (a masqueraded side network:
 * live `LANX`), the plain `device` section of an uplink's port (MAC override,
 * MTU) and the WAN-side DHCP pool (`dhcp 'wan'`, `ignore '1'`).
 *
 * Which sections are WAN-side is the shared side rule (`side.ts`), the same
 * as the collector's capture. Objects are the sections verbatim, so the round
 * trip is exact; the REST view (`wan_service.ts`) is built from the topology
 * below. Every job that touches an uplink, alias, device or pool is a
 * **checked** job (`checksFor`, `wan_checks.ts`): the router verifies the
 * internet after the commit. Authoritative Mode imports router edits of WAN
 * sections by default (`authoritativeWan: 'import'`, D2).
 *
 * Claims nothing without an agent that runs checks (`requires`): a WAN is
 * never reverted without them (domains.md 1.2).
 */

export const WAN_KEY = 'wan'

/** Options Perch owns on a WAN-side pool; the rest (lease options, …) is the router's. */
export const WAN_POOL_OWNED = [
  'interface',
  'ignore',
  'ra',
  'dhcpv6',
  'ndp',
  'master',
  'ra_flags',
] as const

/** UCI booleans of interfaces the equality normalises (domains.md 3.3). */
const INTERFACE_FLAGS = new Set([
  'auto',
  'disabled',
  'defaultroute',
  'peerdns',
  'delegate',
  'norelease',
  'force_link',
])
const DEVICE_FLAGS = new Set(['ipv6', 'disabled'])
const POOL_FLAGS = new Set(['ignore', 'master', 'dynamicdhcp'])

/** Protos whose options Perch shows verbatim (mobile, tunnels over the WAN): `limited` in the REST view. */
export const FULL_PROTOS = ['dhcp', 'static', 'pppoe'] as const
export const MOBILE_PROTOS = ['3g', 'qmi', 'ncm', 'mbim', 'modemmanager', 'wwan', 'directip']

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i

function flag(options: UciOptions, key: string): string | null {
  const v = scalarOption(options, key)
  return v === null ? null : flagValue(v)
}

/** Whether an interface is enabled (`disabled` not `1`, `auto` not `0`). */
export function interfaceEnabled(options: UciOptions): boolean {
  return flag(options, 'disabled') !== '1' && flag(options, 'auto') !== '0'
}

/** Its metric as a number (absent = 0; odd text = 0). */
export function metricOf(options: UciOptions): number {
  const raw = scalarOption(options, 'metric')
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return 0
  return Number(raw)
}

// ── the topology (domains.md 3.2) ─────────────────────────────────────────

export type WanRole = 'internet' | 'nat_link'

export interface WanLink {
  network: string
  proto: string
  /** UCI device (`wan0`, `@wan`); null when none. */
  device: string | null
  metric: number
  enabled: boolean
  /** `defaultroute` is not `0`. */
  defaultRoute: boolean
  role: WanRole
  /** 1 = primary; null for a NAT link. */
  rank: number | null
  /** The IPv6 companion's network (`wan6`), if any. */
  companion: string | null
  /** Alias networks on its device. */
  aliases: string[]
  /** The plain `device` section (by section name) of its port, if any. */
  deviceSection: string | null
  /** The WAN-side pool (`dhcp` section name) of it or its companion. */
  pool: string | null
}

export interface WanTopology {
  sides: Map<string, Side>
  /** Internet uplinks, by rank. */
  uplinks: WanLink[]
  natLinks: WanLink[]
  /** Companion network → its uplink. */
  companionOf: Map<string, string>
  /** Alias network → its uplink. */
  aliasOf: Map<string, string>
  /** `device` section name → the uplink using it. */
  deviceOf: Map<string, string>
  /** Pool (`dhcp` section) name → the WAN network it serves. */
  poolOf: Map<string, string>
}

function interfacesOf(all: UciConfigSet): UciSection[] {
  return (all.network?.sections ?? []).filter((s) => s.type === 'interface' && !s.anonymous)
}

/** An IPv6-only interface: a `dhcpv6` proto, or static with `ip6addr` and no `ipaddr`. */
function v6Only(s: UciSection): boolean {
  const proto = protoOf(s.options)
  if (proto === 'dhcpv6') return true
  return (
    proto === 'static' &&
    s.options.ip6addr !== undefined &&
    s.options.ipaddr === undefined &&
    scalarOption(s.options, 'gateway') === null
  )
}

/**
 * The WAN side as objects: uplinks with their companions, aliases, device
 * sections and pools, NAT links, and the failover rank (uplinks sorted by
 * metric, absent = 0, ties by name). `roles` overrides a link's role (the
 * Perch-only `gateway_wans.role_override`).
 */
export function wanTopology(
  all: UciConfigSet,
  options: { facts?: SideFacts | null; roles?: Record<string, WanRole> } = {}
): WanTopology {
  const sides = sidesOfSet(all, options.facts)
  const wanSide = interfacesOf(all).filter((s) => sides.get(s.name) === 'wan')
  const uplinkCandidates = wanSide.filter((s) => {
    const proto = protoOf(s.options)
    return (
      (isWanProto(proto) || scalarOption(s.options, 'gateway') !== null) &&
      flag(s.options, 'defaultroute') !== '0'
    )
  })
  // Companions: an IPv6-only interface on an IPv4 uplink's device or @uplink.
  const v4 = uplinkCandidates.filter((s) => !v6Only(s))
  const companionOf = new Map<string, string>()
  for (const s of uplinkCandidates.filter(v6Only)) {
    const device = uciDeviceOf(s)
    const host = v4.find(
      (u) => device !== null && (device === `@${u.name}` || device === uciDeviceOf(u))
    )
    if (host && ![...companionOf.values()].includes(host.name)) companionOf.set(s.name, host.name)
  }
  const uplinkSections = uplinkCandidates.filter((s) => !companionOf.has(s.name))
  const uplinkDevices = new Map<string, string>()
  for (const u of uplinkSections) {
    const d = uciDeviceOf(u)
    if (d && !d.startsWith('@') && !uplinkDevices.has(d)) uplinkDevices.set(d, u.name)
    uplinkDevices.set(`@${u.name}`, u.name)
  }
  // Aliases: static/none on an uplink's device (or @uplink), no gateway.
  const aliasOf = new Map<string, string>()
  for (const s of wanSide) {
    if (uplinkSections.includes(s) || companionOf.has(s.name)) continue
    const proto = protoOf(s.options)
    if (proto !== 'static' && proto !== 'none') continue
    if (scalarOption(s.options, 'gateway') !== null) continue
    const d = uciDeviceOf(s)
    const host = d ? uplinkDevices.get(d) : undefined
    if (host) aliasOf.set(s.name, host)
  }
  // Plain device sections of an uplink's port.
  const deviceOf = new Map<string, string>()
  for (const s of all.network?.sections ?? []) {
    if (s.type !== 'device' || scalarOption(s.options, 'type') !== null) continue
    const name = scalarOption(s.options, 'name')
    const host = name ? uplinkDevices.get(name) : undefined
    if (host && !deviceOf.has(s.name)) deviceOf.set(s.name, host)
  }
  // WAN-side pools.
  const poolOf = new Map<string, string>()
  for (const s of all.dhcp?.sections ?? []) {
    if (s.type !== 'dhcp') continue
    const iface = scalarOption(s.options, 'interface')
    if (iface && sides.get(iface) === 'wan') poolOf.set(s.name, iface)
  }

  const link = (s: UciSection, role: WanRole): WanLink => {
    const companion = [...companionOf].find(([, host]) => host === s.name)?.[0] ?? null
    return {
      network: s.name,
      proto: protoOf(s.options),
      device: uciDeviceOf(s),
      metric: metricOf(s.options),
      enabled: interfaceEnabled(s.options),
      defaultRoute: flag(s.options, 'defaultroute') !== '0',
      role,
      rank: null,
      companion,
      aliases: [...aliasOf].filter(([, host]) => host === s.name).map(([alias]) => alias),
      deviceSection: [...deviceOf].find(([, host]) => host === s.name)?.[0] ?? null,
      pool:
        [...poolOf].find(([, net]) => net === s.name)?.[0] ??
        (companion ? ([...poolOf].find(([, net]) => net === companion)?.[0] ?? null) : null),
    }
  }
  const roles = options.roles ?? {}
  const links: WanLink[] = []
  for (const s of wanSide) {
    if (companionOf.has(s.name) || aliasOf.has(s.name)) continue
    const natural: WanRole = uplinkSections.includes(s) ? 'internet' : 'nat_link'
    links.push(link(s, roles[s.name] ?? natural))
  }
  const uplinks = links
    .filter((l) => l.role === 'internet')
    .sort((a, b) => a.metric - b.metric || a.network.localeCompare(b.network))
  uplinks.forEach((u, i) => (u.rank = i + 1))
  const natLinks = links
    .filter((l) => l.role === 'nat_link')
    .sort((a, b) => a.network.localeCompare(b.network))
  return { sides, uplinks, natLinks, companionOf, aliasOf, deviceOf, poolOf }
}

/** The primary uplink: the enabled internet uplink of the lowest rank with a default route. */
export function primaryUplink(topology: WanTopology): WanLink | null {
  return topology.uplinks.find((u) => u.enabled && u.defaultRoute) ?? null
}

/** The uplink a WAN-side network belongs to (itself, its companion, alias, device or pool). */
export function uplinkNetworkOf(topology: WanTopology, network: string): string | null {
  if (topology.uplinks.some((u) => u.network === network)) return network
  return topology.companionOf.get(network) ?? topology.aliasOf.get(network) ?? null
}

// ── claims ────────────────────────────────────────────────────────────────

/** UCI devices of the LAN side and of the WAN side (a plain device section claims by them). */
function devicesBySide(all: UciConfigSet): { wan: Set<string>; lan: Set<string> } {
  const sides = sidesOfSet(all)
  const wan = new Set<string>()
  const lan = new Set<string>()
  for (const s of interfacesOf(all)) {
    const d = uciDeviceOf(s)
    if (!d || d.startsWith('@')) continue
    const side = sides.get(s.name)
    if (side === 'wan') wan.add(d)
    else if (side === 'lan') lan.add(d)
  }
  // A LAN bridge's ports are LAN devices too.
  for (const s of all.network?.sections ?? []) {
    if (s.type !== 'device' || scalarOption(s.options, 'type') !== 'bridge') continue
    const name = scalarOption(s.options, 'name')
    if (!name || !lan.has(name)) continue
    for (const port of wordsOf(s.options.ports)) lan.add(port)
    for (const port of wordsOf(s.options.ifname)) lan.add(port)
  }
  return { wan, lan }
}

/** Does the `wan` domain model this section (domains.md 3.1)? */
export function claimsWanSection(section: UciSection & { config: string }, all: UciConfigSet) {
  if (section.config === 'network') {
    if (section.type === 'interface') {
      return !section.anonymous && sidesOfSet(all).get(section.name) === 'wan'
    }
    if (section.type === 'device') {
      if (scalarOption(section.options, 'type') !== null) return false
      const name = scalarOption(section.options, 'name')
      if (!name) return false
      const devices = devicesBySide(all)
      return devices.wan.has(name) && !devices.lan.has(name)
    }
    return false
  }
  if (section.config === 'dhcp' && section.type === 'dhcp') {
    const iface = section.options.interface
    if (typeof iface !== 'string' || iface.length === 0 || !all.network) return false
    return sidesOfSet(all).get(iface) === 'wan'
  }
  return false
}

// ── the domain ────────────────────────────────────────────────────────────

/** Whether the router lets the agent write a config (`writableConfigs`, else `allowedConfigs`). */
export function configWritable(caps: GatewayCapabilities, config: string): boolean {
  const writable = caps.writableConfigs
  if (Array.isArray(writable)) return writable.includes(config)
  return Array.isArray(caps.allowedConfigs) && caps.allowedConfigs.includes(config)
}

/** Which options differ between two contents (keys of either). */
function changedOptions(a: SectionContent | null, b: SectionContent | null): string[] {
  const keys = new Set([...Object.keys(a?.options ?? {}), ...Object.keys(b?.options ?? {})])
  return [...keys].filter(
    (k) => JSON.stringify(a?.options[k] ?? null) !== JSON.stringify(b?.options[k] ?? null)
  )
}

export const wanDomain: ConfigDomain<VerbatimSection> = {
  key: WAN_KEY,
  configs: ['network', 'dhcp'],
  types: ['interface', 'device', 'dhcp'],
  secretOptions: ['password', 'pincode', 'pukcode'],

  requires(caps: GatewayCapabilities): string | null {
    if (!hasFeature(caps, 'config.checks.v1')) return 'The gateway agent is too old for WAN changes'
    if (!configWritable(caps, 'network')) return 'network is not writable on the router'
    return null
  },

  claims(section, all) {
    return claimsWanSection(section, all)
  },

  ownership(section) {
    if (section.config === 'dhcp') return { kind: 'options', options: [...WAN_POOL_OWNED] }
    return { kind: 'section' }
  },

  listSemantics: {
    'interface.ipaddr': 'set',
    'interface.ip6addr': 'set',
    'interface.ip6prefix': 'set',
  },

  normalize(type, option, value) {
    if (typeof value !== 'string') return value
    if (option === 'macaddr') return value.trim().toLowerCase()
    if (type === 'interface') {
      if (INTERFACE_FLAGS.has(option)) return flagValue(value)
      if (option === 'metric' && /^\s*\d+\s*$/.test(value)) return String(Number(value))
    }
    if (type === 'device' && DEVICE_FLAGS.has(option)) return flagValue(value)
    if (type === 'dhcp' && POOL_FLAGS.has(option)) return flagValue(value)
    return value
  },

  identityKeys(section) {
    if (section.type === 'device') {
      const name = scalarOption(section.options, 'name')
      return name ? [`device:${name}`] : []
    }
    if (section.type === 'dhcp') {
      const iface = scalarOption(section.options, 'interface')
      return iface ? [`wanpool:${iface}`] : []
    }
    // Interfaces are named sections (LuCI names them): matched by name.
    return []
  },

  /**
   * Domains.md 3.6: when the controller is reached over a WAN (a remote
   * controller: the path's network is WAN-side), every WAN interface and its
   * port's device section are on the path (a failover moves the path). On a
   * LAN-side path WAN jobs are checked jobs, not protected ones.
   */
  touchesManagement(section, path) {
    if (path.wanSide !== true) return false
    return section.type === 'interface' || section.type === 'device'
  },

  /**
   * Owner decision D2 (domains.md 3.7): router edits of WAN sections are
   * imported by default. With `enforce`, a WAN enabled or disabled on the
   * router (only `disabled`/`auto` moved) is still imported: a pause, never
   * reverted (decision 15's spirit); every other edit follows Authoritative
   * Mode, and its revert is a checked job.
   */
  authoritative(settings, row) {
    if ((settings?.authoritativeWan ?? 'import') !== 'enforce') return 'import'
    if (row.base && row.router && row.base.type === row.router.type) {
      const moved = changedOptions(row.base, row.router)
      if (moved.length > 0 && moved.every((o) => o === 'disabled' || o === 'auto')) {
        return 'import'
      }
    }
    return 'follow'
  },

  parse(sections) {
    return [
      ...parseVerbatim(sections, 'network', ['interface', 'device']),
      ...parseVerbatim(sections, 'dhcp', ['dhcp']),
    ]
  },

  render(obj, current) {
    return renderVerbatim(obj, current, obj.type === 'dhcp' ? 'dhcp' : 'network')
  },

  validate(desired, ctx) {
    return validateWan(desired, ctx)
  },

  inSync(sections, observed) {
    const live = observed.interfaces
    if (!live) return []
    const out: FeatureSyncIssue[] = []
    for (const s of sections) {
      if (s.scope !== 'synced' || s.type !== 'interface') continue
      if (!interfaceEnabled(s.options)) continue
      const seen = live.find((i) => i.network === s.name)
      if (!seen) {
        out.push({
          feature: WAN_KEY,
          objectId: s.perchId,
          code: 'wan_interface_missing',
          message: `netifd does not report the WAN interface ${s.name}.`,
        })
        continue
      }
      const proto = protoOf(s.options)
      if (seen.proto && seen.proto !== proto) {
        out.push({
          feature: WAN_KEY,
          objectId: s.perchId,
          code: 'wan_proto_mismatch',
          message: `${s.name} runs ${seen.proto}, its config says ${proto} (not reloaded).`,
        })
      }
      if (
        seen.up === true &&
        seen.defaultRoute === true &&
        typeof seen.metric === 'number' &&
        scalarOption(s.options, 'metric') !== null &&
        seen.metric !== metricOf(s.options)
      ) {
        out.push({
          feature: WAN_KEY,
          objectId: s.perchId,
          code: 'wan_metric_mismatch',
          message: `${s.name} routes with metric ${seen.metric}, its config says ${metricOf(s.options)}.`,
        })
      }
    }
    return out
  },

  checksFor(ctx) {
    return deriveWanChecks(ctx)
  },
}

// ── validation (domains.md 3.4) ───────────────────────────────────────────

/** A config set of the desired synced sections plus the router's unmanaged ones. */
function desiredSet(ctx: ValidationCtx): UciConfigSet {
  const out: UciConfigSet = {}
  const add = (s: SyncedSection) => {
    const config = (out[s.config] ??= { name: s.config, hash: '', sections: [] })
    config.sections.push({
      name: s.name,
      type: s.type,
      anonymous: s.anonymous,
      index: config.sections.length,
      options: s.options,
    })
  }
  const ordered = [...ctx.all, ...(ctx.unmanaged ?? [])].sort(
    (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
  )
  for (const s of ordered) add(s)
  return out
}

function v4Of(value: string): string | null {
  const [address] = value.split('/')
  return isIpv4Address(address) ? address : null
}

function inCidr(address: string, cidr: string): boolean {
  const p = parseCidr(cidr)
  if (!p || !isIpv4Address(address)) return false
  const mask = p.prefix === 0 ? 0 : (0xffffffff << (32 - p.prefix)) >>> 0
  return (ipv4ToInt(address) & mask) >>> 0 === (ipv4ToInt(p.address) & mask) >>> 0
}

/** Options of one proto that do nothing on another (`wan_option_not_for_proto`). */
const PPPOE_ONLY = ['username', 'password', 'service', 'ac', 'host_uniq']
const STATIC_ONLY = ['ipaddr', 'netmask', 'gateway']

export function validateWan(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const all = desiredSet(ctx)
  const topology = wanTopology(all)
  const zones = [...ctx.all, ...(ctx.unmanaged ?? [])].filter(
    (s) => s.config === 'firewall' && s.type === 'zone'
  )
  const masq = masqZoneNetworks(zones)
  const zoneOf = (network: string) =>
    zones.find((z) => wordsOf(z.options.network).includes(network)) ?? null
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

  const lanDevices = devicesBySide(all).lan
  for (const s of desired) {
    if (s.config === 'network' && s.type === 'device') {
      const mac = scalarOption(s.options, 'macaddr')
      if (mac !== null && !MAC.test(mac.trim())) {
        issue(s, 'error', 'wan_mac_invalid', `"${mac}" is not a MAC address.`, 'macaddr')
      }
      checkMtu(s)
      continue
    }
    if (s.config !== 'network' || s.type !== 'interface') continue
    const proto = protoOf(s.options)
    if (isTunnelProto(proto)) continue
    // Addresses.
    const rawV4 = wordsOf(s.options.ipaddr)
    const cidrs = interfaceCidrs(s.options)
    if (rawV4.length !== cidrs.length) {
      issue(
        s,
        'error',
        'wan_static_address_invalid',
        `An address of ${s.name} is not valid IPv4.`,
        'ipaddr'
      )
    }
    const netmask = scalarOption(s.options, 'netmask')
    if (netmask !== null && !isIpv4Address(netmask)) {
      issue(s, 'error', 'wan_static_address_invalid', `"${netmask}" is not a netmask.`, 'netmask')
    }
    const gateway = scalarOption(s.options, 'gateway')
    if (gateway !== null && gateway !== '' && !isIpv4Address(gateway)) {
      issue(
        s,
        'error',
        'wan_static_address_invalid',
        `"${gateway}" is not an IPv4 gateway.`,
        'gateway'
      )
    }
    for (const v of wordsOf(s.options.ip6addr)) {
      const p = parsePrefix(v)
      if (!p || p.family !== 6) {
        issue(s, 'error', 'wan_static_address_invalid', `"${v}" is not an IPv6 address.`, 'ip6addr')
        break
      }
    }
    const ip6gw = scalarOption(s.options, 'ip6gw')
    if (ip6gw !== null && !isIpv6Address(ip6gw)) {
      issue(s, 'error', 'wan_static_address_invalid', `"${ip6gw}" is not an IPv6 gateway.`, 'ip6gw')
    }
    if (
      proto === 'static' &&
      gateway &&
      isIpv4Address(gateway) &&
      cidrs.length > 0 &&
      !cidrs.some((c) => inCidr(gateway, c))
    ) {
      issue(
        s,
        'error',
        'wan_gateway_outside_subnet',
        `The gateway ${gateway} is outside ${cidrs.join(', ')}.`,
        'gateway'
      )
    }
    // Aliases must not cover their uplink's address or gateway.
    const host = topology.aliasOf.get(s.name)
    if (host) {
      const uplink = all.network?.sections.find((x) => x.name === host)
      const theirs = uplink ? interfaceCidrs(uplink.options) : []
      const theirGateway = uplink ? scalarOption(uplink.options, 'gateway') : null
      for (const cidr of cidrs) {
        const hit =
          theirs.find((c) => {
            const a = v4Of(c)
            return a !== null && inCidr(a, cidr)
          }) ?? (theirGateway && inCidr(theirGateway, cidr) ? theirGateway : null)
        if (hit) {
          issue(
            s,
            'error',
            'wan_alias_overlaps_uplink',
            `${cidr} covers ${hit} of ${host}.`,
            'ipaddr'
          )
          break
        }
      }
    }
    // Device conflicts with the LAN.
    const device = uciDeviceOf({ name: s.name, type: s.type, options: s.options })
    if (device && !device.startsWith('@') && lanDevices.has(device)) {
      issue(s, 'error', 'wan_device_in_use', `${device} is a LAN device or bridge port.`, 'device')
    }
    const mac = scalarOption(s.options, 'macaddr')
    if (mac !== null && !MAC.test(mac.trim())) {
      issue(s, 'error', 'wan_mac_invalid', `"${mac}" is not a MAC address.`, 'macaddr')
    }
    checkMtu(s)
    const metric = scalarOption(s.options, 'metric')
    if (metric !== null && (!/^\d{1,10}$/.test(metric.trim()) || Number(metric) > 2147483647)) {
      issue(
        s,
        'error',
        'wan_metric_invalid',
        `"${metric}" is not a metric (0–2147483647).`,
        'metric'
      )
    }
    if (proto === 'pppoe' && !scalarOption(s.options, 'username')) {
      issue(s, 'error', 'wan_pppoe_username_required', 'PPPoE needs a user name.', 'username')
    }
    // Warnings on uplinks.
    const link = topology.uplinks.find((u) => u.network === s.name)
    if (link) {
      const zone = zoneOf(s.name)
      if (!zone) {
        issue(
          s,
          'warning',
          'wan_no_zone',
          `${s.name} is in no firewall zone (no NAT, no input policy).`
        )
      } else if (!masq.has(s.name)) {
        issue(s, 'warning', 'wan_zone_not_masq', `${s.name}'s zone does not masquerade.`)
      }
      if (mac !== null && link.deviceSection) {
        const dev = all.network?.sections.find((x) => x.name === link.deviceSection)
        const devMac = dev ? scalarOption(dev.options, 'macaddr') : null
        if (devMac && devMac.toLowerCase() !== mac.toLowerCase()) {
          issue(
            s,
            'warning',
            'wan_mac_override_ignored',
            `The device section sets ${devMac}; this interface's macaddr is not in effect.`,
            'macaddr'
          )
        }
      }
      const twin = topology.uplinks.find(
        (u) => u !== link && u.enabled && link.enabled && u.metric === link.metric
      )
      if (twin) {
        issue(
          s,
          'warning',
          'wan_duplicate_metric',
          `${s.name} and ${twin.network} share metric ${link.metric}: the failover order is unclear.`,
          'metric'
        )
      }
      if (proto === 'pppoe' || proto === 'pppoa') {
        const l3 = `${proto}-${s.name}`
        const shaped = [...ctx.all, ...(ctx.unmanaged ?? [])].find(
          (q) =>
            q.config === 'sqm' &&
            q.type === 'queue' &&
            flag(q.options, 'enabled') !== '0' &&
            scalarOption(q.options, 'interface') === link.device &&
            link.device !== l3
        )
        if (shaped) {
          issue(
            s,
            'warning',
            'wan_sqm_device',
            `An SQM queue shapes ${link.device}; with ${proto} the traffic leaves by ${l3}.`,
            'proto'
          )
        }
      }
    }
    // Options that do nothing for this proto (a proto changed on one side).
    const has = (o: string) => s.options[o] !== undefined || s.secrets?.[o] !== undefined
    const stray = [
      ...(proto === 'dhcp' || proto === 'static' ? PPPOE_ONLY.filter(has) : []),
      ...(proto === 'dhcp' || proto === 'pppoe' ? STATIC_ONLY.filter(has) : []),
    ]
    if (stray.length > 0) {
      issue(
        s,
        'warning',
        'wan_option_not_for_proto',
        `${stray.join(', ')} ${stray.length === 1 ? 'does' : 'do'} nothing with ${proto}.`,
        stray[0]
      )
    }
  }
  return issues

  function checkMtu(s: SyncedSection) {
    const mtu = scalarOption(s.options, 'mtu')
    if (mtu === null) return
    const n = Number(mtu)
    if (!/^\d+$/.test(mtu.trim()) || n < 576 || n > 9200) {
      issue(s, 'error', 'wan_mtu_invalid', `"${mtu}" is not an MTU (576–9200).`, 'mtu')
    }
  }
}

/** Whether two IPv4 CIDR lists share an address (the alias REST check). */
export function cidrListsOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => cidrsOverlap(x, y)))
}
