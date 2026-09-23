import vine from '@vinejs/vine'

/**
 * Request bodies of the gateway REST API (docs/gateway/config-plane.md
 * section 10). Perch ids are the engine's (`^[a-z0-9]{1,24}$`).
 */

export const PERCH_ID_REGEX = /^[a-z0-9_]{1,24}$/

const perchIds = () => vine.array(vine.string().trim().regex(PERCH_ID_REGEX)).maxLength(2000)

/** `PATCH /gateways/:id` */
export const gatewayPatchValidator = vine.compile(
  vine.object({
    mode: vine.enum(['off', 'observe', 'managed'] as const).optional(),
    authoritative: vine.boolean().optional(),
    expectRevision: vine.number().withoutDecimals().min(0).optional(),
    currentPassword: vine.string().maxLength(512).optional(),
  })
)

/** `POST /gateways/:id/bind` */
export const gatewayBindValidator = vine.compile(
  vine.object({ collectorId: vine.number().withoutDecimals().min(1) })
)

/** `PATCH /gateways/:id/sections/:perchId` */
export const sectionScopeValidator = vine.compile(
  vine.object({ scope: vine.enum(['synced', 'excluded'] as const) })
)

/**
 * `POST /gateways/:id/sections/resolve`. `options` (custom) maps option
 * names to a string, a list of strings, or null (remove); checked in the
 * controller since Vine has no union record.
 */
export const sectionResolveValidator = vine.compile(
  vine.object({
    items: vine
      .array(
        vine.object({
          perchId: vine.string().trim().regex(PERCH_ID_REGEX),
          take: vine.enum(['router', 'controller', 'custom'] as const),
          options: vine.record(vine.any()).optional(),
        })
      )
      .minLength(1)
      .maxLength(500),
  })
)

/** `POST /gateways/:id/applies` */
export const applyCreateValidator = vine.compile(
  vine.object({
    perchIds: perchIds().minLength(1).optional(),
    dryRun: vine.boolean().optional(),
    confirmMode: vine.enum(['agent', 'admin_and_agent'] as const).optional(),
    note: vine.string().trim().maxLength(500).optional(),
  })
)

/** `DELETE /gateways/:id/draft`, `POST /gateways/:id/drift/*` */
export const perchIdsValidator = vine.compile(
  vine.object({ perchIds: perchIds().minLength(1).optional() })
)

/** `?limit=&before=` on the paged lists. */
export const pagingValidator = vine.compile(
  vine.object({
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    before: vine.number().withoutDecimals().min(1).optional(),
    state: vine.string().trim().maxLength(16).optional(),
  })
)

/** `GET /gateways/:id/sections?config=&scope=&status=` */
export const sectionFilterValidator = vine.compile(
  vine.object({
    config: vine.string().trim().maxLength(32).optional(),
    scope: vine.enum(['synced', 'excluded', 'unmodeled'] as const).optional(),
    status: vine.string().trim().maxLength(12).optional(),
    domain: vine.string().trim().maxLength(32).optional(),
  })
)

/** `PATCH /gateways/:id/dns` */
export const dnsPolicyValidator = vine.compile(
  vine.object({ labelNames: vine.enum(['off', 'review'] as const) })
)

/** `POST /gateways/:id/dns/records`, `PATCH …/records/:perchId` (partial on PATCH). */
export const dnsRecordValidator = vine.compile(
  vine.object({
    type: vine.enum(['a', 'cname'] as const),
    name: vine.string().trim().minLength(1).maxLength(253),
    value: vine.string().trim().minLength(1).maxLength(253),
  })
)

export const dnsRecordPatchValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(253).optional(),
    value: vine.string().trim().minLength(1).maxLength(253).optional(),
  })
)

/** `POST /gateways/:id/dns/label-names/apply` */
export const labelNamesApplyValidator = vine.compile(
  vine.object({
    macs: vine.array(vine.string().trim().maxLength(17)).minLength(1).maxLength(500).optional(),
  })
)

/**
 * `PUT /devices/:mac/reservation` (plan 2 section 5): `ip` is `current` (the
 * device's lease), an address, or null (a name-only host). `gatewayId` is
 * needed only when several gateways are managed.
 */
export const deviceReservationValidator = vine.compile(
  vine.object({
    gatewayId: vine.number().withoutDecimals().min(1).optional(),
    ip: vine.string().trim().maxLength(45).nullable(),
    hostname: vine.string().trim().maxLength(63).nullable().optional(),
    publishDns: vine.boolean().optional(),
    leaseTime: vine.string().trim().maxLength(16).nullable().optional(),
  })
)

/** `DELETE /devices/:mac/reservation` */
export const deviceGatewayValidator = vine.compile(
  vine.object({ gatewayId: vine.number().withoutDecimals().min(1).optional() })
)
