import { PRODUCTS } from '#services/agent_updates/manifest'
import vine from '@vinejs/vine'

/**
 * Agent updates REST bodies and queries (docs/design/agent-updates/controller.md
 * section 9.2).
 */

/** GET /api/v1/agent-updates/releases */
export const releasesIndexValidator = vine.compile(
  vine.object({
    product: vine.enum(PRODUCTS).optional(),
    includeWithdrawn: vine.boolean().optional(),
  })
)

/**
 * POST /api/v1/agent-updates/releases: the manifest bytes as base64 (so the
 * signed bytes survive JSON untouched) and the `.sig` file's text.
 */
export const releaseCreateValidator = vine.compile(
  vine.object({
    manifest: vine
      .string()
      .maxLength(1_400_000)
      .regex(/^[A-Za-z0-9+/=\s]+$/),
    signature: vine.string().maxLength(4096),
  })
)

/** PATCH /api/v1/agent-updates/releases/:id */
export const releaseUpdateValidator = vine.compile(
  vine.object({
    withdrawn: vine.boolean(),
  })
)
