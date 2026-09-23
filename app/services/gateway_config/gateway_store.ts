import type Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayRevision from '#models/gateway_revision'
import GatewaySection from '#models/gateway_section'
import { contentsEqual, DEFAULT_RULES } from '#services/gateway_config/canonical'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { buildSnapshot, summarizeDiff } from '#services/gateway_config/revisions'
import { applyStateToRow, toSectionState } from '#services/gateway_config/section_rows'
import {
  diffBases,
  FINISHED_APPLY_STATES,
  rollupSyncState,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import {
  actorColumns,
  type GatewayMode,
  type PlaneActor,
  type RevisionSource,
  type RouterAuthor,
  type SectionContent,
} from '#services/gateway_config/types'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Persistence of the config plane's rows (docs/gateway/config-plane.md
 * sections 5 and 9): loading `gateway_sections` as engine states, saving the
 * engine's results, writing revisions and the gateway's `sync_state` rollup.
 * Callers hold the gateway's serial queue.
 */

export type LoadedSections = { rows: GatewaySection[]; states: SectionState[] }

export async function loadSections(
  gatewayId: number,
  trx?: TransactionClientContract
): Promise<LoadedSections> {
  const query = GatewaySection.query({ client: trx })
    .where('gateway_id', gatewayId)
    .orderBy('config')
    .orderBy('position')
    .orderBy('id')
  const rows = await query
  return { rows, states: rows.map(toSectionState) }
}

/** A fresh perch id (12 base32 chars, `^[a-z0-9]+$`) not in `taken`. */
export function perchIdFactory(taken: Iterable<string>): () => string {
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

export type SaveMeta = {
  userId?: number | null
  /** Set on rows whose router content changed. */
  routerAuthor?: RouterAuthor | null
  now?: DateTime
  trx?: TransactionClientContract
}

/**
 * Saves states: rows are matched by perch id; `null` in `after` deletes the
 * row. Rows whose router content changed get `routerAuthor` and
 * `routerChangedAt`; rows whose C changed by an admin get `updatedByUserId`.
 */
export async function saveStates(
  gatewayId: number,
  loaded: GatewaySection[],
  changes: Array<{ perchId: string; after: SectionState | null }>,
  meta: SaveMeta = {}
): Promise<void> {
  const now = meta.now ?? DateTime.utc()
  const byPerch = new Map(loaded.map((r) => [r.perchId, r]))
  // Deletes first: a new row may reuse a (config, name) a deleted one had.
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
    const before = row ? toSectionState(row) : null
    if (!row) {
      row = new GatewaySection()
      row.gatewayId = gatewayId
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

/**
 * Writes a revision when the bases changed between `before` and `after`
 * (section 2: revisions are the linear history of agreed states). Returns
 * the new number, or null when nothing changed. Rows whose base changed get
 * `base_revision` = the new number. `confirmed`: the state is known to work
 * on the router (a live agent reported it, or an apply was confirmed).
 */
export async function writeRevision(
  gateway: Gateway,
  input: {
    before: SectionState[]
    after: SectionState[]
    source: RevisionSource
    userId?: number | null
    /** Instead of `userId`: a user or Perch itself (`{ system: 'qos' }`). */
    actor?: PlaneActor | null
    routerAuthor?: RouterAuthor | null
    applyId?: number | null
    confirmed: boolean
    note?: string | null
    hashes?: Record<string, string> | null
    now?: DateTime
    trx?: TransactionClientContract
  }
): Promise<number | null> {
  const registry = domainRegistry()
  const diff = diffBases(input.before, input.after, registry)
  if (diff.length === 0) return null
  const now = input.now ?? DateTime.utc()
  const number = gateway.headRevision + 1
  const revision = new GatewayRevision()
  if (input.trx) revision.useTransaction(input.trx)
  revision.gatewayId = gateway.id
  revision.number = number
  revision.source = input.source
  const actor = input.actor !== undefined ? actorColumns(input.actor) : null
  revision.authorUserId = actor ? actor.userId : (input.userId ?? null)
  revision.systemActor = actor ? actor.systemActor : null
  revision.routerAuthor = input.routerAuthor ?? null
  revision.summary = summarizeDiff(diff)
  revision.note = input.note ? input.note.slice(0, 500) : null
  revision.snapshot = buildSnapshot(input.after)
  revision.diff = diff
  revision.hashes = input.hashes ?? gateway.observedHashes ?? {}
  revision.applyId = input.applyId ?? null
  revision.confirmedAt = input.confirmed ? now : null
  revision.createdAt = now
  await revision.save()

  gateway.headRevision = number
  if (input.trx) gateway.useTransaction(input.trx)
  await gateway.save()

  const changed = new Set(diff.map((d) => d.perchId).filter((id): id is string => id !== null))
  if (changed.size > 0) {
    await GatewaySection.query({ client: input.trx })
      .where('gateway_id', gateway.id)
      .whereIn('perch_id', [...changed])
      .update({ base_revision: number })
  }
  return number
}

/** The apply in flight (sending or pending_confirm), if any. */
export async function inFlightApply(
  gatewayId: number,
  trx?: TransactionClientContract
): Promise<GatewayApply | null> {
  return GatewayApply.query({ client: trx })
    .where('gateway_id', gatewayId)
    .whereIn('state', ['sending', 'pending_confirm'])
    .orderBy('id', 'desc')
    .first()
}

/** Applies not finished yet (queued, sending, pending_confirm), oldest first. */
export async function openApplies(gatewayId: number): Promise<GatewayApply[]> {
  return GatewayApply.query()
    .where('gateway_id', gatewayId)
    .whereNotIn('state', FINISHED_APPLY_STATES as string[])
    .orderBy('id', 'asc')
}

/** Whether a job of the gateway is not finished yet. */
export async function hasOpenApply(gatewayId: number): Promise<boolean> {
  const open = await openApplies(gatewayId)
  return open.length > 0
}

/** Recomputes `gateways.sync_state` from the rows (section 5.6 rollup). */
export async function refreshSyncState(gateway: Gateway): Promise<void> {
  const [statuses, flight] = await Promise.all([
    GatewaySection.query()
      .where('gateway_id', gateway.id)
      .where('scope', 'synced')
      .select('status'),
    inFlightApply(gateway.id),
  ])
  const next = rollupSyncState({
    mode: gateway.mode as GatewayMode,
    observedAt: gateway.observedAt ? gateway.observedAt.toISO() : null,
    applyInFlight: flight !== null,
    statuses: statuses.map((s) => s.status as SectionState['status']),
  })
  if (next !== gateway.syncState) {
    gateway.syncState = next
    await gateway.save()
  }
}

/** Written content of a job for one section, from the apply row. */
export function writtenFor(apply: GatewayApply, perchId: string): SectionContent | null {
  return apply.written?.[perchId] ?? null
}
