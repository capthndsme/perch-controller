import { CATEGORIES, SEVERITIES } from '#services/alerts/model'
import vine from '@vinejs/vine'

/**
 * Request shapes of the webhook endpoints (docs/design/alerts/api.md §3.6).
 * Which auth a format takes, the URL rules and the telegram options are
 * checked by `webhooks/destinations.ts` (422 with an error code).
 */

const FORMATS = ['standard', 'ntfy', 'gotify', 'discord', 'slack', 'telegram'] as const
const PRESETS = [
  'generic',
  'homeassistant',
  'ntfy',
  'gotify',
  'discord',
  'slack',
  'telegram',
] as const

const secret = () => vine.string().minLength(1).maxLength(1024)

/** Every auth field optional here; `webhookAuthOf` checks what each type needs. */
const auth = () =>
  vine.object({
    type: vine.enum(['none', 'bearer', 'basic', 'header', 'gotify', 'telegram'] as const),
    token: secret().optional(),
    username: vine.string().minLength(1).maxLength(255).optional(),
    password: secret().optional(),
    name: vine.string().trim().minLength(1).maxLength(64).optional(),
    value: secret().optional(),
    botToken: vine.string().trim().minLength(1).maxLength(128).optional(),
  })

const fields = {
  preset: vine.enum(PRESETS).optional(),
  url: vine.string().trim().maxLength(2048).optional(),
  auth: auth().optional(),
  options: vine
    .object({
      chatId: vine.string().trim().maxLength(70).optional(),
      messageThreadId: vine.number().withoutDecimals().min(1).optional(),
      username: vine.string().trim().maxLength(80).optional(),
    })
    .optional(),
  filters: vine
    .object({
      minSeverity: vine.enum(SEVERITIES).optional(),
      categories: vine.array(vine.enum(CATEGORIES)).maxLength(20).nullable().optional(),
      types: vine
        .array(vine.string().trim().minLength(1).maxLength(64))
        .maxLength(100)
        .nullable()
        .optional(),
      quietHours: vine.enum(['inherit', 'ignore'] as const).optional(),
    })
    .optional(),
  detail: vine.enum(['full', 'minimal'] as const).optional(),
  respectQuietHours: vine.boolean().optional(),
  enabled: vine.boolean().optional(),
}

export const webhookCreateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60),
    format: vine.enum(FORMATS),
    ...fields,
  })
)

export const webhookUpdateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60).optional(),
    format: vine.enum(FORMATS).optional(),
    ...fields,
  })
)
