import AlertDelivery from '#models/alert_delivery'
import AlertDeliveryAttempt from '#models/alert_delivery_attempt'
import AlertMute from '#models/alert_mute'
import AlertPushSubscription from '#models/alert_push_subscription'
import AlertWebhook from '#models/alert_webhook'
import { getAlertType } from '#services/alerts/catalogue/index'
import { alertNow, sqlTime } from '#services/alerts/clock'
import {
  refreshOutOfBand,
  setOutOfBandTransport,
  type OutOfBandMessage,
  type OutOfBandTransport,
} from '#services/alerts/detectors/out_of_band'
import { emitAlertEvent } from '#services/alerts/emit'
import { instanceZone } from '#services/alerts/engine'
import { filterMatches } from '#services/alerts/filters'
import { buildMessage, destinationIdOf } from '#services/alerts/messages'
import type { AlertsSettings } from '#services/alerts/model'
import { pushSender } from '#services/alerts/push/push_sender'
import { quietHoldUntil } from '#services/alerts/quiet_hours'
import { rateLimitHoldUntil } from '#services/alerts/rate_limit'
import {
  createDeliveryRow,
  destinationFilters,
  newMessageId,
  type DestinationKind,
} from '#services/alerts/routing'
import {
  onDeliveryQueued,
  registerSender,
  senderFor,
  type RenderedMessage,
  type Sender,
  type SendResult,
} from '#services/alerts/senders'
import { effectiveRule, getAlertsSettings, linkBase } from '#services/alerts/settings'
import { webhookSender } from '#services/alerts/webhooks/webhook_sender'
import { perchVersions } from '#services/perch_version'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

/**
 * The delivery worker (docs/design/alerts/delivery.md §3–7): an in-process
 * loop that wakes on every new delivery and every 2 s, picks due rows
 * (`queued` / `retrying`, most severe first), and sends them, four
 * destinations at a time and one delivery at a time per destination.
 *
 * Before sending: expiry, quiet hours (→ `held` until the window ends) and the
 * destination rate limit (→ `held` until a slot frees); the routing tick turns
 * held rows into one digest. After: every try is an attempt row; backoff
 * 10 s, 30 s, 2 min, 10 min, 30 min, then hourly (±20 % jitter, `Retry-After`
 * wins up to 1 h) until `expires_at`. Destination health: five deliveries in
 * a row ending `failed`/`expired` mark it `failing` and raise
 * `system.delivery_failing` (routed to the other destinations); one `sent`
 * clears both. `ALERTS_DELIVERY=off` collapses due rows instead of sending.
 */

const LANES = 4
const PASS_LIMIT = 20
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800]
const RETRY_AFTER_MAX_SECONDS = 3600
const FAILING_AFTER = 5
const STALE_SENDING_MINUTES = 2
const TEST_TIMEOUT_MS = 10_000
const TEST_INTERVAL_MS = 10_000

type Destination = AlertPushSubscription | AlertWebhook

export function deliveryEnabled(): boolean {
  return env.get('ALERTS_DELIVERY') !== 'off'
}

export const DELIVERY_DISABLED_ERROR = 'delivery disabled (ALERTS_DELIVERY=off)'

/** Wait before try `attempt + 1` (attempt = tries made so far), without jitter. */
export function backoffSeconds(attempt: number): number {
  return BACKOFF_SECONDS[attempt - 1] ?? 3600
}

function jittered(seconds: number): number {
  return seconds * (0.8 + Math.random() * 0.4)
}

function registerDefaultSenders(): void {
  if (!senderFor('push')) registerSender(pushSender)
  if (!senderFor('webhook')) registerSender(webhookSender)
}

async function loadDestination(
  kind: DestinationKind,
  id: number | null
): Promise<Destination | null> {
  if (id === null) return null
  return kind === 'push' ? AlertPushSubscription.find(id) : AlertWebhook.find(id)
}

function destinationName(kind: DestinationKind, row: Destination): string {
  if (kind === 'webhook') return (row as AlertWebhook).name
  const sub = row as AlertPushSubscription
  return sub.label ?? sub.platform ?? `device ${sub.id}`
}

function trimError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 300)
}

/* ------------------------------------------------------------------ */
/* Destination health                                                  */
/* ------------------------------------------------------------------ */

function failingKey(kind: DestinationKind, id: number): string {
  return `system.delivery_failing:${kind}:${id}`
}

async function destinationSucceeded(
  kind: DestinationKind,
  row: Destination,
  now: DateTime
): Promise<void> {
  const wasFailing = row.state === 'failing' || row.consecutiveFailures >= FAILING_AFTER
  row.consecutiveFailures = 0
  row.lastSuccessAt = now
  if (row.state === 'failing') row.state = 'active'
  await row.save()
  if (wasFailing) {
    emitAlertEvent({
      type: 'system.delivery_failing',
      phase: 'clear',
      subject: { kind: 'controller' },
      dedupeKey: failingKey(kind, row.id),
      source: 'delivery_worker',
    })
  }
}

async function destinationFailed(
  kind: DestinationKind,
  row: Destination,
  now: DateTime,
  error: string,
  state?: 'gone' | 'failing'
): Promise<void> {
  row.consecutiveFailures = Math.min(row.consecutiveFailures + 1, 30000)
  row.lastFailureAt = now
  row.lastError = error.slice(0, 300)
  if (state === 'gone' && kind === 'push') {
    ;(row as AlertPushSubscription).state = 'gone'
  } else if (state === 'failing' || row.consecutiveFailures >= FAILING_AFTER) {
    if (row.state !== 'gone' && row.state !== 'needs_secret') row.state = 'failing'
  }
  await row.save()
  if (row.consecutiveFailures >= FAILING_AFTER && row.state !== 'gone') {
    emitAlertEvent({
      type: 'system.delivery_failing',
      phase: 'raise',
      subject: { kind: 'controller' },
      dedupeKey: failingKey(kind, row.id),
      payload: {
        destinationKind: kind,
        destinationId: row.id,
        name: destinationName(kind, row),
        lastError: row.lastError,
        failures: row.consecutiveFailures,
      },
      source: 'delivery_worker',
    })
  }
}

/* ------------------------------------------------------------------ */
/* One delivery                                                        */
/* ------------------------------------------------------------------ */

type PassContext = { settings: AlertsSettings; zone: string; now: DateTime }

async function recordAttempt(
  delivery: AlertDelivery,
  result: SendResult,
  now: DateTime
): Promise<void> {
  await AlertDeliveryAttempt.create({
    deliveryId: delivery.id,
    attemptedAt: now,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    statusCode: result.statusCode ?? null,
    outcome: result.outcome,
    error: result.outcome === 'sent' ? null : result.error.slice(0, 300),
    responseExcerpt: result.responseExcerpt ? result.responseExcerpt.slice(0, 512) : null,
  })
}

async function send(
  sender: Sender,
  delivery: AlertDelivery,
  message: RenderedMessage,
  destination: Destination,
  timeoutMs?: number
): Promise<SendResult> {
  const started = performance.now()
  try {
    const sending = sender.send({ delivery, message, destination })
    if (!timeoutMs) return await sending
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<SendResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            outcome: 'retry',
            error: `timed out after ${timeoutMs / 1000} s`,
            durationMs: performance.now() - started,
          }),
        timeoutMs
      )
    })
    try {
      return await Promise.race([sending, timeout])
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { outcome: 'retry', error: trimError(error), durationMs: performance.now() - started }
  }
}

async function finish(
  delivery: AlertDelivery,
  destination: Destination,
  result: SendResult,
  now: DateTime
): Promise<void> {
  const kind = delivery.destinationKind
  delivery.lastStatusCode = result.statusCode ?? null
  if (result.outcome === 'sent') {
    delivery.status = 'sent'
    delivery.sentAt = now
    delivery.nextAttemptAt = null
    delivery.lastError = null
    await delivery.save()
    await destinationSucceeded(kind, destination, now)
    return
  }
  delivery.lastError = result.error.slice(0, 300)
  if (result.outcome === 'retry') {
    const wait = result.retryAfterSeconds
      ? Math.min(Math.max(result.retryAfterSeconds, 1), RETRY_AFTER_MAX_SECONDS)
      : jittered(backoffSeconds(delivery.attempts))
    const next = now.plus({ milliseconds: Math.round(wait * 1000) })
    if (next < delivery.expiresAt) {
      delivery.status = 'retrying'
      delivery.nextAttemptAt = next
      await delivery.save()
      return
    }
    delivery.status = 'expired'
    delivery.nextAttemptAt = null
    await delivery.save()
    await destinationFailed(kind, destination, now, result.error)
    return
  }
  delivery.status = 'failed'
  delivery.nextAttemptAt = null
  await delivery.save()
  await destinationFailed(kind, destination, now, result.error, result.destinationState)
}

async function hold(
  delivery: AlertDelivery,
  reason: 'quiet_hours' | 'rate_limit',
  until: DateTime
): Promise<void> {
  delivery.status = 'held'
  delivery.holdReason = reason
  delivery.sendAfter = until
  delivery.nextAttemptAt = null
  await delivery.save()
}

async function collapse(delivery: AlertDelivery, reason: string): Promise<void> {
  delivery.status = 'collapsed'
  delivery.nextAttemptAt = null
  delivery.lastError = reason.slice(0, 300)
  await delivery.save()
}

async function processDelivery(delivery: AlertDelivery, ctx: PassContext): Promise<void> {
  const now = ctx.now
  const kind = delivery.destinationKind
  const destination = await loadDestination(kind, destinationIdOf(delivery))
  if (!destination) return collapse(delivery, 'destination removed')
  if (now >= delivery.expiresAt) {
    delivery.status = 'expired'
    delivery.nextAttemptAt = null
    await delivery.save()
    await destinationFailed(
      kind,
      destination,
      now,
      delivery.lastError ?? 'expired before it was sent'
    )
    return
  }
  if (!destination.enabled) return collapse(delivery, 'destination disabled')
  if (kind === 'push' && destination.state === 'gone')
    return collapse(delivery, 'subscription gone')

  if (delivery.transition !== 'test') {
    const filters = destinationFilters(kind, destination)
    const quietUntil = quietHoldUntil(
      ctx.settings,
      filters.quietHours,
      delivery.severity,
      now,
      ctx.zone
    )
    if (quietUntil) return hold(delivery, 'quiet_hours', quietUntil)
    const freeAt = await rateLimitHoldUntil({ kind, id: destination.id }, ctx.settings, now)
    if (freeAt) return hold(delivery, 'rate_limit', freeAt)
  }

  const sender = senderFor(kind)
  if (!sender) {
    delivery.status = 'retrying'
    delivery.nextAttemptAt = now.plus({ seconds: 60 })
    delivery.lastError = `no ${kind} sender`
    await delivery.save()
    return
  }
  const message = await buildMessage(delivery, destination, ctx)
  if (!message) return collapse(delivery, 'its alerts no longer exist')

  delivery.status = 'sending'
  delivery.attempts += 1
  await delivery.save()
  const result = await send(sender, delivery, message, destination)
  await recordAttempt(delivery, result, now)
  await finish(delivery, destination, result, now)
}

/* ------------------------------------------------------------------ */
/* Passes                                                              */
/* ------------------------------------------------------------------ */

/** At boot: rows left in `sending` for over 2 minutes go back to `retrying` (at least once). */
export async function resetStaleSending(now: DateTime = alertNow()): Promise<number> {
  const at = sqlTime(now)
  const affected = await db
    .from('alert_deliveries')
    .where('status', 'sending')
    .where('updated_at', '<', sqlTime(now.minus({ minutes: STALE_SENDING_MINUTES })))
    .update({ status: 'retrying', next_attempt_at: at, updated_at: at })
  return Number(affected) || 0
}

/**
 * One pass: every due delivery (≤ 20), most severe first, four destinations
 * in parallel, FIFO per destination. Returns how many rows it handled.
 */
export async function runDeliveryPass(now: DateTime = alertNow()): Promise<number> {
  const due = await AlertDelivery.query()
    .whereIn('status', ['queued', 'retrying'])
    .whereNotNull('next_attempt_at')
    .where('next_attempt_at', '<=', sqlTime(now))
    .orderBy('severity', 'desc')
    .orderBy('id', 'asc')
    .limit(PASS_LIMIT)
  if (due.length === 0) return 0

  if (!deliveryEnabled()) {
    for (const delivery of due) await collapse(delivery, DELIVERY_DISABLED_ERROR)
    return due.length
  }

  const ctx: PassContext = { settings: await getAlertsSettings(), zone: await instanceZone(), now }
  const lanes = new Map<string, AlertDelivery[]>()
  for (const delivery of due) {
    const key = `${delivery.destinationKind}:${destinationIdOf(delivery)}`
    lanes.set(key, [...(lanes.get(key) ?? []), delivery])
  }
  const queues = [...lanes.values()]
  const workers = Array.from({ length: Math.min(LANES, queues.length) }, async () => {
    for (let lane = queues.shift(); lane; lane = queues.shift()) {
      for (const delivery of lane) {
        try {
          await processDelivery(delivery, ctx)
        } catch (error) {
          logger.error({ err: error, deliveryId: delivery.id }, 'alerts: delivery failed')
        }
      }
    }
  })
  await Promise.all(workers)
  return due.length
}

let timer: NodeJS.Timeout | null = null
let current: Promise<number> | null = null
let again = false
let unsubscribe: (() => void) | null = null

/** Runs a pass now (or once more after the running one). */
export function kickDeliveries(): Promise<number> {
  if (current) {
    again = true
    return current
  }
  current = runDeliveryPass()
    .catch((error) => {
      logger.error({ err: error }, 'alerts: delivery pass failed')
      return 0
    })
    .finally(() => {
      current = null
      if (again && timer) {
        again = false
        void kickDeliveries()
      }
    })
  return current
}

export function startDeliveryWorker(): void {
  registerDefaultSenders()
  if (timer) return
  void resetStaleSending().catch((error) =>
    logger.error({ err: error }, 'alerts: resetting stale deliveries failed')
  )
  timer = setInterval(() => void kickDeliveries(), 2000)
  timer.unref()
  unsubscribe = onDeliveryQueued(() => void kickDeliveries())
  void installOutOfBandTransport()
  if (!deliveryEnabled()) {
    logger.warn('alerts: ALERTS_DELIVERY=off, deliveries are recorded but never sent')
  }
}

export async function stopDeliveryWorker(timeoutMs = 2000): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  unsubscribe?.()
  unsubscribe = null
  if (current) {
    await Promise.race([
      current,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ])
  }
}

/* ------------------------------------------------------------------ */
/* Test sends (the per-destination test buttons, WP-A3 / WP-A4)        */
/* ------------------------------------------------------------------ */

export class DeliveryTestError extends Error {
  constructor(
    readonly code: 'delivery_disabled' | 'test_rate_limited',
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
  }
}

/** One test per destination per 10 s (bounded: one entry per destination). */
const lastTest = new Map<string, number>()

/** Tests only. */
export function _resetDeliveryTests(): void {
  lastTest.clear()
}

/**
 * Sends one test notification to a destination now (10 s timeout),
 * bypassing rules, quiet hours and rate limits, and logs it as a delivery.
 * Throws `DeliveryTestError` for `ALERTS_DELIVERY=off` (409) and the
 * per-destination limit (429).
 */
export async function sendTestDelivery(
  kind: DestinationKind,
  destination: Destination
): Promise<{ delivery: AlertDelivery; result: SendResult }> {
  if (!deliveryEnabled()) {
    throw new DeliveryTestError('delivery_disabled', DELIVERY_DISABLED_ERROR)
  }
  const key = `${kind}:${destination.id}`
  const nowMs = Date.now()
  const last = lastTest.get(key)
  if (last !== undefined && nowMs - last < TEST_INTERVAL_MS) {
    const wait = Math.ceil((TEST_INTERVAL_MS - (nowMs - last)) / 1000)
    throw new DeliveryTestError('test_rate_limited', 'One test per destination per 10 s.', wait)
  }
  lastTest.set(key, nowMs)
  if (lastTest.size > 1000) lastTest.delete(lastTest.keys().next().value!)

  registerDefaultSenders()
  const now = alertNow()
  const settings = await getAlertsSettings()
  const zone = await instanceZone()
  const delivery = await createDeliveryRow(
    {
      destination: { kind, id: destination.id },
      alertId: null,
      transition: 'test',
      severity: 'info',
      status: 'sending',
      sendAfter: now,
    },
    settings,
    now
  )
  delivery.attempts = 1
  await delivery.save()
  const message = (await buildMessage(delivery, destination, { settings, zone, now }))!
  const result = await send(senderFor(kind)!, delivery, message, destination, TEST_TIMEOUT_MS)
  await recordAttempt(delivery, result, now)
  delivery.lastStatusCode = result.statusCode ?? null
  if (result.outcome === 'sent') {
    delivery.status = 'sent'
    delivery.sentAt = now
    delivery.lastError = null
    await delivery.save()
    await destinationSucceeded(kind, destination, now)
  } else {
    delivery.status = 'failed'
    delivery.lastError = result.error.slice(0, 300)
    await delivery.save()
    if (result.outcome === 'failed' && result.destinationState === 'gone' && kind === 'push') {
      ;(destination as AlertPushSubscription).state = 'gone'
      await destination.save()
    }
  }
  return { delivery, result }
}

/* ------------------------------------------------------------------ */
/* Out-of-band transport (database unreachable, delivery.md §6)        */
/* ------------------------------------------------------------------ */

type CachedDestination = { kind: DestinationKind; row: Destination }

const OOB_MAX_DESTINATIONS = 500
const OOB_RETRY_WINDOW_MS = 15 * 60_000

/**
 * The transport `detectors/out_of_band.ts` sends `system.db_unreachable`
 * through while the database is gone: a cache of the enabled destinations
 * (≤ 500 rows, secrets still encrypted; the senders decrypt at send time),
 * the type's effective rule and the active mutes, refreshed while the
 * database answers. Sends go straight to the senders (no rows), honouring
 * filters, channels and mutes as cached, retried in memory for 15 minutes.
 */
export function createOutOfBandTransport(): OutOfBandTransport {
  let destinations: CachedDestination[] = []
  let settings: AlertsSettings | null = null
  let muted = false
  let base: string | null = null

  return {
    async refresh(): Promise<void> {
      settings = await getAlertsSettings()
      base = linkBase(settings)
      const [push, webhooks] = await Promise.all([
        AlertPushSubscription.query()
          .where('enabled', true)
          .whereNot('state', 'gone')
          .limit(OOB_MAX_DESTINATIONS),
        AlertWebhook.query()
          .where('enabled', true)
          .whereNot('state', 'needs_secret')
          .limit(OOB_MAX_DESTINATIONS),
      ])
      destinations = [
        ...push.map((row) => ({ kind: 'push' as const, row })),
        ...webhooks.map((row) => ({ kind: 'webhook' as const, row })),
      ].slice(0, OOB_MAX_DESTINATIONS)
      const now = alertNow()
      const mute = await AlertMute.query()
        .where((q) => q.whereNull('until').orWhere('until', '>', sqlTime(now)))
        .where((q) => q.whereNull('type').orWhere('type', 'system.db_unreachable'))
        .where((q) => q.whereNull('subject_kind').orWhere('subject_kind', 'controller'))
        .where((q) => q.whereNotNull('type').orWhereNotNull('subject_kind'))
        .first()
      muted = Boolean(mute)
    },
    async send(message: OutOfBandMessage): Promise<void> {
      try {
        if (!settings || muted || !deliveryEnabled()) return
        const def = getAlertType(message.type)
        const rule = def ? effectiveRule(def, settings) : null
        if (!rule || !rule.enabled || !rule.notify) return
        registerDefaultSenders()
        const now = alertNow()
        for (const { kind, row } of destinations) {
          if (kind === 'push' ? !rule.push : !rule.webhooks) continue
          const filters = destinationFilters(kind, row)
          if (
            !filterMatches(filters, {
              severity: message.severity,
              category: 'system',
              type: message.type,
            })
          ) {
            continue
          }
          const delivery = new AlertDelivery()
          delivery.fill({
            alertId: null,
            destinationKind: kind,
            pushSubscriptionId: kind === 'push' ? row.id : null,
            webhookId: kind === 'webhook' ? row.id : null,
            transition: message.transition,
            status: 'sending',
            messageId: newMessageId(now),
            severity: message.severity,
            attempts: 1,
            sendAfter: now,
            expiresAt: now.plus({ minutes: 15 }),
            items: null,
          })
          const rendered: RenderedMessage = {
            deliveryId: 0,
            transition: message.transition,
            severity: message.severity,
            title: message.title,
            body: message.body,
            path: message.path,
            url: base ? `${base}${message.path}` : null,
            alert: null,
            items: null,
            event: message.type,
            badge: 0,
            redacted: kind === 'webhook' && (row as AlertWebhook).detail === 'minimal',
            instance: { name: 'Perch', url: base, controllerVersion: perchVersions().version },
          }
          void sendWithRetries(kind, delivery, rendered, row)
        }
      } catch (error) {
        logger.error({ err: error }, 'alerts: out-of-band send failed')
      }
    },
  }
}

async function sendWithRetries(
  kind: DestinationKind,
  delivery: AlertDelivery,
  message: RenderedMessage,
  destination: Destination
): Promise<void> {
  const sender = senderFor(kind)
  if (!sender) return
  const started = Date.now()
  for (let attempt = 1; Date.now() - started < OOB_RETRY_WINDOW_MS; attempt++) {
    const result = await send(sender, delivery, message, destination, TEST_TIMEOUT_MS)
    if (result.outcome !== 'retry') return
    const wait = result.retryAfterSeconds ?? jittered(backoffSeconds(attempt))
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 600) * 1000).unref())
  }
}

/** Hands the transport to the out-of-band path of the controller lifecycle (WP-A5a). */
async function installOutOfBandTransport(): Promise<void> {
  setOutOfBandTransport(createOutOfBandTransport())
  await refreshOutOfBand()
}
