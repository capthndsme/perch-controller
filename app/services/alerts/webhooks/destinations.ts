import type AlertWebhook from '#models/alert_webhook'
import { type WebhookFormat } from '#models/alert_webhook'
import { isoOrNull } from '#services/alerts/clock'
import {
  mergeFilters,
  normalizeFilters,
  webhookFilterDefaults,
  type Filters,
} from '#services/alerts/filters'
import {
  FORMAT_AUTH,
  ntfyTarget,
  type WebhookAuth,
  type WebhookOptions,
} from '#services/alerts/webhooks/formats'
import encryption from '@adonisjs/core/services/encryption'
import { randomBytes } from 'node:crypto'

/**
 * Webhook destinations (docs/design/alerts/api.md §3.6): checks, the
 * encrypted columns and the wire view. The URL (its path is often the
 * credential), the auth and the signing secret are stored APP_KEY-encrypted
 * and never returned; `url_display` is a masked form for the list. A row
 * whose ciphertext APP_KEY can no longer read is `needs_secret` until an admin
 * enters the URL and auth again.
 */

export type WebhookPreset =
  | 'generic'
  | 'homeassistant'
  | 'ntfy'
  | 'gotify'
  | 'discord'
  | 'slack'
  | 'telegram'

export const WEBHOOK_PRESETS: WebhookPreset[] = [
  'generic',
  'homeassistant',
  'ntfy',
  'gotify',
  'discord',
  'slack',
  'telegram',
]

export type WebhookView = {
  id: number
  name: string
  format: WebhookFormat
  preset: WebhookPreset
  urlDisplay: string
  signed: boolean
  auth: {
    type: WebhookAuth['type']
    username?: string
    headerName?: string
  }
  options: WebhookOptions
  filters: Filters
  detail: 'full' | 'minimal'
  respectQuietHours: boolean
  enabled: boolean
  state: 'active' | 'failing' | 'needs_secret'
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

/** Decrypted secrets of one row, or null when APP_KEY cannot read them. */
export type WebhookSecrets = { url: string; auth: WebhookAuth; secret: string | null }

export class WebhookInputError extends Error {
  constructor(
    readonly code: 'webhook_url_invalid' | 'webhook_auth_invalid' | 'webhook_options_invalid',
    message: string
  ) {
    super(message)
  }
}

function decrypt<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return encryption.decrypt<T>(value) ?? null
  } catch {
    return null
  }
}

export function readSecrets(row: AlertWebhook): WebhookSecrets | null {
  const url = decrypt<string>(row.urlEncrypted)
  if (url === null) return null
  const auth = row.authEncrypted
    ? decrypt<WebhookAuth>(row.authEncrypted)
    : { type: 'none' as const }
  if (!auth) return null
  let secret: string | null = null
  if (row.secretEncrypted) {
    secret = decrypt<string>(row.secretEncrypted)
    if (secret === null) return null
  }
  return { url, auth, secret }
}

/** Standard Webhooks secret: `whsec_` + base64 of 24 random bytes. */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`
}

/** `https://discord.com/api/webhooks/1234…/••••`: scheme, host and a hint of the path. */
export function webhookUrlDisplay(
  format: WebhookFormat,
  url: string,
  options: WebhookOptions
): string {
  if (format === 'telegram') return `telegram · chat ${options.chatId ?? '?'}`.slice(0, 160)
  try {
    const u = new URL(url)
    const segments = u.pathname.split('/').filter(Boolean)
    if (format === 'ntfy' || format === 'gotify') {
      // The topic name is the ntfy credential; gotify's base URL carries none.
      const shown = format === 'ntfy' ? segments.slice(0, -1) : segments
      const tail = format === 'ntfy' && segments.length ? '/••••' : ''
      return `${u.protocol}//${u.host}${shown.length ? `/${shown.join('/')}` : ''}${tail}`.slice(
        0,
        160
      )
    }
    if (segments.length === 0) return `${u.protocol}//${u.host}`.slice(0, 160)
    const keep = segments.slice(0, Math.max(0, segments.length - 1))
    const hint = keep.length ? `/${keep.join('/')}` : ''
    return `${u.protocol}//${u.host}${hint.length > 60 ? `${hint.slice(0, 59)}…` : hint}/••••`.slice(
      0,
      160
    )
  } catch {
    return '••••'
  }
}

/** http(s), ≤ 2048, no userinfo; ntfy needs a topic in the path. */
export function checkWebhookUrl(format: WebhookFormat, url: string | undefined): string {
  if (format === 'telegram') return ''
  if (!url) throw new WebhookInputError('webhook_url_invalid', 'This format needs a URL.')
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new WebhookInputError('webhook_url_invalid', 'Expected an http(s) URL.')
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new WebhookInputError('webhook_url_invalid', 'Expected an http(s) URL.')
  }
  if (u.username || u.password) {
    throw new WebhookInputError(
      'webhook_url_invalid',
      'Put credentials in the auth fields, not in the URL.'
    )
  }
  if (url.length > 2048) throw new WebhookInputError('webhook_url_invalid', 'The URL is too long.')
  if (format === 'ntfy' && !ntfyTarget(url)) {
    throw new WebhookInputError(
      'webhook_url_invalid',
      'Use the topic URL from the ntfy app, like https://ntfy.sh/perch-x7k2m9q4.'
    )
  }
  return url
}

const TOKEN_CHARS = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_HEADERS = /^(host|content-.*|transfer-encoding|connection|webhook-.*|x-perch-.*)$/i

export function checkWebhookAuth(
  format: WebhookFormat,
  auth: WebhookAuth | undefined
): WebhookAuth {
  const allowed = FORMAT_AUTH[format]
  const value = auth ?? { type: 'none' as const }
  if (!allowed.types.includes(value.type)) {
    throw new WebhookInputError(
      'webhook_auth_invalid',
      allowed.required
        ? `The ${format} format needs auth type ${allowed.types[0]}.`
        : `The ${format} format takes auth ${allowed.types.join(', ')}.`
    )
  }
  if (
    value.type === 'header' &&
    (!TOKEN_CHARS.test(value.name) || FORBIDDEN_HEADERS.test(value.name))
  ) {
    throw new WebhookInputError(
      'webhook_auth_invalid',
      'The header name must be a plain token and not Host, Content-*, webhook-* or X-Perch-*.'
    )
  }
  if (value.type === 'header' && /[\r\n]/.test(value.value)) {
    throw new WebhookInputError('webhook_auth_invalid', 'The header value has a line break.')
  }
  if (value.type === 'telegram' && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(value.botToken)) {
    throw new WebhookInputError(
      'webhook_auth_invalid',
      'Expected a bot token from @BotFather, like 123456:ABC-DEF….'
    )
  }
  return value
}

export function checkWebhookOptions(
  format: WebhookFormat,
  url: string,
  options: WebhookOptions | undefined
): WebhookOptions {
  const out: WebhookOptions = {}
  if (format === 'telegram') {
    const chatId = options?.chatId?.trim()
    if (!chatId || !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(chatId)) {
      throw new WebhookInputError(
        'webhook_options_invalid',
        'Telegram needs a chat id: a number, or @channelname.'
      )
    }
    out.chatId = chatId
    if (options?.messageThreadId) out.messageThreadId = options.messageThreadId
  }
  if (format === 'discord' && options?.username) out.username = options.username.slice(0, 80)
  if (format === 'ntfy') out.topic = ntfyTarget(url)?.topic
  return out
}

export function presetOf(row: Pick<AlertWebhook, 'format' | 'preset'>): WebhookPreset {
  if (row.preset && (WEBHOOK_PRESETS as string[]).includes(row.preset)) {
    const preset = row.preset as WebhookPreset
    // A preset that no longer fits the format (the format changed) falls back.
    if (preset === 'homeassistant' || preset === 'generic') {
      if (row.format === 'standard') return preset
    } else if (preset === row.format) {
      return preset
    }
  }
  return row.format === 'standard' ? 'generic' : (row.format as WebhookPreset)
}

export function webhookFilters(row: Pick<AlertWebhook, 'format' | 'preset' | 'filters'>): Filters {
  return normalizeFilters(row.filters, webhookFilterDefaults(row.format, row.preset))
}

export function webhookView(row: AlertWebhook): WebhookView {
  const secrets = readSecrets(row)
  const auth = secrets?.auth ?? { type: 'none' as const }
  const authView: WebhookView['auth'] = { type: auth.type }
  if (auth.type === 'basic') authView.username = auth.username
  if (auth.type === 'header') authView.headerName = auth.name
  const options = (row.options ?? {}) as WebhookOptions
  const filters = webhookFilters(row)
  return {
    id: Number(row.id),
    name: row.name,
    format: row.format,
    preset: presetOf(row),
    urlDisplay: row.urlDisplay,
    signed: row.format === 'standard' && Boolean(row.secretEncrypted),
    auth: authView,
    options: {
      ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
      ...(options.messageThreadId !== undefined
        ? { messageThreadId: options.messageThreadId }
        : {}),
      ...(options.username !== undefined ? { username: options.username } : {}),
      ...(options.topic !== undefined ? { topic: options.topic } : {}),
    },
    filters,
    detail: row.detail,
    respectQuietHours: filters.quietHours === 'inherit',
    enabled: row.enabled,
    state: secrets ? row.state : 'needs_secret',
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: isoOrNull(row.lastSuccessAt),
    lastFailureAt: isoOrNull(row.lastFailureAt),
    lastError: row.lastError,
    createdAt: isoOrNull(row.createdAt)!,
    updatedAt: isoOrNull(row.updatedAt ?? row.createdAt)!,
  }
}

export type WebhookInput = {
  name?: string
  format?: WebhookFormat
  preset?: WebhookPreset
  url?: string
  auth?: WebhookAuth
  options?: WebhookOptions
  filters?: Partial<Filters>
  detail?: 'full' | 'minimal'
  respectQuietHours?: boolean
  enabled?: boolean
}

/**
 * Applies a create or update body to a row (not saved). Returns the new
 * signing secret when one was made (a new `standard` webhook), else null.
 * On update, `url` and `auth` change only when present; a format change needs
 * the URL again (and the auth where the format requires one). A row becoming
 * `standard` starts unsigned (rotate-secret signs it and shows the secret);
 * one leaving `standard` drops its secret.
 */
export function applyWebhookInput(
  row: AlertWebhook,
  input: WebhookInput,
  mode: 'create' | 'update'
): string | null {
  const creating = mode === 'create'
  const previous = creating ? null : readSecrets(row)
  const format = input.format ?? row.format
  const formatChanged = !creating && input.format !== undefined && input.format !== row.format
  if (formatChanged && format !== 'telegram' && input.url === undefined) {
    throw new WebhookInputError('webhook_url_invalid', 'Changing the format needs the URL again.')
  }
  if (!creating && !previous && input.url === undefined && format !== 'telegram') {
    throw new WebhookInputError(
      'webhook_url_invalid',
      'The stored URL is unreadable (APP_KEY changed): enter it again.'
    )
  }
  const preset = input.preset
  if (preset === 'homeassistant' && format !== 'standard') {
    throw new WebhookInputError(
      'webhook_options_invalid',
      'The Home Assistant preset uses format standard.'
    )
  }

  const url =
    creating || input.url !== undefined ? checkWebhookUrl(format, input.url) : (previous?.url ?? '')
  const authGiven = input.auth !== undefined
  const keepAuth = !authGiven && previous && FORMAT_AUTH[format].types.includes(previous.auth.type)
  const auth = keepAuth ? previous!.auth : checkWebhookAuth(format, input.auth)
  const storedOptions = (row.options ?? {}) as WebhookOptions
  const options = checkWebhookOptions(format, url, {
    ...(creating || formatChanged ? {} : storedOptions),
    ...(input.options ?? {}),
  })

  row.format = format
  if (input.name !== undefined) row.name = input.name
  if (preset !== undefined) row.preset = preset
  else if (creating || formatChanged) row.preset = null
  row.urlEncrypted = encryption.encrypt(url)
  row.urlDisplay = webhookUrlDisplay(format, url, options)
  row.authEncrypted = auth.type === 'none' ? null : encryption.encrypt(auth)
  row.options = options

  let newSecret: string | null = null
  if (format !== 'standard') {
    row.secretEncrypted = null
  } else if (creating) {
    newSecret = newSigningSecret()
    row.secretEncrypted = encryption.encrypt(newSecret)
  } else if (formatChanged) {
    row.secretEncrypted = null
  } else if (previous === null && row.secretEncrypted) {
    // The old secret is unreadable: receivers must get a new one (rotate-secret).
    row.secretEncrypted = null
  }

  const defaults = webhookFilterDefaults(format, row.preset)
  const patch: Partial<Filters> = { ...(input.filters ?? {}) }
  if (input.respectQuietHours !== undefined && input.filters?.quietHours === undefined) {
    patch.quietHours = input.respectQuietHours ? 'inherit' : 'ignore'
  }
  row.filters =
    creating || formatChanged
      ? normalizeFilters({ ...defaults, ...patch }, defaults)
      : mergeFilters(row.filters, patch, defaults)
  row.respectQuietHours = (row.filters as Filters).quietHours === 'inherit'
  if (input.detail !== undefined) row.detail = input.detail
  else if (creating) row.detail = 'full'
  if (input.enabled !== undefined) row.enabled = input.enabled
  else if (creating) row.enabled = true

  // Fresh ciphertext is readable again.
  if (row.state === 'needs_secret' || creating) row.state = 'active'
  if (creating) row.consecutiveFailures = 0
  return newSecret
}

export type RawWebhookAuth = {
  type: WebhookAuth['type']
  token?: string
  username?: string
  password?: string
  name?: string
  value?: string
  botToken?: string
}

/** The validator's flat auth object as a `WebhookAuth`, or `webhook_auth_invalid`. */
export function webhookAuthOf(raw: RawWebhookAuth | undefined): WebhookAuth | undefined {
  if (!raw) return undefined
  const missing = (field: string): never => {
    throw new WebhookInputError('webhook_auth_invalid', `Auth type ${raw.type} needs ${field}.`)
  }
  switch (raw.type) {
    case 'none':
      return { type: 'none' }
    case 'bearer':
      return { type: 'bearer', token: raw.token ?? missing('token') }
    case 'basic':
      return {
        type: 'basic',
        username: raw.username ?? missing('username'),
        password: raw.password ?? missing('password'),
      }
    case 'header':
      return {
        type: 'header',
        name: raw.name ?? missing('name'),
        value: raw.value ?? missing('value'),
      }
    case 'gotify':
      return { type: 'gotify', token: raw.token ?? missing('token') }
    case 'telegram':
      return { type: 'telegram', botToken: raw.botToken ?? missing('botToken') }
  }
}
