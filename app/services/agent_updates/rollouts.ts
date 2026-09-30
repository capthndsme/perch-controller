import AgentRelease from '#models/agent_release'
import AgentUpdateJob from '#models/agent_update_job'
import AgentUpdateRollout, {
  OPEN_ROLLOUT_STATES,
  type RolloutState,
  type RolloutWaiting,
} from '#models/agent_update_rollout'
import AgentUpdateRolloutDevice, {
  type RolloutDeviceState,
  type RolloutSkipReason,
} from '#models/agent_update_rollout_device'
import User from '#models/user'
import {
  loadAllDevices,
  loadDevice,
  reportOf,
  type DeviceHandle,
} from '#services/agent_updates/devices'
import { recordUpdateEvent, type EventDevice } from '#services/agent_updates/events'
import { effectiveAutoUpdate, fleetContext, offersFor } from '#services/agent_updates/fleet'
import {
  JobError,
  abortJob,
  createJob,
  jobSummary,
  openJobFor,
  planUpdate,
  selfUpdateSupport,
  type AgentUpdateJobSummary,
} from '#services/agent_updates/jobs'
import type { AgentProduct } from '#services/agent_updates/manifest'
import { notOfferableReason } from '#services/agent_updates/releases'
import type { UpdateMethod } from '#services/agent_updates/report'
import type { AgentUpdateSettings } from '#services/agent_updates/settings'
import { deviceKey, type DeviceKind } from '#services/agent_updates/state'
import { compareVersions } from '#services/agent_updates/versions'
import { currentWindow, isWindowOpen } from '#services/agent_updates/window'
import { getPresenceSettings } from '#services/presence_settings'
import { instanceTimezone } from '#services/usage_history'
import { stationConnectedSql } from '#services/wifi_presence'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Rollouts (agent-updates controller.md section 6.1): one release to many
 * devices of a product, one step per tick (every 5 s):
 *
 *   canary     the canary's job (a lone device is its own canary); confirmed
 *              → observing; failed or rolled back → paused (device_failed)
 *   observing  canary_observe_minutes; the canary must stay online and on the
 *              target version, else paused
 *   rolling    when nothing of the rollout is running, the gap has passed and
 *              (with respect_window) the maintenance window is open: the next
 *              batch_size devices; offline devices wait offline_wait_minutes,
 *              then are skipped; a failure pauses (stop_on_failure) or the
 *              rollout goes on without that device
 *   completed  nothing pending or running
 *
 * A rollout only ever starts jobs: it interrupts nothing when the window
 * closes or it is paused, and a cancel aborts only jobs that have not left
 * the queue. One open rollout per product; a device an open rollout still
 * has to update refuses manual updates (`rollout_owns_device`).
 *
 * Auto-update (section 6.3) creates rollouts for devices set to `auto`, only
 * while the maintenance window is open (owner decision: automatic only
 * inside a maintenance window), one per product and release.
 */

export class RolloutError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'RolloutError'
  }
}

type DeviceRefKind = { kind: DeviceKind; id: number }

function refOf(row: AgentUpdateRolloutDevice): DeviceRefKind {
  return row.apId !== null
    ? { kind: 'ap', id: row.apId }
    : { kind: 'collector', id: row.collectorId! }
}

function eventDevice(row: AgentUpdateRolloutDevice): EventDevice {
  return { ...refOf(row), name: row.deviceName }
}

function deviceRef(row: AgentUpdateRolloutDevice) {
  const ref = refOf(row)
  return { key: deviceKey(ref.kind, ref.id), ...ref, name: row.deviceName }
}

/** The devices of a rollout in order. */
export async function rolloutDevices(rolloutId: number): Promise<AgentUpdateRolloutDevice[]> {
  return AgentUpdateRolloutDevice.query().where('rollout_id', rolloutId).orderBy('position')
}

/** The open rollout of a product, if any. */
export async function openRolloutOf(product: AgentProduct): Promise<AgentUpdateRollout | null> {
  return AgentUpdateRollout.query()
    .where('product', product)
    .whereIn('state', [...OPEN_ROLLOUT_STATES])
    .first()
}

/**
 * The open rollout that still has to update this device (it is pending or
 * running there), or null: manual updates are refused meanwhile.
 */
export async function rolloutOwning(
  kind: DeviceKind,
  id: number
): Promise<AgentUpdateRollout | null> {
  const row = await AgentUpdateRolloutDevice.query()
    .where(kind === 'ap' ? 'ap_id' : 'collector_id', id)
    .whereIn('state', ['pending', 'running'])
    .whereIn(
      'rollout_id',
      db
        .from('agent_update_rollouts')
        .whereIn('state', [...OPEN_ROLLOUT_STATES])
        .select('id')
    )
    .first()
  return row ? AgentUpdateRollout.find(row.rolloutId) : null
}

// ── eligibility and the canary ───────────────────────────────────────────

type Eligibility = { ok: true } | { ok: false; reason: RolloutSkipReason; detail: string }

async function eligibility(
  device: DeviceHandle,
  release: AgentRelease,
  method: 'auto' | UpdateMethod
): Promise<Eligibility> {
  const support = selfUpdateSupport(device)
  if (!support.supported) {
    return { ok: false, reason: 'unsupported', detail: `cannot update itself (${support.reason})` }
  }
  if (device.settings?.pinnedVersion) {
    return { ok: false, reason: 'pinned', detail: `held at ${device.settings.pinnedVersion}` }
  }
  if (device.version && compareVersions(device.version, release.version) >= 0) {
    return { ok: false, reason: 'up_to_date', detail: `runs ${device.version}` }
  }
  const report = support.report
  if (report.floor && compareVersions(release.version, report.floor) < 0) {
    return { ok: false, reason: 'unsupported', detail: `below the device's floor ${report.floor}` }
  }
  if (release.minFromVersion && compareVersions(device.version, release.minFromVersion) < 0) {
    return {
      ok: false,
      reason: 'unsupported',
      detail: `installs only over ${release.minFromVersion} or newer`,
    }
  }
  try {
    await planUpdate(device, report, release.version, method === 'auto' ? null : method)
  } catch (error) {
    if (error instanceof JobError) {
      return { ok: false, reason: 'unsupported', detail: error.message }
    }
    throw error
  }
  return { ok: true }
}

/** Connected Wi-Fi clients per AP (the canary suggestion prefers a quiet AP). */
async function clientsPerAp(): Promise<Map<number, number>> {
  const thresholds = await getPresenceSettings()
  const [rows] = (await db.rawQuery(
    `SELECT s.ap_id AS apId, COUNT(*) AS clients
       FROM wifi_station_latest s
       INNER JOIN wifi_access_points ap ON ap.id = s.ap_id
      WHERE ${stationConnectedSql(thresholds, 's', 'ap')}
      GROUP BY s.ap_id`
  )) as [Array<{ apId: number; clients: number | string }>, unknown]
  return new Map(rows.map((row) => [Number(row.apId), Number(row.clients)]))
}

/**
 * The suggested canary among eligible devices: for APs the most free flash,
 * then the fewest connected clients; a collector that is not a gateway before
 * a gateway; then the name.
 */
export async function suggestCanary(devices: DeviceHandle[]): Promise<DeviceHandle | null> {
  if (devices.length === 0) return null
  const clients = devices.some((d) => d.kind === 'ap') ? await clientsPerAp() : new Map()
  const free = (d: DeviceHandle) => reportOf(d)?.flash?.freeBytes ?? 0
  return [...devices].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      Number(a.role === 'gateway') - Number(b.role === 'gateway') ||
      free(b) - free(a) ||
      (a.kind === 'ap' ? (clients.get(a.id) ?? 0) : 0) -
        (b.kind === 'ap' ? (clients.get(b.id) ?? 0) : 0) ||
      a.name.localeCompare(b.name) ||
      a.id - b.id
  )[0]
}

// ── creating ─────────────────────────────────────────────────────────────

export type CreateRolloutInput = {
  product: AgentProduct
  version: string
  deviceKeys?: string[]
  canaryKey?: string
  method?: 'auto' | UpdateMethod
  batchSize?: number
  batchGapSeconds?: number
  canaryObserveMinutes?: number
  offlineWaitMinutes?: number
  stopOnFailure?: boolean
  respectWindow?: boolean
  acceptUnrecoverable?: boolean
  userId: number | null
  auto?: boolean
}

/**
 * Creates a rollout (endpoint 20 and auto-update). Devices: the given keys
 * (the ones that cannot take the release are listed as skipped, with why) or
 * every eligible device of the product. Omitted tunables come from settings.
 */
export async function createRollout(
  input: CreateRolloutInput,
  settings: AgentUpdateSettings,
  now: DateTime = DateTime.utc()
): Promise<AgentUpdateRollout> {
  const release = await AgentRelease.query()
    .where('product', input.product)
    .where('version', input.version)
    .first()
  if (!release) {
    throw new RolloutError(
      422,
      'release_not_found',
      `${input.product} ${input.version} is not known.`
    )
  }
  const reason = notOfferableReason(release)
  if (reason) {
    throw new RolloutError(409, 'release_not_offerable', 'This release cannot be offered.', {
      reason,
    })
  }
  const open = await openRolloutOf(input.product)
  if (open) {
    throw new RolloutError(
      409,
      'rollout_open',
      `Rollout #${open.id} of ${input.product} is still open.`,
      {
        rolloutId: open.id,
      }
    )
  }
  const method = input.method ?? 'auto'
  const loaded = await loadAllDevices()
  const all = loaded.filter((device) => device.product === input.product)
  let chosen: DeviceHandle[]
  if (input.deviceKeys && input.deviceKeys.length > 0) {
    chosen = []
    for (const key of [...new Set(input.deviceKeys)]) {
      const device = all.find((d) => d.key === key)
      if (!device) {
        throw new RolloutError(
          422,
          'device_not_found',
          `${key} is not a ${input.product} device.`,
          {
            deviceKey: key,
          }
        )
      }
      chosen.push(device)
    }
  } else {
    chosen = all
  }

  const eligible: DeviceHandle[] = []
  const skipped: Array<{ device: DeviceHandle; reason: RolloutSkipReason; detail: string }> = []
  for (const device of chosen) {
    const verdict = await eligibility(device, release, method)
    if (verdict.ok) eligible.push(device)
    else if (input.deviceKeys?.length) skipped.push({ device, ...verdict })
  }
  if (eligible.length === 0) {
    throw new RolloutError(422, 'no_eligible_devices', 'No device can take this release.', {
      skipped: skipped.map(({ device, reason: why, detail }) => ({
        key: device.key,
        reason: why,
        detail,
      })),
    })
  }
  let canary: DeviceHandle | null
  if (input.canaryKey) {
    canary = eligible.find((d) => d.key === input.canaryKey) ?? null
    if (!canary) {
      throw new RolloutError(
        422,
        'canary_not_in_rollout',
        'The canary must be one of the eligible devices.',
        {
          canaryKey: input.canaryKey,
        }
      )
    }
  } else {
    canary = await suggestCanary(eligible)
  }
  const rest = eligible
    .filter((d) => d !== canary)
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))

  const rollout = await db.transaction(async (trx) => {
    const row = new AgentUpdateRollout()
    row.useTransaction(trx)
    row.product = input.product
    row.releaseId = release.id
    row.version = release.version
    row.state = 'canary'
    row.method = method
    row.batchSize = input.batchSize ?? settings.batchSize
    row.batchGapSeconds = input.batchGapSeconds ?? settings.batchGapSeconds
    row.canaryObserveMinutes = input.canaryObserveMinutes ?? settings.canaryObserveMinutes
    row.offlineWaitMinutes = input.offlineWaitMinutes ?? settings.offlineWaitMinutes
    row.stopOnFailure = input.stopOnFailure ?? settings.stopOnFailure
    row.respectWindow = input.auto ? true : (input.respectWindow ?? settings.windowEnabled)
    row.auto = input.auto ?? false
    row.acceptUnrecoverable = input.acceptUnrecoverable ?? false
    row.waitingFor = null
    row.pausedReason = null
    row.pausedDetail = null
    row.createdByUserId = input.userId
    row.createdAt = now
    row.startedAt = now
    row.canaryConfirmedAt = null
    row.nextActionAt = now
    row.finishedAt = null
    row.updatedAt = now
    await row.save()
    const members = [canary!, ...rest]
    let position = 0
    for (const device of members) {
      await AgentUpdateRolloutDevice.create(
        {
          rolloutId: row.id,
          apId: device.kind === 'ap' ? device.id : null,
          collectorId: device.kind === 'collector' ? device.id : null,
          deviceName: device.name.slice(0, 120),
          position: position++,
          isCanary: device === canary,
          state: 'pending',
          skipReason: null,
          detail: null,
          jobId: null,
          offlineSince: null,
          updatedAt: now,
        },
        { client: trx }
      )
    }
    for (const { device, reason: why, detail } of skipped) {
      await AgentUpdateRolloutDevice.create(
        {
          rolloutId: row.id,
          apId: device.kind === 'ap' ? device.id : null,
          collectorId: device.kind === 'collector' ? device.id : null,
          deviceName: device.name.slice(0, 120),
          position: position++,
          isCanary: false,
          state: 'skipped',
          skipReason: why,
          detail: detail.slice(0, 500),
          jobId: null,
          offlineSince: null,
          updatedAt: now,
        },
        { client: trx }
      )
    }
    return row
  })
  await recordUpdateEvent('rollout_created', {
    rolloutId: rollout.id,
    releaseId: release.id,
    userId: input.userId,
    systemActor: input.auto ? 'auto_update' : null,
    detail: {
      product: rollout.product,
      version: rollout.version,
      devices: eligible.length,
      skipped: skipped.length,
      canary: canary!.key,
      method,
      batchSize: rollout.batchSize,
      respectWindow: rollout.respectWindow,
      stopOnFailure: rollout.stopOnFailure,
      auto: rollout.auto,
    },
  })
  return rollout
}

// ── the engine ───────────────────────────────────────────────────────────

async function saveRollout(rollout: AgentUpdateRollout, now: DateTime) {
  rollout.updatedAt = now
  await rollout.save()
}

async function setDevice(
  row: AgentUpdateRolloutDevice,
  patch: Partial<
    Pick<AgentUpdateRolloutDevice, 'state' | 'skipReason' | 'detail' | 'jobId' | 'offlineSince'>
  >,
  now: DateTime
) {
  Object.assign(row, patch)
  if (patch.detail !== undefined) row.detail = patch.detail?.slice(0, 500) ?? null
  row.updatedAt = now
  await row.save()
}

export async function pauseRollout(
  rollout: AgentUpdateRollout,
  reason: string,
  detail: string | null,
  options: { device?: AgentUpdateRolloutDevice; userId?: number | null; now?: DateTime } = {}
): Promise<AgentUpdateRollout> {
  const now = options.now ?? DateTime.utc()
  rollout.state = 'paused'
  rollout.pausedReason = reason.slice(0, 48)
  rollout.pausedDetail = detail?.slice(0, 500) ?? null
  rollout.waitingFor = null
  await saveRollout(rollout, now)
  await recordUpdateEvent('agent_update.rollout_paused', {
    rolloutId: rollout.id,
    releaseId: rollout.releaseId,
    device: options.device ? eventDevice(options.device) : null,
    userId: options.userId ?? null,
    systemActor: options.userId ? null : 'rollout',
    detail: {
      rolloutId: rollout.id,
      product: rollout.product,
      version: rollout.version,
      reason,
      detail,
      device: options.device ? deviceRef(options.device) : null,
    },
  })
  return rollout
}

async function complete(
  rollout: AgentUpdateRollout,
  devices: AgentUpdateRolloutDevice[],
  now: DateTime
) {
  rollout.state = 'completed'
  rollout.waitingFor = null
  rollout.finishedAt = now
  rollout.nextActionAt = null
  await saveRollout(rollout, now)
  const count = (state: RolloutDeviceState) => devices.filter((d) => d.state === state).length
  await recordUpdateEvent('agent_update.rollout_completed', {
    rolloutId: rollout.id,
    releaseId: rollout.releaseId,
    systemActor: 'rollout',
    detail: {
      rolloutId: rollout.id,
      product: rollout.product,
      version: rollout.version,
      confirmed: count('confirmed'),
      skipped: count('skipped'),
      failed: count('failed'),
    },
  })
}

/**
 * Settles devices whose job finished. Returns the first failure that stops
 * the rollout (the canary's always; any device's with stop_on_failure).
 */
async function settleRunning(
  rollout: AgentUpdateRollout,
  devices: AgentUpdateRolloutDevice[],
  now: DateTime
): Promise<{ stop: AgentUpdateRolloutDevice | null; settled: boolean }> {
  let stop: AgentUpdateRolloutDevice | null = null
  let settled = false
  for (const row of devices) {
    if (row.state !== 'running') continue
    const job = row.jobId ? await AgentUpdateJob.find(row.jobId) : null
    if (job?.isOpen) continue
    settled = true
    if (!job) {
      await setDevice(row, { state: 'failed', detail: 'its update job is gone' }, now)
    } else if (job.state === 'confirmed') {
      await setDevice(row, { state: 'confirmed', detail: null }, now)
      continue
    } else if (job.state === 'cancelled') {
      await setDevice(
        row,
        { state: 'skipped', skipReason: 'admin', detail: 'the update was cancelled' },
        now
      )
      continue
    } else if (job.state === 'expired') {
      await setDevice(
        row,
        {
          state: 'skipped',
          skipReason: 'offline',
          detail: 'the update waited too long in the queue',
        },
        now
      )
      continue
    } else {
      await setDevice(
        row,
        {
          state: 'failed',
          detail: `${job.state}${job.reason ? `: ${job.reason}` : ''}${job.detail ? ` (${job.detail})` : ''}`,
        },
        now
      )
    }
    if (!stop && (row.isCanary || rollout.stopOnFailure)) stop = row
  }
  return { stop, settled }
}

type StartOutcome = 'started' | 'skipped' | RolloutWaiting

/** Starts one pending device's job, or says what it waits for. */
async function startDevice(
  rollout: AgentUpdateRollout,
  release: AgentRelease,
  row: AgentUpdateRolloutDevice,
  settings: AgentUpdateSettings,
  now: DateTime
): Promise<StartOutcome> {
  const ref = refOf(row)
  const device = await loadDevice(ref.kind, ref.id)
  if (!device) {
    await setDevice(
      row,
      { state: 'skipped', skipReason: 'unsupported', detail: 'the device is gone' },
      now
    )
    return 'skipped'
  }
  const verdict = await eligibility(device, release, rollout.method)
  if (!verdict.ok) {
    await setDevice(
      row,
      { state: 'skipped', skipReason: verdict.reason, detail: verdict.detail },
      now
    )
    return 'skipped'
  }
  if (!device.online) {
    const since = row.offlineSince ?? now
    if (!row.offlineSince) await setDevice(row, { offlineSince: since }, now)
    if (now.diff(since, 'minutes').minutes >= rollout.offlineWaitMinutes) {
      await setDevice(
        row,
        {
          state: 'skipped',
          skipReason: 'offline',
          detail: `offline for ${rollout.offlineWaitMinutes} min`,
        },
        now
      )
      return 'skipped'
    }
    return 'online'
  }
  if (row.offlineSince) await setDevice(row, { offlineSince: null }, now)
  const open = await openJobFor(device.kind, device.id)
  if (open) {
    if (open.rolloutId === rollout.id) {
      await setDevice(row, { state: 'running', jobId: open.id }, now)
      return 'started'
    }
    return 'busy'
  }
  try {
    const plan = await planUpdate(
      device,
      reportOf(device)!,
      release.version,
      rollout.method === 'auto' ? null : rollout.method
    )
    const job = await createJob(
      {
        device,
        source: 'release',
        release: plan.release,
        toVersion: plan.release.version,
        method: plan.method,
        when: 'now', // the rollout already waited for its window
        acceptUnrecoverable: rollout.acceptUnrecoverable,
        userId: null,
        systemActor: rollout.auto ? 'auto_update' : 'rollout',
        rolloutId: rollout.id,
      },
      settings
    )
    await setDevice(row, { state: 'running', jobId: job.id, detail: null }, now)
    return 'started'
  } catch (error) {
    if (error instanceof JobError) {
      if (error.code === 'update_in_progress') return 'busy'
      await setDevice(
        row,
        { state: 'skipped', skipReason: 'unsupported', detail: error.message },
        now
      )
      return 'skipped'
    }
    throw error
  }
}

/** Seconds a canary may be away during its observation before the rollout pauses. */
async function canaryGraceSeconds(ref: DeviceRefKind): Promise<number> {
  if (ref.kind === 'ap') {
    const row = (await db
      .from('wifi_access_points')
      .where('id', ref.id)
      .select('poll_interval_seconds')
      .first()) as { poll_interval_seconds: number } | undefined
    return Math.max(2 * Number(row?.poll_interval_seconds ?? 15), 30)
  }
  return 30
}

/** One step of one open rollout. */
export async function advanceRollout(
  rollout: AgentUpdateRollout,
  settings: AgentUpdateSettings,
  timezone: string,
  now: DateTime = DateTime.utc()
): Promise<AgentUpdateRollout> {
  if (!['canary', 'observing', 'rolling'].includes(rollout.state)) return rollout
  const release = rollout.releaseId ? await AgentRelease.find(rollout.releaseId) : null
  const blocked = release ? notOfferableReason(release) : 'release_withdrawn'
  if (!release || blocked) {
    const reason = blocked === 'controller_too_old' ? 'controller_too_old' : 'release_withdrawn'
    return pauseRollout(rollout, reason, release ? null : 'the release was deleted', { now })
  }
  const devices = await rolloutDevices(rollout.id)
  const { stop, settled } = await settleRunning(rollout, devices, now)
  if (stop) {
    return pauseRollout(
      rollout,
      'device_failed',
      `${stop.deviceName}: ${stop.detail ?? 'failed'}`,
      {
        device: stop,
        now,
      }
    )
  }
  const running = devices.filter((d) => d.state === 'running')
  const pending = devices.filter((d) => d.state === 'pending')
  const waiting = async (what: RolloutWaiting | null) => {
    if (rollout.waitingFor !== what) {
      rollout.waitingFor = what
      await saveRollout(rollout, now)
    }
    return rollout
  }
  const windowOk = () => !rollout.respectWindow || isWindowOpen(settings, timezone, now)

  if (rollout.state === 'canary') {
    const canary = devices.find((d) => d.isCanary)
    if (!canary || canary.state === 'skipped') {
      // The canary could not take part (offline too long, gone): the next
      // pending device becomes the canary.
      const next = pending[0]
      if (!next) {
        await complete(rollout, devices, now)
        return rollout
      }
      if (canary) {
        canary.isCanary = false
        await setDevice(canary, {}, now)
      }
      next.isCanary = true
      await setDevice(next, {}, now)
      return waiting(null)
    }
    if (canary.state === 'pending') {
      if (!windowOk()) return waiting('window')
      const outcome = await startDevice(rollout, release, canary, settings, now)
      return waiting(outcome === 'started' || outcome === 'skipped' ? null : outcome)
    }
    if (canary.state === 'confirmed') {
      rollout.state = 'observing'
      rollout.canaryConfirmedAt = now
      rollout.nextActionAt = now.plus({ minutes: rollout.canaryObserveMinutes })
      rollout.waitingFor = 'observe'
      await saveRollout(rollout, now)
      if (rollout.canaryObserveMinutes > 0) return rollout
    } else {
      return waiting(null) // running
    }
  }

  if (rollout.state === 'observing') {
    const canary = devices.find((d) => d.isCanary)!
    const ref = refOf(canary)
    const device = await loadDevice(ref.kind, ref.id)
    if (!device || (device.version && device.version !== rollout.version)) {
      return pauseRollout(
        rollout,
        'canary_changed',
        device ? `${canary.deviceName} now runs ${device.version}` : `${canary.deviceName} is gone`,
        { device: canary, now }
      )
    }
    if (!device.online) {
      const since = canary.offlineSince ?? now
      if (!canary.offlineSince) await setDevice(canary, { offlineSince: since }, now)
      if (now.diff(since, 'seconds').seconds > (await canaryGraceSeconds(ref))) {
        return pauseRollout(
          rollout,
          'canary_offline',
          `${canary.deviceName} went offline while observed`,
          {
            device: canary,
            now,
          }
        )
      }
      return waiting('observe')
    }
    if (canary.offlineSince) await setDevice(canary, { offlineSince: null }, now)
    if (rollout.nextActionAt && now < rollout.nextActionAt) return waiting('observe')
    rollout.state = 'rolling'
    rollout.nextActionAt = now
    rollout.waitingFor = null
    await saveRollout(rollout, now)
  }

  // rolling
  if (running.length > 0) return waiting(null)
  if (settled) {
    // A batch just finished: the gap starts now.
    rollout.nextActionAt = now.plus({ seconds: rollout.batchGapSeconds })
    await saveRollout(rollout, now)
  }
  if (pending.length === 0) {
    await complete(rollout, devices, now)
    return rollout
  }
  if (rollout.nextActionAt && now < rollout.nextActionAt) return waiting('gap')
  if (!windowOk()) return waiting('window')
  let started = 0
  let wait: RolloutWaiting | null = null
  for (const row of pending) {
    if (started >= rollout.batchSize) break
    const outcome = await startDevice(rollout, release, row, settings, now)
    if (outcome === 'started') started++
    else if (outcome !== 'skipped') wait = wait ?? outcome
  }
  if (started === 0 && wait === null) {
    // Everything left was skipped: done on the next step.
    return waiting(null)
  }
  return waiting(started > 0 ? null : wait)
}

/** Every open rollout, one step (tick). */
export async function advanceRollouts(
  settings: AgentUpdateSettings,
  now: DateTime = DateTime.utc()
): Promise<void> {
  const open = await AgentUpdateRollout.query()
    .whereIn('state', ['canary', 'observing', 'rolling'])
    .orderBy('id')
  if (open.length === 0) return
  const timezone = await instanceTimezone()
  for (const rollout of open) {
    await advanceRollout(rollout, settings, timezone, now).catch((error) =>
      logger.error({ rolloutId: rollout.id, err: error }, 'agent_updates: rollout step failed')
    )
  }
}

// ── admin actions ────────────────────────────────────────────────────────

function assertOpen(rollout: AgentUpdateRollout) {
  if (!rollout.isOpen) {
    throw new RolloutError(409, 'rollout_final', `Rollout #${rollout.id} has ${rollout.state}.`)
  }
}

export async function pauseByAdmin(rollout: AgentUpdateRollout, userId: number | null) {
  assertOpen(rollout)
  if (rollout.state === 'paused') return rollout
  return pauseRollout(rollout, 'admin', null, { userId })
}

/**
 * Resume: back to the canary step when the canary never confirmed, else to
 * rolling. Failed devices are tried again, or with `skipFailed` left out.
 */
export async function resumeRollout(
  rollout: AgentUpdateRollout,
  options: { skipFailed: boolean; userId: number | null },
  now: DateTime = DateTime.utc()
) {
  assertOpen(rollout)
  if (rollout.state !== 'paused') {
    throw new RolloutError(409, 'rollout_not_paused', `Rollout #${rollout.id} is not paused.`)
  }
  const release = rollout.releaseId ? await AgentRelease.find(rollout.releaseId) : null
  const reason = release ? notOfferableReason(release) : 'withdrawn'
  if (reason) {
    throw new RolloutError(
      409,
      'release_not_offerable',
      'The release cannot be offered any more.',
      {
        reason,
      }
    )
  }
  const devices = await rolloutDevices(rollout.id)
  for (const row of devices.filter((d) => d.state === 'failed')) {
    if (options.skipFailed) {
      await setDevice(row, { state: 'skipped', skipReason: 'failed', detail: row.detail }, now)
    } else {
      await setDevice(row, { state: 'pending', jobId: null, offlineSince: null }, now)
    }
  }
  rollout.state = rollout.canaryConfirmedAt ? 'rolling' : 'canary'
  rollout.pausedReason = null
  rollout.pausedDetail = null
  rollout.waitingFor = null
  rollout.nextActionAt = now
  await saveRollout(rollout, now)
  await recordUpdateEvent('rollout_resumed', {
    rolloutId: rollout.id,
    releaseId: rollout.releaseId,
    userId: options.userId,
    detail: { skipFailed: options.skipFailed, state: rollout.state },
  })
  return rollout
}

/** Cancel: nothing more starts; jobs still queued are cancelled, running ones finish. */
export async function cancelRollout(
  rollout: AgentUpdateRollout,
  userId: number | null,
  now: DateTime = DateTime.utc()
) {
  assertOpen(rollout)
  const devices = await rolloutDevices(rollout.id)
  for (const row of devices) {
    if (row.state === 'pending') {
      await setDevice(
        row,
        { state: 'skipped', skipReason: 'admin', detail: 'the rollout was cancelled' },
        now
      )
    } else if (row.state === 'running' && row.jobId) {
      const job = await AgentUpdateJob.find(row.jobId)
      if (job && job.state === 'queued') {
        await abortJob(job, userId)
        await setDevice(
          row,
          { state: 'skipped', skipReason: 'admin', detail: 'the rollout was cancelled' },
          now
        )
      }
    }
  }
  rollout.state = 'cancelled'
  rollout.waitingFor = null
  rollout.nextActionAt = null
  rollout.finishedAt = now
  await saveRollout(rollout, now)
  await recordUpdateEvent('rollout_cancelled', {
    rolloutId: rollout.id,
    releaseId: rollout.releaseId,
    userId,
    detail: { product: rollout.product, version: rollout.version },
  })
  return rollout
}

/** A withdrawn release pauses its open rollouts at once (the tick would too). */
export async function pauseRolloutsOfRelease(releaseId: number, userId: number | null) {
  const open = await AgentUpdateRollout.query()
    .where('release_id', releaseId)
    .whereIn('state', ['canary', 'observing', 'rolling'])
  for (const rollout of open) {
    await pauseRollout(rollout, 'release_withdrawn', null, { userId })
  }
}

// ── auto-update ──────────────────────────────────────────────────────────

/**
 * Auto-update (controller.md 6.3, owner decision): for each product, the
 * newest release offered to devices set to `auto`, as one rollout of those
 * devices, only while the maintenance window is open (never with the window
 * switched off), never while another rollout of the product is open, and once
 * per release (a paused, cancelled or finished auto rollout is not
 * recreated; an admin can start another).
 */
export async function autoUpdate(
  settings: AgentUpdateSettings,
  now: DateTime = DateTime.utc()
): Promise<AgentUpdateRollout[]> {
  if (!settings.windowEnabled) return []
  const timezone = await instanceTimezone()
  if (!currentWindow(settings, timezone, now)) return []
  const context = await fleetContext(settings, null, now)
  const devices = await loadAllDevices()
  const created: AgentUpdateRollout[] = []
  for (const product of ['perch-apd', 'perch-collector'] as const) {
    const auto = devices.filter(
      (d) => d.product === product && effectiveAutoUpdate(d, settings) === 'auto'
    )
    if (auto.length === 0) continue
    if (await openRolloutOf(product)) continue
    const offered = new Map<number, { release: AgentRelease; keys: string[] }>()
    for (const device of auto) {
      // Offers follow the device's channel, floor and "hold at".
      const offer = offersFor(device, context)[0]
      if (!offer) continue
      const entry = offered.get(offer.release.id) ?? { release: offer.release, keys: [] }
      entry.keys.push(device.key)
      offered.set(offer.release.id, entry)
    }
    const newest = [...offered.values()].sort((a, b) =>
      compareVersions(b.release.version, a.release.version)
    )[0]
    if (!newest) continue
    const before = await AgentUpdateRollout.query()
      .where('release_id', newest.release.id)
      .where('auto', true)
      .first()
    if (before) continue
    try {
      created.push(
        await createRollout(
          {
            product,
            version: newest.release.version,
            deviceKeys: newest.keys,
            respectWindow: true,
            stopOnFailure: true,
            userId: null,
            auto: true,
          },
          settings,
          now
        )
      )
    } catch (error) {
      if (!(error instanceof RolloutError)) throw error
      logger.info({ product, code: error.code }, 'agent_updates: auto-update made no rollout')
    }
  }
  return created
}

// ── views ────────────────────────────────────────────────────────────────

export type AgentRolloutDeviceView = {
  device: { key: string; kind: DeviceKind; id: number; name: string }
  position: number
  isCanary: boolean
  state: RolloutDeviceState
  skipReason: string | null
  detail: string | null
  /** What the device runs now. */
  version: string | null
  online: boolean
  job: AgentUpdateJobSummary | null
}

export type AgentRolloutView = {
  id: number
  product: AgentProduct
  version: string
  releaseId: number | null
  state: RolloutState
  method: 'auto' | UpdateMethod
  batchSize: number
  batchGapSeconds: number
  canaryObserveMinutes: number
  offlineWaitMinutes: number
  stopOnFailure: boolean
  respectWindow: boolean
  acceptUnrecoverable: boolean
  auto: boolean
  waitingFor: RolloutWaiting | null
  pausedReason: string | null
  pausedDetail: string | null
  counts: {
    total: number
    confirmed: number
    failed: number
    skipped: number
    pending: number
    running: number
  }
  canary: { key: string; name: string } | null
  devices?: AgentRolloutDeviceView[]
  createdBy: { userId: number; name: string } | { system: 'auto_update' } | null
  createdAt: string
  startedAt: string | null
  canaryConfirmedAt: string | null
  finishedAt: string | null
  nextActionAt: string | null
}

async function userNames(ids: Array<number | null>): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))]
  if (wanted.length === 0) return new Map()
  const users = await User.query().whereIn('id', wanted)
  return new Map(users.map((user) => [user.id, user.fullName ?? user.email]))
}

/** `AgentRollout` (controller.md 9.1); with `withDevices`, each device and its job. */
export async function rolloutViews(
  rollouts: AgentUpdateRollout[],
  options: { withDevices?: boolean } = {}
): Promise<AgentRolloutView[]> {
  if (rollouts.length === 0) return []
  const ids = rollouts.map((r) => r.id)
  const rows = await AgentUpdateRolloutDevice.query().whereIn('rollout_id', ids).orderBy('position')
  const names = await userNames(rollouts.map((r) => r.createdByUserId))
  let jobs = new Map<number, AgentUpdateJob>()
  let handles = new Map<string, DeviceHandle>()
  if (options.withDevices) {
    const jobIds = rows.map((r) => r.jobId).filter((id): id is number => id !== null)
    if (jobIds.length > 0) {
      const found = await AgentUpdateJob.query().whereIn('id', jobIds)
      jobs = new Map(found.map((j) => [j.id, j]))
    }
    const loaded = await loadAllDevices()
    handles = new Map(loaded.map((d) => [d.key, d]))
  }
  return rollouts.map((rollout) => {
    const mine = rows.filter((r) => r.rolloutId === rollout.id)
    const count = (state: RolloutDeviceState) => mine.filter((r) => r.state === state).length
    const canary = mine.find((r) => r.isCanary)
    const view: AgentRolloutView = {
      id: rollout.id,
      product: rollout.product,
      version: rollout.version,
      releaseId: rollout.releaseId,
      state: rollout.state,
      method: rollout.method,
      batchSize: rollout.batchSize,
      batchGapSeconds: rollout.batchGapSeconds,
      canaryObserveMinutes: rollout.canaryObserveMinutes,
      offlineWaitMinutes: rollout.offlineWaitMinutes,
      stopOnFailure: rollout.stopOnFailure,
      respectWindow: rollout.respectWindow,
      acceptUnrecoverable: rollout.acceptUnrecoverable,
      auto: rollout.auto,
      waitingFor: rollout.isOpen ? rollout.waitingFor : null,
      pausedReason: rollout.pausedReason,
      pausedDetail: rollout.pausedDetail,
      counts: {
        total: mine.length,
        confirmed: count('confirmed'),
        failed: count('failed'),
        skipped: count('skipped'),
        pending: count('pending'),
        running: count('running'),
      },
      canary: canary ? { key: deviceRef(canary).key, name: canary.deviceName } : null,
      createdBy:
        rollout.createdByUserId !== null
          ? {
              userId: rollout.createdByUserId,
              name: names.get(rollout.createdByUserId) ?? `User ${rollout.createdByUserId}`,
            }
          : rollout.auto
            ? { system: 'auto_update' }
            : null,
      createdAt: rollout.createdAt.toISO()!,
      startedAt: rollout.startedAt?.toISO() ?? null,
      canaryConfirmedAt: rollout.canaryConfirmedAt?.toISO() ?? null,
      finishedAt: rollout.finishedAt?.toISO() ?? null,
      nextActionAt: rollout.isOpen ? (rollout.nextActionAt?.toISO() ?? null) : null,
    }
    if (options.withDevices) {
      view.devices = mine.map((row) => {
        const ref = refOf(row)
        const key = deviceKey(ref.kind, ref.id)
        const handle = handles.get(key)
        const job = row.jobId ? jobs.get(row.jobId) : undefined
        return {
          device: { key, kind: ref.kind, id: ref.id, name: handle?.name ?? row.deviceName },
          position: row.position,
          isCanary: row.isCanary,
          state: row.state,
          skipReason: row.skipReason,
          detail: row.detail,
          version: handle?.version ?? null,
          online: handle?.online ?? false,
          job: job ? jobSummary(job) : null,
        }
      })
    }
    return view
  })
}

export async function rolloutView(rollout: AgentUpdateRollout): Promise<AgentRolloutView> {
  const [view] = await rolloutViews([rollout], { withDevices: true })
  return view
}
