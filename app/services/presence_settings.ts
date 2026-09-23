import SystemSetting from '#models/system_setting'
import {
  CONNECTED_INACTIVE_MS,
  PRESENCE_DEFAULTS,
  type PresenceThresholds,
} from '#services/wifi_presence'

/**
 * Settings → Presence: the thresholds `wifi_presence.ts` decides "connected
 * right now" with, stored as one `system_settings` row. Read per request (one
 * primary-key lookup), never cached, so a save applies to the next request.
 */
export const PRESENCE_SETTING_KEY = 'presence'

export type PresenceLimits = Record<keyof PresenceThresholds, { min: number; max: number }>

/** Accepted range of each threshold (whole numbers). */
export const PRESENCE_LIMITS: Readonly<PresenceLimits> = {
  lanQuietMinutes: { min: 1, max: 1440 },
  wifiTrailingTrafficMinutes: { min: 1, max: 60 },
  // One interval would flag an AP whose push is a moment late.
  apStaleIntervals: { min: 2, max: 10 },
  apStaleMinSeconds: { min: 10, max: 600 },
  // The latest native bucket is already one interval old when it is written.
  nowRateIntervals: { min: 2, max: 20 },
}

const KEYS = Object.keys(PRESENCE_DEFAULTS) as Array<keyof PresenceThresholds>

/**
 * A stored value that is not a whole number reads as the default; one outside
 * the range (limits changed since it was saved) is clamped into it.
 */
export function normalizePresenceSettings(value: unknown): PresenceThresholds {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: PresenceThresholds = { ...PRESENCE_DEFAULTS }
  for (const key of KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = PRESENCE_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  return settings
}

export async function getPresenceSettings(): Promise<PresenceThresholds> {
  return normalizePresenceSettings(await SystemSetting.get<unknown>(PRESENCE_SETTING_KEY))
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updatePresenceSettings(
  changes: Partial<PresenceThresholds>
): Promise<PresenceThresholds> {
  const merged: Record<string, unknown> = { ...(await getPresenceSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizePresenceSettings(merged)
  await SystemSetting.set(PRESENCE_SETTING_KEY, settings)
  return settings
}

/**
 * GET / PATCH /api/v1/settings/presence body: the values in force, the
 * defaults and ranges the form shows, and the Wi-Fi idle limit, which is
 * fixed (see `CONNECTED_INACTIVE_MS`) but part of the same rule.
 */
export function presenceSettingsView(settings: PresenceThresholds) {
  return {
    settings,
    defaults: PRESENCE_DEFAULTS,
    limits: PRESENCE_LIMITS,
    wifiIdleSeconds: CONNECTED_INACTIVE_MS / 1000,
  }
}
