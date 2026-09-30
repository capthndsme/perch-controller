import Collector from '#models/collector'
import {
  gatewayForCollector,
  normalizeMode,
  resolveGateway,
} from '#services/gateway_config/gateway_registry'
import { deviceWanBlock, type WanAccessView } from '#services/gateway_config/firewall_service'
import collectorHub from '#services/collector_agent_hub'
import { sessionCapabilities } from '#services/collector_agent'
import { getDeviceLabels } from '#services/device_labels'
import {
  isObject,
  parseJsonArray,
  parseJsonObject,
  rawRows,
} from '#services/gateway_observation_common'
import {
  normalizeInterfaces,
  normalizeMwan3,
  normalizePackages,
  normalizeResolver,
  normalizeSystem,
  normalizeDdns,
  normalizeWireguard,
  type Mwan3Observation,
  type ObservedInterface,
  type PackagesObservation,
  type ResolverObservation,
  type SystemObservation,
  type DdnsObservation,
  type WireguardObservation,
} from '#services/gateway_observation_parts'
import db from '@adonisjs/lucid/services/db'

/**
 * Reads of the observation channel for the REST API (docs/gateway/
 * observation.md section 7). Shapes follow plan-2-native-sync.md section 5
 * where it defines them. Times are ISO strings computed by the database
 * (`DATE_FORMAT` of UTC wall times), ages with `TIMESTAMPDIFF` against
 * `UTC_TIMESTAMP()`; MACs are joined to devices and labels in JS (the
 * tables' collations differ).
 */

/**
 * A part whose last report is older than this reads `stale`: three times the
 * agent's full-resend interval (600 s), so only a gone or broken agent
 * crosses it. A protocol bound, not a tunable.
 */
export const STALE_OBSERVATION_SECONDS = 1800

const ISO = `'%Y-%m-%dT%H:%i:%sZ'`

// ── the gateway behind `:gatewayId` ────────────────────────────────────────

/**
 * `:gatewayId` is `gateways.id` (the config plane's row, one per adopted
 * gateway collector; `resolveGateway` in gateway_registry.ts). The mirrors
 * are keyed by the collector the gateway is bound to, so this returns that
 * collector: null (→ 404 `gateway_not_found`) for an unknown or detached
 * gateway, or one whose collector is not adopted.
 */
export async function resolveObservedGateway(gatewayId: unknown): Promise<Collector | null> {
  const gateway = await resolveGateway(gatewayId)
  if (!gateway || gateway.collectorId === null) return null
  const collector = await Collector.find(gateway.collectorId)
  if (!collector || collector.lifecycle !== 'adopted') return null
  return collector
}

// ── parts ──────────────────────────────────────────────────────────────────

export type PartInfo = {
  observedAt: string
  changedAt: string
  secondsSinceReport: number
  stale: boolean
  payload: Record<string, unknown> | null
}

/** One part's info (or undefined when the collector never reported it). */
async function readPart(collectorId: number, kind: string): Promise<PartInfo | undefined> {
  const parts = await readParts(collectorId, [kind])
  return parts.get(kind)
}

async function readParts(collectorId: number, kinds?: string[]): Promise<Map<string, PartInfo>> {
  const filter = kinds && kinds.length > 0 ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''
  const rows = rawRows<{
    kind: string
    payload: string | null
    observedAt: string
    changedAt: string
    age: number | string
  }>(
    await db.rawQuery(
      `SELECT kind, payload,
              DATE_FORMAT(observed_at, ${ISO}) AS observedAt,
              DATE_FORMAT(changed_at, ${ISO}) AS changedAt,
              TIMESTAMPDIFF(SECOND, observed_at, UTC_TIMESTAMP()) AS age
         FROM gateway_observations WHERE collector_id = ? ${filter}`,
      [collectorId, ...(kinds ?? [])]
    )
  )
  const out = new Map<string, PartInfo>()
  for (const row of rows) {
    const age = Math.max(0, Number(row.age))
    out.set(row.kind, {
      observedAt: String(row.observedAt),
      changedAt: String(row.changedAt),
      secondsSinceReport: age,
      stale: age > STALE_OBSERVATION_SECONDS,
      payload: parseJsonObject(row.payload) ?? arrayPayload(row.payload),
    })
  }
  return out
}

/** `interfaces` is stored as an array; wrap it so every payload is an object. */
function arrayPayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? { items: parsed } : null
  } catch {
    return null
  }
}

function interfacesOf(part: PartInfo | undefined): ObservedInterface[] | null {
  if (!part?.payload) return null
  return normalizeInterfaces(part.payload.items)
}

// ── devices (MAC → known device) ───────────────────────────────────────────

export type DeviceRef = { mac: string; name: string | null }

/**
 * The Perch device behind each MAC: a device the collectors have seen
 * (`device_identities`) or one with a label. Name = the label's, else the
 * router's name for it (static host, then lease). Null for a MAC Perch has
 * no device for (a guest VLAN it does not capture: "no traffic data").
 */
async function deviceRefs(
  macs: string[],
  routerNames: Map<string, string | null>
): Promise<Map<string, DeviceRef>> {
  const unique = [...new Set(macs.map((m) => m.toLowerCase()))]
  const out = new Map<string, DeviceRef>()
  if (unique.length === 0) return out
  const known = new Set<string>()
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000)
    const rows = rawRows<{ mac: string }>(
      await db.rawQuery(
        `SELECT DISTINCT mac FROM device_identities WHERE mac IN (${chunk.map(() => '?').join(',')})`,
        chunk
      )
    )
    for (const row of rows) known.add(row.mac.toLowerCase())
  }
  const labels = await getDeviceLabels(unique)
  for (const mac of unique) {
    const label = labels.get(mac)
    if (!known.has(mac) && !label) continue
    out.set(mac, { mac, name: label?.name ?? routerNames.get(mac) ?? null })
  }
  return out
}

// ── hosts: leases and neighbours ───────────────────────────────────────────

type HostRow = {
  collectorId: number
  mac: string
  hostname: string | null
  staticName: string | null
  ipv4: string | null
  ipv6: string | null
  hasLease: number | boolean
  leaseExpiresAt: string | null
  leaseInfinite: number | boolean
  dhcpPresent: number | boolean
  dhcpSeenAt: string | null
  neighborPresent: number | boolean
  neighborReachable: number | boolean
  neighborSeenAt: string | null
  neighborIpv4: string | null
  neighborIpv6: string | null
  neighborDevice: string | null
  network: string | null
  firstSeenAt: string
  lastReportedAt: string | null
}

const HOST_COLUMNS = `
  collector_id AS collectorId, mac, hostname, static_name AS staticName, ipv4, ipv6,
  has_lease AS hasLease, DATE_FORMAT(lease_expires_at, ${ISO}) AS leaseExpiresAt,
  lease_infinite AS leaseInfinite, dhcp_present AS dhcpPresent,
  DATE_FORMAT(dhcp_seen_at, ${ISO}) AS dhcpSeenAt, neighbor_present AS neighborPresent,
  neighbor_reachable AS neighborReachable, DATE_FORMAT(neighbor_seen_at, ${ISO}) AS neighborSeenAt,
  neighbor_ipv4 AS neighborIpv4, neighbor_ipv6 AS neighborIpv6, neighbor_device AS neighborDevice,
  network, DATE_FORMAT(first_seen_at, ${ISO}) AS firstSeenAt,
  DATE_FORMAT(last_reported_at, ${ISO}) AS lastReportedAt`

const truthy = (value: number | boolean) => Boolean(Number(value))

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a > b ? a : b
}

/** plan-2 section 5 `DhcpLease`, plus `staticName` (the router's static host name). */
export type DhcpLease = {
  family: 4 | 6
  mac: string | null
  ip: string
  hostname: string | null
  staticName: string | null
  network: string | null
  expiresAt: string | null
  infinite: boolean
  /** The gateway's latest sighting of the MAC (dated renewal or reachable neighbour). */
  seenAt: string | null
  /** The config plane's reservation id; null until it exists. */
  reservationId: number | null
  device: DeviceRef | null
}

function leasesOf(row: HostRow, device: DeviceRef | null): DhcpLease[] {
  const common = {
    mac: row.mac,
    hostname: row.hostname,
    staticName: row.staticName,
    network: row.network,
    seenAt: latest(row.dhcpSeenAt, row.neighborSeenAt),
    reservationId: null,
    device,
  }
  const out: DhcpLease[] = []
  if (truthy(row.hasLease) && row.ipv4) {
    out.push({
      family: 4,
      ip: row.ipv4,
      expiresAt: row.leaseExpiresAt,
      infinite: truthy(row.leaseInfinite),
      ...common,
    })
  }
  for (const address of parseJsonArray(row.ipv6)) {
    out.push({ family: 6, ip: address, expiresAt: null, infinite: false, ...common })
  }
  return out
}

function routerNamesOf(rows: HostRow[]): Map<string, string | null> {
  return new Map(rows.map((r) => [r.mac.toLowerCase(), r.staticName ?? r.hostname]))
}

/** GET /gateways/:gatewayId/dhcp/leases */
export async function readLeases(collectorId: number, network?: string) {
  const parts = await readParts(collectorId, ['dhcp'])
  const part = parts.get('dhcp')
  const rows = rawRows<HostRow>(
    await db.rawQuery(
      `SELECT ${HOST_COLUMNS} FROM gateway_hosts
        WHERE collector_id = ? AND dhcp_present = 1 ${network ? 'AND network = ?' : ''}
        ORDER BY INET_ATON(ipv4) IS NULL, INET_ATON(ipv4), mac`,
      network ? [collectorId, network] : [collectorId]
    )
  )
  const devices = await deviceRefs(
    rows.map((r) => r.mac),
    routerNamesOf(rows)
  )
  return {
    observedAt: part?.observedAt ?? null,
    stale: part ? part.stale : true,
    leases: rows.flatMap((row) => leasesOf(row, devices.get(row.mac.toLowerCase()) ?? null)),
  }
}

export type GatewayNeighbor = {
  mac: string
  ipv4: string | null
  ipv6: string[]
  /** The router's L3 device the entry is on (`br-lan`). */
  ifname: string | null
  network: string | null
  reachable: boolean
  seenAt: string | null
  hostname: string | null
  device: DeviceRef | null
}

/** GET /gateways/:gatewayId/neighbors */
export async function readNeighbors(collectorId: number, network?: string) {
  const part = await readPart(collectorId, 'neighbors')
  const rows = rawRows<HostRow>(
    await db.rawQuery(
      `SELECT ${HOST_COLUMNS} FROM gateway_hosts
        WHERE collector_id = ? AND neighbor_present = 1 ${network ? 'AND network = ?' : ''}
        ORDER BY INET_ATON(neighbor_ipv4) IS NULL, INET_ATON(neighbor_ipv4), mac`,
      network ? [collectorId, network] : [collectorId]
    )
  )
  const devices = await deviceRefs(
    rows.map((r) => r.mac),
    routerNamesOf(rows)
  )
  return {
    observedAt: part?.observedAt ?? null,
    stale: part ? part.stale : true,
    neighbors: rows.map(
      (row): GatewayNeighbor => ({
        mac: row.mac,
        ipv4: row.neighborIpv4,
        ipv6: parseJsonArray(row.neighborIpv6),
        ifname: row.neighborDevice,
        network: row.network,
        reachable: truthy(row.neighborReachable),
        seenAt: row.neighborSeenAt,
        hostname: row.staticName ?? row.hostname,
        device: devices.get(row.mac.toLowerCase()) ?? null,
      })
    ),
  }
}

// ── UPnP ───────────────────────────────────────────────────────────────────

/** plan-2 section 5 `UpnpMapping`, plus `firstSeenAt`. */
export type UpnpMapping = {
  proto: string
  externalPort: number
  internalIp: string
  internalPort: number
  description: string | null
  expiresAt: string | null
  firstSeenAt: string
  device: DeviceRef | null
}

export type UpnpEvent = {
  id: number
  event: 'opened' | 'closed'
  proto: string
  externalPort: number
  internalIp: string
  internalPort: number
  description: string | null
  at: string
  device: DeviceRef | null
}

type MappingRow = {
  collectorId: number
  proto: string
  extPort: number
  intIp: string
  intPort: number
  mac: string | null
  description: string | null
  expiresAt: string | null
  firstSeenAt: string
}

async function hostNames(macs: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(macs)]
  if (unique.length === 0) return new Map()
  const rows = rawRows<{ mac: string; staticName: string | null; hostname: string | null }>(
    await db.rawQuery(
      `SELECT mac, static_name AS staticName, hostname FROM gateway_hosts
        WHERE mac IN (${unique.map(() => '?').join(',')})`,
      unique
    )
  )
  const out = new Map<string, string | null>()
  for (const row of rows) {
    const name = row.staticName ?? row.hostname
    if (name || !out.has(row.mac)) out.set(row.mac.toLowerCase(), name)
  }
  return out
}

function mappingOf(row: MappingRow, devices: Map<string, DeviceRef>): UpnpMapping {
  return {
    proto: row.proto,
    externalPort: Number(row.extPort),
    internalIp: row.intIp,
    internalPort: Number(row.intPort),
    description: row.description,
    expiresAt: row.expiresAt,
    firstSeenAt: row.firstSeenAt,
    device: row.mac ? (devices.get(row.mac.toLowerCase()) ?? { mac: row.mac, name: null }) : null,
  }
}

const MAPPING_COLUMNS = `
  collector_id AS collectorId, proto, ext_port AS extPort, int_ip AS intIp, int_port AS intPort,
  mac, description, DATE_FORMAT(expires_at, ${ISO}) AS expiresAt,
  DATE_FORMAT(first_seen_at, ${ISO}) AS firstSeenAt`

/** GET /gateways/:gatewayId/upnp */
export async function readUpnp(collectorId: number, eventLimit = 200) {
  const part = await readPart(collectorId, 'upnp')
  const mappings = rawRows<MappingRow>(
    await db.rawQuery(
      `SELECT ${MAPPING_COLUMNS} FROM gateway_upnp_mappings
        WHERE collector_id = ? ORDER BY proto, ext_port`,
      [collectorId]
    )
  )
  const events = rawRows<{
    id: number
    event: 'opened' | 'closed'
    proto: string
    extPort: number
    intIp: string
    intPort: number
    mac: string | null
    description: string | null
    at: string
  }>(
    await db.rawQuery(
      `SELECT id, event, proto, ext_port AS extPort, int_ip AS intIp, int_port AS intPort, mac,
              description, DATE_FORMAT(at, ${ISO}) AS at
         FROM gateway_upnp_events WHERE collector_id = ?
        ORDER BY at DESC, id DESC LIMIT ?`,
      [collectorId, eventLimit]
    )
  )
  const macs = [...mappings, ...events].map((m) => m.mac).filter((m): m is string => m !== null)
  const devices = await deviceRefs(macs, await hostNames(macs))
  const payload = part?.payload ?? {}
  return {
    observedAt: part?.observedAt ?? null,
    stale: part ? part.stale : true,
    installed: part ? payload.installed !== false : null,
    enabled: typeof payload.enabled === 'boolean' ? payload.enabled : null,
    running: typeof payload.running === 'boolean' ? payload.running : null,
    mappings: mappings.map((row) => mappingOf(row, devices)),
    events: events.map(
      (row): UpnpEvent => ({
        id: Number(row.id),
        event: row.event,
        proto: row.proto,
        externalPort: Number(row.extPort),
        internalIp: row.intIp,
        internalPort: Number(row.intPort),
        description: row.description,
        at: row.at,
        device: row.mac
          ? (devices.get(row.mac.toLowerCase()) ?? { mac: row.mac, name: null })
          : null,
      })
    ),
  }
}

// ── WAN status ─────────────────────────────────────────────────────────────

export type WanInterface = {
  network: string
  ifname: string | null
  up: boolean
  proto: string | null
  ipv4: string[]
  ipv6: string[]
  metric: number | null
  uptimeSeconds: number | null
  defaultRoute: boolean | null
  gateway4: string | null
  gateway6: string | null
  dnsServers: string[]
  error: string | null
  /** mwan3's view of it when mwan3 reports (running), else null. */
  mwan3Status: string | null
}

/**
 * GET /gateways/:gatewayId/wan-status. mwan3's config/service state and its
 * live status are separate (the live gateway has mwan3 configured but the
 * service disabled; failover there is two default routes with metrics).
 */
export async function readWanStatus(collector: Collector) {
  const parts = await readParts(collector.id, ['interfaces', 'mwan3'])
  const interfaces = interfacesOf(parts.get('interfaces')) ?? []
  const mwan3Part = parts.get('mwan3')
  const mwan3: Mwan3Observation | null = mwan3Part?.payload
    ? normalizeMwan3(mwan3Part.payload)
    : null
  const gatewayWans = collector.lastStatus?.gateway?.wanInterfaces ?? []
  const mwan3Names = new Set(mwan3?.interfaces.map((i) => i.name) ?? [])

  const withRoute = interfaces
    .filter((i) => i.defaultRoute === true)
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))
  // Devices carrying a default route, lowest metric first; the gateway
  // report's WAN list when the interfaces report does not say.
  const defaultRoutes =
    withRoute.length > 0
      ? withRoute.map((i) => i.device ?? i.network)
      : collector.lastStatus?.gateway?.wanSource === 'default-route'
        ? [...gatewayWans]
        : []

  const wans = interfaces
    .filter(
      (i) =>
        i.defaultRoute === true ||
        mwan3Names.has(i.network) ||
        (i.device !== null && gatewayWans.includes(i.device))
    )
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))
    .map(
      (i): WanInterface => ({
        network: i.network,
        ifname: i.device,
        up: i.up,
        proto: i.proto,
        ipv4: i.ipv4,
        ipv6: i.ipv6,
        metric: i.metric,
        uptimeSeconds: i.uptimeSeconds,
        defaultRoute: i.defaultRoute,
        gateway4: i.gateway4,
        gateway6: i.gateway6,
        dnsServers: i.dnsServers,
        error: i.error,
        mwan3Status: mwan3?.interfaces.find((m) => m.name === i.network)?.status ?? null,
      })
    )

  const observedAt = latest(
    parts.get('interfaces')?.observedAt ?? null,
    mwan3Part?.observedAt ?? null
  )
  return {
    observedAt,
    mwan3: mwan3 ? { ...mwan3, observedAt: mwan3Part!.observedAt } : null,
    defaultRoutes,
    wans,
  }
}

// ── interfaces, system, WireGuard ──────────────────────────────────────────

/** GET /gateways/:gatewayId/interfaces */
export async function readInterfaces(collectorId: number) {
  const part = await readPart(collectorId, 'interfaces')
  return {
    observedAt: part?.observedAt ?? null,
    stale: part ? part.stale : true,
    interfaces: interfacesOf(part) ?? [],
  }
}

/**
 * Native features the Gateway page lists, with plan-2 section 4.5's decision
 * for each: which package names reveal them.
 */
const FEATURES: { name: string; decision: string; packages: RegExp }[] = [
  { name: 'upnp', decision: 'observe', packages: /^miniupnpd/ },
  { name: 'mwan3', decision: 'observe', packages: /^mwan3$/ },
  { name: 'pbr', decision: 'observe', packages: /^pbr$/ },
  { name: 'sqm', decision: 'manage', packages: /^sqm-scripts$/ },
  { name: 'opennds', decision: 'manage', packages: /^opennds$/ },
  { name: 'wireguard', decision: 'observe', packages: /^(wireguard-tools|kmod-wireguard)$/ },
  { name: 'ddns', decision: 'observe', packages: /^ddns-scripts$/ },
  { name: 'adguardhome', decision: 'never', packages: /^adguardhome$/ },
  { name: 'adblock', decision: 'never', packages: /^adblock$/ },
  { name: 'banip', decision: 'never', packages: /^banip$/ },
  { name: 'unbound', decision: 'never', packages: /^unbound-daemon/ },
  { name: 'nlbwmon', decision: 'observe', packages: /^nlbwmon$/ },
  { name: 'vnstat', decision: 'observe', packages: /^vnstat2?$/ },
  { name: 'natmap', decision: 'later', packages: /^natmap$/ },
  { name: 'luci', decision: 'never', packages: /^luci-base$/ },
]

/** GET /gateways/:gatewayId/system (plan-2 section 5, read part). */
export async function readSystem(collectorId: number) {
  const parts = await readParts(collectorId, [
    'system',
    'resolver',
    'packages',
    'upnp',
    'mwan3',
    'wireguard',
  ])
  const system: SystemObservation | null = parts.get('system')?.payload
    ? normalizeSystem(parts.get('system')!.payload)
    : null
  const resolver: ResolverObservation | null = parts.get('resolver')?.payload
    ? normalizeResolver(parts.get('resolver')!.payload)
    : null
  const packages: PackagesObservation | null = parts.get('packages')?.payload
    ? normalizePackages(parts.get('packages')!.payload)
    : null
  const mwan3 = parts.get('mwan3')?.payload ? normalizeMwan3(parts.get('mwan3')!.payload) : null
  const upnp = parts.get('upnp')?.payload ?? null
  const wireguard = parts.get('wireguard')?.payload
    ? normalizeWireguard(parts.get('wireguard')!.payload)
    : null

  const installedNames = packages ? packages.installed.map((p) => p.name) : null
  const features = FEATURES.map((feature) => {
    let installed: boolean | null = installedNames
      ? installedNames.some((n) => feature.packages.test(n))
      : null
    // What the other parts reveal without a package list.
    if (feature.name === 'upnp' && upnp && isObject(upnp)) installed = upnp.installed !== false
    if (feature.name === 'mwan3' && mwan3?.service?.installed !== undefined) {
      installed = mwan3.service?.installed ?? installed
    }
    if (feature.name === 'wireguard' && wireguard && wireguard.interfaces.length > 0) {
      installed = true
    }
    if (
      feature.name === 'adguardhome' &&
      resolver?.port53Process &&
      /adguard/i.test(resolver.port53Process)
    ) {
      installed = true
    }
    return { name: feature.name, installed, decision: feature.decision }
  })

  return {
    observedAt: parts.get('system')?.observedAt ?? null,
    hostname: system?.hostname ?? null,
    // Config plane (plan 1): the router's `system` config. Not observed here.
    timezone: null,
    zonename: null,
    ntp: null,
    board: system?.board ?? null,
    model: system?.model ?? null,
    boardName: system?.boardName ?? null,
    release: system?.release ?? null,
    version: system?.version ?? null,
    revision: system?.revision ?? null,
    kernel: system?.kernel ?? null,
    uptimeSeconds: system?.uptimeSeconds ?? null,
    flowOffloading: system?.flowOffloading ?? null,
    flowOffloadingHw: system?.flowOffloadingHw ?? null,
    resolver,
    packageManager: packages?.manager ?? null,
    packages: packages?.installed ?? null,
    upgradable: packages?.upgradable ?? null,
    features,
  }
}

/** GET /gateways/:gatewayId/wireguard (admin): public keys and peer state only. */
export async function readWireguard(collectorId: number) {
  const part = await readPart(collectorId, 'wireguard')
  const value: WireguardObservation | null = part?.payload ? normalizeWireguard(part.payload) : null
  return {
    observedAt: part?.observedAt ?? null,
    stale: part ? part.stale : true,
    interfaces: value?.interfaces ?? [],
  }
}

/** ddns-scripts' observed state (gateway sync protocol.md 6.1), null when never reported. */
export async function readDdns(collectorId: number) {
  const part = await readPart(collectorId, 'ddns')
  const value: DdnsObservation | null = part?.payload ? normalizeDdns(part.payload) : null
  return {
    observedAt: part?.observedAt ?? null,
    stale: part ? part.stale : true,
    value,
  }
}

// ── overview ───────────────────────────────────────────────────────────────

/** GET /gateways/:gatewayId/observation (`gatewayId` = `gateways.id`). */
export async function readObservationOverview(collector: Collector, gatewayId: number) {
  const parts = await readParts(collector.id)
  const session = collectorHub.session(collector.id)
  const system = parts.get('system')?.payload ? normalizeSystem(parts.get('system')!.payload) : null
  const counts = (kind: string) => {
    const payload = parts.get(kind)?.payload
    if (!payload) return null
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  }
  return {
    gatewayId,
    collectorId: collector.id,
    name: collector.name,
    online: session !== null,
    secure: session?.secure ?? null,
    transport: collector.transport,
    capabilities: sessionCapabilities(collector.id),
    hostname: system?.hostname ?? null,
    release: system?.release ?? null,
    flowOffloadingHw: system?.flowOffloadingHw ?? null,
    parts: Object.fromEntries(
      [...parts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([kind, info]) => [
          kind,
          {
            observedAt: info.observedAt,
            changedAt: info.changedAt,
            secondsSinceReport: info.secondsSinceReport,
            stale: info.stale,
            counts: ['dhcp', 'neighbors', 'upnp'].includes(kind) ? counts(kind) : null,
          },
        ])
    ),
  }
}

// ── one device ─────────────────────────────────────────────────────────────

/**
 * GET /devices/:mac/network: what the gateway knows of one device. The
 * gateway is the adopted collector that listed the MAC most recently;
 * `gatewayId` is its `gateways.id` (null without a gateway row).
 * `reservation` and `dnsName` belong to the config plane and read null
 * here (the device page's Reservation card reads them). `wanBlocked` is the
 * firewall's per-device WAN block (`deviceWanBlock`, docs/gateway/firewall.md
 * section 5) on a gateway the config plane observes or manages; null in mode
 * `off` or without a gateway row.
 */
export async function readDeviceNetwork(mac: string) {
  const rows = rawRows<HostRow>(
    await db.rawQuery(
      `SELECT ${HOST_COLUMNS.replace(/\n/g, ' ')}
         FROM gateway_hosts h
        WHERE h.mac = ?
          AND EXISTS (SELECT 1 FROM collectors c
                       WHERE c.id = h.collector_id AND c.lifecycle = 'adopted')
        ORDER BY (dhcp_present OR neighbor_present) DESC, last_reported_at DESC
        LIMIT 1`,
      [mac]
    )
  )
  const row = rows[0]
  if (!row) {
    return {
      gatewayId: null,
      collectorId: null,
      lease: null,
      reservation: null,
      dnsName: null,
      wanBlocked: null as WanAccessView | null,
      neighbor: null,
      network: null,
      seenAt: null,
      upnp: [] as UpnpMapping[],
    }
  }
  const devices = await deviceRefs([row.mac], routerNamesOf([row]))
  const device = devices.get(row.mac.toLowerCase()) ?? null
  const mappings = rawRows<MappingRow>(
    await db.rawQuery(
      `SELECT ${MAPPING_COLUMNS} FROM gateway_upnp_mappings
        WHERE collector_id = ? AND mac = ? ORDER BY proto, ext_port`,
      [row.collectorId, mac]
    )
  )
  const lease = truthy(row.dhcpPresent)
    ? (leasesOf(row, device).find((l) => l.family === 4) ?? null)
    : null
  const gateway = await gatewayForCollector(Number(row.collectorId))
  const wanBlocked =
    gateway && normalizeMode(gateway.mode) !== 'off' ? await deviceWanBlock(gateway, mac) : null
  return {
    gatewayId: gateway?.id ?? null,
    collectorId: Number(row.collectorId),
    lease,
    reservation: null,
    dnsName: null,
    wanBlocked,
    neighbor: truthy(row.neighborPresent)
      ? {
          ipv4: row.neighborIpv4,
          ipv6: parseJsonArray(row.neighborIpv6),
          ifname: row.neighborDevice,
          reachable: truthy(row.neighborReachable),
          seenAt: row.neighborSeenAt,
        }
      : null,
    network: row.network,
    seenAt: latest(row.dhcpSeenAt, row.neighborSeenAt),
    upnp: mappings.map((m) => mappingOf(m, devices)),
  }
}
