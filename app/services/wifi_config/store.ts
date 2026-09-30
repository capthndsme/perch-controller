import type ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import ApConfigRevision from '#models/ap_config_revision'
import ApConfigSection from '#models/ap_config_section'
import { contentsEqual, DEFAULT_RULES } from '#services/gateway_config/canonical'
import { buildSnapshot, summarizeDiff } from '#services/gateway_config/revisions'
import { GatewaySerialQueue } from '#services/gateway_config/serial_queue'
import {
  diffBases,
  FINISHED_APPLY_STATES,
  rollupSyncState,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import {
  actorColumns,
  SECTION_ISSUES,
  SECTION_SCOPES,
  SECTION_STATUSES,
  type GatewayMode,
  type PlaneActor,
  type RevisionSource,
  type RouterAuthor,
  type SectionIssue,
  type SectionScope,
  type SectionStatus,
} from '#services/gateway_config/types'
import { apRegistry } from '#services/wifi_config/domains/index'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Persistence of the AP plane (docs/design/wifi controller.md sections 2
 * and 4; the gateway's `gateway_store.ts` pattern): `ap_config_sections` as
 * engine states, the engine's results saved back, revisions, and the AP's
 * `sync_state` rollup. Callers hold the AP's serial queue.
 *
 * Two queues:
 * - `apConfigQueue`: everything that changes one AP's rows (reads, merges,
 *   job steps, admin writes, the tick), one task at a time per AP;
 * - `fleetQueue`: fleet-level work (network edits, adoption, divergence
 *   resolutions, rollouts), one at a time. Lock order is fleet → AP: a
 *   fleet task may wait for an AP's queue, an AP task never waits for the
 *   fleet queue (it schedules fleet work instead), so the two cannot
 *   deadlock.
 */
export const apConfigQueue = new GatewaySerialQueue(64, 1024)
export const fleetQueue = new GatewaySerialQueue(256, 4)
/** The one key of `fleetQueue`. */
export const FLEET = 0

/**
 * The async context of module load: no queue held. A queue remembers what
 * a task holds through AsyncLocalStorage, which follows every promise and
 * timer started inside the task; fleet work scheduled from inside an AP's
 * task must start from here, or its own AP calls would look re-entrant and
 * skip that AP's queue.
 */
const outsideQueues = AsyncLocalStorage.snapshot()

/**
 * Queues fleet work without waiting for it (from inside an AP's task),
 * detached from the caller's queue context. Failures are logged.
 */
export function scheduleFleetWork(name: string, task: () => Promise<void>): void {
  outsideQueues(() => {
    fleetQueue.run(FLEET, task).catch((error) => {
      logger.warn({ error: (error as Error).message, task: name }, 'wifi_config: fleet work failed')
    })
  })
}

export type LoadedApSections = { rows: ApConfigSection[]; states: SectionState[] }

/** A row as the engine sees it; unknown union values read as the safest one. */
export function apSectionState(row: ApConfigSection): SectionState {
  const scope = (SECTION_SCOPES as readonly string[]).includes(row.scope)
    ? (row.scope as SectionScope)
    : 'unmodeled'
  const status = (SECTION_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as SectionStatus)
    : 'in_sync'
  const issue =
    row.issue && (SECTION_ISSUES as readonly string[]).includes(row.issue)
      ? (row.issue as SectionIssue)
      : null
  return {
    perchId: row.perchId,
    config: row.config,
    name: row.sectionName,
    type: row.sectionType,
    anonymous: Boolean(row.anonymous),
    scope,
    domain: row.domain,
    ownership: row.ownership && row.ownership.kind === 'options' ? row.ownership : null,
    issue,
    base: row.baseContent,
    baseRevision: row.baseRevision ?? null,
    router: row.routerContent,
    desired: row.desiredContent,
    status,
    conflict: row.conflict,
    driftSince: row.driftSince ? row.driftSince.toUTC().toISO() : null,
    position: row.position ?? null,
  }
}

function applyStateToRow(row: ApConfigSection, state: SectionState): ApConfigSection {
  row.perchId = state.perchId
  row.config = state.config
  row.sectionName = state.name
  row.sectionType = state.desired?.type ?? state.router?.type ?? state.base?.type ?? state.type
  row.anonymous = state.anonymous
  row.scope = state.scope
  row.domain = state.domain
  row.ownership = state.ownership
  row.issue = state.issue
  row.baseContent = state.base
  row.baseRevision = state.baseRevision
  row.routerContent = state.router
  row.desiredContent = state.desired
  row.status = state.status
  row.conflict = state.conflict
  row.driftSince = state.driftSince ? DateTime.fromISO(state.driftSince, { zone: 'utc' }) : null
  row.position = state.position
  return row
}

export async function loadApSections(
  apId: number,
  trx?: TransactionClientContract
): Promise<LoadedApSections> {
  const rows = await ApConfigSection.query({ client: trx })
    .where('ap_id', apId)
    .orderBy('config')
    .orderBy('position')
    .orderBy('id')
  return { rows, states: rows.map(apSectionState) }
}

/** A fresh perch id (12 base32 chars) not in `taken`. */
export function apPerchIdFactory(taken: Iterable<string>): () => string {
  const used = new Set(taken)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  return () => {
    for (;;) {
      let id = ''
      for (const byte of randomBytes(12)) id += alphabet[byte % 32]
      if (!used.has(id)) {
        used.add(id)
        return id
      }
    }
  }
}

export type ApSaveMeta = {
  userId?: number | null
  routerAuthor?: RouterAuthor | null
  now?: DateTime
  trx?: TransactionClientContract
}

/**
 * Saves states by perch id (`after: null` deletes the row). Rows whose
 * router content changed get `routerAuthor`/`routerChangedAt`; rows whose C
 * an admin changed get `updatedByUserId`.
 */
export async function saveApStates(
  apId: number,
  loaded: ApConfigSection[],
  changes: Array<{ perchId: string; after: SectionState | null }>,
  meta: ApSaveMeta = {}
): Promise<void> {
  const now = meta.now ?? DateTime.utc()
  const byPerch = new Map(loaded.map((r) => [r.perchId, r]))
  for (const change of changes) {
    if (change.after) continue
    const row = byPerch.get(change.perchId)
    if (!row) continue
    if (meta.trx) row.useTransaction(meta.trx)
    await row.delete()
    byPerch.delete(change.perchId)
  }
  for (const change of changes) {
    if (!change.after) continue
    let row = byPerch.get(change.perchId)
    const before = row ? apSectionState(row) : null
    if (!row) {
      row = new ApConfigSection()
      row.apId = apId
      row.createdAt = now
    }
    if (meta.trx) row.useTransaction(meta.trx)
    applyStateToRow(row, change.after)
    if (!before || !contentsEqual(before.router, change.after.router, DEFAULT_RULES)) {
      if (change.after.router !== null || before?.router) {
        row.routerAuthor = meta.routerAuthor ?? row.routerAuthor ?? null
        row.routerChangedAt = now
      }
    }
    if (
      meta.userId !== undefined &&
      meta.userId !== null &&
      (!before || !contentsEqual(before.desired, change.after.desired, DEFAULT_RULES))
    ) {
      row.updatedByUserId = meta.userId
    }
    row.updatedAt = now
    await row.save()
    byPerch.set(change.perchId, row)
  }
}

/** Applies changes to a list of states (the "after" view for revisions and validation). */
export function statesAfter(
  before: SectionState[],
  changes: Array<{ perchId: string; after: SectionState | null }>
): SectionState[] {
  const map = new Map(before.map((s) => [s.perchId, s]))
  for (const c of changes) {
    if (c.after) map.set(c.perchId, c.after)
    else map.delete(c.perchId)
  }
  return [...map.values()]
}

/**
 * A revision when the bases changed between `before` and `after`; returns
 * its number or null. Rows whose base changed get `base_revision`.
 */
export async function writeApRevision(
  ap: ApConfig,
  input: {
    before: SectionState[]
    after: SectionState[]
    source: RevisionSource
    actor?: PlaneActor | null
    routerAuthor?: RouterAuthor | null
    applyId?: number | bigint | null
    rolloutId?: number | bigint | null
    confirmed: boolean
    note?: string | null
    hashes?: Record<string, string> | null
    now?: DateTime
    trx?: TransactionClientContract
  }
): Promise<number | null> {
  const registry = apRegistry(ap.capabilities)
  const diff = diffBases(input.before, input.after, registry)
  if (diff.length === 0) return null
  const now = input.now ?? DateTime.utc()
  const number = ap.headRevision + 1
  const revision = new ApConfigRevision()
  if (input.trx) revision.useTransaction(input.trx)
  revision.apId = ap.apId
  revision.number = number
  revision.source = input.source
  const actor = actorColumns(input.actor ?? null)
  revision.authorUserId = actor.userId
  revision.systemActor = actor.systemActor
  revision.routerAuthor = input.routerAuthor ?? null
  revision.summary = summarizeDiff(diff)
  revision.note = input.note ? input.note.slice(0, 500) : null
  revision.snapshot = buildSnapshot(input.after)
  revision.diff = diff
  revision.hashes = input.hashes ?? ap.observedHashes ?? {}
  revision.applyId = input.applyId ?? null
  revision.rolloutId = input.rolloutId ?? null
  revision.confirmedAt = input.confirmed ? now : null
  revision.createdAt = now
  await revision.save()

  ap.headRevision = number
  if (input.trx) ap.useTransaction(input.trx)
  await ap.save()

  const changed = new Set(diff.map((d) => d.perchId).filter((id): id is string => id !== null))
  if (changed.size > 0) {
    await ApConfigSection.query({ client: input.trx })
      .where('ap_id', ap.apId)
      .whereIn('perch_id', [...changed])
      .update({ base_revision: number })
  }
  return number
}

/** The job in flight (sending or pending_confirm), if any. */
export async function inFlightApApply(
  apId: number,
  trx?: TransactionClientContract
): Promise<ApConfigApply | null> {
  return ApConfigApply.query({ client: trx })
    .where('ap_id', apId)
    .whereIn('state', ['sending', 'pending_confirm'])
    .orderBy('id', 'desc')
    .first()
}

/** Jobs not finished yet, oldest first. */
export async function openApApplies(apId: number): Promise<ApConfigApply[]> {
  return ApConfigApply.query()
    .where('ap_id', apId)
    .whereNotIn('state', FINISHED_APPLY_STATES as string[])
    .orderBy('id', 'asc')
}

export async function hasOpenApApply(apId: number): Promise<boolean> {
  const open = await openApApplies(apId)
  return open.length > 0
}

/** Recomputes `ap_configs.sync_state` from the rows (the gateway rollup). */
export async function refreshApSyncState(ap: ApConfig): Promise<void> {
  const [rows, flight] = await Promise.all([
    ApConfigSection.query().where('ap_id', ap.apId).where('scope', 'synced').select('status'),
    inFlightApApply(ap.apId),
  ])
  const next = rollupSyncState({
    mode: ap.mode as GatewayMode,
    observedAt: ap.observedAt ? ap.observedAt.toISO() : null,
    applyInFlight: flight !== null,
    statuses: rows.map((r) => r.status as SectionState['status']),
  })
  if (next !== ap.syncState) {
    ap.syncState = next
    await ap.save()
  }
}
