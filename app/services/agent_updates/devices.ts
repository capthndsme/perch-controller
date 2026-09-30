import AgentUpdateDevice, { type DeviceFacts } from '#models/agent_update_device'
import Collector from '#models/collector'
import WifiAccessPoint from '#models/wifi_access_point'
import type { AgentProduct } from '#services/agent_updates/manifest'
import type { UpdateReport } from '#services/agent_updates/report'
import { hubFor } from '#services/agent_updates/sessions'
import { deviceKey, type DeviceKind } from '#services/agent_updates/state'
import { sessionCapabilities } from '#services/collector_agent'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The devices agent updates deal with: every AP row with a Perch AP Daemon
 * (`agent_id` set) and every adopted collector, with what the update code
 * needs to know about each. The `agent_update_devices` row (settings, last
 * report) is created on first use.
 */

export type DeviceHandle = {
  kind: DeviceKind
  id: number
  key: string
  name: string
  product: AgentProduct
  role: 'ap' | 'gateway' | 'collector'
  version: string | null
  /** Capabilities of the agent (AP: last system.info; collector: the live hello). */
  capabilities: string[] | null
  /** Collectors: `poll` or `agent`; APs: `agent`. */
  transport: string
  /** Release arch naming (`mipsle`, `amd64`) when the agent told us. */
  arch: string | null
  online: boolean
  secure: boolean | null
  settings: AgentUpdateDevice | null
}

export function productOf(kind: DeviceKind): AgentProduct {
  return kind === 'ap' ? 'perch-apd' : 'perch-collector'
}

function apHandle(ap: WifiAccessPoint, settings: AgentUpdateDevice | null): DeviceHandle {
  const hub = hubFor('ap')
  return {
    kind: 'ap',
    id: ap.id,
    key: deviceKey('ap', ap.id),
    name: ap.friendlyName ?? ap.name,
    product: 'perch-apd',
    role: 'ap',
    version: ap.agentVersion,
    capabilities: ap.agentInfo?.capabilities ?? [],
    transport: 'agent',
    arch: ap.agentInfo?.arch ?? settings?.facts?.arch ?? null,
    online: hub.isOnline(ap.id),
    secure: hub.session(ap.id)?.secure ?? null,
    settings,
  }
}

function collectorHandle(
  collector: Collector,
  settings: AgentUpdateDevice | null,
  gatewayCollectorIds: Set<number>
): DeviceHandle {
  const hub = hubFor('collector')
  return {
    kind: 'collector',
    id: collector.id,
    key: deviceKey('collector', collector.id),
    name: collector.name,
    product: 'perch-collector',
    role: gatewayCollectorIds.has(collector.id) ? 'gateway' : 'collector',
    version: collector.version,
    capabilities: sessionCapabilities(collector.id),
    transport: collector.transport,
    arch: settings?.facts?.arch ?? null,
    online: hub.isOnline(collector.id),
    secure: hub.session(collector.id)?.secure ?? null,
    settings,
  }
}

async function gatewayCollectors(): Promise<Set<number>> {
  const rows = (await db
    .from('gateways')
    .whereNotNull('collector_id')
    .select('collector_id')) as Array<{
    collector_id: number
  }>
  return new Set(rows.map((row) => Number(row.collector_id)))
}

export async function loadDevice(kind: DeviceKind, id: number): Promise<DeviceHandle | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const settings = await AgentUpdateDevice.query()
    .where(kind === 'ap' ? 'ap_id' : 'collector_id', id)
    .first()
  if (kind === 'ap') {
    const ap = await WifiAccessPoint.find(id)
    return ap && ap.agentId ? apHandle(ap, settings) : null
  }
  const collector = await Collector.find(id)
  if (!collector || collector.lifecycle !== 'adopted') return null
  return collectorHandle(collector, settings, await gatewayCollectors())
}

export async function loadAllDevices(): Promise<DeviceHandle[]> {
  const [aps, collectors, rows, gateways] = await Promise.all([
    WifiAccessPoint.query().whereNotNull('agent_id').orderBy('id'),
    Collector.query().where('lifecycle', 'adopted').orderBy('id'),
    AgentUpdateDevice.all(),
    gatewayCollectors(),
  ])
  const byAp = new Map(rows.filter((row) => row.apId !== null).map((row) => [row.apId!, row]))
  const byCollector = new Map(
    rows.filter((row) => row.collectorId !== null).map((row) => [row.collectorId!, row])
  )
  return [
    ...aps.map((ap) => apHandle(ap, byAp.get(ap.id) ?? null)),
    ...collectors.map((collector) =>
      collectorHandle(collector, byCollector.get(collector.id) ?? null, gateways)
    ),
  ]
}

/** The device's settings row, created with defaults when missing. */
export async function ensureDeviceRow(kind: DeviceKind, id: number): Promise<AgentUpdateDevice> {
  const column = kind === 'ap' ? 'ap_id' : 'collector_id'
  const existing = await AgentUpdateDevice.query().where(column, id).first()
  if (existing) return existing
  const row = new AgentUpdateDevice()
  row.apId = kind === 'ap' ? id : null
  row.collectorId = kind === 'collector' ? id : null
  row.channel = null
  row.autoUpdate = 'inherit'
  row.pinnedVersion = null
  row.report = null
  row.reportedAt = null
  row.versionSeen = null
  row.facts = null
  row.updatedAt = DateTime.utc()
  try {
    await row.save()
    return row
  } catch (error) {
    // A concurrent first report created it: read that one.
    const raced = await AgentUpdateDevice.query().where(column, id).first()
    if (raced) return raced
    throw error
  }
}

export function reportOf(device: DeviceHandle): UpdateReport | null {
  return device.settings?.report ?? null
}

export function mergeFacts(current: DeviceFacts | null, next: DeviceFacts): DeviceFacts {
  return { ...(current ?? {}), ...Object.fromEntries(Object.entries(next).filter(([, v]) => v)) }
}
