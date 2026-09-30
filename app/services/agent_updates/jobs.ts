import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import AgentUpdateJob, { type JobState, OPEN_JOB_STATES } from '#models/agent_update_job'
import { AgentOfflineError, AgentRpcError, AgentTimeoutError } from '#services/agent_hub'
import { applyPending } from '#services/agent_updates/busy'
import { loadDevice, reportOf, type DeviceHandle } from '#services/agent_updates/devices'
import { artefactPath, downloadKey, wireDeviceKey } from '#services/agent_updates/download_tokens'
import { recordUpdateEvent, type EventDevice } from '#services/agent_updates/events'
import { fetchArtefact, isFetching } from '#services/agent_updates/github'
import { notOfferableReason, releaseManifest } from '#services/agent_updates/releases'
import {
  sanitizePreflight,
  type AgentPreflight,
  type UpdateMethod,
  type UpdateReport,
  type UpdateResult,
} from '#services/agent_updates/report'
import { hubFor, liveSession } from '#services/agent_updates/sessions'
import type { AgentUpdateSettings } from '#services/agent_updates/settings'
import {
  IN_FLIGHT_STATES,
  deviceKey,
  markDeviceInFlight,
  type DeviceKind,
} from '#services/agent_updates/state'
import { storedFileSize } from '#services/agent_updates/store'
import { deviceTarget, selectArtefacts } from '#services/agent_updates/targets'
import { isWindowOpen, windowNotBefore } from '#services/agent_updates/window'
import { instanceTimezone } from '#services/usage_history'
import logger from '@adonisjs/core/services/logger'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * The job lifecycle (agent-updates controller.md section 5) over the agent
 * sockets (protocol.md section 4):
 *
 *   queued ─stage→ staging ─result staged→ staged ─install→ installing
 *     ─candidate connects→ probation ─30 s + 2 pushes, confirm→ confirmed
 *
 * and every way off that path: `failed` (nothing changed on the device),
 * `rolled_back`, `rollback_failed`, `rollback_unavailable` (the device's
 * watchdog or boot guard), `unknown` (silent past its deadline), `cancelled`,
 * `expired`. The device decides; the controller records, and never sends an
 * install while an apply waits for its confirm. RPC failures (offline,
 * timeout) leave a job where it is for the next tick.
 */

export class JobError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'JobError'
  }
}

/** Seconds the watchdog takes to stop and swap before the check window (protocol.md 4.3). */
const SWAP_SECONDS = 60
const STAGE_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 15_000
const SHORT_TIMEOUT_MS = 10_000
/** Re-stages after an expired download link, per job (protocol.md section 2). */
const MAX_RESTAGES = 3

export function newUpdateKey(): string {
  return `u-${randomBytes(8).toString('hex')}`
}

function deviceOf(job: AgentUpdateJob): { kind: DeviceKind; id: number } | null {
  if (job.apId !== null) return { kind: 'ap', id: job.apId }
  if (job.collectorId !== null) return { kind: 'collector', id: job.collectorId }
  return null
}

function eventDevice(job: AgentUpdateJob): EventDevice | null {
  const device = deviceOf(job)
  return device ? { ...device, name: job.deviceName } : null
}

function errorCode(error: AgentRpcError): string {
  const data = error.data as { error?: unknown } | undefined
  return typeof data?.error === 'string' ? data.error.slice(0, 48) : 'agent_error'
}

export async function openJobFor(kind: DeviceKind, id: number): Promise<AgentUpdateJob | null> {
  return AgentUpdateJob.query().where('active_key', deviceKey(kind, id)).first()
}

/**
 * Moves a job to `state` and saves it: final states clear `active_key` and
 * set `finished_at`; the in-flight set follows. Records the README section 16
 * event of the transition.
 */
export async function transition(
  job: AgentUpdateJob,
  state: JobState,
  patch: Partial<Pick<AgentUpdateJob, 'reason' | 'detail'>> & {
    note?: Record<string, unknown>
    userId?: number | null
    systemActor?: string
  } = {}
): Promise<AgentUpdateJob> {
  const from = job.state
  const now = DateTime.utc()
  job.state = state
  if (patch.reason !== undefined) job.reason = patch.reason
  if (patch.detail !== undefined) job.detail = patch.detail?.slice(0, 1000) ?? null
  job.updatedAt = now
  const open = OPEN_JOB_STATES.includes(state)
  if (!open) {
    job.activeKey = null
    job.finishedAt = job.finishedAt ?? now
    if (state === 'confirmed') job.confirmedAt = job.confirmedAt ?? now
  }
  await job.save()

  const device = deviceOf(job)
  if (device) {
    markDeviceInFlight(
      device.kind,
      device.id,
      (IN_FLIGHT_STATES as readonly string[]).includes(state)
    )
  }
  if (from === state) return job

  const common = {
    device: eventDevice(job),
    jobId: job.id,
    rolloutId: job.rolloutId,
    releaseId: job.releaseId,
    userId: patch.userId ?? null,
    systemActor: patch.systemActor ?? 'agent',
  }
  const base = { jobId: job.id, updateId: job.updateKey, toVersion: job.toVersion }
  switch (state) {
    case 'staging':
      if (from === 'queued') {
        await recordUpdateEvent('agent_update.started', {
          ...common,
          systemActor: 'tick',
          detail: {
            ...base,
            fromVersion: job.fromVersion,
            method: job.method,
            source: job.source,
            rolloutId: job.rolloutId,
          },
        })
      }
      break
    case 'confirmed':
      await recordUpdateEvent('agent_update.confirmed', {
        ...common,
        detail: {
          ...base,
          fromVersion: job.fromVersion,
          seconds: job.installSentAt
            ? Math.round(now.diff(job.installSentAt, 'seconds').seconds)
            : null,
          ...patch.note,
        },
      })
      break
    case 'failed':
    case 'rolled_back':
    case 'rollback_failed':
    case 'rollback_unavailable':
    case 'unknown':
      await recordUpdateEvent(`agent_update.${state}`, {
        ...common,
        detail: {
          ...base,
          fromVersion: job.fromVersion,
          reason: job.reason,
          detail: job.detail,
          ...(state === 'unknown' ? { deadline: job.deadlineAt?.toISO() ?? null } : {}),
          ...patch.note,
        },
      })
      break
    case 'expired':
      await recordUpdateEvent('job_aborted', {
        ...common,
        systemActor: 'tick',
        detail: { ...base, reason: 'expired' },
      })
      break
    default:
      break
  }
  return job
}

// ── creating jobs ───────────────────────────────────────────────────────

export type SupportCheck =
  | { supported: true; report: UpdateReport }
  | { supported: false; reason: string; report: UpdateReport | null }

/** Why a device cannot update itself (the fleet's `selfUpdate.reason`), if it cannot. */
export function selfUpdateSupport(device: DeviceHandle): SupportCheck {
  const report = reportOf(device)
  if (device.kind === 'collector' && device.transport === 'poll') {
    return { supported: false, reason: 'poll_transport', report }
  }
  if (!report) {
    const capable = (device.capabilities ?? []).includes('agent_update')
    return { supported: false, reason: capable ? 'never_reported' : 'agent_too_old', report }
  }
  if (!report.enabled) return { supported: false, reason: 'self_update_off', report }
  if (report.refusal) return { supported: false, reason: report.refusal, report }
  if (report.methods.length === 0) {
    return { supported: false, reason: 'install_kind_unsupported', report }
  }
  return { supported: true, report }
}

export type PlannedUpdate = {
  release: AgentRelease
  method: UpdateMethod
  artefacts: AgentArtefact[]
  downloadBytes: number
}

/**
 * Checks that `version` can be offered to `device` and picks the method and
 * artefacts. Throws `JobError` with the REST error of controller.md 9.2.
 */
export async function planUpdate(
  device: DeviceHandle,
  report: UpdateReport,
  version: string,
  requested?: UpdateMethod | null
): Promise<PlannedUpdate> {
  const release = await AgentRelease.query()
    .where('product', device.product)
    .where('version', version)
    .first()
  if (!release) {
    throw new JobError(422, 'release_not_found', `${device.product} ${version} is not known.`)
  }
  const reason = notOfferableReason(release)
  if (reason) {
    throw new JobError(409, 'release_not_offerable', `This release cannot be offered.`, { reason })
  }
  const artefacts = await AgentArtefact.query().where('release_id', release.id).orderBy('id')
  const target = deviceTarget(device.product, report, device.arch)
  const selection = selectArtefacts(artefacts, releaseManifest(release), target, requested)
  if (!selection.ok) {
    if (selection.error === 'method_unsupported') {
      throw new JobError(
        409,
        'method_unsupported',
        `This device cannot update by ${selection.method}.`,
        { method: selection.method, methods: target.methods }
      )
    }
    throw new JobError(422, 'no_matching_artefact', 'The release has nothing for this device.', {
      method: selection.method,
      arch: target.arch,
      pkgArch: target.pkgArch,
      manager: target.packageManager,
      series: target.series,
    })
  }
  return {
    release,
    method: selection.method,
    artefacts: selection.artefacts,
    downloadBytes: selection.downloadBytes,
  }
}

export type CreateJobInput = {
  device: DeviceHandle
  source: 'release' | 'previous'
  release: AgentRelease | null
  toVersion: string
  method: UpdateMethod
  when: 'now' | 'window'
  acceptUnrecoverable: boolean
  userId: number | null
  systemActor?: string | null
  rolloutId?: number | null
}

export async function createJob(
  input: CreateJobInput,
  settings: AgentUpdateSettings
): Promise<AgentUpdateJob> {
  const existing = await openJobFor(input.device.kind, input.device.id)
  if (existing) {
    throw new JobError(409, 'update_in_progress', 'This device already has an open update.', {
      jobId: existing.id,
    })
  }
  const now = DateTime.utc()
  const respectWindow = input.when === 'window'
  const job = new AgentUpdateJob()
  job.updateKey = newUpdateKey()
  job.apId = input.device.kind === 'ap' ? input.device.id : null
  job.collectorId = input.device.kind === 'collector' ? input.device.id : null
  job.activeKey = input.device.key
  job.deviceName = input.device.name.slice(0, 120)
  job.product = input.device.product
  job.rolloutId = input.rolloutId ?? null
  job.releaseId = input.release?.id ?? null
  job.source = input.source
  job.fromVersion = (input.device.version ?? 'unknown').slice(0, 64)
  job.toVersion = input.toVersion
  job.method = input.method
  job.rollbackStore = null
  job.state = 'queued'
  job.reason = null
  job.detail = null
  job.preflight = null
  job.progressBytes = null
  job.progressTotal = null
  job.acceptUnrecoverable = input.acceptUnrecoverable
  job.respectWindow = respectWindow
  job.restageCount = 0
  job.requestedByUserId = input.userId
  job.systemActor = input.userId ? null : (input.systemActor ?? null)
  job.createdAt = now
  job.notBefore = respectWindow ? windowNotBefore(settings, await instanceTimezone(), now) : now
  job.updatedAt = now
  job.pushesSeen = 0
  try {
    await job.save()
  } catch (error) {
    const raced = await openJobFor(input.device.kind, input.device.id)
    if (raced) {
      throw new JobError(409, 'update_in_progress', 'This device already has an open update.', {
        jobId: raced.id,
      })
    }
    throw error
  }
  await recordUpdateEvent('job_created', {
    device: { kind: input.device.kind, id: input.device.id, name: job.deviceName },
    jobId: job.id,
    rolloutId: job.rolloutId,
    releaseId: job.releaseId,
    userId: input.userId,
    systemActor: input.systemActor ?? null,
    detail: {
      updateId: job.updateKey,
      source: job.source,
      fromVersion: job.fromVersion,
      toVersion: job.toVersion,
      method: job.method,
      when: input.when,
      acceptUnrecoverable: job.acceptUnrecoverable,
    },
  })
  return job
}

// ── the stage / install / confirm / abort calls ──────────────────────────

function policy(device: DeviceHandle, settings: AgentUpdateSettings, acceptUnrecoverable: boolean) {
  return {
    probationSeconds: settings.probationSeconds,
    crashLoopRestarts: settings.crashLoopRestarts,
    downloadTimeoutSeconds: settings.downloadTimeoutSeconds,
    downloadRateKbps: settings.downloadRateKbps,
    flashReserveBytes: settings.flashReserveKiB * 1024,
    ramReserveBytes: settings.ramReserveMiB * 1024 * 1024,
    keepPreviousMinFreeBytes: settings.keepPreviousMinFreeKiB * 1024,
    // A broken gateway may not reach the controller again: its copy stays local.
    rollbackStore:
      device.kind === 'collector' || !settings.allowRamRollbackOnAps ? 'flash' : 'auto',
    acceptUnrecoverable,
  }
}

/** A stored artefact whose SHA-256 is the running binary's: the RAM store's re-fetch source. */
async function refetchSource(
  device: DeviceHandle,
  report: UpdateReport,
  settings: AgentUpdateSettings
): Promise<{ path: string; sha256: string } | null> {
  if (device.kind !== 'ap' || !report.binarySha256) return null
  const artefact = await AgentArtefact.query()
    .where('sha256', report.binarySha256)
    .where('kind', 'binary')
    .whereNotNull('stored_path')
    .first()
  if (!artefact) return null
  const exp =
    Math.floor(Date.now() / 1000) +
    settings.downloadTimeoutSeconds +
    SWAP_SECONDS +
    settings.probationSeconds +
    24 * 3600
  return {
    path: artefactPath(await downloadKey(), {
      artefactId: artefact.id,
      file: artefact.fileName,
      deviceKey: wireDeviceKey(device.kind, device.id),
      exp,
    }),
    sha256: report.binarySha256,
  }
}

/** `agent.update.stage` params (protocol.md 4.2). */
export async function stageParams(
  device: DeviceHandle,
  report: UpdateReport,
  input: {
    updateId: string
    dryRun: boolean
    source: 'release' | 'previous'
    method: UpdateMethod
    release: AgentRelease | null
    artefacts: AgentArtefact[]
    acceptUnrecoverable: boolean
  },
  settings: AgentUpdateSettings
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {
    updateId: input.updateId,
    dryRun: input.dryRun,
    source: input.source,
    method: input.method,
    policy: policy(device, settings, input.acceptUnrecoverable),
  }
  if (input.source === 'release' && input.release) {
    const key = await downloadKey()
    const exp = Math.floor(Date.now() / 1000) + settings.downloadTimeoutSeconds + 3600
    params.manifest = Buffer.from(input.release.manifest, 'utf8').toString('base64')
    params.signature = input.release.signature
    params.artefacts = input.artefacts.map((artefact) => ({
      file: artefact.fileName,
      path: artefactPath(key, {
        artefactId: artefact.id,
        file: artefact.fileName,
        deviceKey: wireDeviceKey(device.kind, device.id),
        exp,
      }),
    }))
  }
  const refetch = await refetchSource(device, report, settings)
  if (refetch) params.refetch = refetch
  return params
}

type StageAnswer = { updateId?: unknown; state?: unknown; preflight?: unknown }

/** A dry-run stage: the preflight without downloading anything (endpoint 11). */
export async function dryRun(
  device: DeviceHandle,
  report: UpdateReport,
  input: {
    source: 'release' | 'previous'
    method: UpdateMethod
    release: AgentRelease | null
    artefacts: AgentArtefact[]
    acceptUnrecoverable?: boolean
  },
  settings: AgentUpdateSettings
): Promise<AgentPreflight> {
  const params = await stageParams(
    device,
    report,
    {
      updateId: newUpdateKey(),
      dryRun: true,
      acceptUnrecoverable: input.acceptUnrecoverable ?? false,
      ...input,
    },
    settings
  )
  let answer: StageAnswer
  try {
    answer = await hubFor(device.kind).request<StageAnswer>(
      device.id,
      'agent.update.stage',
      params,
      {
        timeoutMs: STAGE_TIMEOUT_MS,
      }
    )
  } catch (error) {
    throw rpcToJobError(error)
  }
  const preflight = sanitizePreflight(answer?.preflight)
  if (!preflight) throw new JobError(502, 'agent_bad_answer', 'The agent answered no preflight.')
  return preflight
}

/** Maps a hub failure to the REST error of controller.md 9.2. */
export function rpcToJobError(error: unknown): JobError {
  if (error instanceof AgentOfflineError) {
    return new JobError(409, 'agent_offline', 'The device is not connected.')
  }
  if (error instanceof AgentTimeoutError) {
    return new JobError(
      504,
      'agent_timeout',
      `The device did not answer within ${error.timeoutMs} ms.`
    )
  }
  if (error instanceof AgentRpcError) {
    return new JobError(409, 'agent_refused', error.message, {
      code: errorCode(error),
      detail: error.data ?? null,
    })
  }
  return new JobError(500, 'agent_error', error instanceof Error ? error.message : String(error))
}

/**
 * Makes sure the job's artefacts are stored. False while a GitHub fetch runs
 * (started here); throws when an artefact can never be stored.
 */
async function artefactsReady(artefacts: AgentArtefact[]): Promise<boolean> {
  let ready = true
  for (const artefact of artefacts) {
    const size = await storedFileSize(artefact)
    if (size === artefact.sizeBytes) continue
    ready = false
    if (!artefact.sourceUrl) {
      throw new JobError(409, 'artefact_not_stored', `${artefact.fileName} was never uploaded.`)
    }
    if (!isFetching(artefact.id)) {
      fetchArtefact(artefact).catch((error) =>
        logger.warn({ artefactId: artefact.id, err: error }, 'agent_updates: artefact fetch failed')
      )
    }
  }
  return ready
}

const fetchFailures = new Map<number, number>()

/** A queued job whose time has come: stage it (tick). */
export async function startQueuedJob(job: AgentUpdateJob, settings: AgentUpdateSettings) {
  const target = deviceOf(job)
  if (!target) return transition(job, 'failed', { reason: 'device_gone', detail: null })
  const device = await loadDevice(target.kind, target.id)
  if (!device) return transition(job, 'failed', { reason: 'device_gone', detail: null })
  if (!device.online) return job
  if (job.respectWindow && !isWindowOpen(settings, await instanceTimezone())) return job
  const report = reportOf(device)
  if (!report) return job

  const busy = await applyPending(device.kind, device.id)
  if (busy) {
    if (job.detail !== `waiting: ${busy} apply pending`) {
      job.detail = `waiting: ${busy} apply pending`
      job.updatedAt = DateTime.utc()
      await job.save()
    }
    return job
  }

  let release: AgentRelease | null = null
  let artefacts: AgentArtefact[] = []
  if (job.source === 'release') {
    release = job.releaseId ? await AgentRelease.find(job.releaseId) : null
    if (!release) return transition(job, 'failed', { reason: 'release_gone', detail: null })
    try {
      const plan = await planUpdate(device, report, job.toVersion, job.method)
      artefacts = plan.artefacts
      if (!(await artefactsReady(artefacts))) {
        // A failed GitHub fetch: give up after a few ticks rather than retry for a day.
        const failures = fetchFailures.get(job.id) ?? 0
        if (failures > 60) {
          fetchFailures.delete(job.id)
          return transition(job, 'failed', {
            reason: 'artefact_unavailable',
            detail: 'The controller could not fetch the release files.',
          })
        }
        fetchFailures.set(job.id, failures + 1)
        if (fetchFailures.size > 1000) fetchFailures.clear()
        return job
      }
      fetchFailures.delete(job.id)
    } catch (error) {
      if (error instanceof JobError) {
        return transition(job, 'failed', { reason: error.code, detail: error.message })
      }
      throw error
    }
  }

  const params = await stageParams(
    device,
    report,
    {
      updateId: job.updateKey,
      dryRun: false,
      source: job.source,
      method: job.method,
      release,
      artefacts,
      acceptUnrecoverable: job.acceptUnrecoverable,
    },
    settings
  )
  let answer: StageAnswer
  try {
    answer = await hubFor(device.kind).request<StageAnswer>(
      device.id,
      'agent.update.stage',
      params,
      {
        timeoutMs: STAGE_TIMEOUT_MS,
      }
    )
  } catch (error) {
    if (error instanceof AgentRpcError) {
      const code = errorCode(error)
      if (code === 'busy' || code === 'busy_pending_apply') {
        job.detail = `waiting: device busy (${code})`
        job.updatedAt = DateTime.utc()
        await job.save()
        return job
      }
      return transition(job, 'failed', { reason: code, detail: error.message })
    }
    return job
  }
  const preflight = sanitizePreflight(answer?.preflight)
  job.preflight = preflight
  job.rollbackStore = preflight?.rollbackStore ?? null
  job.detail = null
  if (answer?.state === 'staged') {
    job.stagedAt = DateTime.utc()
    await transition(job, 'staging')
    return transition(job, 'staged')
  }
  return transition(job, 'staging')
}

/** A staged job: send the install (tick). */
export async function installStagedJob(job: AgentUpdateJob, settings: AgentUpdateSettings) {
  const target = deviceOf(job)
  if (!target) return transition(job, 'failed', { reason: 'device_gone', detail: null })
  const hub = hubFor(target.kind)
  if (!hub.isOnline(target.id)) return job
  const busy = await applyPending(target.kind, target.id)
  if (busy) {
    job.detail = `waiting: ${busy} apply pending`
    job.updatedAt = DateTime.utc()
    await job.save()
    return job
  }
  const sentAt = DateTime.utc()
  const deadline = sentAt.plus({ seconds: SWAP_SECONDS + settings.probationSeconds })
  try {
    const answer = await hub.request<{ state?: unknown; rollbackStore?: unknown }>(
      target.id,
      'agent.update.install',
      { updateId: job.updateKey },
      { timeoutMs: INSTALL_TIMEOUT_MS }
    )
    job.installSentAt = sentAt
    job.deadlineAt = deadline
    if (answer?.rollbackStore === 'flash' || answer?.rollbackStore === 'ram') {
      job.rollbackStore = answer.rollbackStore
    }
    job.detail = null
    return transition(job, 'installing')
  } catch (error) {
    if (error instanceof AgentRpcError) {
      const code = errorCode(error)
      if (code === 'busy' || code === 'busy_pending_apply') {
        job.detail = `waiting: device busy (${code})`
        job.updatedAt = DateTime.utc()
        await job.save()
        return job
      }
      if (code === 'not_staged' && job.restageCount < MAX_RESTAGES) {
        job.restageCount += 1
        job.stagedAt = null
        job.detail = 'the staged files were gone; staging again'
        return transition(job, 'queued')
      }
      return transition(job, 'failed', { reason: code, detail: error.message })
    }
    // The session closed right after the send (the watchdog stops the old
    // process within ~2 s) or the answer was late: the install may be running.
    job.installSentAt = sentAt
    job.deadlineAt = deadline
    job.detail = 'install sent; the device did not answer before its session closed'
    return transition(job, 'installing')
  }
}

const confirming = new Set<number>()

/**
 * The health check (controller.md 4.2): the job's candidate session (opened
 * after the install was sent, running the target version, reporting this
 * update in `probation`) has been up `stableSeconds` with `minPushes`
 * accepted pushes → `agent.update.confirm`.
 */
export async function checkConfirm(
  kind: DeviceKind,
  id: number,
  settings: AgentUpdateSettings,
  now: DateTime = DateTime.utc()
): Promise<void> {
  const job = await openJobFor(kind, id)
  if (!job || !['installing', 'probation', 'unknown'].includes(job.state)) return
  if (!job.installSentAt) return
  const live = liveSession(kind, id)
  if (!live) return
  const connectedAt = live.session.info.connectedAt
  // Whole seconds: `install_sent_at` comes back from the database truncated,
  // and a real candidate connects seconds after the install (stop, swap, start).
  if (Math.floor(connectedAt.toSeconds()) <= Math.floor(job.installSentAt.toSeconds())) return
  if (live.state.version !== job.toVersion) return
  const active = live.state.report?.active
  if (!active || active.updateId !== job.updateKey || active.phase !== 'probation') return

  const sessionSecond = Math.floor(connectedAt.toMillis() / 1000)
  const knownSecond = job.candidateConnectedAt
    ? Math.floor(job.candidateConnectedAt.toMillis() / 1000)
    : null
  let changed = false
  if (knownSecond !== sessionSecond) {
    job.candidateConnectedAt = connectedAt
    job.reconnectedAt = now
    changed = true
  }
  if (job.pushesSeen !== live.state.pushes) {
    job.pushesSeen = Math.min(live.state.pushes, 65535)
    changed = true
  }
  if (job.state !== 'probation') {
    job.detail = null
    await transition(job, 'probation')
  } else if (changed) {
    job.updatedAt = now
    await job.save()
  }

  const stableFor = now.diff(connectedAt, 'seconds').seconds
  if (live.state.pushes < settings.minPushes || stableFor < settings.stableSeconds) return
  if (confirming.has(job.id)) return
  confirming.add(job.id)
  try {
    const answer = await hubFor(kind).request<{ state?: unknown; floor?: unknown }>(
      id,
      'agent.update.confirm',
      { updateId: job.updateKey },
      { timeoutMs: SHORT_TIMEOUT_MS }
    )
    const fresh = await AgentUpdateJob.find(job.id)
    if (!fresh || !fresh.isOpen) return
    fresh.detail = null
    await transition(fresh, 'confirmed', {
      note: { floor: typeof answer?.floor === 'string' ? answer.floor : null },
    })
  } catch (error) {
    if (error instanceof AgentRpcError) {
      logger.warn(
        { kind, id, jobId: job.id, code: errorCode(error) },
        'agent_updates: confirm refused'
      )
      job.detail = `confirm refused: ${errorCode(error)}`
      job.updatedAt = DateTime.utc()
      await job.save()
    }
  } finally {
    confirming.delete(job.id)
  }
}

/** Admin abort (endpoint 14, and 13 for a job in its check window). */
export async function abortJob(
  job: AgentUpdateJob,
  userId: number | null
): Promise<AgentUpdateJob> {
  if (!job.isOpen) throw new JobError(409, 'job_final', 'This update has already finished.')
  if (job.state === 'queued') {
    await recordUpdateEvent('job_aborted', {
      device: eventDevice(job),
      jobId: job.id,
      releaseId: job.releaseId,
      rolloutId: job.rolloutId,
      userId,
      detail: { updateId: job.updateKey, state: job.state },
    })
    return transition(job, 'cancelled', { reason: 'admin', detail: null, userId })
  }
  const target = deviceOf(job)
  if (!target) return transition(job, 'cancelled', { reason: 'admin', detail: null, userId })
  let answer: { state?: unknown }
  try {
    answer = await hubFor(target.kind).request(
      target.id,
      'agent.update.abort',
      { updateId: job.updateKey, reason: 'admin' },
      { timeoutMs: SHORT_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof AgentRpcError && errorCode(error) === 'unknown_update') {
      // The device has nothing for it: nothing was staged or it already finished.
      if (['staging', 'staged'].includes(job.state)) {
        return transition(job, 'cancelled', { reason: 'admin', detail: null, userId })
      }
    }
    throw rpcToJobError(error)
  }
  await recordUpdateEvent('job_aborted', {
    device: eventDevice(job),
    jobId: job.id,
    releaseId: job.releaseId,
    rolloutId: job.rolloutId,
    userId,
    detail: { updateId: job.updateKey, state: job.state, answer: answer?.state ?? null },
  })
  if (answer?.state === 'cancelled') {
    return transition(job, 'cancelled', { reason: 'admin', detail: null, userId })
  }
  job.detail = 'rolling back on the admin’s request'
  job.updatedAt = DateTime.utc()
  await job.save()
  return job
}

// ── what the device reports ──────────────────────────────────────────────

const RESULT_STATE: Record<string, JobState> = {
  failed: 'failed',
  cancelled: 'cancelled',
  confirmed: 'confirmed',
  rolled_back: 'rolled_back',
  rollback_failed: 'rollback_failed',
  rollback_unavailable: 'rollback_unavailable',
}

/**
 * One `results` entry or `agent.update.result` notification: settles the
 * job of that id on this device. Unknown ids and final jobs are ignored (the
 * caller acks them all the same).
 */
export async function settleResult(
  kind: DeviceKind,
  id: number,
  result: UpdateResult
): Promise<AgentUpdateJob | null> {
  const job = await AgentUpdateJob.query()
    .where('update_key', result.updateId)
    .where(kind === 'ap' ? 'ap_id' : 'collector_id', id)
    .first()
  if (!job || !job.isOpen) return job
  const now = DateTime.utc()
  if (result.outcome === 'staged') {
    if (job.state === 'queued' || job.state === 'staging') {
      job.stagedAt = now
      job.detail = null
      if (job.state === 'queued') await transition(job, 'staging')
      return transition(job, 'staged')
    }
    return job
  }
  if (result.outcome === 'failed' && result.reason === 'url_expired') {
    if (job.restageCount < MAX_RESTAGES) {
      job.restageCount += 1
      job.detail = 'the download link expired; staging again'
      return transition(job, 'queued')
    }
  }
  const state = RESULT_STATE[result.outcome]
  if (!state) return job
  return transition(job, state, {
    reason: result.reason,
    detail: result.detail,
  })
}

/**
 * The open job against a fresh status block (controller.md 5.3), after its
 * results were settled. `sessionVersion` is what the reporting process runs.
 */
export async function resyncFromReport(
  kind: DeviceKind,
  id: number,
  report: UpdateReport | null,
  sessionVersion: string | null,
  settings: AgentUpdateSettings
): Promise<void> {
  const job = await openJobFor(kind, id)
  if (!job || job.state === 'queued' || !report) return
  const active = report.active && report.active.updateId === job.updateKey ? report.active : null

  if (job.state === 'staging' || job.state === 'staged') {
    if (!active) {
      await transition(job, 'failed', {
        reason: 'lost_on_device',
        detail: 'The device no longer has this update.',
      })
      return
    }
    if (active.bytes !== null) job.progressBytes = active.bytes
    if (active.totalBytes !== null) job.progressTotal = active.totalBytes
    if (active.phase === 'staged' && job.state === 'staging') {
      job.stagedAt = DateTime.utc()
      await transition(job, 'staged')
      return
    }
    job.updatedAt = DateTime.utc()
    await job.save()
    return
  }

  // installing / probation / unknown
  if (active) {
    if (active.phase === 'staged' && job.state === 'installing') {
      job.detail = 'the install did not start; sending it again'
      await transition(job, 'staged')
      return
    }
    if (active.phase === 'refetching') {
      job.detail = 're-fetching the previous version'
      job.updatedAt = DateTime.utc()
      await job.save()
      return
    }
    if (active.phase === 'probation') await checkConfirm(kind, id, settings)
    return
  }
  if (sessionVersion !== null && sessionVersion === job.toVersion && !report.active) {
    job.detail = 'the device runs the new version; the confirm answer was lost'
    await transition(job, 'confirmed')
  }
}

// ── tick parts ───────────────────────────────────────────────────────────

/** installing / probation past their deadline + grace → unknown. */
export async function markOverdue(settings: AgentUpdateSettings, now = DateTime.utc()) {
  const jobs = await AgentUpdateJob.query()
    .whereIn('state', ['installing', 'probation'])
    .whereNotNull('deadline_at')
  for (const job of jobs) {
    if (job.deadlineAt!.plus({ seconds: settings.confirmGraceSeconds }) < now) {
      await transition(job, 'unknown', {
        reason: null,
        detail: 'The device has not reported since its deadline.',
        systemActor: 'tick',
      })
    }
  }
}

/** Queued longer than `queueExpiryHours` → expired. */
export async function expireQueued(settings: AgentUpdateSettings, now = DateTime.utc()) {
  const cutoff = now.minus({ hours: settings.queueExpiryHours })
  const jobs = await AgentUpdateJob.query().where('state', 'queued')
  for (const job of jobs) {
    if (job.createdAt < cutoff) await transition(job, 'expired', { reason: 'expired' })
  }
}

// ── views ───────────────────────────────────────────────────────────────

export type AgentUpdateJobSummary = {
  id: number
  updateId: string
  state: JobState
  fromVersion: string
  toVersion: string
  method: UpdateMethod
  source: 'release' | 'previous'
  rollbackStore: 'flash' | 'ram' | null
  reason: string | null
  detail: string | null
  progress: { bytes: number; totalBytes: number } | null
  deadline: string | null
  createdAt: string
  finishedAt: string | null
}

export function jobSummary(job: AgentUpdateJob): AgentUpdateJobSummary {
  return {
    id: job.id,
    updateId: job.updateKey,
    state: job.state,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    method: job.method,
    source: job.source,
    rollbackStore: job.rollbackStore,
    reason: job.reason,
    detail: job.detail,
    progress:
      job.progressTotal !== null
        ? { bytes: job.progressBytes ?? 0, totalBytes: job.progressTotal }
        : null,
    deadline:
      job.state === 'installing' || job.state === 'probation'
        ? (job.deadlineAt?.toISO() ?? null)
        : null,
    createdAt: job.createdAt.toISO()!,
    finishedAt: job.finishedAt?.toISO() ?? null,
  }
}

export function jobDevice(job: AgentUpdateJob) {
  const device = deviceOf(job)
  return device
    ? {
        key: deviceKey(device.kind, device.id),
        kind: device.kind,
        id: device.id,
        name: job.deviceName,
      }
    : null
}
