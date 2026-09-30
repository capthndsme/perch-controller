import {
  bool,
  cidr,
  count,
  ipAny,
  ipv4,
  ipv4InCidr,
  ipv6,
  isObject,
  list,
  text,
  unixSeconds,
} from '#services/gateway_observation_common'

/**
 * Normalisers of the observation parts the controller keeps as one blob per
 * collector (`gateway_observations.payload`, docs/gateway/observation.md
 * section 2): `interfaces`, `mwan3`, `resolver`, `system`, `wireguard`,
 * `ddns`, `packages`. Each takes whatever the agent sent and returns the cleaned,
 * capped value, or null when it is not one (not an object / array). Unknown
 * fields are dropped, so nothing the agent should not send (a private key)
 * can be stored.
 */

export const MAX_INTERFACES = 256
export const MAX_ADDRESSES = 32
export const MAX_MWAN3_INTERFACES = 64
export const MAX_MWAN3_POLICIES = 64
export const MAX_TRACK_IPS = 16
export const MAX_WG_INTERFACES = 16
export const MAX_WG_PEERS = 256
export const MAX_PACKAGES = 4096

const NAME_MAX = 64
const WG_KEY = /^[A-Za-z0-9+/]{42,43}=?$/

// ── interfaces ─────────────────────────────────────────────────────────────

export type ObservedInterface = {
  /** UCI network name (`lan`, `guest`, `wan`). */
  network: string
  /** Its L3 device (`br-lan`, `eth1`), null while down. */
  device: string | null
  up: boolean
  proto: string | null
  ipv4: string[]
  ipv6: string[]
  /** Carries a default route; null when the agent does not say. */
  defaultRoute: boolean | null
  metric: number | null
  uptimeSeconds: number | null
  /** Next hops of its default routes. */
  gateway4: string | null
  gateway6: string | null
  dnsServers: string[]
  /** netifd's first error code (`NO_DEVICE`, …). */
  error: string | null
  /**
   * Gateway sync (protocol.md 6.1, feature `observe.ipv6_prefixes`): prefixes
   * delegated to an upstream, and what netifd assigned to a LAN. Empty when
   * the agent does not report them.
   */
  ipv6Prefixes: { prefix: string; preferredUntil: string | null; validUntil: string | null }[]
  ipv6Assigned: string[]
}

export const MAX_IPV6_PREFIXES = 16

/**
 * A time as ISO-8601 UTC (seconds): the agent sends Unix seconds, a stored
 * blob holds the ISO string (blobs are normalised again on read, so this
 * must take its own output). Null for 0, absent or nonsense.
 */
export function isoFromUnix(value: unknown): string | null {
  if (typeof value === 'string') {
    const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)
      ? Date.parse(value)
      : Number.NaN
    return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  const seconds = unixSeconds(value)
  if (!seconds) return null
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function normalizeInterfaces(value: unknown): ObservedInterface[] | null {
  if (!Array.isArray(value)) return null
  const out: ObservedInterface[] = []
  const seen = new Set<string>()
  for (const entry of list(value)) {
    if (out.length >= MAX_INTERFACES) break
    if (!isObject(entry)) continue
    const network = text(entry.network, 32)
    if (!network || seen.has(network)) continue
    seen.add(network)
    const addresses = (raw: unknown, family: 4 | 6) =>
      [
        ...new Set(
          list(raw)
            .map((a) => cidr(a, family))
            .filter((a): a is string => a !== null)
        ),
      ].slice(0, MAX_ADDRESSES)
    out.push({
      network,
      device: text(entry.device, 32),
      up: entry.up === true,
      proto: text(entry.proto, 32),
      ipv4: addresses(entry.ipv4, 4),
      ipv6: addresses(entry.ipv6, 6),
      defaultRoute: bool(entry.defaultRoute),
      metric: count(entry.metric, 2 ** 31),
      uptimeSeconds: count(entry.uptimeSeconds, 2 ** 40),
      gateway4: ipv4(entry.gateway4),
      gateway6: ipv6(entry.gateway6),
      dnsServers: [
        ...new Set(
          list(entry.dnsServers)
            .map(ipAny)
            .filter((a): a is string => a !== null)
        ),
      ].slice(0, 16),
      error: text(entry.error, 64),
      ipv6Prefixes: list(entry.ipv6Prefixes)
        .filter(isObject)
        .map((p) => ({
          prefix: cidr(p.prefix, 6),
          preferredUntil: isoFromUnix(p.preferredUntil),
          validUntil: isoFromUnix(p.validUntil),
        }))
        .filter(
          (p): p is { prefix: string; preferredUntil: string | null; validUntil: string | null } =>
            p.prefix !== null
        )
        .slice(0, MAX_IPV6_PREFIXES),
      ipv6Assigned: [
        ...new Set(
          list(entry.ipv6Assigned)
            .map((a) => cidr(a, 6))
            .filter((a): a is string => a !== null)
        ),
      ].slice(0, MAX_IPV6_PREFIXES),
    })
  }
  return out.sort((a, b) => (a.network < b.network ? -1 : a.network > b.network ? 1 : 0))
}

/**
 * The network an address or device belongs to: the interface whose IPv4
 * subnet holds the address, else the interface on that device. Null when
 * none matches (or no interfaces are known).
 */
export function networkFor(
  interfaces: ObservedInterface[] | null,
  address: string | null,
  device: string | null = null
): string | null {
  if (!interfaces) return null
  if (address && ipv4(address)) {
    // Longest prefix wins (a /32 alias inside a /24).
    let best: { network: string; bits: number } | null = null
    for (const iface of interfaces) {
      for (const subnet of iface.ipv4) {
        const bits = Number(subnet.split('/')[1])
        if (ipv4InCidr(address, subnet) && (!best || bits > best.bits)) {
          best = { network: iface.network, bits }
        }
      }
    }
    if (best) return best.network
  }
  if (device) {
    const match = interfaces.find((iface) => iface.device === device)
    if (match) return match.network
  }
  return null
}

// ── mwan3 ──────────────────────────────────────────────────────────────────

export type Mwan3Observation = {
  /**
   * The service, apart from its config and live status: installed (the
   * part is only sent when mwan3 is installed), enabled at boot, running
   * (mwan3track). The live gateway has mwan3 configured but disabled.
   */
  service: { installed: boolean | null; enabled: boolean | null; running: boolean | null } | null
  /** UCI `interface` sections. */
  configInterfaces: {
    name: string
    enabled: boolean | null
    family: string | null
    trackIps: string[]
  }[]
  /** UCI `policy` sections: name → member names. */
  configPolicies: Record<string, string[]>
  /** `ubus call mwan3 status` ([] when mwan3 does not answer). */
  interfaces: {
    name: string
    status: string | null
    enabled: boolean | null
    running: boolean | null
    up: boolean | null
    uptimeSeconds: number | null
    tracking: string | null
    trackIps: { ip: string; up: boolean | null }[]
  }[]
  /** Live policies: name → members. */
  policies: Record<string, { interface: string; percent: number | null }[]>
}

/**
 * perch-collector sends `serviceEnabled` / `running` at the top level; an
 * earlier draft of this contract had `service: {installed, enabled,
 * running}`. Both read the same.
 */
export function normalizeMwan3(value: unknown): Mwan3Observation | null {
  if (!isObject(value)) return null
  let service: Mwan3Observation['service'] = null
  if (isObject(value.service)) {
    service = {
      installed: bool(value.service.installed),
      enabled: bool(value.service.enabled),
      running: bool(value.service.running),
    }
  } else if (typeof value.serviceEnabled === 'boolean' || typeof value.running === 'boolean') {
    // The part is absent when mwan3 is not installed: present = installed.
    service = { installed: true, enabled: bool(value.serviceEnabled), running: bool(value.running) }
  }

  const interfaces: Mwan3Observation['interfaces'] = []
  const names = new Set<string>()
  for (const entry of list(value.interfaces)) {
    if (interfaces.length >= MAX_MWAN3_INTERFACES) break
    if (!isObject(entry)) continue
    const name = text(entry.name, NAME_MAX)
    if (!name || names.has(name)) continue
    names.add(name)
    const trackIps: { ip: string; up: boolean | null }[] = []
    for (const track of list(entry.trackIps)) {
      if (trackIps.length >= MAX_TRACK_IPS) break
      const ip = isObject(track) ? ipAny(track.ip) : ipAny(track)
      if (ip) trackIps.push({ ip, up: isObject(track) ? bool(track.up) : null })
    }
    interfaces.push({
      name,
      status: text(entry.status, 32),
      enabled: bool(entry.enabled),
      running: bool(entry.running),
      up: bool(entry.up),
      uptimeSeconds: count(entry.uptimeSeconds, 2 ** 40),
      tracking: text(entry.tracking, 32),
      trackIps,
    })
  }

  const configInterfaces: Mwan3Observation['configInterfaces'] = []
  const configNames = new Set<string>()
  for (const entry of list(value.configInterfaces)) {
    if (configInterfaces.length >= MAX_MWAN3_INTERFACES) break
    if (!isObject(entry)) continue
    const name = text(entry.name, NAME_MAX)
    if (!name || configNames.has(name)) continue
    configNames.add(name)
    configInterfaces.push({
      name,
      enabled: bool(entry.enabled),
      family: text(entry.family, 16),
      trackIps: list(entry.trackIps)
        .map(ipAny)
        .filter((a): a is string => a !== null)
        .slice(0, MAX_TRACK_IPS),
    })
  }

  const policies: Mwan3Observation['policies'] = {}
  if (isObject(value.policies)) {
    for (const [rawName, members] of Object.entries(value.policies).slice(0, MAX_MWAN3_POLICIES)) {
      const name = text(rawName, NAME_MAX)
      if (!name) continue
      policies[name] = list(members)
        .filter(isObject)
        .map((m) => ({ interface: text(m.interface, NAME_MAX), percent: count(m.percent, 100) }))
        .filter((m): m is { interface: string; percent: number | null } => m.interface !== null)
        .slice(0, MAX_MWAN3_INTERFACES)
    }
  }
  const configPolicies: Mwan3Observation['configPolicies'] = {}
  if (isObject(value.configPolicies)) {
    for (const [rawName, members] of Object.entries(value.configPolicies).slice(
      0,
      MAX_MWAN3_POLICIES
    )) {
      const name = text(rawName, NAME_MAX)
      if (!name) continue
      configPolicies[name] = list(members)
        .map((m) => text(m, NAME_MAX))
        .filter((m): m is string => m !== null)
        .slice(0, MAX_MWAN3_INTERFACES)
    }
  }
  return { service, configInterfaces, configPolicies, interfaces, policies }
}

// ── resolver ───────────────────────────────────────────────────────────────

export type ResolverObservation = {
  /** dnsmasq's DNS port (0 = DNS off; 54 behind AdGuard Home on the live gateway). */
  dnsmasqPort: number | null
  /** The process listening on port 53 (`dnsmasq`, `AdGuardHome`, `unbound`); null when unknown. */
  port53Process: string | null
  /** Every process with a socket on port 53 (usually one). */
  port53Processes: string[]
  /** How the router resolves the controller's host name; `error` when the lookup failed. */
  controllerHost: { name: string; addresses: string[]; error: string | null } | null
}

export function normalizeResolver(value: unknown): ResolverObservation | null {
  if (!isObject(value)) return null
  let controllerHost: ResolverObservation['controllerHost'] = null
  if (isObject(value.controllerHost)) {
    const name = text(value.controllerHost.name)
    if (name) {
      controllerHost = {
        name,
        addresses: [
          ...new Set(
            list(value.controllerHost.addresses)
              .map(ipAny)
              .filter((a): a is string => a !== null)
          ),
        ].slice(0, 16),
        error: text(value.controllerHost.error, 32),
      }
    }
  }
  const port53Process = text(value.port53Process, NAME_MAX)
  const port53Processes = list(value.port53Processes)
    .map((p) => text(p, NAME_MAX))
    .filter((p): p is string => p !== null)
    .slice(0, 8)
  return {
    dnsmasqPort: count(value.dnsmasqPort, 65535),
    port53Process,
    port53Processes:
      port53Processes.length > 0 ? port53Processes : port53Process ? [port53Process] : [],
    controllerHost,
  }
}

// ── system ─────────────────────────────────────────────────────────────────

export type SystemObservation = {
  hostname: string | null
  /** `OpenWrt 24.10.2` (DISTRIB_DESCRIPTION / ubus system board release). */
  release: string | null
  /** `24.10.2` and the build revision. */
  version: string | null
  revision: string | null
  /** Target, e.g. `x86/64`; `boardName` and `model` the hardware. */
  board: string | null
  boardName: string | null
  model: string | null
  kernel: string | null
  uptimeSeconds: number | null
  /** Unix seconds on the router's clock when it reported. */
  localtime: number | null
  /** Software / hardware flow offloading in fw4's defaults (hardware hides bytes from the collector). */
  flowOffloading: boolean | null
  flowOffloadingHw: boolean | null
}

export function normalizeSystem(value: unknown): SystemObservation | null {
  if (!isObject(value)) return null
  return {
    hostname: text(value.hostname, NAME_MAX),
    release: text(value.release, 128),
    version: text(value.version, NAME_MAX),
    revision: text(value.revision, NAME_MAX),
    board: text(value.board, NAME_MAX),
    boardName: text(value.boardName, 128),
    model: text(value.model, 128),
    kernel: text(value.kernel, NAME_MAX),
    uptimeSeconds: count(value.uptimeSeconds, 2 ** 40),
    localtime: count(value.localtime, 2 ** 40),
    flowOffloading: bool(value.flowOffloading),
    flowOffloadingHw: bool(value.flowOffloadingHw),
  }
}

// ── wireguard ──────────────────────────────────────────────────────────────

export type WireguardObservation = {
  interfaces: {
    name: string
    /** The UCI network (interface section) it belongs to. */
    network: string | null
    publicKey: string | null
    listenPort: number | null
    peers: {
      publicKey: string
      description: string | null
      endpoint: string | null
      allowedIps: string[]
      /** Unix seconds, 0 = never. */
      latestHandshake: number | null
      rxBytes: number | null
      txBytes: number | null
      /** Persistent keepalive in seconds, null when off. */
      keepalive: number | null
    }[]
  }[]
}

function wgKey(value: unknown): string | null {
  return typeof value === 'string' && WG_KEY.test(value.trim()) ? value.trim() : null
}

/** Public keys and peer state only: private and preshared keys are never kept. */
export function normalizeWireguard(value: unknown): WireguardObservation | null {
  if (!isObject(value)) return null
  const interfaces: WireguardObservation['interfaces'] = []
  for (const entry of list(value.interfaces)) {
    if (interfaces.length >= MAX_WG_INTERFACES) break
    if (!isObject(entry)) continue
    const name = text(entry.name, 32)
    if (!name) continue
    const peers: WireguardObservation['interfaces'][number]['peers'] = []
    for (const peer of list(entry.peers)) {
      if (peers.length >= MAX_WG_PEERS) break
      if (!isObject(peer)) continue
      const publicKey = wgKey(peer.publicKey)
      if (!publicKey) continue
      peers.push({
        publicKey,
        description: text(peer.description, NAME_MAX),
        endpoint: text(peer.endpoint, 128),
        allowedIps: list(peer.allowedIps)
          .map((a) => cidr(a, 4) ?? cidr(a, 6))
          .filter((a): a is string => a !== null)
          .slice(0, 64),
        latestHandshake: count(peer.latestHandshake, 2 ** 40),
        rxBytes: count(peer.rxBytes),
        txBytes: count(peer.txBytes),
        keepalive: count(peer.keepalive, 65535) || null,
      })
    }
    interfaces.push({
      name,
      network: text(entry.network, 32),
      publicKey: wgKey(entry.publicKey),
      listenPort: count(entry.listenPort, 65535),
      peers,
    })
  }
  return { interfaces }
}

// ── ddns ───────────────────────────────────────────────────────────────────

export const MAX_DDNS_SERVICES = 64
export const MAX_DDNS_PROVIDERS = 512

export type DdnsObservation = {
  installed: boolean
  /** `/etc/init.d/ddns` enabled at boot; null when the agent does not say. */
  serviceEnabled: boolean | null
  /** Provider names ddns-scripts knows (`service_name` values). */
  providers: string[]
  services: {
    name: string
    enabled: boolean | null
    domain: string | null
    /** The address the provider has (the `.ip` file). */
    registeredIp: string | null
    /** Last successful update, ISO; null = never. */
    lastUpdate: string | null
    running: boolean
    /** The last ERROR/WARN log line after the last success, ≤ 200 bytes. */
    lastError: string | null
  }[]
}

/** ddns-scripts' state (protocol.md 6.1): never a password. */
export function normalizeDdns(value: unknown): DdnsObservation | null {
  if (!isObject(value)) return null
  const providers = [
    ...new Set(
      list(value.providers)
        .map((p) => text(p, 128))
        .filter((p): p is string => p !== null)
    ),
  ]
    .sort()
    .slice(0, MAX_DDNS_PROVIDERS)
  const services: DdnsObservation['services'] = []
  const seen = new Set<string>()
  for (const entry of list(value.services)) {
    if (services.length >= MAX_DDNS_SERVICES) break
    if (!isObject(entry)) continue
    const name = text(entry.name, 64)
    if (!name || seen.has(name)) continue
    seen.add(name)
    services.push({
      name,
      enabled: bool(entry.enabled),
      domain: text(entry.domain, 253),
      registeredIp: ipAny(entry.registeredIp),
      lastUpdate: isoFromUnix(entry.lastUpdate),
      running: entry.running === true,
      lastError: text(entry.lastError, 200),
    })
  }
  services.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    installed: value.installed !== false,
    serviceEnabled: bool(value.serviceEnabled),
    providers,
    services,
  }
}

// ── packages ───────────────────────────────────────────────────────────────

export type PackagesObservation = {
  /** `opkg` or `apk`. */
  manager: string | null
  installed: { name: string; version: string }[]
  /** Null when the agent did not check (it is on demand). */
  upgradable: { name: string; version: string }[] | null
}

function packageList(value: unknown): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = []
  for (const entry of list(value)) {
    if (out.length >= MAX_PACKAGES) break
    if (!isObject(entry)) continue
    const name = text(entry.name, 128)
    const version = text(entry.version, 128)
    if (name && version) out.push({ name, version })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function normalizePackages(value: unknown): PackagesObservation | null {
  if (!isObject(value)) return null
  return {
    manager: text(value.manager, 16),
    installed: packageList(value.installed),
    upgradable: Array.isArray(value.upgradable) ? packageList(value.upgradable) : null,
  }
}

/** The blob kinds and their normalisers. */
export const BLOB_PARTS = {
  interfaces: normalizeInterfaces,
  mwan3: normalizeMwan3,
  resolver: normalizeResolver,
  system: normalizeSystem,
  wireguard: normalizeWireguard,
  ddns: normalizeDdns,
  packages: normalizePackages,
} as const

export type BlobKind = keyof typeof BLOB_PARTS
export const BLOB_KINDS = Object.keys(BLOB_PARTS) as BlobKind[]
