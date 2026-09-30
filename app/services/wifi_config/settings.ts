import SystemSetting from '#models/system_setting'
import { CONFIRM_MODES, type ConfirmMode } from '#services/gateway_config/types'
import {
  CATCH_UP_POLICIES,
  OFFLINE_POLICIES,
  ROLLOUT_ORDERS,
  type CatchUpPolicy,
  type OfflinePolicy,
  type RolloutOrder,
} from '#services/wifi_config/types'
import encryption from '@adonisjs/core/services/encryption'
import { randomBytes } from 'node:crypto'

/**
 * Settings → Wi-Fi: the Wi-Fi plane's tunables (docs/design/wifi
 * controller.md section 8), one `system_settings` row (key `wifi_config`)
 * normalised and clamped like `presence_settings.ts`. Read per use (one
 * primary-key lookup), never cached, so a save applies to the next decision.
 *
 * Per-AP values (mode, Authoritative Mode, country policy, trunk override)
 * live on the `ap_configs` row, per-network ones on `wifi_networks`.
 *
 * Also the fleet fingerprint key (`wifi_fingerprint_key`): the controller-
 * wide HMAC key the agents fingerprint Wi-Fi secrets with (protocol.md 3.2),
 * APP_KEY-encrypted at rest, created on first use, never returned by any API.
 */
export const WIFI_CONFIG_SETTING_KEY = 'wifi_config'
export const WIFI_FINGERPRINT_KEY_SETTING = 'wifi_fingerprint_key'

export type WifiConfigSettings = {
  /** Confirm window of an ordinary Wi-Fi job; capped by the AP's `wifi_config_confirm_max`. */
  confirmTimeoutSeconds: number
  /** Window of a job on the AP's management path (VLAN/trunk conversion, backhaul radio). */
  managementConfirmTimeoutSeconds: number
  /** Ordinary jobs (decision D4, owner 2026-09-30): `agent` = fresh session + push + the AP's health check. */
  confirmMode: ConfirmMode
  /** Jobs that could cut the AP's uplink still need "Keep changes" by default. */
  protectedConfirmMode: ConfirmMode
  /** How long the AP waits for every expected BSS to come up (sent in `agent.configure`). */
  healthWaitSeconds: number
  /** Add a DFS radio's radar-check time (CAC) to the window of jobs that restart it. */
  dfsAllowance: boolean
  /** The agent's safety-net poll of `wireless` / `network`. */
  watchSeconds: number
  /** Quiet period before the agent reports a router edit. */
  importDebounceSeconds: number
  /** Authoritative Mode: grace delay before router edits are reverted (gateway decision 3). */
  authoritativeRevertDelaySeconds: number
  enforcementMaxFailures: number
  enforcementWindowMinutes: number
  /** Order of APs in a rollout (decision D8). */
  rolloutOrder: RolloutOrder
  /** An offline AP during a rollout: skip it (it catches up later) or wait for it. */
  rolloutOfflinePolicy: OfflinePolicy
  /** An AP that missed changes while offline (decision D7). */
  catchUpOnReconnect: CatchUpPolicy
  /** Fleet country (ISO 3166-1 alpha-2); null = leave each AP's (decision D10). */
  countryDefault: string | null
  /** 802.11r on new networks (decision D14: off). */
  newNetworkFastRoaming: boolean
  /** Revisions kept per AP (the newest confirmed one is always kept). */
  keepRevisions: number
  /** Events, finished rollouts and resolved divergences older than this are pruned. */
  auditRetentionDays: number
  /** Controller half of the plain-HTTP write opt-in (decision D3). */
  allowInsecureTransport: boolean
  /** Send passphrases sealed on paired plain-HTTP sessions (decision D3). */
  sealSecrets: boolean
}

export const WIFI_CONFIG_DEFAULTS: Readonly<WifiConfigSettings> = Object.freeze({
  confirmTimeoutSeconds: 120,
  managementConfirmTimeoutSeconds: 300,
  confirmMode: 'agent',
  protectedConfirmMode: 'admin_and_agent',
  healthWaitSeconds: 45,
  dfsAllowance: true,
  watchSeconds: 30,
  importDebounceSeconds: 5,
  authoritativeRevertDelaySeconds: 90,
  enforcementMaxFailures: 2,
  enforcementWindowMinutes: 60,
  rolloutOrder: 'canary',
  rolloutOfflinePolicy: 'skip',
  catchUpOnReconnect: 'auto',
  countryDefault: null,
  newNetworkFastRoaming: false,
  keepRevisions: 200,
  auditRetentionDays: 730,
  allowInsecureTransport: false,
  sealSecrets: true,
})

type NumericKey = {
  [K in keyof WifiConfigSettings]: WifiConfigSettings[K] extends number ? K : never
}[keyof WifiConfigSettings]

type BooleanKey = {
  [K in keyof WifiConfigSettings]: WifiConfigSettings[K] extends boolean ? K : never
}[keyof WifiConfigSettings]

export type WifiConfigLimits = Record<NumericKey, { min: number; max: number }>

/** Accepted range of each numeric setting (whole numbers). */
export const WIFI_CONFIG_LIMITS: Readonly<WifiConfigLimits> = Object.freeze({
  confirmTimeoutSeconds: { min: 30, max: 600 },
  // perch-apd gives a protected job at least 300 s (protocol.md 3.3).
  managementConfirmTimeoutSeconds: { min: 300, max: 1800 },
  healthWaitSeconds: { min: 10, max: 300 },
  watchSeconds: { min: 10, max: 600 },
  importDebounceSeconds: { min: 1, max: 60 },
  authoritativeRevertDelaySeconds: { min: 0, max: 3600 },
  enforcementMaxFailures: { min: 1, max: 10 },
  enforcementWindowMinutes: { min: 10, max: 1440 },
  keepRevisions: { min: 50, max: 10000 },
  auditRetentionDays: { min: 30, max: 3650 },
})

const NUMERIC_KEYS = Object.keys(WIFI_CONFIG_LIMITS) as NumericKey[]
const BOOLEAN_KEYS: BooleanKey[] = [
  'dfsAllowance',
  'newNetworkFastRoaming',
  'allowInsecureTransport',
  'sealSecrets',
]

/** ISO 3166-1 alpha-2 (upper case), as UCI `country` takes it. */
export const COUNTRY_CODE = /^[A-Z]{2}$/

/** A country code in UCI's form (upper case), or null when not a code. */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return COUNTRY_CODE.test(code) ? code : null
}

function oneOf<T extends string>(choices: readonly T[], value: unknown): T | undefined {
  return choices.includes(value as T) ? (value as T) : undefined
}

/**
 * A stored value of the wrong kind reads as the default; a number outside
 * the range (limits changed since it was saved) is clamped into it.
 */
export function normalizeWifiConfigSettings(value: unknown): WifiConfigSettings {
  const stored =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const settings: WifiConfigSettings = { ...WIFI_CONFIG_DEFAULTS }
  for (const key of NUMERIC_KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = WIFI_CONFIG_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof stored[key] === 'boolean') settings[key] = stored[key] as boolean
  }
  settings.confirmMode = oneOf(CONFIRM_MODES, stored.confirmMode) ?? settings.confirmMode
  settings.protectedConfirmMode =
    oneOf(CONFIRM_MODES, stored.protectedConfirmMode) ?? settings.protectedConfirmMode
  settings.rolloutOrder = oneOf(ROLLOUT_ORDERS, stored.rolloutOrder) ?? settings.rolloutOrder
  settings.rolloutOfflinePolicy =
    oneOf(OFFLINE_POLICIES, stored.rolloutOfflinePolicy) ?? settings.rolloutOfflinePolicy
  settings.catchUpOnReconnect =
    oneOf(CATCH_UP_POLICIES, stored.catchUpOnReconnect) ?? settings.catchUpOnReconnect
  if (stored.countryDefault === null) settings.countryDefault = null
  else if (stored.countryDefault !== undefined) {
    settings.countryDefault = normalizeCountry(stored.countryDefault)
  }
  return settings
}

/** Why a PATCH value is refused (422), or null when every given field is acceptable. */
export function wifiConfigSettingsErrors(
  changes: Record<string, unknown>
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = []
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) continue
    if ((NUMERIC_KEYS as string[]).includes(field)) {
      const { min, max } = WIFI_CONFIG_LIMITS[field as NumericKey]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        errors.push({ field, message: `${field} must be a whole number from ${min} to ${max}` })
      }
    } else if ((BOOLEAN_KEYS as string[]).includes(field)) {
      if (typeof value !== 'boolean')
        errors.push({ field, message: `${field} must be true or false` })
    } else if (field === 'confirmMode' || field === 'protectedConfirmMode') {
      if (!oneOf(CONFIRM_MODES, value)) {
        errors.push({ field, message: `${field} must be one of ${CONFIRM_MODES.join(', ')}` })
      }
    } else if (field === 'rolloutOrder') {
      if (!oneOf(ROLLOUT_ORDERS, value)) errors.push({ field, message: 'unknown rollout order' })
    } else if (field === 'rolloutOfflinePolicy') {
      if (!oneOf(OFFLINE_POLICIES, value)) errors.push({ field, message: 'unknown offline policy' })
    } else if (field === 'catchUpOnReconnect') {
      if (!oneOf(CATCH_UP_POLICIES, value))
        errors.push({ field, message: 'unknown catch-up policy' })
    } else if (field === 'countryDefault') {
      if (value !== null && normalizeCountry(value) === null) {
        errors.push({ field, message: 'countryDefault must be a two-letter country code or null' })
      }
    } else {
      errors.push({ field, message: `unknown setting ${field}` })
    }
  }
  return errors
}

export async function getWifiConfigSettings(): Promise<WifiConfigSettings> {
  return normalizeWifiConfigSettings(await SystemSetting.get<unknown>(WIFI_CONFIG_SETTING_KEY))
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updateWifiConfigSettings(
  changes: Partial<WifiConfigSettings>
): Promise<WifiConfigSettings> {
  const merged: Record<string, unknown> = { ...(await getWifiConfigSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeWifiConfigSettings(merged)
  await SystemSetting.set(WIFI_CONFIG_SETTING_KEY, settings)
  return settings
}

/** GET / PATCH /api/v1/settings/wifi-config body. */
export function wifiConfigSettingsView(settings: WifiConfigSettings) {
  return {
    settings,
    defaults: WIFI_CONFIG_DEFAULTS,
    limits: WIFI_CONFIG_LIMITS,
    choices: {
      confirmMode: CONFIRM_MODES,
      protectedConfirmMode: CONFIRM_MODES,
      rolloutOrder: ROLLOUT_ORDERS,
      rolloutOfflinePolicy: OFFLINE_POLICIES,
      catchUpOnReconnect: CATCH_UP_POLICIES,
    },
  }
}

/**
 * The confirm window of one AP job (controller.md 4.3, 6.3): a protected
 * job gets the management window (never shorter than the normal one); an
 * ordinary one the normal window plus the DFS allowance of the radios it
 * restarts (when `dfsAllowance` is on). Both are capped by what the AP
 * accepts (`confirmMaxSeconds`, when it reported one).
 */
export function wifiConfirmWindow(
  settings: WifiConfigSettings,
  options: { protected: boolean; cacAllowanceSeconds?: number; apMaxSeconds?: number | null }
): number {
  const cac = settings.dfsAllowance ? Math.max(0, options.cacAllowanceSeconds ?? 0) : 0
  const wanted = options.protected
    ? Math.max(settings.managementConfirmTimeoutSeconds, settings.confirmTimeoutSeconds + cac)
    : settings.confirmTimeoutSeconds + cac
  const cap = options.apMaxSeconds
  return typeof cap === 'number' && cap > 0 ? Math.min(wanted, cap) : wanted
}

/**
 * The confirm mode of one AP job (controller.md 4.3): reverts (Authoritative
 * Mode), catch-ups and jobs that waited in a queue always confirm on the
 * agent alone (nobody is there to click); a protected job uses
 * `protectedConfirmMode`; the rest `confirmMode`.
 */
export function wifiConfirmMode(
  settings: WifiConfigSettings,
  job: {
    protected: boolean
    kind: 'apply' | 'revert' | 'adopt'
    catchUp?: boolean
    queued?: boolean
  }
): ConfirmMode {
  if (job.kind !== 'apply' || job.catchUp || job.queued) return 'agent'
  return job.protected ? settings.protectedConfirmMode : settings.confirmMode
}

// ── the fleet fingerprint key ────────────────────────────────────────────

const FINGERPRINT_KEY_HEX = /^[0-9a-f]{64}$/

function decryptKey(stored: unknown): Buffer | null {
  if (typeof stored !== 'string' || stored.length === 0) return null
  try {
    const hex = encryption.decrypt<string>(stored)
    return typeof hex === 'string' && FINGERPRINT_KEY_HEX.test(hex) ? Buffer.from(hex, 'hex') : null
  } catch {
    return null
  }
}

/**
 * The controller-wide Wi-Fi fingerprint key (32 bytes): `hmac:` fingerprints
 * of a passphrase are the same on every AP and section (protocol.md 3.2), so
 * adoption groups interfaces by key equality and an admin-typed passphrase
 * is verified against every AP without any key leaving an AP. Created on
 * first use; a value that no longer decrypts (APP_KEY rotated) is replaced,
 * which makes every AP re-fingerprint on its next read (secrets then read
 * as unknown until an admin types them again).
 */
export async function getWifiFingerprintKey(): Promise<Buffer> {
  const existing = decryptKey(await SystemSetting.get<unknown>(WIFI_FINGERPRINT_KEY_SETTING))
  if (existing) return existing
  const fresh = randomBytes(32).toString('hex')
  const row = await SystemSetting.find(WIFI_FINGERPRINT_KEY_SETTING)
  if (row && decryptKey(row.value) === null) {
    row.value = encryption.encrypt(fresh)
    await row.save()
  } else if (!row) {
    try {
      await SystemSetting.create({
        key: WIFI_FINGERPRINT_KEY_SETTING,
        value: encryption.encrypt(fresh),
      })
    } catch {
      // Another request created it first: use theirs (read below).
    }
  }
  const stored = decryptKey(await SystemSetting.get<unknown>(WIFI_FINGERPRINT_KEY_SETTING))
  if (!stored) throw new Error('the Wi-Fi fingerprint key could not be stored')
  return stored
}
