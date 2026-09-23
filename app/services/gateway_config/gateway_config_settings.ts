import SystemSetting from '#models/system_setting'
import { CONFIRM_MODES, type ConfirmMode, type StorageKind } from '#services/gateway_config/types'

/**
 * Settings → Gateway: the config plane's tunables (docs/gateway/config-plane.md
 * section 11, README 7.3 and 7.18), one `system_settings` row normalised and
 * clamped like `presence_settings.ts`. Read per use (one primary-key lookup),
 * never cached, so a save applies to the next decision.
 *
 * Per-gateway values (Authoritative Mode, the local-state overrides) live on
 * the `gateways` row, not here.
 */
export const GATEWAY_CONFIG_SETTING_KEY = 'gateway_config'

export type GatewayConfigSettings = {
  /** Confirm window of an ordinary apply; capped again by the router's `config_confirm_max`. */
  confirmTimeoutSeconds: number
  /**
   * Confirm window of an apply that touches the management path (README
   * 3.8): such changes go in an apply of their own with this longer window.
   */
  managementConfirmTimeoutSeconds: number
  /** `agent` = new session + first push; `admin_and_agent` = also the admin's "Keep changes". */
  confirmMode: ConfirmMode
  /** A queued apply (gateway offline) expires after this. */
  queueExpiryHours: number
  /** Agent's safety-net poll of the allowlisted files. */
  watchSeconds: number
  /** Quiet period before the agent reports a router edit. */
  importDebounceSeconds: number
  /** Authoritative Mode: grace delay before router edits are reverted (README 7.3: 90 s). */
  authoritativeRevertDelaySeconds: number
  /** Authoritative Mode: this many failed reverts inside the window suspend enforcement. */
  enforcementMaxFailures: number
  /** The window `enforcementMaxFailures` is counted in. */
  enforcementWindowMinutes: number
  /** Revisions kept per gateway (the newest confirmed one is always kept). */
  keepRevisions: number
  /** `gateway_config_events` older than this are pruned. */
  auditRetentionDays: number
  /** Controller half of the plain-HTTP write opt-in (README 7.1). */
  allowInsecureTransport: boolean
  /** Router-side state store (quotas, grants, offline vouchers; README 7.18). */
  localStatePath: string
  /** Snapshot interval when the path is on SPI/NAND flash (batched counters). */
  localStateFlushSecondsFlash: number
  /** Snapshot interval on eMMC, USB or SATA; 0 = write-through. */
  localStateFlushSecondsDisk: number
}

export const GATEWAY_CONFIG_DEFAULTS: Readonly<GatewayConfigSettings> = Object.freeze({
  confirmTimeoutSeconds: 90,
  managementConfirmTimeoutSeconds: 300,
  confirmMode: 'admin_and_agent',
  queueExpiryHours: 24,
  watchSeconds: 30,
  importDebounceSeconds: 5,
  authoritativeRevertDelaySeconds: 90,
  enforcementMaxFailures: 2,
  enforcementWindowMinutes: 60,
  keepRevisions: 500,
  auditRetentionDays: 730,
  allowInsecureTransport: false,
  localStatePath: '/etc/perch-collector/state',
  localStateFlushSecondsFlash: 300,
  localStateFlushSecondsDisk: 0,
})

type NumericKey = {
  [K in keyof GatewayConfigSettings]: GatewayConfigSettings[K] extends number ? K : never
}[keyof GatewayConfigSettings]

export type GatewayConfigLimits = Record<NumericKey, { min: number; max: number }>

/** Accepted range of each numeric setting (whole numbers). */
export const GATEWAY_CONFIG_LIMITS: Readonly<GatewayConfigLimits> = {
  confirmTimeoutSeconds: { min: 30, max: 600 },
  // The router gives a protected job at least 300 s (go-collector gwconfig
  // ProtectedConfirmSeconds): a shorter window here would never apply.
  managementConfirmTimeoutSeconds: { min: 300, max: 1800 },
  queueExpiryHours: { min: 1, max: 168 },
  watchSeconds: { min: 10, max: 600 },
  importDebounceSeconds: { min: 1, max: 60 },
  authoritativeRevertDelaySeconds: { min: 0, max: 3600 },
  enforcementMaxFailures: { min: 1, max: 10 },
  enforcementWindowMinutes: { min: 10, max: 1440 },
  keepRevisions: { min: 50, max: 10000 },
  auditRetentionDays: { min: 30, max: 3650 },
  localStateFlushSecondsFlash: { min: 30, max: 86400 },
  localStateFlushSecondsDisk: { min: 0, max: 86400 },
}

/**
 * An absolute path of plain segments, no `..`, not the root itself. The
 * agent checks the mount on its side (README 7.18); this only keeps the
 * value sane and free of shell metacharacters.
 */
export const LOCAL_STATE_PATH_PATTERN = /^(\/[A-Za-z0-9._-]+)+$/
export function isValidLocalStatePath(value: string): boolean {
  return (
    value.length <= 255 &&
    LOCAL_STATE_PATH_PATTERN.test(value) &&
    !value.split('/').some((segment) => segment === '.' || segment === '..')
  )
}

const NUMERIC_KEYS = Object.keys(GATEWAY_CONFIG_LIMITS) as NumericKey[]

/**
 * A stored value of the wrong kind reads as the default; a number outside
 * the range (limits changed since it was saved) is clamped into it.
 */
export function normalizeGatewayConfigSettings(value: unknown): GatewayConfigSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: GatewayConfigSettings = { ...GATEWAY_CONFIG_DEFAULTS }
  for (const key of NUMERIC_KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = GATEWAY_CONFIG_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  if (CONFIRM_MODES.includes(stored.confirmMode as ConfirmMode)) {
    settings.confirmMode = stored.confirmMode as ConfirmMode
  }
  if (typeof stored.allowInsecureTransport === 'boolean') {
    settings.allowInsecureTransport = stored.allowInsecureTransport
  }
  if (typeof stored.localStatePath === 'string' && isValidLocalStatePath(stored.localStatePath)) {
    settings.localStatePath = stored.localStatePath
  }
  return settings
}

export async function getGatewayConfigSettings(): Promise<GatewayConfigSettings> {
  return normalizeGatewayConfigSettings(
    await SystemSetting.get<unknown>(GATEWAY_CONFIG_SETTING_KEY)
  )
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updateGatewayConfigSettings(
  changes: Partial<GatewayConfigSettings>
): Promise<GatewayConfigSettings> {
  const merged: Record<string, unknown> = { ...(await getGatewayConfigSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeGatewayConfigSettings(merged)
  await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, settings)
  return settings
}

/** GET / PATCH /api/v1/settings/gateway body. */
export function gatewayConfigSettingsView(settings: GatewayConfigSettings) {
  return {
    settings,
    defaults: GATEWAY_CONFIG_DEFAULTS,
    limits: GATEWAY_CONFIG_LIMITS,
    choices: { confirmMode: CONFIRM_MODES },
  }
}

/**
 * Confirm window for one apply: the management-path window for a protected
 * job, else the normal one, never above what the router accepts
 * (`config_confirm_max`, when it reported one).
 */
export function confirmTimeoutFor(
  settings: GatewayConfigSettings,
  options: { protected: boolean; routerMaxSeconds?: number | null }
): number {
  const wanted = options.protected
    ? Math.max(settings.managementConfirmTimeoutSeconds, settings.confirmTimeoutSeconds)
    : settings.confirmTimeoutSeconds
  const cap = options.routerMaxSeconds
  return typeof cap === 'number' && cap > 0 ? Math.min(wanted, cap) : wanted
}

/** Storage classes that wear (README 7.18): counters are batched there. */
const FLASH_STORAGE: ReadonlySet<StorageKind> = new Set(['spi_flash', 'unknown'])

export type LocalStatePlan = {
  path: string
  /** 0 = write-through (every counter write is flushed). Grants are always written immediately. */
  flushSeconds: number
  source: 'gateway' | 'setting'
}

/**
 * The router-side state store a gateway should use (README 7.18): the
 * gateway's own override, else the controller setting; the flush interval
 * follows the storage class the agent reported (unknown counts as flash, the
 * cautious choice). RAM-backed paths flush on the flash interval too: the
 * agent falls back to RAM itself when the mount check fails.
 */
export function resolveLocalState(
  settings: GatewayConfigSettings,
  gateway: { localStatePath: string | null; localStateFlushSeconds: number | null },
  storage: StorageKind | null | undefined
): LocalStatePlan {
  const kind: StorageKind = storage ?? 'unknown'
  const path =
    gateway.localStatePath && isValidLocalStatePath(gateway.localStatePath)
      ? gateway.localStatePath
      : settings.localStatePath
  const byStorage =
    FLASH_STORAGE.has(kind) || kind === 'ram'
      ? settings.localStateFlushSecondsFlash
      : settings.localStateFlushSecondsDisk
  const override = gateway.localStateFlushSeconds
  const flushSeconds =
    typeof override === 'number' && Number.isInteger(override) && override >= 0
      ? Math.min(override, GATEWAY_CONFIG_LIMITS.localStateFlushSecondsFlash.max)
      : byStorage
  return {
    path,
    flushSeconds,
    source: gateway.localStatePath || override !== null ? 'gateway' : 'setting',
  }
}
