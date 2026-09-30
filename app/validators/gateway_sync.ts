import vine from '@vinejs/vine'

/**
 * Gateway sync request bodies (docs/design/gateway-sync/rest.md). Refusals
 * that need the gateway's state (confirm names, policies, completeness) are
 * the services'; these only shape the input.
 */

/** `POST /gateways/:id/ambiguities/resolve` (rest.md 6). */
export const ambiguityResolveValidator = vine.compile(
  vine.object({
    expectRevision: vine.number().withoutDecimals().min(0),
    items: vine
      .array(
        vine.object({
          perchId: vine.string().trim().minLength(1).maxLength(24),
          action: vine.enum(['keep', 'rename', 'delete', 'exclude'] as const),
          /** `rename` only; 1–64 characters (the port-forward name limit). */
          name: vine.string().trim().minLength(1).maxLength(64).optional(),
        })
      )
      .minLength(1)
      .maxLength(64),
  })
)

/** `PATCH /gateways/:id/firewall/defaults` (rest.md 7). */
export const firewallDefaultsPatchValidator = vine.compile(
  vine.object({
    input: vine.string().trim().maxLength(16).optional(),
    output: vine.string().trim().maxLength(16).optional(),
    forward: vine.string().trim().maxLength(16).optional(),
    synfloodProtect: vine.boolean().optional(),
    dropInvalid: vine.boolean().optional(),
    flowOffloading: vine.boolean().optional(),
    flowOffloadingHw: vine.boolean().optional(),
    confirm: vine.string().trim().maxLength(128).optional(),
  })
)
