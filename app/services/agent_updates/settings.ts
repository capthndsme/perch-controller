import SystemSetting from '#models/system_setting'

/**
 * Settings → Updates (agent-updates controller.md section 8): one
 * `system_settings` row, key `agent_updates`. Read once per request or tick
 * (one primary-key lookup), never cached. Every tunable of the update path is
 * here with a default and a range (tunables-as-controller-settings), like
 * `presence_settings.ts`.
 */
export const AGENT_UPDATE_SETTINGS_KEY = 'agent_updates'

export const CHANNELS = ['stable', 'pre', 'local'] as const
export type Channel = (typeof CHANNELS)[number]
export const AUTO_UPDATE_MODES = ['off', 'notify', 'auto'] as const
export type AutoUpdate = (typeof AUTO_UPDATE_MODES)[number]

export type AgentUpdateSettings = {
  githubCheck: boolean
  githubCheckIntervalHours: number
  prefetch: boolean
  keepReleases: number
  defaultChannel: Channel
  autoUpdateAp: AutoUpdate
  autoUpdateCollector: AutoUpdate
  windowEnabled: boolean
  windowDays: number[]
  windowStart: string
  windowEnd: string
  probationSeconds: number
  stableSeconds: number
  minPushes: number
  confirmGraceSeconds: number
  crashLoopRestarts: number
  downloadTimeoutSeconds: number
  downloadRateKbps: number
  flashReserveKiB: number
  ramReserveMiB: number
  keepPreviousMinFreeKiB: number
  allowRamRollbackOnAps: boolean
  batchSize: number
  batchGapSeconds: number
  canaryObserveMinutes: number
  offlineWaitMinutes: number
  stopOnFailure: boolean
  queueExpiryHours: number
  historyDays: number
  extraTrustedKeys: string[]
}

export const AGENT_UPDATE_DEFAULTS: Readonly<AgentUpdateSettings> = {
  githubCheck: true,
  githubCheckIntervalHours: 12,
  prefetch: true,
  keepReleases: 5,
  defaultChannel: 'stable',
  autoUpdateAp: 'notify',
  autoUpdateCollector: 'notify',
  windowEnabled: false,
  windowDays: [0, 1, 2, 3, 4, 5, 6],
  windowStart: '02:00',
  windowEnd: '05:00',
  probationSeconds: 180,
  stableSeconds: 30,
  minPushes: 2,
  confirmGraceSeconds: 60,
  crashLoopRestarts: 3,
  downloadTimeoutSeconds: 600,
  downloadRateKbps: 0,
  flashReserveKiB: 512,
  ramReserveMiB: 12,
  keepPreviousMinFreeKiB: 2048,
  allowRamRollbackOnAps: true,
  batchSize: 1,
  batchGapSeconds: 60,
  canaryObserveMinutes: 10,
  offlineWaitMinutes: 60,
  stopOnFailure: true,
  queueExpiryHours: 24,
  historyDays: 365,
  extraTrustedKeys: [],
}

type NumberKey = {
  [K in keyof AgentUpdateSettings]: AgentUpdateSettings[K] extends number ? K : never
}[keyof AgentUpdateSettings]

/** Whole-number settings and their accepted range. */
export const AGENT_UPDATE_LIMITS: Readonly<Record<NumberKey, { min: number; max: number }>> = {
  githubCheckIntervalHours: { min: 1, max: 168 },
  keepReleases: { min: 2, max: 50 },
  probationSeconds: { min: 60, max: 1800 },
  stableSeconds: { min: 10, max: 600 },
  minPushes: { min: 1, max: 20 },
  confirmGraceSeconds: { min: 10, max: 600 },
  crashLoopRestarts: { min: 2, max: 20 },
  downloadTimeoutSeconds: { min: 60, max: 3600 },
  downloadRateKbps: { min: 0, max: 1_000_000 },
  flashReserveKiB: { min: 128, max: 16384 },
  ramReserveMiB: { min: 4, max: 128 },
  keepPreviousMinFreeKiB: { min: 0, max: 65536 },
  batchSize: { min: 1, max: 50 },
  batchGapSeconds: { min: 0, max: 3600 },
  canaryObserveMinutes: { min: 0, max: 1440 },
  offlineWaitMinutes: { min: 0, max: 1440 },
  queueExpiryHours: { min: 1, max: 168 },
  historyDays: { min: 30, max: 1825 },
}

export const MAX_EXTRA_TRUSTED_KEYS = 8
export const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/

const BOOLEAN_KEYS = [
  'githubCheck',
  'prefetch',
  'windowEnabled',
  'allowRamRollbackOnAps',
  'stopOnFailure',
] as const

/**
 * A stored value of the wrong type reads as the default; a number outside
 * its range (limits changed since it was saved) is clamped into it.
 */
export function normalizeAgentUpdateSettings(value: unknown): AgentUpdateSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: AgentUpdateSettings = {
    ...AGENT_UPDATE_DEFAULTS,
    windowDays: [...AGENT_UPDATE_DEFAULTS.windowDays],
    extraTrustedKeys: [],
  }
  for (const key of Object.keys(AGENT_UPDATE_LIMITS) as NumberKey[]) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = AGENT_UPDATE_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof stored[key] === 'boolean') settings[key] = stored[key] as boolean
  }
  if (CHANNELS.includes(stored.defaultChannel as Channel)) {
    settings.defaultChannel = stored.defaultChannel as Channel
  }
  for (const key of ['autoUpdateAp', 'autoUpdateCollector'] as const) {
    if (AUTO_UPDATE_MODES.includes(stored[key] as AutoUpdate)) {
      settings[key] = stored[key] as AutoUpdate
    }
  }
  if (Array.isArray(stored.windowDays)) {
    const days = [
      ...new Set(
        stored.windowDays.filter(
          (day): day is number => Number.isInteger(day) && day >= 0 && day <= 6
        )
      ),
    ].sort((a, b) => a - b)
    settings.windowDays = days
  }
  for (const key of ['windowStart', 'windowEnd'] as const) {
    if (typeof stored[key] === 'string' && HH_MM_REGEX.test(stored[key] as string)) {
      settings[key] = stored[key] as string
    }
  }
  if (Array.isArray(stored.extraTrustedKeys)) {
    settings.extraTrustedKeys = stored.extraTrustedKeys
      .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      .map((line) => line.trim())
      .slice(0, MAX_EXTRA_TRUSTED_KEYS)
  }
  return settings
}

export async function getAgentUpdateSettings(): Promise<AgentUpdateSettings> {
  return normalizeAgentUpdateSettings(await SystemSetting.get<unknown>(AGENT_UPDATE_SETTINGS_KEY))
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updateAgentUpdateSettings(
  changes: Partial<AgentUpdateSettings>
): Promise<AgentUpdateSettings> {
  const merged: Record<string, unknown> = { ...(await getAgentUpdateSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeAgentUpdateSettings(merged)
  await SystemSetting.set(AGENT_UPDATE_SETTINGS_KEY, settings)
  return settings
}

/** GET / PATCH /api/v1/settings/agent-updates body. */
export function agentUpdateSettingsView(settings: AgentUpdateSettings) {
  return {
    settings,
    defaults: AGENT_UPDATE_DEFAULTS,
    // Numbers: { min, max }; choices: { options }; times: { pattern } (HH:MM
    // in the instance time zone); lists: their item range and length.
    limits: {
      ...AGENT_UPDATE_LIMITS,
      defaultChannel: { options: [...CHANNELS] },
      autoUpdateAp: { options: [...AUTO_UPDATE_MODES] },
      autoUpdateCollector: { options: [...AUTO_UPDATE_MODES] },
      windowStart: { pattern: 'HH:MM' },
      windowEnd: { pattern: 'HH:MM' },
      windowDays: { min: 0, max: 6, maxItems: 7 },
      extraTrustedKeys: { max: MAX_EXTRA_TRUSTED_KEYS },
    },
  }
}
