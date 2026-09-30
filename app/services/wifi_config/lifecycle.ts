import ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import { AgentOfflineError, AgentTimeoutError } from '#services/ap_agent_hub'
import { planApply, type PlannedJob } from '#services/gateway_config/apply_plan'
import { contentOf, validateDesired, type SyncedSection } from '#services/gateway_config/domain'
import {
  enforcementAfterFailure,
  FINISHED_APPLY_STATES,
  isGone,
  markConfirmed,
  markInFlight,
  markRolledBack,
  nextApplyState,
  sectionsDueForRevert,
  type ApplyEvent,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import {
  actorColumns,
  parseSystemActor,
  type ApplyOp,
  type ApplyState,
  type ConfirmMode,
  type Issue,
  type LedgerEntry,
  type PlaneActor,
  type SectionContent,
  type WireValue,
} from '#services/gateway_config/types'
import { apRegistry } from '#services/wifi_config/domains/index'
import { flagOf, scalarOf } from '#services/wifi_config/domains/normalize'
import { wifiError } from '#services/wifi_config/errors'
import { emitWifiAlert, recordApEvent } from '#services/wifi_config/events'
import { cacFor } from '#services/wifi_config/fleet/impact'
import {
  agentErrorCode,
  apRequest,
  parseHealth,
  readAndReconcileAp,
} from '#services/wifi_config/agent'
import {
  apSession,
  apUpdateInFlight,
  normalizeApMode,
  parseApResult,
  writeAccess,
  writeBlockCode,
  writeBlockMessage,
} from '#services/wifi_config/registry'
import { secretValues } from '#services/wifi_config/secrets'
import {
  getWifiConfigSettings,
  wifiConfirmMode,
  wifiConfirmWindow,
  type WifiConfigSettings,
} from '#services/wifi_config/settings'
import {
  apConfigQueue,
  hasOpenApApply,
  loadApSections,
  openApApplies,
  refreshApSyncState,
  saveApStates,
  scheduleFleetWork,
  statesAfter,
  writeApRevision,
} from '#services/wifi_config/store'
import type { ApReportedResult, WifiHealth } from '#services/wifi_config/types'
import logger from '@adonisjs/core/services/logger'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * AP jobs (docs/design/wifi controller.md section 4.3; the gateway's
 * `apply_lifecycle.ts` on the AP socket, protocol.md sections 3.3–3.6):
 *
 *   queued ─writable─► sending ─committed─► pending_confirm ─confirm─► confirmed
 *                          │                   └ deadline / revert / reboot / health ► rolled_back
 *                          └ refused ► failed         (queued ► expired | cancelled)
 *
 * - One job at a time per AP; after a confirm the next job of the same
 *   request (adopt → ordinary → protected, up to 5) is planned from the rows
 *   as they are then.
 * - Confirm (decision D4): the agent commits, drops its session and dials a
 *   fresh one; the fresh session's `system.info` naming the job is the
 *   reconnect, its first accepted `metrics.push` the agent half; then
 *   `wifi.config.confirm`, which the AP only answers `confirmed` once its
 *   health check passed (`health_pending` is retried by the tick until the
 *   deadline − 5 s; `unhealthy` means it rolled back). Protected jobs (the
 *   AP's uplink) also wait for "Keep changes" by default.
 * - The AP's deadline is authoritative: without a confirm it restores by
 *   itself and reports `wifi.config.result`; nothing by the deadline + 30 s
 *   is assumed rolled back.
 * - Every AP write belongs to a rollout (S5), except Authoritative Mode's
 *   reverts; a finished job wakes the rollout engine.
 */

export const DEADLINE_GRACE_SECONDS = 30
export const SENDING_TIMEOUT_SECONDS = 120
/** How long a `busy` AP (device groups, LuCI apply, update) is retried before the job fails. */
export const BUSY_RETRY_SECONDS = 120
/** The AP's health retries stop this long before its deadline (it rolls back by itself then). */
export const HEALTH_RETRY_MARGIN_SECONDS = 5
export const APPLY_RPC_TIMEOUT_MS = 30_000
const MAX_CHAIN = 5

export type ApApplyRequest = {
  actor: PlaneActor | null
  perchIds?: string[]
  kind?: 'apply' | 'revert'
  /** Only the adopt job (ledger entries), never a change (entering managed). */
  adoptOnly?: boolean
  /** The rollout's confirm mode for ordinary jobs (protected jobs use their setting). */
  confirmMode?: ConfirmMode
  note?: string | null
  rolloutId?: number | null
  /** A catch-up of a missed change: confirmed by the agent alone. */
  catchUp?: boolean
}

function newApplyKey(apId: number): string {
  return `a${apId}-${randomBytes(6).toString('hex')}`
}

function authoritativeOf(ap: ApConfig): boolean {
  return normalizeApMode(ap.mode) === 'managed' && Boolean(ap.authoritative)
}

export function applyActorOf(apply: ApConfigApply): PlaneActor | null {
  const system = parseSystemActor(apply.systemActor)
  if (system) return { system }
  return apply.requestedByUserId
}

/** The AP's registry for reads, plans and validation (its capabilities). */
export function registryFor(ap: ApConfig) {
  return apRegistry(ap.capabilities, { trunkOverride: ap.trunkOverride })
}

/** Validation of the desired state with the AP's capabilities and management path. */
export function validateApStates(ap: ApConfig, states: SectionState[]): Issue[] {
  const desired: Array<SyncedSection & { domain: string | null }> = states
    .filter((s) => s.scope === 'synced' && s.desired !== null)
    .map((s) => ({
      perchId: s.perchId,
      config: s.config,
      name: s.name,
      type: s.desired!.type,
      anonymous: s.anonymous,
      options: { ...s.desired!.options },
      ...(s.desired!.secrets ? { secrets: { ...s.desired!.secrets } } : {}),
      domain: s.domain,
      position: s.position,
    }))
  const unmanaged: SyncedSection[] = states
    .filter((s) => s.scope !== 'synced' && s.router !== null)
    .map((s) => ({
      perchId: s.perchId,
      config: s.config,
      name: s.name,
      type: s.router!.type,
      anonymous: s.anonymous,
      options: { ...s.router!.options },
      position: s.position,
    }))
  return validateDesired(registryFor(ap), desired, {
    capabilities: ap.capabilities as never,
    unmanaged,
    networks: (ap.capabilities?.networks ?? []).map((n) => ({ name: n.name, ipv4: [] })),
    managementPath: ap.managementPath,
  })
}

/** The planned jobs for the AP's rows (no ordered types on an AP). */
export function planApJobs(
  ap: ApConfig,
  states: SectionState[],
  request: { perchIds?: string[]; kind?: 'apply' | 'revert' }
) {
  return planApply({
    sections: states,
    perchIds: request.perchIds,
    kind: request.kind ?? 'apply',
    ledger: ap.observedLedger ?? [],
    hashes: ap.observedHashes ?? {},
    management: ap.managementPath,
    registry: registryFor(ap),
    orders: [],
  })
}

function confirmModeFor(
  settings: WifiConfigSettings,
  job: PlannedJob,
  options: Pick<ApApplyRequest, 'confirmMode' | 'catchUp'> & { queued: boolean }
): ConfirmMode {
  const kind = job.kind === 'revert' ? 'revert' : job.kind === 'adopt' ? 'adopt' : 'apply'
  const base = wifiConfirmMode(settings, {
    protected: job.protected,
    kind,
    catchUp: options.catchUp,
    queued: options.queued,
  })
  if (kind !== 'apply' || options.catchUp || options.queued || job.protected) return base
  return options.confirmMode ?? base
}

/** Radio-restart allowance (controller.md 6.3): the longest radar check a job may start. */
function cacAllowanceOf(ap: ApConfig, states: SectionState[], job: PlannedJob): number {
  const byId = new Map(states.map((s) => [s.perchId, s]))
  let max = 0
  for (const id of job.perchIds) {
    const row = byId.get(id)
    if (!row || row.config !== 'wireless' || row.type !== 'wifi-device') continue
    max = Math.max(max, cacFor(ap.capabilities, row.name, row))
  }
  return max
}

/**
 * `expect` of an apply (protocol.md 3.3): the job's own interface sections
 * that must run a BSS afterwards, and their radios. The agent adds what it
 * computes from the committed config.
 */
function expectOf(states: SectionState[], job: PlannedJob): { bss: string[]; radios: string[] } {
  const after = new Map(states.map((s) => [s.perchId, s]))
  const radioEnabled = (name: string) => {
    const radio = [...after.values()].find((s) => s.config === 'wireless' && s.name === name)
    const content = radio ? (job.written[radio.perchId] ?? radio.desired ?? radio.router) : null
    return content ? !flagOf(content.options, 'disabled', false) : true
  }
  const bss: string[] = []
  const radios = new Set<string>()
  for (const id of job.perchIds) {
    const row = after.get(id)
    const written = job.written[id]
    if (!row || row.config !== 'wireless' || !written || written.type !== 'wifi-iface') continue
    const mode = scalarOf(written.options, 'mode')
    if (mode !== null && mode !== 'ap') continue
    if (flagOf(written.options, 'disabled', false)) continue
    const device = scalarOf(written.options, 'device')
    if (!device || !radioEnabled(device)) continue
    const adopt = job.ops.find((op) => op.op === 'adopt' && op.perchId === id)
    bss.push(adopt && adopt.op === 'adopt' && adopt.renameTo ? adopt.renameTo : row.name)
    radios.add(device)
  }
  for (const id of job.perchIds) {
    const row = after.get(id)
    const written = job.written[id]
    if (row?.type === 'wifi-device' && written && !flagOf(written.options, 'disabled', false)) {
      radios.add(row.name)
    }
  }
  return { bss: bss.sort(), radios: [...radios].sort() }
}

/**
 * The core puts the router's own values of the options Perch does not own
 * into `put` ops; the AP protocol (protocol.md 3.3) wants `{"$keep": true}`
 * for those (the AP keeps whatever it has). A secret the AP already holds
 * (its fingerprint equals the desired one) is kept too, so a passphrase
 * travels only when it changes. Sections the AP does not have yet are sent
 * as they are.
 */
export function apWireOps(ops: ApplyOp[], states: SectionState[]): ApplyOp[] {
  return ops.map((op) => {
    if (op.op !== 'put') return op
    const row = states.find(
      (s) =>
        s.config === op.config && (s.name === op.section || `perch_${s.perchId}` === op.section)
    )
    if (!row || row.router === null) return op
    const owned =
      row.ownership && row.ownership.kind === 'options' ? new Set(row.ownership.options) : null
    const options: Record<string, WireValue> = {}
    for (const [name, value] of Object.entries(op.options)) {
      const special = typeof value === 'object' && value !== null && !Array.isArray(value)
      if (special && '$secret' in value) {
        const held = row.router.secrets?.[name]?.fingerprint
        const wanted = row.desired?.secrets?.[name]?.fingerprint
        options[name] = held !== undefined && held === wanted ? { $keep: true } : value
        continue
      }
      options[name] = !owned || owned.has(name) || special ? value : { $keep: true }
    }
    return { ...op, options }
  })
}

/** The secret refs wire ops still name (`{"$secret": ref}`). */
export function wireSecretRefs(ops: ApplyOp[]): string[] {
  const refs = new Set<string>()
  for (const op of ops) {
    if (op.op !== 'put') continue
    for (const value of Object.values(op.options)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        '$secret' in value
      ) {
        refs.add(value.$secret)
      }
    }
  }
  return [...refs]
}

// ── requesting ───────────────────────────────────────────────────────────

/**
 * Plans an AP's draft and queues its first job, sending it at once when the
 * AP is writable (the rollout engine's step, and Authoritative reverts). A
 * job waits `queued` only while the AP is offline; any other write block is
 * refused.
 */
export async function requestApApply(
  apId: number,
  request: ApApplyRequest
): Promise<ApConfigApply> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.findOrFail(apId)
    const settings = await getWifiConfigSettings()
    if (normalizeApMode(ap.mode) !== 'managed') {
      throw wifiError(409, 'not_managed', 'The access point is not managed by Perch.')
    }
    const open = await openApApplies(ap.apId)
    if (open.length > 0) {
      throw wifiError(409, 'apply_in_flight', 'A change is still being applied on this AP.', {
        applyId: open[0].applyKey,
      })
    }
    const { states } = await loadApSections(ap.apId)
    if (request.perchIds) {
      const conflicted = states
        .filter((s) => request.perchIds!.includes(s.perchId) && s.conflict !== null)
        .map((s) => s.perchId)
      if (conflicted.length > 0) {
        throw wifiError(409, 'conflicts_open', 'Resolve the conflicts first.', {
          apId,
          perchIds: conflicted,
        })
      }
    }
    const kind = request.kind ?? 'apply'
    const plan = planApJobs(ap, states, { perchIds: request.perchIds, kind })
    const planned = new Set(plan.jobs.flatMap((j) => j.perchIds))
    const errors = validateApStates(ap, states).filter(
      (i) => i.severity === 'error' && (!i.perchId || planned.has(i.perchId))
    )
    if (errors.length > 0 && kind === 'apply') {
      throw wifiError(422, 'invalid_config', errors[0].message, { apId, issues: errors })
    }
    const job = request.adoptOnly ? plan.jobs.find((j) => j.kind === 'adopt') : plan.jobs[0]
    if (!job) {
      const conflicted = plan.blocked.filter((b) => b.reason === 'conflict').map((b) => b.perchId)
      if (conflicted.length > 0) {
        throw wifiError(409, 'conflicts_open', 'Resolve the conflicts first.', {
          apId,
          perchIds: conflicted,
        })
      }
      throw wifiError(409, 'nothing_to_apply', 'There is nothing to apply.')
    }
    const access = writeAccess(ap, settings)
    if (!access.writable && access.reason !== 'offline') {
      throw wifiError(409, writeBlockCode(access.reason), writeBlockMessage(access.reason), {
        apIds: [apId],
      })
    }
    const apply = await createApApply(ap, settings, job, states, {
      ...request,
      kind,
      queued: !access.writable,
      chainStep: 0,
    })
    await recordApEvent(ap.apId, 'apply_requested', {
      actor: request.actor,
      applyId: apply.id,
      detail: {
        applyId: apply.applyKey,
        kind: apply.kind,
        perchIds: apply.perchIds,
        queued: !access.writable,
        rolloutId: request.rolloutId ?? null,
      },
    })
    if (access.writable) await sendApApply(ap, apply)
    await apply.refresh()
    return apply
  })
}

async function createApApply(
  ap: ApConfig,
  settings: WifiConfigSettings,
  job: PlannedJob,
  states: SectionState[],
  options: Omit<ApApplyRequest, 'kind'> & {
    kind: 'apply' | 'revert'
    queued: boolean
    chainStep: number
  }
): Promise<ApConfigApply> {
  const now = DateTime.utc()
  const apply = new ApConfigApply()
  apply.apId = ap.apId
  apply.applyKey = newApplyKey(ap.apId)
  apply.state = 'queued'
  applyJob(apply, job)
  apply.confirmMode = confirmModeFor(settings, job, options)
  apply.cacAllowanceSeconds = settings.dfsAllowance ? cacAllowanceOf(ap, states, job) : 0
  apply.confirmTimeoutSeconds = wifiConfirmWindow(settings, {
    protected: job.protected,
    cacAllowanceSeconds: apply.cacAllowanceSeconds,
    apMaxSeconds: ap.capabilities?.confirmMaxSeconds ?? null,
  })
  const actor = actorColumns(options.actor ?? null)
  apply.requestedByUserId = actor.userId
  apply.systemActor = actor.systemActor
  apply.note = options.note ? options.note.slice(0, 500) : null
  apply.requestedAt = now
  // A job waiting for an offline AP expires with the queue (settings have no
  // separate limit for APs: a rollout step decides how long to wait).
  apply.queueExpiresAt = now.plus({ hours: 24 })
  apply.chainPerchIds = options.perchIds ?? null
  apply.chainStep = options.chainStep
  apply.retried = false
  apply.signed = false
  apply.sealed = false
  apply.rolloutId = options.rolloutId ?? null
  apply.health = null
  // An adopt-only request (entering managed) never chains into a change.
  apply.outcome = options.adoptOnly ? { adoptOnly: true } : null
  await apply.save()
  return apply
}

function applyJob(apply: ApConfigApply, job: PlannedJob) {
  apply.kind = job.kind === 'revert' ? 'revert' : job.kind === 'adopt' ? 'adopt' : 'apply'
  apply.ops = job.ops
  apply.baseHashes = job.base
  apply.perchIds = job.perchIds
  apply.protected = job.protected
  apply.written = job.written
  apply.ledger = job.ledger
  apply.secretRefs = job.secretRefs
  apply.configs = job.configs
  apply.changes = job.changes
  apply.replacedRouterContent = job.replaced
}

// ── sending ──────────────────────────────────────────────────────────────

function transition(apply: ApConfigApply, event: ApplyEvent): ApplyState {
  const next = nextApplyState(apply.state as ApplyState, event)
  if (!next) throw new Error(`apply ${apply.applyKey}: ${event} not valid in ${apply.state}`)
  apply.state = next
  return next
}

/** The request's job kinds: an adopt-only step never sends a change. */
function adoptOnlyApply(apply: ApConfigApply): boolean {
  return apply.kind === 'adopt' && apply.chainStep === 0 && apply.outcome?.adoptOnly === true
}

/**
 * Sends a queued job, re-planned from the current rows first (it may be
 * stale): a job that lost its work is `cancelled`, one whose sections are in
 * conflict now `failed`. Waits while agent-updates holds the AP.
 */
export async function sendApApply(ap: ApConfig, apply: ApConfigApply): Promise<void> {
  const settings = await getWifiConfigSettings()
  const access = writeAccess(ap, settings)
  if (!access.writable || apUpdateInFlight(ap.apId)) return
  const { states } = await loadApSections(ap.apId)
  const plan = planApJobs(ap, states, {
    kind: apply.kind === 'revert' ? 'revert' : 'apply',
    perchIds: apply.chainPerchIds ?? (apply.kind === 'revert' ? apply.perchIds : undefined),
  })
  const job = adoptOnlyApply(apply) ? plan.jobs.find((j) => j.kind === 'adopt') : plan.jobs[0]
  if (!job) {
    const conflicted = plan.blocked.filter((b) => b.reason === 'conflict').map((b) => b.perchId)
    apply.state = conflicted.length > 0 ? 'failed' : 'cancelled'
    apply.finishedAt = DateTime.utc()
    apply.outcome = {
      ...(apply.outcome ?? {}),
      reason: conflicted.length > 0 ? 'conflicts_open' : 'nothing_to_apply',
      message:
        conflicted.length > 0
          ? 'Sections of this change are in conflict now.'
          : 'Nothing left to apply.',
    }
    await apply.save()
    await recordApEvent(ap.apId, conflicted.length > 0 ? 'failed' : 'cancelled', {
      applyId: apply.id,
      detail: { applyId: apply.applyKey, reason: apply.outcome.reason },
    })
    await refreshApSyncState(ap)
    notifyRollouts(apply)
    return
  }
  const domains = new Map(states.map((s) => [s.perchId, s.domain]))
  job.ops = job.ops.map((op) =>
    op.op === 'adopt' && domains.get(op.perchId) ? { ...op, domain: domains.get(op.perchId)! } : op
  )
  applyJob(apply, job)
  if (apply.state === 'queued') transition(apply, 'send')
  apply.sentAt = DateTime.utc()
  apply.signed = false
  await apply.save()
  await markRows(ap, apply.perchIds, (s) =>
    markInFlight(s, apply.kind === 'revert' ? 'revert' : 'apply')
  )
  await refreshApSyncState(ap)

  const ops = apWireOps(job.ops, states)
  const refs = wireSecretRefs(ops)
  const params: Record<string, unknown> = {
    applyId: apply.applyKey,
    kind: apply.kind,
    dryRun: false,
    base: baseOf(ap, job),
    ops,
    ledger: job.ledger,
    confirmTimeoutSeconds: apply.confirmTimeoutSeconds,
    cacAllowanceSeconds: apply.cacAllowanceSeconds,
    guards: { pskWildcardDigests: [] },
    expect: expectOf(states, job),
  }
  if (job.protected) params.protected = true
  if (refs.length > 0) params.secrets = await secretValues(refs)

  let result: Record<string, unknown> | null
  try {
    result = await apRequest<Record<string, unknown>>(ap.apId, 'wifi.config.apply', params, {
      timeoutMs: APPLY_RPC_TIMEOUT_MS,
    })
  } catch (error) {
    await onSendError(ap, apply, error)
    return
  }
  await onApplyReply(ap, apply, result ?? {})
}

/** The AP needs the hash of every config an op touches ("" = no file). */
function baseOf(ap: ApConfig, job: PlannedJob): Record<string, string> {
  const base: Record<string, string> = { ...job.base }
  for (const op of job.ops) {
    if (base[op.config] === undefined) base[op.config] = ap.observedHashes?.[op.config] ?? ''
  }
  return base
}

async function onSendError(ap: ApConfig, apply: ApConfigApply, error: unknown) {
  if (error instanceof AgentOfflineError || error instanceof AgentTimeoutError) {
    // The AP may have committed and dropped the session on purpose: its next
    // hello says whether the job is pending.
    logger.info(
      { apId: ap.apId, applyId: apply.applyKey, error: (error as Error).message },
      'wifi_config: no reply to the apply; waiting for the agent'
    )
    return
  }
  const code = agentErrorCode(error) ?? 'apply_failed'
  const data = ((error as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>
  if (data.rolledBack === true && data.result && typeof data.result === 'object') {
    const parsed = parseApResult(data.result)
    if (parsed) {
      await settleResult(ap, apply, parsed)
      return
    }
  }
  if (code === 'stale_base' && !apply.retried) {
    apply.retried = true
    apply.state = 'queued'
    await apply.save()
    await markRows(ap, apply.perchIds, (s) => restoreStatus(ap, s))
    try {
      await readAndReconcileAp(ap.apId, { reason: 'stale_base' })
    } catch {
      // The retry below re-checks everything.
    }
    await ap.refresh()
    await sendApApply(ap, apply)
    return
  }
  if (code === 'busy') {
    // Device groups, a LuCI apply or an update hold the AP's one write lock:
    // back to the queue, retried by the tick for a while (operations.md 2).
    const since = apply.outcome?.busySince
      ? DateTime.fromISO(String(apply.outcome.busySince))
      : null
    const first = since && since.isValid ? since : DateTime.utc()
    if (DateTime.utc().diff(first, 'seconds').seconds < BUSY_RETRY_SECONDS) {
      apply.state = 'queued'
      apply.outcome = {
        ...(apply.outcome ?? {}),
        busySince: first.toISO(),
        busyReason: typeof data.reason === 'string' ? data.reason : null,
      }
      await apply.save()
      await markRows(ap, apply.perchIds, (s) => restoreStatus(ap, s))
      await refreshApSyncState(ap)
      return
    }
  }
  const extra = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== 'error' && key !== 'result')
  )
  await failApApply(ap, apply, code, (error as Error).message, extra)
}

async function onApplyReply(ap: ApConfig, apply: ApConfigApply, result: Record<string, unknown>) {
  const state = typeof result.state === 'string' ? result.state : ''
  if (state === 'pending_confirm') {
    transition(apply, 'committed')
    const deadline = typeof result.deadline === 'string' ? DateTime.fromISO(result.deadline) : null
    apply.deadlineAt =
      deadline && deadline.isValid
        ? deadline.toUTC()
        : DateTime.utc().plus({ seconds: apply.confirmTimeoutSeconds })
    if (typeof result.confirmTimeoutSeconds === 'number') {
      apply.confirmTimeoutSeconds = Math.round(result.confirmTimeoutSeconds)
    }
    if (typeof result.protected === 'boolean' && result.protected && !apply.protected) {
      // The AP found the job on its management path by itself.
      apply.protected = true
    }
    await apply.save()
    await recordApEvent(ap.apId, 'applied', {
      applyId: apply.id,
      detail: {
        applyId: apply.applyKey,
        state,
        deadline: apply.deadlineAt.toISO(),
        reload: typeof result.reload === 'string' ? result.reload : null,
      },
    })
    await refreshApSyncState(ap)
    return
  }
  if (state === 'applied' || state === 'noop' || state === 'confirmed') {
    await finishConfirmed(ap, apply, hashesOf(result.hashes), 'applied', null)
    return
  }
  await failApApply(ap, apply, 'apply_failed', `unexpected apply reply state "${state}"`)
}

function hashesOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string')
  ) as Record<string, string>
}

function boundedData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(data).length <= 2000 ? data : { truncated: true }
}

export async function failApApply(
  ap: ApConfig,
  apply: ApConfigApply,
  error: string,
  message: string,
  data: Record<string, unknown> = {}
) {
  apply.state = 'failed'
  apply.finishedAt = DateTime.utc()
  apply.outcome = {
    error,
    message: message.slice(0, 500),
    ...(Object.keys(data).length > 0 ? { data: boundedData(data) } : {}),
  }
  await apply.save()
  await markRows(ap, apply.perchIds, (s) => restoreStatus(ap, s))
  await recordApEvent(ap.apId, 'failed', {
    applyId: apply.id,
    detail: { applyId: apply.applyKey, error, message: message.slice(0, 500) },
  })
  emitWifiAlert({
    name: 'wifi.apply.failed',
    severity: 'warning',
    source: { kind: 'ap', id: ap.apId },
    dedupeKey: `wifi.apply.failed:${apply.applyKey}`,
    payload: { apId: ap.apId, applyId: apply.applyKey, error, message },
  })
  await afterFailure(ap, apply)
  await refreshApSyncState(ap)
  notifyRollouts(apply)
}

/** Status of a row whose job ended without a change on the AP. */
function restoreStatus(ap: ApConfig, s: SectionState): SectionState {
  return markRolledBack(s, {
    authoritative: authoritativeOf(ap),
    now: DateTime.utc().toISO()!,
    rules: registryFor(ap).rules(s.domain),
  })
}

async function markRows(
  ap: ApConfig,
  perchIds: string[],
  fn: (s: SectionState) => SectionState | null
): Promise<void> {
  if (perchIds.length === 0) return
  const loaded = await loadApSections(ap.apId)
  const changes: Array<{ perchId: string; after: SectionState | null }> = []
  for (const s of loaded.states) {
    if (!perchIds.includes(s.perchId)) continue
    changes.push({ perchId: s.perchId, after: fn(s) })
  }
  await saveApStates(ap.apId, loaded.rows, changes)
}

// ── confirming ───────────────────────────────────────────────────────────

/**
 * A fresh session's `system.info` (protocol.md 3.4): the pending job's
 * reconnect, and the fate of a `sending` job whose reply was lost.
 */
export async function onApAgentReconnected(ap: ApConfig): Promise<void> {
  const session = apSession(ap.apId)
  if (!session?.block) return
  for (const apply of await openApApplies(ap.apId)) {
    if (apply.state !== 'sending' && apply.state !== 'pending_confirm') continue
    if (!apply.sentAt || session.connectedAt < apply.sentAt) continue
    const reported = session.block.apply
    const pendingHere = reported.state === 'pending_confirm' && reported.applyId === apply.applyKey
    if (apply.state === 'sending') {
      if (pendingHere) {
        await onApplyReply(ap, apply, { state: 'pending_confirm', deadline: reported.deadline })
      } else if (!session.block.results.some((r) => r.applyId === apply.applyKey)) {
        await failApApply(ap, apply, 'no_answer', 'The agent reconnected without the change.')
        continue
      }
    }
    if (apply.state !== 'pending_confirm' || !pendingHere) continue
    if (reported.deadline) {
      const deadline = DateTime.fromISO(reported.deadline)
      if (deadline.isValid) apply.deadlineAt = deadline.toUTC()
    }
    apply.agentReconnectedAt = DateTime.utc()
    await apply.save()
  }
}

/** The first accepted `metrics.push` on a fresh session: the agent half of the confirm. */
export async function onApPushAccepted(ap: ApConfig): Promise<boolean> {
  const open = await openApApplies(ap.apId)
  const apply = open.find((a) => a.state === 'pending_confirm')
  if (!apply || !apply.agentReconnectedAt || apply.agentConfirmedAt) return false
  apply.agentConfirmedAt = DateTime.utc()
  await apply.save()
  return tryConfirm(ap, apply)
}

/** "Keep changes" (`POST …/applies/:applyId/confirm`): the admin half. */
export async function adminConfirmAp(
  apId: number,
  applyKey: string,
  userId: number
): Promise<ApConfigApply> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.findOrFail(apId)
    const apply = await findApApply(apId, applyKey)
    if (apply.state !== 'pending_confirm' && apply.state !== 'sending') {
      throw wifiError(409, 'not_pending', 'This change is not waiting for a confirmation.', {
        state: apply.state,
      })
    }
    if (apply.deadlineAt && apply.deadlineAt < DateTime.utc()) {
      throw wifiError(410, 'deadline_passed', 'The confirm window has closed.')
    }
    apply.adminConfirmedAt = DateTime.utc()
    apply.adminConfirmedBy = userId
    await apply.save()
    await recordApEvent(apId, 'confirmed', {
      userId,
      applyId: apply.id,
      detail: { applyId: apply.applyKey, by: 'admin' },
    })
    await tryConfirm(ap, apply)
    await apply.refresh()
    return apply
  })
}

/**
 * `wifi.config.confirm` once the confirm mode is satisfied. Returns whether
 * the job was confirmed (the caller reads the AP afterwards).
 */
async function tryConfirm(ap: ApConfig, apply: ApConfigApply): Promise<boolean> {
  if (apply.state !== 'pending_confirm' || !apply.agentConfirmedAt) return false
  if (apply.confirmMode === 'admin_and_agent' && !apply.adminConfirmedAt) return false
  const settings = await getWifiConfigSettings()
  if (!writeAccess(ap, settings).writable) return false
  let result: Record<string, unknown> | null
  try {
    result = await apRequest<Record<string, unknown>>(ap.apId, 'wifi.config.confirm', {
      applyId: apply.applyKey,
    })
  } catch (error) {
    const code = agentErrorCode(error)
    const data = ((error as { data?: Record<string, unknown> }).data ?? {}) as Record<
      string,
      unknown
    >
    const health = parseHealth(data.health)
    if (code === 'health_pending') {
      // The AP's health check still runs (a radar check, a BSS coming up).
      apply.health = health
      apply.healthCheckedAt = DateTime.utc()
      await apply.save()
      return false
    }
    if (code === 'unhealthy') {
      await settleResult(ap, apply, {
        applyId: apply.applyKey,
        kind: apply.kind as 'apply',
        outcome: 'rolled_back',
        reason: 'health_failed',
        at: new Date().toISOString(),
        ...(health ? { health } : {}),
      })
      return false
    }
    if (code === 'deadline_passed' && data.result && typeof data.result === 'object') {
      const parsed = parseApResult(data.result)
      if (parsed) await settleResult(ap, apply, parsed)
      return false
    }
    if (code === 'unknown_apply') {
      await failApApply(ap, apply, code, (error as Error).message)
      return false
    }
    logger.warn(
      { apId: ap.apId, applyId: apply.applyKey, error: (error as Error).message },
      'wifi_config: confirm failed; will retry'
    )
    return false
  }
  const health = parseHealth(result?.health)
  if (health) {
    apply.health = health
    apply.healthCheckedAt = DateTime.utc()
    ap.health = health
    ap.healthAt = DateTime.utc()
    await ap.save()
  }
  await finishConfirmed(ap, apply, hashesOf(result?.hashes), 'confirmed', health)
  return true
}

/**
 * The job is live and kept: B := R := written for its sections (renamed
 * adoptions take their new name), a confirmed revision, the ledger as the
 * agent now has it, then the next job of the same request.
 */
async function finishConfirmed(
  ap: ApConfig,
  apply: ApConfigApply,
  hashes: Record<string, string>,
  via: 'applied' | 'confirmed',
  health: WifiHealth | null
): Promise<void> {
  const now = DateTime.utc()
  const event: ApplyEvent = apply.state === 'sending' ? 'applied' : 'confirmed'
  if (nextApplyState(apply.state as ApplyState, event)) transition(apply, event)
  else apply.state = 'confirmed'
  apply.finishedAt = now
  apply.outcome = { ...(apply.outcome ?? {}), hashes, ...(health ? { health } : {}) }
  const renames = new Map<string, string>()
  for (const op of apply.ops) {
    if (op.op === 'adopt' && op.renameTo) renames.set(op.perchId, op.renameTo)
  }
  const loaded = await loadApSections(ap.apId)
  const changes: Array<{ perchId: string; after: SectionState | null }> = []
  for (const s of loaded.states) {
    if (!apply.perchIds.includes(s.perchId)) continue
    const written: SectionContent | null =
      apply.written && s.perchId in apply.written ? apply.written[s.perchId] : s.router
    let next: SectionState | null = markConfirmed(s, written, {
      authoritative: authoritativeOf(ap),
      rules: registryFor(ap).rules(s.domain),
    })
    const renamed = renames.get(s.perchId)
    if (renamed) next = { ...next, name: renamed, anonymous: false }
    if (isGone(next)) next = null
    changes.push({ perchId: s.perchId, after: next })
  }
  await saveApStates(ap.apId, loaded.rows, changes, {
    now,
    routerAuthor: { kind: 'perch', applyId: apply.applyKey },
  })
  const revision = await writeApRevision(ap, {
    before: loaded.states,
    after: statesAfter(loaded.states, changes),
    source: apply.kind === 'revert' ? 'revert' : 'controller',
    actor: applyActorOf(apply),
    applyId: apply.id,
    rolloutId: apply.rolloutId,
    confirmed: true,
    note: apply.note,
    hashes,
    now,
  })
  apply.revisionNumber = revision
  await apply.save()

  const ledger = new Map<string, LedgerEntry>((ap.observedLedger ?? []).map((e) => [e.perchId, e]))
  for (const id of apply.ledger?.remove ?? []) ledger.delete(id)
  for (const entry of apply.ledger?.set ?? []) ledger.set(entry.perchId, entry)
  for (const op of apply.ops) {
    if (op.op !== 'adopt') continue
    const row = loaded.states.find((s) => s.perchId === op.perchId)
    ledger.set(op.perchId, {
      perchId: op.perchId,
      config: op.config,
      section: op.renameTo ?? op.section,
      domain: row?.domain ?? '',
    })
  }
  ap.observedLedger = [...ledger.values()]
  ap.observedHashes = { ...(ap.observedHashes ?? {}), ...hashes }
  if (apply.kind === 'revert') ap.pinnedHashes = ap.observedHashes
  await ap.save()
  await recordApEvent(ap.apId, 'confirmed', {
    applyId: apply.id,
    revision,
    detail: { applyId: apply.applyKey, kind: apply.kind, via },
  })
  await refreshApSyncState(ap)
  if (!(await chainNext(ap, apply))) notifyRollouts(apply)
}

/** Plans and sends the next job of the request that produced `apply`; false when none. */
async function chainNext(ap: ApConfig, apply: ApConfigApply): Promise<boolean> {
  if (apply.kind === 'revert' || adoptOnlyApply(apply) || apply.chainStep + 1 >= MAX_CHAIN) {
    return false
  }
  const settings = await getWifiConfigSettings()
  const { states } = await loadApSections(ap.apId)
  const plan = planApJobs(ap, states, { perchIds: apply.chainPerchIds ?? undefined })
  const job = plan.jobs[0]
  if (!job) return false
  if (
    validateApStates(ap, states).some(
      (i) => i.severity === 'error' && i.perchId && job.perchIds.includes(i.perchId)
    )
  ) {
    return false
  }
  const next = await createApApply(ap, settings, job, states, {
    actor: applyActorOf(apply),
    perchIds: apply.chainPerchIds ?? undefined,
    confirmMode:
      apply.confirmMode === 'admin_and_agent' && !apply.protected ? 'admin_and_agent' : undefined,
    note: apply.note,
    rolloutId: apply.rolloutId === null ? null : Number(apply.rolloutId),
    kind: 'apply',
    queued: false,
    chainStep: apply.chainStep + 1,
  })
  await recordApEvent(ap.apId, 'apply_requested', {
    actor: applyActorOf(apply),
    applyId: next.id,
    detail: { applyId: next.applyKey, kind: next.kind, chainedFrom: apply.applyKey },
  })
  await sendApApply(ap, next)
  return true
}

// ── rollback and results ─────────────────────────────────────────────────

/** `POST …/applies/:applyId/revert`: the AP restores now; a queued job is cancelled. */
export async function revertApApply(
  apId: number,
  applyKey: string,
  userId: number
): Promise<ApConfigApply> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.findOrFail(apId)
    const apply = await findApApply(apId, applyKey)
    if (apply.state === 'queued') {
      transition(apply, 'cancel')
      apply.finishedAt = DateTime.utc()
      apply.outcome = { ...(apply.outcome ?? {}), reason: 'admin' }
      await apply.save()
      await recordApEvent(apId, 'cancelled', {
        userId,
        applyId: apply.id,
        detail: { applyId: apply.applyKey },
      })
      await refreshApSyncState(ap)
      notifyRollouts(apply)
      return apply
    }
    if (apply.state !== 'pending_confirm') {
      throw wifiError(409, 'not_revertible', 'Only a pending or queued change can be reverted.', {
        state: apply.state,
      })
    }
    const settings = await getWifiConfigSettings()
    if (!writeAccess(ap, settings).writable) {
      throw wifiError(409, 'agent_offline', 'The agent is not reachable; it rolls back by itself.')
    }
    try {
      await apRequest(apId, 'wifi.config.rollback', { applyId: apply.applyKey })
    } catch (error) {
      const code = agentErrorCode(error) ?? 'agent_error'
      throw wifiError(409, code, (error as Error).message)
    }
    apply.outcome = { ...(apply.outcome ?? {}), revertRequestedBy: userId }
    await apply.save()
    await recordApEvent(apId, 'rolled_back', {
      userId,
      applyId: apply.id,
      detail: { applyId: apply.applyKey, requested: true },
    })
    return apply
  })
}

/**
 * One reported outcome (`wifi.config.result`, or the hello's `results` for
 * outcomes that happened while the controller was unreachable), then acked.
 */
export async function applyApResult(ap: ApConfig, result: ApReportedResult): Promise<void> {
  const apply = await ApConfigApply.query()
    .where('ap_id', ap.apId)
    .where('apply_key', result.applyId)
    .first()
  if (apply) await settleResult(ap, apply, result)
  await ackResults(ap, [result.applyId])
}

/** The AP restored its files: R is its pre-job content again, the draft stays. */
function routerBeforeJob(apply: ApConfigApply, s: SectionState): SectionState {
  const before = apply.replacedRouterContent
  if (!before || !(s.perchId in before)) return s
  return { ...s, router: before[s.perchId] ?? null }
}

async function settleResult(ap: ApConfig, apply: ApConfigApply, result: ApReportedResult) {
  const assumed = apply.state === 'rolled_back' && apply.outcome?.assumed === true
  const open = !(FINISHED_APPLY_STATES as string[]).includes(apply.state)
  if (!open && !assumed) return
  const now = DateTime.utc()
  const discarded = (result.discarded ?? {}) as Record<
    string,
    Array<{
      name: string
      type?: string
      anonymous?: boolean
      options?: Record<string, string | string[]>
      secrets?: Record<string, string>
      change?: string
    }>
  >
  const discardedConfigs = Object.keys(discarded)
  if (open) {
    apply.state = result.outcome === 'failed' ? 'failed' : 'rolled_back'
    apply.finishedAt = now
  }
  const health = result.health ? parseHealth(result.health) : apply.health
  apply.outcome = {
    reason: result.reason ?? (result.outcome === 'failed' ? 'failed' : 'rolled_back'),
    ...(result.detail ? { message: String(result.detail).slice(0, 500) } : {}),
    ...(discardedConfigs.length > 0 ? { discardedConfigs } : {}),
    hashes: result.hashes ?? {},
    ...(health ? { health } : {}),
  }
  if (health) {
    apply.health = health
    apply.healthCheckedAt = now
  }
  await apply.save()

  const renames = new Map<string, string>()
  for (const op of apply.ops)
    if (op.op === 'adopt' && op.renameTo) renames.set(op.perchId, op.renameTo)
  const loaded = await loadApSections(ap.apId)
  const changes: Array<{ perchId: string; after: SectionState | null }> = []
  for (const loadedState of loaded.states) {
    if (!apply.perchIds.includes(loadedState.perchId)) continue
    const s = routerBeforeJob(apply, loadedState)
    let lost: SectionContent | null | undefined
    const hit = (discarded[s.config] ?? []).find((d) =>
      [s.name, renames.get(s.perchId) ?? `perch_${s.perchId}`].includes(d.name)
    )
    if (hit) {
      lost =
        hit.change === 'removed'
          ? null
          : contentOf({
              perchId: s.perchId,
              config: s.config,
              name: hit.name,
              type: hit.type || s.type,
              anonymous: hit.anonymous ?? false,
              options: hit.options ?? {},
              ...(hit.secrets
                ? {
                    secrets: Object.fromEntries(
                      Object.entries(hit.secrets).map(([k, fp]) => [k, { fingerprint: fp }])
                    ),
                  }
                : {}),
            })
    }
    changes.push({
      perchId: s.perchId,
      after: markRolledBack(s, {
        authoritative: authoritativeOf(ap),
        now: now.toISO()!,
        discarded: lost,
        rules: registryFor(ap).rules(s.domain),
      }),
    })
  }
  await saveApStates(ap.apId, loaded.rows, changes, {
    now,
    routerAuthor: { kind: 'perch', applyId: apply.applyKey },
  })
  if (result.hashes && Object.keys(result.hashes).length > 0) {
    ap.observedHashes = { ...(ap.observedHashes ?? {}), ...result.hashes }
    await ap.save()
  }
  if (open) {
    const failed = result.outcome === 'failed'
    await recordApEvent(ap.apId, failed ? 'failed' : 'rolled_back', {
      applyId: apply.id,
      detail: { applyId: apply.applyKey, reason: result.reason ?? null, discardedConfigs },
    })
    if (result.reason === 'health_failed') {
      await recordApEvent(ap.apId, 'health_failed', {
        applyId: apply.id,
        detail: { applyId: apply.applyKey, problems: health?.problems ?? [] },
      })
    }
    emitWifiAlert({
      name: 'wifi.apply.rolled_back',
      severity: 'warning',
      source: { kind: 'ap', id: ap.apId },
      dedupeKey: `wifi.apply.rolled_back:${apply.applyKey}`,
      payload: {
        apId: ap.apId,
        applyId: apply.applyKey,
        rolloutId: apply.rolloutId === null ? null : Number(apply.rolloutId),
        reason: result.reason ?? null,
        problems: health?.problems ?? [],
        discardedConfigs,
      },
    })
    await afterFailure(ap, apply)
    notifyRollouts(apply)
  }
  await refreshApSyncState(ap)
}

async function ackResults(ap: ApConfig, applyIds: string[]) {
  if (!apSession(ap.apId)) return
  try {
    await apRequest(ap.apId, 'wifi.config.ack', { applyIds })
  } catch (error) {
    logger.debug({ apId: ap.apId, error: (error as Error).message }, 'wifi_config: ack refused')
  }
}

/** A revert that failed or rolled back counts toward suspension (Authoritative Mode). */
async function afterFailure(ap: ApConfig, apply: ApConfigApply) {
  if (apply.kind !== 'revert' || ap.enforcement === 'suspended') return
  const settings = await getWifiConfigSettings()
  const now = DateTime.utc()
  const since = now.minus({ minutes: settings.enforcementWindowMinutes })
  const failures = await ApConfigApply.query()
    .where('ap_id', ap.apId)
    .where('kind', 'revert')
    .whereIn('state', ['rolled_back', 'failed'])
    .where('finished_at', '>=', since.toSQL({ includeOffset: false })!)
    .select('finished_at')
  const next = enforcementAfterFailure(
    failures.map((f) => f.finishedAt!.toISO()!),
    {
      now: now.toISO()!,
      maxFailures: settings.enforcementMaxFailures,
      windowMinutes: settings.enforcementWindowMinutes,
    }
  )
  if (next === 'suspended') {
    ap.enforcement = 'suspended'
    ap.enforcementChangedAt = now
    await ap.save()
    await recordApEvent(ap.apId, 'enforcement_suspended', {
      applyId: apply.id,
      detail: { failures: failures.length, windowMinutes: settings.enforcementWindowMinutes },
    })
    emitWifiAlert({
      name: 'wifi.enforcement.suspended',
      severity: 'warning',
      source: { kind: 'ap', id: ap.apId },
      dedupeKey: `wifi.enforcement.suspended:${ap.apId}`,
      payload: {
        apId: ap.apId,
        failures: failures.length,
        windowMinutes: settings.enforcementWindowMinutes,
      },
    })
  }
}

export async function findApApply(apId: number, applyKey: string): Promise<ApConfigApply> {
  const apply = await ApConfigApply.query()
    .where('ap_id', apId)
    .where('apply_key', applyKey)
    .first()
  if (!apply) throw wifiError(404, 'apply_not_found', `No change ${applyKey}.`)
  return apply
}

/** A finished job of a rollout wakes the rollout engine (in the fleet queue). */
function notifyRollouts(apply: ApConfigApply) {
  if (apply.rolloutId === null) return
  scheduleFleetWork('advance rollouts', async () => {
    const { advanceRollouts } = await import('#services/wifi_config/rollouts')
    await advanceRollouts()
  })
}

// ── the tick's per-AP work ──────────────────────────────────────────────

/**
 * One AP's timers (in its queue): expire queued jobs, send queued ones the
 * AP can take now, retry confirms (health still pending, a confirm lost on
 * the wire), assume the rollback of jobs whose deadline passed without a
 * result, give up on unanswered sends; then Authoritative enforcement.
 */
export async function tickApJobs(
  ap: ApConfig,
  now: DateTime,
  options: { rolloutStepActive: boolean }
): Promise<void> {
  const settings = await getWifiConfigSettings()
  for (const apply of await openApApplies(ap.apId)) {
    if (apply.state === 'queued') {
      if (apply.queueExpiresAt && apply.queueExpiresAt < now) {
        transition(apply, 'expired')
        apply.finishedAt = now
        apply.outcome = { ...(apply.outcome ?? {}), reason: 'queue_expired' }
        await apply.save()
        await recordApEvent(ap.apId, 'expired', {
          applyId: apply.id,
          detail: { applyId: apply.applyKey },
        })
        notifyRollouts(apply)
        continue
      }
      const busySince = apply.outcome?.busySince
        ? DateTime.fromISO(String(apply.outcome.busySince))
        : null
      if (
        busySince &&
        busySince.isValid &&
        now.diff(busySince, 'seconds').seconds >= BUSY_RETRY_SECONDS
      ) {
        await failApApply(
          ap,
          apply,
          'busy',
          `The access point stayed busy (${String(apply.outcome?.busyReason ?? 'locked')}).`,
          { reason: apply.outcome?.busyReason ?? null }
        )
        continue
      }
      if (writeAccess(ap, settings).writable) await sendApApply(ap, apply)
      continue
    }
    if (apply.state === 'pending_confirm' && apply.deadlineAt) {
      if (apply.deadlineAt.plus({ seconds: DEADLINE_GRACE_SECONDS }) < now) {
        await assumeRolledBack(ap, apply, now)
      } else if (apply.deadlineAt.minus({ seconds: HEALTH_RETRY_MARGIN_SECONDS }) > now) {
        await tryConfirm(ap, apply)
      }
      continue
    }
    if (
      apply.state === 'sending' &&
      apply.sentAt &&
      apply.sentAt.plus({ seconds: SENDING_TIMEOUT_SECONDS }) < now
    ) {
      await failApApply(ap, apply, 'no_answer', 'The agent never answered the change.')
    }
  }
  if (!options.rolloutStepActive) await enforce(ap, settings, now)
  await refreshApSyncState(ap)
}

async function assumeRolledBack(ap: ApConfig, apply: ApConfigApply, now: DateTime) {
  apply.state = 'rolled_back'
  apply.finishedAt = now
  apply.outcome = { ...(apply.outcome ?? {}), reason: 'confirm_timeout', assumed: true }
  await apply.save()
  await markRows(ap, apply.perchIds, (s) => restoreStatus(ap, routerBeforeJob(apply, s)))
  await recordApEvent(ap.apId, 'rolled_back', {
    applyId: apply.id,
    detail: { applyId: apply.applyKey, reason: 'confirm_timeout', assumed: true },
  })
  await afterFailure(ap, apply)
  notifyRollouts(apply)
}

/**
 * Authoritative Mode (config-plane.md 5.3 on the AP's rows): drifted
 * sections whose grace delay elapsed go out in one `revert` job, unless
 * enforcement is suspended, a job is open, a rollout step is active on the
 * AP, or the last revert failed less than one grace delay ago.
 */
async function enforce(ap: ApConfig, settings: WifiConfigSettings, now: DateTime) {
  if (!authoritativeOf(ap) || ap.enforcement !== 'active') return
  if (!writeAccess(ap, settings).writable || apUpdateInFlight(ap.apId)) return
  if (await hasOpenApApply(ap.apId)) return
  const { states } = await loadApSections(ap.apId)
  const due = sectionsDueForRevert(states, {
    now: now.toISO()!,
    delaySeconds: settings.authoritativeRevertDelaySeconds,
    enforcement: 'active',
    authoritative: true,
  })
  if (due.length === 0) return
  const last = await ApConfigApply.query()
    .where('ap_id', ap.apId)
    .where('kind', 'revert')
    .whereNotNull('finished_at')
    .orderBy('finished_at', 'desc')
    .first()
  if (
    last?.finishedAt &&
    last.state !== 'confirmed' &&
    last.finishedAt.plus({ seconds: settings.authoritativeRevertDelaySeconds }) > now
  ) {
    return
  }
  await startApRevert(ap, due, { system: 'enforcement' })
}

/** Queues and sends a revert job for drifted sections (no rollout). */
export async function startApRevert(
  ap: ApConfig,
  perchIds: string[],
  actor: PlaneActor | null
): Promise<ApConfigApply | null> {
  const settings = await getWifiConfigSettings()
  const { states } = await loadApSections(ap.apId)
  const plan = planApJobs(ap, states, { kind: 'revert', perchIds })
  const job = plan.jobs.find((j) => j.kind === 'revert') ?? plan.jobs[0]
  if (!job) return null
  const apply = await createApApply(ap, settings, job, states, {
    actor,
    perchIds,
    kind: 'revert',
    queued: false,
    chainStep: 0,
  })
  await recordApEvent(ap.apId, 'apply_requested', {
    actor,
    applyId: apply.id,
    detail: { applyId: apply.applyKey, kind: 'revert', perchIds: job.perchIds },
  })
  emitWifiAlert({
    name: 'wifi.drift.reverted',
    severity: 'info',
    source: { kind: 'ap', id: ap.apId },
    dedupeKey: `wifi.drift.reverted:${apply.applyKey}`,
    payload: { apId: ap.apId, applyId: apply.applyKey },
  })
  await sendApApply(ap, apply)
  await apply.refresh()
  return apply
}
