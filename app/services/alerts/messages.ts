import Alert from '#models/alert'
import type AlertDelivery from '#models/alert_delivery'
import type AlertPushSubscription from '#models/alert_push_subscription'
import type AlertWebhook from '#models/alert_webhook'
import SystemSetting from '#models/system_setting'
import { getAlertType } from '#services/alerts/catalogue/index'
import { isoOrNull } from '#services/alerts/clock'
import { renderInputFor } from '#services/alerts/engine'
import type { AlertsSettings, Category, Severity, SubjectKind } from '#services/alerts/model'
import { SEVERITY_RANK } from '#services/alerts/model'
import { hhmm, listNames, plural, renderAlert, renderGroup } from '#services/alerts/render'
import type { MessageAlert, RenderedMessage } from '#services/alerts/senders'
import { effectiveRule, linkBase } from '#services/alerts/settings'
import { perchVersions } from '#services/perch_version'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

/**
 * Renders a delivery into the message its sender sends (delivery.md §1.3,
 * §2): at send time, from the alerts' current state, in the instance time
 * zone, redacted for `detail: minimal` webhooks.
 */

export type MessageContext = { settings: AlertsSettings; zone: string; now: DateTime }

/** `group_key` marker of the recovery that ends a flapping period. */
export const FLAP_END_MARK = 'flap_end'

/** Transitions that tell a destination about an outage (their recovery says "back", not "was"). */
export const OUTAGE_TRANSITIONS = ['opened', 'escalated', 'flapping', 'reminder'] as const

const MAX_ITEMS = 20

function destinationColumn(kind: 'push' | 'webhook') {
  return kind === 'push' ? 'push_subscription_id' : 'webhook_id'
}

export function destinationIdOf(delivery: AlertDelivery): number {
  return (
    delivery.destinationKind === 'push' ? delivery.pushSubscriptionId : delivery.webhookId
  ) as number
}

/** Alert ids a delivery is about (its `alert_id` and `items`). */
export function deliveryAlertIds(delivery: Pick<AlertDelivery, 'alertId' | 'items'>): number[] {
  const ids = new Set<number>()
  if (delivery.alertId !== null && delivery.alertId !== undefined) ids.add(Number(delivery.alertId))
  for (const id of delivery.items ?? []) ids.add(Number(id))
  return [...ids]
}

/** Did this destination receive an outage notification for the alert? (per-destination `wasNotified`) */
export async function destinationWasNotified(
  alertId: number,
  kind: 'push' | 'webhook',
  destinationId: number
): Promise<boolean> {
  const row = await db
    .from('alert_deliveries')
    .where(destinationColumn(kind), destinationId)
    .where('status', 'sent')
    .whereIn('transition', [...OUTAGE_TRANSITIONS])
    .where((q) =>
      q.where('alert_id', alertId).orWhereRaw('JSON_CONTAINS(items, ?)', [String(alertId)])
    )
    .select('id')
    .first()
  return Boolean(row)
}

export async function activeBadge(): Promise<number> {
  const row = await db
    .from('alerts')
    .where('state', 'active')
    .whereIn('severity', ['warning', 'critical'])
    .count('* as n')
    .first()
  return Number(row?.n ?? 0)
}

function redactData(
  data: Record<string, unknown> | null,
  pii: string[] | undefined,
  redact: boolean
): Record<string, unknown> | null {
  if (!data || !redact || !pii || pii.length === 0) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) if (!pii.includes(key)) out[key] = value
  return out
}

export function messageAlert(alert: Alert, base: string | null, redact: boolean): MessageAlert {
  const def = getAlertType(alert.type)
  return {
    id: Number(alert.id),
    type: alert.type,
    category: alert.category as Category,
    kind: alert.kind,
    state: alert.state,
    severity: alert.severity,
    flapping: alert.flapping,
    subject: {
      kind: alert.subjectKind as SubjectKind,
      ref: alert.subjectRef,
      label: redact && alert.subjectKind === 'device' ? null : alert.subjectLabel,
    },
    firstRaisedAt: isoOrNull(alert.firstRaisedAt)!,
    openedAt: isoOrNull(alert.openedAt),
    resolvedAt: isoOrNull(alert.resolvedAt),
    eventCount: alert.eventCount,
    url: base ? `${base}/alerts/${alert.id}` : null,
    data: redactData(alert.payload, def?.pii, redact),
  }
}

async function siteName(): Promise<string> {
  const name = await SystemSetting.get<string>('site_name')
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'Perch'
}

function maxSeverity(values: Severity[]): Severity {
  return values.reduce<Severity>(
    (max, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[max] ? s : max),
    'info'
  )
}

/**
 * The message of one delivery to one destination, or null when there is
 * nothing left to say (its alerts were deleted).
 */
export async function buildMessage(
  delivery: AlertDelivery,
  destination: AlertPushSubscription | AlertWebhook,
  ctx: MessageContext
): Promise<RenderedMessage | null> {
  const redact =
    delivery.destinationKind === 'webhook' && (destination as AlertWebhook).detail === 'minimal'
  const base = linkBase(ctx.settings)
  const common = {
    deliveryId: Number(delivery.id),
    transition: delivery.transition,
    redacted: redact,
    badge: await activeBadge(),
    instance: {
      name: await siteName(),
      url: base,
      controllerVersion: perchVersions().version,
    },
  }
  const link = (path: string) => (base ? `${base}${path}` : null)

  if (delivery.transition === 'test') {
    return {
      ...common,
      severity: delivery.severity,
      title: 'Test notification from Perch',
      body: `Sent at ${hhmm(ctx.now, ctx.zone)}. Notifications to this destination work.`,
      path: '/settings/notifications',
      url: link('/settings/notifications'),
      alert: null,
      items: null,
      event: 'test',
    }
  }

  const ids = deliveryAlertIds(delivery)
  if (ids.length === 0) return null
  const alerts = await Alert.query().whereIn('id', ids)
  if (alerts.length === 0) return null
  alerts.sort((a, b) => ids.indexOf(Number(a.id)) - ids.indexOf(Number(b.id)))

  if (delivery.transition === 'digest') {
    const active = alerts.filter((a) => a.state === 'active' || a.state === 'pending')
    const resolved = alerts.filter((a) => a.state === 'resolved')
    const other = alerts.filter((a) => a.state === 'posted')
    const names = (list: Alert[]) =>
      listNames(
        list.map((a) => a.title),
        3
      )
    const parts: string[] = []
    if (active.length)
      parts.push(`${plural(active.length, 'alert', 'alerts')} still active (${names(active)})`)
    if (resolved.length) parts.push(`${resolved.length} resolved (${names(resolved)})`)
    if (other.length) parts.push(`${plural(other.length, 'notice', 'notices')} (${names(other)})`)
    const count = plural(alerts.length, 'alert', 'alerts')
    return {
      ...common,
      severity: maxSeverity(alerts.map((a) => a.severity)),
      title:
        delivery.holdReason === 'rate_limit'
          ? `${count} held back (too many notifications)`
          : `While quiet hours were on: ${count}`,
      body: `${parts.join('; ')}.`,
      path: '/alerts',
      url: link('/alerts'),
      alert: null,
      items: alerts.slice(0, MAX_ITEMS).map((a) => messageAlert(a, base, redact)),
      event: 'digest',
    }
  }

  const first = alerts[0]
  const def = getAlertType(first.type)
  const renderCtx = {
    transition: delivery.transition,
    wasNotified: true,
    redact,
    zone: ctx.zone,
    now: ctx.now,
    flapEnded: delivery.groupKey === FLAP_END_MARK,
    windowMinutes: def ? effectiveRule(def, ctx.settings).flapWindowMinutes : undefined,
  }

  if (alerts.length > 1) {
    const text = renderGroup(
      def,
      alerts.map((a) => renderInputFor(a)),
      renderCtx
    )
    return {
      ...common,
      severity: maxSeverity(alerts.map((a) => a.severity)),
      title: text.title,
      body: text.body,
      path: '/alerts',
      url: link('/alerts'),
      alert: null,
      items: alerts.slice(0, MAX_ITEMS).map((a) => messageAlert(a, base, redact)),
      event: 'group',
    }
  }

  if (delivery.transition === 'resolved') {
    renderCtx.wasNotified = await destinationWasNotified(
      Number(first.id),
      delivery.destinationKind,
      destinationIdOf(delivery)
    )
  }
  const text = renderAlert(def, renderInputFor(first), renderCtx)
  const path = `/alerts/${first.id}`
  return {
    ...common,
    severity: delivery.severity,
    title: text.title,
    body: text.body,
    path,
    url: link(path),
    alert: messageAlert(first, base, redact),
    items: null,
    event: first.type,
  }
}
