import type Alert from '#models/alert'
import AlertDelivery from '#models/alert_delivery'
import AlertPushSubscription from '#models/alert_push_subscription'
import AlertWebhook from '#models/alert_webhook'
import { sqlTime } from '#services/alerts/clock'
import type { AlertNotifier, NotifyRequest } from '#services/alerts/engine'
import {
  filterMatches,
  normalizeFilters,
  PUSH_FILTER_DEFAULTS,
  webhookFilterDefaults,
  type Filters,
} from '#services/alerts/filters'
import { deliveryAlertIds, FLAP_END_MARK, OUTAGE_TRANSITIONS } from '#services/alerts/messages'
import type {
  AlertsSettings,
  DeliveryStatus,
  Rule,
  Severity,
  Transition,
} from '#services/alerts/model'
import { SEVERITY_RANK } from '#services/alerts/model'
import { signalDeliveryQueued } from '#services/alerts/senders'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { randomBytes } from 'node:crypto'
import type { DateTime } from 'luxon'

/**
 * Routing (docs/design/alerts/README.md §2.5, delivery.md §3–4): turns one
 * visible transition of an alert into `alert_deliveries` rows, one per
 * matching destination. The engine calls it through the `AlertNotifier` seam.
 *
 * - `maxPerHour` per type (in memory, one window per type) → inbox only.
 * - Destinations: enabled push subscriptions (not `gone`) when the rule's
 *   `push` channel is on, enabled webhooks (not `needs_secret`) when
 *   `webhooks` is on, whose filter matches. `system.delivery_failing` never
 *   goes to the destination it is about.
 * - Grouping: `opened` with `groupSeconds > 0` joins the destination's open
 *   group of that type (≤ 50 items) or starts one (`grouping` until
 *   `send_after`).
 * - Recovery (`resolved`): first collapses what is still unsent about the
 *   alert, then goes to every destination that had an outage delivery.
 * - The tick releases groups, and turns a destination's due `held` rows into
 *   one digest (two or more) or sends the single one as itself.
 * Quiet hours and the destination rate limit apply at send time (worker).
 */

export type DestinationKind = 'push' | 'webhook'

export type RoutedDestination =
  | { kind: 'push'; row: AlertPushSubscription; filters: Filters }
  | { kind: 'webhook'; row: AlertWebhook; filters: Filters }

const MAX_ITEMS = 50
const UNSENT: DeliveryStatus[] = ['queued', 'grouping', 'held', 'retrying']
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `msg_` + 26 Crockford base32 characters (time-ordered, like a ULID): the `webhook-id`. */
export function newMessageId(now: DateTime): string {
  let t = Math.max(0, Math.floor(now.toMillis()))
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time
    t = Math.floor(t / 32)
  }
  const random = [...randomBytes(16)].map((b) => B32[b % 32]).join('')
  return `msg_${time}${random}`
}

export function destinationFilters(
  kind: DestinationKind,
  row: AlertPushSubscription | AlertWebhook
) {
  return kind === 'push'
    ? normalizeFilters(row.filters, PUSH_FILTER_DEFAULTS)
    : normalizeFilters(
        row.filters,
        webhookFilterDefaults((row as AlertWebhook).format, (row as AlertWebhook).preset)
      )
}

/** When a delivery stops retrying (delivery.md §3). */
export function expiryFor(
  kind: DestinationKind,
  severity: Severity,
  transition: Transition,
  settings: Pick<AlertsSettings, 'pushTtlMinutes' | 'webhookRetryHours'>,
  now: DateTime
): DateTime {
  if (kind === 'webhook') return now.plus({ hours: settings.webhookRetryHours })
  let minutes = settings.pushTtlMinutes[severity]
  if (transition === 'resolved' || transition === 'digest' || transition === 'test') {
    minutes = Math.min(minutes, 60)
  }
  return now.plus({ minutes })
}

export type NewDelivery = {
  destination: { kind: DestinationKind; id: number }
  alertId: number | null
  transition: Transition
  severity: Severity
  status: DeliveryStatus
  sendAfter: DateTime
  groupKey?: string | null
  items?: number[] | null
  holdReason?: 'quiet_hours' | 'rate_limit' | null
}

/** Inserts one delivery row (also used for tests and digests). */
export async function createDeliveryRow(
  input: NewDelivery,
  settings: Pick<AlertsSettings, 'pushTtlMinutes' | 'webhookRetryHours'>,
  now: DateTime
): Promise<AlertDelivery> {
  return AlertDelivery.create({
    alertId: input.alertId,
    destinationKind: input.destination.kind,
    pushSubscriptionId: input.destination.kind === 'push' ? input.destination.id : null,
    webhookId: input.destination.kind === 'webhook' ? input.destination.id : null,
    transition: input.transition,
    status: input.status,
    holdReason: input.holdReason ?? null,
    groupKey: input.groupKey ?? null,
    items: input.items ?? null,
    messageId: newMessageId(now),
    severity: input.severity,
    attempts: 0,
    sendAfter: input.sendAfter,
    nextAttemptAt: input.status === 'queued' ? input.sendAfter : null,
    expiresAt: expiryFor(input.destination.kind, input.severity, input.transition, settings, now),
    lastStatusCode: null,
    lastError: null,
    sentAt: null,
    createdAt: now,
  })
}

/** Enabled destinations that can receive (push not `gone`, webhooks with readable secrets). */
export async function loadDestinations(): Promise<RoutedDestination[]> {
  const [push, webhooks] = await Promise.all([
    AlertPushSubscription.query().where('enabled', true).whereNot('state', 'gone').orderBy('id'),
    AlertWebhook.query().where('enabled', true).whereNot('state', 'needs_secret').orderBy('id'),
  ])
  return [
    ...push.map((row) => ({
      kind: 'push' as const,
      row,
      filters: destinationFilters('push', row),
    })),
    ...webhooks.map((row) => ({
      kind: 'webhook' as const,
      row,
      filters: destinationFilters('webhook', row),
    })),
  ]
}

function channelOn(kind: DestinationKind, rule: Rule): boolean {
  return kind === 'push' ? rule.push : rule.webhooks
}

/** `system.delivery_failing` never goes to the destination that is failing. */
function isSelf(alert: Alert, destination: { kind: DestinationKind; id: number }): boolean {
  if (alert.type !== 'system.delivery_failing') return false
  const payload = alert.payload ?? {}
  return (
    payload.destinationKind === destination.kind &&
    Number(payload.destinationId) === Number(destination.id)
  )
}

/* maxPerHour: one sliding window per type (bounded by the number of types). */
const hourly = new Map<string, number[]>()

function takeHourlySlot(type: string, max: number, now: DateTime): boolean {
  const since = now.toMillis() - 3_600_000
  const stamps = (hourly.get(type) ?? []).filter((t) => t > since)
  if (stamps.length >= max) {
    hourly.set(type, stamps)
    return false
  }
  stamps.push(now.toMillis())
  hourly.set(type, stamps.slice(-1000))
  return true
}

/** Tests only. */
export function _resetRoutingState(): void {
  hourly.clear()
}

async function addToGroup(
  destination: RoutedDestination,
  alert: Alert,
  rule: Rule,
  settings: AlertsSettings,
  now: DateTime
): Promise<void> {
  const groupKey = `${destination.kind}:${destination.row.id}:${alert.type}:opened`
  const open = await AlertDelivery.query()
    .where('group_key', groupKey)
    .where('status', 'grouping')
    .orderBy('id', 'desc')
    .first()
  if (open) {
    const items = deliveryAlertIds(open)
    if (items.length < MAX_ITEMS) {
      if (!items.includes(Number(alert.id))) items.push(Number(alert.id))
      open.items = items
      if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[open.severity])
        open.severity = alert.severity
      await open.save()
      return
    }
  }
  await createDeliveryRow(
    {
      destination: { kind: destination.kind, id: destination.row.id },
      alertId: Number(alert.id),
      transition: 'opened',
      severity: alert.severity,
      status: 'grouping',
      sendAfter: now.plus({ seconds: rule.groupSeconds }),
      groupKey,
      items: [Number(alert.id)],
    },
    settings,
    now
  )
}

/** The engine's notifier: route one visible transition. Returns the deliveries created. */
export async function routeNotification(request: NotifyRequest): Promise<number> {
  const { alert, rule, transition, now, settings } = request
  if (transition === 'resolved') return routeRecovery(request)
  if (rule.maxPerHour > 0 && !takeHourlySlot(alert.type, rule.maxPerHour, now)) {
    logger.info({ type: alert.type, alertId: alert.id }, 'alerts: maxPerHour reached, inbox only')
    return 0
  }
  const available = await loadDestinations()
  const destinations = available.filter(
    (d) =>
      channelOn(d.kind, rule) &&
      filterMatches(d.filters, alert) &&
      !isSelf(alert, { kind: d.kind, id: d.row.id })
  )
  let created = 0
  for (const destination of destinations) {
    if (transition === 'opened' && rule.groupSeconds > 0) {
      await addToGroup(destination, alert, rule, settings, now)
    } else {
      await createDeliveryRow(
        {
          destination: { kind: destination.kind, id: destination.row.id },
          alertId: Number(alert.id),
          transition,
          severity: alert.severity,
          status: 'queued',
          sendAfter: now,
        },
        settings,
        now
      )
    }
    created += 1
  }
  if (created > 0) signalDeliveryQueued()
  return created
}

/**
 * Recovery: collapse what is unsent about the alert, then one `resolved`
 * delivery to every destination that had an outage delivery for it.
 */
async function routeRecovery(request: NotifyRequest): Promise<number> {
  const { alert, rule, now, settings, flapEnded } = request
  const id = Number(alert.id)
  const prior = (await db
    .from('alert_deliveries')
    .whereIn('transition', [...OUTAGE_TRANSITIONS])
    .where((q) => q.where('alert_id', id).orWhereRaw('JSON_CONTAINS(items, ?)', [String(id)]))
    .select('destination_kind', 'push_subscription_id', 'webhook_id')) as Array<{
    destination_kind: DestinationKind
    push_subscription_id: number | null
    webhook_id: number | null
  }>
  await collapseUnsent(id, now)

  const pushIds = new Set<number>()
  const webhookIds = new Set<number>()
  for (const row of prior) {
    if (row.destination_kind === 'push' && row.push_subscription_id)
      pushIds.add(row.push_subscription_id)
    if (row.destination_kind === 'webhook' && row.webhook_id) webhookIds.add(row.webhook_id)
  }
  const available = await loadDestinations()
  const targets = available.filter(
    (d) =>
      channelOn(d.kind, rule) &&
      (d.kind === 'push' ? pushIds.has(d.row.id) : webhookIds.has(d.row.id))
  )
  for (const destination of targets) {
    await createDeliveryRow(
      {
        destination: { kind: destination.kind, id: destination.row.id },
        alertId: id,
        transition: 'resolved',
        severity: alert.severity,
        status: 'queued',
        sendAfter: now,
        groupKey: flapEnded ? FLAP_END_MARK : null,
      },
      settings,
      now
    )
  }
  if (targets.length > 0) signalDeliveryQueued()
  return targets.length
}

/**
 * Collapse on resolve (delivery.md §4): the alert's `opened` / `escalated` /
 * `flapping` / `reminder` deliveries not yet sent become `collapsed`; in a
 * group the alert leaves `items` (an emptied group collapses).
 */
export async function collapseUnsent(alertId: number, now: DateTime): Promise<number> {
  const rows = await AlertDelivery.query()
    .whereIn('status', UNSENT)
    .whereIn('transition', [...OUTAGE_TRANSITIONS])
    .where((q) =>
      q.where('alert_id', alertId).orWhereRaw('JSON_CONTAINS(items, ?)', [String(alertId)])
    )
  let collapsed = 0
  for (const row of rows) {
    const remaining = deliveryAlertIds(row).filter((id) => id !== Number(alertId))
    if (remaining.length === 0) {
      row.status = 'collapsed'
      row.nextAttemptAt = null
      row.lastError = 'resolved before it was sent'
      collapsed += 1
    } else {
      row.items = remaining
      row.alertId = remaining[0]
    }
    await row.save()
  }
  void now
  return collapsed
}

/**
 * Every engine tick: groups whose window passed are queued; a destination's
 * due `held` rows become one digest (two or more) or go out as themselves.
 */
export async function routingTick(now: DateTime, settings: AlertsSettings): Promise<void> {
  const at = sqlTime(now)
  const released = await db
    .from('alert_deliveries')
    .where('status', 'grouping')
    .where('send_after', '<=', at)
    .update({ status: 'queued', next_attempt_at: at, updated_at: at })

  const held = await AlertDelivery.query()
    .where('status', 'held')
    .where('send_after', '<=', at)
    .orderBy('id', 'asc')
    .limit(500)
  const byDestination = new Map<string, AlertDelivery[]>()
  for (const row of held) {
    const key = `${row.destinationKind}:${row.pushSubscriptionId ?? row.webhookId}`
    byDestination.set(key, [...(byDestination.get(key) ?? []), row])
  }
  let queued = Number(released) || 0
  for (const rows of byDestination.values()) {
    if (rows.length === 1) {
      rows[0].status = 'queued'
      rows[0].nextAttemptAt = now
      await rows[0].save()
      queued += 1
      continue
    }
    const ids: number[] = []
    for (const row of rows) {
      for (const id of deliveryAlertIds(row)) if (!ids.includes(id)) ids.push(id)
    }
    const severity = rows.reduce<Severity>(
      (max, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[max] ? r.severity : max),
      'info'
    )
    const first = rows[0]
    const digest = await createDeliveryRow(
      {
        destination: {
          kind: first.destinationKind,
          id: (first.pushSubscriptionId ?? first.webhookId) as number,
        },
        alertId: null,
        transition: 'digest',
        severity,
        status: 'queued',
        sendAfter: now,
        items: ids.slice(0, MAX_ITEMS),
        holdReason: first.holdReason,
      },
      settings,
      now
    )
    for (const row of rows) {
      row.status = 'collapsed'
      row.nextAttemptAt = null
      row.lastError = `in digest #${digest.id}`
      await row.save()
    }
    queued += 1
  }
  if (queued > 0) signalDeliveryQueued()
}

/** The engine's production notifier. */
export const routingNotifier: AlertNotifier = {
  notify: routeNotification,
  collapse: async (alertId, now) => {
    await collapseUnsent(alertId, now)
  },
  tick: (now, settings) => routingTick(now, settings),
}
