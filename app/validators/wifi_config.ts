import vine from '@vinejs/vine'

/**
 * Request bodies of the Wi-Fi REST API (docs/design/wifi controller.md
 * section 7.2). Semantic checks that need data (an AP's radios, a
 * passphrase's rules, SSID bytes) are the services'; these check shapes.
 */

export const PERCH_ID_REGEX = /^[a-z0-9_]{1,24}$/
const perchIds = () => vine.array(vine.string().trim().regex(PERCH_ID_REGEX)).maxLength(2000)
const band = () => vine.enum(['2g', '5g', '6g'] as const)
const confirmMode = () => vine.enum(['agent', 'admin_and_agent'] as const)

const binding = () =>
  vine.object({
    kind: vine.enum(['lan', 'vlan', 'ap_network'] as const),
    vlanId: vine.number().withoutDecimals().min(1).max(4094).optional(),
    gatewayId: vine.number().withoutDecimals().min(1).nullable().optional(),
    networkPerchId: vine.string().trim().maxLength(24).nullable().optional(),
  })

const roaming = () =>
  vine.object({
    ft: vine.boolean().optional(),
    mobilityDomain: vine
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{4}$/)
      .nullable()
      .optional(),
    rrm: vine.boolean().optional(),
    btm: vine.boolean().optional(),
  })

const advanced = () =>
  vine.object({
    pmf: vine.enum(['default', 'disabled', 'optional', 'required'] as const).optional(),
    multicastToUnicast: vine.boolean().nullable().optional(),
    maxClients: vine.number().withoutDecimals().min(1).max(512).nullable().optional(),
    dtimPeriod: vine.number().withoutDecimals().min(1).max(255).nullable().optional(),
  })

const networkFields = {
  name: vine.string().trim().minLength(1).maxLength(64),
  ssid: vine.string().minLength(1).maxLength(32),
  enabled: vine.boolean().optional(),
  security: vine.enum(['open', 'owe', 'wpa2', 'wpa2_wpa3', 'wpa3'] as const),
  passphrase: vine.string().minLength(8).maxLength(64).optional(),
  hidden: vine.boolean().optional(),
  isolate: vine.boolean().optional(),
  binding: binding().optional(),
  bands: vine.array(band()).minLength(1).maxLength(3).optional(),
  apScope: vine.enum(['all', 'selected'] as const).optional(),
  apIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
  roaming: roaming().optional(),
  advanced: advanced().optional(),
  groups: vine.boolean().optional(),
}

/** `POST /wifi/networks` */
export const networkCreateValidator = vine.compile(vine.object(networkFields))

/** `PATCH /wifi/networks/:id` (any create field, plus the step-up password) */
export const networkPatchValidator = vine.compile(
  vine.object({
    name: networkFields.name.optional(),
    ssid: networkFields.ssid.optional(),
    enabled: vine.boolean().optional(),
    security: vine.enum(['open', 'owe', 'wpa2', 'wpa2_wpa3', 'wpa3'] as const).optional(),
    passphrase: vine.string().minLength(8).maxLength(64).optional(),
    hidden: vine.boolean().optional(),
    isolate: vine.boolean().optional(),
    binding: binding().optional(),
    bands: vine.array(band()).minLength(1).maxLength(3).optional(),
    apScope: vine.enum(['all', 'selected'] as const).optional(),
    apIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    roaming: roaming().optional(),
    advanced: advanced().optional(),
    groups: vine.boolean().optional(),
    currentPassword: vine.string().maxLength(512).optional(),
  })
)

/** `POST /wifi/networks/:id/passphrase` */
export const passphraseValidator = vine.compile(
  vine.object({
    passphrase: vine.string().minLength(1).maxLength(64),
    force: vine.boolean().optional(),
  })
)

/** `PUT /wifi/networks/:id/aps/:apId` */
export const networkApValidator = vine.compile(
  vine.object({
    included: vine.boolean().nullable().optional(),
    bands: vine.array(band()).maxLength(3).nullable().optional(),
    radios: vine
      .array(
        vine
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_]{1,32}$/)
      )
      .maxLength(8)
      .nullable()
      .optional(),
    overrides: vine
      .object({
        enabled: vine.boolean().optional(),
        hidden: vine.boolean().optional(),
        isolate: vine.boolean().optional(),
        apNetwork: vine
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_]{1,32}$/)
          .optional(),
        keepKey: vine.boolean().optional(),
        maxClients: vine.number().withoutDecimals().min(1).max(512).optional(),
        dtimPeriod: vine.number().withoutDecimals().min(1).max(255).optional(),
      })
      .optional(),
    radioOverrides: vine.record(vine.object({ enabled: vine.boolean().optional() })).optional(),
  })
)

/** `PATCH /wifi/config/aps/:apId` */
export const apPatchValidator = vine.compile(
  vine.object({
    mode: vine.enum(['off', 'observe', 'managed'] as const).optional(),
    authoritative: vine.boolean().optional(),
    expectRevision: vine.number().withoutDecimals().min(0).optional(),
    currentPassword: vine.string().maxLength(512).optional(),
    country: vine
      .object({
        mode: vine.enum(['fleet', 'fixed', 'router'] as const),
        code: vine.string().trim().maxLength(2).nullable().optional(),
      })
      .optional(),
    trunk: vine.string().trim().maxLength(15).nullable().optional(),
  })
)

/** `PATCH /wifi/config/aps/:apId/radios/:section` */
export const radioPatchValidator = vine.compile(
  vine.object({
    channelMode: vine.enum(['auto', 'fixed'] as const).optional(),
    channel: vine.number().withoutDecimals().min(1).max(233).optional(),
    allowed: vine
      .array(vine.number().withoutDecimals().min(1).max(233))
      .maxLength(64)
      .nullable()
      .optional(),
    width: vine.number().in([20, 40, 80, 160, 320]).optional(),
    txpower: vine
      .object({
        mode: vine.enum(['auto', 'fixed'] as const),
        dbm: vine.number().withoutDecimals().min(0).max(40).optional(),
      })
      .optional(),
    enabled: vine.boolean().optional(),
  })
)

/** `POST /wifi/config/aps/:apId/rejoin` */
export const rejoinValidator = vine.compile(
  vine.object({ use: vine.enum(['fleet', 'revision'] as const) })
)

/** `POST /wifi/divergences/resolve` */
export const divergenceResolveValidator = vine.compile(
  vine.object({
    items: vine
      .array(
        vine.object({
          id: vine.number().withoutDecimals().min(1),
          resolution: vine.enum(['fleet', 'override', 'revert', 'split'] as const),
          passphrase: vine.string().maxLength(64).optional(),
        })
      )
      .minLength(1)
      .maxLength(200),
    currentPassword: vine.string().maxLength(512).optional(),
  })
)

/** `POST /wifi/adoption` */
export const adoptionValidator = vine.compile(
  vine.object({
    proposals: vine
      .array(
        vine.object({
          key: vine
            .string()
            .trim()
            .regex(/^[0-9a-f]{16}$/),
          name: vine.string().trim().minLength(1).maxLength(64).optional(),
          merge: vine
            .array(
              vine
                .string()
                .trim()
                .regex(/^[0-9a-f]{16}$/)
            )
            .maxLength(16)
            .optional(),
          choices: vine.record(vine.any()).optional(),
          exclude: vine.boolean().optional(),
          passphrase: vine.string().maxLength(64).optional(),
        })
      )
      .maxLength(256),
    countryDefault: vine.string().trim().maxLength(2).nullable().optional(),
    countries: vine
      .record(
        vine.object({
          mode: vine.enum(['fleet', 'fixed', 'router'] as const),
          code: vine.string().trim().maxLength(2).nullable().optional(),
        })
      )
      .optional(),
  })
)

const draftNetwork = () =>
  vine.object({
    id: vine.number().withoutDecimals().min(1).nullable().optional(),
    name: vine.string().trim().maxLength(64).optional(),
    ssid: vine.string().maxLength(32).optional(),
    enabled: vine.boolean().optional(),
    security: vine.enum(['open', 'owe', 'wpa2', 'wpa2_wpa3', 'wpa3'] as const).optional(),
    passphrase: vine.string().maxLength(64).optional(),
    hidden: vine.boolean().optional(),
    isolate: vine.boolean().optional(),
    binding: binding().optional(),
    bands: vine.array(band()).maxLength(3).optional(),
    apScope: vine.enum(['all', 'selected'] as const).optional(),
    apIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    roaming: roaming().optional(),
    advanced: advanced().optional(),
  })

/** `POST /wifi/rollouts/preview` (with `draft`: unsaved network edits, nothing stored) */
export const rolloutPreviewValidator = vine.compile(
  vine.object({
    networkIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    apIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    perchIds: perchIds().optional(),
    draft: vine
      .object({
        network: draftNetwork(),
        aps: vine
          .array(
            vine.object({
              apId: vine.number().withoutDecimals().min(1),
              included: vine.boolean().nullable().optional(),
              bands: vine.array(band()).maxLength(3).nullable().optional(),
              radios: vine
                .array(vine.string().trim().maxLength(32))
                .maxLength(8)
                .nullable()
                .optional(),
              overrides: vine.record(vine.any()).optional(),
              radioOverrides: vine
                .record(vine.object({ enabled: vine.boolean().optional() }))
                .optional(),
            })
          )
          .maxLength(256)
          .optional(),
      })
      .optional(),
  })
)

/** `POST /wifi/rollouts` */
export const rolloutCreateValidator = vine.compile(
  vine.object({
    networkIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    apIds: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    perchIds: perchIds().optional(),
    order: vine.array(vine.number().withoutDecimals().min(1)).maxLength(256).optional(),
    confirmMode: confirmMode().optional(),
    offlinePolicy: vine.enum(['skip', 'wait'] as const).optional(),
    note: vine.string().trim().maxLength(500).optional(),
  })
)

/** `POST /wifi/rollouts/:rolloutId/{retry,skip}` */
export const rolloutActionValidator = vine.compile(
  vine.object({ apId: vine.number().withoutDecimals().min(1).optional() })
)

/** `?limit=&before=` */
export const wifiPagingValidator = vine.compile(
  vine.object({
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    before: vine.number().withoutDecimals().min(1).optional(),
    state: vine.string().trim().maxLength(16).optional(),
  })
)

/** `GET /wifi/divergences?apId=&networkId=&open=1` */
export const divergenceFilterValidator = vine.compile(
  vine.object({
    apId: vine.number().withoutDecimals().min(1).optional(),
    networkId: vine.number().withoutDecimals().min(1).optional(),
    open: vine.enum(['0', '1', 'true', 'false'] as const).optional(),
  })
)
