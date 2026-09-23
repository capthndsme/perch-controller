import { CHART_LIMITS, type ChartLimits } from '#services/chart_settings'
import vine from '@vinejs/vine'

function setting(key: keyof ChartLimits) {
  const { min, max } = CHART_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

/**
 * PATCH /api/v1/settings/charts: any subset of the settings; the fields left
 * out keep their stored value.
 */
export const updateChartSettingsValidator = vine.compile(
  vine.object({
    minBucketSeconds: setting('minBucketSeconds'),
    maxPoints: setting('maxPoints'),
  })
)
