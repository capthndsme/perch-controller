import SystemSetting from '#models/system_setting'

/**
 * Settings → Gateway observation (docs/gateway/observation.md section 6):
 * how long the observation channel keeps what no report lists any more.
 * One `system_settings` row, read per use (the retention task, the backup
 * writer), never cached, so a save applies to the next run.
 */
export const GATEWAY_OBSERVATION_SETTING_KEY = 'gateway_observations'

export type GatewayObservationSettings = {
  /** A host row no report lists any more (lease gone, not a neighbour) is kept this long. */
  hostRetentionDays: number
  /** UPnP opened/closed events are kept this long. */
  upnpEventRetentionDays: number
  /** Router backups kept per gateway (the newest). */
  backupsKept: number
}

export const GATEWAY_OBSERVATION_DEFAULTS: Readonly<GatewayObservationSettings> = {
  hostRetentionDays: 14,
  upnpEventRetentionDays: 90,
  backupsKept: 10,
}

export const GATEWAY_OBSERVATION_LIMITS: Readonly<
  Record<keyof GatewayObservationSettings, { min: number; max: number }>
> = {
  hostRetentionDays: { min: 1, max: 365 },
  upnpEventRetentionDays: { min: 1, max: 730 },
  backupsKept: { min: 1, max: 50 },
}

const KEYS = Object.keys(GATEWAY_OBSERVATION_DEFAULTS) as Array<keyof GatewayObservationSettings>

/** Not a whole number reads as the default; out of range is clamped. */
export function normalizeGatewayObservationSettings(value: unknown): GatewayObservationSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: GatewayObservationSettings = { ...GATEWAY_OBSERVATION_DEFAULTS }
  for (const key of KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = GATEWAY_OBSERVATION_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  return settings
}

export async function getGatewayObservationSettings(): Promise<GatewayObservationSettings> {
  return normalizeGatewayObservationSettings(
    await SystemSetting.get<unknown>(GATEWAY_OBSERVATION_SETTING_KEY)
  )
}

export async function updateGatewayObservationSettings(
  changes: Partial<GatewayObservationSettings>
): Promise<GatewayObservationSettings> {
  const merged: Record<string, unknown> = { ...(await getGatewayObservationSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeGatewayObservationSettings(merged)
  await SystemSetting.set(GATEWAY_OBSERVATION_SETTING_KEY, settings)
  return settings
}

/** GET / PATCH /api/v1/settings/gateway-observations body. */
export function gatewayObservationSettingsView(settings: GatewayObservationSettings) {
  return {
    settings,
    defaults: GATEWAY_OBSERVATION_DEFAULTS,
    limits: GATEWAY_OBSERVATION_LIMITS,
  }
}
