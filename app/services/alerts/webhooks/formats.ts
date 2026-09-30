import type { WebhookFormat } from '#models/alert_webhook'
import type { Severity } from '#services/alerts/model'
import type { RenderedMessage } from '#services/alerts/senders'
import { Webhook } from 'standardwebhooks'

/**
 * What each webhook format sends (docs/design/alerts/delivery.md §2.2–2.7):
 * one POST with a JSON body, built from the rendered message. `standard` is
 * the generic JSON body signed per Standard Webhooks (also the Home Assistant
 * preset); the others speak the receiving service's own API.
 */

export type WebhookAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string }
  | { type: 'gotify'; token: string }
  | { type: 'telegram'; botToken: string }

export type WebhookOptions = {
  chatId?: string
  messageThreadId?: number
  username?: string
  topic?: string
}

export type WebhookRequest = { url: string; body: string; headers: Record<string, string> }

export type BuildInput = {
  format: WebhookFormat
  /** The stored URL (unused for telegram, whose URL carries the bot token). */
  url: string
  auth: WebhookAuth
  options: WebhookOptions
  /** `whsec_…` for a signed `standard` webhook, else null. */
  secret: string | null
  message: RenderedMessage
  /** `alert_deliveries.message_id`: the same on every retry (`webhook-id`). */
  messageId: string
  now: Date
}

/** Which auth types each format takes; the first is required when `required`. */
export const FORMAT_AUTH: Record<
  WebhookFormat,
  { types: WebhookAuth['type'][]; required: boolean }
> = {
  standard: { types: ['none', 'bearer', 'basic', 'header'], required: false },
  ntfy: { types: ['none', 'bearer', 'basic'], required: false },
  gotify: { types: ['gotify'], required: true },
  discord: { types: ['none'], required: false },
  slack: { types: ['none'], required: false },
  telegram: { types: ['telegram'], required: true },
}

type Tone = Severity | 'resolved'

function tone(message: RenderedMessage): Tone {
  return message.transition === 'resolved' ? 'resolved' : message.severity
}

function quiet(message: RenderedMessage): boolean {
  return (
    message.severity === 'info' ||
    message.transition === 'resolved' ||
    message.transition === 'digest'
  )
}

function cutChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Cut to at most `max` UTF-8 bytes without splitting a character. */
export function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let out = ''
  let size = 0
  for (const ch of text) {
    const n = Buffer.byteLength(ch)
    if (size + n > max - 3) break
    out += ch
    size += n
  }
  return `${out}…`
}

function authHeaders(auth: WebhookAuth): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` }
    case 'basic':
      return {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
      }
    case 'header':
      return { [auth.name]: auth.value }
    case 'gotify':
      return { 'X-Gotify-Key': auth.token }
    default:
      return {}
  }
}

/* ------------------------------------------------------------------ */

function standard(input: BuildInput): WebhookRequest {
  const { message } = input
  const body = JSON.stringify({
    version: 1,
    id: input.messageId,
    transition: message.transition,
    sentAt: input.now.toISOString(),
    instance: message.instance,
    message: {
      title: message.title,
      body: message.body,
      url: message.url,
      severity: message.severity,
    },
    alert: message.alert,
    items: message.items,
  })
  const headers: Record<string, string> = {
    'webhook-id': input.messageId,
    'webhook-timestamp': String(Math.floor(input.now.getTime() / 1000)),
    'X-Perch-Event': message.event,
    'X-Perch-Transition': message.transition,
    ...authHeaders(input.auth),
  }
  if (input.secret) {
    headers['webhook-signature'] = new Webhook(input.secret).sign(input.messageId, input.now, body)
  }
  return { url: input.url, body, headers }
}

const NTFY_PRIORITY: Record<Tone, number> = { critical: 5, warning: 4, info: 3, resolved: 3 }
const NTFY_TAG: Record<Tone, string> = {
  critical: 'rotating_light',
  warning: 'warning',
  info: 'information_source',
  resolved: 'white_check_mark',
}

/** `https://ntfy.sh/perch-x7k2` → server root `https://ntfy.sh/` and topic `perch-x7k2`. */
export function ntfyTarget(topicUrl: string): { root: string; topic: string } | null {
  try {
    const url = new URL(topicUrl)
    const segments = url.pathname.split('/').filter(Boolean)
    const topic = segments.pop()
    if (!topic) return null
    url.pathname = segments.length ? `/${segments.join('/')}/` : '/'
    url.search = ''
    url.hash = ''
    return { root: url.toString(), topic: decodeURIComponent(topic) }
  } catch {
    return null
  }
}

function ntfy(input: BuildInput): WebhookRequest {
  const { message } = input
  const target = ntfyTarget(input.url)
  if (!target) throw new Error('the ntfy URL has no topic')
  const t = tone(message)
  const payload: Record<string, unknown> = {
    topic: target.topic,
    title: message.title,
    message: cutBytes(message.body || message.title, 4000),
    priority: message.transition === 'digest' ? 3 : NTFY_PRIORITY[t],
    tags: [NTFY_TAG[t]],
  }
  if (message.url) payload.click = message.url
  return { url: target.root, body: JSON.stringify(payload), headers: authHeaders(input.auth) }
}

const GOTIFY_PRIORITY: Record<Tone, number> = { critical: 8, warning: 5, info: 2, resolved: 2 }

function gotify(input: BuildInput): WebhookRequest {
  const { message } = input
  const payload: Record<string, unknown> = {
    title: message.title,
    message: message.body || message.title,
    priority: message.transition === 'digest' ? 2 : GOTIFY_PRIORITY[tone(message)],
  }
  if (message.url) payload.extras = { 'client::notification': { click: { url: message.url } } }
  return {
    url: `${input.url.replace(/\/+$/, '')}/message`,
    body: JSON.stringify(payload),
    headers: authHeaders(input.auth),
  }
}

const DISCORD_COLOR: Record<Tone, number> = {
  critical: 14427686,
  warning: 16096779,
  info: 3900150,
  resolved: 1483594,
}

function discord(input: BuildInput): WebhookRequest {
  const { message } = input
  const url = new URL(input.url)
  url.searchParams.set('wait', 'true')
  const embed: Record<string, unknown> = {
    title: cutChars(message.title, 256),
    description: cutChars(message.body, 4096),
    color: DISCORD_COLOR[tone(message)],
    timestamp: input.now.toISOString(),
    footer: {
      text: `${message.instance.name} · ${message.transition === 'resolved' ? 'resolved' : message.severity}`,
    },
  }
  if (message.url) embed.url = message.url
  return {
    url: url.toString(),
    body: JSON.stringify({
      username: input.options.username || 'Perch',
      allowed_mentions: { parse: [] },
      embeds: [embed],
    }),
    headers: {},
  }
}

function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function slack(input: BuildInput): WebhookRequest {
  const { message } = input
  const title = slackEscape(message.title)
  const body = slackEscape(message.body)
  const heading = message.url ? `*<${message.url}|${title}>*` : `*${title}*`
  const level = message.transition === 'resolved' ? 'resolved' : message.severity
  return {
    url: input.url,
    body: JSON.stringify({
      text: body ? `${title}: ${body}` : title,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: body ? `${heading}\n${body}` : heading } },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Perch · ${slackEscape(message.instance.name)} · ${level}` },
          ],
        },
      ],
    }),
    headers: {},
  }
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function telegramUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`
}

function telegram(input: BuildInput): WebhookRequest {
  const { message, auth, options } = input
  if (auth.type !== 'telegram') throw new Error('telegram needs a bot token')
  if (!options.chatId) throw new Error('telegram needs a chat id')
  const link = message.url ? `\n<a href="${htmlEscape(message.url)}">Open in Perch</a>` : ''
  let text = `<b>${htmlEscape(message.title)}</b>`
  if (message.body) text += `\n${htmlEscape(message.body)}`
  // Cut the text, never the link or an entity in half.
  const room = 4096 - link.length
  if (text.length > room) text = text.slice(0, room - 1).replace(/&[a-z]*$/i, '') + '…'
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    text: text + link,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    disable_notification: quiet(message),
  }
  if (options.messageThreadId) payload.message_thread_id = options.messageThreadId
  return { url: telegramUrl(auth.botToken), body: JSON.stringify(payload), headers: {} }
}

const BUILDERS: Record<WebhookFormat, (input: BuildInput) => WebhookRequest> = {
  standard,
  ntfy,
  gotify,
  discord,
  slack,
  telegram,
}

export function buildWebhookRequest(input: BuildInput): WebhookRequest {
  return BUILDERS[input.format](input)
}
