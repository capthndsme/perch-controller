import AgentUpdateEvent from '#models/agent_update_event'
import AgentUpdateJob, { FINAL_JOB_STATES, OPEN_JOB_STATES } from '#models/agent_update_job'
import User from '#models/user'
import { AgentOfflineError } from '#services/agent_hub'
import { recordUpdateReport } from '#services/agent_updates/bridge'
import { ensureDeviceRow, loadDevice, type DeviceHandle } from '#services/agent_updates/devices'
import { recordUpdateEvent } from '#services/agent_updates/events'
import { buildFleet, deviceView, fleetContext, jobsByDevice } from '#services/agent_updates/fleet'
import {
  JobError,
  abortJob,
  createJob,
  dryRun,
  jobDevice,
  jobSummary,
  openJobFor,
  planUpdate,
  rpcToJobError,
  selfUpdateSupport,
} from '#services/agent_updates/jobs'
import { parseExtraKey } from '#services/agent_updates/keys'
import { hubFor, sessionState } from '#services/agent_updates/sessions'
import {
  agentUpdateSettingsView,
  getAgentUpdateSettings,
  updateAgentUpdateSettings,
} from '#services/agent_updates/settings'
import { parseDeviceKey, type DeviceKind } from '#services/agent_updates/state'
import { isValidVersion } from '#services/agent_updates/versions'
import {
  agentUpdateSettingsValidator,
  deviceSettingsValidator,
  eventsQueryValidator,
  fleetQueryValidator,
  jobsQueryValidator,
  preflightValidator,
  rollbackDeviceValidator,
  updateDeviceValidator,
} from '#validators/agent_updates'
import env from '#start/env'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

/**
 * Agent updates: the fleet, devices, jobs, the audit trail and the settings
 * (docs/design/agent-updates/controller.md section 9.2, endpoints 1-4, 9-14
 * and 22). Reads for any signed-in user; every write is admin-only and
 * recorded with its user.
 */
export default class AgentUpdatesController {
  /** GET /api/v1/agent-updates/fleet */
  async fleet({ request, serialize }: HttpContext) {
    const query = await fleetQueryValidator.validate(request.qs())
    const settings = await getAgentUpdateSettings()
    return serialize(
      await buildFleet(settings, { product: query.product, controllerUrl: controllerUrl(request) })
    )
  }

  /** GET /api/v1/agent-updates/jobs */
  async jobs({ request, serialize }: HttpContext) {
    const query = await jobsQueryValidator.validate(request.qs())
    const limit = query.limit ?? 50
    const builder = AgentUpdateJob.query()
      .orderBy('id', 'desc')
      .limit(limit + 1)
    const device = parseDeviceKey(query.deviceKey)
    if (device) builder.where(device.kind === 'ap' ? 'ap_id' : 'collector_id', device.id)
    if (query.state === 'open') builder.whereIn('state', [...OPEN_JOB_STATES])
    if (query.state === 'final') builder.whereIn('state', [...FINAL_JOB_STATES])
    if (query.before) builder.where('id', '<', query.before)
    const rows = await builder
    const page = rows.slice(0, limit)
    return serialize({
      jobs: page.map((job) => ({
        ...jobSummary(job),
        device: jobDevice(job),
        product: job.product,
        rolloutId: job.rolloutId,
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    })
  }

  /** GET /api/v1/agent-updates/jobs/:id */
  async job({ params, response, serialize }: HttpContext) {
    const job = await AgentUpdateJob.find(Number(params.id))
    if (!job) return notFound(response, 'job_not_found', `Job ${params.id} does not exist.`)
    return serialize(await jobDetail(job))
  }

  /** GET /api/v1/agent-updates/events */
  async events({ request, serialize }: HttpContext) {
    const query = await eventsQueryValidator.validate(request.qs())
    const limit = query.limit ?? 100
    const builder = AgentUpdateEvent.query()
      .orderBy('id', 'desc')
      .limit(limit + 1)
    const device = parseDeviceKey(query.deviceKey)
    if (device) builder.where(device.kind === 'ap' ? 'ap_id' : 'collector_id', device.id)
    if (query.rolloutId) builder.where('rollout_id', query.rolloutId)
    if (query.jobId) builder.where('job_id', query.jobId)
    if (query.severity) builder.where('severity', query.severity)
    if (query.before) builder.where('id', '<', query.before)
    const rows = await builder
    const page = rows.slice(0, limit)
    const names = await userNames(page.map((row) => row.userId))
    return serialize({
      events: page.map((row) => eventView(row, names)),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    })
  }

  /** PATCH /api/v1/agent-updates/devices/:kind/:id */
  async updateDevice({ params, request, response, auth, serialize }: HttpContext) {
    const device = await findDevice(params)
    if (!device) return deviceNotFound(response)
    const payload = await request.validateUsing(deviceSettingsValidator)
    if (payload.pinnedVersion && !isValidVersion(payload.pinnedVersion)) {
      return response.unprocessableEntity({
        error: 'version_invalid',
        message: 'pinnedVersion must be a release version like 1.2.0.',
      })
    }
    const row = await ensureDeviceRow(device.kind, device.id)
    const changes: Record<string, unknown> = {}
    if (payload.channel !== undefined && payload.channel !== row.channel) {
      changes.channel = payload.channel
      row.channel = payload.channel
    }
    if (payload.autoUpdate !== undefined && payload.autoUpdate !== row.autoUpdate) {
      changes.autoUpdate = payload.autoUpdate
      row.autoUpdate = payload.autoUpdate
    }
    if (payload.pinnedVersion !== undefined && payload.pinnedVersion !== row.pinnedVersion) {
      changes.pinnedVersion = payload.pinnedVersion
      row.pinnedVersion = payload.pinnedVersion
    }
    if (Object.keys(changes).length > 0) {
      row.updatedAt = DateTime.utc()
      await row.save()
      await recordUpdateEvent('device_settings_changed', {
        device: { kind: device.kind, id: device.id, name: device.name },
        userId: auth.user?.id ?? null,
        detail: changes,
      })
    }
    return serialize(await freshDeviceView(device.kind, device.id, request))
  }

  /** POST /api/v1/agent-updates/devices/:kind/:id/refresh */
  async refresh({ params, request, response, serialize }: HttpContext) {
    const device = await findDevice(params)
    if (!device) return deviceNotFound(response)
    const support = selfUpdateSupport(device)
    if (!support.supported && ['agent_too_old', 'poll_transport'].includes(support.reason)) {
      return response.conflict({
        error: 'self_update_unsupported',
        reason: support.reason,
        message: 'This agent cannot report its update status.',
      })
    }
    const hub = hubFor(device.kind)
    const session = hub.liveSession(device.id)
    if (!session) return jobError(response, rpcToJobError(new AgentOfflineError(device.id)))
    try {
      const block = await hub.request(device.id, 'agent.update.status', {}, { timeoutMs: 10_000 })
      await recordUpdateReport(device.kind, device.id, block, {
        version: sessionState(session).version ?? device.version,
        session,
      })
    } catch (error) {
      return jobError(response, rpcToJobError(error))
    }
    return serialize(await freshDeviceView(device.kind, device.id, request))
  }

  /** POST /api/v1/agent-updates/devices/:kind/:id/preflight */
  async preflight({ params, request, response, auth, serialize }: HttpContext) {
    const device = await findDevice(params)
    if (!device) return deviceNotFound(response)
    const payload = await request.validateUsing(preflightValidator)
    const settings = await getAgentUpdateSettings()
    try {
      const support = selfUpdateSupport(device)
      if (!support.supported) throw unsupported(support.reason)
      if (!device.online) throw rpcToJobError(new AgentOfflineError(device.id))
      const source = payload.source ?? 'release'
      let preflight
      let release = null
      if (source === 'previous') {
        if (!support.report.previous) throw noPrevious()
        preflight = await dryRun(
          device,
          support.report,
          { source, method: payload.method ?? 'binary', release: null, artefacts: [] },
          settings
        )
      } else {
        if (!payload.version) {
          return response.unprocessableEntity({
            error: 'version_required',
            message: 'Name the version to check.',
          })
        }
        const plan = await planUpdate(device, support.report, payload.version, payload.method)
        release = { id: plan.release.id, version: plan.release.version }
        preflight = await dryRun(
          device,
          support.report,
          { source, method: plan.method, release: plan.release, artefacts: plan.artefacts },
          settings
        )
      }
      await recordUpdateEvent('preflight', {
        device: { kind: device.kind, id: device.id, name: device.name },
        releaseId: release?.id ?? null,
        userId: auth.user?.id ?? null,
        detail: {
          source,
          version: release?.version ?? support.report.previous?.version ?? null,
          method: preflight.method,
          ok: preflight.ok,
          problems: preflight.problems.map((problem) => problem.code),
        },
      })
      return serialize({ preflight, release })
    } catch (error) {
      if (error instanceof JobError) return jobError(response, error)
      throw error
    }
  }

  /** POST /api/v1/agent-updates/devices/:kind/:id/update */
  async update({ params, request, response, auth, serialize }: HttpContext) {
    const device = await findDevice(params)
    if (!device) return deviceNotFound(response)
    const payload = await request.validateUsing(updateDeviceValidator)
    const settings = await getAgentUpdateSettings()
    try {
      const support = selfUpdateSupport(device)
      if (!support.supported) throw unsupported(support.reason)
      const plan = await planUpdate(device, support.report, payload.version, payload.method)
      const open = await openJobFor(device.kind, device.id)
      if (open) {
        throw new JobError(409, 'update_in_progress', 'This device already has an open update.', {
          jobId: open.id,
        })
      }
      if (device.version === plan.release.version) {
        throw new JobError(409, 'same_version', `The device already runs ${device.version}.`)
      }
      const job = await createJob(
        {
          device,
          source: 'release',
          release: plan.release,
          toVersion: plan.release.version,
          method: plan.method,
          when: payload.when ?? 'now',
          acceptUnrecoverable: payload.acceptUnrecoverable ?? false,
          userId: auth.user?.id ?? null,
        },
        settings
      )
      response.status(201)
      return serialize(await jobDetail(job))
    } catch (error) {
      if (error instanceof JobError) return jobError(response, error)
      throw error
    }
  }

  /** POST /api/v1/agent-updates/devices/:kind/:id/rollback */
  async rollback({ params, request, response, auth, serialize }: HttpContext) {
    const device = await findDevice(params)
    if (!device) return deviceNotFound(response)
    const payload = await request.validateUsing(rollbackDeviceValidator)
    const settings = await getAgentUpdateSettings()
    const userId = auth.user?.id ?? null
    try {
      const open = await openJobFor(device.kind, device.id)
      if (open && ['installing', 'probation'].includes(open.state)) {
        const job = await abortJob(open, userId)
        return serialize(await jobDetail(job))
      }
      if (open) {
        throw new JobError(409, 'update_in_progress', 'This device already has an open update.', {
          jobId: open.id,
        })
      }
      const support = selfUpdateSupport(device)
      if (!support.supported) throw unsupported(support.reason)
      const previous = support.report.previous
      if (!previous) throw noPrevious()
      const job = await createJob(
        {
          device,
          source: 'previous',
          release: null,
          toVersion: previous.version,
          method: 'binary',
          when: 'now',
          acceptUnrecoverable: payload.acceptUnrecoverable ?? false,
          userId,
        },
        settings
      )
      response.status(201)
      return serialize(await jobDetail(job))
    } catch (error) {
      if (error instanceof JobError) return jobError(response, error)
      throw error
    }
  }

  /** POST /api/v1/agent-updates/jobs/:id/abort */
  async abort({ params, response, auth, serialize }: HttpContext) {
    const job = await AgentUpdateJob.find(Number(params.id))
    if (!job) return notFound(response, 'job_not_found', `Job ${params.id} does not exist.`)
    try {
      const updated = await abortJob(job, auth.user?.id ?? null)
      return serialize(await jobDetail(updated))
    } catch (error) {
      if (error instanceof JobError) return jobError(response, error)
      throw error
    }
  }

  /** GET /api/v1/settings/agent-updates */
  async settings({ serialize }: HttpContext) {
    return serialize(agentUpdateSettingsView(await getAgentUpdateSettings()))
  }

  /** PATCH /api/v1/settings/agent-updates */
  async updateSettings({ request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(agentUpdateSettingsValidator)
    if (payload.extraTrustedKeys) {
      const invalid = payload.extraTrustedKeys.find((line) => parseExtraKey(line) === null)
      if (invalid !== undefined) {
        return response.unprocessableEntity({
          error: 'key_invalid',
          message: 'Each extra trusted key must be a signify public key (RW…).',
        })
      }
    }
    const before = await getAgentUpdateSettings()
    const settings = await updateAgentUpdateSettings(payload)
    const changed = Object.keys(payload).filter(
      (key) =>
        JSON.stringify(before[key as keyof typeof before]) !==
        JSON.stringify(settings[key as keyof typeof settings])
    )
    if (changed.length > 0) {
      await recordUpdateEvent('settings_changed', {
        userId: auth.user?.id ?? null,
        detail: { changed },
      })
    }
    return serialize(agentUpdateSettingsView(settings))
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function unsupported(reason: string): JobError {
  return new JobError(409, 'self_update_unsupported', 'This device cannot update itself.', {
    reason,
  })
}

function noPrevious(): JobError {
  return new JobError(409, 'no_previous', 'The device keeps no previous version.')
}

function controllerUrl(request: HttpContext['request']): string {
  const configured = env.get('AP_AGENT_CONTROLLER_URL')
  const base = configured || `${request.protocol()}://${request.host()}`
  return base.replace(/\/+$/, '')
}

async function findDevice(params: Record<string, unknown>): Promise<DeviceHandle | null> {
  const kind =
    params.kind === 'ap' || params.kind === 'collector' ? (params.kind as DeviceKind) : null
  if (!kind) return null
  return loadDevice(kind, Number(params.id))
}

function deviceNotFound(response: HttpContext['response']) {
  return notFound(response, 'device_not_found', 'No such device.')
}

function notFound(response: HttpContext['response'], error: string, message: string) {
  return response.notFound({ error, message })
}

function jobError(response: HttpContext['response'], error: JobError) {
  return response
    .status(error.status)
    .send({ error: error.code, message: error.message, ...error.extra })
}

async function freshDeviceView(kind: DeviceKind, id: number, request: HttpContext['request']) {
  const device = (await loadDevice(kind, id))!
  const settings = await getAgentUpdateSettings()
  const context = await fleetContext(settings, controllerUrl(request))
  const jobs = await jobsByDevice([device])
  return deviceView(device, context, jobs.get(device.key) ?? { active: null, last: null })
}

async function userNames(ids: Array<number | null>): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))]
  if (wanted.length === 0) return new Map()
  const users = await User.query().whereIn('id', wanted)
  return new Map(users.map((user) => [user.id, user.fullName ?? user.email]))
}

function eventView(row: AgentUpdateEvent, names: Map<number, string>) {
  const kind = row.apId !== null ? 'ap' : row.collectorId !== null ? 'collector' : null
  const id = row.apId ?? row.collectorId
  return {
    id: row.id,
    at: row.createdAt.toISO(),
    event: row.event,
    severity: row.severity,
    device:
      kind && id !== null
        ? { key: `${kind}:${id}`, kind, id, name: row.deviceName ?? `${kind} ${id}` }
        : null,
    jobId: row.jobId,
    rolloutId: row.rolloutId,
    releaseId: row.releaseId,
    actor:
      row.userId !== null
        ? { userId: row.userId, name: names.get(row.userId) ?? `User ${row.userId}` }
        : row.systemActor
          ? { system: row.systemActor }
          : null,
    detail: row.detail,
  }
}

/** `AgentUpdateJob` (controller.md 9.1): the summary plus device, timeline and actors. */
async function jobDetail(job: AgentUpdateJob) {
  const events = await AgentUpdateEvent.query().where('job_id', job.id).orderBy('id')
  const names = await userNames([job.requestedByUserId])
  const started = events.find((row) => row.event === 'agent_update.started')
  const timeline: { at: string; state: string; note: string | null }[] = [
    { at: job.createdAt.toISO()!, state: 'queued', note: null },
  ]
  if (started) timeline.push({ at: started.createdAt.toISO()!, state: 'staging', note: null })
  if (job.stagedAt) timeline.push({ at: job.stagedAt.toISO()!, state: 'staged', note: null })
  if (job.installSentAt) {
    timeline.push({ at: job.installSentAt.toISO()!, state: 'installing', note: null })
  }
  if (job.reconnectedAt) {
    timeline.push({ at: job.reconnectedAt.toISO()!, state: 'probation', note: 'reconnected' })
  }
  const unknown = events.find((row) => row.event === 'agent_update.unknown')
  if (unknown) timeline.push({ at: unknown.createdAt.toISO()!, state: 'unknown', note: null })
  if (job.finishedAt) {
    timeline.push({ at: job.finishedAt.toISO()!, state: job.state, note: job.reason })
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at))
  return {
    ...jobSummary(job),
    device: jobDevice(job),
    product: job.product,
    releaseId: job.releaseId,
    rolloutId: job.rolloutId,
    preflight: job.preflight,
    requestedBy:
      job.requestedByUserId !== null
        ? {
            userId: job.requestedByUserId,
            name: names.get(job.requestedByUserId) ?? `User ${job.requestedByUserId}`,
          }
        : job.systemActor
          ? { system: job.systemActor }
          : null,
    timeline,
    stagedAt: job.stagedAt?.toISO() ?? null,
    installSentAt: job.installSentAt?.toISO() ?? null,
    reconnectedAt: job.reconnectedAt?.toISO() ?? null,
    confirmedAt: job.confirmedAt?.toISO() ?? null,
  }
}
