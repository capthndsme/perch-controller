import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewaySecret from '#models/gateway_secret'
import { AgentOfflineError, AgentTimeoutError } from '#services/collector_agent_hub'
import { planApply, type PlannedJob } from '#services/gateway_config/apply_plan'
import { contentOf, validateDesired, type SyncedSection } from '#services/gateway_config/domain'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import {
  agentErrorCode,
  fetchCapabilities,
  gatewayRequest,
  readAndReconcile,
} from '#services/gateway_config/gateway_agent'
import {
  confirmTimeoutFor,
  getGatewayConfigSettings,
  type GatewayConfigSettings,
} from '#services/gateway_config/gateway_config_settings'
import {
  gatewaySession,
  normalizeMode,
  parseApplyResult,
  writeAccess,
  type AgentApplyResult,
  type WriteAccess,
} from '#services/gateway_config/gateway_registry'
import {
  hasOpenApply,
  loadSections,
  openApplies,
  refreshSyncState,
  saveStates,
  writeRevision,
} from '#services/gateway_config/gateway_store'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import {
  enforcementAfterFailure,
  FINISHED_APPLY_STATES,
  isGone,
  markConfirmed,
  markInFlight,
  markRolledBack,
  nextApplyState,
  authoritativeFor,
  sectionsDueForRevert,
  type ApplyEvent,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import {
  actorColumns,
  parseSystemActor,
  type ApplyKind,
  type ApplyState,
  type ConfigDiffEntry,
  type ConfirmMode,
  type Issue,
  type LedgerEntry,
  type PlaneActor,
  type SectionContent,
} from '#services/gateway_config/types'
import logger from '@adonisjs/core/services/logger'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * The apply lifecycle (docs/gateway/config-plane.md sections 3.4, 5.5, 5.6):
 *
 *   queued ─online─► sending ─agent committed─► pending_confirm ─► confirmed
 *                        │                         └ deadline / revert / reboot ► rolled_back
 *                        └ refused ► failed           (queued ► expired | cancelled)
 *
 * - One job at a time per gateway; the planner's first job is sent, and
 *   after it confirms the next job of the same request is planned from the
 *   rows as they are then (the hashes changed).
 * - Confirm: the agent commits, drops its session and dials a fresh one.
 *   The agent half is that fresh session plus the first accepted push on
 *   it; in `admin_and_agent` mode the admin's "Keep changes" is needed too
 *   (it may come first). Then `gateway.config.confirm` goes out on the new
 *   session, and B := R := written, with a confirmed revision.
 * - The agent's deadline is authoritative: without a confirm it rolls back
 *   by itself and reports `gateway.config.result` (now, or in the next
 *   hello's `results`). When nothing arrives within the deadline plus
 *   `DEADLINE_GRACE_SECONDS`, the controller assumes the rollback.
 * - Authoritative Mode (section 5.3): the tick sends a `revert` job for
 *   drifted sections whose grace delay elapsed; failed or rolled-back reverts
 *   inside the window suspend enforcement.
 *
 * Every step runs inside the gateway's serial queue.
 */

/** After the agent's deadline, how long the controller waits for its result. */
export const DEADLINE_GRACE_SECONDS = 30
/** A job the agent never answered (it may be mid-commit; its hello tells). */
export const SENDING_TIMEOUT_SECONDS = 120
export const APPLY_RPC_TIMEOUT_MS = 30_000
/** Longest chain of jobs one request produces (adopt, apply, protected, …). */
const MAX_CHAIN = 5

export type ApplyRequest = {
  userId: number | null
  /**
   * Who asks, when it is not (only) a user: `{ system: 'qos' }` for writes
   * Perch makes by itself (section 6.8). Wins over `userId`.
   */
  actor?: PlaneActor | null
  perchIds?: string[]
  kind?: 'apply' | 'revert'
  dryRun?: boolean
  confirmMode?: ConfirmMode
  note?: string | null
}

export type DryRunResult = {
  changes: ConfigDiffEntry[]
  agentChanges: unknown[]
  issues: Issue[]
}

/** The request's actor: `actor`, else the user. */
function requestActor(request: Pick<ApplyRequest, 'userId' | 'actor'>): PlaneActor | null {
  return request.actor ?? request.userId
}

/** Who asked for an apply (a user, or Perch itself), for its events and revision. */
export function applyActor(apply: GatewayApply): PlaneActor | null {
  const system = parseSystemActor(apply.systemActor)
  if (system) return { system }
  return apply.requestedByUserId
}

function newApplyKey(gatewayId: number): string {
  return `g${gatewayId}-${randomBytes(6).toString('hex')}`
}

function authoritativeOf(gateway: Gateway): boolean {
  return normalizeMode(gateway.mode) === 'managed' && Boolean(gateway.authoritative)
}

/** Authoritative for one section: the gateway's flag, or a one-way domain (README 2). */
function authoritativeRow(gateway: Gateway, domain: string | null): boolean {
  return authoritativeFor(
    { mode: normalizeMode(gateway.mode), authoritative: Boolean(gateway.authoritative) },
    domainRegistry(),
    domain
  )
}

/** Desired synced sections for validation, plus the unmanaged ones. */
export function validationInput(states: SectionState[]) {
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
    }))
  return { desired, unmanaged }
}

/** LAN-side networks from the synced or mirrored `network` interfaces (validation context). */
export function lanNetworks(states: SectionState[]): Array<{ name: string; ipv4: string[] }> {
  const out: Array<{ name: string; ipv4: string[] }> = []
  for (const s of states) {
    const content = s.router ?? s.desired
    if (s.config !== 'network' || !content || content.type !== 'interface') continue
    const proto = content.options.proto
    if (proto !== 'static') continue
    const ip = content.options.ipaddr
    const mask = content.options.netmask
    const list = Array.isArray(ip) ? ip : typeof ip === 'string' ? [ip] : []
    const ipv4 = list.map((a) =>
      a.includes('/') ? a : typeof mask === 'string' ? `${a}/${maskBits(mask)}` : `${a}/24`
    )
    if (ipv4.length > 0) out.push({ name: s.name, ipv4 })
  }
  return out
}

function maskBits(mask: string): number {
  return mask
    .split('.')
    .map((p) => Number(p).toString(2).replaceAll('0', '').length)
    .reduce((a, b) => a + b, 0)
}

export function validateStates(gateway: Gateway, states: SectionState[]): Issue[] {
  const { desired, unmanaged } = validationInput(states)
  return validateDesired(domainRegistry(), desired, {
    capabilities: gateway.capabilities,
    unmanaged,
    networks: lanNetworks(states),
    managementPath: gateway.managementPath,
  })
}

function planFor(gateway: Gateway, states: SectionState[], request: ApplyRequest) {
  return planApply({
    sections: states,
    perchIds: request.perchIds,
    kind: request.kind ?? 'apply',
    ledger: gateway.observedLedger ?? [],
    hashes: gateway.observedHashes ?? {},
    management: gateway.managementPath,
    registry: domainRegistry(),
  })
}

// ── requesting ───────────────────────────────────────────────────────────

/**
 * `POST /gateways/:id/applies` (and the enforcement tick): plans the draft
 * and queues its first job, sending it at once when the agent is online.
 * A dry run sends the job with `dryRun` and returns both diffs.
 */
export async function requestApply(
  gatewayId: number,
  request: ApplyRequest
): Promise<GatewayApply | DryRunResult> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.findOrFail(gatewayId)
    const settings = await getGatewayConfigSettings()
    if (normalizeMode(gateway.mode) !== 'managed') {
      throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
    }
    const open = await openApplies(gateway.id)
    if (open.length > 0 && !request.dryRun) {
      throw planeError(409, 'apply_in_flight', 'Another apply is not finished yet.', {
        applyId: open[0].applyKey,
      })
    }
    const { states } = await loadSections(gateway.id)
    if (request.perchIds) {
      const conflicted = states
        .filter((s) => request.perchIds!.includes(s.perchId) && s.conflict !== null)
        .map((s) => s.perchId)
      if (conflicted.length > 0) {
        throw planeError(409, 'conflicts_open', 'Resolve the conflicts first.', {
          perchIds: conflicted,
        })
      }
    }
    const kind = request.kind ?? 'apply'
    const plan = planFor(gateway, states, request)
    // Errors block only the sections this request changes: an odd section
    // imported from the router does not freeze every other edit.
    const planned = new Set(plan.jobs.flatMap((j) => j.perchIds))
    const issues = validateStates(gateway, states).filter(
      (i) => !i.perchId || planned.has(i.perchId)
    )
    const errors = issues.filter((i) => i.severity === 'error')
    if (errors.length > 0 && kind === 'apply') {
      throw planeError(422, 'invalid_config', 'The desired configuration has errors.', {
        issues: errors,
      })
    }
    const job = plan.jobs[0]
    if (!job) {
      const conflicted = plan.blocked.filter((b) => b.reason === 'conflict').map((b) => b.perchId)
      if (conflicted.length > 0) {
        throw planeError(409, 'conflicts_open', 'Resolve the conflicts first.', {
          perchIds: conflicted,
        })
      }
      throw planeError(409, 'nothing_to_apply', 'There is nothing to apply.')
    }
    const access = writeAccess(gateway, settings)

    if (request.dryRun) {
      if (!access.writable) {
        throw planeError(
          409,
          access.reason === 'offline' ? 'agent_offline' : blockCode(access.reason),
          'A dry run needs the agent online and writable.'
        )
      }
      const result = await gatewayRequest<Record<string, unknown>>(
        gateway,
        'gateway.config.apply',
        await applyParams(gateway, newApplyKey(gateway.id), job, 0, true, access),
        { timeoutMs: APPLY_RPC_TIMEOUT_MS, access }
      ).catch((error) => {
        throw agentFailure(error)
      })
      return {
        changes: plan.jobs.flatMap((j) => j.changes),
        agentChanges: Array.isArray(result?.changes) ? result.changes : [],
        issues,
      }
    }

    if (!access.writable && access.reason !== 'offline') {
      throw planeError(409, blockCode(access.reason), writeBlockMessage(access.reason))
    }
    if (access.writable && access.signed && job.secretRefs.length > 0) {
      throw planeError(
        409,
        'insecure_transport',
        'Secrets are only sent over verified TLS; signed plain-HTTP applies cannot carry them.'
      )
    }

    const apply = await createApply(gateway, settings, job, {
      ...request,
      kind,
      queued: !access.writable,
      chainStep: 0,
    })
    await recordGatewayEvent(gateway.id, 'apply_requested', {
      actor: requestActor(request),
      applyId: Number(apply.id),
      detail: {
        applyId: apply.applyKey,
        kind: apply.kind,
        perchIds: apply.perchIds,
        queued: !access.writable,
      },
    })
    if (access.writable) await sendApply(gateway, apply)
    await apply.refresh()
    return apply
  })
}

function blockCode(reason: string): string {
  switch (reason) {
    case 'router_access':
      return 'router_access_insufficient'
    case 'no_capability':
      return 'no_capability'
    case 'offline':
      return 'agent_offline'
    case 'not_paired':
      return 'not_paired'
    default:
      return 'insecure_transport'
  }
}

function writeBlockMessage(reason: string): string {
  switch (reason) {
    case 'router_access':
      return "The router does not allow writes (config_access is not 'write')."
    case 'not_paired':
      return 'Writes over plain HTTP need the gateway paired with this controller first.'
    case 'sign_key_unknown':
      return "The router signs with its own config_sign_key, which the controller doesn't hold."
    case 'no_capability':
      return 'The collector has no config plane (update it).'
    default:
      return 'Writes need verified TLS, or the plain-HTTP opt-in on both the controller and the router.'
  }
}

async function createApply(
  gateway: Gateway,
  settings: GatewayConfigSettings,
  job: PlannedJob,
  options: Omit<ApplyRequest, 'kind'> & { kind: ApplyKind; queued: boolean; chainStep: number }
): Promise<GatewayApply> {
  const now = DateTime.utc()
  const apply = new GatewayApply()
  apply.gatewayId = gateway.id
  apply.applyKey = newApplyKey(gateway.id)
  apply.kind = job.kind
  apply.state = 'queued'
  applyJob(apply, job)
  // Queued applies always confirm by the agent alone (section 5.5): the
  // admin may be long gone when the router comes back.
  apply.confirmMode =
    options.queued || job.kind === 'revert'
      ? 'agent'
      : (options.confirmMode ?? settings.confirmMode)
  apply.confirmTimeoutSeconds = confirmTimeoutFor(settings, {
    protected: job.protected,
    routerMaxSeconds: routerConfirmMax(gateway),
  })
  const actor = actorColumns(requestActor(options))
  apply.requestedByUserId = actor.userId
  apply.systemActor = actor.systemActor
  apply.note = options.note ? options.note.slice(0, 500) : null
  apply.requestedAt = now
  apply.queueExpiresAt = now.plus({ hours: settings.queueExpiryHours })
  apply.chainPerchIds = options.perchIds ?? null
  apply.chainStep = options.chainStep
  apply.retried = false
  apply.signed = false
  await apply.save()
  return apply
}

function applyJob(apply: GatewayApply, job: PlannedJob) {
  apply.kind = job.kind
  apply.ops = job.ops
  apply.baseHashes = job.base
  apply.perchIds = job.perchIds
  apply.protected = job.protected
  apply.written = job.written
  apply.ledger = job.ledger
  apply.secretRefs = job.secretRefs
  apply.configs = job.configs
  apply.changes = job.changes
  // The router's content before the job: a rollback restores it (and a
  // revert keeps it for "Restore router version").
  apply.replacedRouterContent = job.replaced
}

function routerConfirmMax(gateway: Gateway): number | null {
  const caps = gateway.capabilities as Record<string, unknown> | null
  const value = caps?.confirmMaxSeconds
  return typeof value === 'number' && value > 0 ? value : null
}

async function applyParams(
  gateway: Gateway,
  applyKey: string,
  job: Pick<PlannedJob, 'kind' | 'protected' | 'base' | 'ops' | 'ledger' | 'secretRefs'>,
  confirmTimeoutSeconds: number,
  dryRun: boolean,
  access: WriteAccess
): Promise<Record<string, unknown>> {
  // The agent needs the hash of every config an op touches ("" = no file).
  const base: Record<string, string> = { ...job.base }
  for (const op of job.ops) {
    if (base[op.config] === undefined) base[op.config] = gateway.observedHashes?.[op.config] ?? ''
  }
  const params: Record<string, unknown> = {
    applyId: applyKey,
    kind: job.kind,
    dryRun,
    base,
    ops: job.ops,
    ledger: job.ledger,
  }
  if (job.protected) params.protected = true
  if (confirmTimeoutSeconds > 0) params.confirmTimeoutSeconds = confirmTimeoutSeconds
  if (job.secretRefs.length > 0 && access.writable && !access.signed) {
    const rows = await GatewaySecret.query()
      .where('gateway_id', gateway.id)
      .whereIn('ref', job.secretRefs)
    const secrets: Record<string, string> = {}
    for (const row of rows) if (row.value !== null) secrets[row.ref] = row.value
    params.secrets = secrets
  }
  return params
}

function agentFailure(error: unknown) {
  if (error instanceof AgentOfflineError) {
    return planeError(409, 'agent_offline', 'The gateway agent is not connected.')
  }
  if (error instanceof AgentTimeoutError) {
    return planeError(504, 'agent_timeout', 'The gateway agent did not answer in time.')
  }
  const code = agentErrorCode(error)
  const data = (error as { data?: Record<string, unknown> }).data ?? {}
  const extra = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'error'))
  return planeError(
    code === 'bad_params' ? 422 : 409,
    code ?? 'agent_error',
    (error as Error).message ?? 'agent error',
    extra
  )
}

// ── sending ──────────────────────────────────────────────────────────────

function transition(apply: GatewayApply, event: ApplyEvent): ApplyState {
  const next = nextApplyState(apply.state as ApplyState, event)
  if (!next) throw new Error(`apply ${apply.applyKey}: ${event} not valid in ${apply.state}`)
  apply.state = next
  return next
}

/**
 * Sends a queued job. Re-plans it from the current rows first (a job that
 * waited for the agent may be stale): a job that lost its work finishes as
 * cancelled, one whose sections are in conflict now fails.
 */
export async function sendApply(gateway: Gateway, apply: GatewayApply): Promise<void> {
  if (apply.kind === 'package') return sendPackageJob(gateway, apply)
  const settings = await getGatewayConfigSettings()
  const access = writeAccess(gateway, settings)
  if (!access.writable) return
  const { states } = await loadSections(gateway.id)
  const plan = planFor(gateway, states, {
    userId: null,
    kind: apply.kind === 'revert' ? 'revert' : 'apply',
    perchIds: apply.chainPerchIds ?? (apply.kind === 'revert' ? apply.perchIds : undefined),
  })
  const job = plan.jobs[0]
  if (!job) {
    const conflicted = plan.blocked.filter((b) => b.reason === 'conflict').map((b) => b.perchId)
    apply.state = conflicted.length > 0 ? 'failed' : 'cancelled'
    apply.finishedAt = DateTime.utc()
    apply.outcome = {
      reason: conflicted.length > 0 ? 'conflicts_open' : 'nothing_to_apply',
      message:
        conflicted.length > 0
          ? 'Sections of this apply are in conflict now.'
          : 'Nothing left to apply.',
    }
    await apply.save()
    await recordGatewayEvent(gateway.id, conflicted.length > 0 ? 'failed' : 'cancelled', {
      applyId: Number(apply.id),
      detail: { applyId: apply.applyKey, reason: apply.outcome.reason },
    })
    await refreshSyncState(gateway)
    return
  }
  if (access.signed && job.secretRefs.length > 0) {
    await failApply(gateway, apply, 'insecure_transport', 'Secrets need verified TLS.')
    return
  }
  // The agent records each adopted section's domain in its ledger.
  const domains = new Map(states.map((s) => [s.perchId, s.domain]))
  job.ops = job.ops.map((op) =>
    op.op === 'adopt' && domains.get(op.perchId) ? { ...op, domain: domains.get(op.perchId)! } : op
  )
  applyJob(apply, job)
  transition(apply, 'send')
  apply.sentAt = DateTime.utc()
  apply.signed = access.signed
  await apply.save()
  await markRows(gateway, apply.perchIds, (s) =>
    markInFlight(s, apply.kind === 'revert' ? 'revert' : 'apply')
  )
  await refreshSyncState(gateway)

  let result: Record<string, unknown> | null
  try {
    result = await gatewayRequest<Record<string, unknown>>(
      gateway,
      'gateway.config.apply',
      await applyParams(gateway, apply.applyKey, job, apply.confirmTimeoutSeconds, false, access),
      { timeoutMs: APPLY_RPC_TIMEOUT_MS, access }
    )
  } catch (error) {
    await onSendError(gateway, apply, error)
    return
  }
  await onApplyReply(gateway, apply, result ?? {})
}

async function onSendError(gateway: Gateway, apply: GatewayApply, error: unknown) {
  if (error instanceof AgentOfflineError || error instanceof AgentTimeoutError) {
    // The agent may have committed and dropped the session on purpose: its
    // next hello says whether the apply is pending (section 3.4 step 5).
    logger.info(
      { gatewayId: gateway.id, applyId: apply.applyKey, error: (error as Error).message },
      'apply_lifecycle: no reply to the apply; waiting for the agent'
    )
    return
  }
  const code = agentErrorCode(error) ?? 'apply_failed'
  const data = (error as { data?: Record<string, unknown> }).data
  if (data?.rolledBack === true && data.result && typeof data.result === 'object') {
    // Failed after the first commit: the agent rolled back already.
    const parsed = parseApplyResult(data.result)
    if (parsed) {
      await applyResult(gateway, parsed)
      return
    }
  }
  if (code === 'stale_base' && !apply.retried) {
    // Section 5.5: read, merge, retry once when the merge opened no conflict.
    apply.retried = true
    apply.state = 'queued'
    await apply.save()
    await markRows(gateway, apply.perchIds, (s) => restoreStatus(gateway, s))
    try {
      await readAndReconcile(gateway.id, { reason: 'stale_base' })
    } catch {
      // The retry below re-checks everything.
    }
    await gateway.refresh()
    await sendApply(gateway, apply)
    return
  }
  // The agent's refusal details (`detail`, `minWanKbit`, `configs`, …) stay
  // on the outcome: the feature that asked shows them.
  const extra = data
    ? Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== 'error' && key !== 'result')
      )
    : {}
  await failApply(gateway, apply, code, (error as Error).message, extra)
}

async function onApplyReply(
  gateway: Gateway,
  apply: GatewayApply,
  result: Record<string, unknown>
) {
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
    await apply.save()
    await recordGatewayEvent(gateway.id, 'applied', {
      applyId: Number(apply.id),
      detail: {
        applyId: apply.applyKey,
        state,
        deadline: apply.deadlineAt.toISO(),
        signed: apply.signed,
      },
    })
    await refreshSyncState(gateway)
    return
  }
  if (state === 'applied' || state === 'noop' || state === 'confirmed') {
    await finishConfirmed(gateway, apply, hashesOf(result.hashes), 'applied')
    return
  }
  await failApply(gateway, apply, 'apply_failed', `unexpected apply reply state "${state}"`)
}

/** An agent's error data, bounded (it is stored and served). */
function boundedData(data: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(data)
  return text.length <= 2000 ? data : { truncated: true }
}

function hashesOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string')
  ) as Record<string, string>
}

async function failApply(
  gateway: Gateway,
  apply: GatewayApply,
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
  await markRows(gateway, apply.perchIds, (s) => restoreStatus(gateway, s))
  await recordGatewayEvent(gateway.id, 'failed', {
    applyId: Number(apply.id),
    detail: { applyId: apply.applyKey, error, message: message.slice(0, 500) },
  })
  await afterFailure(gateway, apply)
  await refreshSyncState(gateway)
}

/** Status of a row whose job ended without a change on the router. */
function restoreStatus(gateway: Gateway, s: SectionState): SectionState {
  return markRolledBack(s, {
    authoritative: authoritativeRow(gateway, s.domain),
    now: DateTime.utc().toISO()!,
    rules: domainRegistry().rules(s.domain),
  })
}

async function markRows(
  gateway: Gateway,
  perchIds: string[],
  fn: (s: SectionState) => SectionState | null
): Promise<void> {
  if (perchIds.length === 0) return
  const loaded = await loadSections(gateway.id)
  const changes: Array<{ perchId: string; after: SectionState | null }> = []
  for (const s of loaded.states) {
    if (!perchIds.includes(s.perchId)) continue
    changes.push({ perchId: s.perchId, after: fn(s) })
  }
  await saveStates(gateway.id, loaded.rows, changes)
}

// ── confirming ───────────────────────────────────────────────────────────

/**
 * The agent's hello on a fresh session (section 3.4 step 5): the pending
 * apply's agent half starts here. Also resolves a `sending` job whose reply
 * was lost: the hello's `apply` block says whether it is pending.
 */
export async function onAgentReconnected(gateway: Gateway): Promise<void> {
  const session = gatewaySession(gateway.collectorId)
  if (!session) return
  const open = await openApplies(gateway.id)
  for (const apply of open) {
    if (apply.state !== 'sending' && apply.state !== 'pending_confirm') continue
    if (!apply.sentAt || session.connectedAt < apply.sentAt) continue
    const agentApply = session.hello.apply
    const pendingHere =
      agentApply.state === 'pending_confirm' && agentApply.applyId === apply.applyKey
    if (apply.state === 'sending') {
      if (pendingHere) {
        await onApplyReply(gateway, apply, {
          state: 'pending_confirm',
          deadline: agentApply.deadline,
        })
      } else if (!session.hello.results.some((r) => r.applyId === apply.applyKey)) {
        await failApply(gateway, apply, 'no_answer', 'The agent reconnected without the apply.')
        continue
      }
    }
    if (apply.state !== 'pending_confirm') continue
    if (!pendingHere) {
      // Its outcome is in the hello's results (handled by the caller), or
      // the agent restarted without it: the deadline tick settles it.
      continue
    }
    if (agentApply.deadline) {
      const deadline = DateTime.fromISO(agentApply.deadline)
      if (deadline.isValid) apply.deadlineAt = deadline.toUTC()
    }
    apply.agentReconnectedAt = DateTime.utc()
    await apply.save()
  }
}

/** The first accepted `collector.push` on a fresh session: the agent half of the confirm. */
export async function onPushAccepted(gateway: Gateway): Promise<void> {
  const open = await openApplies(gateway.id)
  const apply = open.find((a) => a.state === 'pending_confirm')
  if (!apply || !apply.agentReconnectedAt || apply.agentConfirmedAt) return
  apply.agentConfirmedAt = DateTime.utc()
  await apply.save()
  await tryConfirm(gateway, apply)
}

/**
 * "Keep changes" (`POST …/applies/:applyId/confirm`): the admin half. It may
 * come before the agent is back.
 */
export async function adminConfirm(
  gatewayId: number,
  applyKey: string,
  userId: number
): Promise<GatewayApply> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.findOrFail(gatewayId)
    const apply = await findApply(gateway.id, applyKey)
    if (apply.state !== 'pending_confirm' && apply.state !== 'sending') {
      throw planeError(409, 'not_pending', 'This apply is not waiting for a confirmation.', {
        state: apply.state,
      })
    }
    if (apply.deadlineAt && apply.deadlineAt < DateTime.utc()) {
      throw planeError(410, 'deadline_passed', 'The confirm window has closed.')
    }
    apply.adminConfirmedAt = DateTime.utc()
    apply.adminConfirmedBy = userId
    await apply.save()
    await recordGatewayEvent(gateway.id, 'confirmed', {
      userId,
      applyId: Number(apply.id),
      detail: { applyId: apply.applyKey, by: 'admin' },
    })
    await tryConfirm(gateway, apply)
    await apply.refresh()
    return apply
  })
}

async function tryConfirm(gateway: Gateway, apply: GatewayApply): Promise<void> {
  if (apply.state !== 'pending_confirm' || !apply.agentConfirmedAt) return
  if (apply.confirmMode === 'admin_and_agent' && !apply.adminConfirmedAt) return
  const settings = await getGatewayConfigSettings()
  const access = writeAccess(gateway, settings)
  if (!access.writable) return
  let result: Record<string, unknown> | null
  try {
    result = await gatewayRequest<Record<string, unknown>>(
      gateway,
      'gateway.config.confirm',
      { applyId: apply.applyKey },
      { access }
    )
  } catch (error) {
    const code = agentErrorCode(error)
    const data = (error as { data?: Record<string, unknown> }).data
    if (code === 'deadline_passed' && data && typeof data.result === 'object') {
      const parsed = parseApplyResult(data.result)
      if (parsed) await applyResult(gateway, parsed)
      return
    }
    if (code === 'unknown_apply') {
      await failApply(gateway, apply, code, (error as Error).message)
      return
    }
    logger.warn(
      { gatewayId: gateway.id, applyId: apply.applyKey, error: (error as Error).message },
      'apply_lifecycle: confirm failed; will retry'
    )
    return
  }
  await finishConfirmed(gateway, apply, hashesOf(result?.hashes), 'confirmed')
}

/**
 * The job is live and kept: B := R := written for its sections (renamed
 * adoptions take their new name), a confirmed revision, the ledger as the
 * agent now has it, then the next job of the same request.
 */
async function finishConfirmed(
  gateway: Gateway,
  apply: GatewayApply,
  hashes: Record<string, string>,
  via: 'applied' | 'confirmed'
): Promise<void> {
  const now = DateTime.utc()
  const event: ApplyEvent = apply.state === 'sending' ? 'applied' : 'confirmed'
  if (nextApplyState(apply.state as ApplyState, event)) transition(apply, event)
  else apply.state = 'confirmed'
  apply.finishedAt = now
  apply.outcome = { ...(apply.outcome ?? {}), hashes }
  const renames = new Map<string, string>()
  for (const op of apply.ops) {
    if (op.op === 'adopt' && op.renameTo) renames.set(op.perchId, op.renameTo)
  }

  const loaded = await loadSections(gateway.id)
  const changes: Array<{ perchId: string; after: SectionState | null }> = []
  const after = new Map(loaded.states.map((s) => [s.perchId, s]))
  for (const s of loaded.states) {
    if (!apply.perchIds.includes(s.perchId)) continue
    const written: SectionContent | null =
      apply.written && s.perchId in apply.written ? apply.written[s.perchId] : s.router
    let next: SectionState | null = markConfirmed(s, written, {
      authoritative: authoritativeRow(gateway, s.domain),
      rules: domainRegistry().rules(s.domain),
    })
    const renamed = renames.get(s.perchId)
    if (renamed) next = { ...next, name: renamed, anonymous: false }
    if (isGone(next)) next = null
    changes.push({ perchId: s.perchId, after: next })
    if (next) after.set(s.perchId, next)
    else after.delete(s.perchId)
  }
  await saveStates(gateway.id, loaded.rows, changes, {
    now,
    routerAuthor: { kind: 'perch', applyId: apply.applyKey },
  })
  const revision = await writeRevision(gateway, {
    before: loaded.states,
    after: [...after.values()],
    source: apply.kind === 'revert' ? 'revert' : 'controller',
    actor: applyActor(apply),
    applyId: Number(apply.id),
    confirmed: true,
    note: apply.note,
    hashes,
    now,
  })
  apply.revisionNumber = revision
  await apply.save()

  // The ledger as the agent has it now (a later read confirms it).
  const ledger = new Map<string, LedgerEntry>(
    (gateway.observedLedger ?? []).map((e) => [e.perchId, e])
  )
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
  gateway.observedLedger = [...ledger.values()]
  gateway.observedHashes = { ...(gateway.observedHashes ?? {}), ...hashes }
  if (apply.kind === 'revert') gateway.pinnedHashes = gateway.observedHashes
  await gateway.save()
  await recordGatewayEvent(gateway.id, 'confirmed', {
    applyId: Number(apply.id),
    revision,
    detail: { applyId: apply.applyKey, kind: apply.kind, via },
  })
  await refreshSyncState(gateway)
  if (apply.kind === 'package') {
    // The router's package list changed: capabilities say what is there now.
    await fetchCapabilities(gateway).catch(() => undefined)
    return
  }
  await chainNext(gateway, apply)
}

/** Plans and sends the next job of the request that produced `apply`. */
async function chainNext(gateway: Gateway, apply: GatewayApply): Promise<void> {
  if (apply.kind === 'revert' || apply.chainStep + 1 >= MAX_CHAIN) return
  const settings = await getGatewayConfigSettings()
  const { states } = await loadSections(gateway.id)
  const request: ApplyRequest = {
    userId: apply.requestedByUserId,
    actor: applyActor(apply),
    perchIds: apply.chainPerchIds ?? undefined,
  }
  // Only the sections the request covered: without a filter, the ones the
  // first job and its siblings carried are the whole draft of that moment.
  const plan = planFor(gateway, states, request)
  const job = plan.jobs[0]
  if (!job) return
  if (
    validateStates(gateway, states).some(
      (i) => i.severity === 'error' && i.perchId && job.perchIds.includes(i.perchId)
    )
  ) {
    return
  }
  const next = await createApply(gateway, settings, job, {
    ...request,
    confirmMode: apply.confirmMode as ConfirmMode,
    note: apply.note,
    kind: job.kind,
    queued: false,
    chainStep: apply.chainStep + 1,
  })
  await recordGatewayEvent(gateway.id, 'apply_requested', {
    actor: applyActor(apply),
    applyId: Number(next.id),
    detail: { applyId: next.applyKey, kind: next.kind, chainedFrom: apply.applyKey },
  })
  await sendApply(gateway, next)
}

// ── rollback and results ─────────────────────────────────────────────────

/**
 * `POST …/applies/:applyId/revert`: a pending job is rolled back now on the
 * router (its result arrives as `gateway.config.result`); a queued one is
 * cancelled.
 */
export async function revertApply(
  gatewayId: number,
  applyKey: string,
  userId: number
): Promise<GatewayApply> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.findOrFail(gatewayId)
    const apply = await findApply(gateway.id, applyKey)
    if (apply.state === 'queued') {
      transition(apply, 'cancel')
      apply.finishedAt = DateTime.utc()
      apply.outcome = { reason: 'admin' }
      await apply.save()
      await recordGatewayEvent(gateway.id, 'cancelled', {
        userId,
        applyId: Number(apply.id),
        detail: { applyId: apply.applyKey },
      })
      await refreshSyncState(gateway)
      return apply
    }
    if (apply.state !== 'pending_confirm') {
      throw planeError(409, 'not_revertible', 'Only a pending or queued apply can be reverted.', {
        state: apply.state,
      })
    }
    const settings = await getGatewayConfigSettings()
    const access = writeAccess(gateway, settings)
    if (!access.writable) {
      throw planeError(409, 'agent_offline', 'The agent is not reachable; it rolls back by itself.')
    }
    try {
      await gatewayRequest(
        gateway,
        'gateway.config.rollback',
        { applyId: apply.applyKey },
        { access }
      )
    } catch (error) {
      throw agentFailure(error)
    }
    apply.outcome = { ...(apply.outcome ?? {}), revertRequestedBy: userId }
    await apply.save()
    await recordGatewayEvent(gateway.id, 'rolled_back', {
      userId,
      applyId: Number(apply.id),
      detail: { applyId: apply.applyKey, requested: true },
    })
    return apply
  })
}

/**
 * One outcome the agent reported (`gateway.config.result`, or the hello's
 * `results` for outcomes that happened while the controller was
 * unreachable). Rolled back: the draft stays, and router edits the rollback
 * discarded come back as conflicts (section 5.5). Acked afterwards.
 */
export async function applyResult(gateway: Gateway, result: AgentApplyResult): Promise<void> {
  const apply = await GatewayApply.query()
    .where('gateway_id', gateway.id)
    .where('apply_key', result.applyId)
    .first()
  if (apply) {
    if (result.outcome === 'confirmed') {
      if (!(FINISHED_APPLY_STATES as string[]).includes(apply.state)) {
        await finishConfirmed(gateway, apply, result.hashes ?? {}, 'confirmed')
      }
    } else if (result.outcome === 'rolled_back' || result.outcome === 'failed') {
      await settleRolledBack(gateway, apply, result)
    }
  }
  await ackResults(gateway, [result.applyId])
}

async function settleRolledBack(gateway: Gateway, apply: GatewayApply, result: AgentApplyResult) {
  const assumed = apply.state === 'rolled_back' && apply.outcome?.assumed === true
  const open = !(FINISHED_APPLY_STATES as string[]).includes(apply.state)
  if (!open && !assumed) return
  const now = DateTime.utc()
  const discardedConfigs = Object.keys(result.discarded ?? {})
  if (open) {
    apply.state = result.outcome === 'failed' ? 'failed' : 'rolled_back'
    apply.finishedAt = now
  }
  apply.outcome = {
    reason: result.reason ?? (result.outcome === 'failed' ? 'failed' : 'rolled_back'),
    ...(result.detail ? { message: result.detail } : {}),
    ...(discardedConfigs.length > 0 ? { discardedConfigs } : {}),
    hashes: result.hashes ?? {},
  }
  await apply.save()

  // Discarded router edits, matched to the job's sections by name.
  const renames = new Map<string, string>()
  for (const op of apply.ops)
    if (op.op === 'adopt' && op.renameTo) renames.set(op.perchId, op.renameTo)
  const loaded = await loadSections(gateway.id)
  const changes: Array<{ perchId: string; after: SectionState | null }> = []
  for (const loadedState of loaded.states) {
    if (!apply.perchIds.includes(loadedState.perchId)) continue
    const s = routerBeforeJob(apply, loadedState)
    let discarded: SectionContent | null | undefined
    const list = result.discarded?.[s.config] ?? []
    const names = [s.name, renames.get(s.perchId) ?? `perch_${s.perchId}`]
    const hit = list.find((d) => names.includes(d.name))
    if (hit) {
      discarded =
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
        authoritative: authoritativeRow(gateway, s.domain),
        now: now.toISO()!,
        discarded,
        rules: domainRegistry().rules(s.domain),
      }),
    })
  }
  await saveStates(gateway.id, loaded.rows, changes, {
    now,
    routerAuthor: { kind: 'perch', applyId: apply.applyKey },
  })
  if (result.hashes) {
    gateway.observedHashes = { ...(gateway.observedHashes ?? {}), ...result.hashes }
    await gateway.save()
  }
  if (open) {
    await recordGatewayEvent(gateway.id, result.outcome === 'failed' ? 'failed' : 'rolled_back', {
      applyId: Number(apply.id),
      detail: {
        applyId: apply.applyKey,
        reason: result.reason ?? null,
        discardedConfigs,
      },
    })
    await afterFailure(gateway, apply)
  }
  await refreshSyncState(gateway)
}

async function ackResults(gateway: Gateway, applyIds: string[]) {
  const settings = await getGatewayConfigSettings()
  const access = writeAccess(gateway, settings)
  if (!gatewaySession(gateway.collectorId)) return
  try {
    await gatewayRequest(
      gateway,
      'gateway.config.ack',
      { applyIds },
      { access: access.writable ? access : undefined }
    )
  } catch (error) {
    logger.debug(
      { gatewayId: gateway.id, error: (error as Error).message },
      'apply_lifecycle: ack not accepted'
    )
  }
}

/** A revert that failed or rolled back counts toward suspension (section 5.3). */
async function afterFailure(gateway: Gateway, apply: GatewayApply) {
  if (apply.kind !== 'revert' || gateway.enforcement === 'suspended') return
  const settings = await getGatewayConfigSettings()
  const now = DateTime.utc()
  const since = now.minus({ minutes: settings.enforcementWindowMinutes })
  const failures = await GatewayApply.query()
    .where('gateway_id', gateway.id)
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
    gateway.enforcement = 'suspended'
    gateway.enforcementChangedAt = now
    await gateway.save()
    await recordGatewayEvent(gateway.id, 'enforcement_suspended', {
      applyId: Number(apply.id),
      detail: { failures: failures.length, windowMinutes: settings.enforcementWindowMinutes },
    })
  }
}

export async function findApply(gatewayId: number, applyKey: string): Promise<GatewayApply> {
  const apply = await GatewayApply.query()
    .where('gateway_id', gatewayId)
    .where('apply_key', applyKey)
    .first()
  if (!apply) throw planeError(404, 'apply_not_found', `No apply ${applyKey}.`)
  return apply
}

// ── the tick ─────────────────────────────────────────────────────────────

/**
 * The 5 s poll task's work for the config plane: expire queued jobs, send
 * queued ones whose agent is back, assume the rollback of jobs whose
 * deadline passed without a result, give up on unanswered sends, and run
 * Authoritative Mode's enforcement. Never throws.
 */
export async function gatewayConfigTick(now: DateTime = DateTime.utc()): Promise<void> {
  const gateways = await Gateway.query().where('mode', 'managed')
  for (const gateway of gateways) {
    try {
      await gatewayQueue.run(gateway.id, async () => {
        await gateway.refresh()
        await tickGateway(gateway, now)
      })
    } catch (error) {
      logger.warn(
        { gatewayId: gateway.id, error: (error as Error).message },
        'apply_lifecycle: tick failed'
      )
    }
  }
}

async function tickGateway(gateway: Gateway, now: DateTime) {
  const settings = await getGatewayConfigSettings()
  for (const apply of await openApplies(gateway.id)) {
    if (apply.state === 'queued') {
      if (apply.queueExpiresAt && apply.queueExpiresAt < now) {
        transition(apply, 'expired')
        apply.finishedAt = now
        apply.outcome = { reason: 'queue_expired' }
        await apply.save()
        await recordGatewayEvent(gateway.id, 'expired', {
          applyId: Number(apply.id),
          detail: { applyId: apply.applyKey },
        })
        continue
      }
      if (writeAccess(gateway, settings).writable) await sendApply(gateway, apply)
      continue
    }
    if (apply.state === 'pending_confirm' && apply.deadlineAt) {
      if (apply.deadlineAt.plus({ seconds: DEADLINE_GRACE_SECONDS }) < now) {
        await assumeRolledBack(gateway, apply, now)
      } else if (apply.deadlineAt > now) {
        // A confirm that failed on the wire (timeout) is sent again.
        await tryConfirm(gateway, apply)
      }
      continue
    }
    if (
      apply.state === 'sending' &&
      apply.sentAt &&
      apply.sentAt.plus({ seconds: SENDING_TIMEOUT_SECONDS }) < now
    ) {
      await failApply(gateway, apply, 'no_answer', 'The agent never answered the apply.')
    }
  }
  await enforce(gateway, settings, now)
  await refreshSyncState(gateway)
}

/**
 * The router restored its snapshot: R is the content from before the job
 * again. Reads during the window may have replaced R with the committed
 * content (deferred, section 5.5); put the pre-job content back.
 */
function routerBeforeJob(apply: GatewayApply, s: SectionState): SectionState {
  const before = apply.replacedRouterContent
  if (!before || !(s.perchId in before)) return s
  return { ...s, router: before[s.perchId] ?? null }
}

async function assumeRolledBack(gateway: Gateway, apply: GatewayApply, now: DateTime) {
  apply.state = 'rolled_back'
  apply.finishedAt = now
  apply.outcome = { reason: 'confirm_timeout', assumed: true }
  await apply.save()
  await markRows(gateway, apply.perchIds, (s) => restoreStatus(gateway, routerBeforeJob(apply, s)))
  await recordGatewayEvent(gateway.id, 'rolled_back', {
    applyId: Number(apply.id),
    detail: { applyId: apply.applyKey, reason: 'confirm_timeout', assumed: true },
  })
  await afterFailure(gateway, apply)
}

/**
 * Authoritative Mode (section 5.3): drifted sections whose grace delay
 * elapsed are reverted in one `revert` job, unless enforcement is
 * suspended, a job is open, or the last revert finished less than one grace
 * delay ago (a failing revert is not hammered).
 */
async function enforce(gateway: Gateway, settings: GatewayConfigSettings, now: DateTime) {
  if (normalizeMode(gateway.mode) !== 'managed' || gateway.enforcement !== 'active') return
  // Without Authoritative Mode only one-way domains' sections are enforced
  // (README 2: Perch-owned config, router edits are drift).
  const registry = domainRegistry()
  const oneWay = registry.list().some((d) => d.oneWay)
  if (!authoritativeOf(gateway) && !oneWay) return
  if (!writeAccess(gateway, settings).writable) return
  if (await hasOpenApply(gateway.id)) return
  const loaded = await loadSections(gateway.id)
  const states = authoritativeOf(gateway)
    ? loaded.states
    : loaded.states.filter((s) => registry.get(s.domain)?.oneWay === true)
  const due = sectionsDueForRevert(states, {
    now: now.toISO()!,
    delaySeconds: settings.authoritativeRevertDelaySeconds,
    enforcement: 'active',
    authoritative: true,
  })
  if (due.length === 0) return
  const last = await GatewayApply.query()
    .where('gateway_id', gateway.id)
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
  await startRevert(gateway, due, { system: 'enforcement' })
}

/** Queues and sends a revert job for the given drifted sections. */
export async function startRevert(
  gateway: Gateway,
  perchIds: string[],
  actor: PlaneActor | null
): Promise<GatewayApply | null> {
  const settings = await getGatewayConfigSettings()
  const { states } = await loadSections(gateway.id)
  const { userId } = actorColumns(actor)
  const plan = planFor(gateway, states, { userId, kind: 'revert', perchIds })
  const job = plan.jobs.find((j) => j.kind === 'revert') ?? plan.jobs[0]
  if (!job) return null
  const apply = await createApply(gateway, settings, job, {
    userId,
    actor,
    perchIds,
    kind: 'revert',
    queued: false,
    chainStep: 0,
  })
  await recordGatewayEvent(gateway.id, 'apply_requested', {
    actor,
    applyId: Number(apply.id),
    detail: { applyId: apply.applyKey, kind: 'revert', perchIds: job.perchIds },
  })
  await sendApply(gateway, apply)
  await apply.refresh()
  return apply
}

// ── package installs (README 7.7) ─────────────────────────────────────────

/** `gateway.package.install` runs the package manager: a minute or more with `update`. */
export const PACKAGE_RPC_TIMEOUT_MS = 6 * 60_000

const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]{0,63}$/

/**
 * `POST /gateways/:id/packages` (README 7.7, "Install on gateway"): one
 * `package` job for the named packages, confirmed like an apply (fresh
 * session, and the admin in `admin_and_agent` mode); a rollback removes what
 * it installed. The agent checks its install allowlist and free flash. A
 * dry run returns the agent's plan (`install`, `needBytes`, `freeBytes`).
 */
export async function requestPackageInstall(
  gatewayId: number,
  request: { userId: number | null; packages: string[]; dryRun?: boolean; note?: string | null }
): Promise<GatewayApply | Record<string, unknown>> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.findOrFail(gatewayId)
    const settings = await getGatewayConfigSettings()
    if (normalizeMode(gateway.mode) !== 'managed') {
      throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
    }
    const packages = [...new Set(request.packages)]
    if (
      packages.length === 0 ||
      packages.length > 16 ||
      !packages.every((p) => PACKAGE_NAME.test(p))
    ) {
      throw planeError(422, 'invalid_packages', 'Name 1 to 16 packages.')
    }
    const allow = (gateway.capabilities as Record<string, unknown> | null)?.installAllowlist
    if (Array.isArray(allow)) {
      const refused = packages.filter((p) => !allow.includes(p))
      if (refused.length > 0) {
        throw planeError(409, 'package_not_allowed', 'Not on the router’s install allowlist.', {
          packages: refused,
        })
      }
    }
    if (!request.dryRun && (await hasOpenApply(gateway.id))) {
      throw planeError(409, 'apply_in_flight', 'Another job is not finished yet.')
    }
    const access = writeAccess(gateway, settings)
    if (!access.writable) {
      throw planeError(
        409,
        access.reason === 'offline' ? 'agent_offline' : blockCode(access.reason),
        writeBlockMessage(access.reason)
      )
    }
    if (request.dryRun) {
      return gatewayRequest<Record<string, unknown>>(
        gateway,
        'gateway.package.install',
        { applyId: newApplyKey(gateway.id), packages, dryRun: true },
        { timeoutMs: PACKAGE_RPC_TIMEOUT_MS, access }
      ).catch((error) => {
        throw agentFailure(error)
      })
    }
    const now = DateTime.utc()
    const apply = new GatewayApply()
    apply.gatewayId = gateway.id
    apply.applyKey = newApplyKey(gateway.id)
    apply.kind = 'package'
    apply.state = 'queued'
    apply.ops = []
    apply.baseHashes = {}
    apply.perchIds = []
    apply.packages = packages
    apply.protected = false
    apply.confirmMode = settings.confirmMode
    apply.confirmTimeoutSeconds = confirmTimeoutFor(settings, {
      protected: false,
      routerMaxSeconds: routerConfirmMax(gateway),
    })
    apply.requestedByUserId = request.userId
    apply.note = request.note ? request.note.slice(0, 500) : null
    apply.requestedAt = now
    apply.queueExpiresAt = now.plus({ hours: settings.queueExpiryHours })
    apply.chainStep = 0
    apply.retried = false
    apply.signed = false
    apply.configs = []
    apply.changes = []
    await apply.save()
    await recordGatewayEvent(gateway.id, 'apply_requested', {
      userId: request.userId,
      applyId: Number(apply.id),
      detail: { applyId: apply.applyKey, kind: 'package', packages },
    })
    await sendPackageJob(gateway, apply)
    await apply.refresh()
    return apply
  })
}

async function sendPackageJob(gateway: Gateway, apply: GatewayApply): Promise<void> {
  const settings = await getGatewayConfigSettings()
  const access = writeAccess(gateway, settings)
  if (!access.writable) return
  transition(apply, 'send')
  apply.sentAt = DateTime.utc()
  apply.signed = access.signed
  await apply.save()
  await refreshSyncState(gateway)
  let result: Record<string, unknown> | null
  try {
    result = await gatewayRequest<Record<string, unknown>>(
      gateway,
      'gateway.package.install',
      {
        applyId: apply.applyKey,
        packages: apply.packages ?? [],
        confirmTimeoutSeconds: apply.confirmTimeoutSeconds,
      },
      { timeoutMs: PACKAGE_RPC_TIMEOUT_MS, access }
    )
  } catch (error) {
    await onSendError(gateway, apply, error)
    return
  }
  if (result && typeof result === 'object') {
    apply.outcome = {
      ...(apply.outcome ?? {}),
      ...(Array.isArray(result.install) ? { install: result.install } : {}),
      ...(Array.isArray(result.alreadyInstalled)
        ? { alreadyInstalled: result.alreadyInstalled }
        : {}),
      ...(typeof result.manager === 'string' ? { manager: result.manager } : {}),
    }
  }
  await onApplyReply(gateway, apply, result ?? {})
}
