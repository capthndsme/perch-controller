import { CATEGORIES, SEVERITIES } from '#services/alerts/model'
import vine from '@vinejs/vine'

/**
 * Request shapes of the push endpoints (docs/design/alerts/api.md §3.4). The
 * endpoint's push service and the key lengths are checked by
 * `push/subscriptions.ts` (same 422 shape).
 */

const filters = () =>
  vine
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
    .optional()

const subscription = () =>
  vine.object({
    endpoint: vine.string().trim().maxLength(2048),
    expirationTime: vine.number().withoutDecimals().min(0).nullable().optional(),
    keys: vine.object({
      p256dh: vine.string().trim().minLength(80).maxLength(100),
      auth: vine.string().trim().minLength(20).maxLength(30),
    }),
  })

/** `POST /alerts/push/subscriptions`. */
export const pushSubscribeValidator = vine.compile(
  vine.object({
    subscription: subscription(),
    vapidKeyId: vine.string().trim().maxLength(32),
    label: vine.string().trim().maxLength(80).nullable().optional(),
    filters: filters(),
  })
)

/** `PATCH /alerts/push/subscriptions/:id`. */
export const pushUpdateValidator = vine.compile(
  vine.object({
    label: vine.string().trim().maxLength(80).nullable().optional(),
    enabled: vine.boolean().optional(),
    filters: filters(),
  })
)

/** `POST /alerts/push/subscriptions/unsubscribe`. */
export const pushUnsubscribeValidator = vine.compile(
  vine.object({ endpoint: vine.string().trim().maxLength(2048) })
)

/** `POST /alerts/push/renew` (the service worker). */
export const pushRenewValidator = vine.compile(
  vine.object({
    oldEndpoint: vine.string().trim().maxLength(2048),
    renewToken: vine.string().trim().maxLength(100),
    subscription: subscription(),
  })
)

/** `POST /settings/alerts/vapid/rotate`. */
export const vapidRotateValidator = vine.compile(vine.object({ confirm: vine.literal('rotate') }))
