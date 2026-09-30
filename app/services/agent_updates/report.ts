import { INSTALL_KINDS, type InstallKind } from '#services/agent_updates/manifest'

/**
 * The `update` status block both daemons report (agent-updates protocol.md
 * section 3): in perch-apd's `system.info` result, in perch-collector's
 * `collector.hello` params, and as the result of `agent.update.status`.
 *
 * The agent is trusted to be itself, not to be well formed: every field is
 * type-checked and length-capped here, unknown fields are dropped, and a
 * block that is not an object reads as null (the device then shows as not
 * reporting).
 */

export const UPDATE_METHODS = ['binary', 'package'] as const
export type UpdateMethod = (typeof UPDATE_METHODS)[number]

export const REFUSALS = [
  'self_update_off',
  'no_trusted_keys',
  'install_kind_unsupported',
  'not_openwrt',
] as const
export type Refusal = (typeof REFUSALS)[number]

export const ACTIVE_PHASES = [
  'downloading',
  'staged',
  'installing',
  'probation',
  'rolling_back',
  'refetching',
] as const
export type ActivePhase = (typeof ACTIVE_PHASES)[number]

export const RESULT_OUTCOMES = [
  'staged',
  'failed',
  'cancelled',
  'confirmed',
  'rolled_back',
  'rollback_failed',
  'rollback_unavailable',
] as const
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number]

export const UPDATE_ID_REGEX = /^u-[0-9a-f]{16}$/

export type UpdateActive = {
  updateId: string
  phase: ActivePhase
  fromVersion: string | null
  toVersion: string | null
  method: UpdateMethod | null
  rollbackStore: 'flash' | 'ram' | null
  bytes: number | null
  totalBytes: number | null
  deadline: string | null
  watchdog: 'running' | 'dead' | null
}

export type UpdateResult = {
  updateId: string
  outcome: ResultOutcome
  reason: string | null
  detail: string | null
  fromVersion: string | null
  toVersion: string | null
  at: string | null
}

export type UpdateReport = {
  protocol: number
  enabled: boolean
  refusal: Refusal | null
  keyIds: string[]
  floor: string | null
  installKind: InstallKind | null
  methods: UpdateMethod[]
  binaryPath: string | null
  binarySha256: string | null
  packageManager: 'opkg' | 'apk' | null
  packageVersion: string | null
  openwrt: { release: string | null; series: string | null; pkgArch: string | null } | null
  arch: string | null
  variant: string | null
  flash: {
    path: string | null
    fsType: string | null
    freeBytes: number
    totalBytes: number
  } | null
  ram: { memAvailableBytes: number; tmpFreeBytes: number } | null
  guard: 'installed' | 'missing' | 'outdated' | null
  previous: { version: string; store: 'flash'; sha256: string | null } | null
  active: UpdateActive | null
  results: UpdateResult[]
}

/** The preflight as the agent answers it (protocol.md 4.2), sanitised. */
export type AgentPreflight = {
  ok: boolean
  problems: { code: string; message: string; freeBytes?: number; needBytes?: number }[]
  method: UpdateMethod
  installKind: InstallKind
  rollbackStore: 'flash' | 'ram' | null
  staging: 'ram' | 'flash' | null
  downloadBytes: number
  flash: {
    path: string
    fsType: string
    freeBytes: number
    needBytes: number
    reserveBytes: number
    estimate: string
    hardlink: boolean
  }
  ram: { memAvailableBytes: number; tmpFreeBytes: number; needBytes: number; reserveBytes: number }
  busy: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  if (pattern && !pattern.test(trimmed)) return null
  return trimmed
}

/** A version as the agent reports it (`dev` included; order handles unknowns). */
function version(value: unknown): string | null {
  return str(value, 64, /^[0-9A-Za-z.+~_-]+$/)
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER)
    : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

const SHA256 = /^[0-9a-f]{64}$/
const KEY_ID = /^[0-9a-f]{16}$/

export function sanitizeActive(value: unknown): UpdateActive | null {
  if (!isObject(value)) return null
  const updateId = str(value.updateId, 18, UPDATE_ID_REGEX)
  const phase = oneOf(value.phase, ACTIVE_PHASES)
  if (!updateId || !phase) return null
  return {
    updateId,
    phase,
    fromVersion: version(value.fromVersion),
    toVersion: version(value.toVersion),
    method: oneOf(value.method, UPDATE_METHODS),
    rollbackStore: oneOf(value.rollbackStore, ['flash', 'ram'] as const),
    bytes: count(value.bytes),
    totalBytes: count(value.totalBytes),
    deadline: str(value.deadline, 40),
    watchdog: oneOf(value.watchdog, ['running', 'dead'] as const),
  }
}

export function sanitizeResult(value: unknown): UpdateResult | null {
  if (!isObject(value)) return null
  const updateId = str(value.updateId, 18, UPDATE_ID_REGEX)
  const outcome = oneOf(value.outcome, RESULT_OUTCOMES)
  if (!updateId || !outcome) return null
  return {
    updateId,
    outcome,
    reason: str(value.reason, 48, /^[a-z0-9_]+$/),
    detail: str(value.detail, 200),
    fromVersion: version(value.fromVersion),
    toVersion: version(value.toVersion),
    at: str(value.at, 40),
  }
}

/** Null when the block is not an object (no report). */
export function sanitizeUpdateReport(value: unknown): UpdateReport | null {
  if (!isObject(value)) return null
  const openwrt = isObject(value.openwrt)
    ? {
        release: str(value.openwrt.release, 32),
        series: str(value.openwrt.series, 8, /^\d{2}\.\d{2}$/),
        pkgArch: str(value.openwrt.pkgArch, 48, /^[A-Za-z0-9_-]+$/),
      }
    : null
  const flash = isObject(value.flash)
    ? {
        path: str(value.flash.path, 200),
        fsType: str(value.flash.fsType, 32),
        freeBytes: count(value.flash.freeBytes) ?? 0,
        totalBytes: count(value.flash.totalBytes) ?? 0,
      }
    : null
  const ram = isObject(value.ram)
    ? {
        memAvailableBytes: count(value.ram.memAvailableBytes) ?? 0,
        tmpFreeBytes: count(value.ram.tmpFreeBytes) ?? 0,
      }
    : null
  const previousVersion = isObject(value.previous) ? version(value.previous.version) : null
  const previous =
    isObject(value.previous) && previousVersion
      ? {
          version: previousVersion,
          store: 'flash' as const,
          sha256: str(value.previous.sha256, 64, SHA256),
        }
      : null
  const results = Array.isArray(value.results)
    ? value.results
        .map(sanitizeResult)
        .filter((entry): entry is UpdateResult => entry !== null)
        .slice(-10)
    : []
  return {
    protocol: count(value.protocol) ?? 1,
    enabled: value.enabled !== false,
    refusal: oneOf(value.refusal, REFUSALS),
    keyIds: Array.isArray(value.keyIds)
      ? value.keyIds
          .map((id) => str(id, 16, KEY_ID))
          .filter((id): id is string => id !== null)
          .slice(0, 16)
      : [],
    floor: version(value.floor),
    installKind: oneOf(value.installKind, INSTALL_KINDS),
    methods: Array.isArray(value.methods)
      ? [
          ...new Set(
            value.methods
              .map((method) => oneOf(method, UPDATE_METHODS))
              .filter((method): method is UpdateMethod => method !== null)
          ),
        ]
      : [],
    binaryPath: str(value.binaryPath, 200),
    binarySha256: str(value.binarySha256, 64, SHA256),
    packageManager: oneOf(value.packageManager, ['opkg', 'apk'] as const),
    packageVersion: str(value.packageVersion, 64),
    openwrt,
    arch: str(value.arch, 16, /^[a-z0-9]+$/),
    variant: str(value.variant, 16, /^[a-z0-9-]+$/),
    flash,
    ram,
    guard: oneOf(value.guard, ['installed', 'missing', 'outdated'] as const),
    previous,
    active: sanitizeActive(value.active),
    results,
  }
}

function problem(value: unknown): AgentPreflight['problems'][number] | null {
  if (!isObject(value)) return null
  const code = str(value.code, 48, /^[a-z0-9_]+$/)
  if (!code) return null
  const entry: AgentPreflight['problems'][number] = {
    code,
    message: str(value.message, 300) ?? code,
  }
  const free = count(value.freeBytes)
  const need = count(value.needBytes)
  if (free !== null) entry.freeBytes = free
  if (need !== null) entry.needBytes = need
  return entry
}

/** A preflight from `agent.update.stage`; null when it is not one. */
export function sanitizePreflight(value: unknown): AgentPreflight | null {
  if (!isObject(value)) return null
  const flash = isObject(value.flash) ? value.flash : {}
  const ram = isObject(value.ram) ? value.ram : {}
  return {
    ok: value.ok === true,
    problems: Array.isArray(value.problems)
      ? value.problems
          .map(problem)
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .slice(0, 16)
      : [],
    method: oneOf(value.method, UPDATE_METHODS) ?? 'binary',
    installKind: oneOf(value.installKind, INSTALL_KINDS) ?? 'other',
    rollbackStore: oneOf(value.rollbackStore, ['flash', 'ram'] as const),
    staging: oneOf(value.staging, ['ram', 'flash'] as const),
    downloadBytes: count(value.downloadBytes) ?? 0,
    flash: {
      path: str(flash.path, 200) ?? '',
      fsType: str(flash.fsType, 32) ?? '',
      freeBytes: count(flash.freeBytes) ?? 0,
      needBytes: count(flash.needBytes) ?? 0,
      reserveBytes: count(flash.reserveBytes) ?? 0,
      estimate: str(flash.estimate, 32) ?? '',
      hardlink: flash.hardlink === true,
    },
    ram: {
      memAvailableBytes: count(ram.memAvailableBytes) ?? 0,
      tmpFreeBytes: count(ram.tmpFreeBytes) ?? 0,
      needBytes: count(ram.needBytes) ?? 0,
      reserveBytes: count(ram.reserveBytes) ?? 0,
    },
    busy: str(value.busy, 64),
  }
}
