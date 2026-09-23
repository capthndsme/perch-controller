import { INFRA_LINK_MEDIA, type InfraLinkMedium } from '#models/infra_link'
import { INFRA_NODE_KINDS, type InfraNodeKind } from '#models/infra_node'
import {
  INFRA_PORT_MEDIA,
  INFRA_PORT_ROLES,
  type InfraPortMedium,
  type InfraPortOrigin,
  type InfraPortRole,
} from '#models/infra_port'
import apHub from '#services/ap_agent_hub'
import { collectorStaleSeconds } from '#services/collector_agent'
import collectorHub from '#services/collector_agent_hub'
import { isDuplicateEntryError } from '#services/db_errors'
import { getDeviceLabels, normalizeMac, type DeviceLabel } from '#services/device_labels'
import { queryDevicePresences } from '#services/device_presence_query'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { ensureNodeFor, forgetAgentPorts, type PortBinding } from '#services/infra_ports'
import { getPresenceSettings } from '#services/presence_settings'
import { gatewaySource } from '#services/router_metrics'
import {
  apStaleSeconds,
  type DeviceOnMap,
  type DevicePresence,
  type PresenceThresholds,
} from '#services/wifi_presence'
import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The infrastructure view's topology (docs/infrastructure-view.md sections 6
 * and 7): nodes, ports and cables as the operator draws them, the nodes the
 * agents bring along, and the live state derived from the agents' reports.
 *
 * Everything is read from the database per request, no query cache: the
 * layout is small, and freshness comes from the in-process agent hubs. Times
 * are stored as UTC wall times, turned into ISO strings by the database, and
 * ages are computed against `UTC_TIMESTAMP()`, so nothing depends on the
 * process zone.
 */

// ── limits and the kinds catalog ─────────────────────────────────────────

/** Guard rails (section 6.5). */
export const INFRA_LIMITS = { nodes: 200, portsPerNode: 64, links: 400 } as const
export const MAX_SFP_PORTS = 8
export const MAX_POSITION = 100_000
export const FRAME_SIZE = { min: 120, max: 4000 } as const

/** Kinds that may stand for a Linux bridge, a vSwitch or a VM (`virtual`). */
const VIRTUAL_KINDS = new Set<InfraNodeKind>(['switch', 'host'])

/**
 * Kinds a node may carry a device from Perch's device list on (`deviceMac`,
 * amendment A4 item 1): every manual kind but the ISP's line. Never on a node
 * bound to an agent row: that node stands for the agent.
 */
const DEVICE_KINDS = new Set<InfraNodeKind>([
  'device',
  'switch',
  'router',
  'modem',
  'host',
  'access_point',
])

/** The unique index behind "one node per device" (migration 1779000000045). */
const DEVICE_MAC_INDEX = 'infra_nodes_device_mac_unique_idx'

type KindSpec = {
  label: string
  /** The operator may create it (every kind but the Gateway agent's). */
  manual: boolean
  /** Other nodes may sit inside it (a host frame). */
  container: boolean
  /** `portCount` on create: default and accepted range. */
  ports: { default: number; min: number; max: number }
  /** `sfpPorts` is accepted on create (SFP cages next to the numbered ports). */
  supportsSfp: boolean
}

const KINDS: Record<InfraNodeKind, KindSpec> = {
  gateway: {
    label: 'Gateway',
    manual: false,
    container: false,
    ports: { default: 0, min: 0, max: 64 },
    supportsSfp: false,
  },
  access_point: {
    label: 'Access point',
    manual: true,
    container: false,
    ports: { default: 2, min: 0, max: 64 },
    supportsSfp: false,
  },
  switch: {
    label: 'Switch',
    manual: true,
    container: false,
    ports: { default: 8, min: 1, max: 64 },
    supportsSfp: true,
  },
  router: {
    label: 'Router',
    manual: true,
    container: false,
    ports: { default: 5, min: 1, max: 64 },
    supportsSfp: false,
  },
  modem: {
    label: 'Modem / ONT',
    manual: true,
    container: false,
    ports: { default: 2, min: 1, max: 64 },
    supportsSfp: false,
  },
  isp: {
    label: 'ISP uplink',
    manual: true,
    container: false,
    ports: { default: 1, min: 1, max: 1 },
    supportsSfp: false,
  },
  host: {
    label: 'Host / hypervisor',
    manual: true,
    container: true,
    ports: { default: 0, min: 0, max: 64 },
    supportsSfp: true,
  },
  device: {
    label: 'Device',
    manual: true,
    container: false,
    ports: { default: 1, min: 0, max: 64 },
    supportsSfp: false,
  },
}

/** `GET /infra/layout` `kinds`: the dashboard builds its "Add device" menu from it. */
export function kindCatalog() {
  return INFRA_NODE_KINDS.map((kind) => ({
    kind,
    label: KINDS[kind].label,
    manual: KINDS[kind].manual,
    container: KINDS[kind].container,
    ports: { ...KINDS[kind].ports },
    supportsSfp: KINDS[kind].supportsSfp,
  }))
}

// ── API shapes (section 7.1) ──────────────────────────────────────────────

export type InfraBinding = {
  type: 'collector' | 'ap'
  id: number
  name: string
  transport: 'agent' | 'poll' | 'scrape'
  version: string | null
  /** true = it reports ports, false = it cannot, null = unknown (old collector). */
  portsSupported: boolean | null
}

export type InfraPortView = {
  id: number
  nodeId: number
  key: string
  origin: InfraPortOrigin
  label: string
  labelOverride: string | null
  role: InfraPortRole | null
  roleOverride: InfraPortRole | null
  medium: InfraPortMedium | null
  mac: string | null
  position: number
  hidden: boolean
  present: boolean
  missingSince: string | null
  linkId: number | null
}

export type InfraNodeView = {
  id: number
  kind: InfraNodeKind
  name: string
  nameOverride: string | null
  source: 'agent' | 'manual'
  binding: InfraBinding | null
  detached: boolean
  virtual: boolean
  model: string | null
  notes: string | null
  device: {
    mac: string
    name: string | null
    deviceType: string | null
    connection: 'ethernet' | null
    /** From the DHCP leases / static hosts, by MAC alone (as `/wifi/clients`). */
    hostname: string | null
    /** Of its most recently seen identity that has one, across collectors. */
    primaryIp: string | null
  } | null
  parentId: number | null
  position: { x: number; y: number } | null
  size: { width: number; height: number } | null
  hidden: boolean
  isRoot: boolean
  ports: InfraPortView[]
  createdAt: string
  updatedAt: string | null
}

/**
 * Where a device is on the map (amendment A4 item 5): the node that carries
 * its MAC, and the cable on that node's port with the lowest position.
 */
export type DeviceAttachment = {
  nodeId: number
  /** Resolved like `InfraNodeView.name`. */
  nodeName: string
  /** Null when none of the node's ports is cabled. */
  uplink: {
    linkId: number
    medium: InfraLinkMedium
    /** The far end of the cable. */
    nodeId: number
    nodeName: string
    nodeKind: InfraNodeKind
    portId: number
    portKey: string
    portLabel: string
    /** The far port is a live agent port (section 7.3 rules). */
    live: boolean
    /** Its link, when live. */
    up: boolean | null
    speedMbps: number | null
    duplex: 'full' | 'half' | null
  } | null
}

/** A device's attachment, and what the presence rule reads from it. */
export type DevicePlacement = { attachment: DeviceAttachment; onMap: DeviceOnMap }

export type InfraLinkView = {
  id: number
  medium: InfraLinkMedium
  label: string | null
  notes: string | null
  a: { nodeId: number; portId: number }
  b: { nodeId: number; portId: number }
}

export type InfraNodeStatus = 'online' | 'stale' | 'offline' | 'unmanaged' | 'detached'

export type InfraNodeState = {
  id: number
  status: InfraNodeStatus
  live: boolean
  lastSeenAt: string | null
  version: string | null
  presence: DevicePresence | null
}

export type InfraPortState = {
  id: number
  nodeId: number
  present: boolean
  live: boolean
  up: boolean | null
  adminUp: boolean | null
  operstate: string | null
  speedMbps: number | null
  duplex: string | null
  carrierChanges: number | null
  changedAt: string | null
  /** Manual ports: the link whose far end the state was taken from. */
  derivedFrom: number | null
}

export type InfraLinkState = {
  id: number
  state: 'up' | 'down' | 'unknown' | 'mismatch'
  speedMbps: number | null
  detail: 'carrier' | 'speed' | null
}

// ── errors ────────────────────────────────────────────────────────────────

/**
 * A refusal with its HTTP status and body (Appendix B). The controller sends
 * it as is; Vine-shaped field errors (`{ errors: [...] }`) use the same class.
 */
export class InfraError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.message === 'string' ? body.message : 'infrastructure request refused')
  }
}

function refuse(
  status: 404 | 409 | 422,
  error: string,
  message: string,
  extra: Record<string, unknown> = {}
): InfraError {
  return new InfraError(status, { error, message, ...extra })
}

function nodeNotFound(id: number): InfraError {
  return refuse(404, 'infra_node_not_found', `There is no node ${id}.`, { nodeId: id })
}

function portNotFound(id: number): InfraError {
  return refuse(404, 'infra_port_not_found', `There is no port ${id}.`, { portId: id })
}

function linkNotFound(id: number): InfraError {
  return refuse(404, 'infra_link_not_found', `There is no cable ${id}.`, { linkId: id })
}

function notApplicable(field: string, kind: string): InfraError {
  return refuse(
    422,
    'infra_field_not_applicable',
    `A ${KINDS[kind as InfraNodeKind]?.label ?? kind} node has no \`${field}\`.`,
    { field }
  )
}

function limitReached(what: 'nodes' | 'ports' | 'links', message: string): InfraError {
  const limit = what === 'ports' ? INFRA_LIMITS.portsPerNode : INFRA_LIMITS[what]
  return refuse(422, 'infra_limit_reached', message, { limit: what, max: limit })
}

/** Same body as a Vine validation failure, for ranges that depend on the kind. */
function fieldError(field: string, message: string, rule: string): InfraError {
  return new InfraError(422, { errors: [{ field, message, rule }] })
}

/** One node per device (amendment A4 item 2): `nodeId` already carries the MAC. */
function deviceAlreadyPlaced(mac: string, nodeId: number): InfraError {
  return refuse(
    409,
    'infra_device_already_placed',
    `Device ${mac} is already on the map (node ${nodeId}).`,
    { nodeId }
  )
}

// ── rows ──────────────────────────────────────────────────────────────────

type Client = QueryClientContract

/** A UTC wall-time column as an ISO string, formatted by the database. */
function isoColumn(column: string, alias: string): string {
  return `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.000Z') AS ${alias}`
}

function sqlNow(): string {
  return DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
}

function bool(value: unknown): boolean {
  return Boolean(Number(value))
}

function nullableBool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(Number(value))
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

type NodeRow = {
  id: number
  kind: InfraNodeKind
  origin: string
  name: string | null
  collectorId: number | null
  apId: number | null
  deviceMac: string | null
  parentId: number | null
  virtual: number | boolean
  model: string | null
  notes: string | null
  posX: number | null
  posY: number | null
  width: number | null
  height: number | null
  hidden: number | boolean
  createdAt: string
  updatedAt: string | null
}

type PortRow = {
  id: number
  nodeId: number
  key: string
  origin: string
  label: string | null
  reportedLabel: string | null
  role: string | null
  reportedRole: string | null
  medium: string | null
  reportedMedium: string | null
  mac: string | null
  position: number
  hidden: number | boolean
  present: number | boolean
  missingSince: string | null
  adminUp: number | boolean | null
  carrier: number | boolean | null
  operstate: string | null
  speedMbps: number | null
  duplex: string | null
  carrierChanges: number | null
  stateChangedAt: string | null
  /** Seconds since `state_changed_at`, computed by the database. */
  stateChangedAgo: number | string | null
}

type LinkRow = {
  id: number
  aPortId: number
  bPortId: number
  medium: string
  label: string | null
  notes: string | null
}

function rows<T>(result: unknown): T[] {
  return ((Array.isArray(result) ? result[0] : result) ?? []) as T[]
}

async function selectNodes(
  client: Client,
  filter: { ids?: number[]; deviceMacs?: string[] } = {}
): Promise<NodeRow[]> {
  if (filter.ids?.length === 0 || filter.deviceMacs?.length === 0) return []
  const query = client
    .from('infra_nodes')
    .select(
      'id',
      'kind',
      'origin',
      'name',
      'collector_id as collectorId',
      'ap_id as apId',
      'device_mac as deviceMac',
      'parent_id as parentId',
      'virtual',
      'model',
      'notes',
      'pos_x as posX',
      'pos_y as posY',
      'width',
      'height',
      'hidden',
      client.raw(isoColumn('created_at', 'createdAt')),
      client.raw(isoColumn('updated_at', 'updatedAt'))
    )
    .orderBy('id', 'asc')
  if (filter.ids) query.whereIn('id', filter.ids)
  // Bound parameters, compared in the column's collation (case-insensitive).
  if (filter.deviceMacs) query.whereIn('device_mac', filter.deviceMacs)
  return (await query) as NodeRow[]
}

async function selectPorts(
  client: Client,
  filter: { nodeIds?: number[]; portIds?: number[] } = {}
): Promise<PortRow[]> {
  if (filter.nodeIds?.length === 0 || filter.portIds?.length === 0) return []
  const query = client
    .from('infra_ports')
    .select(
      'id',
      'node_id as nodeId',
      'port_key as key',
      'origin',
      'label',
      'reported_label as reportedLabel',
      'role',
      'reported_role as reportedRole',
      'medium',
      'reported_medium as reportedMedium',
      'mac',
      'position',
      'hidden',
      'present',
      client.raw(isoColumn('missing_since', 'missingSince')),
      'admin_up as adminUp',
      'carrier',
      'operstate',
      'speed_mbps as speedMbps',
      'duplex',
      'carrier_changes as carrierChanges',
      client.raw(isoColumn('state_changed_at', 'stateChangedAt')),
      client.raw('TIMESTAMPDIFF(SECOND, state_changed_at, UTC_TIMESTAMP()) AS stateChangedAgo')
    )
    .orderBy('node_id', 'asc')
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')
  if (filter.nodeIds) query.whereIn('node_id', filter.nodeIds)
  if (filter.portIds) query.whereIn('id', filter.portIds)
  return (await query) as PortRow[]
}

async function selectLinks(
  client: Client,
  filter: { portIds?: number[]; ids?: number[] } = {}
): Promise<LinkRow[]> {
  if (filter.portIds?.length === 0 || filter.ids?.length === 0) return []
  const query = client
    .from('infra_links')
    .select('id', 'a_port_id as aPortId', 'b_port_id as bPortId', 'medium', 'label', 'notes')
    .orderBy('id', 'asc')
  if (filter.portIds) {
    const portIds = filter.portIds
    query.where((q) => q.whereIn('a_port_id', portIds).orWhereIn('b_port_id', portIds))
  }
  if (filter.ids) query.whereIn('id', filter.ids)
  return (await query) as LinkRow[]
}

// ── the agent rows behind bound nodes ─────────────────────────────────────

type AgentRow = {
  type: PortBinding['type']
  id: number
  name: string
  transport: InfraBinding['transport']
  version: string | null
  portsSupported: boolean | null
  pollIntervalSeconds: number
  /** `last_status.ok` of the row (polled and scraped rows). */
  statusOk: boolean
  /** Seconds since the last accepted report, computed by the database. */
  lastSeenAgoSeconds: number | null
  lastSeenAt: string | null
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function agentKey(type: PortBinding['type'], id: number): string {
  return `${type}:${id}`
}

/**
 * Whether an AP's agent reports ports: its `system.info` lists the `ports`
 * capability (perch-apd builds with the feature, on a device with ports).
 * Scraped rows cannot; an agent that has not answered `system.info` yet is
 * unknown.
 */
function apPortsSupported(transport: string, agentInfo: Record<string, unknown> | null) {
  if (transport !== 'agent') return false
  const capabilities = agentInfo?.capabilities
  if (!Array.isArray(capabilities) || capabilities.length === 0) return null
  return capabilities.includes('ports')
}

/**
 * Every AP and collector row, keyed `ap:<id>` / `collector:<id>`: a home
 * network has a handful, and the layout and the state need them all.
 */
async function loadAgents(client: Client): Promise<Map<string, AgentRow>> {
  const lastSeenColumns = [
    client.raw('TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP()) AS lastSeenAgo'),
    client.raw(isoColumn('last_seen_at', 'lastSeenAt')),
  ]
  const [aps, collectors] = await Promise.all([
    client
      .from('wifi_access_points')
      .select(
        'id',
        'name',
        'friendly_name as friendlyName',
        'transport',
        'poll_interval_seconds as pollIntervalSeconds',
        'agent_version as agentVersion',
        'agent_info as agentInfo',
        'last_status as lastStatus',
        ...lastSeenColumns
      ),
    client
      .from('collectors')
      .select(
        'id',
        'name',
        'transport',
        'poll_interval_seconds as pollIntervalSeconds',
        'version',
        'last_status as lastStatus',
        ...lastSeenColumns
      ),
  ])

  const agents = new Map<string, AgentRow>()
  for (const ap of aps as Array<Record<string, unknown>>) {
    const transport = ap.transport === 'agent' ? 'agent' : 'scrape'
    const status = parseJson(ap.lastStatus)
    agents.set(agentKey('ap', Number(ap.id)), {
      type: 'ap',
      id: Number(ap.id),
      name: String(ap.friendlyName ?? ap.name),
      transport,
      version: transport === 'agent' ? ((ap.agentVersion as string | null) ?? null) : null,
      portsSupported: apPortsSupported(transport, parseJson(ap.agentInfo)),
      pollIntervalSeconds: Number(ap.pollIntervalSeconds),
      statusOk: status?.ok === true,
      lastSeenAgoSeconds: nullableNumber(ap.lastSeenAgo),
      lastSeenAt: (ap.lastSeenAt as string | null) ?? null,
    })
  }
  for (const collector of collectors as Array<Record<string, unknown>>) {
    const status = parseJson(collector.lastStatus)
    const gateway = status?.gateway as { portsReported?: unknown } | undefined
    agents.set(agentKey('collector', Number(collector.id)), {
      type: 'collector',
      id: Number(collector.id),
      name: String(collector.name),
      transport: collector.transport === 'agent' ? 'agent' : 'poll',
      version: (collector.version as string | null) ?? null,
      // The gateway report of a collector older than the feature has no
      // `ports`: unknown, not "cannot" (section 4.3).
      portsSupported: gateway?.portsReported === true ? true : null,
      pollIntervalSeconds: Number(collector.pollIntervalSeconds),
      statusOk: status?.ok === true,
      lastSeenAgoSeconds: nullableNumber(collector.lastSeenAgo),
      lastSeenAt: (collector.lastSeenAt as string | null) ?? null,
    })
  }
  return agents
}

function agentOf(
  node: Pick<NodeRow, 'apId' | 'collectorId'>,
  agents: Map<string, AgentRow>
): AgentRow | null {
  if (node.apId !== null) return agents.get(agentKey('ap', Number(node.apId))) ?? null
  if (node.collectorId !== null) {
    return agents.get(agentKey('collector', Number(node.collectorId))) ?? null
  }
  return null
}

function bindingOf(node: { apId: number | null; collectorId: number | null }): PortBinding | null {
  if (node.apId !== null) return { type: 'ap', id: Number(node.apId) }
  if (node.collectorId !== null) return { type: 'collector', id: Number(node.collectorId) }
  return null
}

// ── agent nodes ───────────────────────────────────────────────────────────

/**
 * One `access_point` node per Wi-Fi source (enabled or not, scraped or
 * agent) and one `gateway` node per adopted collector that reports gateway
 * stats (section 6.3), created unplaced and unnamed. Idempotent; concurrent
 * runs settle on the unique indexes. Returns how many it created.
 */
export async function ensureAgentNodes(): Promise<number> {
  const [aps, collectors, bound] = await Promise.all([
    db.from('wifi_access_points').select('id'),
    db.from('collectors').where('lifecycle', 'adopted').select('id', 'last_status'),
    db
      .from('infra_nodes')
      .where((q) => q.whereNotNull('ap_id').orWhereNotNull('collector_id'))
      .select('ap_id', 'collector_id'),
  ])
  const boundAps = new Set(
    bound
      .map((row) => row.ap_id)
      .filter((id) => id !== null)
      .map(Number)
  )
  const boundCollectors = new Set(
    bound
      .map((row) => row.collector_id)
      .filter((id) => id !== null)
      .map(Number)
  )

  const missing: PortBinding[] = []
  for (const ap of aps) {
    if (!boundAps.has(Number(ap.id))) missing.push({ type: 'ap', id: Number(ap.id) })
  }
  for (const collector of collectors) {
    const gateway = parseJson(collector.last_status)?.gateway
    if (gateway && !boundCollectors.has(Number(collector.id))) {
      missing.push({ type: 'collector', id: Number(collector.id) })
    }
  }
  let created = 0
  for (const binding of missing) {
    if ((await ensureNodeFor(binding)) !== null) created += 1
  }
  return created
}

// ── names ─────────────────────────────────────────────────────────────────

/** What a node's display name is resolved from. */
type NameSources = {
  agents: Map<string, AgentRow>
  /** Device labels, keyed by lowercase MAC. */
  labels: Map<string, DeviceLabel>
  /** Hostnames by lowercase MAC. */
  hostnames: Map<string, string>
}

type NameFields = Pick<NodeRow, 'kind' | 'name' | 'apId' | 'collectorId' | 'deviceMac'>

/**
 * A node's display name (amendment A4 item 3), the first of: the operator's
 * name, the agent's (a rename in Settings follows through), and for a node
 * that carries a device, the device label's name, its hostname and its MAC;
 * then the kind. The layout, `DeviceAttachment.nodeName` and
 * `uplink.nodeName` all resolve it here.
 */
function nodeName(node: NameFields, sources: NameSources): string {
  const mac = node.deviceMac ? node.deviceMac.toLowerCase() : null
  const deviceName =
    mac === null ? null : (sources.labels.get(mac)?.name ?? sources.hostnames.get(mac) ?? mac)
  return (
    node.name ??
    agentOf(node, sources.agents)?.name ??
    deviceName ??
    KINDS[node.kind]?.label ??
    node.kind
  )
}

/** Hostnames by MAC alone, as `/wifi/clients` looks them up; keyed by lowercase MAC. */
async function hostnamesByMac(macs: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(macs.map((mac) => mac.toLowerCase()))]
  const out = new Map<string, string>()
  if (keys.length === 0) return out
  const matches = await getHostnameMatches(keys.map((mac) => ({ mac, primaryIp: null, ips: [] })))
  for (const [i, mac] of keys.entries()) {
    const hostname = matches[i]?.hostname
    if (hostname) out.set(mac, hostname)
  }
  return out
}

/**
 * Each device's primary IP: that of its most recently seen identity that has
 * one, whichever collector saw it; keyed by lowercase MAC. Matched in JS
 * (`device_identities.mac` has another collation than `infra_nodes`).
 */
async function primaryIpsByMac(client: Client, macs: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(macs.map((mac) => mac.toLowerCase()))]
  const out = new Map<string, string>()
  if (keys.length === 0) return out
  const found = (await client
    .from('device_identities')
    .whereIn('mac', keys)
    .whereNotNull('primary_ip')
    .select('mac', 'primary_ip as primaryIp')
    .orderBy('last_seen_at', 'desc')
    .orderBy('id', 'desc')) as Array<{ mac: string; primaryIp: string }>
  for (const row of found) {
    const mac = row.mac.toLowerCase()
    if (!out.has(mac)) out.set(mac, row.primaryIp)
  }
  return out
}

// ── views ─────────────────────────────────────────────────────────────────

type ViewContext = NameSources & {
  portsByNode: Map<number, PortRow[]>
  linkIdByPort: Map<number, number>
  primaryIps: Map<string, string>
  rootCollectorId: number | null
}

function toBinding(agent: AgentRow): InfraBinding {
  return {
    type: agent.type,
    id: agent.id,
    name: agent.name,
    transport: agent.transport,
    version: agent.version,
    portsSupported: agent.portsSupported,
  }
}

function toPortView(row: PortRow, linkId: number | null): InfraPortView {
  const role = oneOf(row.role, INFRA_PORT_ROLES)
  return {
    id: Number(row.id),
    nodeId: Number(row.nodeId),
    key: row.key,
    origin: row.origin === 'agent' ? 'agent' : 'manual',
    label: row.label ?? row.reportedLabel ?? row.key,
    labelOverride: row.label,
    role: role ?? oneOf(row.reportedRole, INFRA_PORT_ROLES),
    roleOverride: role,
    medium: oneOf(row.medium, INFRA_PORT_MEDIA) ?? oneOf(row.reportedMedium, INFRA_PORT_MEDIA),
    mac: row.mac,
    position: Number(row.position),
    hidden: bool(row.hidden),
    present: bool(row.present),
    missingSince: row.missingSince,
    linkId,
  }
}

function toNodeView(row: NodeRow, context: ViewContext): InfraNodeView {
  const agent = agentOf(row, context.agents)
  const binding = agent ? toBinding(agent) : null
  const source = row.origin === 'agent' ? 'agent' : 'manual'
  const mac = row.deviceMac ? row.deviceMac.toLowerCase() : null
  const label = mac ? context.labels.get(mac) : undefined
  const ports = (context.portsByNode.get(Number(row.id)) ?? []).map((port) =>
    toPortView(port, context.linkIdByPort.get(Number(port.id)) ?? null)
  )
  return {
    id: Number(row.id),
    kind: row.kind,
    name: nodeName(row, context),
    nameOverride: row.name,
    source,
    binding,
    detached: source === 'agent' && binding === null,
    virtual: bool(row.virtual),
    model: row.model,
    notes: row.notes,
    device:
      row.deviceMac && mac
        ? {
            mac: row.deviceMac,
            name: label?.name ?? null,
            deviceType: label?.deviceType ?? null,
            connection: label?.connection ?? null,
            hostname: context.hostnames.get(mac) ?? null,
            primaryIp: context.primaryIps.get(mac) ?? null,
          }
        : null,
    parentId: nullableNumber(row.parentId),
    position:
      row.posX !== null && row.posY !== null ? { x: Number(row.posX), y: Number(row.posY) } : null,
    size:
      row.width !== null && row.height !== null
        ? { width: Number(row.width), height: Number(row.height) }
        : null,
    hidden: bool(row.hidden),
    isRoot:
      row.collectorId !== null &&
      context.rootCollectorId !== null &&
      Number(row.collectorId) === context.rootCollectorId,
    ports,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toLinkView(row: LinkRow, nodeOfPort: Map<number, number>): InfraLinkView {
  const medium = oneOf(row.medium, INFRA_LINK_MEDIA) ?? 'ethernet'
  return {
    id: Number(row.id),
    medium,
    label: row.label,
    notes: row.notes,
    a: { nodeId: nodeOfPort.get(Number(row.aPortId)) ?? 0, portId: Number(row.aPortId) },
    b: { nodeId: nodeOfPort.get(Number(row.bPortId)) ?? 0, portId: Number(row.bPortId) },
  }
}

function groupPorts(ports: PortRow[]): Map<number, PortRow[]> {
  const byNode = new Map<number, PortRow[]>()
  for (const port of ports) {
    const nodeId = Number(port.nodeId)
    const list = byNode.get(nodeId)
    if (list) list.push(port)
    else byNode.set(nodeId, [port])
  }
  return byNode
}

function linkIndex(links: LinkRow[]): Map<number, number> {
  const byPort = new Map<number, number>()
  for (const link of links) {
    byPort.set(Number(link.aPortId), Number(link.id))
    byPort.set(Number(link.bPortId), Number(link.id))
  }
  return byPort
}

async function viewContext(
  client: Client,
  nodes: NodeRow[],
  ports: PortRow[],
  links: LinkRow[]
): Promise<ViewContext> {
  const macs = nodes.flatMap((node) => (node.deviceMac ? [node.deviceMac.toLowerCase()] : []))
  const [agents, labels, source, hostnames, primaryIps] = await Promise.all([
    loadAgents(client),
    getDeviceLabels(macs),
    gatewaySource(),
    hostnamesByMac(macs),
    primaryIpsByMac(client, macs),
  ])
  return {
    agents,
    portsByNode: groupPorts(ports),
    linkIdByPort: linkIndex(links),
    labels,
    hostnames,
    primaryIps,
    rootCollectorId: source?.collectorId ?? null,
  }
}

/** One node as the API returns it (after a write). */
export async function loadNodeView(id: number): Promise<InfraNodeView> {
  const client = db.connection()
  const [node] = await selectNodes(client, { ids: [id] })
  if (!node) throw nodeNotFound(id)
  const ports = await selectPorts(client, { nodeIds: [id] })
  const links = await selectLinks(client, { portIds: ports.map((port) => Number(port.id)) })
  return toNodeView(node, await viewContext(client, [node], ports, links))
}

async function loadPortViews(ids: number[]): Promise<InfraPortView[]> {
  const client = db.connection()
  const ports = await selectPorts(client, { portIds: ids })
  const linkIds = linkIndex(await selectLinks(client, { portIds: ids }))
  return ports.map((port) => toPortView(port, linkIds.get(Number(port.id)) ?? null))
}

async function loadLinkView(id: number): Promise<InfraLinkView> {
  const client = db.connection()
  const [link] = await selectLinks(client, { ids: [id] })
  if (!link) throw linkNotFound(id)
  const ports = await selectPorts(client, {
    portIds: [Number(link.aPortId), Number(link.bPortId)],
  })
  return toLinkView(link, new Map(ports.map((port) => [Number(port.id), Number(port.nodeId)])))
}

// ── GET /infra/layout ─────────────────────────────────────────────────────

export type InfraLayout = {
  generatedAt: string
  rootNodeId: number | null
  nodes: InfraNodeView[]
  links: InfraLinkView[]
  kinds: ReturnType<typeof kindCatalog>
  limits: typeof INFRA_LIMITS
}

export async function loadLayout(): Promise<InfraLayout> {
  await ensureAgentNodes()
  const client = db.connection()
  const [nodes, ports, links] = await Promise.all([
    selectNodes(client),
    selectPorts(client),
    selectLinks(client),
  ])
  const context = await viewContext(client, nodes, ports, links)
  const nodeOfPort = new Map(ports.map((port) => [Number(port.id), Number(port.nodeId)]))
  const root = nodes.find(
    (node) => node.collectorId !== null && Number(node.collectorId) === context.rootCollectorId
  )
  return {
    generatedAt: new Date().toISOString(),
    rootNodeId: root ? Number(root.id) : null,
    nodes: nodes.map((node) => toNodeView(node, context)),
    links: links.map((link) => toLinkView(link, nodeOfPort)),
    kinds: kindCatalog(),
    limits: INFRA_LIMITS,
  }
}

// ── GET /infra/state ──────────────────────────────────────────────────────

/**
 * Section 7.3. A node bound to a socket agent is online while its session is
 * open and its last accepted report is within its silence bound (APs: the
 * Settings → Presence bound, collectors: max(3 × interval, 30 s)), stale when
 * connected past it, offline otherwise. Polled and scraped rows are online
 * while their last poll succeeded and is within the same bound.
 */
function nodeStatus(
  node: Pick<NodeRow, 'apId' | 'collectorId' | 'origin'>,
  agent: AgentRow | null,
  thresholds: PresenceThresholds
): Omit<InfraNodeState, 'id' | 'presence'> {
  const bound = node.apId !== null || node.collectorId !== null
  if (!bound || !agent) {
    const status = node.origin === 'agent' || bound ? 'detached' : 'unmanaged'
    return { status, live: false, lastSeenAt: null, version: null }
  }
  const silenceSeconds =
    agent.type === 'ap'
      ? apStaleSeconds(thresholds, agent.pollIntervalSeconds)
      : collectorStaleSeconds(agent.pollIntervalSeconds)
  const fresh = agent.lastSeenAgoSeconds !== null && agent.lastSeenAgoSeconds < silenceSeconds
  let status: InfraNodeStatus
  if (agent.transport === 'agent') {
    const connected =
      agent.type === 'ap' ? apHub.isOnline(agent.id) : collectorHub.isOnline(agent.id)
    status = connected ? (fresh ? 'online' : 'stale') : 'offline'
  } else {
    status = agent.statusOk && fresh ? 'online' : 'offline'
  }
  return {
    status,
    live: status === 'online',
    lastSeenAt: agent.lastSeenAt,
    version: agent.version,
  }
}

/** A port's link state: `carrier`, else what `operstate` says, else unknown. */
function portUp(row: Pick<PortRow, 'carrier' | 'operstate'>): boolean | null {
  const carrier = nullableBool(row.carrier)
  if (carrier !== null) return carrier
  return row.operstate === null ? null : row.operstate === 'up'
}

/**
 * Section 7.3: an agent port's own state can be believed while its node is
 * online and its agent still reports it. The infrastructure view's port LEDs
 * and a device's uplink (`farEndOf`) both go by this.
 */
function agentPortLive(row: Pick<PortRow, 'origin' | 'present'>, nodeLive: boolean): boolean {
  return row.origin === 'agent' && bool(row.present) && nodeLive
}

type PortEnd = { row: PortRow; state: InfraPortState }

function isLiveAgentEnd(end: PortEnd | undefined): end is PortEnd {
  return (
    end !== undefined &&
    end.row.origin === 'agent' &&
    end.state.live &&
    end.state.derivedFrom === null &&
    end.state.up !== null
  )
}

/**
 * Section 7.3: the live agent ends decide. Two that disagree on carrier, or
 * are both up at different speeds, mean the cable is not between these two
 * ports: `mismatch`.
 */
function linkState(link: LinkRow, a: PortEnd | undefined, b: PortEnd | undefined): InfraLinkState {
  const ends = [a, b].filter(isLiveAgentEnd)
  const id = Number(link.id)
  if (ends.length === 0) return { id, state: 'unknown', speedMbps: null, detail: null }
  const speeds = ends
    .filter((end) => end.state.up)
    .map((end) => end.state.speedMbps)
    .filter((speed): speed is number => speed !== null)
  const speedMbps = speeds.length > 0 ? Math.min(...speeds) : null
  if (ends.length === 2 && ends[0].state.up !== ends[1].state.up) {
    return { id, state: 'mismatch', speedMbps, detail: 'carrier' }
  }
  if (ends.length === 2 && ends[0].state.up && speeds.length === 2 && speeds[0] !== speeds[1]) {
    return { id, state: 'mismatch', speedMbps, detail: 'speed' }
  }
  if (ends.some((end) => end.state.up)) return { id, state: 'up', speedMbps, detail: null }
  return { id, state: 'down', speedMbps: null, detail: null }
}

export type InfraState = {
  generatedAt: string
  nodes: InfraNodeState[]
  ports: InfraPortState[]
  links: InfraLinkState[]
}

export async function loadState(): Promise<InfraState> {
  const client = db.connection()
  const [nodes, ports, links, agents, thresholds] = await Promise.all([
    selectNodes(client),
    selectPorts(client),
    selectLinks(client),
    loadAgents(client),
    getPresenceSettings(),
  ])

  const statuses = nodes.map((node) => ({
    id: Number(node.id),
    ...nodeStatus(node, agentOf(node, agents), thresholds),
  }))
  const nodeLive = new Map(statuses.map((state) => [state.id, state.live]))

  const ends = new Map<number, PortEnd>()
  for (const row of ports) {
    const agentPort = row.origin === 'agent'
    ends.set(Number(row.id), {
      row,
      state: {
        id: Number(row.id),
        nodeId: Number(row.nodeId),
        present: bool(row.present),
        live: agentPortLive(row, nodeLive.get(Number(row.nodeId)) ?? false),
        // An agent port keeps its last reported state when it is not live
        // (the dashboard greys it); a manual port has none of its own.
        up: agentPort ? portUp(row) : null,
        adminUp: agentPort ? nullableBool(row.adminUp) : null,
        operstate: agentPort ? row.operstate : null,
        speedMbps: agentPort ? nullableNumber(row.speedMbps) : null,
        duplex: agentPort ? row.duplex : null,
        carrierChanges: agentPort ? nullableNumber(row.carrierChanges) : null,
        changedAt: agentPort ? row.stateChangedAt : null,
        derivedFrom: null,
      },
    })
  }

  const linkStates: InfraLinkState[] = []
  for (const link of links) {
    const a = ends.get(Number(link.aPortId))
    const b = ends.get(Number(link.bPortId))
    linkStates.push(linkState(link, a, b))
    // A manual port shows what the live agent port at the other end of its
    // cable reports: that is what makes an unmanaged switch worth drawing.
    for (const [near, far] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!near || near.row.origin === 'agent' || !isLiveAgentEnd(far)) continue
      near.state = {
        ...near.state,
        live: true,
        up: far.state.up,
        speedMbps: far.state.speedMbps,
        duplex: far.state.duplex,
        changedAt: far.state.changedAt,
        derivedFrom: Number(link.id),
      }
    }
  }

  // Device nodes carry their device's presence, with what their cable says
  // (amendment A4 item 6), from the rows read above.
  const onMap = onMapOfLayout(nodes, ports, links, agents, nodeLive)
  const presences = await queryDevicePresences([...onMap.keys()], thresholds, onMap)
  const nodeStates = nodes.map((node, i): InfraNodeState => {
    const mac = node.deviceMac ? node.deviceMac.toLowerCase() : null
    return { ...statuses[i], presence: mac ? (presences.get(mac) ?? null) : null }
  })

  return {
    generatedAt: new Date().toISOString(),
    nodes: nodeStates,
    ports: [...ends.values()].map((end) => end.state),
    links: linkStates,
  }
}

// ── devices on the map (amendment A4 items 5 and 6) ─────────────────────────

type FarPortFields = Pick<
  PortRow,
  | 'id'
  | 'nodeId'
  | 'key'
  | 'origin'
  | 'label'
  | 'reportedLabel'
  | 'present'
  | 'carrier'
  | 'operstate'
  | 'speedMbps'
  | 'duplex'
  | 'stateChangedAgo'
>

type FarNodeFields = NameFields & Pick<NodeRow, 'id' | 'origin'>

/** A cable on a port of a node that carries a device, seen from that node. */
type UplinkRow = {
  /** The node's port that takes the cable. */
  portId: number
  position: number
  linkId: number
  medium: string
  /** The other end of the cable. */
  far: FarPortFields
  farNode: FarNodeFields
}

/** The far end of a device's uplink, by the section 7.3 rules. */
type FarEnd = {
  live: boolean
  up: boolean | null
  speedMbps: number | null
  duplex: 'full' | 'half' | null
  /** Epoch ms: its agent's last report while up, when the link went down while down. */
  at: number | null
}

/** A device's uplink: its node's cabled port with the lowest position (then id). */
function pickUplink(candidates: UplinkRow[]): UplinkRow | null {
  let best: UplinkRow | null = null
  for (const candidate of candidates) {
    if (
      best === null ||
      Number(candidate.position) < Number(best.position) ||
      (Number(candidate.position) === Number(best.position) &&
        Number(candidate.portId) < Number(best.portId))
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * What the far end of a device's uplink says, believed only when it is a live
 * agent port. While up, the device was on the wire at the agent's last
 * accepted report (its row's `last_seen_at`: a port row's `reported_at` only
 * moves when a report changes it); while down, when the link went down.
 * `nodeLive` is the far node's `nodeStatus(…).live`.
 */
function farEndOf(
  far: FarPortFields,
  nodeLive: boolean,
  agent: AgentRow | null,
  now: number
): FarEnd {
  if (!agentPortLive(far, nodeLive)) {
    return { live: false, up: null, speedMbps: null, duplex: null, at: null }
  }
  const up = portUp(far)
  const reportedAgo = agent?.lastSeenAgoSeconds ?? null
  const ago = up === false ? (nullableNumber(far.stateChangedAgo) ?? reportedAgo) : reportedAgo
  return {
    live: true,
    up,
    speedMbps: nullableNumber(far.speedMbps),
    duplex: oneOf(far.duplex, ['full', 'half'] as const),
    at: ago === null ? null : now - ago * 1000,
  }
}

function linkMedium(value: string): InfraLinkMedium {
  return oneOf(value, INFRA_LINK_MEDIA) ?? 'ethernet'
}

/** What `devicePresence` reads from a device's uplink (`DeviceOnMap`). */
function onMapOf(uplink: UplinkRow | null, far: FarEnd | null): DeviceOnMap {
  const medium = uplink ? linkMedium(uplink.medium) : null
  return {
    wired: medium === 'ethernet' || medium === 'fiber',
    link:
      far !== null && far.live && far.up !== null && far.at !== null
        ? { up: far.up, at: far.at }
        : null,
  }
}

function attachmentOf(
  node: NameFields & { id: number },
  uplink: UplinkRow | null,
  far: FarEnd | null,
  names: NameSources
): DeviceAttachment {
  return {
    nodeId: Number(node.id),
    nodeName: nodeName(node, names),
    uplink:
      uplink && far
        ? {
            linkId: Number(uplink.linkId),
            medium: linkMedium(uplink.medium),
            nodeId: Number(uplink.farNode.id),
            nodeName: nodeName(uplink.farNode, names),
            nodeKind: uplink.farNode.kind,
            portId: Number(uplink.far.id),
            portKey: uplink.far.key,
            portLabel: uplink.far.label ?? uplink.far.reportedLabel ?? uplink.far.key,
            live: far.live,
            up: far.up,
            speedMbps: far.speedMbps,
            duplex: far.duplex,
          }
        : null,
  }
}

/**
 * `/infra/state`: what the map says about every device node's device, from
 * the rows the state was built from; keyed by lowercase MAC. `nodeLive` holds
 * each node's `nodeStatus(…).live`.
 */
function onMapOfLayout(
  nodes: NodeRow[],
  ports: PortRow[],
  links: LinkRow[],
  agents: Map<string, AgentRow>,
  nodeLive: Map<number, boolean>
): Map<string, DeviceOnMap> {
  const out = new Map<string, DeviceOnMap>()
  const devices = nodes.filter((node) => node.deviceMac)
  if (devices.length === 0) return out

  const nodesById = new Map(nodes.map((node) => [Number(node.id), node]))
  const portsById = new Map(ports.map((port) => [Number(port.id), port]))
  const portsByNode = groupPorts(ports)
  const linkByPort = new Map<number, LinkRow>()
  for (const link of links) {
    linkByPort.set(Number(link.aPortId), link)
    linkByPort.set(Number(link.bPortId), link)
  }
  const now = Date.now()
  for (const node of devices) {
    const mac = node.deviceMac!.toLowerCase()
    // One node per device; were there two, the first (lowest id) speaks.
    if (out.has(mac)) continue
    const candidates: UplinkRow[] = []
    for (const port of portsByNode.get(Number(node.id)) ?? []) {
      const link = linkByPort.get(Number(port.id))
      if (!link) continue
      const farId =
        Number(link.aPortId) === Number(port.id) ? Number(link.bPortId) : Number(link.aPortId)
      const far = portsById.get(farId)
      const farNode = far ? nodesById.get(Number(far.nodeId)) : undefined
      if (!far || !farNode) continue
      candidates.push({
        portId: Number(port.id),
        position: Number(port.position),
        linkId: Number(link.id),
        medium: link.medium,
        far,
        farNode,
      })
    }
    const uplink = pickUplink(candidates)
    const farEnd = uplink
      ? farEndOf(
          uplink.far,
          nodeLive.get(Number(uplink.farNode.id)) ?? false,
          agentOf(uplink.farNode, agents),
          now
        )
      : null
    out.set(mac, onMapOf(uplink, farEnd))
  }
  return out
}

type UplinkSqlRow = {
  nodeId: number
  portId: number
  position: number
  linkId: number
  medium: string
  farId: number
  farNodeId: number
  farKey: string
  farOrigin: string
  farLabel: string | null
  farReportedLabel: string | null
  farPresent: number | boolean
  farCarrier: number | boolean | null
  farOperstate: string | null
  farSpeedMbps: number | null
  farDuplex: string | null
  farStateChangedAgo: number | string | null
  farKind: InfraNodeKind
  farNodeOrigin: string
  farName: string | null
  farCollectorId: number | null
  farApId: number | null
  farDeviceMac: string | null
}

/**
 * Every cable on these nodes' ports, with its far port and far node, in one
 * query; grouped by node.
 */
async function selectUplinks(client: Client, nodeIds: number[]): Promise<Map<number, UplinkRow[]>> {
  const out = new Map<number, UplinkRow[]>()
  if (nodeIds.length === 0) return out
  const result = await client.rawQuery(
    `SELECT p.node_id AS nodeId, p.id AS portId, p.position AS position,
            l.id AS linkId, l.medium AS medium,
            fp.id AS farId, fp.node_id AS farNodeId, fp.port_key AS farKey,
            fp.origin AS farOrigin, fp.label AS farLabel, fp.reported_label AS farReportedLabel,
            fp.present AS farPresent, fp.carrier AS farCarrier, fp.operstate AS farOperstate,
            fp.speed_mbps AS farSpeedMbps, fp.duplex AS farDuplex,
            TIMESTAMPDIFF(SECOND, fp.state_changed_at, UTC_TIMESTAMP()) AS farStateChangedAgo,
            fn.kind AS farKind, fn.origin AS farNodeOrigin, fn.name AS farName,
            fn.collector_id AS farCollectorId, fn.ap_id AS farApId, fn.device_mac AS farDeviceMac
       FROM infra_ports p
       INNER JOIN infra_links l ON l.a_port_id = p.id OR l.b_port_id = p.id
       INNER JOIN infra_ports fp ON fp.id = IF(l.a_port_id = p.id, l.b_port_id, l.a_port_id)
       INNER JOIN infra_nodes fn ON fn.id = fp.node_id
      WHERE p.node_id IN (${nodeIds.map(() => '?').join(', ')})`,
    nodeIds
  )
  for (const row of rows<UplinkSqlRow>(result)) {
    const uplink: UplinkRow = {
      portId: Number(row.portId),
      position: Number(row.position),
      linkId: Number(row.linkId),
      medium: row.medium,
      far: {
        id: Number(row.farId),
        nodeId: Number(row.farNodeId),
        key: row.farKey,
        origin: row.farOrigin,
        label: row.farLabel,
        reportedLabel: row.farReportedLabel,
        present: row.farPresent,
        carrier: row.farCarrier,
        operstate: row.farOperstate,
        speedMbps: row.farSpeedMbps,
        duplex: row.farDuplex,
        stateChangedAgo: row.farStateChangedAgo,
      },
      farNode: {
        id: Number(row.farNodeId),
        kind: row.farKind,
        origin: row.farNodeOrigin,
        name: row.farName,
        collectorId: nullableNumber(row.farCollectorId),
        apId: nullableNumber(row.farApId),
        deviceMac: row.farDeviceMac,
      },
    }
    const list = out.get(Number(row.nodeId))
    if (list) list.push(uplink)
    else out.set(Number(row.nodeId), [uplink])
  }
  return out
}

function isBound(node: Pick<NodeRow, 'apId' | 'collectorId'>): boolean {
  return node.apId !== null || node.collectorId !== null
}

/**
 * Where these devices are on the map (amendment A4 items 5 and 6): the
 * attachment `/devices` and `/devices/:mac/presence` serve, and what the
 * presence rule reads from it. Keyed by lowercase MAC; a device no node
 * carries has no entry.
 *
 * Read per request and never cached, in a fixed number of queries whatever
 * the number of MACs: the nodes that carry them (the only one when none
 * does), their cables with the far ends, the agent rows (two tables in
 * parallel) only when a bound node is involved, and the hostname settings
 * only when a node has no name of its own. Labels come from their cached map.
 * The far end is judged by `nodeStatus` and `agentPortLive`, the rules of
 * `/infra/state`.
 */
export async function loadDeviceAttachments(
  macs: string[],
  thresholds: PresenceThresholds
): Promise<Map<string, DevicePlacement>> {
  const placements = new Map<string, DevicePlacement>()
  const keys = [...new Set(macs.map((mac) => normalizeMac(mac) ?? mac.toLowerCase()))]
  if (keys.length === 0) return placements

  const client = db.connection()
  const nodes = await selectNodes(client, { deviceMacs: keys })
  if (nodes.length === 0) return placements
  const uplinksByNode = await selectUplinks(
    client,
    nodes.map((node) => Number(node.id))
  )

  const involved: NameFields[] = [
    ...nodes,
    ...[...uplinksByNode.values()].flat().map((uplink) => uplink.farNode),
  ]
  const deviceMacs = involved.flatMap((node) =>
    node.deviceMac ? [node.deviceMac.toLowerCase()] : []
  )
  const [agents, labels, hostnames] = await Promise.all([
    involved.some(isBound) ? loadAgents(client) : new Map<string, AgentRow>(),
    getDeviceLabels(deviceMacs),
    hostnamesByMac(
      involved.flatMap((node) =>
        node.name === null && node.deviceMac ? [node.deviceMac.toLowerCase()] : []
      )
    ),
  ])
  const names: NameSources = { agents, labels, hostnames }

  const now = Date.now()
  for (const node of nodes) {
    const mac = node.deviceMac!.toLowerCase()
    // One node per device; were there two, the first (lowest id) speaks.
    if (placements.has(mac)) continue
    const uplink = pickUplink(uplinksByNode.get(Number(node.id)) ?? [])
    let farEnd: FarEnd | null = null
    if (uplink) {
      const agent = agentOf(uplink.farNode, agents)
      const status = nodeStatus(uplink.farNode, agent, thresholds)
      farEnd = farEndOf(uplink.far, status.live, agent, now)
    }
    placements.set(mac, {
      attachment: attachmentOf(node, uplink, farEnd, names),
      onMap: onMapOf(uplink, farEnd),
    })
  }
  return placements
}

// ── writes: shared checks ─────────────────────────────────────────────────

export type PortInput = {
  key: string
  label?: string | null
  role?: InfraPortRole | null
  medium?: InfraPortMedium | null
  position?: number
}

type Position = { x: number; y: number }
type Size = { width: number; height: number }

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function lockNode(client: Client, id: number): Promise<NodeRow | null> {
  const [node] = (await client
    .from('infra_nodes')
    .where('id', id)
    .forUpdate()
    .select(
      'id',
      'kind',
      'origin',
      'name',
      'collector_id as collectorId',
      'ap_id as apId',
      'parent_id as parentId'
    )) as NodeRow[]
  return node ?? null
}

/**
 * Only a host may be a parent, one level deep: not itself, not a node that
 * already sits in a frame, and a host never goes inside another.
 */
async function assertParent(
  client: Client,
  node: { id: number | null; kind: InfraNodeKind },
  parentId: number | null
): Promise<void> {
  if (parentId === null) return
  const invalid = (message: string) => refuse(422, 'infra_parent_invalid', message, { parentId })
  if (node.id !== null && parentId === node.id) throw invalid('A node cannot sit inside itself.')
  if (node.kind === 'host') throw invalid('A host cannot sit inside another host.')
  const parent = await client
    .from('infra_nodes')
    .where('id', parentId)
    .select('id', 'kind', 'parent_id as parentId')
    .first()
  if (!parent || parent.kind !== 'host') {
    throw invalid(`Node ${parentId} is not a host, so nothing can sit inside it.`)
  }
  if (parent.parentId !== null) throw invalid(`Node ${parentId} already sits inside a host.`)
}

function assertUniqueKeys(ports: PortInput[]): void {
  const seen = new Set<string>()
  for (const port of ports) {
    const key = port.key.toLowerCase()
    if (seen.has(key)) {
      throw refuse(422, 'infra_port_key_duplicate', `Port key "${port.key}" is given twice.`, {
        key: port.key,
      })
    }
    seen.add(key)
  }
}

/** Default port set of a kind (section 7.4). */
function templatePorts(kind: InfraNodeKind, count: number, sfpPorts: number): PortInput[] {
  const ports: PortInput[] = []
  const numbered = (prefix: string, from: number, to: number, medium: InfraPortMedium | null) => {
    for (let i = from; i <= to; i++) ports.push({ key: `${prefix}${i}`, medium })
  }
  switch (kind) {
    case 'switch':
      numbered('', 1, count, 'copper')
      break
    case 'router':
    case 'modem':
    case 'access_point':
      if (count >= 1) ports.push({ key: 'wan', role: 'wan', medium: 'copper' })
      for (let i = 1; i < count; i++) ports.push({ key: `lan${i}`, role: 'lan', medium: 'copper' })
      break
    case 'isp':
      if (count >= 1) ports.push({ key: 'uplink', role: 'wan', medium: null })
      break
    case 'device':
      numbered('eth', 0, count - 1, 'copper')
      break
    case 'host':
      numbered('nic', 0, count - 1, 'copper')
      break
    case 'gateway':
      break
  }
  if (KINDS[kind].supportsSfp) numbered('sfp', 1, sfpPorts, 'sfp')
  return ports
}

async function insertManualPorts(
  client: Client,
  nodeId: number,
  ports: PortInput[],
  firstPosition: number
): Promise<number[]> {
  const now = sqlNow()
  const ids: number[] = []
  for (const [index, port] of ports.entries()) {
    const [id] = await client.table('infra_ports').insert({
      node_id: nodeId,
      port_key: port.key,
      origin: 'manual',
      label: blankToNull(port.label),
      role: port.role ?? null,
      medium: port.medium ?? null,
      position: port.position ?? firstPosition + index,
      hidden: false,
      present: true,
      created_at: now,
      updated_at: now,
    })
    ids.push(Number(id))
  }
  return ids
}

/** The binding of a node, to forget its agent's last report after an operator edit. */
async function forgetPortsOfNode(nodeId: number): Promise<void> {
  const node = await db
    .from('infra_nodes')
    .where('id', nodeId)
    .select('ap_id', 'collector_id')
    .first()
  const binding = node ? bindingOf({ apId: node.ap_id, collectorId: node.collector_id }) : null
  if (binding) forgetAgentPorts(binding)
}

// ── nodes ─────────────────────────────────────────────────────────────────

/** `linkTo` on create (amendment A4 item 4): cable one of the new node's ports to `portId`. */
export type LinkToInput = {
  portId: number
  /** Default: the new node's first port by position. */
  ownPortKey?: string
  medium?: InfraLinkMedium
}

export type CreateNodeInput = {
  kind: InfraNodeKind
  /** Optional when `deviceMac` is set: the node then follows the device's name. */
  name?: string | null
  virtual?: boolean
  model?: string | null
  notes?: string | null
  deviceMac?: string | null
  parentId?: number | null
  position?: Position | null
  size?: Size | null
  portCount?: number
  sfpPorts?: number
  ports?: PortInput[]
  linkTo?: LinkToInput
}

/** A MAC from a request (the validator checked its shape), stored lowercase with colons. */
function deviceMacOf(raw: string): string {
  const mac = normalizeMac(raw)
  if (!mac) throw fieldError('deviceMac', 'The deviceMac field must be a MAC address', 'regex')
  return mac
}

/**
 * One node per device (amendment A4 item 2): refuses a MAC another node
 * carries. A locking read, so a concurrent write waits for this one; the
 * unique index is the backstop (`refusalAfterRace`).
 */
async function assertDeviceFree(client: Client, mac: string, nodeId: number | null) {
  const query = client.from('infra_nodes').where('device_mac', mac).forUpdate().select('id')
  if (nodeId !== null) query.whereNot('id', nodeId)
  const holder = await query.first()
  if (holder) throw deviceAlreadyPlaced(mac, Number(holder.id))
}

/**
 * The index into `ports` that `linkTo` cables: `ownPortKey` (case-insensitive,
 * like every key), else the first port by the position it is stored with.
 */
function linkToPortIndex(ports: PortInput[], ownPortKey: string | undefined): number {
  if (ports.length === 0) {
    throw refuse(
      422,
      'infra_field_not_applicable',
      'A node without ports cannot take a cable; give it a port first.',
      { field: 'linkTo' }
    )
  }
  if (ownPortKey !== undefined) {
    const wanted = ownPortKey.toLowerCase()
    const index = ports.findIndex((port) => port.key.toLowerCase() === wanted)
    if (index === -1) {
      throw fieldError('linkTo.ownPortKey', `The new node has no port "${ownPortKey}".`, 'exists')
    }
    return index
  }
  let first = 0
  for (const [index, port] of ports.entries()) {
    if ((port.position ?? index) < (ports[first].position ?? first)) first = index
  }
  return first
}

/** The unique index a duplicate-entry error names, when it is ours. */
function isDuplicateDeviceMac(error: unknown): boolean {
  if (!isDuplicateEntryError(error)) return false
  const { sqlMessage, message } = error as { sqlMessage?: unknown; message?: unknown }
  return String(sqlMessage ?? message ?? '').includes(DEVICE_MAC_INDEX)
}

/**
 * A write that lost a race on a unique index, as the refusal the locking
 * reads would have given: the device's MAC went to another node, or the far
 * port of a new cable got one in between.
 */
async function refusalAfterRace(
  error: unknown,
  context: { deviceMac: string | null; linkPortIds: number[] }
): Promise<unknown> {
  if (!isDuplicateEntryError(error)) return error
  if (context.deviceMac !== null && isDuplicateDeviceMac(error)) {
    const holder = await db
      .from('infra_nodes')
      .where('device_mac', context.deviceMac)
      .select('id')
      .first()
    if (holder) return deviceAlreadyPlaced(context.deviceMac, Number(holder.id))
    return error
  }
  if (context.linkPortIds.length > 0) return busyAfterRace(context.linkPortIds)
  return error
}

/**
 * `POST /infra/nodes` (section 7.4, amendment A4 items 1–4). With `linkTo`,
 * the new node's port is cabled in the same transaction, by the rules of
 * `POST /infra/links`: any refusal leaves nothing behind.
 */
export async function createNode(
  input: CreateNodeInput
): Promise<{ node: InfraNodeView; link: InfraLinkView | null }> {
  const kind = input.kind
  if (kind === 'gateway') {
    throw refuse(
      422,
      'infra_kind_not_manual',
      'The gateway node belongs to the Gateway agent; add a second router as `router`.',
      { kind }
    )
  }
  const spec = KINDS[kind]
  if (input.virtual === true && !VIRTUAL_KINDS.has(kind)) throw notApplicable('virtual', kind)
  if (input.deviceMac && !DEVICE_KINDS.has(kind)) throw notApplicable('deviceMac', kind)
  if (input.size && kind !== 'host') throw notApplicable('size', kind)
  if (input.sfpPorts && !spec.supportsSfp) throw notApplicable('sfpPorts', kind)
  const deviceMac = input.deviceMac ? deviceMacOf(input.deviceMac) : null
  const name = blankToNull(input.name)
  if (name === null && deviceMac === null) {
    throw fieldError('name', 'The name field must be defined', 'required')
  }

  let ports: PortInput[]
  if (input.ports !== undefined) {
    ports = input.ports
  } else {
    const count = input.portCount ?? spec.ports.default
    if (count < spec.ports.min || count > spec.ports.max) {
      throw fieldError(
        'portCount',
        `A ${spec.label} node takes ${spec.ports.min} to ${spec.ports.max} ports.`,
        'range'
      )
    }
    ports = templatePorts(kind, count, input.sfpPorts ?? 0)
  }
  assertUniqueKeys(ports)
  if (ports.length > INFRA_LIMITS.portsPerNode) {
    throw limitReached('ports', `A node has at most ${INFRA_LIMITS.portsPerNode} ports.`)
  }
  const linkTo = input.linkTo
  const ownPort = linkTo ? linkToPortIndex(ports, linkTo.ownPortKey) : null

  let created: { nodeId: number; linkId: number | null }
  try {
    created = await db.transaction(async (trx) => {
      const [{ total }] = (await trx.from('infra_nodes').count('* as total')) as Array<{
        total: number | string
      }>
      if (Number(total) >= INFRA_LIMITS.nodes) {
        throw limitReached('nodes', `The map holds at most ${INFRA_LIMITS.nodes} nodes.`)
      }
      await assertParent(trx, { id: null, kind }, input.parentId ?? null)
      if (deviceMac !== null) await assertDeviceFree(trx, deviceMac, null)
      const now = sqlNow()
      const [nodeId] = await trx.table('infra_nodes').insert({
        kind,
        origin: 'manual',
        name,
        device_mac: deviceMac,
        parent_id: input.parentId ?? null,
        virtual: input.virtual ?? false,
        model: blankToNull(input.model),
        notes: blankToNull(input.notes),
        pos_x: input.position?.x ?? null,
        pos_y: input.position?.y ?? null,
        width: input.size?.width ?? null,
        height: input.size?.height ?? null,
        hidden: false,
        created_at: now,
        updated_at: now,
      })
      const portIds = await insertManualPorts(trx, Number(nodeId), ports, 0)
      const linkId =
        linkTo && ownPort !== null
          ? await insertLink(trx, {
              aPortId: portIds[ownPort],
              bPortId: linkTo.portId,
              medium: linkTo.medium,
            })
          : null
      return { nodeId: Number(nodeId), linkId }
    })
  } catch (error) {
    throw await refusalAfterRace(error, {
      deviceMac,
      linkPortIds: linkTo ? [linkTo.portId] : [],
    })
  }
  return {
    node: await loadNodeView(created.nodeId),
    link: created.linkId === null ? null : await loadLinkView(created.linkId),
  }
}

export type UpdateNodeInput = {
  name?: string | null
  model?: string | null
  notes?: string | null
  virtual?: boolean
  deviceMac?: string | null
  parentId?: number | null
  position?: Position | null
  size?: Size | null
  hidden?: boolean
  portCount?: number
}

/**
 * Grows or shrinks a switch's numbered ports ("1"…"N") to exactly 1…N, then
 * lays the strip out again: the numbered ports in order, the others (SFP
 * cages, ports added by hand) after them in their current order.
 */
async function resizeNumberedPorts(client: Client, nodeId: number, count: number) {
  const ports = (await client
    .from('infra_ports')
    .where('node_id', nodeId)
    .forUpdate()
    .select('id', 'port_key as key', 'position')
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')) as Array<{ id: number; key: string; position: number }>
  const numberOf = (key: string) => (/^[1-9][0-9]*$/.test(key) ? Number(key) : null)
  const drop = ports.filter((port) => (numberOf(port.key) ?? 0) > count)
  if (drop.length > 0) {
    const cabled = await selectLinks(client, { portIds: drop.map((port) => Number(port.id)) })
    if (cabled.length > 0) {
      const byPort = linkIndex(cabled)
      const blocked = drop
        .filter((port) => byPort.has(Number(port.id)))
        .map((port) => ({
          id: Number(port.id),
          key: port.key,
          linkId: byPort.get(Number(port.id)),
        }))
      throw refuse(
        409,
        'infra_port_has_link',
        `Ports ${blocked.map((port) => port.key).join(', ')} carry cables; remove them first.`,
        { ports: blocked }
      )
    }
  }
  const present = new Set(ports.map((port) => numberOf(port.key)).filter((n) => n !== null))
  const add: PortInput[] = []
  for (let n = 1; n <= count; n++) {
    if (!present.has(n)) add.push({ key: String(n), medium: 'copper' })
  }
  if (ports.length - drop.length + add.length > INFRA_LIMITS.portsPerNode) {
    throw limitReached('ports', `A node has at most ${INFRA_LIMITS.portsPerNode} ports.`)
  }
  if (drop.length === 0 && add.length === 0) return

  if (drop.length > 0) {
    await client
      .from('infra_ports')
      .whereIn(
        'id',
        drop.map((port) => Number(port.id))
      )
      .delete()
  }
  const addedIds = await insertManualPorts(client, nodeId, add, 0)

  const kept = ports.filter((port) => !drop.includes(port))
  const numbered = [
    ...kept
      .filter((port) => numberOf(port.key) !== null)
      .map((port) => ({
        id: Number(port.id),
        n: numberOf(port.key)!,
      })),
    ...add.map((port, i) => ({ id: addedIds[i], n: Number(port.key) })),
  ].sort((left, right) => left.n - right.n)
  const others = kept.filter((port) => numberOf(port.key) === null)
  const order = [...numbered.map((port) => port.id), ...others.map((port) => Number(port.id))]
  const now = sqlNow()
  for (const [position, id] of order.entries()) {
    await client.from('infra_ports').where('id', id).update({ position, updated_at: now })
  }
}

/** `PATCH /infra/nodes/:id` (section 7.5): omitted keys keep, `null` clears. */
export async function updateNode(id: number, input: UpdateNodeInput): Promise<InfraNodeView> {
  const deviceMac = input.deviceMac ? deviceMacOf(input.deviceMac) : null
  try {
    await patchNode(id, input, deviceMac)
  } catch (error) {
    throw await refusalAfterRace(error, { deviceMac, linkPortIds: [] })
  }
  return loadNodeView(id)
}

/** The write behind `updateNode`, in one transaction; `deviceMac` is the normalised MAC. */
async function patchNode(id: number, input: UpdateNodeInput, deviceMac: string | null) {
  await db.transaction(async (trx) => {
    const node = await lockNode(trx, id)
    if (!node) throw nodeNotFound(id)
    const kind = node.kind
    if (input.virtual === true && !VIRTUAL_KINDS.has(kind)) throw notApplicable('virtual', kind)
    if (input.deviceMac && !DEVICE_KINDS.has(kind)) throw notApplicable('deviceMac', kind)
    if (input.deviceMac && (node.apId !== null || node.collectorId !== null)) {
      throw refuse(
        422,
        'infra_field_not_applicable',
        'This node stands for the agent it is bound to; it cannot carry a device as well.',
        { field: 'deviceMac' }
      )
    }
    if (input.size && kind !== 'host') throw notApplicable('size', kind)
    if (input.portCount !== undefined && kind !== 'switch') throw notApplicable('portCount', kind)
    if (input.parentId !== undefined) await assertParent(trx, { id, kind }, input.parentId)
    if (deviceMac) await assertDeviceFree(trx, deviceMac, id)

    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = blankToNull(input.name)
    if (input.model !== undefined) patch.model = blankToNull(input.model)
    if (input.notes !== undefined) patch.notes = blankToNull(input.notes)
    if (input.virtual !== undefined) patch.virtual = input.virtual
    if (input.deviceMac !== undefined) patch.device_mac = deviceMac
    if (input.parentId !== undefined) patch.parent_id = input.parentId
    if (input.position !== undefined) {
      patch.pos_x = input.position?.x ?? null
      patch.pos_y = input.position?.y ?? null
    }
    if (input.size !== undefined) {
      patch.width = input.size?.width ?? null
      patch.height = input.size?.height ?? null
    }
    if (input.hidden !== undefined) patch.hidden = input.hidden
    if (input.portCount !== undefined) {
      const { min, max } = KINDS.switch.ports
      if (input.portCount < min || input.portCount > max) {
        throw fieldError('portCount', `A switch takes ${min} to ${max} ports.`, 'range')
      }
      await resizeNumberedPorts(trx, id, input.portCount)
    }
    patch.updated_at = sqlNow()
    await trx.from('infra_nodes').where('id', id).update(patch)
  })
}

/** `DELETE /infra/nodes/:id` (section 7.6). Children leave the frame (SET NULL). */
export async function deleteNode(id: number): Promise<void> {
  const node = await db
    .from('infra_nodes')
    .where('id', id)
    .select('id', 'ap_id as apId', 'collector_id as collectorId')
    .first()
  if (!node) throw nodeNotFound(id)
  const binding = bindingOf(node)
  if (binding) {
    const agents = await loadAgents(db.connection())
    const name = agents.get(agentKey(binding.type, binding.id))?.name ?? `#${binding.id}`
    const message =
      binding.type === 'ap'
        ? `This node is the AP "${name}". Remove it in Settings → Wi-Fi sources, or hide it here.`
        : `This node is the Gateway agent "${name}". Remove it in Settings → Collectors, or hide it here.`
    throw refuse(409, 'infra_node_bound', message, { binding })
  }
  await db.from('infra_nodes').where('id', id).delete()
}

export type BindTarget = { type: 'ap' | 'collector'; id: number }

/**
 * `POST /infra/nodes/:id/bind` (section 6.3): puts a detached (or manual)
 * node back onto an agent row. The agent's own node, if it has one, gives way
 * when it carries no cable. The agent's next report matches ports by key.
 */
export async function bindNode(
  id: number,
  target: BindTarget
): Promise<{ node: InfraNodeView; replacedNodeId: number | null }> {
  const column = target.type === 'ap' ? 'ap_id' : 'collector_id'
  const bind = () =>
    db.transaction(async (trx) => {
      const node = await lockNode(trx, id)
      if (!node) throw nodeNotFound(id)
      if (node.apId !== null || node.collectorId !== null) {
        throw refuse(409, 'infra_node_already_bound', `Node ${id} is already bound to an agent.`, {
          binding: bindingOf(node),
        })
      }
      const table = target.type === 'ap' ? 'wifi_access_points' : 'collectors'
      const row = await trx.from(table).where('id', target.id).forUpdate().select('id').first()
      if (!row) {
        throw refuse(
          404,
          'infra_binding_not_found',
          target.type === 'ap'
            ? `There is no Wi-Fi source ${target.id}.`
            : `There is no collector ${target.id}.`,
          { binding: target }
        )
      }
      const wanted: InfraNodeKind = target.type === 'ap' ? 'access_point' : 'gateway'
      if (node.kind !== wanted) {
        throw refuse(
          422,
          'infra_binding_kind_mismatch',
          `Only a ${KINDS[wanted].label.toLowerCase()} node can be bound to ` +
            `${target.type === 'ap' ? 'an AP' : 'a collector'}.`,
          { kind: node.kind }
        )
      }

      let replacedNodeId: number | null = null
      const current = await trx
        .from('infra_nodes')
        .where(column, target.id)
        .forUpdate()
        .select('id')
        .first()
      if (current) {
        const ports = await trx.from('infra_ports').where('node_id', current.id).select('id')
        const cabled = await selectLinks(trx, { portIds: ports.map((port) => Number(port.id)) })
        if (cabled.length > 0) {
          throw refuse(
            409,
            'infra_agent_node_has_links',
            `The agent already has node ${current.id}, and it carries cables. ` +
              'Delete or rewire it first.',
            { nodeId: Number(current.id) }
          )
        }
        await trx.from('infra_nodes').where('id', current.id).delete()
        replacedNodeId = Number(current.id)
      }
      await trx
        .from('infra_nodes')
        .where('id', id)
        .update({ [column]: target.id, origin: 'agent', updated_at: sqlNow() })
      return replacedNodeId
    })

  let replacedNodeId: number | null
  try {
    replacedNodeId = await bind()
  } catch (error) {
    // The agent's first report created its node in between: that node is new
    // and uncabled, so going round once more replaces it.
    if (!isDuplicateEntryError(error)) throw error
    replacedNodeId = await bind()
  }
  forgetAgentPorts(target)
  return { node: await loadNodeView(id), replacedNodeId }
}

// ── ports ─────────────────────────────────────────────────────────────────

/** `POST /infra/nodes/:id/ports` (section 7.8): pins ports by hand, on any node. */
export async function addPorts(nodeId: number, ports: PortInput[]): Promise<InfraPortView[]> {
  assertUniqueKeys(ports)
  let ids: number[] = []
  try {
    ids = await db.transaction(async (trx) => {
      const node = await lockNode(trx, nodeId)
      if (!node) throw nodeNotFound(nodeId)
      const existing = (await trx
        .from('infra_ports')
        .where('node_id', nodeId)
        .forUpdate()
        .select('port_key as key', 'position')) as Array<{ key: string; position: number }>
      const keys = new Set(existing.map((port) => port.key.toLowerCase()))
      const taken = ports.find((port) => keys.has(port.key.toLowerCase()))
      if (taken) throw keyTaken(taken.key, nodeId)
      if (existing.length + ports.length > INFRA_LIMITS.portsPerNode) {
        throw limitReached('ports', `A node has at most ${INFRA_LIMITS.portsPerNode} ports.`)
      }
      const next = existing.reduce((max, port) => Math.max(max, Number(port.position) + 1), 0)
      return insertManualPorts(trx, nodeId, ports, next)
    })
  } catch (error) {
    // The node's agent reported one of these keys in the meantime.
    if (isDuplicateEntryError(error)) throw keyTaken(ports[0].key, nodeId)
    throw error
  }
  await forgetPortsOfNode(nodeId)
  return loadPortViews(ids)
}

function keyTaken(key: string, nodeId: number): InfraError {
  return refuse(409, 'infra_port_key_taken', `Node ${nodeId} already has a port "${key}".`, {
    key,
  })
}

export type UpdatePortInput = {
  key?: string
  label?: string | null
  role?: InfraPortRole | null
  medium?: InfraPortMedium | null
  hidden?: boolean
  position?: number
}

/**
 * `PATCH /infra/ports/:id`: the operator's fields. On an agent port `label`,
 * `role` and `medium` override what the agent reports (`null` = the agent's
 * again); only a manual port's key can change.
 */
export async function updatePort(id: number, input: UpdatePortInput): Promise<InfraPortView> {
  let nodeId = 0
  await db.transaction(async (trx) => {
    const port = await trx
      .from('infra_ports')
      .where('id', id)
      .forUpdate()
      .select('id', 'node_id as nodeId', 'port_key as key', 'origin', 'hidden')
      .first()
    if (!port) throw portNotFound(id)
    nodeId = Number(port.nodeId)

    const patch: Record<string, unknown> = {}
    if (input.key !== undefined && input.key !== port.key) {
      if (port.origin !== 'manual') {
        throw refuse(
          422,
          'infra_port_key_immutable',
          `Port "${port.key}" is reported by the agent under that name; its key cannot change.`,
          { portId: id }
        )
      }
      const clash = await trx
        .from('infra_ports')
        .where('node_id', nodeId)
        .where('port_key', input.key)
        .whereNot('id', id)
        .select('id')
        .first()
      if (clash) throw keyTaken(input.key, nodeId)
      patch.port_key = input.key
    }
    if (input.hidden === true && !bool(port.hidden)) {
      const [link] = await selectLinks(trx, { portIds: [id] })
      if (link) {
        throw refuse(
          409,
          'infra_port_has_link',
          'This port carries a cable; remove the cable before hiding it.',
          { portId: id, linkId: Number(link.id), ports: [{ id, key: port.key, linkId: link.id }] }
        )
      }
    }
    if (input.label !== undefined) patch.label = blankToNull(input.label)
    if (input.role !== undefined) patch.role = input.role
    if (input.medium !== undefined) patch.medium = input.medium
    if (input.hidden !== undefined) patch.hidden = input.hidden
    if (input.position !== undefined) patch.position = input.position
    patch.updated_at = sqlNow()
    try {
      await trx.from('infra_ports').where('id', id).update(patch)
    } catch (error) {
      if (isDuplicateEntryError(error) && input.key) throw keyTaken(input.key, nodeId)
      throw error
    }
  })
  await forgetPortsOfNode(nodeId)
  const [view] = await loadPortViews([id])
  return view
}

/**
 * `DELETE /infra/ports/:id`: a manual port always, an agent port once its
 * agent stopped reporting it. Its cable goes with it (CASCADE).
 */
export async function deletePort(id: number): Promise<void> {
  const port = await db
    .from('infra_ports')
    .where('id', id)
    .select('id', 'node_id as nodeId', 'origin', 'present')
    .first()
  if (!port) throw portNotFound(id)
  if (port.origin === 'agent' && bool(port.present)) {
    throw refuse(409, 'infra_port_present', 'The agent still reports this port.', { portId: id })
  }
  await db.from('infra_ports').where('id', id).delete()
  await forgetPortsOfNode(Number(port.nodeId))
}

// ── links ─────────────────────────────────────────────────────────────────

type LinkEndRow = {
  id: number
  nodeId: number
  hidden: number | boolean
  medium: string | null
  reportedMedium: string | null
}

/**
 * Both ends must exist, differ, sit on different nodes, not be hidden and
 * carry no other cable (section 6.4). The ends are locked, then every link
 * touching them, before anything is written: one link per port holds even
 * against a concurrent write (the unique indexes only catch half the cases).
 */
async function checkLinkEnds(
  client: Client,
  aPortId: number,
  bPortId: number,
  ignoreLinkId: number | null
): Promise<[LinkEndRow, LinkEndRow]> {
  if (aPortId === bPortId) {
    throw refuse(422, 'infra_link_same_port', 'A cable needs two different ports.', {
      portId: aPortId,
    })
  }
  const ends = (await client
    .from('infra_ports')
    .whereIn('id', [aPortId, bPortId])
    .forUpdate()
    .select(
      'id',
      'node_id as nodeId',
      'hidden',
      'medium',
      'reported_medium as reportedMedium'
    )) as LinkEndRow[]
  const a = ends.find((end) => Number(end.id) === aPortId)
  const b = ends.find((end) => Number(end.id) === bPortId)
  if (!a) throw portNotFound(aPortId)
  if (!b) throw portNotFound(bPortId)
  if (Number(a.nodeId) === Number(b.nodeId)) {
    throw refuse(
      422,
      'infra_link_same_node',
      'Both ports are on the same device: a cable from a device to itself is a loop.',
      { nodeId: Number(a.nodeId) }
    )
  }
  for (const end of [a, b]) {
    if (bool(end.hidden)) {
      throw refuse(409, 'infra_port_hidden', 'A hidden port cannot take a cable; show it first.', {
        portId: Number(end.id),
      })
    }
  }
  const busy = (await client
    .from('infra_links')
    .where((q) =>
      q.whereIn('a_port_id', [aPortId, bPortId]).orWhereIn('b_port_id', [aPortId, bPortId])
    )
    .forUpdate()
    .select('id', 'a_port_id as aPortId', 'b_port_id as bPortId')) as LinkRow[]
  for (const portId of [aPortId, bPortId]) {
    const link = busy.find(
      (row) =>
        Number(row.id) !== ignoreLinkId &&
        (Number(row.aPortId) === portId || Number(row.bPortId) === portId)
    )
    if (link) {
      throw refuse(409, 'infra_port_busy', `Port ${portId} already carries cable ${link.id}.`, {
        portId,
        linkId: Number(link.id),
      })
    }
  }
  return [a, b]
}

/** Section 6.4: both ends virtual ⇒ virtual, an SFP end ⇒ fiber, a wireless end ⇒ wireless. */
export function defaultLinkMedium(
  a: InfraPortMedium | null,
  b: InfraPortMedium | null
): InfraLinkMedium {
  if (a === 'virtual' && b === 'virtual') return 'virtual'
  if (a === 'sfp' || b === 'sfp') return 'fiber'
  if (a === 'wireless' || b === 'wireless') return 'wireless'
  return 'ethernet'
}

function endMedium(end: LinkEndRow): InfraPortMedium | null {
  return oneOf(end.medium, INFRA_PORT_MEDIA) ?? oneOf(end.reportedMedium, INFRA_PORT_MEDIA)
}

/** A busy-port refusal after losing an insert race on the unique indexes. */
async function busyAfterRace(portIds: number[]): Promise<InfraError> {
  const [link] = await selectLinks(db.connection(), { portIds })
  const portId = link
    ? (portIds.find((id) => id === Number(link.aPortId) || id === Number(link.bPortId)) ??
      portIds[0])
    : portIds[0]
  return refuse(409, 'infra_port_busy', `Port ${portId} already carries a cable.`, {
    portId,
    linkId: link ? Number(link.id) : null,
  })
}

export type CreateLinkInput = {
  aPortId: number
  bPortId: number
  medium?: InfraLinkMedium
  label?: string | null
  notes?: string | null
}

/**
 * One new cable, inside the caller's transaction: the checks and locks of
 * `checkLinkEnds`, the cable cap, then the row. `POST /infra/links` and
 * `linkTo` on `POST /infra/nodes` both write cables through here.
 */
async function insertLink(client: Client, input: CreateLinkInput): Promise<number> {
  const [a, b] = await checkLinkEnds(client, input.aPortId, input.bPortId, null)
  const [{ total }] = (await client.from('infra_links').count('* as total')) as Array<{
    total: number | string
  }>
  if (Number(total) >= INFRA_LIMITS.links) {
    throw limitReached('links', `The map holds at most ${INFRA_LIMITS.links} cables.`)
  }
  const now = sqlNow()
  const [linkId] = await client.table('infra_links').insert({
    a_port_id: Math.min(input.aPortId, input.bPortId),
    b_port_id: Math.max(input.aPortId, input.bPortId),
    medium: input.medium ?? defaultLinkMedium(endMedium(a), endMedium(b)),
    label: blankToNull(input.label),
    notes: blankToNull(input.notes),
    created_at: now,
    updated_at: now,
  })
  return Number(linkId)
}

/** `POST /infra/links` (section 7.9). */
export async function createLink(input: CreateLinkInput): Promise<InfraLinkView> {
  let id: number
  try {
    id = await db.transaction((trx) => insertLink(trx, input))
  } catch (error) {
    if (isDuplicateEntryError(error)) throw await busyAfterRace([input.aPortId, input.bPortId])
    throw error
  }
  return loadLinkView(id)
}

export type UpdateLinkInput = {
  aPortId?: number
  bPortId?: number
  medium?: InfraLinkMedium
  label?: string | null
  notes?: string | null
}

/**
 * `PATCH /infra/links/:id`: moves an end (`aPortId` replaces the `a` end,
 * `bPortId` the `b` end), with the checks of a new cable, and edits the rest.
 */
export async function updateLink(id: number, input: UpdateLinkInput): Promise<InfraLinkView> {
  let ends: number[] = []
  try {
    await db.transaction(async (trx) => {
      const link = (await trx
        .from('infra_links')
        .where('id', id)
        .forUpdate()
        .select('id', 'a_port_id as aPortId', 'b_port_id as bPortId')
        .first()) as LinkRow | null
      if (!link) throw linkNotFound(id)
      const aPortId = input.aPortId ?? Number(link.aPortId)
      const bPortId = input.bPortId ?? Number(link.bPortId)
      ends = [aPortId, bPortId]

      const patch: Record<string, unknown> = {}
      if (aPortId !== Number(link.aPortId) || bPortId !== Number(link.bPortId)) {
        await checkLinkEnds(trx, aPortId, bPortId, id)
        // `a` stays the smaller id.
        patch.a_port_id = Math.min(aPortId, bPortId)
        patch.b_port_id = Math.max(aPortId, bPortId)
      }
      if (input.medium !== undefined) patch.medium = input.medium
      if (input.label !== undefined) patch.label = blankToNull(input.label)
      if (input.notes !== undefined) patch.notes = blankToNull(input.notes)
      patch.updated_at = sqlNow()
      await trx.from('infra_links').where('id', id).update(patch)
    })
  } catch (error) {
    if (isDuplicateEntryError(error)) throw await busyAfterRace(ends)
    throw error
  }
  return loadLinkView(id)
}

/** `DELETE /infra/links/:id`. */
export async function deleteLink(id: number): Promise<void> {
  const deleted = await db.from('infra_links').where('id', id).delete()
  if (Number(Array.isArray(deleted) ? deleted[0] : deleted) === 0) throw linkNotFound(id)
}

// ── positions ─────────────────────────────────────────────────────────────

export type PositionInput = { nodeId: number; x: number; y: number; parentId?: number | null }

/**
 * `PUT /infra/positions` (section 7.10): auto-arrange and multi-select drags,
 * in one transaction. Unknown ids refuse the whole batch, naming the first.
 */
export async function savePositions(entries: PositionInput[]): Promise<number> {
  return db.transaction(async (trx) => {
    const ids = [...new Set(entries.map((entry) => entry.nodeId))]
    const found = (await trx
      .from('infra_nodes')
      .whereIn('id', ids)
      .forUpdate()
      .select('id', 'kind')) as Array<{ id: number; kind: InfraNodeKind }>
    const kinds = new Map(found.map((row) => [Number(row.id), row.kind]))
    const unknown = entries.find((entry) => !kinds.has(entry.nodeId))
    if (unknown) throw nodeNotFound(unknown.nodeId)

    const now = sqlNow()
    for (const entry of entries) {
      const patch: Record<string, unknown> = { pos_x: entry.x, pos_y: entry.y, updated_at: now }
      if (entry.parentId !== undefined) {
        await assertParent(
          trx,
          { id: entry.nodeId, kind: kinds.get(entry.nodeId)! },
          entry.parentId
        )
        patch.parent_id = entry.parentId
      }
      await trx.from('infra_nodes').where('id', entry.nodeId).update(patch)
    }
    return ids.length
  })
}

/** Test-only: every row of the three tables, for assertions. */
export async function _infraRowCounts(): Promise<{ nodes: number; ports: number; links: number }> {
  const count = async (table: string) => {
    const [row] = rows<{ total: number | string }>(
      await db.rawQuery(`SELECT COUNT(*) AS total FROM ${table}`)
    )
    return Number(row?.total ?? 0)
  }
  return {
    nodes: await count('infra_nodes'),
    ports: await count('infra_ports'),
    links: await count('infra_links'),
  }
}
