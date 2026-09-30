import AlertMute from '#models/alert_mute'
import {
  enqueueEvent,
  enqueueReconcile,
  normalizeConditions,
  normalizeEmit,
  releaseMutedAlerts,
} from '#services/alerts/engine'
import type { AlertSubject, ConditionInput, EmitInput } from '#services/alerts/model'
import { createMute } from '#services/alerts/mutes'
import { validSubject } from '#services/alerts/subjects'
import logger from '@adonisjs/core/services/logger'
import type { DateTime } from 'luxon'

export type {
  AlertSubject,
  Category,
  ConditionInput,
  EmitInput,
  Severity,
} from '#services/alerts/model'

/**
 * The alerts event API (docs/design/alerts/README.md §2.2): the only module
 * other areas import to raise, clear and post alerts. Nothing here ever
 * throws or waits on delivery; the engine (`engine.ts`) processes the queue
 * on its single worker.
 */

type Capture = {
  emits: EmitInput[]
  reconciles: Array<{ types: string[]; current: ConditionInput[]; scope?: string }>
}
let capture: Capture | null = null

/**
 * Raises, clears or posts one event. Never throws, never waits: the event is
 * queued (after the transaction commits when `trx` is given, never after a
 * rollback) and processed by the engine's single worker. Unknown types are
 * logged and dropped by the engine.
 */
export function emitAlertEvent(input: EmitInput): void {
  try {
    if (capture) {
      const record = capture
      if (input.trx) {
        input.trx.after('commit', () => {
          record.emits.push({ ...input, trx: undefined })
        })
        return
      }
      record.emits.push(input)
      return
    }
    const event = normalizeEmit(input)
    if (!event) return
    if (input.trx) {
      input.trx.after('commit', () => enqueueEvent(event))
      return
    }
    enqueueEvent(event)
  } catch (error) {
    logger.warn({ err: error, type: input?.type }, 'alerts: emit failed')
  }
}

/**
 * Level-triggered form for detectors: `current` is the full set of keys that
 * hold right now for `types`. Keys not currently active are raised, active
 * keys missing from `current` are cleared, the rest are left alone (no event
 * rows for "still true"). A higher severity on a held key escalates.
 * `scope` restricts clears to keys starting with that prefix (one gateway,
 * one AP…). Resolves when the engine has processed it; never rejects.
 */
export async function reconcileConditions(
  types: string[],
  current: ConditionInput[],
  options?: { scope?: string }
): Promise<void> {
  try {
    if (capture) {
      capture.reconciles.push({ types, current, scope: options?.scope })
      return
    }
    await enqueueReconcile(types, normalizeConditions(current), options?.scope)
  } catch (error) {
    logger.error({ err: error, types }, 'alerts: reconcile failed')
  }
}

/**
 * Maintenance window for other areas (agent updates, applies that restart
 * things): alerts matching it are still recorded but notify nobody. One mute
 * row per type (or one for the subject alone). Returns the mute id to pass to
 * `endSuppression`, or 0 when nothing was created (logged). Never rejects.
 */
export async function suppressAlerts(input: {
  subject?: AlertSubject
  types?: string[]
  until: DateTime
  source: string
  note?: string
}): Promise<number> {
  try {
    const subject = input.subject && validSubject(input.subject) ? input.subject : null
    const types = (input.types ?? []).filter((t) => typeof t === 'string' && t !== '')
    if (!subject && types.length === 0) {
      logger.warn({ source: input.source }, 'alerts: suppressAlerts needs a subject or types')
      return 0
    }
    let first = 0
    for (const type of types.length > 0 ? types : [null]) {
      const mute = await createMute({
        type,
        subject,
        until: input.until,
        reason: 'maintenance',
        source: input.source,
        note: input.note ?? null,
      })
      if (first === 0) first = mute.id
      // Rows of one call share `source`, `until` and `created_at`: `endSuppression` ends them together.
      if (mute.id !== first) {
        const head = await AlertMute.find(first)
        if (head && +head.createdAt !== +mute.createdAt) {
          mute.createdAt = head.createdAt
          await mute.save()
        }
      }
    }
    return first
  } catch (error) {
    logger.error({ err: error, source: input.source }, 'alerts: suppressAlerts failed')
    return 0
  }
}

/**
 * Ends a maintenance window early (the operation finished). Alerts it kept
 * silent that are still active notify now. Never rejects.
 */
export async function endSuppression(muteId: number): Promise<void> {
  try {
    if (!muteId) return
    const head = await AlertMute.find(muteId)
    if (!head) return
    const rows =
      head.reason === 'maintenance'
        ? await AlertMute.query()
            .where('reason', 'maintenance')
            .where((q) =>
              head.source === null ? q.whereNull('source') : q.where('source', head.source)
            )
            .where('created_at', head.createdAt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'))
            .where('id', '>=', head.id)
            .where('id', '<', head.id + 64)
        : [head]
    const ended = rows.map((m) => ({
      type: m.type,
      subjectKind: m.subjectKind,
      subjectRef: m.subjectRef,
    }))
    for (const row of rows) await row.delete()
    await releaseMutedAlerts(ended)
  } catch (error) {
    logger.error({ err: error, muteId }, 'alerts: endSuppression failed')
  }
}

/** Tests only (`tests/helpers/alerts.ts`): record emits in memory instead of queuing them. */
export function _setEmitCapture(next: Capture | null): void {
  capture = next
}
