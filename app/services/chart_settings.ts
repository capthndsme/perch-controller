import SystemSetting from '#models/system_setting'
import { nativeRetentionDaysFromEnv } from '#services/bucket_retention'

/**
 * Settings → Charts: how fine a server or destination traffic chart may
 * bucket (`series_buckets.ts`), stored as one `system_settings` row. Read
 * once per request (one primary-key lookup), never cached, so a save applies
 * to the next chart refresh. Same pattern as `presence_settings.ts`.
 */
export const CHART_SETTING_KEY = 'charts'

export type ChartSettings = {
  /**
   * Finest bucket a chart uses, in seconds. Only reachable where per-poll
   * (native) rows exist; older windows use the stored 5-minute or hourly
   * detail. Rates are bytes per bucket ÷ the bucket's seconds, so a finer
   * floor shows short bursts at their real speed.
   */
  minBucketSeconds: number
  /** Most buckets one series may return; wider windows get coarser buckets. */
  maxPoints: number
}

export const CHART_DEFAULTS: Readonly<ChartSettings> = {
  minBucketSeconds: 15,
  maxPoints: 1500,
}

export type ChartLimits = Record<keyof ChartSettings, { min: number; max: number }>

/** Accepted range of each setting (whole numbers). */
export const CHART_LIMITS: Readonly<ChartLimits> = {
  // The collectors poll every 5 s; nothing finer is stored.
  minBucketSeconds: { min: 5, max: 300 },
  // The ceiling keeps every series response bounded (~1500 × 150 B).
  maxPoints: { min: 100, max: 1500 },
}

const KEYS = Object.keys(CHART_DEFAULTS) as Array<keyof ChartSettings>

/**
 * A stored value that is not a whole number reads as the default; one outside
 * the range (limits changed since it was saved) is clamped into it.
 */
export function normalizeChartSettings(value: unknown): ChartSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: ChartSettings = { ...CHART_DEFAULTS }
  for (const key of KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = CHART_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  return settings
}

export async function getChartSettings(): Promise<ChartSettings> {
  return normalizeChartSettings(await SystemSetting.get<unknown>(CHART_SETTING_KEY))
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updateChartSettings(changes: Partial<ChartSettings>): Promise<ChartSettings> {
  const merged: Record<string, unknown> = { ...(await getChartSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeChartSettings(merged)
  await SystemSetting.set(CHART_SETTING_KEY, settings)
  return settings
}

/**
 * GET / PATCH /api/v1/settings/charts body: the values in force, the defaults
 * and ranges the form shows, and how long the per-poll rows the floor needs
 * are kept (`BUCKET_RETENTION_DAYS`).
 */
export function chartSettingsView(settings: ChartSettings) {
  return {
    settings,
    defaults: CHART_DEFAULTS,
    limits: CHART_LIMITS,
    nativeRetentionDays: nativeRetentionDaysFromEnv(),
  }
}
