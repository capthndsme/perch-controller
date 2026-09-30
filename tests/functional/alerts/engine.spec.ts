import Alert from '#models/alert'
import AlertEvent from '#models/alert_event'
import AlertMute from '#models/alert_mute'
import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _registerTestAlertType } from '#services/alerts/catalogue/index'
import { fakeAlertClock } from '#services/alerts/clock'
import {
  emitAlertEvent,
  endSuppression,
  reconcileConditions,
  suppressAlerts,
} from '#services/alerts/emit'
import {
  _pauseAlertEngine,
  _queuedEvents,
  _setAlertNotifier,
  _setEngineBootedAt,
  acknowledgeAlert,
  engineStats,
  flushAlertQueue,
  onManualResolve,
  QUEUE_MAX,
  resolveAlertManually,
  resolveTypeQuietly,
  runAlertTick,
} from '#services/alerts/engine'
import type { AlertTypeDef, EmitInput } from '#services/alerts/model'
import { createMute } from '#services/alerts/mutes'
import { conditionRender } from '#services/alerts/render'
import { recordingNotifier, resetAlertEngineState, truncateAllTables } from '#tests/helpers/alerts'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

/**
 * WP-A1 acceptance (docs/design/alerts/README.md §2.3, §9): every row of the
 * state-machine table, hold promotion, blips, flap damping, reopen inside the
 * recovery hold, escalation, notice dedupe, mutes, boot grace, withholding,
 * reconcile, transactions, unknown types and the queue bound. Fake clock,
 * recording notifier; nothing is sent.
 */

const T0 = '2026-10-01T06:00:00Z'

function cond(
  type: string,
  defaults: AlertTypeDef['defaults'] = {},
  extra: Partial<AlertTypeDef> = {}
): AlertTypeDef {
  return {
    type,
    category: 'system',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller', 'ap', 'collector'],
    owner: 'alerts',
    label: `Test ${type}`,
    description: 'test type',
    defaults,
    render: conditionRender({
      state: 'down',
      opened: (a) => ({ title: `${a.label} is down`, body: 'down' }),
      resolved: (a) => ({ title: `${a.label} is back`, body: 'back' }),
    }),
    ...extra,
  }
}

const HELD = cond('test.held', { holdSeconds: 60, recoveryHoldSeconds: 30 })
const NOW = cond('test.now', { holdSeconds: 0, recoveryHoldSeconds: 30 })
const NOREC = cond('test.norec', { holdSeconds: 0, notifyRecovery: false })
const REMIND = cond('test.remind', { holdSeconds: 0, repeatMinutes: 15 })
const BOOT = cond('test.boot', { holdSeconds: 0 }, { bootGrace: true })
const WITHHELD = cond('test.withheld', { holdSeconds: 0 }, { withheldBy: ['test.now'] })
const NOTICE: AlertTypeDef = {
  type: 'test.notice',
  category: 'system',
  kind: 'notice',
  severity: 'info',
  subjects: ['controller', 'ap'],
  owner: 'alerts',
  label: 'Test notice',
  description: 'test notice',
  defaults: { dedupeMinutes: 60 },
  render: (a) => ({ title: `Notice on ${a.label}`, body: 'happened' }),
}

const AP4 = { kind: 'ap', id: 4 } as const
const AP5 = { kind: 'ap', id: 5 } as const

function emit(input: Omit<EmitInput, 'subject'> & { subject?: EmitInput['subject'] }) {
  emitAlertEvent({ subject: AP4, ...input } as EmitInput)
  return flushAlertQueue()
}

async function tick() {
  await runAlertTick()
  await flushAlertQueue()
}

async function latest(key: string) {
  return Alert.query().where('dedupe_key', key).orderBy('id', 'desc').firstOrFail()
}

async function prop<K extends keyof Alert>(key: string, name: K): Promise<Alert[K]> {
  const alert = await latest(key)
  return alert[name]
}

async function adminId(): Promise<number> {
  const user = await seedUser()
  return user.id
}

async function outcomes(key?: string) {
  const q = AlertEvent.query().orderBy('id', 'asc')
  if (key) q.where('dedupe_key', key)
  const rows = await q
  return rows.map((e) => e.outcome)
}

test.group('alerts engine: conditions', (group) => {
  let clock: ReturnType<typeof fakeAlertClock>
  let rec: ReturnType<typeof recordingNotifier>

  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    clock = fakeAlertClock(T0)
    rec = recordingNotifier()
    _setAlertNotifier(rec.notifier)
    for (const def of [HELD, NOW, NOREC, REMIND, BOOT, WITHHELD, NOTICE]) {
      _registerTestAlertType(def)
    }
    return () => resetAlertEngineState()
  })

  test('raise holds as pending, the tick promotes it after the hold and notifies opened', async ({
    assert,
  }) => {
    await emit({ type: 'test.held' })
    let alert = await latest('test.held:ap:4')
    assert.equal(alert.state, 'pending')
    assert.equal(alert.activeKey, 'test.held:ap:4')
    assert.deepEqual(rec.transitions(), [])

    clock.advance({ seconds: 59 })
    await tick()
    assert.equal(await prop('test.held:ap:4', 'state'), 'pending')

    clock.advance({ seconds: 1 })
    await tick()
    alert = await latest('test.held:ap:4')
    assert.equal(alert.state, 'active')
    assert.isTrue(alert.notified)
    assert.equal(alert.openedAt!.toMillis(), clock.now().toMillis())
    assert.deepEqual(rec.transitions(), ['opened'])
    assert.deepEqual(await outcomes(), ['opened'])
  })

  test('hold 0 activates at once and notifies opened', async ({ assert }) => {
    await emit({ type: 'test.now' })
    const alert = await latest('test.now:ap:4')
    assert.equal(alert.state, 'active')
    assert.deepEqual(rec.transitions(), ['opened'])
  })

  test('pending + raise updates; severity only rises', async ({ assert }) => {
    await emit({ type: 'test.held', severity: 'warning' })
    await emit({ type: 'test.held', severity: 'critical' })
    await emit({ type: 'test.held', severity: 'info' })
    const alert = await latest('test.held:ap:4')
    assert.equal(alert.state, 'pending')
    assert.equal(alert.severity, 'critical')
    assert.equal(alert.eventCount, 3)
    assert.deepEqual(await outcomes(), ['opened', 'updated', 'updated'])
    assert.deepEqual(rec.transitions(), [])
    assert.equal(
      await Alert.query()
        .count('* as n')
        .first()
        .then((r) => Number(r!.$extras.n)),
      1
    )
  })

  test('pending + clear is a blip: resolved quietly, never notified', async ({ assert }) => {
    await emit({ type: 'test.held' })
    clock.advance({ seconds: 20 })
    await emit({ type: 'test.held', phase: 'clear' })
    const alert = await latest('test.held:ap:4')
    assert.equal(alert.state, 'resolved')
    assert.isTrue(alert.quietResolve)
    assert.isNull(alert.activeKey)
    clock.advance({ minutes: 5 })
    await tick()
    assert.deepEqual(rec.transitions(), [])
    assert.deepEqual(await outcomes(), ['opened', 'blip'])
  })

  test('active + raise with a higher severity escalates; acknowledged alerts do not', async ({
    assert,
  }) => {
    await emit({ type: 'test.now', severity: 'info' })
    await emit({ type: 'test.now', severity: 'warning' })
    const alert = await latest('test.now:ap:4')
    assert.equal(alert.severity, 'warning')
    assert.deepEqual(rec.transitions(), ['opened', 'escalated'])

    await acknowledgeAlert(alert.id, await adminId(), 'on it')
    await emit({ type: 'test.now', severity: 'critical' })
    assert.equal(await prop('test.now:ap:4', 'severity'), 'critical')
    assert.deepEqual(rec.transitions(), ['opened', 'escalated'])
    assert.deepEqual(await outcomes(), ['opened', 'escalated', 'escalated'])
  })

  test('active + clear resolves; the recovery goes out after the recovery hold', async ({
    assert,
  }) => {
    await emit({ type: 'test.now' })
    clock.advance({ minutes: 7 })
    await emit({ type: 'test.now', phase: 'clear' })
    let alert = await latest('test.now:ap:4')
    assert.equal(alert.state, 'resolved')
    assert.isFalse(alert.quietResolve)
    assert.isNotNull(alert.recoveryDueAt)

    clock.advance({ seconds: 29 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened'])

    clock.advance({ seconds: 1 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened', 'resolved'])
    alert = await latest('test.now:ap:4')
    assert.isNull(alert.recoveryDueAt)
    assert.deepEqual(await outcomes(), ['opened', 'resolved'])
  })

  test('a raise inside the recovery hold reopens silently and cancels the recovery', async ({
    assert,
  }) => {
    await emit({ type: 'test.now' })
    const first = await latest('test.now:ap:4')
    clock.advance({ minutes: 2 })
    await emit({ type: 'test.now', phase: 'clear' })
    clock.advance({ seconds: 10 })
    await emit({ type: 'test.now' })

    const alert = await latest('test.now:ap:4')
    assert.equal(alert.id, first.id)
    assert.equal(alert.state, 'active')
    assert.isNull(alert.recoveryDueAt)
    clock.advance({ minutes: 5 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened'])
    assert.deepEqual(await outcomes(), ['opened', 'resolved', 'reopened'])
  })

  test('a raise after a resolve inside the flap window reopens the same alert', async ({
    assert,
  }) => {
    await emit({ type: 'test.now' })
    await emit({ type: 'test.now', phase: 'clear' })
    clock.advance({ minutes: 2 })
    await tick() // recovery sent
    clock.advance({ minutes: 10 })
    await emit({ type: 'test.now' })
    const alerts = await Alert.query().where('dedupe_key', 'test.now:ap:4')
    assert.lengthOf(alerts, 1)
    assert.equal(alerts[0].transitions, 1)
    assert.equal(alerts[0].state, 'active')
    assert.deepEqual(rec.transitions(), ['opened', 'resolved', 'opened'])

    // Outside the window: a new alert.
    await emit({ type: 'test.now', phase: 'clear' })
    clock.advance({ minutes: 31 })
    await tick()
    await emit({ type: 'test.now' })
    assert.lengthOf(await Alert.query().where('dedupe_key', 'test.now:ap:4'), 2)
  })

  test('flapping: one notice at the threshold, silence, then "stable" a window later', async ({
    assert,
  }) => {
    // A link that bounces every 20 s with a 60 s hold.
    for (let i = 0; i < 4; i++) {
      await emit({ type: 'test.held' })
      clock.advance({ seconds: 20 })
      await tick()
      await emit({ type: 'test.held', phase: 'clear' })
      clock.advance({ seconds: 20 })
      await tick()
    }
    const alert = await latest('test.held:ap:4')
    assert.isTrue(alert.flapping)
    assert.equal(alert.transitions, 3)
    assert.lengthOf(await Alert.query().where('dedupe_key', 'test.held:ap:4'), 1)
    assert.deepEqual(rec.transitions(), ['flapping'])
    assert.equal(alert.state, 'resolved')
    assert.isFalse(alert.quietResolve, 'a flapping alert stays visible')

    clock.advance({ minutes: 29 })
    await tick()
    assert.deepEqual(rec.transitions(), ['flapping'])
    clock.advance({ minutes: 1 })
    await tick()
    assert.deepEqual(rec.transitions(), ['flapping', 'resolved'])
    assert.isTrue(rec.calls[1].flapEnded)
    assert.isFalse(await prop('test.held:ap:4', 'flapping'))
  })

  test('flapping that ends while the condition holds says it is still down', async ({ assert }) => {
    for (let i = 0; i < 3; i++) {
      await emit({ type: 'test.held' })
      clock.advance({ seconds: 20 })
      await emit({ type: 'test.held', phase: 'clear' })
      clock.advance({ seconds: 20 })
    }
    await emit({ type: 'test.held' }) // third reopen: flapping, pending
    assert.deepEqual(rec.transitions(), ['flapping'])
    clock.advance({ seconds: 61 })
    await tick() // promoted silently
    assert.equal(await prop('test.held:ap:4', 'state'), 'active')
    assert.deepEqual(rec.transitions(), ['flapping'])
    clock.advance({ minutes: 30 })
    await tick()
    assert.deepEqual(rec.transitions(), ['flapping', 'opened'])
    assert.isTrue(rec.calls[1].flapEnded)
  })

  test('without notifyRecovery a resolve collapses the unsent deliveries', async ({ assert }) => {
    await emit({ type: 'test.norec' })
    await emit({ type: 'test.norec', phase: 'clear' })
    const alert = await latest('test.norec:ap:4')
    assert.deepEqual(rec.transitions(), ['opened'])
    assert.deepEqual(rec.collapsed, [alert.id])
  })

  test('clear without a live alert is recorded as no_active', async ({ assert }) => {
    await emit({ type: 'test.now', phase: 'clear' })
    assert.deepEqual(await outcomes(), ['no_active'])
    assert.equal(await countAlerts(), 0)
  })

  test('reminders repeat until acknowledged', async ({ assert }) => {
    await emit({ type: 'test.remind' })
    clock.advance({ minutes: 14 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened'])
    clock.advance({ minutes: 1 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened', 'reminder'])
    const alert = await latest('test.remind:ap:4')
    await acknowledgeAlert(alert.id, await adminId())
    clock.advance({ minutes: 30 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened', 'reminder'])
  })

  test('manual resolve sends no recovery, runs the hook, and the next raise opens a new alert', async ({
    assert,
  }) => {
    const seen: number[] = []
    onManualResolve('test.now', async (a) => {
      seen.push(a.id)
    })
    await emit({ type: 'test.now' })
    const first = await latest('test.now:ap:4')
    await resolveAlertManually(first.id, await adminId(), 'fixed')
    const resolved = await Alert.findOrFail(first.id)
    assert.equal(resolved.state, 'resolved')
    assert.isNotNull(resolved.resolvedByUserId)
    assert.deepEqual(seen, [first.id])
    assert.deepEqual(rec.collapsed, [first.id])

    await emit({ type: 'test.now' })
    const second = await latest('test.now:ap:4')
    assert.notEqual(second.id, first.id)
    assert.deepEqual(rec.transitions(), ['opened', 'opened'])
  })

  test('resolveTypeQuietly resolves live alerts without recovery notices', async ({ assert }) => {
    await emit({ type: 'test.now' })
    await emit({ type: 'test.now', subject: AP5 })
    assert.equal(await resolveTypeQuietly(['test.now']), 2)
    clock.advance({ minutes: 5 })
    await tick()
    assert.deepEqual(rec.transitions(), ['opened', 'opened'])
    assert.equal(
      await Alert.query()
        .whereNotNull('active_key')
        .count('* as n')
        .first()
        .then((r) => Number(r!.$extras.n)),
      0
    )
  })
})

test.group('alerts engine: notices, mutes, grace, reconcile', (group) => {
  let clock: ReturnType<typeof fakeAlertClock>
  let rec: ReturnType<typeof recordingNotifier>

  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    clock = fakeAlertClock(T0)
    rec = recordingNotifier()
    _setAlertNotifier(rec.notifier)
    for (const def of [HELD, NOW, BOOT, WITHHELD, NOTICE]) _registerTestAlertType(def)
    return () => resetAlertEngineState()
  })

  test('notices post and notify; the same key within dedupeMinutes merges', async ({ assert }) => {
    await emit({ type: 'test.notice' })
    clock.advance({ minutes: 10 })
    await emit({ type: 'test.notice' })
    let alerts = await Alert.query().where('type', 'test.notice')
    assert.lengthOf(alerts, 1)
    assert.equal(alerts[0].state, 'posted')
    assert.equal(alerts[0].eventCount, 2)
    assert.isNull(alerts[0].activeKey)
    assert.deepEqual(rec.transitions(), ['opened'])

    clock.advance({ minutes: 51 })
    await emit({ type: 'test.notice' })
    alerts = await Alert.query().where('type', 'test.notice')
    assert.lengthOf(alerts, 2)
    assert.deepEqual(rec.transitions(), ['opened', 'opened'])
    assert.deepEqual(await outcomes(), ['posted', 'merged', 'posted'])
  })

  test('a type mute marks the alert muted and sends nothing', async ({ assert }) => {
    await createMute({ type: 'test.now' })
    await emit({ type: 'test.now' })
    const alert = await latest('test.now:ap:4')
    assert.isTrue(alert.muted)
    assert.isFalse(alert.notified)
    assert.deepEqual(rec.transitions(), [])
  })

  test('a subject mute matches only that subject; an expired mute matches nothing', async ({
    assert,
  }) => {
    await createMute({ subject: AP4 })
    await createMute({ type: 'test.now', until: clock.now().minus({ minutes: 1 }) })
    await emit({ type: 'test.now', subject: AP4 })
    await emit({ type: 'test.now', subject: AP5 })
    assert.isTrue(await prop('test.now:ap:4', 'muted'))
    assert.isFalse(await prop('test.now:ap:5', 'muted'))
    assert.deepEqual(rec.transitions(), ['opened'])
    assert.equal(rec.calls[0].alertId, await prop('test.now:ap:5', 'id'))
  })

  test('suppressAlerts records but sends nothing; endSuppression lets a still-active alert notify', async ({
    assert,
  }) => {
    const id = await suppressAlerts({
      types: ['test.now', 'test.held'],
      subject: AP4,
      until: clock.now().plus({ hours: 1 }),
      source: 'agent_update:17',
    })
    assert.isAbove(id, 0)
    assert.equal(
      await AlertMute.query()
        .count('* as n')
        .first()
        .then((r) => Number(r!.$extras.n)),
      2
    )
    await emit({ type: 'test.now' })
    assert.isTrue(await prop('test.now:ap:4', 'muted'))
    assert.deepEqual(rec.transitions(), [])

    await endSuppression(id)
    await flushAlertQueue()
    assert.equal(
      await AlertMute.query()
        .count('* as n')
        .first()
        .then((r) => Number(r!.$extras.n)),
      0
    )
    assert.deepEqual(rec.transitions(), ['opened'])
    assert.isFalse(await prop('test.now:ap:4', 'muted'))
  })

  test('boot grace: no new agent-silence alert, clears pass, repeats are logged once', async ({
    assert,
  }) => {
    await emit({ type: 'test.boot', subject: AP5 }) // exists before the restart
    _setEngineBootedAt(clock.now())
    await reconcileConditions('test.boot'.split(' '), [
      { type: 'test.boot', subject: AP4, dedupeKey: 'test.boot:ap:4' },
      { type: 'test.boot', subject: AP5, dedupeKey: 'test.boot:ap:5' },
    ])
    await reconcileConditions(
      ['test.boot'],
      [{ type: 'test.boot', subject: AP4, dedupeKey: 'test.boot:ap:4' }]
    )
    assert.deepEqual(await outcomes('test.boot:ap:4'), ['boot_grace'])
    assert.deepEqual(await outcomes('test.boot:ap:5'), ['opened', 'resolved'])
    assert.lengthOf(await Alert.query().where('dedupe_key', 'test.boot:ap:4'), 0)

    clock.advance({ seconds: 121 })
    await reconcileConditions(
      ['test.boot'],
      [{ type: 'test.boot', subject: AP4, dedupeKey: 'test.boot:ap:4' }]
    )
    assert.deepEqual(await outcomes('test.boot:ap:4'), ['boot_grace', 'opened'])
  })

  test('withheldBy: no new alert while a withholding alert is live', async ({ assert }) => {
    await emit({ type: 'test.now', subject: AP5 })
    await emit({ type: 'test.withheld' })
    assert.deepEqual(await outcomes('test.withheld:ap:4'), ['withheld_mass'])
    await emit({ type: 'test.now', subject: AP5, phase: 'clear' })
    await emit({ type: 'test.withheld' })
    assert.deepEqual(await outcomes('test.withheld:ap:4'), ['withheld_mass', 'opened'])
  })

  test('reconcile raises new keys, clears missing ones, leaves held ones alone, escalates', async ({
    assert,
  }) => {
    const k = (id: number) => ({
      type: 'test.now',
      subject: { kind: 'ap', id } as const,
      dedupeKey: `test.now:ap:${id}`,
    })
    await reconcileConditions(['test.now'], [k(1), k(2)])
    assert.deepEqual(rec.transitions(), ['opened', 'opened'])

    await reconcileConditions(['test.now'], [k(1)])
    assert.equal(await prop('test.now:ap:2', 'state'), 'resolved')
    assert.deepEqual(await outcomes('test.now:ap:1'), ['opened'], 'no event row for "still true"')

    await reconcileConditions(['test.now'], [{ ...k(1), severity: 'critical' }])
    assert.equal(await prop('test.now:ap:1', 'severity'), 'critical')
    assert.deepEqual(await outcomes('test.now:ap:1'), ['opened', 'escalated'])

    // A scope restricts clears to its prefix.
    await reconcileConditions(['test.now'], [], { scope: 'test.now:ap:9' })
    assert.equal(await prop('test.now:ap:1', 'state'), 'active')
    await reconcileConditions(['test.now'], [], { scope: 'test.now:ap:1' })
    assert.equal(await prop('test.now:ap:1', 'state'), 'resolved')
  })

  test('emit with trx queues after commit, never after rollback', async ({ assert }) => {
    await db.transaction(async (trx) => {
      emitAlertEvent({ type: 'test.now', subject: AP4, trx })
      assert.lengthOf(_queuedEvents(), 0, 'not queued before the commit')
    })
    try {
      await db.transaction(async (trx) => {
        emitAlertEvent({ type: 'test.now', subject: AP5, trx })
        throw new Error('rollback')
      })
    } catch {
      // expected
    }
    await flushAlertQueue()
    assert.lengthOf(await Alert.query().where('dedupe_key', 'test.now:ap:4'), 1)
    assert.lengthOf(await Alert.query().where('dedupe_key', 'test.now:ap:5'), 0)
  })

  test('an unknown type is logged as an event and dropped; a bad subject is dropped', async ({
    assert,
  }) => {
    await emit({ type: 'nope.nothing' })
    await emit({ type: 'test.now', subject: { kind: 'ap', id: -1 } as never })
    await emit({ type: 'test.now', subject: { kind: 'device', mac: '02:00:00:00:00:01' } })
    assert.deepEqual(await outcomes(), ['unknown_type', 'invalid_subject'])
    assert.equal(await countAlerts(), 0)
  })

  test('the queue is bounded: overflow drops the oldest info event first', async ({ assert }) => {
    _pauseAlertEngine(true)
    emitAlertEvent({ type: 'test.notice', subject: AP4, dedupeKey: 'info-first' })
    for (let i = 1; i < QUEUE_MAX; i++) {
      emitAlertEvent({ type: 'test.now', subject: AP4, dedupeKey: `w-${i}` })
    }
    assert.lengthOf(_queuedEvents(), QUEUE_MAX)
    emitAlertEvent({ type: 'test.now', subject: AP4, dedupeKey: 'w-last' })
    let queued = _queuedEvents()
    assert.lengthOf(queued, QUEUE_MAX)
    assert.equal(queued[0].dedupeKey, 'w-1', 'the info event went first')
    assert.equal(engineStats().dropped, 1)

    emitAlertEvent({ type: 'test.now', subject: AP4, dedupeKey: 'w-later' })
    queued = _queuedEvents()
    assert.equal(queued[0].dedupeKey, 'w-2', 'then the oldest event')
    assert.equal(queued[queued.length - 1].dedupeKey, 'w-later')
    assert.equal(engineStats().dropped, 2)
  })

  test('labels, paths and texts come from the subject and the catalogue, in the instance zone', async ({
    assert,
  }) => {
    await SystemSetting.set('timezone', 'Asia/Manila')
    const collector = await Collector.create({
      name: 'gateway',
      baseUrl: 'http://127.0.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    await emit({
      type: 'collector.offline',
      subject: { kind: 'collector', id: collector.id },
      payload: { name: 'gateway', lastSeenAt: '2026-10-01T05:58:00Z', silentSeconds: 120 },
    })
    const alert = await latest(`collector.offline:collector:${collector.id}`)
    assert.equal(alert.subjectLabel, 'gateway')
    assert.equal(alert.path, '/settings/collectors')
    assert.equal(alert.title, 'Collector gateway is offline')
    assert.equal(alert.body, 'No data for 2 min (since 13:58).')
  })
})

async function seedUser() {
  return (
    (await User.findBy('email', 'admin@example.com')) ??
    User.create({
      fullName: 'Admin',
      email: 'admin@example.com',
      password: 'admin-pass-123',
      role: 'admin',
    })
  )
}

async function countAlerts() {
  const row = await Alert.query().count('* as n').first()
  return Number(row!.$extras.n)
}
