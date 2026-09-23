import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayRevision from '#models/gateway_revision'
import { sendCollectorConfigure } from '#services/collector_agent'
import {
  planSectionEdits,
  EditRefusedError,
  type EditSectionsResult,
} from '#services/gateway_config/apply_plan'
import { validateStates } from '#services/gateway_config/apply_lifecycle'
import { cloneContent, contentsEqual } from '#services/gateway_config/canonical'
import { SectionEditError, type SectionEdit } from '#services/gateway_config/domain'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import {
  fetchCapabilities,
  GatewayOfflineError,
  lastConfirmedRevision,
  offerRejoin,
  readAndReconcile,
  type ReadOutcome,
} from '#services/gateway_config/gateway_agent'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import {
  gatewaySession,
  normalizeMode,
  setConfigureBlock,
  writeAccess,
} from '#services/gateway_config/gateway_registry'
import {
  hasOpenApply,
  inFlightApply,
  loadSections,
  perchIdFactory,
  refreshSyncState,
  saveStates,
  writeRevision,
} from '#services/gateway_config/gateway_store'
import {
  findOrder,
  loadOrders,
  refreshOrders,
  saveOrder,
} from '#services/gateway_config/order_store'
import { clearPairing } from '#services/gateway_config/pairing'
import { planRestore } from '#services/gateway_config/revisions'
import { featureObservation, readObservedFacts } from '#services/gateway_config/observed_facts'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import {
  acceptDrift,
  checkEnableAuthoritative,
  checkModeChange,
  computeSyncStatus,
  featureSyncIssues,
  computeUnledgered,
  deriveStatus,
  isGone,
  resolveConflict,
  type ConflictResolution,
  type OptionResolution,
  type SectionState,
  type SyncStatus,
} from '#services/gateway_config/sync_engine'
import type { GatewayMode, Issue, UciValue } from '#services/gateway_config/types'
import {
  orderMembers,
  resolveOrder,
  setDesiredOrder,
  type OrderKey,
  type OrderState,
} from '#services/gateway_config/section_order'
import type User from '#models/user'
import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The admin operations of the config plane (docs/gateway/config-plane.md
 * sections 5 and 10): modes and Authoritative Mode, sync status, conflicts,
 * drift, scope, drafts, revisions, rejoin, and `editSections`, the single
 * write entry point for domain REST handlers. Everything runs inside the
 * gateway's serial queue.
 */

export async function findGateway(id: number): Promise<Gateway> {
  const gateway = await Gateway.find(id)
  if (!gateway) throw planeError(404, 'gateway_not_found', `No gateway with id ${id}.`)
  return gateway
}

function authoritativeOf(gateway: Gateway): boolean {
  return normalizeMode(gateway.mode) === 'managed' && Boolean(gateway.authoritative)
}

async function pushConfigure(gateway: Gateway) {
  setConfigureBlock(gateway, await getGatewayConfigSettings())
  if (gateway.collectorId === null) return
  const collector = await Collector.find(gateway.collectorId)
  if (collector) sendCollectorConfigure(collector)
}

async function verifyPassword(user: User, password: string | undefined): Promise<boolean> {
  if (!password) return false
  return hash.verify(user.password, password)
}

// ── modes ────────────────────────────────────────────────────────────────

export type GatewayPatch = {
  mode?: GatewayMode
  authoritative?: boolean
  expectRevision?: number
  currentPassword?: string
}

/**
 * `PATCH /gateways/:id` (sections 5.4 and 5.6): mode changes (off → observe
 * needs the router's read access; → managed needs write access, a writable
 * transport and the step-up password; → off and down are always allowed),
 * and Authoritative Mode (ON only when a fresh read says both sides are in
 * sync and nothing moved since the admin looked; OFF any time).
 */
export async function patchGateway(
  gatewayId: number,
  user: User,
  patch: GatewayPatch
): Promise<Gateway> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    const settings = await getGatewayConfigSettings()
    const from = normalizeMode(gateway.mode)
    const to = patch.mode ?? from
    const needsPassword = (to === 'managed' && from !== 'managed') || patch.authoritative === true
    if (needsPassword && !(await verifyPassword(user, patch.currentPassword))) {
      throw planeError(403, 'invalid_password', 'Confirm with your current password.')
    }

    if (to !== from) {
      if (from === 'managed' && (await hasOpenApply(gateway.id))) {
        throw planeError(409, 'apply_in_flight', 'Wait for the running apply to finish.')
      }
      const session = gatewaySession(gateway.collectorId)
      if (to !== 'off' && !session) {
        throw planeError(409, 'agent_offline', 'The gateway agent is not connected.')
      }
      if (to === 'managed' && gateway.capabilities?.capable === true) {
        // The router's opt-ins as they are now (config_allow_insecure).
        await fetchCapabilities(gateway).catch(() => undefined)
      }
      const access = writeAccess(gateway, settings)
      const error = checkModeChange(from, to, {
        hasCapability: gateway.capabilities?.capable !== false,
        routerAccess: session?.hello.access ?? (gateway.agentAccess as 'none' | 'read' | 'write'),
        transportOk:
          access.writable ||
          (access.reason !== 'insecure_transport' &&
            access.reason !== 'sign_key_unknown' &&
            access.reason !== 'not_paired'),
        passwordVerified: true,
      })
      if (error === 'router_access_insufficient') {
        throw planeError(
          409,
          'router_access_insufficient',
          `The router allows '${session?.hello.access ?? 'none'}' access; set config_access on the router.`
        )
      }
      if (error === 'insecure_transport') {
        if (!access.writable && access.reason === 'not_paired') {
          throw planeError(
            409,
            'not_paired',
            'Pair the gateway with this controller first (plain HTTP writes are signed).'
          )
        }
        throw planeError(
          409,
          'insecure_transport',
          'Managed mode needs verified TLS, or the plain-HTTP opt-in on both ends.'
        )
      }
      if (error === 'no_capability') {
        throw planeError(409, 'no_capability', 'The collector has no config plane.')
      }
      gateway.mode = to
      if (to !== 'managed' && gateway.authoritative) {
        gateway.authoritative = false
        gateway.authoritativeSince = null
        gateway.authoritativeByUserId = null
      }
      await gateway.save()
      await recordGatewayEvent(gateway.id, 'mode_changed', {
        userId: user.id,
        detail: { from, to },
      })
      if (to === 'off') {
        gateway.syncState = 'unknown'
        await gateway.save()
      }
      await pushConfigure(gateway)
      if (to !== 'off') {
        await readAndReconcile(gateway.id, { reason: 'mode' }).catch((e) => {
          if (!(e instanceof GatewayOfflineError)) throw e
        })
      }
    }

    if (patch.authoritative === true && !gateway.authoritative) {
      await enableAuthoritative(gateway, user, patch.expectRevision)
    } else if (patch.authoritative === false && gateway.authoritative) {
      gateway.authoritative = false
      gateway.authoritativeSince = null
      gateway.authoritativeByUserId = null
      gateway.pinnedHashes = null
      await gateway.save()
      await recordGatewayEvent(gateway.id, 'authoritative_changed', {
        userId: user.id,
        detail: { authoritative: false },
      })
      await pushConfigure(gateway)
      // Drifted sections are two-way edits again: the next read imports them.
      await readAndReconcile(gateway.id, { reason: 'authoritative_off' }).catch(() => undefined)
    }
    await gateway.refresh()
    await refreshSyncState(gateway)
    return gateway
  })
}

/**
 * Section 5.4 steps 1–5, inside the queue: a fresh read, the blockers, the
 * head revision the admin saw, then the flag in one transaction with the
 * gateway row locked, then `agent.configure`. A router edit after the read
 * is drift under the new mode, never a silent enable.
 */
async function enableAuthoritative(
  gateway: Gateway,
  user: User,
  expectRevision: number | undefined
): Promise<void> {
  if (normalizeMode(gateway.mode) !== 'managed') {
    throw planeError(409, 'not_managed', 'Authoritative Mode needs managed mode.')
  }
  if (expectRevision === undefined) {
    throw planeError(422, 'expect_revision_required', 'Send the head revision you reviewed.')
  }
  if (!gatewaySession(gateway.collectorId)) {
    throw planeError(409, 'agent_offline', 'The gateway agent is not connected.')
  }
  if ((await inFlightApply(gateway.id)) !== null) {
    throw planeError(409, 'apply_in_flight', 'Wait for the running apply to finish.')
  }
  const outcome = await readAndReconcile(gateway.id, { reason: 'enable_authoritative' })
  await gateway.refresh()
  const status = await syncStatusOf(gateway)
  const check = checkEnableAuthoritative(status, expectRevision)
  if (!check.ok) {
    if (check.error === 'sync_changed') {
      throw planeError(409, 'sync_changed', 'The configuration changed since you looked.', {
        blockers: check.blockers,
        headRevision: check.headRevision,
      })
    }
    throw planeError(409, 'not_in_sync', 'Both sides must be in sync first.', {
      blockers: check.blockers,
    })
  }
  const pinned = Object.fromEntries(outcome.read.configs.map((c) => [c.name, c.hash]))
  await db.transaction(async (trx) => {
    const locked = await Gateway.query({ client: trx })
      .where('id', gateway.id)
      .forUpdate()
      .firstOrFail()
    locked.authoritative = true
    locked.authoritativeSince = DateTime.utc()
    locked.authoritativeByUserId = user.id
    locked.pinnedHashes = pinned
    locked.enforcement = 'active'
    await locked.save()
    await recordGatewayEvent(gateway.id, 'authoritative_changed', {
      userId: user.id,
      revision: status.headRevision,
      detail: { authoritative: true },
      trx,
    })
  })
  await gateway.refresh()
  await pushConfigure(gateway)
}

// ── sync status ──────────────────────────────────────────────────────────

async function syncStatusOf(gateway: Gateway): Promise<SyncStatus> {
  const { states } = await loadSections(gateway.id)
  const online = gatewaySession(gateway.collectorId) !== null
  return computeSyncStatus({
    mode: normalizeMode(gateway.mode),
    online,
    enforcement: gateway.enforcement === 'suspended' ? 'suspended' : 'active',
    headRevision: gateway.headRevision,
    observedAt: gateway.observedAt?.toISO() ?? null,
    applyInFlight: await hasOpenApply(gateway.id),
    luciPending: gateway.observedState?.luciPending ?? false,
    uncommitted: gateway.observedState?.uncommitted ?? [],
    sections: states,
    unledgered: computeUnledgered(states, gateway.observedLedger ?? []),
    registry: domainRegistry(),
    orders: await loadOrders(gateway.id),
    features: featureSyncIssues(
      domainRegistry(),
      states,
      featureObservation(await readObservedFacts(gateway.collectorId))
    ),
  })
}

/** `GET /gateways/:id/sync-status?fresh=` (section 5.4). */
export async function syncStatus(gatewayId: number, fresh: boolean): Promise<SyncStatus> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    if (fresh) {
      if (!gatewaySession(gateway.collectorId)) {
        throw planeError(409, 'agent_offline', 'The gateway agent is not connected.')
      }
      if (normalizeMode(gateway.mode) !== 'off') {
        await readAndReconcile(gateway.id, { reason: 'sync_status' })
        await gateway.refresh()
      }
    }
    return syncStatusOf(gateway)
  })
}

/** `POST /gateways/:id/refresh`: capabilities and a fresh read. */
export async function refreshGateway(
  gatewayId: number
): Promise<{ capabilities: unknown; observedAt: string | null; changedConfigs: string[] }> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    if (!gatewaySession(gateway.collectorId)) {
      throw planeError(409, 'agent_offline', 'The gateway agent is not connected.')
    }
    const capabilities = await fetchCapabilities(gateway)
    let outcome: ReadOutcome | null = null
    if (normalizeMode(gateway.mode) === 'off') {
      throw planeError(409, 'mode_off', 'Turn the gateway to observe or managed first.', {
        capabilities,
      })
    }
    outcome = await readAndReconcile(gateway.id, { reason: 'refresh' })
    return {
      capabilities,
      observedAt: outcome.observedAt,
      changedConfigs: outcome.changedConfigs,
    }
  })
}

// ── rows: edits, conflicts, drift, scope, draft ──────────────────────────

function requireManaged(gateway: Gateway) {
  if (normalizeMode(gateway.mode) !== 'managed') {
    throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
  }
}

async function saveWithRevision(
  gateway: Gateway,
  loaded: Awaited<ReturnType<typeof loadSections>>,
  changes: Array<{ perchId: string; after: SectionState | null }>,
  revision: { source: 'router' | 'merge' | 'controller'; userId: number; confirmed: boolean } | null
): Promise<number | null> {
  const now = DateTime.utc()
  let number: number | null = null
  await db.transaction(async (trx) => {
    await saveStates(gateway.id, loaded.rows, changes, { userId: revision?.userId, now, trx })
    if (revision) {
      const after = new Map(loaded.states.map((s) => [s.perchId, s]))
      for (const c of changes) {
        if (c.after) after.set(c.perchId, c.after)
        else after.delete(c.perchId)
      }
      gateway.useTransaction(trx)
      number = await writeRevision(gateway, {
        before: loaded.states,
        after: [...after.values()],
        source: revision.source,
        userId: revision.userId,
        confirmed: revision.confirmed,
        now,
        trx,
      })
    }
  })
  await refreshSyncState(gateway)
  return number
}

export type EditOutcome = {
  perchIds: string[]
  deleted: string[]
  issues: Issue[]
}

/**
 * `gatewayConfig.editSections(gatewayId, userId, edits)` (section 7): the
 * single write entry point for domain REST handlers. The edits become C of
 * the domain's synced sections (new sections are controller rows until an
 * apply creates them); nothing is sent to the router here.
 */
export async function editSections(
  gatewayId: number,
  userId: number,
  domain: string,
  edits: SectionEdit[]
): Promise<EditOutcome> {
  const outcome = await editDomainSections(gatewayId, userId, [{ domain, edits }])
  return {
    perchIds: outcome.perchIds,
    deleted: outcome.deleted,
    issues: outcome.issues,
  }
}

export type DomainEditBatch = { domain: string; edits: SectionEdit[] }

export type MultiEditOutcome = EditOutcome & {
  /** Per batch, in order: the rows it changed or created, and the new ones alone. */
  batches: Array<{ domain: string; perchIds: string[]; created: string[]; deleted: string[] }>
}

/**
 * Edits of several domains as one draft change (plan 1 section 8.1: a new
 * network, its DHCP pool and later its firewall zone go into one apply).
 * Each batch is planned against the rows as the batches before it left
 * them; validation runs once over the result; everything is stored in one
 * transaction or not at all.
 */
export async function editDomainSections(
  gatewayId: number,
  userId: number,
  batches: DomainEditBatch[]
): Promise<MultiEditOutcome> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    const loaded = await loadSections(gateway.id)
    const newPerchId = perchIdFactory(loaded.states.map((s) => s.perchId))
    const candidate = new Map(loaded.states.map((s) => [s.perchId, s]))
    const upserted = new Map<string, SectionState>()
    const deletedAll = new Set<string>()
    const perBatch: MultiEditOutcome['batches'] = []
    // Order requests of every batch (firewall.md section 3); a later batch's
    // request for the same config + type replaces an earlier one.
    const orders = new Map<string, EditSectionsResult['orders'][number]>()
    for (const batch of batches) {
      if (batch.edits.length === 0) {
        perBatch.push({ domain: batch.domain, perchIds: [], created: [], deleted: [] })
        continue
      }
      let result: EditSectionsResult
      const before = new Set(candidate.keys())
      try {
        result = planSectionEdits({
          rows: [...candidate.values()],
          edits: batch.edits,
          domain: batch.domain,
          registry: domainRegistry(),
          authoritative: authoritativeOf(gateway),
          newPerchId,
        })
      } catch (error) {
        if (error instanceof EditRefusedError) {
          throw planeError(409, error.code, error.message)
        }
        if (error instanceof SectionEditError) throw planeError(422, 'invalid_edit', error.message)
        throw error
      }
      for (const order of result.orders) orders.set(`${order.config}\u0000${order.type}`, order)
      for (const u of result.upserts) {
        candidate.set(u.perchId, u)
        upserted.set(u.perchId, u)
        deletedAll.delete(u.perchId)
      }
      for (const id of result.deleted) {
        candidate.delete(id)
        upserted.delete(id)
        deletedAll.add(id)
      }
      perBatch.push({
        domain: batch.domain,
        perchIds: result.upserts.map((u) => u.perchId),
        created: result.upserts.filter((u) => !before.has(u.perchId)).map((u) => u.perchId),
        deleted: result.deleted,
      })
    }
    const touched = [...upserted.keys(), ...deletedAll]
    const inFlight = await inFlightApply(gateway.id)
    if (inFlight && inFlight.perchIds.some((id) => touched.includes(id))) {
      throw planeError(409, 'pending_apply', 'An apply carrying this section is running.')
    }
    // Validate the draft as it would be; an edit that leaves an error on a
    // section it touches is refused before anything is stored.
    const issues = validateStates(gateway, [...candidate.values()])
    const blocking = issues.filter(
      (i) => i.severity === 'error' && i.perchId && touched.includes(i.perchId)
    )
    if (blocking.length > 0) {
      throw planeError(422, 'invalid_config', blocking[0].message, { issues: blocking })
    }
    // Deleted rows that existed before: dropped (controller-only rows the
    // router never had); new rows deleted again within the batches: nothing.
    const existing = new Set(loaded.states.map((s) => s.perchId))
    const changes = [
      ...[...upserted.values()].map((s) => ({ perchId: s.perchId, after: s })),
      ...[...deletedAll]
        .filter((id) => existing.has(id))
        .map((id) => ({ perchId: id, after: null })),
    ]
    await db.transaction(async (trx) => {
      await saveStates(gateway.id, loaded.rows, changes, { userId, trx })
      await recordGatewayEvent(gateway.id, 'draft_edited', {
        userId,
        detail:
          batches.length === 1
            ? { domain: batches[0].domain, perchIds: touched }
            : { domains: batches.map((b) => b.domain), perchIds: touched },
        trx,
      })
    })
    // New and deleted members of ordered types (firewall.md section 3), and
    // the domain's own order edits.
    await refreshOrders(gateway, [...candidate.values()])
    for (const order of orders.values()) {
      const prev = await findOrder(gateway.id, order)
      await saveOrder(
        gateway.id,
        setDesiredOrder(prev, order, [...candidate.values()], order.perchIds),
        { userId }
      )
    }
    await refreshSyncState(gateway)
    return {
      perchIds: [...upserted.keys()],
      deleted: [...deletedAll].filter((id) => existing.has(id)),
      issues: issues.filter((i) => !i.perchId || touched.includes(i.perchId)),
      batches: perBatch,
    }
  })
}

export type ResolveItem = {
  perchId: string
  take: 'router' | 'controller' | 'custom'
  options?: Record<string, UciValue | null>
}

/** `POST /gateways/:id/sections/resolve` (section 5.2). */
export async function resolveSections(
  gatewayId: number,
  userId: number,
  items: ResolveItem[]
): Promise<string[]> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    const loaded = await loadSections(gateway.id)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const item of items) {
      const state = loaded.states.find((s) => s.perchId === item.perchId)
      if (!state || !state.conflict) continue
      let resolution: ConflictResolution
      if (item.take === 'custom') {
        const options: Record<string, OptionResolution> = {}
        for (const [name, value] of Object.entries(item.options ?? {})) {
          options[name] = { take: 'custom', value }
        }
        resolution = { take: 'custom', options }
      } else {
        resolution = { take: item.take }
      }
      const next = resolveConflict(state, resolution, {
        authoritative: authoritativeOf(gateway),
        rules: domainRegistry().rules(state.domain),
      })
      if (!next) {
        throw planeError(422, 'resolution_incomplete', `Decide every option of ${state.name}.`, {
          perchId: state.perchId,
          options: state.conflict.options.map((o) => o.name),
        })
      }
      changes.push({ perchId: state.perchId, after: isGone(next) ? null : next })
    }
    if (changes.length === 0) {
      throw planeError(409, 'nothing_to_resolve', 'None of these sections is in conflict.')
    }
    const revision = await saveWithRevision(gateway, loaded, changes, {
      source: 'merge',
      userId,
      confirmed: true,
    })
    for (const change of changes) {
      const item = items.find((i) => i.perchId === change.perchId)!
      await recordGatewayEvent(gateway.id, 'conflict_resolved', {
        userId,
        revision,
        detail: { perchId: change.perchId, take: item.take },
      })
    }
    return changes.map((c) => c.perchId)
  })
}

/** `POST /gateways/:id/drift/accept` (section 5.3): C := B := R for drifted sections. */
export async function acceptDriftSections(
  gatewayId: number,
  userId: number,
  perchIds?: string[]
): Promise<string[]> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    const loaded = await loadSections(gateway.id)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const s of loaded.states) {
      if (s.status !== 'drift') continue
      if (perchIds && !perchIds.includes(s.perchId)) continue
      changes.push({
        perchId: s.perchId,
        after: acceptDrift(s, { rules: domainRegistry().rules(s.domain) }),
      })
    }
    if (changes.length === 0) throw planeError(409, 'no_drift', 'Nothing has drifted.')
    const revision = await saveWithRevision(gateway, loaded, changes, {
      source: 'router',
      userId,
      confirmed: true,
    })
    for (const change of changes) {
      await recordGatewayEvent(gateway.id, 'drift_accepted', {
        userId,
        revision,
        detail: { perchId: change.perchId },
      })
    }
    return changes.map((c) => c.perchId)
  })
}

/** `POST /gateways/:id/drift/revert-now`: the revert job without waiting for the grace delay. */
export async function revertDriftNow(gatewayId: number, userId: number, perchIds?: string[]) {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    if (gateway.enforcement === 'suspended') {
      throw planeError(409, 'enforcement_suspended', 'Resume enforcement first.')
    }
    const { states } = await loadSections(gateway.id)
    const drifted = states
      .filter((s) => s.status === 'drift' && (!perchIds || perchIds.includes(s.perchId)))
      .map((s) => s.perchId)
    if (drifted.length === 0) throw planeError(409, 'no_drift', 'Nothing has drifted.')
    if (await hasOpenApply(gateway.id)) {
      throw planeError(409, 'apply_in_flight', 'Wait for the running apply to finish.')
    }
    const settings = await getGatewayConfigSettings()
    const access = writeAccess(gateway, settings)
    if (!access.writable) {
      throw planeError(
        409,
        access.reason === 'offline' ? 'agent_offline' : 'insecure_transport',
        'The gateway cannot be written now.'
      )
    }
    const { startRevert } = await import('#services/gateway_config/apply_lifecycle')
    const apply = await startRevert(gateway, drifted, userId)
    if (!apply) throw planeError(409, 'no_drift', 'Nothing to revert.')
    return apply
  })
}

/** `POST /gateways/:id/enforcement/resume`. */
export async function resumeEnforcement(gatewayId: number, userId: number): Promise<Gateway> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    if (gateway.enforcement !== 'active') {
      gateway.enforcement = 'active'
      gateway.enforcementChangedAt = DateTime.utc()
      await gateway.save()
      await recordGatewayEvent(gateway.id, 'enforcement_resumed', { userId })
    }
    return gateway
  })
}

/**
 * `PATCH /gateways/:id/sections/:perchId {scope}` (README 7.5): a synced
 * section becomes router-only (mirrored, its ledger entry dropped with the
 * next job), or an excluded one is synced again (its router content as B = C).
 */
export async function setSectionScope(
  gatewayId: number,
  userId: number,
  perchId: string,
  scope: 'synced' | 'excluded'
): Promise<void> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    const loaded = await loadSections(gateway.id)
    const state = loaded.states.find((s) => s.perchId === perchId)
    if (!state) throw planeError(404, 'section_not_found', `No section ${perchId}.`)
    if (state.scope === scope) return
    if (state.scope === 'unmodeled') {
      throw planeError(409, 'unmodeled', 'No domain models this section; it stays router-only.')
    }
    const inFlight = await inFlightApply(gateway.id)
    if (inFlight?.perchIds.includes(perchId)) {
      throw planeError(409, 'pending_apply', 'An apply carrying this section is running.')
    }
    if (state.router === null) {
      throw planeError(409, 'not_on_router', 'The section does not exist on the router yet.')
    }
    const next: SectionState = {
      ...state,
      scope,
      base: cloneContent(state.router),
      desired: cloneContent(state.router),
      conflict: null,
      driftSince: null,
      status: 'in_sync',
    }
    next.status = deriveStatus(next, { authoritative: authoritativeOf(gateway) })
    await saveWithRevision(gateway, loaded, [{ perchId, after: next }], null)
    await recordGatewayEvent(
      gateway.id,
      scope === 'excluded' ? 'section_excluded' : 'section_included',
      { userId, detail: { perchId, config: state.config, section: state.name } }
    )
  })
}

/** `DELETE /gateways/:id/draft {perchIds?}`: C := B where the controller moved. */
export async function discardDraft(
  gatewayId: number,
  userId: number,
  perchIds?: string[]
): Promise<number> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    const loaded = await loadSections(gateway.id)
    const inFlight = await inFlightApply(gateway.id)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const s of loaded.states) {
      if (s.scope !== 'synced' || s.conflict) continue
      if (perchIds && !perchIds.includes(s.perchId)) continue
      if (inFlight?.perchIds.includes(s.perchId)) continue
      const rules = domainRegistry().rules(s.domain)
      if (contentsEqual(s.desired, s.base, rules)) continue
      if (s.base === null && s.router === null) {
        changes.push({ perchId: s.perchId, after: null })
        continue
      }
      const next: SectionState = { ...s, desired: cloneContent(s.base) }
      next.status = deriveStatus(next, { authoritative: authoritativeOf(gateway), rules })
      changes.push({ perchId: s.perchId, after: next })
    }
    if (changes.length > 0) {
      await saveWithRevision(gateway, loaded, changes, null)
      await recordGatewayEvent(gateway.id, 'draft_discarded', {
        userId,
        detail: { perchIds: changes.map((c) => c.perchId) },
      })
    }
    return changes.length
  })
}

/**
 * `POST /gateways/:id/revisions/:number/restore` (and the rejoin offer,
 * README 3.7): C := the snapshot; applying stays a separate step.
 */
export async function restoreRevision(
  gatewayId: number,
  userId: number,
  number: number
): Promise<string[]> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    const revision = await GatewayRevision.query()
      .where('gateway_id', gateway.id)
      .where('number', number)
      .first()
    if (!revision) throw planeError(404, 'revision_not_found', `No revision ${number}.`)
    const loaded = await loadSections(gateway.id)
    const plan = planRestore(loaded.states, revision.snapshot)
    const touched = new Set([...plan.updates.map((u) => u.perchId)])
    const conflicted = loaded.states
      .filter((s) => touched.has(s.perchId) && s.conflict)
      .map((s) => s.perchId)
    if (conflicted.length > 0) {
      throw planeError(409, 'conflicts_open', 'Resolve the conflicts first.', {
        perchIds: conflicted,
      })
    }
    if ((await inFlightApply(gateway.id)) !== null) {
      throw planeError(409, 'apply_in_flight', 'Wait for the running apply to finish.')
    }
    const authoritative = authoritativeOf(gateway)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const update of plan.updates) {
      const s = loaded.states.find((x) => x.perchId === update.perchId)!
      const rules = domainRegistry().rules(s.domain)
      if (contentsEqual(update.desired, s.desired, rules)) continue
      if (update.desired === null && s.base === null && s.router === null) {
        changes.push({ perchId: s.perchId, after: null })
        continue
      }
      const next: SectionState = { ...s, desired: cloneContent(update.desired) }
      next.status = deriveStatus(next, { authoritative, rules })
      changes.push({ perchId: s.perchId, after: next })
    }
    const taken = new Set(loaded.states.map((s) => `${s.config}/${s.name}`))
    for (const entry of plan.creates) {
      const name = taken.has(`${entry.config}/${entry.section}`)
        ? `perch_${entry.perchId}`
        : entry.section
      changes.push({
        perchId: entry.perchId,
        after: {
          perchId: entry.perchId,
          config: entry.config,
          name,
          type: entry.content.type,
          anonymous: false,
          scope: 'synced',
          domain: entry.domain,
          ownership: null,
          issue: null,
          base: null,
          baseRevision: null,
          router: null,
          desired: cloneContent(entry.content),
          status: 'ahead',
          conflict: null,
          driftSince: null,
          position: null,
        },
      })
    }
    await saveWithRevision(gateway, loaded, changes, null)
    if (gateway.rejoinOffer && gateway.rejoinOffer.revision === number) {
      gateway.rejoinOffer = null
      await gateway.save()
    }
    await recordGatewayEvent(gateway.id, 'revision_restored', {
      userId,
      revision: number,
      detail: { sections: changes.length },
    })
    return changes.map((c) => c.perchId)
  })
}

/**
 * `PUT /gateways/:id/sign-key` (README 7.1): the router's own
 * `config_sign_key`, for a router that signs with it instead of the api_key.
 * Stored APP_KEY-encrypted, never returned; `null` clears it.
 */
export async function setSignKey(
  gatewayId: number,
  user: User,
  key: string | null,
  password: string | undefined
): Promise<Gateway> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    if (key !== null && !(await verifyPassword(user, password))) {
      throw planeError(403, 'invalid_password', 'Confirm with your current password.')
    }
    gateway.configSignKey = key
    await gateway.save()
    await recordGatewayEvent(gateway.id, 'sign_key_changed', {
      userId: user.id,
      detail: { set: key !== null },
    })
    return gateway
  })
}

/** `POST /gateways/:id/rejoin/dismiss`. */
export async function dismissRejoin(gatewayId: number, userId: number): Promise<Gateway> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    if (gateway.rejoinOffer) {
      gateway.rejoinOffer = null
      await gateway.save()
      await recordGatewayEvent(gateway.id, 'rejoin_dismissed', { userId })
    }
    return gateway
  })
}

/**
 * `POST /gateways/:id/bind {collectorId}`: a detached gateway (its collector
 * was deleted) is bound to another collector, e.g. the reinstalled router.
 * README 3.7: it is offered its last confirmed revision.
 */
export async function bindGateway(
  gatewayId: number,
  userId: number,
  collectorId: number
): Promise<Gateway> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    if (gateway.collectorId !== null) {
      throw planeError(409, 'not_detached', 'This gateway is bound to a collector.')
    }
    const collector = await Collector.find(collectorId)
    if (!collector) throw planeError(404, 'collector_not_found', `No collector ${collectorId}.`)
    const other = await Gateway.query().where('collector_id', collectorId).first()
    if (other) {
      throw planeError(409, 'collector_has_gateway', 'That collector already has a gateway.', {
        gatewayId: other.id,
      })
    }
    gateway.collectorId = collectorId
    gateway.mode = 'off'
    gateway.authoritative = false
    gateway.observedHashes = null
    gateway.observedLedger = null
    // Another router: its pairing (if any) has to be made again.
    clearPairing(gateway)
    await gateway.save()
    await recordGatewayEvent(gateway.id, 'bound', { userId, detail: { collectorId } })
    await offerRejoin(gateway, 'rebound', await lastConfirmedRevision(gateway.id))
    await pushConfigure(gateway)
    return gateway
  })
}

// ── section orders (docs/gateway/firewall.md section 3) ──────────────────

/**
 * A controller reorder of an ordered type: C := `perchIds`, which must name
 * exactly the synced sections of that type (unmodeled and excluded ones
 * keep their slots). Nothing is sent; an apply of those sections carries
 * the `order` op.
 */
export async function setSectionOrder(
  gatewayId: number,
  userId: number,
  key: OrderKey,
  perchIds: string[]
): Promise<OrderState> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    const { states } = await loadSections(gateway.id)
    const members = orderMembers(states, key)
    const wanted = new Set(perchIds)
    const missing = members.filter((id) => !wanted.has(id))
    const unknown = perchIds.filter((id) => !members.includes(id))
    if (missing.length > 0 || unknown.length > 0 || wanted.size !== perchIds.length) {
      throw planeError(422, 'order_incomplete', 'Name every synced section of the type once.', {
        missing,
        unknown,
      })
    }
    const inFlight = await inFlightApply(gateway.id)
    if (inFlight && (inFlight.configs ?? []).includes(key.config)) {
      throw planeError(409, 'pending_apply', 'An apply of this config is running.')
    }
    const prev = await findOrder(gateway.id, key)
    const next = setDesiredOrder(prev, key, states, perchIds)
    await saveOrder(gateway.id, next, { userId })
    await recordGatewayEvent(gateway.id, 'order_changed', {
      userId,
      detail: { config: key.config, type: key.type, order: next.desired },
    })
    await refreshSyncState(gateway)
    return next
  })
}

/**
 * Settles an order conflict (two-way) or order drift (Authoritative):
 * `router` takes the router's order, `controller` keeps C for the next apply.
 */
export async function resolveSectionOrder(
  gatewayId: number,
  userId: number,
  key: OrderKey,
  take: 'router' | 'controller'
): Promise<OrderState> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    const prev = await findOrder(gateway.id, key)
    if (!prev || (prev.status !== 'conflict' && prev.status !== 'drift')) {
      throw planeError(409, 'nothing_to_resolve', 'This order has no conflict or drift.')
    }
    const { states } = await loadSections(gateway.id)
    const next = resolveOrder(prev, states, take)
    await saveOrder(gateway.id, next, { userId })
    await recordGatewayEvent(gateway.id, 'order_resolved', {
      userId,
      detail: { config: key.config, type: key.type, take, was: prev.status },
    })
    await refreshSyncState(gateway)
    return next
  })
}
