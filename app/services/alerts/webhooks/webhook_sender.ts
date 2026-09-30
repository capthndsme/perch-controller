import type AlertWebhook from '#models/alert_webhook'
import { alertNow } from '#services/alerts/clock'
import type { Sender, SendJob, SendResult } from '#services/alerts/senders'
import { readSecrets } from '#services/alerts/webhooks/destinations'
import { buildWebhookRequest, type WebhookOptions } from '#services/alerts/webhooks/formats'
import { networkError, postJson, retryAfter, type HttpAnswer } from '#services/alerts/webhooks/http'

/**
 * The webhook sender (docs/design/alerts/delivery.md §2): decrypts the
 * destination, builds its format's request and maps the answer. 2xx = sent;
 * 408, 425, 429, 5xx, timeouts, DNS and connection errors = retry (honouring
 * `Retry-After`, Discord's and Telegram's `retry_after`); a 3xx or any other
 * 4xx = failed. Unreadable ciphertext (APP_KEY changed) marks the row
 * `needs_secret` and fails without a request.
 */

const RETRY_STATUSES = new Set([408, 425, 429])

function excerptOf(answer: HttpAnswer): string {
  return answer.text.slice(0, 512)
}

function jsonOf(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** How an answer maps onto the delivery; exported for the tests. */
export function mapWebhookAnswer(format: AlertWebhook['format'], answer: HttpAnswer): SendResult {
  const { status } = answer
  const durationMs = answer.durationMs
  const responseExcerpt = excerptOf(answer)

  if (format === 'telegram') {
    const body = jsonOf(answer.text)
    if (status >= 200 && status < 300 && body?.ok === true) {
      return { outcome: 'sent', statusCode: status, durationMs, responseExcerpt }
    }
    const params = body?.parameters as { retry_after?: unknown } | undefined
    const description = typeof body?.description === 'string' ? body.description : `HTTP ${status}`
    if (typeof params?.retry_after === 'number' || status >= 500 || status === 429) {
      return {
        outcome: 'retry',
        statusCode: status,
        error: `Telegram: ${description}`.slice(0, 300),
        retryAfterSeconds:
          typeof params?.retry_after === 'number'
            ? retryAfter(String(params.retry_after))
            : undefined,
        durationMs,
        responseExcerpt,
      }
    }
    return {
      outcome: 'failed',
      statusCode: status,
      error: `Telegram: ${description}`.slice(0, 300),
      durationMs,
      responseExcerpt,
    }
  }

  if (status >= 200 && status < 300) {
    return { outcome: 'sent', statusCode: status, durationMs, responseExcerpt }
  }
  if (status >= 300 && status < 400) {
    return {
      outcome: 'failed',
      statusCode: status,
      error:
        `redirect (${status}) to ${answer.headers.get('location') ?? 'elsewhere'}: redirects are not followed, use the final URL`.slice(
          0,
          300
        ),
      durationMs,
      responseExcerpt,
    }
  }
  if (RETRY_STATUSES.has(status) || status >= 500) {
    let wait = retryAfter(answer.headers.get('retry-after'))
    if (format === 'discord' && status === 429) {
      const body = jsonOf(answer.text)
      if (typeof body?.retry_after === 'number') wait = retryAfter(String(body.retry_after))
    }
    return {
      outcome: 'retry',
      statusCode: status,
      error: `HTTP ${status}`,
      retryAfterSeconds: wait,
      durationMs,
      responseExcerpt,
    }
  }
  return {
    outcome: 'failed',
    statusCode: status,
    error: `HTTP ${status}${responseExcerpt ? `: ${responseExcerpt.slice(0, 200)}` : ''}`.slice(
      0,
      300
    ),
    durationMs,
    responseExcerpt,
  }
}

async function sendWebhook(job: SendJob): Promise<SendResult> {
  const started = performance.now()
  const row = job.destination as AlertWebhook
  const secrets = readSecrets(row)
  if (!secrets) {
    row.state = 'needs_secret'
    return {
      outcome: 'failed',
      error: 'the URL, auth or secret is unreadable (APP_KEY changed?): enter them again',
      durationMs: performance.now() - started,
    }
  }
  let request
  try {
    request = buildWebhookRequest({
      format: row.format,
      url: secrets.url,
      auth: secrets.auth,
      options: (row.options ?? {}) as WebhookOptions,
      secret: row.format === 'standard' ? secrets.secret : null,
      message: job.message,
      messageId: job.delivery.messageId,
      now: alertNow().toJSDate(),
    })
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      durationMs: performance.now() - started,
    }
  }
  try {
    const answer = await postJson(request.url, request.body, request.headers)
    return mapWebhookAnswer(row.format, answer)
  } catch (error) {
    return { outcome: 'retry', error: networkError(error), durationMs: performance.now() - started }
  }
}

export const webhookSender: Sender = {
  kind: 'webhook',
  send: sendWebhook,
}
