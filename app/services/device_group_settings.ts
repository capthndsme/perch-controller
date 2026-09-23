import SystemSetting from '#models/system_setting'

/**
 * Settings → Device groups (docs/gateway/device-groups.md section 8): the
 * SSIDs the groups' Wi-Fi keys and bindings apply to on the access points,
 * and the confirm window of an AP apply. One `system_settings` row, read per
 * use.
 */
export const DEVICE_GROUP_SETTING_KEY = 'device_groups'

export type DeviceGroupSettings = {
  /** SSIDs (exact names) whose access points carry the groups' keys and VLANs. */
  ssids: string[]
  /** How long an AP waits for the controller's confirm before it rolls back. */
  confirmSeconds: number
}

export const DEVICE_GROUP_DEFAULTS: Readonly<DeviceGroupSettings> = Object.freeze({
  ssids: [],
  confirmSeconds: 120,
})

export const DEVICE_GROUP_LIMITS = {
  confirmSeconds: { min: 30, max: 600 },
  ssids: { max: 16 },
} as const

/** An SSID is 1-32 bytes; control characters are refused. */
export function isValidSsid(value: string): boolean {
  const bytes = Buffer.byteLength(value, 'utf8')
  // eslint-disable-next-line no-control-regex
  return bytes >= 1 && bytes <= 32 && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Stored values of the wrong kind read as the defaults; numbers are clamped. */
export function normalizeDeviceGroupSettings(value: unknown): DeviceGroupSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: DeviceGroupSettings = { ...DEVICE_GROUP_DEFAULTS, ssids: [] }
  if (Array.isArray(stored.ssids)) {
    const seen = new Set<string>()
    for (const s of stored.ssids) {
      if (typeof s === 'string' && isValidSsid(s) && !seen.has(s)) {
        seen.add(s)
        settings.ssids.push(s)
      }
      if (settings.ssids.length >= DEVICE_GROUP_LIMITS.ssids.max) break
    }
  }
  const c = stored.confirmSeconds
  if (typeof c === 'number' && Number.isInteger(c)) {
    const { min, max } = DEVICE_GROUP_LIMITS.confirmSeconds
    settings.confirmSeconds = Math.min(max, Math.max(min, c))
  }
  return settings
}

export async function getDeviceGroupSettings(): Promise<DeviceGroupSettings> {
  return normalizeDeviceGroupSettings(await SystemSetting.get<unknown>(DEVICE_GROUP_SETTING_KEY))
}

export async function updateDeviceGroupSettings(
  changes: Partial<DeviceGroupSettings>
): Promise<DeviceGroupSettings> {
  const merged: Record<string, unknown> = { ...(await getDeviceGroupSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeDeviceGroupSettings(merged)
  await SystemSetting.set(DEVICE_GROUP_SETTING_KEY, settings)
  return settings
}

/** GET / PATCH /api/v1/settings/device-groups body. */
export function deviceGroupSettingsView(settings: DeviceGroupSettings) {
  return { settings, defaults: DEVICE_GROUP_DEFAULTS, limits: DEVICE_GROUP_LIMITS }
}
