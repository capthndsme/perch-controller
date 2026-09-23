import { QOS_LIMITS, type QosLimits } from '#services/qos_settings'
import vine from '@vinejs/vine'

function setting(key: keyof QosLimits) {
  const { min, max } = QOS_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

/**
 * PATCH /api/v1/settings/qos: any subset of the settings; the fields left
 * out keep their stored value.
 */
export const updateQosSettingsValidator = vine.compile(
  vine.object({
    minWanKbit: setting('minWanKbit'),
    minDeviceKbit: setting('minDeviceKbit'),
    dynamicIdleMinutes: setting('dynamicIdleMinutes'),
    dynamicClassLimit: setting('dynamicClassLimit'),
    leafFlows: setting('leafFlows'),
    leafLimitPackets: setting('leafLimitPackets'),
    leafMemoryKb: setting('leafMemoryKb'),
    restMemlimitKb: setting('restMemlimitKb'),
    applyDebounceSeconds: setting('applyDebounceSeconds'),
    quotaPersistSeconds: setting('quotaPersistSeconds'),
    maxBucketDepth: setting('maxBucketDepth'),
  })
)
