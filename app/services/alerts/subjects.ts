import type { AlertSubject, SubjectKind } from '#services/alerts/model'
import { SUBJECT_KINDS } from '#services/alerts/model'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'

/**
 * Subjects of alerts (events.md §1.2): keys, soft references, labels and the
 * dashboard path of each kind.
 *
 * Key `<kind>:<ref>`: `collector:<id>`, `ap:<id>`, `gateway:<id>`,
 * `network:<gatewayId>:<name>`, `ssid:<name>`, `device:<mac>`,
 * `port:<infra_ports.id>`, `portal:<id>`, `terminal:<id>`, `controller`.
 * `subject_ref` is everything after the first colon.
 */

export function subjectRef(subject: AlertSubject): string {
  switch (subject.kind) {
    case 'collector':
    case 'ap':
    case 'gateway':
    case 'port':
    case 'portal':
    case 'terminal':
      return String(subject.id)
    case 'network':
      return `${subject.gatewayId}:${subject.name}`
    case 'ssid':
      return subject.name
    case 'device':
      return subject.mac.toLowerCase()
    case 'controller':
      return ''
  }
}

export function subjectKey(subject: AlertSubject): string {
  return subject.kind === 'controller' ? 'controller' : `${subject.kind}:${subjectRef(subject)}`
}

export function isSubjectKind(value: unknown): value is SubjectKind {
  return typeof value === 'string' && (SUBJECT_KINDS as readonly string[]).includes(value)
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/** The subject a stored `(kind, ref)` pair names, or null when it does not parse. */
export function subjectFromRef(kind: string, ref: string): AlertSubject | null {
  const id = /^\d+$/.test(ref) ? Number(ref) : Number.NaN
  switch (kind) {
    case 'collector':
    case 'ap':
    case 'gateway':
    case 'port':
    case 'portal':
    case 'terminal':
      return Number.isSafeInteger(id) ? ({ kind, id } as AlertSubject) : null
    case 'network': {
      const colon = ref.indexOf(':')
      const gatewayId = Number(ref.slice(0, colon))
      const name = ref.slice(colon + 1)
      if (colon < 1 || !Number.isSafeInteger(gatewayId) || !name) return null
      return { kind, gatewayId, name }
    }
    case 'ssid':
      return ref ? { kind, name: ref } : null
    case 'device':
      return MAC.test(ref.toLowerCase()) ? { kind, mac: ref.toLowerCase() } : null
    case 'controller':
      return { kind }
    default:
      return null
  }
}

/** Parses the `subject` query parameter form `<kind>:<ref>` (`controller` alone). */
export function parseSubjectKey(value: string): AlertSubject | null {
  if (value === 'controller') return { kind: 'controller' }
  const colon = value.indexOf(':')
  if (colon < 1) return null
  return subjectFromRef(value.slice(0, colon), value.slice(colon + 1))
}

/** Checks the fields a subject needs; used on emit (other areas' input). */
export function validSubject(subject: unknown): subject is AlertSubject {
  if (typeof subject !== 'object' || subject === null) return false
  const s = subject as Record<string, unknown>
  const positiveInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
  switch (s.kind) {
    case 'collector':
    case 'ap':
    case 'gateway':
    case 'port':
    case 'portal':
    case 'terminal':
      return positiveInt(s.id)
    case 'network':
      return (
        positiveInt(s.gatewayId) &&
        typeof s.name === 'string' &&
        s.name.length > 0 &&
        s.name.length <= 48
      )
    case 'ssid':
      return typeof s.name === 'string' && s.name.length > 0 && s.name.length <= 63
    case 'device':
      return typeof s.mac === 'string' && MAC.test(s.mac.toLowerCase())
    case 'controller':
      return true
    default:
      return false
  }
}

/** Dashboard path of a subject (events.md §1.2); a type may override it in `render`. */
export function pathFor(subject: AlertSubject, extra: { nodeId?: number | null } = {}): string {
  switch (subject.kind) {
    case 'collector':
      return '/settings/collectors'
    case 'ap':
      return `/wifi/aps/${subject.id}`
    case 'gateway':
      return `/gateway/config/${subject.id}`
    case 'network':
      return '/networks'
    case 'ssid':
      return '/wifi'
    case 'device':
      return `/devices/${subject.mac}`
    case 'port':
      return extra.nodeId ? `/infrastructure?node=${extra.nodeId}` : '/infrastructure'
    case 'portal':
      return `/portal/portals/${subject.id}`
    case 'terminal':
      return '/portal/terminals'
    case 'controller':
      return '/settings'
  }
}

export type SubjectLabel = { label: string | null; path: string }

/**
 * Bounded cache of resolved labels (1000 entries, 5 minutes): labels are
 * snapshots at raise time, so a slightly stale name is fine and a detector
 * tick does not cost one query per subject.
 */
const LABEL_TTL_MS = 5 * 60_000
const LABEL_MAX = 1000
const labelCache = new Map<string, { value: SubjectLabel; at: number }>()

export function _resetSubjectLabels(): void {
  labelCache.clear()
}

/**
 * The label and path of a subject (events.md §1.2): collector `name`; AP
 * `friendly_name ?? name`; gateway = its collector's name; device = device
 * label → gateway host name → MAC; port = `<node name> <port label ??
 * port_key>`; portal / terminal `name`. A label never blocks an emit: any
 * failure falls back to no label.
 */
export async function resolveSubjectLabel(subject: AlertSubject): Promise<SubjectLabel> {
  const key = subjectKey(subject)
  const cached = labelCache.get(key)
  if (cached && Date.now() - cached.at < LABEL_TTL_MS) {
    labelCache.delete(key)
    labelCache.set(key, cached)
    return cached.value
  }
  let value: SubjectLabel
  try {
    value = await lookupLabel(subject)
  } catch (error) {
    logger.debug({ err: error, subject: key }, 'alerts: subject label lookup failed')
    value = { label: null, path: pathFor(subject) }
  }
  labelCache.set(key, { value, at: Date.now() })
  while (labelCache.size > LABEL_MAX) {
    const oldest = labelCache.keys().next().value
    if (oldest === undefined) break
    labelCache.delete(oldest)
  }
  return value
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

async function lookupLabel(subject: AlertSubject): Promise<SubjectLabel> {
  const path = pathFor(subject)
  switch (subject.kind) {
    case 'collector': {
      const row = await db.from('collectors').select('name').where('id', subject.id).first()
      return { label: str(row?.name), path }
    }
    case 'ap': {
      const row = await db
        .from('wifi_access_points')
        .select('friendly_name', 'name')
        .where('id', subject.id)
        .first()
      return { label: str(row?.friendly_name) ?? str(row?.name), path }
    }
    case 'gateway': {
      const row = await db
        .from('gateways')
        .join('collectors', 'collectors.id', 'gateways.collector_id')
        .select('collectors.name as name')
        .where('gateways.id', subject.id)
        .first()
      return { label: str(row?.name), path }
    }
    case 'network':
      return { label: subject.name, path }
    case 'ssid':
      return { label: subject.name, path }
    case 'device': {
      const mac = subject.mac.toLowerCase()
      const labelRow = await db.from('device_labels').select('name').where('mac', mac).first()
      const named = str(labelRow?.name)
      if (named) return { label: named, path }
      const host = await db
        .from('gateway_hosts')
        .select('hostname', 'static_name')
        .where('mac', mac)
        .orderBy('last_reported_at', 'desc')
        .first()
      return { label: str(host?.static_name) ?? str(host?.hostname) ?? mac, path }
    }
    case 'port': {
      const row = await db
        .from('infra_ports')
        .join('infra_nodes', 'infra_nodes.id', 'infra_ports.node_id')
        .select(
          'infra_nodes.id as node_id',
          'infra_nodes.name as node_name',
          'infra_ports.label',
          'infra_ports.reported_label',
          'infra_ports.port_key'
        )
        .where('infra_ports.id', subject.id)
        .first()
      if (!row) return { label: null, path }
      const port =
        str(row.label) ?? str(row.reported_label) ?? str(row.port_key) ?? `#${subject.id}`
      const node = str(row.node_name)
      return {
        label: node ? `${node} ${port}` : port,
        path: pathFor(subject, { nodeId: Number(row.node_id) }),
      }
    }
    case 'portal': {
      const row = await db.from('portals').select('name').where('id', subject.id).first()
      return { label: str(row?.name), path }
    }
    case 'terminal': {
      const row = await db.from('hotspot_terminals').select('name').where('id', subject.id).first()
      return { label: str(row?.name), path }
    }
    case 'controller':
      return { label: 'Perch', path }
  }
}
