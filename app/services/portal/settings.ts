/**
 * Settings → Guest portal (docs/gateway/portal.md §8): instance-wide
 * tunables, one `system_settings` row under key `portal`, normalized like
 * `presence_settings.ts`. Read per use (one primary-key lookup), never cached.
 *
 * The pure part (`normalizePortalSettings`, limits, defaults) lives here
 * without app imports so the unit suite can test it; the DB-bound get/update
 * are in `portal_settings.ts`.
 */

export const PORTAL_SETTING_KEY = 'portal'

export type PortalSettings = {
  /** Sessions, ended grants and portal events are deleted after this many days. */
  sessionRetentionDays: number
  /** Router enforcement tick (expiry, quota, active-time charging). */
  enforceIntervalSeconds: number
  /** How often the router reports usage (`portal.sessions`). */
  usageIntervalSeconds: number
  /** Guest page: failed code/password attempts per device per minute. */
  guestFailuresPerDevicePerMinute: number
  /** Guest page: failed attempts per device per hour. */
  guestFailuresPerDevicePerHour: number
  /** Guest page: failed attempts per portal per minute across all devices (the real bound; MACs are cheap). */
  guestFailuresPerPortalPerMinute: number
  /** Controller's second check on `portal.redeem`/`portal.login`: failures per (portal, MAC) per 15 min. */
  controllerFailuresPerDevicePer15Minutes: number
  /** Failures per username (keyed with the MAC) per 15 min. */
  controllerFailuresPerUsernamePer15Minutes: number
  /** Integration API requests per API client per minute. */
  apiRequestsPerClientPerMinute: number
  /** A portal user's device unseen this long may be evicted to make room (vouchers always move, decision 23). */
  deviceUnseenEvictMinutes: number
  /** Pre-auth DNS queries per device per minute (decision 24: rate-limited against tunnelling). */
  preauthDnsPerDevicePerMinute: number
  /** Hand gateways the vouchers they may redeem while the controller is unreachable (decision 20). */
  offlineRedemption: boolean
  /** Most vouchers one gateway holds for offline redemption (newest batches first). 0 = none. */
  offlineVoucherLimit: number
}

type IntLimit = { min: number; max: number }

export const PORTAL_SETTINGS_DEFAULTS: Readonly<PortalSettings> = {
  sessionRetentionDays: 30,
  enforceIntervalSeconds: 5,
  usageIntervalSeconds: 30,
  guestFailuresPerDevicePerMinute: 5,
  guestFailuresPerDevicePerHour: 20,
  guestFailuresPerPortalPerMinute: 60,
  controllerFailuresPerDevicePer15Minutes: 10,
  controllerFailuresPerUsernamePer15Minutes: 20,
  apiRequestsPerClientPerMinute: 120,
  deviceUnseenEvictMinutes: 10,
  preauthDnsPerDevicePerMinute: 120,
  offlineRedemption: true,
  offlineVoucherLimit: 5000,
}

type IntKey = {
  [K in keyof PortalSettings]: PortalSettings[K] extends number ? K : never
}[keyof PortalSettings]
type BoolKey = {
  [K in keyof PortalSettings]: PortalSettings[K] extends boolean ? K : never
}[keyof PortalSettings]

/** Accepted range of each whole-number setting. */
export const PORTAL_SETTINGS_LIMITS: Readonly<Record<IntKey, IntLimit>> = {
  sessionRetentionDays: { min: 1, max: 730 },
  enforceIntervalSeconds: { min: 2, max: 60 },
  usageIntervalSeconds: { min: 10, max: 300 },
  guestFailuresPerDevicePerMinute: { min: 1, max: 60 },
  guestFailuresPerDevicePerHour: { min: 1, max: 600 },
  guestFailuresPerPortalPerMinute: { min: 10, max: 600 },
  controllerFailuresPerDevicePer15Minutes: { min: 1, max: 100 },
  controllerFailuresPerUsernamePer15Minutes: { min: 1, max: 200 },
  apiRequestsPerClientPerMinute: { min: 10, max: 6000 },
  deviceUnseenEvictMinutes: { min: 1, max: 1440 },
  preauthDnsPerDevicePerMinute: { min: 10, max: 6000 },
  offlineVoucherLimit: { min: 0, max: 50000 },
}

const INT_KEYS = Object.keys(PORTAL_SETTINGS_LIMITS) as IntKey[]
const BOOL_KEYS: BoolKey[] = ['offlineRedemption']

/**
 * A stored value of the wrong type reads as the default; a number outside
 * its range (limits changed since it was saved) is clamped into it. Unknown
 * keys are dropped.
 */
export function normalizePortalSettings(value: unknown): PortalSettings {
  const stored =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const settings: PortalSettings = { ...PORTAL_SETTINGS_DEFAULTS }
  for (const key of INT_KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = PORTAL_SETTINGS_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  for (const key of BOOL_KEYS) {
    const candidate = stored[key]
    if (typeof candidate === 'boolean') settings[key] = candidate
  }
  return settings
}

/** Applies the given fields over `current`; undefined fields keep their value. */
export function mergePortalSettings(
  current: PortalSettings,
  changes: Partial<PortalSettings>
): PortalSettings {
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  return normalizePortalSettings(merged)
}

/** GET / PATCH /api/v1/settings/portal body. */
export function portalSettingsView(settings: PortalSettings) {
  return { settings, defaults: PORTAL_SETTINGS_DEFAULTS, limits: PORTAL_SETTINGS_LIMITS }
}
