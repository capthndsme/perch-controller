import ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import ApConfigRevision from '#models/ap_config_revision'
import WifiAccessPoint from '#models/wifi_access_point'
import WifiIfaceLink from '#models/wifi_iface_link'
import WifiRollout from '#models/wifi_rollout'
import WifiRolloutStep from '#models/wifi_rollout_step'
import { cloneContent, contentsEqual } from '#services/gateway_config/canonical'
import { planRestore } from '#services/gateway_config/revisions'
import {
  deriveStatus,
  FINISHED_APPLY_STATES,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import {
  actorColumns,
  parseSystemActor,
  type ConfirmMode,
  type Issue,
  type PlaneActor,
} from '#services/gateway_config/types'
import { scalarOf } from '#services/wifi_config/domains/normalize'
import {
  adminDeviceOf,
  connectedStations,
  countClients,
  type ConnectedStation,
} from '#services/wifi_config/clients'
import { rolloutRunning, wifiError, WifiPlaneError } from '#services/wifi_config/errors'
import { emitWifiAlert, recordApEvent } from '#services/wifi_config/events'
import { impactForAp, previewImpact } from '#services/wifi_config/fleet/impact'
import {
  planApJobs,
  registryFor,
  requestApApply,
  validateApStates,
} from '#services/wifi_config/lifecycle'
import {
  apDisplayName,
  apSession,
  apUpdateInFlight,
  normalizeApMode,
  writeAccess,
  writeBlockCode,
} from '#services/wifi_config/registry'
import { rolloutOrder, type OrderCandidate } from '#services/wifi_config/rollout_order'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import {
  apConfigQueue,
  FLEET,
  fleetQueue,
  hasOpenApApply,
  loadApSections,
  refreshApSyncState,
  saveApStates,
} from '#services/wifi_config/store'
import type {
  ImpactAp,
  ImpactPreview,
  OfflinePolicy,
  RolloutKind,
  RolloutStepState,
} from '#services/wifi_config/types'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Rollouts (docs/design/wifi controller.md section 6, decision D8): a change
 * goes to the managed APs one at a time, in canary order (fewest clients
 * first, the admin's own AP last, protected jobs last), and stops at the
 * first AP that fails, rolls back or refuses. One rollout at a time
 * fleet-wide: a running, paused or stopped rollout blocks the next one (a
 * stopped one waits for Retry, Skip, Roll back or Cancel). Offline APs are
 * skipped (they catch up on reconnect) or waited for.
 *
 * Everything here runs in the fleet queue; per-AP work goes through each
 * AP's queue (lock order fleet → AP). A controller restart resumes from the
 * database: the tick calls `advanceRollouts`.
 */

/** Rollout states that keep the fleet from starting another one. */
export const ACTIVE_ROLLOUT_STATES = ['running', 'paused', 'stopped'] as const
const DONE_STEP_STATES: RolloutStepState[] = [
  'confirmed',
  'noop',
  'failed',
  'rolled_back',
  'skipped',
  'cancelled',
]

/** Per AP: the sections a rollout carries (null = everything the AP has to apply). */
export type RolloutTargets = Map<number, string[] | null>

export type RolloutRequest = {
  kind: RolloutKind
  actor: PlaneActor | null
  targets?: RolloutTargets
  networkIds?: number[]
  apIds?: number[]
  perchIds?: string[]
  order?: number[]
  confirmMode?: ConfirmMode
  offlinePolicy?: OfflinePolicy
  note?: string | null
  /** The requesting admin's client address (their device goes last). */
  adminAddress?: string | null
  /** Preview only: rows as a draft would leave them (nothing stored). */
  states?: Map<number, SectionState[]>
}

type PlannedStep = {
  ap: ApConfig
  name: string
  online: boolean
  perchIds: string[]
  impact: Omit<ImpactAp, 'order'>
  protected: boolean
  clients: number
}

export type RolloutPlan = {
  steps: PlannedStep[]
  order: number[]
  preview: ImpactPreview
}

export async function activeRollout(): Promise<WifiRollout | null> {
  return WifiRollout.query()
    .whereIn('state', ACTIVE_ROLLOUT_STATES as unknown as string[])
    .orderBy('id', 'desc')
    .first()
}

/** Whether a rollout's step is running on the AP (Authoritative reverts wait for it). */
export async function rolloutStepActive(apId: number): Promise<boolean> {
  const row = await WifiRolloutStep.query()
    .where('ap_id', apId)
    .whereIn('state', ['applying', 'waiting_offline'])
    .first()
  return row !== null
}

async function targetsOf(request: RolloutRequest): Promise<RolloutTargets> {
  if (request.targets) return request.targets
  const managed = await ApConfig.query().where('mode', 'managed').orderBy('ap_id')
  const out: RolloutTargets = new Map()
  const links =
    request.networkIds && request.networkIds.length > 0
      ? await WifiIfaceLink.query().whereIn('network_id', request.networkIds)
      : null
  for (const ap of managed) {
    if (request.apIds && !request.apIds.includes(ap.apId)) continue
    let perchIds: string[] | null = null
    if (links) perchIds = links.filter((l) => l.apId === ap.apId).map((l) => l.perchId)
    if (request.perchIds) {
      perchIds = perchIds
        ? perchIds.filter((id) => request.perchIds!.includes(id))
        : [...request.perchIds]
    }
    out.set(ap.apId, perchIds)
  }
  if (request.apIds) {
    const unmanaged = request.apIds.filter((id) => !managed.some((ap) => ap.apId === id))
    if (unmanaged.length > 0) {
      throw wifiError(409, 'not_managed', 'Some access points are not managed by Perch.', {
        apIds: unmanaged,
      })
    }
  }
  return out
}

/**
 * The rollout a request would start (controller.md 6.1): per AP its jobs
 * and impact, the refusals (conflicts, invalid config, write blocks), and
 * the order. Writes nothing.
 */
export async function planRollout(request: RolloutRequest): Promise<RolloutPlan> {
  const settings = await getWifiConfigSettings()
  const targets = await targetsOf(request)
  const stations = await connectedStations([...targets.keys()])
  const adminDevice = await adminDeviceOf(request.adminAddress ?? null, stations)
  const planned: PlannedStep[] = []
  const errors: Issue[] = []
  const blocked: Record<string, number[]> = {}
  for (const [apId, perchIds] of targets) {
    const ap = await ApConfig.find(apId)
    if (!ap) continue
    if (normalizeApMode(ap.mode) !== 'managed') {
      ;(blocked.not_managed ??= []).push(apId)
      continue
    }
    const apRow = await WifiAccessPoint.find(apId)
    let states = request.states?.get(apId)
    if (!states) {
      const loaded = await loadApSections(apId)
      states = loaded.states
    }
    const filter = perchIds === null ? undefined : perchIds
    if (filter && filter.length === 0) continue
    const plan = planApJobs(ap, states, { perchIds: filter })
    let jobs = plan.jobs
    if (request.kind === 'adopt') jobs = jobs.filter((j) => j.kind === 'adopt').slice(0, 1)
    if (jobs.length === 0) {
      const conflicted = plan.blocked.filter((b) => b.reason === 'conflict').map((b) => b.perchId)
      if (conflicted.length > 0 && filter) {
        throw wifiError(409, 'conflicts_open', 'Resolve the open conflicts first.', {
          apId,
          perchIds: conflicted,
        })
      }
      continue
    }
    const conflicted = plan.blocked.filter((b) => b.reason === 'conflict').map((b) => b.perchId)
    if (conflicted.length > 0 && filter) {
      throw wifiError(409, 'conflicts_open', 'Resolve the open conflicts first.', {
        apId,
        perchIds: conflicted,
      })
    }
    const jobIds = new Set(jobs.flatMap((j) => j.perchIds))
    for (const issue of validateApStates(ap, states)) {
      if (issue.severity === 'error' && (!issue.perchId || jobIds.has(issue.perchId))) {
        errors.push({
          ...issue,
          message: `${apRow ? apDisplayName(apRow) : `AP ${apId}`}: ${issue.message}`,
        })
      }
    }
    const access = writeAccess(ap, settings)
    if (!access.writable && access.reason !== 'offline') {
      ;(blocked[writeBlockCode(access.reason)] ??= []).push(apId)
      continue
    }
    const name = apRow ? apDisplayName(apRow) : `AP ${apId}`
    const clientsBySection: Record<string, number> = {}
    for (const row of states) {
      if (row.config !== 'wireless' || row.type !== 'wifi-iface') continue
      const content = row.desired ?? row.router
      if (!content) continue
      clientsBySection[row.name] = countClients(stations, {
        apId,
        ssid: scalarOf(content.options, 'ssid'),
        radio: scalarOf(content.options, 'device'),
      })
    }
    const adminSection = adminDevice && adminDevice.apId === apId ? adminDevice : null
    const impact = impactForAp({
      ap: { id: apId, name, online: access.writable, caps: ap.capabilities },
      order: 0,
      jobs: jobs.map((j) => ({ kind: j.kind, protected: j.protected, changes: j.changes })),
      rows: states,
      clientsBySection,
      adminDevice: adminSection ? { apId, section: null } : null,
      settings,
    })
    planned.push({
      ap,
      name,
      online: access.writable,
      perchIds: [...jobIds],
      impact,
      protected: jobs.some((j) => j.protected),
      clients: countClients(stations, { apId }),
    })
  }
  for (const [code, apIds] of Object.entries(blocked)) {
    const message =
      code === 'not_managed'
        ? 'Some access points are not managed by Perch.'
        : 'Some access points cannot be written now.'
    throw wifiError(409, code, message, { apIds })
  }
  if (errors.length > 0) {
    throw wifiError(422, 'invalid_config', errors[0].message, { issues: errors })
  }
  if (planned.length === 0) throw wifiError(409, 'nothing_to_apply', 'There is nothing to apply.')
  const candidates: OrderCandidate[] = planned.map((p) => ({
    apId: p.ap.apId,
    name: p.name,
    online: p.online,
    protected: p.protected,
    clients: p.clients,
    adminDeviceHere: adminDevice?.apId === p.ap.apId,
  }))
  const order = rolloutOrder(candidates, settings.rolloutOrder, request.order)
  const aps = order.map((apId, i) => ({
    ...planned.find((p) => p.ap.apId === apId)!.impact,
    order: i,
  }))
  const preview = previewImpact(
    aps,
    adminDevice ? { mac: adminDevice.mac, apId: adminDevice.apId, ssid: adminDevice.ssid } : null
  )
  return {
    steps: order.map((apId) => planned.find((p) => p.ap.apId === apId)!),
    order,
    preview,
  }
}

/** `POST /wifi/rollouts/preview`: the impact of a rollout, nothing written. */
export async function previewRollout(request: RolloutRequest): Promise<ImpactPreview> {
  const plan = await planRollout(request)
  return plan.preview
}

/**
 * Starts a rollout (controller.md 6.1): refused while another is active
 * (`rollout_running`); the first step starts at once.
 */
export async function createRollout(request: RolloutRequest): Promise<WifiRollout> {
  return fleetQueue.run(FLEET, async () => {
    const active = await activeRollout()
    if (active) throw rolloutRunning(Number(active.id))
    const settings = await getWifiConfigSettings()
    const plan = await planRollout(request)
    const rollout = new WifiRollout()
    rollout.kind = request.kind
    rollout.state = 'running'
    const actor = actorColumns(request.actor)
    rollout.requestedByUserId = actor.userId
    rollout.systemActor = actor.systemActor
    rollout.note = request.note ? request.note.slice(0, 500) : null
    rollout.confirmMode = request.confirmMode ?? settings.confirmMode
    rollout.offlinePolicy = request.offlinePolicy ?? settings.rolloutOfflinePolicy
    rollout.networkIds = request.networkIds ?? []
    rollout.apOrder = plan.order
    rollout.stop = null
    rollout.impact = plan.preview
    rollout.createdAt = DateTime.utc()
    rollout.finishedAt = null
    await rollout.save()
    let position = 0
    for (const step of plan.steps) {
      const row = new WifiRolloutStep()
      row.rolloutId = rollout.id
      row.apId = step.ap.apId
      row.position = position++
      row.state = 'pending'
      row.perchIds = step.perchIds
      row.applyId = null
      row.startedAt = null
      row.finishedAt = null
      row.outcome = null
      await row.save()
      await recordApEvent(step.ap.apId, 'rollout_started', {
        actor: request.actor,
        detail: { rolloutId: Number(rollout.id), kind: rollout.kind, position: row.position },
      })
    }
    await advanceRollout(rollout)
    await rollout.refresh()
    return rollout
  })
}

/** Runs every rollout that can move (the tick, and each finished job). */
export async function advanceRollouts(): Promise<void> {
  return fleetQueue.run(FLEET, async () => {
    const rows = await WifiRollout.query()
      .whereIn('state', ['running', 'paused', 'stopped', 'cancelled'])
      .orderBy('id')
    for (const rollout of rows) {
      if (rollout.state === 'cancelled' || rollout.state === 'stopped') {
        // Only steps still applying settle (their jobs finish on the AP).
        const applying = await WifiRolloutStep.query()
          .where('rollout_id', Number(rollout.id))
          .where('state', 'applying')
          .first()
        if (!applying) continue
      }
      try {
        await advanceRollout(rollout)
      } catch (error) {
        logger.warn(
          { rolloutId: Number(rollout.id), error: (error as Error).message },
          'wifi_config: rollout step failed'
        )
      }
    }
  })
}

async function stepsOf(rollout: WifiRollout): Promise<WifiRolloutStep[]> {
  return WifiRolloutStep.query().where('rollout_id', Number(rollout.id)).orderBy('position')
}

/** The latest job of a step (a chain moves on to the next job). */
async function latestApply(step: WifiRolloutStep): Promise<ApConfigApply | null> {
  return ApConfigApply.query()
    .where('ap_id', step.apId)
    .where('rollout_id', Number(step.rolloutId))
    .orderBy('id', 'desc')
    .first()
}

async function stopRollout(
  rollout: WifiRollout,
  step: WifiRolloutStep,
  stop: { reason: string; applyId: string | null; message: string }
) {
  if (rollout.state === 'running' || rollout.state === 'paused') rollout.state = 'stopped'
  rollout.stop = { apId: step.apId, ...stop }
  await rollout.save()
  const steps = await stepsOf(rollout)
  const completed = steps.filter((s) => s.state === 'confirmed').map((s) => s.apId)
  for (const s of steps) {
    await recordApEvent(s.apId, 'rollout_stopped', {
      detail: { rolloutId: Number(rollout.id), apId: step.apId, reason: stop.reason },
    })
  }
  emitWifiAlert({
    name: 'wifi.rollout.stopped',
    severity: 'warning',
    source: { kind: 'wifi_rollout', id: Number(rollout.id) },
    dedupeKey: `wifi.rollout.stopped:${rollout.id}`,
    payload: {
      rolloutId: Number(rollout.id),
      apId: step.apId,
      reason: stop.reason,
      completedApIds: completed,
    },
  })
}

/**
 * One rollout's next moves (controller.md 6.4): settle the running step
 * from its job; then, while running, start the next step (skip or wait for
 * an offline AP; wait while an update holds it or another job runs on it),
 * until one is applying or the rollout completes. Stops at the first
 * failure.
 */
export async function advanceRollout(rollout: WifiRollout): Promise<void> {
  const settings = await getWifiConfigSettings()
  for (let guard = 0; guard < 256; guard++) {
    const steps = await stepsOf(rollout)
    const applying = steps.find((s) => s.state === 'applying')
    if (applying) {
      const apply = await latestApply(applying)
      if (!apply || !(FINISHED_APPLY_STATES as string[]).includes(apply.state)) return
      applying.applyId = apply.id
      applying.finishedAt = DateTime.utc()
      if (apply.state === 'confirmed') {
        applying.state = 'confirmed'
        await applying.save()
        continue
      }
      const reason = String(apply.outcome?.reason ?? apply.outcome?.error ?? apply.state)
      const message = String(apply.outcome?.message ?? '')
      applying.state =
        apply.state === 'rolled_back'
          ? 'rolled_back'
          : apply.state === 'cancelled'
            ? 'cancelled'
            : 'failed'
      applying.outcome = {
        ...(applying.outcome ?? {}),
        reason,
        ...(apply.outcome?.error ? { error: String(apply.outcome.error) } : {}),
        ...(message ? { message } : {}),
      }
      await applying.save()
      if (rollout.state !== 'cancelled') {
        await stopRollout(rollout, applying, { reason, applyId: apply.applyKey, message })
      }
      return
    }
    if (rollout.state !== 'running') return
    const next = steps.find((s) => s.state === 'pending' || s.state === 'waiting_offline')
    if (!next) {
      await completeRollout(rollout, steps)
      return
    }
    const ap = await ApConfig.find(next.apId)
    if (!ap || normalizeApMode(ap.mode) !== 'managed') {
      next.state = 'failed'
      next.finishedAt = DateTime.utc()
      next.outcome = { reason: 'not_managed', message: 'The access point is no longer managed.' }
      await next.save()
      await stopRollout(rollout, next, {
        reason: 'not_managed',
        applyId: null,
        message: next.outcome.message!,
      })
      return
    }
    const access = writeAccess(ap, settings)
    if (!access.writable && access.reason === 'offline') {
      if (rollout.offlinePolicy === 'wait') {
        if (next.state !== 'waiting_offline') {
          next.state = 'waiting_offline'
          await next.save()
        }
        return
      }
      next.state = 'skipped'
      next.finishedAt = DateTime.utc()
      next.outcome = { reason: 'offline', message: 'The access point was offline.' }
      await next.save()
      emitWifiAlert({
        name: 'wifi.ap.behind',
        severity: 'warning',
        source: { kind: 'ap', id: next.apId },
        dedupeKey: `wifi.ap.behind:${next.apId}`,
        payload: {
          apId: next.apId,
          networkIds: rollout.networkIds,
          since: DateTime.utc().toISO(),
          passphraseChanged: false,
        },
      })
      continue
    }
    if (apUpdateInFlight(next.apId) || (await hasOpenApApply(next.apId))) return
    next.state = 'applying'
    next.startedAt = DateTime.utc()
    next.outcome = { revisionBefore: ap.headRevision }
    await next.save()
    try {
      const apply = await requestApApply(next.apId, {
        actor: parseSystemActor(rollout.systemActor)
          ? { system: parseSystemActor(rollout.systemActor)! }
          : rollout.requestedByUserId,
        perchIds: next.perchIds,
        adoptOnly: rollout.kind === 'adopt',
        confirmMode: rollout.confirmMode as ConfirmMode,
        note: rollout.note,
        rolloutId: Number(rollout.id),
        catchUp: rollout.kind === 'catch_up',
      })
      next.applyId = apply.id
      await next.save()
    } catch (error) {
      if (error instanceof WifiPlaneError && error.code === 'nothing_to_apply') {
        next.state = 'noop'
        next.finishedAt = DateTime.utc()
        await next.save()
        continue
      }
      const code = error instanceof WifiPlaneError ? error.code : 'apply_failed'
      next.state = 'failed'
      next.finishedAt = DateTime.utc()
      next.outcome = {
        ...(next.outcome ?? {}),
        error: code,
        reason: code,
        message: (error as Error).message,
      }
      await next.save()
      await stopRollout(rollout, next, {
        reason: code,
        applyId: null,
        message: (error as Error).message,
      })
      return
    }
  }
}

async function completeRollout(rollout: WifiRollout, steps: WifiRolloutStep[]) {
  rollout.state = 'completed'
  rollout.finishedAt = DateTime.utc()
  await rollout.save()
  for (const s of steps) {
    await recordApEvent(s.apId, rollout.kind === 'catch_up' ? 'caught_up' : 'rollout_completed', {
      detail: { rolloutId: Number(rollout.id), state: s.state },
    })
  }
  emitWifiAlert({
    name: rollout.kind === 'catch_up' ? 'wifi.ap.caught_up' : 'wifi.rollout.completed',
    severity: 'info',
    source: { kind: 'wifi_rollout', id: Number(rollout.id) },
    dedupeKey: `wifi.rollout.completed:${rollout.id}`,
    payload: {
      rolloutId: Number(rollout.id),
      apIds: steps.filter((s) => s.state === 'confirmed').map((s) => s.apId),
      skippedApIds: steps.filter((s) => s.state === 'skipped').map((s) => s.apId),
      durationSeconds: Math.round(DateTime.utc().diff(rollout.createdAt, 'seconds').seconds),
    },
  })
}

// ── admin actions (controller.md 6.4) ────────────────────────────────────

export type RolloutAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'skip' | 'rollback'

export async function findRollout(id: number): Promise<WifiRollout> {
  const rollout = await WifiRollout.find(id)
  if (!rollout) throw wifiError(404, 'rollout_not_found', `No rollout ${id}.`)
  return rollout
}

/**
 * Pause (after the running step), resume, cancel (drafts kept), retry the
 * stopped AP, skip it (its rows stay ahead), or roll back the completed APs
 * (a `revert` rollout restoring each one's revision from before this
 * rollout). Returns the rollout the admin should look at next.
 */
export async function rolloutAction(
  id: number,
  action: RolloutAction,
  options: { actor: PlaneActor | null; apId?: number; adminAddress?: string | null }
): Promise<WifiRollout> {
  return fleetQueue.run(FLEET, async () => {
    const rollout = await findRollout(id)
    const steps = await stepsOf(rollout)
    switch (action) {
      case 'pause': {
        if (rollout.state !== 'running') {
          throw wifiError(409, 'rollout_not_running', 'The rollout is not running.')
        }
        rollout.state = 'paused'
        await rollout.save()
        break
      }
      case 'resume': {
        if (rollout.state !== 'paused') {
          throw wifiError(409, 'rollout_not_running', 'The rollout is not paused.')
        }
        rollout.state = 'running'
        await rollout.save()
        await advanceRollout(rollout)
        break
      }
      case 'cancel': {
        if (!(ACTIVE_ROLLOUT_STATES as readonly string[]).includes(rollout.state)) {
          throw wifiError(409, 'rollout_not_running', 'The rollout has finished.')
        }
        rollout.state = 'cancelled'
        rollout.finishedAt = DateTime.utc()
        await rollout.save()
        for (const s of steps) {
          if (s.state === 'pending' || s.state === 'waiting_offline') {
            s.state = 'cancelled'
            s.finishedAt = DateTime.utc()
            await s.save()
          }
        }
        break
      }
      case 'retry': {
        if (rollout.state !== 'stopped') {
          throw wifiError(409, 'rollout_not_stopped', 'The rollout is not stopped.')
        }
        const step = steps.find((s) => s.apId === (options.apId ?? rollout.stop?.apId))
        if (!step || !['failed', 'rolled_back', 'cancelled'].includes(step.state)) {
          throw wifiError(409, 'step_not_skippable', 'That access point has nothing to retry.')
        }
        step.state = 'pending'
        step.applyId = null
        step.startedAt = null
        step.finishedAt = null
        step.outcome = null
        await step.save()
        rollout.state = 'running'
        rollout.stop = null
        await rollout.save()
        await advanceRollout(rollout)
        break
      }
      case 'skip': {
        const apId = options.apId ?? rollout.stop?.apId
        const step = steps.find((s) => s.apId === apId)
        const skippable =
          step &&
          ((rollout.state === 'stopped' &&
            ['failed', 'rolled_back', 'cancelled'].includes(step.state)) ||
            ((rollout.state === 'running' || rollout.state === 'paused') &&
              (step.state === 'waiting_offline' || step.state === 'pending')))
        if (!skippable) {
          throw wifiError(409, 'step_not_skippable', 'That step cannot be skipped.')
        }
        step!.state = 'skipped'
        step!.finishedAt = DateTime.utc()
        step!.outcome = {
          ...(step!.outcome ?? {}),
          reason: 'skipped',
          message: 'Skipped by an admin.',
        }
        await step!.save()
        if (rollout.state === 'stopped') {
          rollout.state = 'running'
          rollout.stop = null
          await rollout.save()
        }
        await advanceRollout(rollout)
        break
      }
      case 'rollback': {
        if (rollout.state !== 'stopped' && rollout.state !== 'paused') {
          throw wifiError(
            409,
            'rollout_not_stopped',
            'Only a stopped or paused rollout is rolled back.'
          )
        }
        const completed = steps.filter((s) => s.state === 'confirmed')
        if (completed.length === 0) {
          throw wifiError(409, 'nothing_to_apply', 'No access point completed this rollout.')
        }
        const targets: RolloutTargets = new Map()
        for (const step of completed) {
          const before = Number(step.outcome?.revisionBefore ?? Number.NaN)
          if (!Number.isFinite(before)) continue
          const perchIds = await restoreRevisionDraft(step.apId, before, options.actor)
          if (perchIds.length > 0) targets.set(step.apId, perchIds)
        }
        rollout.state = 'cancelled'
        rollout.finishedAt = DateTime.utc()
        await rollout.save()
        for (const s of steps) {
          if (s.state === 'pending' || s.state === 'waiting_offline') {
            s.state = 'cancelled'
            await s.save()
          }
        }
        if (targets.size === 0) {
          throw wifiError(409, 'nothing_to_apply', 'Nothing to roll back.')
        }
        return createRollout({
          kind: 'revert',
          actor: options.actor,
          targets,
          networkIds: rollout.networkIds,
          note: `Roll back rollout ${rollout.id}`,
          adminAddress: options.adminAddress,
        })
      }
    }
    await rollout.refresh()
    return rollout
  })
}

/**
 * C := the AP's revision `number` (the core's `planRestore`) for the rows it
 * holds; nothing is sent. Returns the perch ids whose draft changed. Used
 * by "Roll back completed APs", the revision restore and the rejoin offer.
 */
export async function restoreRevisionDraft(
  apId: number,
  number: number,
  actor: PlaneActor | null
): Promise<string[]> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.findOrFail(apId)
    const revision = await ApConfigRevision.query()
      .where('ap_id', apId)
      .where('number', number)
      .first()
    if (!revision) throw wifiError(404, 'revision_not_found', `No revision ${number}.`)
    const loaded = await loadApSections(apId)
    const plan = planRestore(loaded.states, revision.snapshot)
    const conflicted = loaded.states
      .filter((s) => plan.updates.some((u) => u.perchId === s.perchId) && s.conflict)
      .map((s) => s.perchId)
    if (conflicted.length > 0) {
      throw wifiError(409, 'conflicts_open', 'Resolve the conflicts first.', {
        apId,
        perchIds: conflicted,
      })
    }
    if (await hasOpenApApply(apId)) {
      throw wifiError(409, 'apply_in_flight', 'Wait for the running change to finish.')
    }
    const registry = registryFor(ap)
    const authoritative = normalizeApMode(ap.mode) === 'managed' && Boolean(ap.authoritative)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const update of plan.updates) {
      const s = loaded.states.find((x) => x.perchId === update.perchId)!
      const rules = registry.rules(s.domain)
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
      changes.push({
        perchId: entry.perchId,
        after: {
          perchId: entry.perchId,
          config: entry.config,
          name: taken.has(`${entry.config}/${entry.section}`)
            ? `perch_${entry.perchId}`
            : entry.section,
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
    const userId = actorColumns(actor).userId
    await saveApStates(apId, loaded.rows, changes, { userId })
    if (ap.rejoinOffer && ap.rejoinOffer.revision === number) {
      ap.rejoinOffer = null
      await ap.save()
    }
    await recordApEvent(apId, 'revision_restored', {
      actor,
      revision: number,
      detail: { sections: changes.length },
    })
    await refreshApSyncState(ap)
    return changes.map((c) => c.perchId)
  })
}

// ── catch-ups (controller.md 4.6, decision D7) ───────────────────────────

/**
 * The sections an AP missed while offline: those of rollout steps skipped
 * because it was offline, since its last step that went through.
 */
export async function missedSections(apId: number): Promise<string[]> {
  const steps = await WifiRolloutStep.query().where('ap_id', apId).orderBy('id', 'desc').limit(50)
  const missed = new Set<string>()
  for (const step of steps) {
    if (step.state === 'confirmed' || step.state === 'noop') break
    if (step.state === 'skipped' && step.outcome?.reason === 'offline') {
      for (const id of step.perchIds) missed.add(id)
    }
  }
  return [...missed]
}

/**
 * A reconnected AP that missed changes gets a one-AP `catch_up` rollout
 * (confirmed by the agent alone), when no rollout is active; else it waits
 * for the next reconnect or the tick.
 */
export async function catchUpAp(apId: number): Promise<WifiRollout | null> {
  return fleetQueue.run(FLEET, async () => {
    const settings = await getWifiConfigSettings()
    if (settings.catchUpOnReconnect !== 'auto') return null
    if (await activeRollout()) return null
    if (!apSession(apId)) return null
    const missed = await missedSections(apId)
    if (missed.length === 0) return null
    try {
      return await createRollout({
        kind: 'catch_up',
        actor: { system: 'system' },
        targets: new Map([[apId, missed]]),
        note: 'Catch up after being offline',
      })
    } catch (error) {
      if (error instanceof WifiPlaneError && error.code === 'nothing_to_apply') {
        // Nothing left: record a noop step so the AP is not caught up again.
        await WifiRolloutStep.query()
          .where('ap_id', apId)
          .where('state', 'skipped')
          .update({ outcome: JSON.stringify({ reason: 'caught_up' }) })
        return null
      }
      throw error
    }
  })
}

/** Is `value` a rollout step state (the migration's union)? */
export function isStepDone(state: string): boolean {
  return (DONE_STEP_STATES as string[]).includes(state)
}

export type { ConnectedStation }
