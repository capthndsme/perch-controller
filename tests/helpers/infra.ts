import Collector from '#models/collector'
import WifiAccessPoint from '#models/wifi_access_point'
import { _resetAgentMetricsState } from '#services/ap_agent_metrics'
import apHub from '#services/ap_agent_hub'
import { _resetCollectorAgentState } from '#services/collector_agent'
import collectorHub from '#services/collector_agent_hub'
import { _resetPollerState } from '#services/collector_poller'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { resetHostnameEnrichmentCacheForTesting } from '#services/hostname_enrichment'
import { _resetInfraPortsState, recordAgentPorts } from '#services/infra_ports'
import { _resetQueryCache } from '#services/query_cache'
import { _resetRouterState } from '#services/router_metrics'
import { _resetWifiPollerState } from '#services/wifi_metrics_poller'
import { FakeAgent, seedAgentAp } from '#tests/helpers/ap_agent'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Test side of the infrastructure view (docs/infrastructure-view.md): seed
 * helpers and port reports shaped like the agents'. Placeholder MACs only.
 */

/** Truncates every table and forgets the in-process state the ingest paths keep. */
export async function resetInfraTests() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  resetInfraState()
  return teardown
}

export function resetInfraState() {
  _resetInfraPortsState()
  _resetAgentMetricsState()
  _resetWifiPollerState()
  _resetPollerState()
  _resetCollectorAgentState()
  _resetRouterState()
  resetDeviceLabelCacheForTesting()
  resetHostnameEnrichmentCacheForTesting()
  _resetQueryCache()
}

/** Closes every agent session a test left open. */
export function closeAgentSessions() {
  apHub.closeAll(1000, 'test reset')
  collectorHub.closeAll(1000, 'test reset')
}

type PortFields = {
  label: string
  role: 'wan' | 'lan'
  medium: 'copper' | 'sfp' | 'virtual' | 'wireless'
  mac: string
  adminUp: boolean
  carrier: boolean
  operstate: string
  speedMbps: number
  duplex: 'full' | 'half'
  carrierChanges: number
}

/** One entry of a `ports` array as perch-apd / perch-collector send it. */
export function portReport(name: string, fields: Partial<PortFields> = {}) {
  const up = fields.carrier ?? true
  return {
    name,
    label: fields.label ?? name,
    ...(fields.role ? { role: fields.role } : {}),
    medium: fields.medium ?? 'copper',
    mac: fields.mac ?? '02:00:00:00:00:10',
    adminUp: fields.adminUp ?? true,
    carrier: up,
    operstate: fields.operstate ?? (up ? 'up' : 'down'),
    ...(up ? { speedMbps: fields.speedMbps ?? 1000, duplex: fields.duplex ?? 'full' } : {}),
    ...(fields.carrierChanges !== undefined ? { carrierChanges: fields.carrierChanges } : {}),
  }
}

/** A four-port AP: `wan` plus `lan1…lan3`, all up at 1 Gb/s unless told otherwise. */
export function apPorts(overrides: Record<string, Partial<PortFields>> = {}) {
  return [
    portReport('wan', { role: 'wan', ...overrides.wan }),
    portReport('lan1', { role: 'lan', ...overrides.lan1 }),
    portReport('lan2', { role: 'lan', ...overrides.lan2 }),
    portReport('lan3', { role: 'lan', ...overrides.lan3 }),
  ]
}

/** The smallest exposition the Wi-Fi ingest accepts. */
export const MINIMAL_METRICS_TEXT = [
  '# TYPE node_boot_time_seconds gauge',
  'node_boot_time_seconds 1789796464',
  '# TYPE node_load1 gauge',
  'node_load1 0.04',
  '',
].join('\n')

/** `metrics.push` params, with `ports` only when given (an old agent sends none). */
export function metricsPush(seq: number, ports?: unknown) {
  return {
    format: 'prometheus-text',
    text: MINIMAL_METRICS_TEXT,
    collectedAt: '2026-09-23T11:20:36Z',
    durationMs: 9,
    seq,
    ...(ports === undefined ? {} : { ports }),
  }
}

/** A scraped Wi-Fi source (node_exporter URL, no agent). */
export async function seedScrapeAp(name = 'ap-scrape') {
  return WifiAccessPoint.create({
    name,
    friendlyName: null,
    metricsUrl: `http://${name}.example.com:9100/metrics`,
    transport: 'scrape',
    pollIntervalSeconds: 15,
    enabled: true,
    enableTwoWayCommands: false,
    sshHost: null,
    sshPort: 22,
    sshUsername: null,
    sshPrivateKey: null,
    model: null,
    openwrtRelease: null,
    nodename: null,
    lastSeenAt: null,
    lastStatus: null,
  })
}

/** An adopted collector that reports gateway stats (it runs on the router). */
export async function seedGatewayCollector(
  overrides: Partial<{
    name: string
    transport: 'poll' | 'agent'
    version: string | null
    portsReported: boolean
    instanceId: string
    apiKey: string | null
    pollIntervalSeconds: number
  }> = {}
) {
  return Collector.create({
    name: overrides.name ?? 'gateway',
    baseUrl: 'http://192.168.1.1:9800',
    transport: overrides.transport ?? 'poll',
    instanceId: overrides.instanceId ?? null,
    source: 'announced',
    lifecycle: 'adopted',
    enabled: true,
    pollIntervalSeconds: overrides.pollIntervalSeconds ?? 5,
    version: overrides.version === undefined ? '0.2.0' : overrides.version,
    apiKey: overrides.apiKey ?? null,
    lastStatus: {
      ok: true,
      checkedAt: DateTime.utc().toISO()!,
      gateway: {
        reportedAt: DateTime.utc().toISO()!,
        wanInterfaces: ['wan0'],
        wanSource: 'default-route',
        ...(overrides.portsReported ? { portsReported: true as const } : {}),
      },
    },
  })
}

/** Sets a row's `last_seen_at` this many seconds ago, as the database counts it. */
export async function setLastSeen(
  table: 'wifi_access_points' | 'collectors',
  id: number,
  secondsAgo: number | null
) {
  await db.rawQuery(
    secondsAgo === null
      ? `UPDATE ${table} SET last_seen_at = NULL WHERE id = ?`
      : `UPDATE ${table} SET last_seen_at = UTC_TIMESTAMP() - INTERVAL ${Math.trunc(secondsAgo)} SECOND WHERE id = ?`,
    [id]
  )
}

/** Every port row of a node, keyed by port key. */
export async function portRows(nodeId: number): Promise<Record<string, any>> {
  const rows = await db.from('infra_ports').where('node_id', nodeId).orderBy('position', 'asc')
  return Object.fromEntries(rows.map((row) => [row.port_key, row]))
}

/** The node bound to an AP or a collector, if any. */
export async function nodeFor(binding: { apId?: number; collectorId?: number }) {
  const query = db.from('infra_nodes')
  if (binding.apId !== undefined) query.where('ap_id', binding.apId)
  if (binding.collectorId !== undefined) query.where('collector_id', binding.collectorId)
  return query.first()
}

/** A manual node straight in the database, with ports `keys` (for state and link tests). */
export async function seedManualNode(
  kind: string,
  name: string,
  keys: string[],
  extra: Record<string, unknown> = {}
): Promise<{ id: number; ports: Record<string, number> }> {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  const [id] = await db.table('infra_nodes').insert({
    kind,
    origin: 'manual',
    name,
    virtual: false,
    hidden: false,
    created_at: now,
    updated_at: now,
    ...extra,
  })
  const ports: Record<string, number> = {}
  for (const [position, key] of keys.entries()) {
    const [portId] = await db.table('infra_ports').insert({
      node_id: id,
      port_key: key,
      origin: 'manual',
      position,
      hidden: false,
      present: true,
      created_at: now,
      updated_at: now,
    })
    ports[key] = Number(portId)
  }
  return { id: Number(id), ports }
}

/** A cable straight in the database. */
export async function seedLink(aPortId: number, bPortId: number, medium = 'ethernet') {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  const [id] = await db.table('infra_links').insert({
    a_port_id: Math.min(aPortId, bPortId),
    b_port_id: Math.max(aPortId, bPortId),
    medium,
    created_at: now,
    updated_at: now,
  })
  return Number(id)
}

/** An agent AP with ports, its session open, reported `secondsAgo` ago. */
export async function onlineAp(
  name: string,
  mac: string,
  ports: unknown[],
  secondsAgo = 5
): Promise<{ apId: number; nodeId: number; ports: Record<string, number>; agent: FakeAgent }> {
  const { ap, agentId, agentSecret } = await seedAgentAp({ name, macs: [mac] })
  const agent = await FakeAgent.connect({ agentId, agentSecret })
  await agent.waitFor('system.info')
  await recordAgentPorts({ type: 'ap', id: ap.id }, ports, DateTime.utc())
  await setLastSeen('wifi_access_points', ap.id, secondsAgo)
  const node = await nodeFor({ apId: ap.id })
  const rows = await db.from('infra_ports').where('node_id', node.id)
  return {
    apId: ap.id,
    nodeId: Number(node.id),
    ports: Object.fromEntries(rows.map((row) => [row.port_key, Number(row.id)])),
    agent,
  }
}

/**
 * A device a collector saw: its identity (`secondsAgo` = its last traffic, as
 * the database counts it) and one traffic bucket then, so it is listed by
 * `/api/v1/devices` over the last hour.
 */
export async function seedDevice(
  collectorId: number,
  mac: string,
  options: { ip?: string | null; secondsAgo?: number } = {}
) {
  const ago = Math.trunc(options.secondsAgo ?? 2)
  const ip = options.ip === undefined ? '192.168.1.20' : options.ip
  await db.rawQuery(
    `INSERT INTO device_identities
       (collector_id, mac, primary_ip, ips, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() - INTERVAL ${ago} SECOND,
             UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [collectorId, mac, ip, JSON.stringify(ip ? [ip] : [])]
  )
  await db.rawQuery(
    `INSERT INTO device_traffic_buckets
       (collector_id, mac, bucket_start, bytes_in, bytes_out, packets_in, packets_out,
        bytes_in_wan, bytes_out_wan, packets_in_wan, packets_out_wan,
        bytes_in_lan, bytes_out_lan, packets_in_lan, packets_out_lan, created_at, updated_at)
     VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL ${Math.max(ago, 2)} SECOND, 1000, 2000, 10, 20,
             1000, 2000, 10, 20, 0, 0, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [collectorId, mac]
  )
}
