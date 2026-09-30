import { SEVERITIES } from '#services/alerts/model'
import vine from '@vinejs/vine'

/**
 * Request shapes of the alerts inbox, mutes and watches
 * (docs/design/alerts/api.md §3.1–3.2). Values Vine cannot check alone
 * (category lists, subjects, cursors, catalogue types) are checked by the
 * controllers and answered with the same 422 shape.
 */

/** `GET /api/v1/alerts` query. */
export const alertListValidator = vine.compile(
  vine.object({
    view: vine.enum(['active', 'all'] as const).optional(),
    blips: vine.enum(['0', '1', 'true', 'false'] as const).optional(),
    minSeverity: vine.enum(SEVERITIES).optional(),
    category: vine.string().trim().maxLength(200).optional(),
    type: vine.string().trim().maxLength(1400).optional(),
    subject: vine.string().trim().maxLength(96).optional(),
    before: vine.string().trim().maxLength(40).optional(),
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
  })
)

/** `POST /api/v1/alerts/read`. */
export const alertReadValidator = vine.compile(
  vine.object({
    through: vine.string().trim().maxLength(40).optional(),
  })
)

/** `POST /api/v1/alerts/:id/acknowledge` and `/resolve`. */
export const alertNoteValidator = vine.compile(
  vine.object({
    note: vine.string().trim().maxLength(300).nullable().optional(),
  })
)

/** `POST /api/v1/alerts/mutes`. */
export const alertMuteValidator = vine.compile(
  vine.object({
    type: vine.string().trim().maxLength(64).optional(),
    subject: vine
      .object({
        kind: vine.string().trim().maxLength(16),
        ref: vine.string().trim().maxLength(64),
      })
      .optional(),
    minutes: vine.number().withoutDecimals().min(1).max(525600).optional(),
    until: vine.string().trim().maxLength(40).optional(),
    note: vine.string().trim().maxLength(200).optional(),
  })
)

/** `GET /api/v1/alerts/watches` query. */
export const alertWatchListValidator = vine.compile(
  vine.object({
    mac: vine.string().trim().maxLength(17).optional(),
  })
)

/** `PUT /api/v1/alerts/watches/devices/:mac`. */
export const alertWatchValidator = vine.compile(
  vine.object({
    offline: vine.boolean(),
    arrival: vine.boolean(),
  })
)
