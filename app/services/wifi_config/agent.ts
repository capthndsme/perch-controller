import ApConfig from '#models/ap_config'
import ApConfigRevision from '#models/ap_config_revision'
import hub from '#services/ap_agent_hub'
import {
  agentErrorCode,
  READ_LIMITS,
  ReadRefusedError,
} from '#services/gateway_config/gateway_agent'
import { rejoinOffer } from '#services/gateway_config/revisions'
import { reconcileRead, type InFlight } from '#services/gateway_config/sync_engine'
import type { LedgerEntry, RouterAuthor } from '#services/gateway_config/types'
import { apRegistry } from '#services/wifi_config/domains/index'
import { recordApEvent } from '#services/wifi_config/events'
import { apSession, normalizeApMode, parseApManagement } from '#services/wifi_config/registry'
import {
  apConfigQueue,
  apPerchIdFactory,
  inFlightApApply,
  loadApSections,
  refreshApSyncState,
  saveApStates,
  statesAfter,
  writeApRevision,
} from '#services/wifi_config/store'
import type {
  ApCapabilities,
  ApConfigRead,
  ApGuardState,
  ApReadConfig,
  ApReadSection,
  WifiHealth,
} from '#services/wifi_config/types'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The controller's side of the `wifi.*` RPCs (docs/design/wifi
 * controller.md section 4.2, protocol.md section 3): capabilities, health,
 * reads and their merge into the AP's rows (the core's `reconcileRead`),
 * with the revision, the events and then the fleet reconcile. Everything
 * that changes an AP's rows runs inside its serial queue.
 */

export const READ_TIMEOUT_MS = 10_000
export const CAPABILITIES_TIMEOUT_MS = 10_000
export const HEALTH_TIMEOUT_MS = 10_000

export { agentErrorCode, ReadRefusedError }

export class ApOfflineError extends Error {
  constructor() {
    super('the access point’s agent is offline')
    this.name = 'ApOfflineError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One RPC to the AP's agent (plain: signed writes come with pairing, phase 3). */
export async function apRequest<T = unknown>(
  apId: number,
  method: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {}
): Promise<T> {
  return hub.request<T>(apId, method, params, { timeoutMs: options.timeoutMs })
}

// ── capabilities ─────────────────────────────────────────────────────────

const GUARD_STATES: ApGuardState[] = ['installed', 'self_installed', 'missing']

/** `wifi.capabilities` onto the row (capabilities, opt-ins, guard, management path). */
export async function fetchApCapabilities(ap: ApConfig): Promise<ApCapabilities> {
  const result = await apRequest<unknown>(
    ap.apId,
    'wifi.capabilities',
    {},
    { timeoutMs: CAPABILITIES_TIMEOUT_MS }
  )
  const caps = (isObject(result) ? result : {}) as ApCapabilities
  if (JSON.stringify(caps).length > 1_000_000) {
    throw new ReadRefusedError('read_too_large', 'the capabilities are over 1 MB')
  }
  const before = JSON.stringify(ap.capabilities ?? null)
  ap.capabilities = caps
  ap.capabilitiesAt = DateTime.utc()
  if (caps.access) ap.agentAccess = caps.access
  if (typeof caps.transportOk === 'boolean') ap.transportOk = caps.transportOk
  if (typeof caps.allowInsecure === 'boolean') ap.allowInsecure = caps.allowInsecure
  ap.guard = GUARD_STATES.includes(caps.guard as ApGuardState) ? (caps.guard as ApGuardState) : null
  const management = parseApManagement(caps.management)
  if (management) ap.managementPath = management
  await ap.save()
  if (before !== 'null' && before !== JSON.stringify(caps)) {
    await recordApEvent(ap.apId, 'capabilities_changed', {
      detail: {
        radios: (caps.radios ?? []).map((r) => ({ section: r.section, present: r.present })),
      },
    })
  }
  return caps
}

// ── health ───────────────────────────────────────────────────────────────

/** Parses a `wifi.health` report (protocol.md 3.7), tolerant. */
export function parseHealth(value: unknown): WifiHealth | null {
  if (!isObject(value)) return null
  const radios = Array.isArray(value.radios) ? value.radios.filter(isObject).slice(0, 16) : []
  const bss = Array.isArray(value.bss) ? value.bss.filter(isObject).slice(0, 128) : []
  const problems = Array.isArray(value.problems) ? value.problems.filter(isObject).slice(0, 64) : []
  return {
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : new Date().toISOString(),
    ok: value.ok === true,
    pending: value.pending === true,
    radios: radios.map((r) => ({
      section: String(r.section ?? ''),
      up: r.up === true,
      retrySetupFailed: r.retrySetupFailed === true,
      channel: typeof r.channel === 'number' ? r.channel : null,
      dfs: isObject(r.dfs)
        ? {
            cacActive: r.dfs.cacActive === true,
            cacSecondsLeft: typeof r.dfs.cacSecondsLeft === 'number' ? r.dfs.cacSecondsLeft : 0,
          }
        : null,
    })),
    bss: bss.map((b) => ({
      section: String(b.section ?? ''),
      ifname: typeof b.ifname === 'string' ? b.ifname : null,
      ssid: typeof b.ssid === 'string' ? b.ssid : '',
      status: typeof b.status === 'string' ? b.status : 'UNKNOWN',
      expected: b.expected === true,
      bssid: typeof b.bssid === 'string' ? b.bssid : null,
    })),
    problems: problems.map((p) => ({
      code: String(p.code ?? 'unknown'),
      section: typeof p.section === 'string' ? p.section : null,
      message: typeof p.message === 'string' ? p.message.slice(0, 500) : '',
    })),
  }
}

/** `wifi.health` now, stored on the row. */
export async function fetchApHealth(ap: ApConfig): Promise<WifiHealth | null> {
  const health = parseHealth(
    await apRequest(ap.apId, 'wifi.health', {}, { timeoutMs: HEALTH_TIMEOUT_MS })
  )
  if (health) {
    ap.health = health
    ap.healthAt = DateTime.utc()
    await ap.save()
  }
  return health
}

// ── reads ────────────────────────────────────────────────────────────────

const NAME = /^[A-Za-z0-9_]{1,64}$/
const CONFIG_NAME = /^[A-Za-z0-9_-]{1,32}$/
const TYPE_NAME = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Validates a `wifi.config.read` result (untrusted; the gateway's read
 * limits). Keeps the AP-only fields: `owner: "groups"` on the device-groups
 * engine's sections (never claimed by a domain), and `groupsOwned`.
 */
export function parseApRead(result: unknown): ApConfigRead {
  if (!isObject(result) || !Array.isArray(result.configs)) {
    throw new ReadRefusedError('read_malformed', 'the read has no configs')
  }
  if (JSON.stringify(result).length > READ_LIMITS.bytes) {
    throw new ReadRefusedError('read_too_large', 'the read is over 2 MiB')
  }
  let count = 0
  const configs: ApReadConfig[] = []
  for (const raw of result.configs) {
    if (!isObject(raw) || typeof raw.name !== 'string' || !CONFIG_NAME.test(raw.name)) {
      throw new ReadRefusedError('read_malformed', 'a config without a valid name')
    }
    const list = Array.isArray(raw.sections) ? raw.sections : []
    count += list.length
    if (count > READ_LIMITS.sections) {
      throw new ReadRefusedError('read_too_large', 'the read has over 2000 sections')
    }
    const sections: ApReadSection[] = list.map((s: unknown, i: number) => {
      if (!isObject(s) || typeof s.name !== 'string' || typeof s.type !== 'string') {
        throw new ReadRefusedError('read_malformed', `a section of ${raw.name} is malformed`)
      }
      if (!NAME.test(s.name) || !TYPE_NAME.test(s.type)) {
        throw new ReadRefusedError('read_malformed', `section name or type in ${raw.name}`)
      }
      const options: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(isObject(s.options) ? s.options : {})) {
        if (!NAME.test(key)) {
          throw new ReadRefusedError('read_malformed', `option name ${key} in ${raw.name}`)
        }
        const values = typeof value === 'string' ? [value] : value
        if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
          throw new ReadRefusedError('read_malformed', `option ${key} in ${raw.name}`)
        }
        if (values.some((v) => Buffer.byteLength(v) > READ_LIMITS.valueBytes)) {
          throw new ReadRefusedError('read_too_large', `a value over 4 KiB in ${raw.name}`)
        }
        options[key] = typeof value === 'string' ? value : [...(value as string[])]
      }
      const secrets: Record<string, string> = {}
      for (const [key, value] of Object.entries(isObject(s.secrets) ? s.secrets : {})) {
        if (NAME.test(key) && typeof value === 'string') secrets[key] = value.slice(0, 64)
      }
      const section: ApReadSection = {
        name: s.name,
        type: s.type,
        anonymous: s.anonymous === true,
        index: typeof s.index === 'number' ? s.index : i,
        options,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        ...(s.owner === 'groups' ? { owner: 'groups' as const } : {}),
      }
      return section
    })
    configs.push({ name: raw.name, hash: typeof raw.hash === 'string' ? raw.hash : '', sections })
  }
  const ledger: LedgerEntry[] = []
  for (const e of Array.isArray(result.ledger) ? result.ledger : []) {
    if (
      isObject(e) &&
      typeof e.perchId === 'string' &&
      typeof e.config === 'string' &&
      typeof e.section === 'string'
    ) {
      ledger.push({
        perchId: e.perchId.slice(0, 24),
        config: e.config.slice(0, 32),
        section: e.section.slice(0, 64),
        domain: typeof e.domain === 'string' ? e.domain.slice(0, 32) : '',
      })
    }
  }
  const groupsOwned = isObject(result.groupsOwned)
    ? {
        dynamicVlan: Array.isArray(result.groupsOwned.dynamicVlan)
          ? result.groupsOwned.dynamicVlan.filter((v): v is string => typeof v === 'string')
          : [],
      }
    : undefined
  return {
    readAt: typeof result.readAt === 'string' ? result.readAt : new Date().toISOString(),
    configs,
    ledger,
    uncommitted: Array.isArray(result.uncommitted)
      ? result.uncommitted.filter((c): c is string => typeof c === 'string').slice(0, 64)
      : [],
    luciPending: result.luciPending === true,
    ...(groupsOwned ? { groupsOwned } : {}),
  }
}

export type ApReadOutcome = {
  changedConfigs: string[]
  changes: number
  revision: number | null
  observedAt: string
  read: ApConfigRead
}

/**
 * Reads the AP's configs and merges them (controller.md 4.2): the core's
 * `reconcileRead` over the AP's registry (built from its capabilities),
 * then the fleet reconcile. Runs inside the AP's queue.
 */
export async function readAndReconcileAp(
  apId: number,
  options: { author?: RouterAuthor | null; reason?: string } = {}
): Promise<ApReadOutcome> {
  return apConfigQueue.run(apId, async () => {
    const ap = await ApConfig.findOrFail(apId)
    if (normalizeApMode(ap.mode) === 'off') {
      throw new ReadRefusedError('mode_off', 'Wi-Fi management is off for this access point')
    }
    if (!apSession(apId)) throw new ApOfflineError()
    let read: ApConfigRead
    try {
      read = parseApRead(
        await apRequest(apId, 'wifi.config.read', {}, { timeoutMs: READ_TIMEOUT_MS })
      )
    } catch (error) {
      const code = error instanceof ReadRefusedError ? error.code : (agentErrorCode(error) ?? null)
      if (code) {
        await recordApEvent(apId, 'read_refused', {
          detail: { error: code, message: (error as Error).message },
        })
      }
      throw error
    }
    return mergeApRead(ap, read, options)
  })
}

/** The newest confirmed revision of an AP (the rejoin offer), or null. */
export async function lastConfirmedApRevision(apId: number): Promise<number | null> {
  const rows = await ApConfigRevision.query()
    .where('ap_id', apId)
    .whereNotNull('confirmed_at')
    .select('number', 'confirmed_at')
  return rejoinOffer(rows.map((r) => ({ number: r.number, confirmedAt: r.confirmedAt })))
}

/** The merge half of a read (exported for the enable-Authoritative flow). */
export async function mergeApRead(
  ap: ApConfig,
  read: ApConfigRead,
  options: { author?: RouterAuthor | null; reason?: string } = {}
): Promise<ApReadOutcome> {
  const registry = apRegistry(ap.capabilities, { trunkOverride: ap.trunkOverride })
  const now = DateTime.utc()
  const mode = normalizeApMode(ap.mode)
  const loaded = await loadApSections(ap.apId)
  const flight = await inFlightApApply(ap.apId)
  const inFlight = new Map<string, InFlight>()
  for (const id of flight?.perchIds ?? []) {
    inFlight.set(id, flight!.kind === 'revert' ? 'revert' : 'apply')
  }
  const result = reconcileRead({
    rows: loaded.states,
    read: { configs: read.configs, ledger: read.ledger },
    registry,
    mode,
    authoritative: mode === 'managed' && Boolean(ap.authoritative),
    now: now.toISO()!,
    newPerchId: apPerchIdFactory(loaded.states.map((s) => s.perchId)),
    inFlight,
  })
  const after = statesAfter(loaded.states, result.changes)
  const hashes = Object.fromEntries(read.configs.map((c) => [c.name, c.hash]))
  const previousLedger = ap.observedLedger ?? []
  const author = options.author ?? null
  // A reset AP (the ledger emptied under an AP Perch managed): offer the
  // newest confirmed revision from before this read, or the fleet render.
  const reset = previousLedger.length > 0 && read.ledger.length === 0 && !ap.rejoinOffer
  const offered = reset ? await lastConfirmedApRevision(ap.apId) : null

  let revision: number | null = null
  await db.transaction(async (trx) => {
    await saveApStates(ap.apId, loaded.rows, result.changes, { routerAuthor: author, now, trx })
    ap.useTransaction(trx)
    ap.observedHashes = { ...(ap.observedHashes ?? {}), ...hashes }
    ap.observedLedger = read.ledger
    ap.observedState = {
      luciPending: read.luciPending,
      uncommitted: read.uncommitted,
      readAt: read.readAt,
    }
    ap.observedAt = now
    await ap.save()
    if (result.revisionSource) {
      revision = await writeApRevision(ap, {
        before: loaded.states,
        after,
        source: result.revisionSource,
        routerAuthor: author,
        confirmed: result.revisionSource !== 'merge',
        hashes,
        now,
        trx,
      })
    }
    for (const event of result.events) {
      await recordApEvent(ap.apId, event.event, {
        revision,
        detail: {
          perchId: event.perchId,
          config: event.config,
          section: event.section,
          ...(event.detail ?? {}),
          ...(author ? { author } : {}),
        },
        trx,
      })
    }
  })

  if (reset) {
    ap.rejoinOffer = {
      revision: offered,
      reason: 'ledger_reset',
      detectedAt: now.toISO()!,
      fleet: true,
    }
    await ap.save()
    await recordApEvent(ap.apId, 'rejoin_offered', {
      revision: offered,
      detail: { reason: 'ledger_reset' },
    })
  }
  await refreshApSyncState(ap)

  // The fleet reconcile (controller.md 5.3), in the same queue task.
  try {
    const { reconcileApFleet } = await import('#services/wifi_config/fleet_service')
    await reconcileApFleet(ap.apId)
  } catch (error) {
    logger.warn(
      { apId: ap.apId, error: (error as Error).message },
      'wifi_config: fleet reconcile failed'
    )
  }

  const changedConfigs = [
    ...new Set(
      result.changes
        .map((c) => (c.after ?? c.before)?.config)
        .filter((c): c is string => typeof c === 'string')
    ),
  ].sort()
  if (options.reason) {
    logger.debug(
      { apId: ap.apId, reason: options.reason, changes: result.changes.length },
      'wifi_config: read merged'
    )
  }
  return {
    changedConfigs,
    changes: result.changes.length,
    revision,
    observedAt: now.toISO()!,
    read,
  }
}
