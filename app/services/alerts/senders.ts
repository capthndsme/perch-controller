import type AlertDelivery from '#models/alert_delivery'
import type AlertPushSubscription from '#models/alert_push_subscription'
import type AlertWebhook from '#models/alert_webhook'
import type {
  AlertKind,
  AlertState,
  Category,
  Severity,
  SubjectKind,
  Transition,
} from '#services/alerts/model'

/**
 * The seam between the delivery worker (WP-A2) and the senders: Web Push
 * (WP-A3, `push/push_sender.ts`, the only file that imports `web-push`) and
 * webhooks (WP-A4, `webhooks/webhook_sender.ts`). docs/design/alerts/delivery.md §1.4.
 */

/** One alert as messages carry it: the Standard Webhooks `alert` object (delivery.md §2.2). */
export type MessageAlert = {
  id: number
  type: string
  category: Category
  kind: AlertKind
  state: AlertState
  severity: Severity
  flapping: boolean
  subject: { kind: SubjectKind; ref: string; label: string | null }
  firstRaisedAt: string
  openedAt: string | null
  resolvedAt: string | null
  eventCount: number
  /** Absolute link to the alert in the dashboard, or null when no link base is known. */
  url: string | null
  /** The latest payload; the type's pii fields are removed for `detail: minimal`. */
  data: Record<string, unknown> | null
}

/** What a sender sends: texts rendered on the controller, in the instance time zone. */
export type RenderedMessage = {
  deliveryId: number
  transition: Transition
  severity: Severity
  title: string
  body: string
  /** Dashboard path the notification opens: `/alerts/<id>`, `/alerts`, `/settings/notifications`. */
  path: string
  /** `path` on the link base (`dashboardUrl ?? capturedOrigin`), or null. */
  url: string | null
  /** Single-alert message: the alert (its id is the push `tag`/`Topic`). */
  alert: MessageAlert | null
  /** Group or digest: its alerts (≤ 20); null for single-alert messages and tests. */
  items: MessageAlert[] | null
  /** 'group' | 'digest' | 'test' | the alert type (webhook `X-Perch-Event`). */
  event: string
  /** Active warning + critical alerts right now (the app badge). */
  badge: number
  /** `detail: minimal` destination: texts and data without MACs, IPs, host names. */
  redacted: boolean
  instance: { name: string; url: string | null; controllerVersion: string }
}

export type SendJob = {
  /** The row (transition, severity, items, message_id, attempts). */
  delivery: AlertDelivery
  message: RenderedMessage
  destination: AlertPushSubscription | AlertWebhook
}

export type SendResult =
  | { outcome: 'sent'; statusCode: number; durationMs: number; responseExcerpt?: string }
  | {
      outcome: 'retry'
      statusCode?: number
      error: string
      retryAfterSeconds?: number
      durationMs: number
      responseExcerpt?: string
    }
  | {
      outcome: 'failed'
      statusCode?: number
      error: string
      destinationState?: 'gone' | 'failing'
      durationMs: number
      responseExcerpt?: string
    }

export interface Sender {
  kind: 'push' | 'webhook'
  send(job: SendJob): Promise<SendResult>
}

const senders = new Map<Sender['kind'], Sender>()

/** Registers the sender of a destination kind (the delivery worker registers the defaults). */
export function registerSender(sender: Sender): void {
  senders.set(sender.kind, sender)
}

export function senderFor(kind: Sender['kind']): Sender | null {
  return senders.get(kind) ?? null
}

/** Tests only: replace (or with `null`, forget) the registered senders. */
export function _setSenders(next: Partial<Record<Sender['kind'], Sender>> | null): void {
  senders.clear()
  for (const sender of Object.values(next ?? {})) if (sender) senders.set(sender.kind, sender)
}

/* The worker wakes on every new delivery (routing signals, the worker listens). */
const queuedListeners = new Set<() => void>()

export function onDeliveryQueued(listener: () => void): () => void {
  queuedListeners.add(listener)
  return () => queuedListeners.delete(listener)
}

export function signalDeliveryQueued(): void {
  for (const listener of queuedListeners) {
    try {
      listener()
    } catch {
      // A listener never breaks routing.
    }
  }
}
