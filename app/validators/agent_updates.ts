import { PRODUCTS } from '#services/agent_updates/manifest'
import { UPDATE_METHODS } from '#services/agent_updates/report'
import {
  AGENT_UPDATE_LIMITS,
  AUTO_UPDATE_MODES,
  CHANNELS,
  HH_MM_REGEX,
  MAX_EXTRA_TRUSTED_KEYS,
} from '#services/agent_updates/settings'
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

const DEVICE_KEY = /^(ap|collector):[1-9]\d{0,9}$/
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/

/** GET /api/v1/agent-updates/fleet */
export const fleetQueryValidator = vine.compile(
  vine.object({
    product: vine.enum(PRODUCTS).optional(),
  })
)

/** GET /api/v1/agent-updates/jobs */
export const jobsQueryValidator = vine.compile(
  vine.object({
    deviceKey: vine.string().regex(DEVICE_KEY).optional(),
    state: vine.enum(['open', 'final', 'all'] as const).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    before: vine.number().withoutDecimals().min(1).optional(),
  })
)

/** GET /api/v1/agent-updates/events */
export const eventsQueryValidator = vine.compile(
  vine.object({
    deviceKey: vine.string().regex(DEVICE_KEY).optional(),
    rolloutId: vine.number().withoutDecimals().min(1).optional(),
    jobId: vine.number().withoutDecimals().min(1).optional(),
    severity: vine.enum(['info', 'warning', 'critical'] as const).optional(),
    limit: vine.number().withoutDecimals().min(1).max(500).optional(),
    before: vine.number().withoutDecimals().min(1).optional(),
  })
)

/** PATCH /api/v1/agent-updates/devices/:kind/:id */
export const deviceSettingsValidator = vine.compile(
  vine.object({
    channel: vine.enum(CHANNELS).nullable().optional(),
    autoUpdate: vine.enum(['inherit', ...AUTO_UPDATE_MODES] as const).optional(),
    pinnedVersion: vine.string().trim().regex(VERSION).nullable().optional(),
  })
)

/** POST /api/v1/agent-updates/devices/:kind/:id/preflight */
export const preflightValidator = vine.compile(
  vine.object({
    version: vine.string().trim().regex(VERSION).optional(),
    method: vine.enum(UPDATE_METHODS).optional(),
    source: vine.enum(['release', 'previous'] as const).optional(),
  })
)

/** POST /api/v1/agent-updates/devices/:kind/:id/update */
export const updateDeviceValidator = vine.compile(
  vine.object({
    version: vine.string().trim().regex(VERSION),
    method: vine.enum(UPDATE_METHODS).optional(),
    when: vine.enum(['now', 'window'] as const).optional(),
    acceptUnrecoverable: vine.boolean().optional(),
  })
)

/** POST /api/v1/agent-updates/devices/:kind/:id/rollback */
export const rollbackDeviceValidator = vine.compile(
  vine.object({
    acceptUnrecoverable: vine.boolean().optional(),
  })
)

function setting(key: keyof typeof AGENT_UPDATE_LIMITS) {
  const { min, max } = AGENT_UPDATE_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

/** PATCH /api/v1/settings/agent-updates: any subset of controller.md section 8. */
export const agentUpdateSettingsValidator = vine.compile(
  vine.object({
    githubCheck: vine.boolean().optional(),
    githubCheckIntervalHours: setting('githubCheckIntervalHours'),
    prefetch: vine.boolean().optional(),
    keepReleases: setting('keepReleases'),
    defaultChannel: vine.enum(CHANNELS).optional(),
    autoUpdateAp: vine.enum(AUTO_UPDATE_MODES).optional(),
    autoUpdateCollector: vine.enum(AUTO_UPDATE_MODES).optional(),
    windowEnabled: vine.boolean().optional(),
    windowDays: vine
      .array(vine.number().withoutDecimals().min(0).max(6))
      .maxLength(7)
      .distinct()
      .optional(),
    windowStart: vine.string().regex(HH_MM_REGEX).optional(),
    windowEnd: vine.string().regex(HH_MM_REGEX).optional(),
    probationSeconds: setting('probationSeconds'),
    stableSeconds: setting('stableSeconds'),
    minPushes: setting('minPushes'),
    confirmGraceSeconds: setting('confirmGraceSeconds'),
    crashLoopRestarts: setting('crashLoopRestarts'),
    downloadTimeoutSeconds: setting('downloadTimeoutSeconds'),
    downloadRateKbps: setting('downloadRateKbps'),
    flashReserveKiB: setting('flashReserveKiB'),
    ramReserveMiB: setting('ramReserveMiB'),
    keepPreviousMinFreeKiB: setting('keepPreviousMinFreeKiB'),
    allowRamRollbackOnAps: vine.boolean().optional(),
    batchSize: setting('batchSize'),
    batchGapSeconds: setting('batchGapSeconds'),
    canaryObserveMinutes: setting('canaryObserveMinutes'),
    offlineWaitMinutes: setting('offlineWaitMinutes'),
    stopOnFailure: vine.boolean().optional(),
    queueExpiryHours: setting('queueExpiryHours'),
    historyDays: setting('historyDays'),
    extraTrustedKeys: vine
      .array(vine.string().trim().maxLength(300))
      .maxLength(MAX_EXTRA_TRUSTED_KEYS)
      .optional(),
  })
)

/** GET /api/v1/agent-updates/rollouts */
export const rolloutsQueryValidator = vine.compile(
  vine.object({
    state: vine.enum(['open', 'all'] as const).optional(),
    product: vine.enum(PRODUCTS).optional(),
  })
)

/** POST /api/v1/agent-updates/rollouts: omitted tunables come from the settings. */
export const rolloutCreateValidator = vine.compile(
  vine.object({
    product: vine.enum(PRODUCTS),
    version: vine.string().trim().regex(VERSION),
    deviceKeys: vine.array(vine.string().regex(DEVICE_KEY)).minLength(1).maxLength(500).optional(),
    canaryKey: vine.string().regex(DEVICE_KEY).optional(),
    method: vine.enum(['auto', ...UPDATE_METHODS] as const).optional(),
    batchSize: setting('batchSize'),
    batchGapSeconds: setting('batchGapSeconds'),
    canaryObserveMinutes: setting('canaryObserveMinutes'),
    offlineWaitMinutes: setting('offlineWaitMinutes'),
    stopOnFailure: vine.boolean().optional(),
    respectWindow: vine.boolean().optional(),
    acceptUnrecoverable: vine.boolean().optional(),
  })
)

/** POST /api/v1/agent-updates/rollouts/:id/resume */
export const rolloutResumeValidator = vine.compile(
  vine.object({
    skipFailed: vine.boolean().optional(),
  })
)
