import Alert from '#models/alert'
import AlertDelivery from '#models/alert_delivery'
import AlertDeliveryAttempt from '#models/alert_delivery_attempt'
import AlertEvent from '#models/alert_event'
import AlertPushSubscription from '#models/alert_push_subscription'
import AlertWebhook from '#models/alert_webhook'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _registerTestAlertType } from '#services/alerts/catalogue/index'
import { fakeAlertClock, sqlTime } from '#services/alerts/clock'
import {
  _resetDeliveryTests,
  DeliveryTestError,
  resetStaleSending,
  runDeliveryPass,
  sendTestDelivery,
} from '#services/alerts/delivery_worker'
import { emitAlertEvent } from '#services/alerts/emit'
import { flushAlertQueue, runAlertTick } from '#services/alerts/engine'
import type { AlertTypeDef, EmitInput } from '#services/alerts/model'
import { conditionRender } from '#services/alerts/render'
import { pruneAlerts } from '#services/alerts/retention'
import { _resetRoutingState } from '#services/alerts/routing'
import { _setSenders, type Sender, type SendJob, type SendResult } from '#services/alerts/senders'
import { ALERTS_DEFAULTS, saveAlertsSettings } from '#services/alerts/settings'
import { resetAlertEngineState, truncateAllTables } from '#tests/helpers/alerts'
import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'

/**
 * WP-A2 acceptance (docs/design/alerts/README.md §9, delivery.md §3–7):
 * the routing matrix, grouping, quiet hours with break-through and a digest,
 * the destination rate limit, collapse on resolve, backoff and Retry-After,
 * stale `sending` rows, destination health and `system.delivery_failing`,
 * `ALERTS_DELIVERY=off`, test sends and retention. Fake clock, fake senders.
 */

const T0 = '2026-10-01T06:00:00Z' // 14:00 in Manila

function cond(
  type: string,
  defaults: AlertTypeDef['defaults'] = {},
  extra: Partial<AlertTypeDef> = {}
): AlertTypeDef {
  return {
    type,
    category: 'network',
    kind: 'condition',
    severity: 'warning',
    subjects: ['ap', 'controller'],
    owner: 'alerts',
    label: type,
    description: 'test',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 30, flapThreshold: 0, ...defaults },
    render: conditionRender({
      state: 'offline',
      opened: (a) => ({ title: `${a.label} is offline`, body: 'down' }),
      resolved: (a) => ({ title: `${a.label} is back online`, body: 'back' }),
    }),
    ...extra,
  }
}

function notice(type: string, defaults: AlertTypeDef['defaults'] = {}): AlertTypeDef {
  return {
    type,
    category: 'network',
    kind: 'notice',
    severity: 'info',
    subjects: ['ap', 'controller'],
    owner: 'alerts',
    label: type,
    description: 'test',
    defaults: { dedupeMinutes: 0, ...defaults },
    render: (a) => ({ title: `${type} on ${a.label}`, body: 'it happened' }),
    renderGroup: (alerts) => ({ title: `${alerts.length} × ${type}`, body: 'group' }),
  }
}

type Script = (job: SendJob) => SendResult

function fakeSender(kind: 'push' | 'webhook') {
  const jobs: SendJob[] = []
  let script: Script = () => ({ outcome: 'sent', statusCode: 201, durationMs: 5 })
  const sender: Sender = {
    kind,
    async send(job) {
      jobs.push(job)
      return script(job)
    },
  }
  return {
    sender,
    jobs,
    respond(next: Script) {
      script = next
    },
    titles: () => jobs.map((j) => j.message.title),
  }
}

let counter = 0

async function webhook(fields: Partial<AlertWebhook> = {}) {
  return AlertWebhook.create({
    name: `hook ${++counter}`,
    format: 'standard',
    preset: null,
    urlEncrypted: 'x',
    urlDisplay: 'https://hooks.example.com/••••',
    secretEncrypted: null,
    authEncrypted: null,
    options: null,
    filters: { minSeverity: 'info', categories: null, types: null, quietHours: 'inherit' },
    detail: 'full',
    respectQuietHours: true,
    enabled: true,
    state: 'active',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    createdByUserId: null,
    ...fields,
  })
}

async function pushSub(fields: Partial<AlertPushSubscription> = {}) {
  const user =
    (await User.findBy('email', 'admin@example.com')) ??
    (await User.create({
      fullName: 'Admin',
      email: 'admin@example.com',
      password: 'admin-pass-123',
      role: 'admin',
    }))
  const endpoint = `https://fcm.googleapis.com/fcm/send/device-${++counter}`
  return AlertPushSubscription.create({
    userId: user.id,
    endpoint,
    endpointHash: createHash('sha256').update(endpoint).digest('hex'),
    pushService: 'fcm',
    p256dh: 'B'.repeat(87),
    auth: 'a'.repeat(22),
    vapidKeyId: 'v1-00000000',
    expirationAt: null,
    label: `Phone ${counter}`,
    platform: 'Chrome on Android',
    filters: { minSeverity: 'warning', categories: null, types: null, quietHours: 'inherit' },
    enabled: true,
    state: 'active',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    renewTokenHash: null,
    ...fields,
  })
}

async function emit(input: Partial<EmitInput> & { type: string }) {
  emitAlertEvent({ subject: { kind: 'ap', id: 4 }, ...input } as EmitInput)
  await flushAlertQueue()
}

async function tick() {
  await runAlertTick()
  await flushAlertQueue()
}

async function deliveries(where: Partial<Record<string, unknown>> = {}) {
  const q = AlertDelivery.query().orderBy('id', 'asc')
  for (const [k, v] of Object.entries(where)) q.where(k, v as string)
  return q
}

async function firstDelivery() {
  return AlertDelivery.query().orderBy('id', 'asc').firstOrFail()
}

async function statusOfFirst() {
  const d = await firstDelivery()
  return d.status
}

async function patchSettings(patch: Partial<typeof ALERTS_DEFAULTS>) {
  await saveAlertsSettings({ ...structuredClone(ALERTS_DEFAULTS), ...patch })
}

test.group('alerts delivery pipeline', (group) => {
  let clock: ReturnType<typeof fakeAlertClock>
  let push: ReturnType<typeof fakeSender>
  let hooks: ReturnType<typeof fakeSender>

  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    _resetRoutingState()
    _resetDeliveryTests()
    clock = fakeAlertClock(T0)
    push = fakeSender('push')
    hooks = fakeSender('webhook')
    _setSenders({ push: push.sender, webhook: hooks.sender })
    await SystemSetting.set('timezone', 'Asia/Manila')
    await SystemSetting.set('site_name', 'Home')
    for (const def of [
      cond('test.down'),
      cond('test.wan', {}, { category: 'wan' }),
      cond('test.norec', { notifyRecovery: false }),
      cond('test.nopush', { push: false }),
      cond('test.silent', { notify: false }),
      cond('test.capped', { maxPerHour: 2 }),
      notice('test.joined', { groupSeconds: 60 }),
      notice('test.ping'),
    ]) {
      _registerTestAlertType(def)
    }
    return async () => {
      _setSenders(null)
      await resetAlertEngineState()
    }
  })

  test('routing: severity and category filters, channels, notify off, mutes and maxPerHour', async ({
    assert,
  }) => {
    const phone = await pushSub() // warning+
    const all = await webhook() // info+
    const wanOnly = await webhook({
      filters: { minSeverity: 'info', categories: ['wan'], types: null, quietHours: 'inherit' },
    })

    await emit({ type: 'test.down', severity: 'info', subject: { kind: 'ap', id: 1 } })
    const firstRows = await deliveries()
    assert.deepEqual(
      firstRows.map((d) => d.webhookId ?? `push${d.pushSubscriptionId}`),
      [all.id]
    )
    await emit({ type: 'test.down', severity: 'warning', subject: { kind: 'ap', id: 2 } })
    await emit({ type: 'test.wan', subject: { kind: 'ap', id: 3 } })
    const destinationsOf = async (type: string, ref: string) => {
      const alert = await Alert.query().where('type', type).where('subject_ref', ref).firstOrFail()
      const rows = await deliveries({ alert_id: alert.id })
      return rows.map((d) =>
        d.pushSubscriptionId ? `push:${d.pushSubscriptionId}` : `webhook:${d.webhookId}`
      )
    }
    assert.sameMembers(await destinationsOf('test.down', '2'), [
      `push:${phone.id}`,
      `webhook:${all.id}`,
    ])
    assert.sameMembers(await destinationsOf('test.wan', '3'), [
      `push:${phone.id}`,
      `webhook:${all.id}`,
      `webhook:${wanOnly.id}`,
    ])

    // Channel off: no push. Notify off: nothing at all.
    await emit({ type: 'test.nopush', subject: { kind: 'ap', id: 5 } })
    await emit({ type: 'test.silent', subject: { kind: 'ap', id: 6 } })
    assert.deepEqual(await destinationsOf('test.nopush', '5'), [`webhook:${all.id}`])
    assert.deepEqual(await destinationsOf('test.silent', '6'), [])

    // maxPerHour 2: the third notification of the type within the hour is inbox only.
    for (const id of [7, 8, 9]) await emit({ type: 'test.capped', subject: { kind: 'ap', id } })
    const capped = await Alert.query().where('type', 'test.capped').orderBy('id')
    assert.lengthOf(capped, 3)
    const cappedDeliveries = await AlertDelivery.query().whereIn(
      'alert_id',
      capped.map((a) => a.id)
    )
    assert.sameMembers(
      [...new Set(cappedDeliveries.map((d) => Number(d.alertId)))],
      [capped[0].id, capped[1].id]
    )
  })

  test('grouping: three notices within the window become one delivery with three items', async ({
    assert,
  }) => {
    await webhook()
    for (const id of [1, 2, 3]) {
      await emit({ type: 'test.joined', subject: { kind: 'ap', id } })
      clock.advance({ seconds: 10 })
    }
    let rows = await deliveries()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].status, 'grouping')
    assert.lengthOf(rows[0].items!, 3)

    clock.advance({ seconds: 31 })
    await tick()
    rows = await deliveries()
    assert.equal(rows[0].status, 'queued')
    await runDeliveryPass()
    assert.lengthOf(hooks.jobs, 1)
    assert.equal(hooks.jobs[0].message.event, 'group')
    assert.equal(hooks.jobs[0].message.title, '3 × test.joined')
    assert.lengthOf(hooks.jobs[0].message.items!, 3)
    assert.equal(await statusOfFirst(), 'sent')
  })

  test('quiet hours across midnight in Asia/Manila: held, critical breaks through, one digest at the end', async ({
    assert,
  }) => {
    await patchSettings({
      quietHours: { enabled: true, start: '22:00', end: '07:00', breakThrough: 'critical' },
    })
    await webhook()
    clock.set('2026-10-01T15:30:00Z') // 23:30 Manila
    await emit({ type: 'test.down', subject: { kind: 'ap', id: 1 } })
    await emit({ type: 'test.down', subject: { kind: 'ap', id: 2 } })
    await emit({ type: 'test.down', subject: { kind: 'ap', id: 3 }, severity: 'critical' })
    await runDeliveryPass()
    const rows = await deliveries()
    assert.deepEqual(
      rows.map((d) => d.status),
      ['held', 'held', 'sent']
    )
    assert.equal(rows[0].holdReason, 'quiet_hours')
    assert.equal(sqlTime(rows[0].sendAfter), '2026-10-01 23:00:00')
    assert.deepEqual(hooks.titles(), ['3 is offline'])

    // One of them recovers during the night (its recovery is held too).
    clock.set('2026-10-01T18:00:00Z')
    await emit({ type: 'test.down', subject: { kind: 'ap', id: 2 }, phase: 'clear' })
    clock.advance({ seconds: 30 })
    await tick()
    await runDeliveryPass()

    clock.set('2026-10-01T23:00:00Z') // 07:00 Manila
    await tick()
    await runDeliveryPass()
    const digest = hooks.jobs[hooks.jobs.length - 1].message
    assert.equal(digest.event, 'digest')
    assert.equal(digest.title, 'While quiet hours were on: 2 alerts')
    assert.equal(digest.body, '1 alert still active (1 is offline); 1 resolved (2 is back online).')
    assert.lengthOf(hooks.jobs, 2)
  })

  test('rate limit: overflow is held and released as one digest', async ({ assert }) => {
    await patchSettings({ destinationRateLimit: { max: 2, windowMinutes: 10 } })
    await webhook()
    for (const id of [1, 2, 3, 4]) {
      await emit({ type: 'test.ping', subject: { kind: 'ap', id } })
      await runDeliveryPass()
      clock.advance({ seconds: 5 })
    }
    let rows = await deliveries()
    assert.deepEqual(
      rows.map((d) => d.status),
      ['sent', 'sent', 'held', 'held']
    )
    assert.equal(rows[2].holdReason, 'rate_limit')
    assert.equal(sqlTime(rows[2].sendAfter), '2026-10-01 06:10:00')

    clock.set('2026-10-01T06:10:00Z')
    await tick()
    await runDeliveryPass()
    rows = await deliveries()
    assert.deepEqual(
      rows.map((d) => d.status),
      ['sent', 'sent', 'collapsed', 'collapsed', 'sent']
    )
    assert.equal(rows[4].transition, 'digest')
    assert.equal(hooks.jobs[2].message.title, '2 alerts held back (too many notifications)')
  })

  test('collapse on resolve: an unsent outage notice collapses and the recovery says "was"', async ({
    assert,
  }) => {
    await webhook()
    hooks.respond(() => ({ outcome: 'retry', error: 'getaddrinfo ENOTFOUND', durationMs: 3 }))
    await emit({ type: 'test.down' })
    await runDeliveryPass()
    assert.equal(await statusOfFirst(), 'retrying')

    clock.advance({ minutes: 7 })
    await emit({ type: 'test.down', phase: 'clear' })
    clock.advance({ seconds: 30 })
    await tick() // recovery due
    const rows = await deliveries()
    assert.deepEqual(
      rows.map((d) => [d.transition, d.status]),
      [
        ['opened', 'collapsed'],
        ['resolved', 'queued'],
      ]
    )
    hooks.respond(() => ({ outcome: 'sent', statusCode: 200, durationMs: 4 }))
    await runDeliveryPass()
    const recovery = hooks.jobs[hooks.jobs.length - 1].message
    assert.equal(recovery.title, '4 was offline')
    assert.equal(recovery.body, '14:00–14:07 (7 min).')
  })

  test('a destination that saw the outage gets "back online"', async ({ assert }) => {
    await webhook()
    await emit({ type: 'test.down' })
    await runDeliveryPass()
    clock.advance({ minutes: 3 })
    await emit({ type: 'test.down', phase: 'clear' })
    clock.advance({ seconds: 30 })
    await tick()
    await runDeliveryPass()
    assert.deepEqual(hooks.titles(), ['4 is offline', '4 is back online'])
    assert.equal(hooks.jobs[1].message.alert!.state, 'resolved')
  })

  test('backoff 10 s, 30 s …; Retry-After wins (capped at 1 h); expiry ends it', async ({
    assert,
  }) => {
    await webhook()
    hooks.respond(() => ({ outcome: 'retry', statusCode: 503, error: '503', durationMs: 1 }))
    await emit({ type: 'test.down' })
    await runDeliveryPass()
    let [d] = await deliveries()
    let wait = d.nextAttemptAt!.diff(clock.now(), 'seconds').seconds
    assert.isAtLeast(wait, 8)
    assert.isAtMost(wait, 12)

    clock.advance({ seconds: 12 })
    await runDeliveryPass()
    d = await firstDelivery()
    wait = d.nextAttemptAt!.diff(clock.now(), 'seconds').seconds
    assert.isAtLeast(wait, 24)
    assert.isAtMost(wait, 36)

    hooks.respond(() => ({
      outcome: 'retry',
      statusCode: 429,
      error: '429',
      retryAfterSeconds: 99999,
      durationMs: 1,
    }))
    clock.advance({ seconds: 36 })
    await runDeliveryPass()
    d = await firstDelivery()
    assert.equal(d.nextAttemptAt!.diff(clock.now(), 'seconds').seconds, 3600)
    assert.equal(d.attempts, 3)
    assert.lengthOf(await AlertDeliveryAttempt.query().where('delivery_id', d.id), 3)

    // Past expires_at (24 h for webhooks): expired, a failure for the destination.
    clock.advance({ hours: 25 })
    await runDeliveryPass()
    d = await firstDelivery()
    assert.equal(d.status, 'expired')
    const hook = await AlertWebhook.findOrFail(d.webhookId!)
    assert.equal(hook.consecutiveFailures, 1)
  })

  test('rows left in sending at boot go back to retrying', async ({ assert }) => {
    await webhook()
    await emit({ type: 'test.down' })
    const [d] = await deliveries()
    await db
      .from('alert_deliveries')
      .where('id', d.id)
      .update({ status: 'sending', updated_at: sqlTime(clock.now().minus({ minutes: 3 })) })
    assert.equal(await resetStaleSending(), 1)
    const again = await AlertDelivery.findOrFail(d.id)
    assert.equal(again.status, 'retrying')
  })

  test('five failures in a row: failing + system.delivery_failing to the other destinations; a success clears it', async ({
    assert,
  }) => {
    const bad = await webhook({ name: 'Broken hook' })
    const good = await webhook({ name: 'Good hook' })
    hooks.respond((job) =>
      (job.destination as AlertWebhook).id === bad.id
        ? { outcome: 'failed', statusCode: 401, error: '401 Unauthorized', durationMs: 2 }
        : { outcome: 'sent', statusCode: 200, durationMs: 2 }
    )
    for (const id of [1, 2, 3, 4, 5]) {
      await emit({ type: 'test.ping', subject: { kind: 'ap', id } })
      await runDeliveryPass()
    }
    await flushAlertQueue()
    const broken = await AlertWebhook.findOrFail(bad.id)
    assert.equal(broken.state, 'failing')
    assert.equal(broken.consecutiveFailures, 5)
    const failing = await Alert.query().where('type', 'system.delivery_failing').firstOrFail()
    assert.equal(failing.state, 'active')
    assert.equal(failing.dedupeKey, `system.delivery_failing:webhook:${bad.id}`)
    const routed = await AlertDelivery.query().where('alert_id', failing.id)
    assert.deepEqual(
      routed.map((r) => r.webhookId),
      [good.id],
      'never to the failing destination'
    )

    hooks.respond(() => ({ outcome: 'sent', statusCode: 200, durationMs: 2 }))
    await emit({ type: 'test.ping', subject: { kind: 'ap', id: 6 } })
    await runDeliveryPass()
    await flushAlertQueue()
    const healed = await AlertWebhook.findOrFail(bad.id)
    assert.equal(healed.state, 'active')
    assert.equal(healed.consecutiveFailures, 0)
    const cleared = await Alert.findOrFail(failing.id)
    assert.equal(cleared.state, 'resolved')
  })

  test('a push service answering 410 marks the subscription gone; it gets nothing more', async ({
    assert,
  }) => {
    const phone = await pushSub()
    push.respond(() => ({
      outcome: 'failed',
      statusCode: 410,
      error: '410 Gone',
      destinationState: 'gone',
      durationMs: 1,
    }))
    await emit({ type: 'test.down', severity: 'critical' })
    await runDeliveryPass()
    const gone = await AlertPushSubscription.findOrFail(phone.id)
    assert.equal(gone.state, 'gone')
    await emit({ type: 'test.down', severity: 'critical', subject: { kind: 'ap', id: 9 } })
    assert.lengthOf(await deliveries({ push_subscription_id: phone.id }), 1)
  })

  test('ALERTS_DELIVERY=off: routed and recorded, never sent', async ({ assert, cleanup }) => {
    const previous = env.get('ALERTS_DELIVERY')
    env.set('ALERTS_DELIVERY', 'off')
    cleanup(() => env.set('ALERTS_DELIVERY', previous as 'on'))
    const hook = await webhook()
    await emit({ type: 'test.down' })
    await runDeliveryPass()
    const [d] = await deliveries()
    assert.equal(d.status, 'collapsed')
    assert.equal(d.lastError, 'delivery disabled (ALERTS_DELIVERY=off)')
    assert.lengthOf(hooks.jobs, 0)
    await assert.rejects(
      () => sendTestDelivery('webhook', hook),
      'delivery disabled (ALERTS_DELIVERY=off)'
    )
  })

  test('test sends: logged as a delivery, one per destination per 10 s', async ({ assert }) => {
    const hook = await webhook()
    const { delivery, result } = await sendTestDelivery('webhook', hook)
    assert.equal(result.outcome, 'sent')
    assert.equal(delivery.transition, 'test')
    assert.equal(delivery.status, 'sent')
    assert.equal(hooks.jobs[0].message.event, 'test')
    try {
      await sendTestDelivery('webhook', hook)
      assert.fail('expected a rate limit')
    } catch (error) {
      assert.instanceOf(error, DeliveryTestError)
      assert.equal((error as DeliveryTestError).code, 'test_rate_limited')
    }
  })

  test('minimal webhooks get no MACs, names or IPs', async ({ assert }) => {
    await webhook({ detail: 'minimal' })
    await emit({
      type: 'device.new',
      subject: { kind: 'device', mac: '02:00:00:5e:10:22' },
      payload: {
        mac: '02:00:00:5e:10:22',
        name: 'pixel-8',
        ip: '192.168.1.20',
        network: 'lan',
        firstSeenAt: T0,
      },
    })
    clock.advance({ minutes: 6 })
    await tick()
    await runDeliveryPass()
    const message = hooks.jobs[0].message
    assert.isTrue(message.redacted)
    assert.equal(message.body, 'On lan, first seen 14:00.')
    assert.deepEqual(message.alert!.data, { network: 'lan', firstSeenAt: T0 })
    assert.isNull(message.alert!.subject.label)
  })

  test('retention deletes old events, alerts, deliveries and expired mutes', async ({ assert }) => {
    await webhook()
    await emit({ type: 'test.ping' })
    await runDeliveryPass()
    clock.advance({ days: 200 })
    const result = await pruneAlerts(ALERTS_DEFAULTS)
    assert.include(result, { events: 1, alerts: 1 })
    assert.equal(
      await AlertEvent.query()
        .count('* as n')
        .first()
        .then((r) => Number(r!.$extras.n)),
      0
    )
    assert.lengthOf(await deliveries(), 0)
    await emit({ type: 'test.down' }) // active: never pruned
    clock.advance({ days: 400 })
    await pruneAlerts(ALERTS_DEFAULTS)
    assert.lengthOf(await Alert.query().where('state', 'active'), 1)
  })
})
