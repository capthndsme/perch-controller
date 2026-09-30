import type AlertDelivery from '#models/alert_delivery'
import type AlertDeliveryAttempt from '#models/alert_delivery_attempt'
import AlertPushSubscription from '#models/alert_push_subscription'
import AlertWebhook, { type WebhookFormat } from '#models/alert_webhook'
import { isoOrNull } from '#services/alerts/clock'
import type { DeliveryStatus, Severity, Transition } from '#services/alerts/model'

/** Wire shapes of the delivery log (docs/design/alerts/api.md §2). */

export type DestinationRef =
  | { kind: 'push'; id: number; label: string; platform: string | null; userId: number }
  | { kind: 'webhook'; id: number; name: string; format: WebhookFormat }

export type DeliveryView = {
  id: number
  alertId: number | null
  alertIds: number[]
  destination: DestinationRef | null
  transition: Transition
  status: DeliveryStatus
  holdReason: 'quiet_hours' | 'rate_limit' | null
  severity: Severity
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  createdAt: string
  sendAfter: string
  nextAttemptAt: string | null
  expiresAt: string
  sentAt: string | null
}

export type AttemptView = {
  attemptedAt: string
  durationMs: number
  statusCode: number | null
  outcome: 'sent' | 'retry' | 'failed'
  error: string | null
  responseExcerpt: string | null
}

const FINAL: DeliveryStatus[] = ['sent', 'failed', 'expired', 'collapsed']

export type DestinationMaps = {
  push: Map<number, AlertPushSubscription>
  webhooks: Map<number, AlertWebhook>
}

/** The destinations a list of deliveries refers to, loaded in two queries. */
export async function loadDestinations(deliveries: AlertDelivery[]): Promise<DestinationMaps> {
  const pushIds = [
    ...new Set(
      deliveries.map((d) => d.pushSubscriptionId).filter((id): id is number => id !== null)
    ),
  ]
  const webhookIds = [
    ...new Set(deliveries.map((d) => d.webhookId).filter((id): id is number => id !== null)),
  ]
  const push = new Map<number, AlertPushSubscription>()
  const webhooks = new Map<number, AlertWebhook>()
  if (pushIds.length > 0) {
    for (const s of await AlertPushSubscription.query().whereIn('id', pushIds)) push.set(s.id, s)
  }
  if (webhookIds.length > 0) {
    for (const w of await AlertWebhook.query().whereIn('id', webhookIds)) webhooks.set(w.id, w)
  }
  return { push, webhooks }
}

export function destinationRef(
  delivery: Pick<AlertDelivery, 'destinationKind' | 'pushSubscriptionId' | 'webhookId'>,
  maps: DestinationMaps
): DestinationRef | null {
  if (delivery.destinationKind === 'push' && delivery.pushSubscriptionId !== null) {
    const s = maps.push.get(delivery.pushSubscriptionId)
    return s
      ? {
          kind: 'push',
          id: s.id,
          label: s.label ?? s.platform ?? `Device ${s.id}`,
          platform: s.platform,
          userId: s.userId,
        }
      : null
  }
  if (delivery.destinationKind === 'webhook' && delivery.webhookId !== null) {
    const w = maps.webhooks.get(delivery.webhookId)
    return w ? { kind: 'webhook', id: w.id, name: w.name, format: w.format } : null
  }
  return null
}

export function deliveryView(delivery: AlertDelivery, maps: DestinationMaps): DeliveryView {
  const items = Array.isArray(delivery.items) ? delivery.items.map(Number) : []
  const alertIds =
    delivery.alertId !== null && !items.includes(Number(delivery.alertId))
      ? [Number(delivery.alertId), ...items]
      : items.length > 0
        ? items
        : delivery.alertId !== null
          ? [Number(delivery.alertId)]
          : []
  return {
    id: Number(delivery.id),
    alertId: delivery.alertId === null ? null : Number(delivery.alertId),
    alertIds,
    destination: destinationRef(delivery, maps),
    transition: delivery.transition,
    status: delivery.status,
    holdReason: delivery.holdReason,
    severity: delivery.severity,
    attempts: delivery.attempts,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    createdAt: isoOrNull(delivery.createdAt)!,
    sendAfter: isoOrNull(delivery.sendAfter)!,
    nextAttemptAt: FINAL.includes(delivery.status) ? null : isoOrNull(delivery.nextAttemptAt),
    expiresAt: isoOrNull(delivery.expiresAt)!,
    sentAt: isoOrNull(delivery.sentAt),
  }
}

export function attemptView(attempt: AlertDeliveryAttempt): AttemptView {
  return {
    attemptedAt: isoOrNull(attempt.attemptedAt)!,
    durationMs: attempt.durationMs,
    statusCode: attempt.statusCode,
    outcome: attempt.outcome,
    error: attempt.error,
    responseExcerpt: attempt.responseExcerpt,
  }
}
