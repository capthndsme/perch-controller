import {
  GATEWAY_CONFIG_LIMITS,
  LOCAL_STATE_PATH_PATTERN,
  type GatewayConfigLimits,
} from '#services/gateway_config/gateway_config_settings'
import { CONFIRM_MODES } from '#services/gateway_config/types'
import vine from '@vinejs/vine'

function whole(key: keyof GatewayConfigLimits) {
  const { min, max } = GATEWAY_CONFIG_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

/**
 * PATCH /api/v1/settings/gateway: any subset of the settings; the fields
 * left out keep their stored value.
 */
export const updateGatewayConfigSettingsValidator = vine.compile(
  vine.object({
    confirmTimeoutSeconds: whole('confirmTimeoutSeconds'),
    managementConfirmTimeoutSeconds: whole('managementConfirmTimeoutSeconds'),
    confirmMode: vine.enum(CONFIRM_MODES).optional(),
    queueExpiryHours: whole('queueExpiryHours'),
    watchSeconds: whole('watchSeconds'),
    importDebounceSeconds: whole('importDebounceSeconds'),
    authoritativeRevertDelaySeconds: whole('authoritativeRevertDelaySeconds'),
    enforcementMaxFailures: whole('enforcementMaxFailures'),
    enforcementWindowMinutes: whole('enforcementWindowMinutes'),
    keepRevisions: whole('keepRevisions'),
    auditRetentionDays: whole('auditRetentionDays'),
    allowInsecureTransport: vine.boolean({ strict: true }).optional(),
    localStatePath: vine
      .string()
      .trim()
      .maxLength(255)
      .regex(LOCAL_STATE_PATH_PATTERN)
      .notIn(['/'])
      .optional(),
    localStateFlushSecondsFlash: whole('localStateFlushSecondsFlash'),
    localStateFlushSecondsDisk: whole('localStateFlushSecondsDisk'),
  })
)
