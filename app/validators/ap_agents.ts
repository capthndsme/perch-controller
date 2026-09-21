import vine from '@vinejs/vine'

const MAC_REGEX = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/

/**
 * `POST /api/v1/ap-agent/join` — the agent's side of a join
 * (perch-apd PROTOCOL.md section 1). The MACs are how the server
 * recognises an AP it already knows; the controller lowercases them.
 */
export const apAgentJoinValidator = vine.compile(
  vine.object({
    token: vine.string().trim().minLength(1).maxLength(128),
    hostname: vine.string().trim().minLength(1).maxLength(120),
    model: vine.string().trim().maxLength(120).optional(),
    boardName: vine.string().trim().maxLength(120).optional(),
    release: vine.string().trim().maxLength(50).optional(),
    revision: vine.string().trim().maxLength(64).optional(),
    target: vine.string().trim().maxLength(64).optional(),
    arch: vine.string().trim().maxLength(32).optional(),
    kernel: vine.string().trim().maxLength(64).optional(),
    agentVersion: vine.string().trim().minLength(1).maxLength(32),
    macs: vine.array(vine.string().trim().regex(MAC_REGEX)).maxLength(64),
  })
)

/** `POST /api/v1/settings/ap-join-tokens` (docs/ap-controller.md section 4.1). */
export const apJoinTokenCreateValidator = vine.compile(
  vine.object({
    label: vine.string().trim().maxLength(80).nullable().optional(),
    expiresInHours: vine.number().withoutDecimals().min(1).max(8760).nullable().optional(),
    maxUses: vine.number().withoutDecimals().min(1).max(1000).nullable().optional(),
  })
)
