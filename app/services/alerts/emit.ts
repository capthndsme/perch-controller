import type { AlertSubject, ConditionInput, EmitInput } from '#services/alerts/model'
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
 * other areas import to raise, clear and post alerts.
 *
 * DAY-1 VERSION: a working no-op with the final signatures. Emits are
 * dropped (or recorded by `captureAlertEvents()` in tests) until the engine
 * lands in WP-A1; nothing here ever throws or waits on delivery.
 */

type Capture = {
  emits: EmitInput[]
  reconciles: Array<{ types: string[]; current: ConditionInput[]; scope?: string }>
}
let capture: Capture | null = null

/**
 * Raises, clears or posts one event. Never throws, never waits: the event is
 * queued (after the transaction commits when `trx` is given) and processed
 * by the engine's single worker.
 */
export function emitAlertEvent(input: EmitInput): void {
  try {
    if (capture) {
      if (input.trx) {
        const record = capture
        input.trx.after('commit', () => {
          record.emits.push({ ...input, trx: undefined })
        })
        return
      }
      capture.emits.push(input)
    }
  } catch {
    // Never throws.
  }
}

/**
 * Level-triggered form for detectors: `current` is the full set of keys that
 * hold right now for `types`. Keys not currently active are raised, active
 * keys missing from `current` are cleared, the rest are left alone (no event
 * rows for "still true"). A higher severity on a held key escalates.
 * `scope` restricts clears to keys starting with that prefix.
 */
export async function reconcileConditions(
  types: string[],
  current: ConditionInput[],
  options?: { scope?: string }
): Promise<void> {
  if (capture) capture.reconciles.push({ types, current, scope: options?.scope })
}

/** Maintenance window: alerts matching it are recorded but not sent. Returns the mute id. */
export async function suppressAlerts(_input: {
  subject?: AlertSubject
  types?: string[]
  until: DateTime
  source: string
  note?: string
}): Promise<number> {
  return 0
}

export async function endSuppression(_muteId: number): Promise<void> {}

/** Tests only (`tests/helpers/alerts.ts`): record emits in memory instead of queuing them. */
export function _setEmitCapture(next: Capture | null): void {
  capture = next
}
