import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import AgentUpdateDevice from '#models/agent_update_device'
import AgentUpdateJob from '#models/agent_update_job'
import SystemSetting from '#models/system_setting'
import { loadAllDevices } from '#services/agent_updates/devices'
import { recordUpdateEvent } from '#services/agent_updates/events'
import { effectiveAutoUpdate, fleetContext, offersFor } from '#services/agent_updates/fleet'
import {
  checkGithubReleases,
  fetchArtefact,
  githubFetchIsFaked,
  githubState,
  isFetching,
  type GithubCheckResult,
} from '#services/agent_updates/github'
import {
  checkConfirm,
  expireQueued,
  installStagedJob,
  markOverdue,
  startQueuedJob,
} from '#services/agent_updates/jobs'
import { runningVersions } from '#services/agent_updates/releases'
import { advanceRollouts, autoUpdate } from '#services/agent_updates/rollouts'
import { getAgentUpdateSettings, type AgentUpdateSettings } from '#services/agent_updates/settings'
import { refreshInFlight } from '#services/agent_updates/state'
import { deleteStoredArtefact } from '#services/agent_updates/store'
import { compareVersions } from '#services/agent_updates/versions'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * One pass of agent updates (controller.md section 5.2), every 5 s from
 * `app/tasks/agent_updates_tick.task.ts`: rebuild the in-flight set, stage
 * queued jobs whose time has come, install staged ones, run the confirm
 * checks, mark overdue jobs `unknown`, expire old queued jobs, one step of
 * every open rollout; then, when due, auto-update (inside the maintenance
 * window only), the GitHub check (in the background), the
 * `agent_update.available` notices and the daily retention.
 */

const ANNOUNCED_KEY = 'agent_updates_announced'
const MAX_ANNOUNCED = 200
const AVAILABILITY_EVERY_MS = 10 * 60_000
const RETENTION_EVERY_MS = 24 * 3600_000
const AUTO_UPDATE_EVERY_MS = 60_000

let githubRunning = false
let lastAvailabilityAt = 0
let lastRetentionAt = 0
let lastAutoUpdateAt = 0

export async function agentUpdatesTick(now: DateTime = DateTime.utc()): Promise<void> {
  await refreshInFlight()
  const settings = await getAgentUpdateSettings()

  const queued = await AgentUpdateJob.query().where('state', 'queued').orderBy('id')
  await Promise.allSettled(
    queued
      .filter((job) => !job.notBefore || job.notBefore <= now)
      .map((job) =>
        startQueuedJob(job, settings).catch((error) =>
          logger.error({ jobId: job.id, err: error }, 'agent_updates: stage failed')
        )
      )
  )

  const staged = await AgentUpdateJob.query().where('state', 'staged').orderBy('id')
  await Promise.allSettled(
    staged.map((job) =>
      installStagedJob(job, settings).catch((error) =>
        logger.error({ jobId: job.id, err: error }, 'agent_updates: install failed')
      )
    )
  )

  const checking = await AgentUpdateJob.query().whereIn('state', [
    'installing',
    'probation',
    'unknown',
  ])
  for (const job of checking) {
    const kind = job.apId !== null ? 'ap' : 'collector'
    const id = job.apId ?? job.collectorId
    if (id === null) continue
    await checkConfirm(kind, id, settings, now).catch((error) =>
      logger.error({ jobId: job.id, err: error }, 'agent_updates: confirm check failed')
    )
  }

  await markOverdue(settings, now)
  await expireQueued(settings, now)
  await advanceRollouts(settings, now)
  if (Date.now() - lastAutoUpdateAt >= AUTO_UPDATE_EVERY_MS) {
    lastAutoUpdateAt = Date.now()
    await autoUpdate(settings, now).catch((error) =>
      logger.error({ err: error }, 'agent_updates: auto-update failed')
    )
  }

  await maybeCheckGithub(settings, now)
  if (Date.now() - lastAvailabilityAt >= AVAILABILITY_EVERY_MS) {
    lastAvailabilityAt = Date.now()
    await announceAvailable(settings)
  }
  if (Date.now() - lastRetentionAt >= RETENTION_EVERY_MS) {
    lastRetentionAt = Date.now()
    await runRetention(settings, now)
  }
}

/** Starts the GitHub check in the background when it is on and due. */
async function maybeCheckGithub(settings: AgentUpdateSettings, now: DateTime): Promise<void> {
  if (!settings.githubCheck || githubRunning) return
  // Tests never reach GitHub unless they replaced fetch.
  if (app.inTest && !githubFetchIsFaked()) return
  const state = await githubState()
  const last = state.lastCheckAt ? DateTime.fromISO(state.lastCheckAt) : null
  if (last && last.isValid && now.diff(last, 'hours').hours < settings.githubCheckIntervalHours) {
    return
  }
  githubRunning = true
  checkGithubReleases(settings, now)
    .then((result) => afterGithubCheck(result, settings, null))
    .catch((error) => logger.warn({ err: error }, 'agent_updates: GitHub check failed'))
    .finally(() => {
      githubRunning = false
    })
}

/**
 * The audit rows of a check (imports, rejections), then prefetch and the
 * availability notices. Also run after "Check now".
 */
export async function afterGithubCheck(
  result: GithubCheckResult,
  settings: AgentUpdateSettings,
  userId: number | null
): Promise<void> {
  for (const id of result.imported) {
    const release = await AgentRelease.find(id)
    if (!release) continue
    await recordUpdateEvent('release_imported', {
      releaseId: release.id,
      userId,
      systemActor: 'github_check',
      detail: { product: release.product, version: release.version, source: 'github' },
    })
  }
  for (const rejected of result.rejected) {
    await recordUpdateEvent('agent_update.release_rejected', {
      userId,
      systemActor: 'github_check',
      detail: {
        source: 'github',
        product: rejected.product,
        version: rejected.version,
        reason: rejected.reason,
        keyId: rejected.keyId,
        detail: rejected.detail,
      },
    })
  }
  if (settings.prefetch && result.imported.length > 0) {
    prefetch(settings).catch((error) =>
      logger.warn({ err: error }, 'agent_updates: prefetch failed')
    )
  }
  await announceAvailable(settings)
}

/** Fetches ahead the artefacts devices would need for what they are offered. */
export async function prefetch(settings: AgentUpdateSettings): Promise<void> {
  const context = await fleetContext(settings, null)
  const wanted = new Map<number, AgentArtefact>()
  for (const device of await loadAllDevices()) {
    const offer = offersFor(device, context)[0]
    if (!offer) continue
    for (const artefact of offer.artefacts) {
      if (!artefact.storedPath && artefact.sourceUrl) wanted.set(artefact.id, artefact)
    }
  }
  for (const artefact of wanted.values()) {
    if (isFetching(artefact.id)) continue
    try {
      await fetchArtefact(artefact)
    } catch (error) {
      logger.warn({ artefactId: artefact.id, err: error }, 'agent_updates: prefetch failed')
    }
  }
}

/**
 * `agent_update.available`, once per (product, version): for every release
 * some device (auto-update not `off`) is newly offered.
 */
export async function announceAvailable(settings: AgentUpdateSettings): Promise<void> {
  const context = await fleetContext(settings, null)
  const byRelease = new Map<
    number,
    {
      release: AgentRelease
      devices: Array<{ kind: string; id: number; name: string; version: string | null }>
    }
  >()
  for (const device of await loadAllDevices()) {
    if (effectiveAutoUpdate(device, settings) === 'off') continue
    const offer = offersFor(device, context)[0]
    if (!offer) continue
    const entry = byRelease.get(offer.release.id) ?? { release: offer.release, devices: [] }
    entry.devices.push({
      kind: device.kind,
      id: device.id,
      name: device.name,
      version: device.version,
    })
    byRelease.set(offer.release.id, entry)
  }
  if (byRelease.size === 0) return
  const stored = await SystemSetting.get<unknown>(ANNOUNCED_KEY)
  const announced = Array.isArray(stored)
    ? stored.filter((entry): entry is string => typeof entry === 'string')
    : []
  let changed = false
  for (const { release, devices } of byRelease.values()) {
    const key = `${release.product}@${release.version}`
    if (announced.includes(key)) continue
    await recordUpdateEvent('agent_update.available', {
      releaseId: release.id,
      systemActor: 'tick',
      detail: {
        product: release.product,
        version: release.version,
        channel: release.channel,
        devices,
      },
    })
    announced.push(key)
    changed = true
  }
  if (changed) await SystemSetting.set(ANNOUNCED_KEY, announced.slice(-MAX_ANNOUNCED))
}

/**
 * Daily: audit rows and final jobs past `historyDays`; stored artefact files
 * of releases outside the newest `keepReleases` per product that nothing
 * needs (a device runs or keeps it as `previous`, an open job uses it). The
 * rows stay; a GitHub release is fetched again when needed.
 */
export async function runRetention(settings: AgentUpdateSettings, now = DateTime.utc()) {
  const cutoff = now.minus({ days: settings.historyDays }).toFormat('yyyy-MM-dd HH:mm:ss')
  await db.from('agent_update_events').where('created_at', '<', cutoff).delete()
  await db
    .from('agent_update_jobs')
    .whereNull('active_key')
    .where('finished_at', '<', cutoff)
    .delete()

  const releases = await AgentRelease.all()
  const running = await runningVersions()
  const previous = new Set<string>()
  for (const row of await AgentUpdateDevice.query().whereNotNull('report')) {
    const product = row.apId !== null ? 'perch-apd' : 'perch-collector'
    if (row.report?.previous) previous.add(`${product}@${row.report.previous.version}`)
  }
  const openJobs = await AgentUpdateJob.query()
    .whereNotNull('active_key')
    .whereNotNull('release_id')
  const openReleaseIds = new Set(openJobs.map((job) => job.releaseId!))
  for (const product of ['perch-apd', 'perch-collector'] as const) {
    const ordered = releases
      .filter((release) => release.product === product)
      .sort((a, b) => compareVersions(b.version, a.version))
    for (const release of ordered.slice(settings.keepReleases)) {
      if (running[product].includes(release.version)) continue
      if (previous.has(`${product}@${release.version}`)) continue
      if (openReleaseIds.has(release.id)) continue
      const stored = await AgentArtefact.query()
        .where('release_id', release.id)
        .whereNotNull('stored_path')
      for (const artefact of stored) await deleteStoredArtefact(artefact)
    }
  }
}

/** Test-only: forget the in-process schedule of the periodic parts. */
export function _resetTickSchedule(): void {
  lastAvailabilityAt = 0
  lastRetentionAt = 0
  lastAutoUpdateAt = 0
  githubRunning = false
}
