import { DEVICE_CONNECTIONS, DEVICE_TYPES, MAX_TAGS, TAG_MAX_LENGTH } from '#services/device_labels'
import vine from '@vinejs/vine'

/**
 * `PATCH /api/v1/devices/:mac/label`
 *
 * Every field is optional *and* nullable, and the two mean different things:
 * an omitted key keeps whatever is stored, an explicit `null` clears that one
 * field. Empty strings are treated as `null` by the service.
 *
 * Length caps mirror the column widths in the migration; the service trims
 * and normalizes on top (lowercased, deduplicated tags).
 */
export const deviceLabelUpdateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().maxLength(80).nullable().optional(),
    deviceType: vine.enum(DEVICE_TYPES).nullable().optional(),
    connection: vine.enum(DEVICE_CONNECTIONS).nullable().optional(),
    tags: vine
      .array(vine.string().trim().maxLength(TAG_MAX_LENGTH))
      .maxLength(MAX_TAGS)
      .nullable()
      .optional(),
    notes: vine.string().trim().maxLength(2000).nullable().optional(),
  })
)
