import { PRESENCE_LIMITS, type PresenceLimits } from '#services/presence_settings'
import vine from '@vinejs/vine'

function threshold(key: keyof PresenceLimits) {
  const { min, max } = PRESENCE_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

/**
 * PATCH /api/v1/settings/presence: any subset of the thresholds; the fields
 * left out keep their stored value.
 */
export const updatePresenceSettingsValidator = vine.compile(
  vine.object({
    lanQuietMinutes: threshold('lanQuietMinutes'),
    wifiTrailingTrafficMinutes: threshold('wifiTrailingTrafficMinutes'),
    apStaleIntervals: threshold('apStaleIntervals'),
    apStaleMinSeconds: threshold('apStaleMinSeconds'),
    nowRateIntervals: threshold('nowRateIntervals'),
  })
)
