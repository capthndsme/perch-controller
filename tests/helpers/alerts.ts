import { _clearTestAlertTypes } from '#services/alerts/catalogue/index'
import { _setAlertClock } from '#services/alerts/clock'
import { _setEmitCapture } from '#services/alerts/emit'
import {
  _resetAlertEngine,
  _setAlertNotifier,
  _setEngineBootedAt,
  type AlertNotifier,
} from '#services/alerts/engine'
import type { ConditionInput, EmitInput, Transition } from '#services/alerts/model'
import { _resetSubjectLabels } from '#services/alerts/subjects'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient, ApiRequest } from '@japa/api-client'

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

/* ------------------------------------------------------------------ */
/* Engine tests (alerts area)                                          */
/* ------------------------------------------------------------------ */

export type NotifyCall = {
  alertId: number
  type: string
  transition: Transition
  flapEnded: boolean
  state: string
  severity: string
}

/**
 * A notifier that records what the engine asked to send and pretends one
 * destination took it (so `notified` is set like with a real destination).
 * `destinations: 0` behaves like an install without any.
 */
export function recordingNotifier(options: { destinations?: number } = {}) {
  const calls: NotifyCall[] = []
  const collapsed: number[] = []
  const ticks: number[] = []
  const notifier: AlertNotifier = {
    async notify(request) {
      calls.push({
        alertId: Number(request.alert.id),
        type: request.alert.type,
        transition: request.transition,
        flapEnded: request.flapEnded,
        state: request.alert.state,
        severity: request.alert.severity,
      })
      return options.destinations ?? 1
    },
    async collapse(alertId) {
      collapsed.push(Number(alertId))
    },
    async tick(now) {
      ticks.push(now.toMillis())
    },
  }
  return {
    notifier,
    calls,
    collapsed,
    ticks,
    transitions: () => calls.map((c) => c.transition),
    clear() {
      calls.length = 0
      collapsed.length = 0
      ticks.length = 0
    },
  }
}

/** Forgets the engine's queue and in-memory state between tests. */
export async function resetAlertEngineState(): Promise<void> {
  await _resetAlertEngine()
  _setEngineBootedAt(null)
  _setAlertNotifier(null)
  _resetSubjectLabels()
  _clearTestAlertTypes()
  _setAlertClock(null)
}

/**
 * Empties every table of the test database without running `migration:run`
 * first (`testUtils.db().truncate()` does, and takes MariaDB's server-wide
 * advisory lock "1" each time, which collides with other test runs on the
 * same server). One connection, foreign key checks off for the duration.
 */
export async function truncateAllTables(): Promise<void> {
  await db.transaction(async (trx) => {
    const [[current]] = (await trx.rawQuery('SELECT DATABASE() AS d')) as [Array<{ d: string }>]
    if (!/_test$/.test(String(current?.d))) throw new Error(`refusing to truncate "${current?.d}"`)
    const [rows] = (await trx.rawQuery(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'adonis_schema%'"
    )) as [Array<{ t: string }>]
    await trx.rawQuery('SET FOREIGN_KEY_CHECKS = 0')
    try {
      for (const row of rows) await trx.rawQuery(`TRUNCATE TABLE \`${row.t}\``)
    } finally {
      await trx.rawQuery('SET FOREIGN_KEY_CHECKS = 1')
    }
  })
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

/**
 * The test client, untyped. The typed client (`RoutesRegistry`) infers bodies
 * and responses from the route pattern; instantiating it with non-literal
 * paths (`/api/v1/alerts/${id}`) unions every route's types, and that union,
 * checked early, turns other suites' `call(client, method, path).json(...)`
 * helpers into `never`. Alerts specs call through this instead.
 */
export function apiLoose(client: ApiClient): Record<HttpMethod, (path: string) => ApiRequest> {
  return client as unknown as Record<HttpMethod, (path: string) => ApiRequest>
}
