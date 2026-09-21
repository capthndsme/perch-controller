import vine from '@vinejs/vine'

const RANGE_REGEX = /^(\d{1,6})(s|m|h|d)$/
const MAC_REGEX = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/
const RESOLUTION_VALUES = ['5s', '15s', '1m', '5m', '15m', '1h'] as const

const TIME_WINDOW_FIELDS = {
  range: vine.string().regex(RANGE_REGEX).optional(),
  from: vine.string().optional(),
  to: vine.string().optional(),
}

export const wifiSourceCreateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    friendlyName: vine.string().trim().maxLength(120).nullable().optional(),
    metricsUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500),
    pollIntervalSeconds: vine.number().min(5).max(3600).optional(),
    enabled: vine.boolean().optional(),
    enableTwoWayCommands: vine.boolean().optional(),
    sshHost: vine.string().trim().maxLength(255).nullable().optional(),
    sshPort: vine.number().min(1).max(65535).optional(),
    sshUsername: vine.string().trim().maxLength(100).nullable().optional(),
    sshPrivateKey: vine.string().trim().maxLength(20000).nullable().optional(),
  })
)

export const wifiSourceUpdateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120).optional(),
    friendlyName: vine.string().trim().maxLength(120).nullable().optional(),
    metricsUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500).optional(),
    pollIntervalSeconds: vine.number().min(5).max(3600).optional(),
    enabled: vine.boolean().optional(),
    enableTwoWayCommands: vine.boolean().optional(),
    sshHost: vine.string().trim().maxLength(255).nullable().optional(),
    sshPort: vine.number().min(1).max(65535).optional(),
    sshUsername: vine.string().trim().maxLength(100).nullable().optional(),
    sshPrivateKey: vine.string().trim().maxLength(20000).nullable().optional(),
  })
)

export const wifiSourceProbeValidator = vine.compile(
  vine.object({
    metricsUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500),
  })
)

export const wifiOverviewQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    apId: vine.number().positive().optional(),
  })
)

export const wifiSsidsQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    apId: vine.number().positive().optional(),
  })
)

export const wifiSsidClientsQueryValidator = vine.compile(
  vine.object({
    apId: vine.number().positive().optional(),
  })
)

export const wifiSsidThroughputQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    apId: vine.number().positive().optional(),
  })
)

export const wifiClientsQueryValidator = vine.compile(
  vine.object({
    apId: vine.number().positive().optional(),
    activeOnly: vine.boolean().optional(),
  })
)

export const wifiClientSignalQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    apId: vine.number().positive().optional(),
  })
)

export const wifiRfQueryValidator = vine.compile(
  vine.object({
    apId: vine.number().positive().optional(),
  })
)

export const wifiRfHistoryQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    apId: vine.number().positive().optional(),
  })
)

export const wifiClientsHistoryQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
    apId: vine.number().positive().optional(),
  })
)

export const wifiApsQueryValidator = vine.compile(
  vine.object({
    includeDisabled: vine.boolean().optional(),
  })
)

export const wifiApHealthQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
  })
)

/** `GET /api/v1/wifi/aps/throughput?range=24h&resolution=1m` */
export const wifiApThroughputQueryValidator = vine.compile(
  vine.object({
    ...TIME_WINDOW_FIELDS,
    resolution: vine.enum(RESOLUTION_VALUES).optional(),
  })
)

export const wifiClientMacParamValidator = vine.compile(
  vine.object({
    mac: vine.string().trim().regex(MAC_REGEX),
  })
)

export const wifiClientSteerValidator = vine.compile(
  vine.object({
    banTimeMs: vine.number().min(1000).max(60000).optional(),
  })
)

/**
 * `blinkTimes` / `blinkDurationMs` drive the SSH blink loop; `durationSeconds`
 * and `stop` are for Perch AP Daemon agents (`locate.start` / `locate.stop`).
 */
export const wifiApLocateValidator = vine.compile(
  vine.object({
    blinkTimes: vine.number().min(1).max(30).optional(),
    blinkDurationMs: vine.number().min(50).max(5000).optional(),
    durationSeconds: vine.number().withoutDecimals().min(1).max(600).optional(),
    stop: vine.boolean().optional(),
  })
)

/**
 * Parses `15m` into seconds for unified time-window handling.
 */
export function parseRange(raw: string): { seconds: number } | null {
  const match = RANGE_REGEX.exec(raw)
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2]
  const multiplier: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  }
  return { seconds: value * multiplier[unit] }
}

export type WifiResolution = (typeof RESOLUTION_VALUES)[number]

export const RESOLUTION_SECONDS: Record<WifiResolution, number> = {
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
}
