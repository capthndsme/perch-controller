import { _setEmitCapture } from '#services/alerts/emit'
import type { ConditionInput, EmitInput } from '#services/alerts/model'

/**
 * Test side of the alerts event API (docs/design/alerts/README.md §11.2),
 * for every area's tests.
 *
 * `captureAlertEvents()` makes `emitAlertEvent` and `reconcileConditions`
 * record into memory instead of queuing for the engine, so a test can assert
 * what its code emitted without running the engine. An emit with `trx` is
 * recorded only when that transaction commits (never after a rollback), like
 * the real queue. Always `restore()` (Japa: `cleanup(() => capture.restore())`).
 *
 *   const alerts = captureAlertEvents()
 *   cleanup(() => alerts.restore())
 *   await applySomething()
 *   assert.deepEqual(alerts.types(), ['wifi.apply_rolled_back'])
 */
export type AlertCapture = {
  /** Every emit, in order. */
  readonly emits: EmitInput[]
  /** Every `reconcileConditions` call, in order. */
  readonly reconciles: Array<{ types: string[]; current: ConditionInput[]; scope?: string }>
  /** Type names of the emits, in order. */
  types(): string[]
  /** Emits of one type. */
  ofType(type: string): EmitInput[]
  /** Forget what was recorded so far (keeps capturing). */
  clear(): void
  /** Stop capturing: emits go to the engine queue again. */
  restore(): void
}

export function captureAlertEvents(): AlertCapture {
  const record = {
    emits: [] as EmitInput[],
    reconciles: [] as Array<{ types: string[]; current: ConditionInput[]; scope?: string }>,
  }
  _setEmitCapture(record)
  return {
    get emits() {
      return record.emits
    },
    get reconciles() {
      return record.reconciles
    },
    types: () => record.emits.map((e) => e.type),
    ofType: (type) => record.emits.filter((e) => e.type === type),
    clear() {
      record.emits.length = 0
      record.reconciles.length = 0
    },
    restore() {
      _setEmitCapture(null)
    },
  }
}
