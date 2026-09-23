import { PORTAL_API_SCOPES } from '#models/portal_api_client'
import { PORTAL_SETTINGS_LIMITS } from '#services/portal/settings'
import { TEMPLATE_FILE_NAME_REGEX } from '#services/portal/templates'
import { DURATION_MODES, GRANT_SOURCES, START_MODES } from '#services/portal/types'
import vine from '@vinejs/vine'

/**
 * Bodies and query strings of the guest portal REST API
 * (docs/gateway/portal.md section 11). Shapes, lengths and ranges; what
 * depends on stored state (a portal exists, a network is free, per-client
 * caps) is refused by the services with the codes of section 11.
 */

const id = () => vine.number().withoutDecimals().min(1)
const limit = () => vine.number().withoutDecimals().min(1).max(1000).optional()
const offset = () => vine.number().withoutDecimals().min(0).max(10_000_000).optional()
const kbps = () => vine.number().withoutDecimals().min(64).max(10_000_000)
const MAC_REGEX =
  /^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/

/** `http(s)://` or `ws(s)://` origin, no path: goes into the portal page's CSP `connect-src`. */
export const CSP_ORIGIN_REGEX =
  /^(https?|wss?):\/\/(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(:[0-9]{1,5})?$/

/** An integration's idempotency key. */
export const EXTERNAL_REF_REGEX = /^[A-Za-z0-9._:-]{1,64}$/

/** The network's ledger id (`perch_id` of its `interface` section). */
const NETWORK_PERCH_ID_REGEX = /^[A-Za-z0-9._:-]{1,24}$/

const methods = () =>
  vine.object({ voucher: vine.boolean().optional(), password: vine.boolean().optional() })

const portalFields = {
  name: vine.string().trim().minLength(1).maxLength(80),
  networkPerchId: vine.string().trim().regex(NETWORK_PERCH_ID_REGEX),
  methods: methods().optional(),
  templateId: id().nullable().optional(),
  cspConnectSrc: vine
    .array(vine.string().trim().toLowerCase().maxLength(255).regex(CSP_ORIGIN_REGEX))
    .maxLength(16)
    .optional(),
  privacyNotice: vine.string().trim().maxLength(2000).nullable().optional(),
  force: vine.boolean().optional(),
}

export const createPortalValidator = vine.compile(vine.object({ gatewayId: id(), ...portalFields }))

export const updatePortalValidator = vine.compile(
  vine.object({
    ...portalFields,
    name: portalFields.name.optional(),
    networkPerchId: portalFields.networkPerchId.optional(),
  })
)

export const portalListQueryValidator = vine.compile(vine.object({ gatewayId: id().optional() }))

export const deletePortalQueryValidator = vine.compile(
  vine.object({ force: vine.boolean().optional() })
)

// --- templates ---------------------------------------------------------------

export const templateNameValidator = vine.compile(
  vine.object({ name: vine.string().trim().minLength(1).maxLength(80) })
)

export const templateFileNameRegex = TEMPLATE_FILE_NAME_REGEX

export const previewQueryValidator = vine.compile(
  vine.object({
    page: vine.enum(['login', 'status'] as const).optional(),
    message: vine.string().trim().maxLength(40).optional(),
    portalId: id().optional(),
  })
)

// --- vouchers ----------------------------------------------------------------

export const createBatchValidator = vine.compile(
  vine.object({
    portalId: id().nullable().optional(),
    name: vine.string().trim().minLength(1).maxLength(80),
    note: vine.string().trim().maxLength(500).nullable().optional(),
    count: vine.number().withoutDecimals().min(1).max(1000),
    codeLength: vine.number().withoutDecimals().min(8).max(16).optional(),
    durationMinutes: vine.number().withoutDecimals().min(1).max(525_600).nullable().optional(),
    durationMode: vine.enum(DURATION_MODES).optional(),
    startMode: vine.enum(START_MODES).optional(),
    quotaBytes: vine.number().withoutDecimals().min(1_000_000).max(1e13).nullable().optional(),
    downKbps: kbps().nullable().optional(),
    upKbps: kbps().nullable().optional(),
    maxDevices: vine.number().withoutDecimals().min(1).max(10).optional(),
    redeemBy: vine.string().trim().maxLength(40).nullable().optional(),
  })
)

export const batchListQueryValidator = vine.compile(vine.object({ portalId: id().optional() }))

export const voucherListQueryValidator = vine.compile(
  vine.object({
    batchId: id().optional(),
    portalId: id().optional(),
    status: vine.enum(['unused', 'active', 'exhausted', 'expired', 'revoked'] as const).optional(),
    limit: limit(),
    offset: offset(),
  })
)

export const voucherLookupValidator = vine.compile(
  vine.object({ code: vine.string().trim().minLength(1).maxLength(64) })
)

// --- portal users --------------------------------------------------------------

const username = () =>
  vine
    .string()
    .trim()
    .regex(/^[a-z0-9._-]{3,32}$/)
const password = () => vine.string().minLength(8).maxLength(64)

const portalUserFields = {
  displayName: vine.string().trim().maxLength(80).nullable().optional(),
  enabled: vine.boolean().optional(),
  maxDevices: vine.number().withoutDecimals().min(1).max(10).optional(),
  sessionMinutes: vine.number().withoutDecimals().min(1).max(525_600).nullable().optional(),
  downKbps: kbps().nullable().optional(),
  upKbps: kbps().nullable().optional(),
  portalIds: vine.array(id()).maxLength(256).nullable().optional(),
}

export const createPortalUserValidator = vine.compile(
  vine.object({ username: username(), password: password(), ...portalUserFields })
)

export const updatePortalUserValidator = vine.compile(
  vine.object({ username: username().optional(), ...portalUserFields })
)

export const portalUserPasswordValidator = vine.compile(vine.object({ password: password() }))

// --- API clients -----------------------------------------------------------------

const apiClientFields = {
  name: vine.string().trim().minLength(1).maxLength(80),
  portalIds: vine.array(id()).minLength(1).maxLength(256),
  scopes: vine.array(vine.enum(PORTAL_API_SCOPES)).minLength(1).maxLength(2),
  maxMinutesPerCall: vine.number().withoutDecimals().min(1).max(10_080).optional(),
  maxBytesPerCall: vine.number().withoutDecimals().min(1_000_000).max(1e13).optional(),
  maxActiveGrants: vine.number().withoutDecimals().min(1).max(5000).optional(),
}

export const createApiClientValidator = vine.compile(vine.object(apiClientFields))

export const updateApiClientValidator = vine.compile(
  vine.object({
    ...apiClientFields,
    name: apiClientFields.name.optional(),
    portalIds: apiClientFields.portalIds.optional(),
    scopes: apiClientFields.scopes.optional(),
  })
)

// --- grants and sessions -------------------------------------------------------

export const grantListQueryValidator = vine.compile(
  vine.object({
    portalId: id().optional(),
    gatewayId: id().optional(),
    voucherId: id().optional(),
    state: vine.enum(['active', 'live', 'queued', 'ended', 'all'] as const).optional(),
    mac: vine.string().trim().maxLength(20).optional(),
    source: vine.enum(GRANT_SOURCES).optional(),
    limit: limit(),
    offset: offset(),
  })
)

export const extendGrantValidator = vine.compile(
  vine.object({
    minutes: vine
      .number()
      .withoutDecimals()
      .min(1)
      .max(525_600)
      .optional()
      .requiredIfMissing('bytes'),
    bytes: vine.number().withoutDecimals().min(1).max(1e13).optional(),
  })
)

export const sessionListQueryValidator = vine.compile(
  vine.object({
    portalId: id().optional(),
    gatewayId: id().optional(),
    grantId: id().optional(),
    mac: vine.string().trim().maxLength(20).optional(),
    from: vine.string().trim().maxLength(40).optional(),
    to: vine.string().trim().maxLength(40).optional(),
    limit: limit(),
    offset: offset(),
  })
)

// --- authorize API ---------------------------------------------------------------

export const authorizeValidator = vine.compile(
  vine.object({
    portalId: id(),
    mac: vine.string().trim().maxLength(20).regex(MAC_REGEX),
    minutes: vine.number().withoutDecimals().min(1).max(525_600).nullable().optional(),
    bytes: vine.number().withoutDecimals().min(1).max(1e13).nullable().optional(),
    durationMode: vine.enum(DURATION_MODES).optional(),
    downKbps: kbps().nullable().optional(),
    upKbps: kbps().nullable().optional(),
    mode: vine.enum(['extend', 'replace'] as const).optional(),
    externalRef: vine.string().trim().regex(EXTERNAL_REF_REGEX).nullable().optional(),
    note: vine.string().trim().maxLength(200).nullable().optional(),
  })
)

export const authorizationQueryValidator = vine.compile(vine.object({ portalId: id() }))

// --- settings ----------------------------------------------------------------------

function setting(key: keyof typeof PORTAL_SETTINGS_LIMITS) {
  const { min, max } = PORTAL_SETTINGS_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

export const updatePortalSettingsValidator = vine.compile(
  vine.object({
    sessionRetentionDays: setting('sessionRetentionDays'),
    enforceIntervalSeconds: setting('enforceIntervalSeconds'),
    usageIntervalSeconds: setting('usageIntervalSeconds'),
    guestFailuresPerDevicePerMinute: setting('guestFailuresPerDevicePerMinute'),
    guestFailuresPerDevicePerHour: setting('guestFailuresPerDevicePerHour'),
    guestFailuresPerPortalPerMinute: setting('guestFailuresPerPortalPerMinute'),
    controllerFailuresPerDevicePer15Minutes: setting('controllerFailuresPerDevicePer15Minutes'),
    controllerFailuresPerUsernamePer15Minutes: setting('controllerFailuresPerUsernamePer15Minutes'),
    apiRequestsPerClientPerMinute: setting('apiRequestsPerClientPerMinute'),
    deviceUnseenEvictMinutes: setting('deviceUnseenEvictMinutes'),
    preauthDnsPerDevicePerMinute: setting('preauthDnsPerDevicePerMinute'),
    offlineRedemption: vine.boolean().optional(),
    offlineVoucherLimit: setting('offlineVoucherLimit'),
  })
)
