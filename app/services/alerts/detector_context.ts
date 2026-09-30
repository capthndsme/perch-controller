import { getAlertType } from '#services/alerts/catalogue/index'
import { alertNow, sqlTime } from '#services/alerts/clock'
import { emitAlertEvent, reconcileConditions } from '#services/alerts/emit'
import { isInBootGrace } from '#services/alerts/engine'
import type {
  AlertsSettings,
  DetectorContext,
  DetectorDef,
  DetectorState,
  Rule,
} from '#services/alerts/model'
import { listDetectors } from '#services/alerts/registry'
import { baseRule, effectiveRule, getAlertsSettings } from '#services/alerts/settings'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

/**
 * What a detector gets (events.md §1.5), and the loop that runs the due
 * detectors one after the other (for `app/tasks/alerts_evaluate.task.ts`).
 */

/** `alert_detector_states`, scoped to one detector. Values are JSON. */
export function detectorState(detector: string): DetectorState {
  return {
    async get<T>(key: string): Promise<T | null> {
      const row = await db
        .from('alert_detector_states')
        .where('detector', detector)
        .where('state_key', key)
        .select('value')
        .first()
      if (!row) return null
      try {
        return JSON.parse(row.value) as T
      } catch {
        return null
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      const json = JSON.stringify(value ?? null)
      await db.rawQuery(
        'INSERT INTO alert_detector_states (detector, state_key, value, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
        [detector, key.slice(0, 191), json, sqlTime(alertNow())]
      )
    },
    async delete(key: string): Promise<void> {
      await db
        .from('alert_detector_states')
        .where('detector', detector)
        .where('state_key', key)
        .delete()
    },
  }
}

/** The effective rule of a type; an unknown type reads as a disabled condition. */
export function ruleFor(type: string, settings: AlertsSettings): Rule {
  const def = getAlertType(type)
  if (!def) return { ...baseRule('condition'), enabled: false }
  return effectiveRule(def, settings)
}

export async function createDetectorContext(
  detectorId: string,
  options: { now?: DateTime; settings?: AlertsSettings } = {}
): Promise<DetectorContext> {
  const now = options.now ?? alertNow()
  const settings = options.settings ?? (await getAlertsSettings())
  return {
    now,
    settings,
    rule: (type) => ruleFor(type, settings),
    inBootGrace: isInBootGrace(settings, now),
    state: detectorState(detectorId),
    reconcile: reconcileConditions,
    emit: emitAlertEvent,
  }
}

const lastRun = new Map<string, number>()

/** Tests only. */
export function _resetDetectorSchedule(): void {
  lastRun.clear()
}

function isDue(d: DetectorDef, now: DateTime): boolean {
  const last = lastRun.get(d.id)
  // A little slack so a 15 s task tick does not skip a 60 s detector by one tick.
  return last === undefined || now.toMillis() - last >= d.everySeconds * 1000 - 2000
}

/**
 * Runs every registered detector whose period is due, one after the other,
 * each in its own try/catch (a failing detector logs and costs only itself).
 * A detector whose declared types are all disabled is skipped. Returns the
 * ids that ran.
 */
export async function runDueDetectors(
  options: { now?: DateTime; force?: boolean } = {}
): Promise<string[]> {
  const now = options.now ?? alertNow()
  const settings = await getAlertsSettings()
  const ran: string[] = []
  for (const detector of listDetectors()) {
    if (!options.force && !isDue(detector, now)) continue
    if (detector.types && detector.types.length > 0) {
      if (!detector.types.some((t) => ruleFor(t, settings).enabled)) continue
    }
    lastRun.set(detector.id, now.toMillis())
    try {
      await detector.run(await createDetectorContext(detector.id, { now, settings }))
      ran.push(detector.id)
    } catch (error) {
      logger.error({ err: error, detector: detector.id }, 'alerts: detector failed')
    }
  }
  return ran
}
