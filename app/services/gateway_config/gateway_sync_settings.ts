import Gateway from '#models/gateway'
import SystemSetting from '#models/system_setting'
import type User from '#models/user'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { planeError } from '#services/gateway_config/errors'
import type { ConfirmMode } from '#services/gateway_config/types'
import hash from '@adonisjs/core/services/hash'
import { isIP } from 'node:net'

/**
 * Settings → Gateway sync (docs/design/gateway-sync/rest.md 11, README 7):
 * the WAN safety net's tunables (check targets, per-proto check budgets, the
 * WAN confirm window and mode), Authoritative Mode's policy for WAN sections
 * (owner decision D2: `import` by default), WAN transition retention, the
 * WireGuard and UPnP switches and the multi-WAN write switch (off: decision
 * 12 stands). One `system_settings` row (`gateway_sync`), modelled on
 * `presence_settings.ts`: typed defaults, a limits table the validator and
 * the form share, a partial PATCH, 422 outside the limits. Read per request.
 */

export const GATEWAY_SYNC_SETTING_KEY = 'gateway_sync'

export type AuthoritativeWan = 'import' | 'enforce'

export interface GatewaySyncSettings {
  /** 1–8 entries: IPv4/IPv6 literals or `$gateway` (the primary uplink's next hop after the job). */
  checkTargets: string[]
  checkTcpPort: number
  /** A host name under which the router resolves a fresh label; '' = no resolve check. */
  checkResolveName: string
  checkTimeoutDhcpSeconds: number
  checkTimeoutStaticSeconds: number
  checkTimeoutPppoeSeconds: number
  checkTimeoutMobileSeconds: number
  checkTimeoutOtherSeconds: number
  /** The confirm window of a checked (WAN) job. */
  wanConfirmTimeoutSeconds: number
  wanConfirmMode: ConfirmMode
  /** Authoritative Mode and router edits of WAN sections (D2). */
  authoritativeWan: AuthoritativeWan
  transitionRetentionDays: number
  wgPeerStaleMinutes: number
  wgStepUp: boolean
  upnpOpenedEvents: boolean
  /** Owner decision 12 stands while this is off (mwan3 writes are not built). */
  multiWanWrites: boolean
}

export const GATEWAY_SYNC_DEFAULTS: Readonly<GatewaySyncSettings> = Object.freeze({
  checkTargets: ['$gateway', '1.1.1.1', '8.8.8.8'],
  checkTcpPort: 443,
  checkResolveName: 'example.com',
  checkTimeoutDhcpSeconds: 60,
  checkTimeoutStaticSeconds: 20,
  checkTimeoutPppoeSeconds: 90,
  checkTimeoutMobileSeconds: 150,
  checkTimeoutOtherSeconds: 90,
  wanConfirmTimeoutSeconds: 300,
  wanConfirmMode: 'admin_and_agent',
  authoritativeWan: 'import',
  transitionRetentionDays: 90,
  wgPeerStaleMinutes: 15,
  wgStepUp: true,
  upnpOpenedEvents: false,
  multiWanWrites: false,
}) as Readonly<GatewaySyncSettings>

type NumericKey = {
  [K in keyof GatewaySyncSettings]: GatewaySyncSettings[K] extends number ? K : never
}[keyof GatewaySyncSettings]

/** Whole-number ranges; `checkTargets` is a count. */
export const GATEWAY_SYNC_LIMITS: Readonly<
  Record<NumericKey, { min: number; max: number }> & { checkTargets: { min: number; max: number } }
> = {
  checkTargets: { min: 1, max: 8 },
  checkTcpPort: { min: 1, max: 65535 },
  checkTimeoutDhcpSeconds: { min: 10, max: 600 },
  checkTimeoutStaticSeconds: { min: 10, max: 600 },
  checkTimeoutPppoeSeconds: { min: 10, max: 600 },
  checkTimeoutMobileSeconds: { min: 10, max: 600 },
  checkTimeoutOtherSeconds: { min: 10, max: 600 },
  // The router caps it again at its config_confirm_max.
  wanConfirmTimeoutSeconds: { min: 120, max: 1800 },
  transitionRetentionDays: { min: 7, max: 730 },
  wgPeerStaleMinutes: { min: 3, max: 1440 },
}

export const GATEWAY_SYNC_CHOICES = {
  wanConfirmMode: ['agent', 'admin_and_agent'] as ConfirmMode[],
  authoritativeWan: ['import', 'enforce'] as AuthoritativeWan[],
}

const NUMERIC_KEYS = Object.keys(GATEWAY_SYNC_LIMITS).filter(
  (k) => k !== 'checkTargets'
) as NumericKey[]
const BOOLEAN_KEYS = ['wgStepUp', 'upnpOpenedEvents', 'multiWanWrites'] as const

/**
 * The perch-collector's resolve probe asks `perch-<12 hex>.<name>`, so the
 * name leaves room for that label (protocol.md 1.1, collector
 * `FreshLabelLen`): 253 − 19.
 */
export const RESOLVE_NAME_MAX = 234

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i
/** Domains a router answers itself: a fresh name there proves nothing about the internet. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'lan', 'home.arpa', 'internal', 'localdomain']

/** Why a resolve name is refused, or null. */
export function resolveNameProblem(name: string): string | null {
  if (name === '') return null
  const bare = name.endsWith('.') ? name.slice(0, -1) : name
  if (bare.length === 0 || bare.length > RESOLVE_NAME_MAX) {
    return `A host name of at most ${RESOLVE_NAME_MAX} characters.`
  }
  const labels = bare.split('.')
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) {
    return 'A host name with a dot, like example.com.'
  }
  const lower = bare.toLowerCase()
  const local = LOCAL_SUFFIXES.find((d) => lower === d || lower.endsWith(`.${d}`))
  if (local) return `The router answers .${local} itself; use an internet name.`
  return null
}

/** Is a check target valid: an IP literal or `$gateway`. */
export function validCheckTarget(value: string): boolean {
  return value === '$gateway' || isIP(value) !== 0
}

/**
 * A stored value read back: unknown fields dropped, a bad value takes its
 * default, a number outside the range (limits changed since) is clamped.
 */
export function normalizeGatewaySyncSettings(value: unknown): GatewaySyncSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const out: GatewaySyncSettings = {
    ...GATEWAY_SYNC_DEFAULTS,
    checkTargets: [...GATEWAY_SYNC_DEFAULTS.checkTargets],
  }
  for (const key of NUMERIC_KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = GATEWAY_SYNC_LIMITS[key]
    out[key] = Math.min(max, Math.max(min, candidate))
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof stored[key] === 'boolean') out[key] = stored[key] as boolean
  }
  if (Array.isArray(stored.checkTargets)) {
    const targets = [
      ...new Set(
        stored.checkTargets.filter((t): t is string => typeof t === 'string' && validCheckTarget(t))
      ),
    ].slice(0, GATEWAY_SYNC_LIMITS.checkTargets.max)
    if (targets.length >= GATEWAY_SYNC_LIMITS.checkTargets.min) out.checkTargets = targets
  }
  if (typeof stored.checkResolveName === 'string' && !resolveNameProblem(stored.checkResolveName)) {
    out.checkResolveName = stored.checkResolveName
  }
  if (GATEWAY_SYNC_CHOICES.wanConfirmMode.includes(stored.wanConfirmMode as ConfirmMode)) {
    out.wanConfirmMode = stored.wanConfirmMode as ConfirmMode
  }
  if (GATEWAY_SYNC_CHOICES.authoritativeWan.includes(stored.authoritativeWan as AuthoritativeWan)) {
    out.authoritativeWan = stored.authoritativeWan as AuthoritativeWan
  }
  return out
}

export type GatewaySyncPatch = Partial<GatewaySyncSettings>

/** Checks a PATCH against the limits: 422 `invalid_setting` {field} on the first bad field. */
export function checkGatewaySyncPatch(patch: GatewaySyncPatch): void {
  const refuse = (field: string, message: string) => {
    throw planeError(422, 'invalid_setting', message, { field })
  }
  for (const key of NUMERIC_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    const { min, max } = GATEWAY_SYNC_LIMITS[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      refuse(key, `${key} is a whole number from ${min} to ${max}.`)
    }
  }
  if (patch.checkTargets !== undefined) {
    const { min, max } = GATEWAY_SYNC_LIMITS.checkTargets
    const targets = patch.checkTargets
    if (!Array.isArray(targets) || targets.length < min || targets.length > max) {
      refuse('checkTargets', `Name ${min} to ${max} check targets.`)
    }
    const bad = targets.find((t) => typeof t !== 'string' || !validCheckTarget(t))
    if (bad !== undefined) {
      refuse('checkTargets', `"${bad}" is not an IP address or $gateway.`)
    }
    if (new Set(targets).size !== targets.length)
      refuse('checkTargets', 'A target is listed twice.')
  }
  if (patch.checkResolveName !== undefined) {
    const problem = resolveNameProblem(patch.checkResolveName)
    if (problem) refuse('checkResolveName', problem)
  }
}

export async function getGatewaySyncSettings(): Promise<GatewaySyncSettings> {
  return normalizeGatewaySyncSettings(await SystemSetting.get<unknown>(GATEWAY_SYNC_SETTING_KEY))
}

/**
 * Applies a PATCH over the stored settings. Turning `multiWanWrites` on
 * needs the admin's current password (403 `invalid_password`) and is logged
 * (`multiwan_writes_changed`) on every gateway; turning it off never needs
 * the password.
 */
export async function updateGatewaySyncSettings(
  patch: GatewaySyncPatch,
  user: User,
  currentPassword?: string
): Promise<GatewaySyncSettings> {
  checkGatewaySyncPatch(patch)
  const before = await getGatewaySyncSettings()
  const turningOn = patch.multiWanWrites === true && !before.multiWanWrites
  if (turningOn) {
    const ok = currentPassword ? await hash.verify(user.password, currentPassword) : false
    if (!ok) throw planeError(403, 'invalid_password', 'Confirm with your current password.')
  }
  const merged: Record<string, unknown> = { ...before }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeGatewaySyncSettings(merged)
  await SystemSetting.set(GATEWAY_SYNC_SETTING_KEY, settings)
  if (settings.multiWanWrites !== before.multiWanWrites) {
    for (const gateway of await Gateway.query().select('id')) {
      await recordGatewayEvent(gateway.id, 'multiwan_writes_changed', {
        userId: user.id,
        detail: { multiWanWrites: settings.multiWanWrites },
      })
    }
  }
  return settings
}

/** GET / PATCH body: the values in force, the defaults, the limits and the choices. */
export function gatewaySyncSettingsView(settings: GatewaySyncSettings) {
  return {
    settings,
    defaults: GATEWAY_SYNC_DEFAULTS,
    limits: GATEWAY_SYNC_LIMITS,
    choices: GATEWAY_SYNC_CHOICES,
  }
}
