import {
  INFRA_PORT_MEDIA,
  INFRA_PORT_ROLES,
  type InfraPortMedium,
  type InfraPortRole,
} from '#models/infra_port'
import { isDuplicateEntryError, isMissingParentError } from '#services/db_errors'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'

/**
 * Port reports from the agents (docs/infrastructure-view.md sections 4.4 and
 * 5.2). The Perch AP Daemon sends `ports` with every `metrics.push`, the
 * Gateway agent inside its gateway report; both land here as the same array,
 * are normalised field by field and mirrored into `infra_ports`, one
 * latest-state row per port of the agent's node.
 *
 * Almost every report is identical to the one before it, so the process
 * remembers a fingerprint of the last report it wrote per agent and skips the
 * database while nothing changed: in steady state a report costs a map
 * lookup. A report without a `ports` array (agents older than the feature)
 * writes nothing and forgets nothing.
 */

/** Most ports one report may carry; the rest are dropped. */
export const MAX_AGENT_PORTS = 64
/** A port key: the netdev name for agent ports, the operator's key for manual ones. */
export const PORT_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,31}$/
export const PORT_LABEL_MAX_LENGTH = 48
/** Agents whose last report is remembered; the least recently written is evicted first. */
export const MAX_REMEMBERED_REPORTS = 256

const OPERSTATE_MAX_LENGTH = 16
const MAX_SPEED_MBPS = 1_000_000
const MAX_CARRIER_CHANGES = 2 ** 31 - 1
/** Entries looked at per report, junk included, so no report can make the server loop. */
const MAX_SCANNED_ENTRIES = 1024
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** One port as an agent reports it, after normalisation (section 4.4). */
export type PortReport = {
  name: string
  label?: string
  role?: InfraPortRole
  medium?: InfraPortMedium
  mac?: string
  adminUp?: boolean
  carrier?: boolean
  operstate?: string
  speedMbps?: number
  duplex?: 'full' | 'half'
  carrierChanges?: number
}

/** The agent row a report speaks for; the node is looked up (or created) from it. */
export type PortBinding = { type: 'ap'; id: number } | { type: 'collector'; id: number }

// ── normalisation ─────────────────────────────────────────────────────────

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  return cleaned.length > 0 && cleaned.length <= maxLength ? cleaned : undefined
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function mac(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().toLowerCase().replace(/-/g, ':')
  return MAC_REGEX.test(cleaned) ? cleaned : undefined
}

/** One entry, or null when it has no usable name. Other bad fields are dropped one by one. */
export function normalizePort(entry: unknown): PortReport | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
  const raw = entry as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!PORT_KEY_REGEX.test(name)) return null

  const candidates: Omit<PortReport, 'name'> = {
    label: text(raw.label, PORT_LABEL_MAX_LENGTH),
    role: oneOf(raw.role, INFRA_PORT_ROLES),
    medium: oneOf(raw.medium, INFRA_PORT_MEDIA),
    mac: mac(raw.mac),
    adminUp: typeof raw.adminUp === 'boolean' ? raw.adminUp : undefined,
    carrier: typeof raw.carrier === 'boolean' ? raw.carrier : undefined,
    operstate: text(raw.operstate, OPERSTATE_MAX_LENGTH),
    speedMbps: integer(raw.speedMbps, 1, MAX_SPEED_MBPS),
    duplex: oneOf(raw.duplex, ['full', 'half'] as const),
    carrierChanges: integer(raw.carrierChanges, 0, MAX_CARRIER_CHANGES),
  }
  // Fixed key order: the fingerprint of a report depends on it.
  const port: PortReport = { name }
  for (const [key, value] of Object.entries(candidates)) {
    if (value !== undefined) (port as Record<string, unknown>)[key] = value
  }
  return port
}

/**
 * A report as the controller keeps it: valid entries only, the first of two
 * names that differ only in case (the keys are case-insensitive, like the
 * unique index), at most `MAX_AGENT_PORTS`, in the agent's order (which is its
 * display order).
 */
export function normalizePortReport(ports: readonly unknown[]): PortReport[] {
  const out: PortReport[] = []
  const seen = new Set<string>()
  for (const entry of ports.slice(0, MAX_SCANNED_ENTRIES)) {
    if (out.length >= MAX_AGENT_PORTS) break
    const port = normalizePort(entry)
    if (!port) continue
    const key = port.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(port)
  }
  return out
}

export function reportFingerprint(report: PortReport[]): string {
  return createHash('sha1').update(JSON.stringify(report)).digest('base64')
}

// ── the last report per agent ─────────────────────────────────────────────

type RememberedReport = { fingerprint: string; nodeId: number }

/**
 * The fingerprint of the last report written per agent (`ap:4`,
 * `collector:1`), bounded: at most `limit` agents, the least recently written
 * evicted first. Lost on restart, which costs one full upsert per agent.
 */
export class ReportFingerprints {
  readonly #entries = new Map<string, RememberedReport>()

  constructor(readonly limit: number = MAX_REMEMBERED_REPORTS) {}

  get(key: string): RememberedReport | undefined {
    return this.#entries.get(key)
  }

  set(key: string, entry: RememberedReport): void {
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  delete(key: string): void {
    this.#entries.delete(key)
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}

const remembered = new ReportFingerprints()

function bindingKey(binding: PortBinding): string {
  return `${binding.type}:${binding.id}`
}

/**
 * Makes the next report of this agent go to the database even when it is
 * identical to the last one: after its node changed (bind), or after an
 * operator edit of its ports.
 */
export function forgetAgentPorts(binding: PortBinding): void {
  remembered.delete(bindingKey(binding))
}

/** Test-only: forget the per-agent last-report cache. */
export function _resetInfraPortsState(): void {
  remembered.clear()
}

// ── nodes ─────────────────────────────────────────────────────────────────

function sqlNow(at: DateTime = DateTime.utc()): string {
  return at.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

/**
 * The node bound to this agent row, created (unplaced, unnamed) when it has
 * none. Concurrent callers settle on the unique index. Null when the agent row
 * no longer exists.
 */
export async function ensureNodeFor(binding: PortBinding): Promise<number | null> {
  const column = binding.type === 'ap' ? 'ap_id' : 'collector_id'
  const find = async () => {
    const row = await db.from('infra_nodes').where(column, binding.id).select('id').first()
    return row ? Number(row.id) : null
  }

  const existing = await find()
  if (existing !== null) return existing

  const now = sqlNow()
  try {
    await db.table('infra_nodes').insert({
      kind: binding.type === 'ap' ? 'access_point' : 'gateway',
      origin: 'agent',
      [column]: binding.id,
      virtual: false,
      hidden: false,
      created_at: now,
      updated_at: now,
    })
  } catch (error) {
    // Someone else created it first, or the agent row is gone.
    if (!isDuplicateEntryError(error) && !isMissingParentError(error)) throw error
  }
  return find()
}

// ── ingest ────────────────────────────────────────────────────────────────

type PortRow = {
  id: number
  port_key: string
  origin: string
  label: string | null
  role: string | null
  medium: string | null
  reported_label: string | null
  reported_role: string | null
  reported_medium: string | null
  mac: string | null
  hidden: number | boolean
  present: number | boolean
  admin_up: number | boolean | null
  carrier: number | boolean | null
  operstate: string | null
  speed_mbps: number | null
  duplex: string | null
  carrier_changes: number | null
}

function flag(value: number | boolean | null | undefined): boolean | null {
  return value === null || value === undefined ? null : Boolean(Number(value))
}

function count(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** The live-state columns of one reported port; a field the agent left out is unknown. */
function stateColumns(port: PortReport) {
  return {
    admin_up: port.adminUp ?? null,
    carrier: port.carrier ?? null,
    operstate: port.operstate ?? null,
    speed_mbps: port.speedMbps ?? null,
    duplex: port.duplex ?? null,
    carrier_changes: port.carrierChanges ?? null,
  }
}

/**
 * Writes one report onto the node's ports (section 5.2 step 4), in one
 * transaction. Returns the number of rows inserted, updated or deleted.
 *
 * - A reported port is inserted, or updated where it differs: the agent's
 *   label, role and medium (the operator's overrides are other columns),
 *   MAC, live state, `present`. `state_changed_at` moves only when carrier,
 *   speed, duplex or operstate changed. `position` is the report order when
 *   the port first appears (or is adopted); after that it is the operator's
 *   (amendment A2).
 * - A manual port with a reported key is adopted: it becomes the agent's,
 *   keeps the operator's label, role, hidden flag and cable, and shows the
 *   agent's medium.
 * - Agent ports the report does not name are marked missing; those that hold
 *   nothing of the operator's (no cable, label, role, medium, not hidden) are
 *   deleted.
 */
async function applyReport(
  trx: TransactionClientContract,
  nodeId: number,
  report: PortReport[],
  at: DateTime
): Promise<number> {
  const atSql = sqlNow(at)
  const rows = (await trx
    .from('infra_ports')
    .where('node_id', nodeId)
    .forUpdate()
    .select(
      'id',
      'port_key',
      'origin',
      'label',
      'role',
      'medium',
      'reported_label',
      'reported_role',
      'reported_medium',
      'mac',
      'hidden',
      'present',
      'admin_up',
      'carrier',
      'operstate',
      'speed_mbps',
      'duplex',
      'carrier_changes'
    )) as PortRow[]
  const byKey = new Map(rows.map((row) => [row.port_key.toLowerCase(), row]))
  const reported = new Set<string>()
  let changed = 0

  for (const [index, port] of report.entries()) {
    const key = port.name.toLowerCase()
    reported.add(key)
    const state = stateColumns(port)
    const existing = byKey.get(key)

    if (!existing) {
      await trx.table('infra_ports').insert({
        node_id: nodeId,
        port_key: port.name,
        origin: 'agent',
        reported_label: port.label ?? null,
        reported_role: port.role ?? null,
        reported_medium: port.medium ?? null,
        mac: port.mac ?? null,
        position: index,
        hidden: false,
        present: true,
        ...state,
        state_changed_at: atSql,
        reported_at: atSql,
        created_at: atSql,
        updated_at: atSql,
      })
      changed += 1
      continue
    }

    const patch: Record<string, unknown> = {}
    const put = (column: string, current: unknown, next: unknown) => {
      if (current !== next) patch[column] = next
    }
    if (existing.origin !== 'agent') {
      patch.origin = 'agent'
      patch.position = index
      patch.medium = null
    }
    put('port_key', existing.port_key, port.name)
    put('reported_label', existing.reported_label, port.label ?? null)
    put('reported_role', existing.reported_role, port.role ?? null)
    put('reported_medium', existing.reported_medium, port.medium ?? null)
    put('mac', existing.mac, port.mac ?? null)
    put('admin_up', flag(existing.admin_up), state.admin_up)
    put('carrier', flag(existing.carrier), state.carrier)
    put('operstate', existing.operstate, state.operstate)
    put('speed_mbps', count(existing.speed_mbps), state.speed_mbps)
    put('duplex', existing.duplex, state.duplex)
    put('carrier_changes', count(existing.carrier_changes), state.carrier_changes)
    if ('carrier' in patch || 'operstate' in patch || 'speed_mbps' in patch || 'duplex' in patch) {
      patch.state_changed_at = atSql
    }
    if (!flag(existing.present)) {
      patch.present = true
      patch.missing_since = null
    }
    if (Object.keys(patch).length === 0) continue

    patch.reported_at = atSql
    patch.updated_at = atSql
    await trx.from('infra_ports').where('id', existing.id).update(patch)
    changed += 1
  }

  const missing = rows.filter(
    (row) => row.origin === 'agent' && !reported.has(row.port_key.toLowerCase())
  )
  const newlyMissing = missing.filter((row) => flag(row.present))
  if (newlyMissing.length > 0) {
    await trx
      .from('infra_ports')
      .whereIn(
        'id',
        newlyMissing.map((row) => row.id)
      )
      .update({
        present: false,
        missing_since: trx.raw('COALESCE(missing_since, ?)', [atSql]),
        updated_at: atSql,
      })
    changed += newlyMissing.length
  }

  const unclaimed = missing.filter(
    (row) => row.label === null && row.role === null && row.medium === null && !flag(row.hidden)
  )
  if (unclaimed.length > 0) {
    const ids = unclaimed.map((row) => row.id)
    const cabled = new Set<number>()
    const links = (await trx
      .from('infra_links')
      .whereIn('a_port_id', ids)
      .orWhereIn('b_port_id', ids)
      .forUpdate()
      .select('a_port_id', 'b_port_id')) as Array<{ a_port_id: number; b_port_id: number }>
    for (const link of links) {
      cabled.add(Number(link.a_port_id))
      cabled.add(Number(link.b_port_id))
    }
    const prune = ids.filter((id) => !cabled.has(id))
    if (prune.length > 0) {
      await trx.from('infra_ports').whereIn('id', prune).delete()
      changed += prune.length
    }
  }

  return changed
}

/**
 * One port report of an agent (section 5.2). `ports` is the raw value from
 * the push or the gateway report: anything but an array (an agent that does
 * not report ports) writes nothing and returns null, so an old agent never
 * erases what a newer one reported. A report identical to the last one this
 * process wrote for the agent returns without touching the database
 * (`changed: 0`). Throws on a database error: callers log it and carry on,
 * and the next report tries again.
 */
export async function recordAgentPorts(
  binding: PortBinding,
  ports: unknown,
  at: DateTime
): Promise<{ nodeId: number; changed: number } | null> {
  if (!Array.isArray(ports)) return null
  const report = normalizePortReport(ports)
  const key = bindingKey(binding)
  const fingerprint = reportFingerprint(report)
  const last = remembered.get(key)
  if (last && last.fingerprint === fingerprint) return { nodeId: last.nodeId, changed: 0 }

  const nodeId = await ensureNodeFor(binding)
  if (nodeId === null) return null
  const changed = await db.transaction((trx) => applyReport(trx, nodeId, report, at))
  remembered.set(key, { fingerprint, nodeId })
  return { nodeId, changed }
}
