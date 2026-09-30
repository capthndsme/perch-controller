import ApConfig from '#models/ap_config'
import type WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import { parseApplyResult, parseManagementPath } from '#services/gateway_config/gateway_registry'
import { parseSigning } from '#services/gateway_config/rpc_signing'
import {
  AGENT_ACCESS_LEVELS,
  GATEWAY_MODES,
  type AgentAccess,
} from '#services/gateway_config/types'
import { fleetKeyHexCached } from '#services/wifi_config/secrets'
import type { WifiConfigSettings } from '#services/wifi_config/settings'
import type {
  ApGroupsState,
  ApManagementPath,
  ApMode,
  ApReportedApply,
  ApReportedResult,
  ApWifiConfigBlock,
  ApWriteBlock,
} from '#services/wifi_config/types'
import { DateTime } from 'luxon'

/**
 * AP rows and their live session context (docs/design/wifi controller.md
 * section 4.1; the gateway's `gateway_registry.ts` pattern on the AP socket).
 *
 * - `ensureApConfig`: one `ap_configs` row per perch-apd whose `system.info`
 *   carries `wifiConfig`, created in mode `off`.
 * - The hello's `wifiConfig` block (access, transportOk, hashes, the open
 *   job, unacked results, management path, the groups engine) is session
 *   state, in memory per AP and dropped when the session ends. Bounded by
 *   the number of live AP sessions.
 * - `configureBlockFor`: the `wifiConfig` part of `agent.configure`, cached
 *   per AP so the synchronous configure builder can add it.
 * - `writeAccess`: offline, no capability, the AP's own opt-in, the boot
 *   guard, then the gateway's transport table (verified TLS, or both
 *   plain-HTTP opt-ins plus a pairing: pairing is phase 3, not built yet,
 *   so plain HTTP answers `not_paired`).
 */

export const WIFI_CONFIG_CAPABILITY = 'wifi_config'
/** The plane protocol this controller speaks (protocol.md 2.1). */
export const WIFI_PLANE_PROTOCOL = 1

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && k.length <= 64) out[k] = v.slice(0, 128)
  }
  return out
}

function access(value: unknown): AgentAccess | null {
  return (AGENT_ACCESS_LEVELS as readonly unknown[]).includes(value) ? (value as AgentAccess) : null
}

function strings(value: unknown, max = 32, len = 64): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.slice(0, len))
        .slice(0, max)
    : []
}

/** A `management` block with its uplink radios (protocol.md 3.8), or null. */
export function parseApManagement(value: unknown): ApManagementPath | null {
  const path = parseManagementPath(value)
  if (!path) return null
  return { ...path, radios: isObject(value) ? strings(value.radios, 16, 32) : [] }
}

function parseGroups(value: unknown): ApGroupsState | null {
  if (!isObject(value)) return null
  return {
    engine: value.engine === true,
    enabled: value.enabled === true,
    ...(typeof value.state === 'string' ? { state: value.state.slice(0, 32) } : {}),
    handedOver: value.handedOver === true,
    ...(typeof value.appliedRevision === 'number'
      ? { appliedRevision: value.appliedRevision }
      : {}),
    ...(Array.isArray(value.owned) ? { owned: strings(value.owned, 256) } : {}),
  }
}

function parseApply(value: unknown): ApReportedApply {
  if (!isObject(value) || typeof value.state !== 'string') return { state: 'idle' }
  const states = ['idle', 'applying', 'pending_confirm', 'rolling_back'] as const
  const state = (states as readonly string[]).includes(value.state)
    ? (value.state as ApReportedApply['state'])
    : 'idle'
  const out: ApReportedApply = { state }
  if (typeof value.applyId === 'string') out.applyId = value.applyId.slice(0, 64)
  if (value.kind === 'apply' || value.kind === 'revert' || value.kind === 'adopt') {
    out.kind = value.kind
  }
  if (typeof value.deadline === 'string') out.deadline = value.deadline.slice(0, 40)
  if (typeof value.protected === 'boolean') out.protected = value.protected
  if (value.health === 'pending' || value.health === 'ok' || value.health === 'failed') {
    out.health = value.health
  }
  return out
}

/** One reported outcome (`wifi.config.result`, or the hello's `results`). */
export function parseApResult(value: unknown): ApReportedResult | null {
  const base = parseApplyResult(value)
  if (!base || !isObject(value)) return null
  const kind = value.kind === 'revert' || value.kind === 'adopt' ? value.kind : 'apply'
  return {
    applyId: base.applyId,
    kind,
    outcome: base.outcome === 'failed' ? 'failed' : 'rolled_back',
    reason: base.reason ?? 'rolled_back',
    at: base.at ?? new Date().toISOString(),
    hashes: base.hashes,
    discarded: base.discarded,
    ...(isObject(value.health)
      ? { health: value.health as unknown as ApReportedResult['health'] }
      : {}),
    ...(base.detail ? { detail: base.detail } : {}),
  }
}

/** Parses `system.info.wifiConfig`; tolerant of older and newer agents. */
export function parseWifiConfigBlock(value: unknown): ApWifiConfigBlock | null {
  if (!isObject(value)) return null
  const signing = parseSigning(value.signing)
  return {
    protocol: typeof value.protocol === 'number' ? value.protocol : 0,
    access: access(value.access) ?? 'none',
    transportOk: value.transportOk === true,
    allowInsecure: value.allowInsecure === true,
    allowedConfigs: strings(value.allowedConfigs, 8),
    hashes: stringMap(value.hashes),
    apply: parseApply(value.apply),
    results: Array.isArray(value.results)
      ? value.results
          .slice(0, 64)
          .map(parseApResult)
          .filter((r): r is ApReportedResult => r !== null)
      : [],
    signing: signing
      ? {
          required: signing.required,
          challenge: signing.challenge,
          key: signing.key,
          keyId: signing.keyId ?? null,
          windowSeconds: signing.windowSeconds,
        }
      : { required: false, key: 'none' },
    management: parseApManagement(value.management),
    groups: parseGroups(value.groups),
  }
}

// ── session context ──────────────────────────────────────────────────────

export type ApSessionContext = {
  /** Increases per session of this process. */
  seq: number
  connectedAt: DateTime
  secure: boolean | null
  /** The hello's `wifiConfig` block; null = an agent without the plane. */
  block: ApWifiConfigBlock | null
  /** `system.info.capabilities`. */
  capabilities: string[]
  agentVersion: string | null
}

const sessions = new Map<number, ApSessionContext>()
let sessionSeq = 0

export function rememberApSession(
  apId: number,
  block: ApWifiConfigBlock | null,
  info: {
    connectedAt: DateTime
    secure: boolean | null
    capabilities: string[]
    agentVersion: string | null
  }
): ApSessionContext {
  const context: ApSessionContext = { seq: ++sessionSeq, ...info, block }
  sessions.set(apId, context)
  return context
}

/** The AP's live session context, when its agent is online and said hello. */
export function apSession(apId: number): ApSessionContext | null {
  const context = sessions.get(apId)
  if (!context) return null
  const live = hub.session(apId)
  if (!live || live.connectedAt.toMillis() !== context.connectedAt.toMillis()) {
    // A newer session that has not said hello yet, or none: not this context.
    if (!live) sessions.delete(apId)
    return null
  }
  return context
}

export function forgetApSession(apId: number): void {
  sessions.delete(apId)
}

/** Test-only. */
export function _resetApSessions(): void {
  sessions.clear()
  configureBlocks.clear()
}

// ── agent.configure block ────────────────────────────────────────────────

export type WifiConfigureBlock = {
  mode: ApMode
  authoritative: boolean
  watchSeconds: number
  debounceSeconds: number
  healthWaitSeconds: number
  /** The fleet fingerprint key, 64 hex (protocol.md 2.2); absent until loaded. */
  fingerprintKey?: string
}

const configureBlocks = new Map<number, WifiConfigureBlock>()

export function normalizeApMode(value: string): ApMode {
  return (GATEWAY_MODES as readonly string[]).includes(value) ? (value as ApMode) : 'off'
}

/** The block `agent.configure` carries for this AP, or null (no plane). */
export function configureBlockFor(apId: number): WifiConfigureBlock | null {
  return configureBlocks.get(apId) ?? null
}

/**
 * Caches the AP's block (called whenever its mode, Authoritative flag or
 * Settings → Wi-Fi change, and at every hello). The fingerprint key must
 * have been loaded (`fleetKey()`) before.
 */
export function setConfigureBlock(
  ap: Pick<ApConfig, 'apId' | 'mode' | 'authoritative'>,
  settings: Pick<WifiConfigSettings, 'watchSeconds' | 'importDebounceSeconds' | 'healthWaitSeconds'>
): WifiConfigureBlock {
  const mode = normalizeApMode(ap.mode)
  const key = fleetKeyHexCached()
  const block: WifiConfigureBlock = {
    mode,
    authoritative: mode === 'managed' && Boolean(ap.authoritative),
    watchSeconds: settings.watchSeconds,
    debounceSeconds: settings.importDebounceSeconds,
    healthWaitSeconds: settings.healthWaitSeconds,
    ...(key ? { fingerprintKey: key } : {}),
  }
  configureBlocks.set(ap.apId, block)
  return block
}

export function clearConfigureBlock(apId: number): void {
  configureBlocks.delete(apId)
}

// ── rows ─────────────────────────────────────────────────────────────────

/**
 * The AP's plane row, created (mode `off`) at its first hello with a
 * `wifiConfig` block. The hello's opt-ins and management path are copied
 * onto it.
 */
export async function ensureApConfig(
  apId: number,
  block: ApWifiConfigBlock | null
): Promise<ApConfig> {
  let row = await ApConfig.find(apId)
  if (!row) {
    row = new ApConfig()
    row.apId = apId
    row.mode = 'off'
    row.authoritative = false
    row.enforcement = 'active'
    row.headRevision = 0
    row.syncState = 'unknown'
    row.fleetState = 'unknown'
    row.countryMode = 'fleet'
    row.createdAt = DateTime.utc()
  }
  if (block) {
    row.agentAccess = block.access
    row.transportOk = block.transportOk
    row.allowInsecure = block.allowInsecure
    if (block.management) row.managementPath = block.management
  }
  await row.save()
  return row
}

/** The plane row of an AP, or null. */
export async function findApConfig(apId: number): Promise<ApConfig | null> {
  return ApConfig.find(apId)
}

/** The name the dashboard shows for an AP. */
export function apDisplayName(ap: Pick<WifiAccessPoint, 'id' | 'name' | 'friendlyName'>): string {
  return ap.friendlyName || ap.name || `AP ${ap.id}`
}

// ── write access ─────────────────────────────────────────────────────────

export type ApWriteAccess =
  | { writable: true; secure: true }
  | { writable: false; reason: ApWriteBlock }

/**
 * Whether the controller may write this AP now (controller.md 4.1): offline,
 * no plane, the AP's `wifi_config` below `write`, the boot guard missing,
 * then verified TLS on both ends (`secure === true` for the session and the
 * agent's `transportOk`), else `insecure_transport` (either plain-HTTP
 * opt-in off) or `not_paired` (both on: signed writes need a pairing).
 */
export function writeAccess(
  ap: Pick<ApConfig, 'apId' | 'agentAccess' | 'capabilities' | 'transportOk' | 'allowInsecure'>,
  settings: Pick<WifiConfigSettings, 'allowInsecureTransport'>
): ApWriteAccess {
  const session = apSession(ap.apId)
  if (!session) return { writable: false, reason: 'offline' }
  if (!session.block || !session.capabilities.includes(WIFI_CONFIG_CAPABILITY)) {
    return { writable: false, reason: 'no_capability' }
  }
  if ((session.block.access ?? ap.agentAccess) !== 'write') {
    return { writable: false, reason: 'router_access' }
  }
  if (ap.capabilities?.guard === 'missing') return { writable: false, reason: 'guard_missing' }
  const transportOk = session.block.transportOk ?? ap.transportOk ?? false
  if (session.secure === true && transportOk === true) return { writable: true, secure: true }
  const apOptIn = session.block.allowInsecure || ap.allowInsecure === true
  if (!settings.allowInsecureTransport || !apOptIn) {
    return { writable: false, reason: 'insecure_transport' }
  }
  return { writable: false, reason: 'not_paired' }
}

/** The documented refusal code of a write block (REST 409). */
export function writeBlockCode(reason: ApWriteBlock): string {
  switch (reason) {
    case 'offline':
      return 'agent_offline'
    case 'router_access':
      return 'router_access_insufficient'
    default:
      return reason
  }
}

export function writeBlockMessage(reason: ApWriteBlock): string {
  switch (reason) {
    case 'offline':
      return 'The access point’s agent is not connected.'
    case 'no_capability':
      return 'This perch-apd has no Wi-Fi plane: update it.'
    case 'router_access':
      return "The access point does not allow writes (perch-apd wifi_config is not 'write')."
    case 'guard_missing':
      return 'The boot guard is missing on the access point.'
    case 'not_paired':
      return 'Writes over plain HTTP need the access point paired with this controller.'
    default:
      return 'Writes need verified TLS, or the plain-HTTP opt-in on both the controller and the access point.'
  }
}

// ── holds (build plan agreement 4) ───────────────────────────────────────

type UpdateHold = (kind: 'ap' | 'collector', id: number) => boolean

/**
 * agent-updates' `deviceUpdateInFlight('ap', id)` (wave 2 wiring): while a
 * perch-apd update runs on an AP, the plane sends it no job. Always false
 * until agent-updates installs its check.
 */
let updateHold: UpdateHold = () => false

export function setDeviceUpdateHold(check: UpdateHold | null): void {
  updateHold = check ?? (() => false)
}

export function apUpdateInFlight(apId: number): boolean {
  try {
    return updateHold('ap', apId)
  } catch {
    return false
  }
}
