import type AlertPushSubscription from '#models/alert_push_subscription'
import { alertNow } from '#services/alerts/clock'
import type { Transition } from '#services/alerts/model'
import { vapidKeys } from '#services/alerts/push/vapid'
import type { RenderedMessage, Sender, SendJob, SendResult } from '#services/alerts/senders'
import { getAlertsSettings, vapidSubjectFor } from '#services/alerts/settings'
import type { Agent } from 'node:https'
import webpush, { WebPushError } from 'web-push'

/**
 * The Web Push sender (docs/design/alerts/delivery.md §1.3–1.4), the only file
 * that imports `web-push`. It encrypts the payload (aes128gcm, RFC 8291),
 * signs the VAPID JWT and POSTs to the browser's push service; the push
 * service wakes the device and `sw.js` shows the notification.
 *
 * TTL is what is left of the delivery's lifetime (created at + the severity's
 * `pushTtlMinutes`, at most 60 min for resolved, digest and test), so a retry
 * never outlives the delivery. `Topic` (one per alert) lets the push service
 * replace an undelivered older push for the same alert: a phone offline
 * overnight gets "back online", not the outage and then the recovery.
 */

const MAX_PAYLOAD_BYTES = 3000
const TITLE_MAX = 120
const BODY_MAX = 400
const TIMEOUT_MS = 10_000
const RETRY_AFTER_MAX_SECONDS = 3600
const RENOTIFY: Transition[] = ['opened', 'escalated', 'flapping', 'reminder', 'digest', 'test']

let testAgent: Agent | null = null

/** Tests only: the HTTPS agent pushes go through (a local server with a throwaway certificate). */
export function _setPushAgent(agent: Agent | null): void {
  testAgent = agent
}

export type PushPayload = {
  v: 1
  id: number | null
  title: string
  body: string
  url: string
  tag: string
  renotify: boolean
  severity: RenderedMessage['severity']
  transition: Transition
  ts: number
  badge: number
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The plaintext (delivery.md §1.3), trimmed to fit 3000 bytes. */
export function pushPayload(message: RenderedMessage, now = alertNow()): PushPayload {
  const single = message.alert !== null
  const payload: PushPayload = {
    v: 1,
    id: message.alert?.id ?? null,
    title: cut(message.title, TITLE_MAX),
    body: cut(message.body, BODY_MAX),
    url: message.path,
    tag:
      message.transition === 'test'
        ? 'perch-test'
        : single
          ? `alert-${message.alert!.id}`
          : `group-${message.deliveryId}`,
    renotify: RENOTIFY.includes(message.transition),
    severity: message.severity,
    transition: message.transition,
    ts: now.toMillis(),
    badge: message.badge,
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) payload.body = ''
  return payload
}

function urgencyFor(message: RenderedMessage): 'high' | 'normal' | 'low' {
  if (message.transition === 'resolved' || message.transition === 'digest') return 'low'
  if (message.transition === 'test') return 'normal'
  return message.severity === 'critical'
    ? 'high'
    : message.severity === 'warning'
      ? 'normal'
      : 'low'
}

function retryAfterSeconds(headers: Record<string, unknown> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 1), RETRY_AFTER_MAX_SECONDS)
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(Math.ceil((at - Date.now()) / 1000), 1), RETRY_AFTER_MAX_SECONDS)
}

function excerpt(body: unknown): string | undefined {
  if (typeof body !== 'string' || !body) return undefined
  return body.slice(0, 512)
}

/** How a push service's answer maps onto the delivery (delivery.md §1.4 table). */
export function mapPushError(error: unknown, durationMs: number): SendResult {
  if (!(error instanceof WebPushError)) {
    const text = error instanceof Error ? error.message : String(error)
    return { outcome: 'retry', error: text.slice(0, 300) || 'push request failed', durationMs }
  }
  const status = error.statusCode
  const responseExcerpt = excerpt(error.body)
  if (status === 404 || status === 410) {
    return {
      outcome: 'failed',
      statusCode: status,
      error: `the push service no longer knows this subscription (${status})`,
      destinationState: 'gone',
      durationMs,
      responseExcerpt,
    }
  }
  if (status === 429) {
    return {
      outcome: 'retry',
      statusCode: status,
      error: 'rate limited by the push service (429)',
      retryAfterSeconds: retryAfterSeconds(error.headers as Record<string, unknown>),
      durationMs,
      responseExcerpt,
    }
  }
  if (status === 401 || status === 403) {
    return {
      outcome: 'failed',
      statusCode: status,
      error:
        `the push service refused the VAPID signature (${status}): check the VAPID key ` +
        `(rotated or restored?) and the controller's clock`,
      destinationState: 'failing',
      durationMs,
      responseExcerpt,
    }
  }
  if (status >= 500) {
    return {
      outcome: 'retry',
      statusCode: status,
      error: `push service error (${status})`,
      durationMs,
      responseExcerpt,
    }
  }
  return {
    outcome: 'failed',
    statusCode: status,
    error: `the push service refused the push (${status})${responseExcerpt ? `: ${responseExcerpt.slice(0, 200)}` : ''}`,
    durationMs,
    responseExcerpt,
  }
}

async function sendPush(job: SendJob): Promise<SendResult> {
  const started = performance.now()
  const elapsed = () => performance.now() - started
  const sub = job.destination as AlertPushSubscription
  const keys = await vapidKeys()
  if (!keys.privateKey) {
    return {
      outcome: 'failed',
      error:
        'the VAPID private key is unreadable (APP_KEY changed?): rotate the keys in Settings → Alerts',
      durationMs: elapsed(),
    }
  }
  if (sub.vapidKeyId !== keys.keyId) {
    return {
      outcome: 'failed',
      error:
        'subscribed with an older VAPID key; the browser subscribes again when the dashboard opens there',
      destinationState: 'gone',
      durationMs: elapsed(),
    }
  }
  const settings = await getAlertsSettings()
  const now = alertNow()
  const ttl = Math.max(30, Math.floor(job.delivery.expiresAt.diff(now, 'seconds').seconds))
  const payload = pushPayload(job.message, now)
  const message = job.message
  const options: webpush.RequestOptions = {
    vapidDetails: {
      subject: vapidSubjectFor(settings),
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
    TTL: ttl,
    urgency: urgencyFor(message),
    timeout: TIMEOUT_MS,
    contentEncoding: 'aes128gcm',
  }
  if (message.alert) options.topic = `a${message.alert.id.toString(36)}`
  if (testAgent) options.agent = testAgent
  const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }

  const attempt = async (body: PushPayload): Promise<SendResult> => {
    try {
      const result = await webpush.sendNotification(target, JSON.stringify(body), options)
      return {
        outcome: 'sent',
        statusCode: result.statusCode,
        durationMs: elapsed(),
        responseExcerpt: excerpt(result.body),
      }
    } catch (error) {
      return mapPushError(error, elapsed())
    }
  }

  const first = await attempt(payload)
  // 413: once more without the body (the title and the link still arrive).
  if (first.outcome === 'failed' && first.statusCode === 413 && payload.body) {
    return attempt({ ...payload, body: '' })
  }
  return first
}

export const pushSender: Sender = {
  kind: 'push',
  send: sendPush,
}
