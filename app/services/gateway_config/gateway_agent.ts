import Gateway from '#models/gateway'
import GatewayConfigEvent from '#models/gateway_config_event'
import collectorHub, { AgentRpcError, RPC_ERRORS } from '#services/collector_agent_hub'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { emitRouterRead } from '#services/gateway_config/hooks'
import { recordGatewayEvent } from '#services/gateway_config/events'
import {
  inFlightApply,
  loadSections,
  perchIdFactory,
  refreshSyncState,
  saveStates,
  writeRevision,
} from '#services/gateway_config/gateway_store'
import {
  gatewaySession,
  normalizeMode,
  parseManagementPath,
  type WriteAccess,
} from '#services/gateway_config/gateway_registry'
import { signParams } from '#services/gateway_config/rpc_signing'
import { rejoinOffer } from '#services/gateway_config/revisions'
import { refreshOrders } from '#services/gateway_config/order_store'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { getGatewaySyncSettings } from '#services/gateway_config/gateway_sync_settings'
import { readSideFacts } from '#services/gateway_config/observed_facts'
import {
  reconcileRead,
  type EngineEvent,
  type InFlight,
} from '#services/gateway_config/sync_engine'
import type {
  GatewayCapabilities,
  LedgerEntry,
  RouterAuthor,
  UciConfig,
  UciSection,
} from '#services/gateway_config/types'
import GatewayRevision from '#models/gateway_revision'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The controller's side of the config plane RPCs (docs/gateway/config-plane.md
 * section 4): capabilities, reads, and merging a read into the rows
 * (`reconcileRead`) with its revision and events. Everything that changes a
 * gateway's rows runs inside its serial queue.
 */

export const READ_TIMEOUT_MS = 10_000
export const CAPABILITIES_TIMEOUT_MS = 10_000
/** Section 11: reads over these limits are refused whole, never partly stored. */
export const READ_LIMITS = { bytes: 2 * 1024 * 1024, sections: 2000, valueBytes: 4096 }

const NAME = /^[A-Za-z0-9_]{1,64}$/
const CONFIG_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** Section types: `bridge-vlan` has a dash; the column holds 32. */
const TYPE_NAME = /^[A-Za-z0-9_-]{1,32}$/

export class GatewayOfflineError extends Error {
  constructor() {
    super('gateway agent is offline')
    this.name = 'GatewayOfflineError'
  }
}

export class ReadRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ReadRefusedError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── requests ─────────────────────────────────────────────────────────────

/**
 * Calls a plane method on the gateway's agent. With a signed write access
 * the params travel in the signed envelope (`rpc_signing.ts`); a
 * `stale_signature` answer (clocks apart) is retried once with the agent's
 * clock.
 */
export async function gatewayRequest<T = unknown>(
  gateway: Pick<Gateway, 'id' | 'collectorId' | 'configSignKey' | 'pairingKey'>,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; access?: WriteAccess } = {}
): Promise<T> {
  if (gateway.collectorId === null) throw new GatewayOfflineError()
  const access = options.access
  if (!access || !access.writable || !access.signed) {
    return collectorHub.request<T>(gateway.collectorId, method, params, {
      timeoutMs: options.timeoutMs,
    })
  }
  const apiKey: string | Buffer | null =
    access.key === 'config_sign_key'
      ? gateway.configSignKey
      : gateway.pairingKey
        ? Buffer.from(gateway.pairingKey, 'hex')
        : null
  if (!apiKey) throw new AgentRpcError(RPC_ERRORS.COMMAND_FAILED, 'no key to sign with')
  const send = (ts?: number) =>
    collectorHub.request<T>(
      gateway.collectorId!,
      method,
      signParams(apiKey, method, access.challenge, params, { ts }) as unknown as Record<
        string,
        unknown
      >,
      { timeoutMs: options.timeoutMs }
    )
  try {
    return await send()
  } catch (error) {
    const data = error instanceof AgentRpcError ? (error.data as Record<string, unknown>) : null
    if (data?.error === 'stale_signature' && typeof data.agentTime === 'number') {
      return send(Math.floor(data.agentTime))
    }
    throw error
  }
}

/** The `data.error` code of an agent refusal, if it is one. */
export function agentErrorCode(error: unknown): string | null {
  if (!(error instanceof AgentRpcError)) return null
  const data = error.data as Record<string, unknown> | null
  return data && typeof data.error === 'string' ? data.error : null
}

// ── capabilities ─────────────────────────────────────────────────────────

/** `gateway.capabilities` onto the row (`capabilities`, `management_path`). */
export async function fetchCapabilities(gateway: Gateway): Promise<GatewayCapabilities> {
  const result = await gatewayRequest<unknown>(
    gateway,
    'gateway.capabilities',
    {},
    {
      timeoutMs: CAPABILITIES_TIMEOUT_MS,
    }
  )
  const caps = isObject(result) ? (result as GatewayCapabilities) : {}
  const merged: GatewayCapabilities = {
    ...caps,
    capable: gateway.capabilities?.capable ?? true,
  }
  gateway.capabilities = merged
  gateway.capabilitiesAt = DateTime.utc()
  if (caps.access) gateway.agentAccess = caps.access
  const management = parseManagementPath(caps.management)
  if (management) gateway.managementPath = management
  await gateway.save()
  return merged
}

// ── reads ────────────────────────────────────────────────────────────────

export type ParsedRead = {
  readAt: string | null
  configs: UciConfig[]
  ledger: LedgerEntry[]
  uncommitted: string[]
  luciPending: boolean
}

/** Validates a `gateway.config.read` result (untrusted; section 11 limits). */
export function parseRead(result: unknown): ParsedRead {
  if (!isObject(result) || !Array.isArray(result.configs)) {
    throw new ReadRefusedError('read_malformed', 'the read has no configs')
  }
  if (JSON.stringify(result).length > READ_LIMITS.bytes) {
    throw new ReadRefusedError('read_too_large', 'the read is over 2 MiB')
  }
  let sectionCount = 0
  const configs: UciConfig[] = []
  for (const raw of result.configs) {
    if (!isObject(raw) || typeof raw.name !== 'string' || !CONFIG_NAME.test(raw.name)) {
      throw new ReadRefusedError('read_malformed', 'a config without a valid name')
    }
    const sections: UciSection[] = []
    const list = Array.isArray(raw.sections) ? raw.sections : []
    sectionCount += list.length
    if (sectionCount > READ_LIMITS.sections) {
      throw new ReadRefusedError('read_too_large', 'the read has over 2000 sections')
    }
    list.forEach((s: unknown, i: number) => {
      if (!isObject(s) || typeof s.name !== 'string' || typeof s.type !== 'string') {
        throw new ReadRefusedError('read_malformed', `a section of ${raw.name} is malformed`)
      }
      if (!NAME.test(s.name) || !TYPE_NAME.test(s.type)) {
        throw new ReadRefusedError('read_malformed', `section name or type in ${raw.name}`)
      }
      const options: Record<string, string | string[]> = {}
      if (isObject(s.options)) {
        for (const [key, value] of Object.entries(s.options)) {
          if (!NAME.test(key)) {
            throw new ReadRefusedError('read_malformed', `option name ${key} in ${raw.name}`)
          }
          if (typeof value === 'string') {
            if (Buffer.byteLength(value) > READ_LIMITS.valueBytes) {
              throw new ReadRefusedError('read_too_large', `a value over 4 KiB in ${raw.name}`)
            }
            options[key] = value
          } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
            if (value.some((v) => Buffer.byteLength(v) > READ_LIMITS.valueBytes)) {
              throw new ReadRefusedError('read_too_large', `a value over 4 KiB in ${raw.name}`)
            }
            options[key] = [...value]
          } else {
            throw new ReadRefusedError('read_malformed', `option ${key} in ${raw.name}`)
          }
        }
      }
      const secrets: Record<string, string> = {}
      if (isObject(s.secrets)) {
        for (const [key, value] of Object.entries(s.secrets)) {
          if (NAME.test(key) && typeof value === 'string') secrets[key] = value.slice(0, 64)
        }
      }
      sections.push({
        name: s.name,
        type: s.type,
        anonymous: s.anonymous === true,
        index: typeof s.index === 'number' ? s.index : i,
        options,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      })
    })
    configs.push({ name: raw.name, hash: typeof raw.hash === 'string' ? raw.hash : '', sections })
  }
  const ledger: LedgerEntry[] = []
  if (Array.isArray(result.ledger)) {
    for (const e of result.ledger) {
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
  }
  return {
    readAt: typeof result.readAt === 'string' ? result.readAt : null,
    configs,
    ledger,
    uncommitted: Array.isArray(result.uncommitted)
      ? result.uncommitted.filter((c): c is string => typeof c === 'string').slice(0, 64)
      : [],
    luciPending: result.luciPending === true,
  }
}

export type ReadOutcome = {
  changedConfigs: string[]
  changes: number
  revision: number | null
  observedAt: string
  read: ParsedRead
}

/**
 * Reads the router's configs and merges them into the rows (section 5.5,
 * `reconcileRead`): creates, imports, merges, conflicts, drift, mirrors.
 * Writes the events and, when a base changed, a revision (a live agent
 * reported this state, so it is confirmed; a merge is confirmed by the
 * apply that pushes its controller half). Runs inside the serial queue.
 */
export async function readAndReconcile(
  gatewayId: number,
  options: { author?: RouterAuthor | null; reason?: string } = {}
): Promise<ReadOutcome> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.findOrFail(gatewayId)
    const mode = normalizeMode(gateway.mode)
    if (mode === 'off') throw new ReadRefusedError('mode_off', 'the gateway is off')
    if (!gatewaySession(gateway.collectorId)) throw new GatewayOfflineError()

    let read: ParsedRead
    try {
      read = parseRead(
        await gatewayRequest(gateway, 'gateway.config.read', {}, { timeoutMs: READ_TIMEOUT_MS })
      )
    } catch (error) {
      if (error instanceof ReadRefusedError) {
        await recordGatewayEvent(gateway.id, 'read_refused', {
          detail: { error: error.code, message: error.message },
        })
      } else {
        const code = agentErrorCode(error)
        if (code) {
          await recordGatewayEvent(gateway.id, 'read_refused', {
            detail: { error: code, message: (error as Error).message },
          })
        }
      }
      throw error
    }
    return mergeRead(gateway, read, options)
  })
}

/** The merge half of `readAndReconcile` (exported for the enable-authoritative flow). */
export async function mergeRead(
  gateway: Gateway,
  read: ParsedRead,
  options: { author?: RouterAuthor | null; reason?: string } = {}
): Promise<ReadOutcome> {
  const registry = domainRegistry()
  const now = DateTime.utc()
  const mode = normalizeMode(gateway.mode)
  const loaded = await loadSections(gateway.id)
  const flight = await inFlightApply(gateway.id)
  const inFlight = new Map<string, InFlight>()
  for (const id of flight?.perchIds ?? []) {
    inFlight.set(id, flight!.kind === 'revert' ? 'revert' : 'apply')
  }
  const result = reconcileRead({
    rows: loaded.states,
    read: { configs: read.configs, ledger: read.ledger },
    registry,
    mode,
    authoritative: mode === 'managed' && Boolean(gateway.authoritative),
    now: now.toISO()!,
    newPerchId: perchIdFactory(loaded.states.map((s) => s.perchId)),
    inFlight,
    // Gateway sync domains.md 1.2: domains the agent cannot serve claim nothing.
    capabilities: gateway.capabilities,
    // Gateway sync: the WAN's Authoritative policy (1.7) and the side rule's
    // agent facts (domains.md 2).
    gatewaySync: await getGatewaySyncSettings(),
    sideFacts: await readSideFacts(gateway.collectorId),
  })
  const events = await withoutRepeatedDeferrals(gateway.id, result.events)

  const before = loaded.states
  const afterById = new Map(before.map((s) => [s.perchId, s]))
  for (const change of result.changes) {
    if (change.after) afterById.set(change.perchId, change.after)
    else afterById.delete(change.perchId)
  }
  const after = [...afterById.values()]
  const hashes = Object.fromEntries(read.configs.map((c) => [c.name, c.hash]))
  const previousLedger = gateway.observedLedger ?? []
  const author = options.author ?? null
  // README 3.7: the router's ledger emptied under a gateway Perch managed
  // (a reset, or a wiped ledger): offer the last confirmed revision from
  // before this read, which is about to record the reset state.
  const reset = previousLedger.length > 0 && read.ledger.length === 0 && !gateway.rejoinOffer
  const offered = reset ? await lastConfirmedRevision(gateway.id) : null

  let revision: number | null = null
  await db.transaction(async (trx) => {
    await saveStates(gateway.id, loaded.rows, result.changes, {
      routerAuthor: author,
      now,
      trx,
    })
    gateway.useTransaction(trx)
    gateway.observedHashes = { ...(gateway.observedHashes ?? {}), ...hashes }
    gateway.observedLedger = read.ledger
    gateway.observedState = {
      luciPending: read.luciPending,
      uncommitted: read.uncommitted,
      readAt: read.readAt,
    }
    gateway.observedAt = now
    await gateway.save()
    if (result.revisionSource) {
      revision = await writeRevision(gateway, {
        before,
        after,
        source: result.revisionSource,
        routerAuthor: author,
        confirmed: result.revisionSource !== 'merge',
        hashes,
        now,
        trx,
      })
    }
    for (const event of events) {
      await recordGatewayEvent(gateway.id, event.event, {
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

  if (reset) await offerRejoin(gateway, 'ledger_reset', offered)

  // Section orders (docs/gateway/firewall.md section 3), except in configs
  // an apply in flight is rewriting.
  await refreshOrders(gateway, after, { frozen: flight?.configs ?? [] })

  const perchIds: Record<string, Record<string, string>> = {}
  for (const entry of read.ledger) (perchIds[entry.config] ??= {})[entry.section] = entry.perchId
  await emitRouterRead({ gatewayId: gateway.id, configs: read.configs, perchIds })

  await refreshSyncState(gateway)
  const changedConfigs = [
    ...new Set(
      result.changes
        .map((c) => (c.after ?? c.before)?.config)
        .filter((c): c is string => typeof c === 'string')
    ),
  ].sort()
  if (options.reason) {
    logger.debug(
      { gatewayId: gateway.id, reason: options.reason, changes: result.changes.length },
      'gateway_agent: read merged'
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

/**
 * `rehome_deferred` (gateway sync domains.md 1.3) is logged once per wait: a
 * row still waiting for the same re-home is not logged again on every read.
 * Looked up only when the read produced one.
 */
async function withoutRepeatedDeferrals(
  gatewayId: number,
  events: EngineEvent[]
): Promise<EngineEvent[]> {
  if (!events.some((e) => e.event === 'rehome_deferred')) return events
  const recent = await GatewayConfigEvent.query()
    .where('gateway_id', gatewayId)
    .whereIn('event', ['rehome_deferred', 'section_rehomed'])
    .orderBy('id', 'desc')
    .limit(500)
  const last = new Map<string, { event: string; to: unknown }>()
  for (const row of recent) {
    const perchId = row.detail?.perchId
    if (typeof perchId !== 'string' || last.has(perchId)) continue
    last.set(perchId, { event: row.event, to: row.detail?.to ?? null })
  }
  return events.filter((e) => {
    if (e.event !== 'rehome_deferred' || e.perchId === null) return true
    const previous = last.get(e.perchId)
    return !(previous?.event === 'rehome_deferred' && previous.to === (e.detail?.to ?? null))
  })
}

/** The newest confirmed revision of a gateway (README 3.7), or null. */
export async function lastConfirmedRevision(gatewayId: number): Promise<number | null> {
  const confirmed = await GatewayRevision.query()
    .where('gateway_id', gatewayId)
    .whereNotNull('confirmed_at')
    .select('number', 'confirmed_at')
  return rejoinOffer(confirmed.map((r) => ({ number: r.number, confirmedAt: r.confirmedAt })))
}

/** Records the rejoin offer (README 3.7): the newest confirmed revision. */
export async function offerRejoin(
  gateway: Gateway,
  reason: 'ledger_reset' | 'rebound',
  revision: number | null
): Promise<void> {
  if (revision === null) return
  gateway.rejoinOffer = { revision, reason, detectedAt: DateTime.utc().toISO()! }
  await gateway.save()
  await recordGatewayEvent(gateway.id, 'rejoin_offered', { revision, detail: { reason } })
}
