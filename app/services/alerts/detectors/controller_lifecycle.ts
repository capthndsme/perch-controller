import { alertNow } from '#services/alerts/clock'
import { detectorState, ruleFor } from '#services/alerts/detector_context'
import { emitAlertEvent } from '#services/alerts/emit'
import { instanceZone } from '#services/alerts/engine'
import type { Severity } from '#services/alerts/model'
import { getAlertsSettings } from '#services/alerts/settings'
import { startHeartbeatPinger, stopHeartbeatPinger } from '#services/alerts/detectors/heartbeat'
import {
  refreshOutOfBand,
  renderDbUnreachable,
  sendOutOfBand,
  setOutOfBandZone,
} from '#services/alerts/detectors/out_of_band'
import { perchVersions } from '#services/perch_version'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'

/**
 * The controller's own lifecycle (WP-A5a, events.md section 3.9), started
 * and stopped by `boot.ts` (web environment only):
 *
 * - a heartbeat (`controller:heartbeat` = `{ at, version, bootId }`) every
 *   60 s, and a shutdown marker (`controller:shutdown` = `{ at, bootId }`)
 *   when the process terminates cleanly;
 * - `controller.started` at boot: clean when the shutdown marker belongs to
 *   the last heartbeat's boot; the downtime is measured from the marker
 *   (clean) or the last heartbeat (unclean); warning when unclean or down for
 *   `downWarnMinutes` or longer;
 * - the database probe: `SELECT 1` (5 s timeout) every 15 s; three failures
 *   in a row are an outage, sent out of band once (`out_of_band.ts`); when the
 *   probe answers again one recovery goes out and the outage is written as
 *   `system.db_unreachable` events;
 * - the heartbeat URL pinger (`heartbeat.ts`).
 */

export const DETECTOR_ID = 'controller'
export const HEARTBEAT_KEY = 'controller:heartbeat'
export const SHUTDOWN_KEY = 'controller:shutdown'
export const HEARTBEAT_EVERY_MS = 60_000
export const PROBE_EVERY_MS = 15_000
export const PROBE_TIMEOUT_MS = 5_000
export const PROBE_FAILURES = 3
/** The out-of-band destination cache is refreshed at most this often while healthy. */
const CACHE_REFRESH_MS = 60_000

export type Heartbeat = { at: string; version: string; bootId: string }
export type ShutdownMarker = { at: string; bootId: string }

export type StartedVerdict = {
  severity: Severity
  payload: {
    version: string
    previousVersion: string | null
    clean: boolean
    downSeconds: number
    lastHeartbeatAt: string
  }
}

/**
 * `controller.started` from what the previous run left behind; null on the
 * very first start (no heartbeat yet: nothing was down).
 */
export function startedVerdict(input: {
  heartbeat: Heartbeat | null
  shutdown: ShutdownMarker | null
  now: DateTime
  version: string
  downWarnMinutes: number
}): StartedVerdict | null {
  const { heartbeat, shutdown } = input
  if (!heartbeat) return null
  const clean = shutdown !== null && shutdown.bootId === heartbeat.bootId
  const from = DateTime.fromISO(clean ? shutdown!.at : heartbeat.at, { zone: 'utc' })
  const downSeconds = from.isValid
    ? Math.max(0, Math.round(input.now.diff(from, 'seconds').seconds))
    : 0
  return {
    severity: clean && downSeconds < input.downWarnMinutes * 60 ? 'info' : 'warning',
    payload: {
      version: input.version,
      previousVersion: heartbeat.version ?? null,
      clean,
      downSeconds,
      lastHeartbeatAt: heartbeat.at,
    },
  }
}

/** What one probe result means: an outage started or ended (with its start). */
export type ProbeStep = { kind: 'outage_started' | 'outage_ended'; since: DateTime } | null

/**
 * The database probe's bookkeeping, free of timers: `record(ok)` after each
 * probe returns what to do. An outage starts at the third failure in a row
 * (dated from the first) and ends at the next success.
 */
export class DbProbeState {
  failures = 0
  firstFailureAt: DateTime | null = null
  outageSince: DateTime | null = null

  record(ok: boolean, now: DateTime): ProbeStep {
    if (ok) {
      const since = this.outageSince
      this.failures = 0
      this.firstFailureAt = null
      this.outageSince = null
      return since ? { kind: 'outage_ended', since } : null
    }
    this.failures += 1
    if (this.failures === 1) this.firstFailureAt = now
    if (this.failures === PROBE_FAILURES && this.outageSince === null) {
      this.outageSince = this.firstFailureAt ?? now
      return { kind: 'outage_started', since: this.outageSince }
    }
    return null
  }
}

type ProbeFn = () => Promise<void>

const defaultProbe: ProbeFn = async () => {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      db.rawQuery('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

let bootId: string | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let probeTimer: NodeJS.Timeout | null = null
let probe: ProbeFn = defaultProbe
let probeState = new DbProbeState()
let lastCacheRefresh = 0
let probing = false

/** Tests only: replace the `SELECT 1` probe (null restores it). */
export function _setDbProbeForTesting(fn: ProbeFn | null): void {
  probe = fn ?? defaultProbe
}

/** Tests only. */
export function _resetControllerLifecycle(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (probeTimer) clearInterval(probeTimer)
  heartbeatTimer = null
  probeTimer = null
  bootId = null
  probe = defaultProbe
  probeState = new DbProbeState()
  lastCacheRefresh = 0
  probing = false
}

async function writeHeartbeat(): Promise<void> {
  if (!bootId) return
  const value: Heartbeat = {
    at: alertNow().toISO()!,
    version: perchVersions().version,
    bootId,
  }
  await detectorState(DETECTOR_ID).set(HEARTBEAT_KEY, value)
}

/** One probe and what follows from it. Exported for tests. */
export async function probeOnce(now: DateTime = alertNow()): Promise<void> {
  if (probing) return
  probing = true
  try {
    let ok = true
    try {
      await probe()
    } catch {
      ok = false
    }
    const step = probeState.record(ok, now)
    if (step?.kind === 'outage_started') {
      logger.error({ since: step.since.toISO() }, 'alerts: database unreachable')
      await sendOutOfBand(renderDbUnreachable('opened', step.since, now))
    } else if (step?.kind === 'outage_ended') {
      const since = step.since
      logger.info({ since: since.toISO() }, 'alerts: database reachable again')
      await sendOutOfBand(renderDbUnreachable('resolved', since, now))
      // The outage is written once the database is back (it was notified out of band).
      emitAlertEvent({
        type: 'system.db_unreachable',
        phase: 'raise',
        subject: { kind: 'controller' },
        severity: 'critical',
        occurredAt: since,
        source: 'controller_lifecycle',
        payload: { since: since.toISO(), until: now.toISO(), outOfBand: true },
      })
      emitAlertEvent({
        type: 'system.db_unreachable',
        phase: 'clear',
        subject: { kind: 'controller' },
        occurredAt: now,
        source: 'controller_lifecycle',
      })
    }
    if (ok && now.toMillis() - lastCacheRefresh >= CACHE_REFRESH_MS) {
      lastCacheRefresh = now.toMillis()
      try {
        setOutOfBandZone(await instanceZone())
      } catch {
        // Keep the last zone.
      }
      await refreshOutOfBand()
    }
  } finally {
    probing = false
  }
}

/** `controller.started` from the previous run's heartbeat and shutdown marker. */
export async function announceStart(now: DateTime = alertNow()): Promise<StartedVerdict | null> {
  const state = detectorState(DETECTOR_ID)
  const [heartbeat, shutdown, settings] = await Promise.all([
    state.get<Heartbeat>(HEARTBEAT_KEY),
    state.get<ShutdownMarker>(SHUTDOWN_KEY),
    getAlertsSettings(),
  ])
  const params = ruleFor('controller.started', settings).params
  const downWarnMinutes =
    typeof params.downWarnMinutes === 'number' && params.downWarnMinutes > 0
      ? params.downWarnMinutes
      : 10
  const verdict = startedVerdict({
    heartbeat,
    shutdown,
    now,
    version: perchVersions().version,
    downWarnMinutes,
  })
  if (verdict && bootId) {
    emitAlertEvent({
      type: 'controller.started',
      phase: 'instant',
      subject: { kind: 'controller' },
      dedupeKey: `controller.started:${bootId}`,
      severity: verdict.severity,
      source: 'controller_lifecycle',
      payload: verdict.payload,
    })
  }
  return verdict
}

export async function startControllerLifecycle(): Promise<void> {
  if (bootId) return
  bootId = randomUUID()
  try {
    await announceStart()
  } catch (err) {
    logger.warn({ err }, 'alerts: controller.started not recorded')
  }
  await writeHeartbeat().catch((err) => logger.warn({ err }, 'alerts: heartbeat not written'))
  heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch((err) => logger.warn({ err }, 'alerts: heartbeat not written'))
  }, HEARTBEAT_EVERY_MS)
  heartbeatTimer.unref()
  probeTimer = setInterval(() => void probeOnce(), PROBE_EVERY_MS)
  probeTimer.unref()
  startHeartbeatPinger()
}

export async function stopControllerLifecycle(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (probeTimer) clearInterval(probeTimer)
  heartbeatTimer = null
  probeTimer = null
  stopHeartbeatPinger()
  if (!bootId) return
  const marker: ShutdownMarker = { at: alertNow().toISO()!, bootId }
  await detectorState(DETECTOR_ID).set(SHUTDOWN_KEY, marker)
  bootId = null
}

/** The current boot's id (null before `startControllerLifecycle`). */
export function currentBootId(): string | null {
  return bootId
}
