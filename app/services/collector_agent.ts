import Collector, { type CollectorStatus } from '#models/collector'
import collectorHub, {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
  CLOSE_CODES,
} from '#services/collector_agent_hub'
import {
  ingestCollectorSnapshot,
  type CollectorSnapshot,
  type PollOutcome,
} from '#services/collector_poller'
import { keysMatch } from '#services/collector_announce'
import { upsertProtocolCategories, type ProtocolCategoryInput } from '#services/protocol_categories'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Collectors on the socket (docs/collector-agent.md section 3). The server
 * sets each session's push schedule with `agent.configure`; the collector
 * then sends `collector.push` with the same summary + devices a poll would
 * fetch, and every accepted push goes through `ingestCollectorSnapshot`, so
 * deltas, buckets, identities and `last_status` are exactly the poll path's.
 * Rows are bucketed by server receive time; the collector's clock is ignored.
 */

/** Same slack the poll task gives a due row. */
const EARLY_PUSH_SLACK_MS = 1500
/** Stale after max(3 intervals, 30 s) without an accepted push. */
const STALE_INTERVALS = 3
const STALE_MIN_SECONDS = 30
/** `collector.status` stands in for the HTTP probe; same bound. */
export const COLLECTOR_STATUS_TIMEOUT_MS = 5000
const PROTOCOLS_TIMEOUT_MS = 15_000

export type CollectorConfigureParams = {
  metricsIntervalSeconds: number
  lifecycle: string
}

export type CollectorPushOutcome =
  | { status: 'ingested'; outcome: PollOutcome }
  | {
      status: 'dropped'
      reason:
        | 'invalid'
        | 'missing'
        | 'not_adopted'
        | 'disabled'
        | 'not_agent'
        | 'too_early'
        | 'superseded'
    }

type QueuedPush = {
  snapshot: CollectorSnapshot
  receivedAt: DateTime
  resolve: (outcome: CollectorPushOutcome) => void
}

type PushState = {
  /** Server receive time (ms) of the last accepted push. */
  lastAcceptedAt: number | null
  /** When a non-zero schedule was last sent (ms): freshness counts from here too. */
  scheduleSetAt: number | null
  /** One ingest at a time per collector… */
  running: boolean
  /** …and while it runs, only the newest push waits (counters are cumulative). */
  queued: QueuedPush | null
  /** Reference time of the stale episode already reported, if any. */
  staleReportedFor: number | null
}

const states = new Map<number, PushState>()

/**
 * The bearer each live session presented, by collector id. Adoption binds a
 * key the admin did not paste to the one the connected collector proved it
 * holds, and a key change closes a session that holds another one.
 */
const sessionKeys = new Map<number, string>()

function stateFor(collectorId: number): PushState {
  let state = states.get(collectorId)
  if (!state) {
    state = {
      lastAcceptedAt: null,
      scheduleSetAt: null,
      running: false,
      queued: null,
      staleReportedFor: null,
    }
    states.set(collectorId, state)
  }
  return state
}

/** Test-only: forget every collector's push state and session keys. */
export function _resetCollectorAgentState(): void {
  states.clear()
  sessionKeys.clear()
}

export function rememberSessionKey(collectorId: number, key: string): void {
  sessionKeys.set(collectorId, key)
}

export function forgetSessionKey(collectorId: number): void {
  sessionKeys.delete(collectorId)
}

/** The bearer the live session presented, when the collector is online. */
export function presentedSessionKey(collectorId: number): string | null {
  if (!collectorHub.isOnline(collectorId)) return null
  return sessionKeys.get(collectorId) ?? null
}

/**
 * After a key change (adopt, edit): a live session that presented another key
 * is closed with 4001, so the collector reconnects and meets the new key at
 * the door. Returns true when it closed one.
 */
export function closeSessionOnKeyMismatch(collector: Collector): boolean {
  const presented = presentedSessionKey(collector.id)
  if (presented === null || collector.apiKey === null) return false
  if (keysMatch(collector.apiKey, presented)) return false
  logger.warn(
    { collectorId: collector.id },
    'collector_agent: stored key no longer matches the live session; closing it'
  )
  return collectorHub.disconnect(collector.id, CLOSE_CODES.REVOKED, 'collector key changed')
}

/** Interval 0 pauses: pending, dismissed or disabled rows never push. */
export function collectorConfigureParams(collector: Collector): CollectorConfigureParams {
  const inService = collector.lifecycle === 'adopted' && Boolean(collector.enabled)
  return {
    metricsIntervalSeconds: inService ? collector.pollIntervalSeconds : 0,
    lifecycle: collector.lifecycle,
  }
}

/** Sends `agent.configure` when the collector is online. */
export function sendCollectorConfigure(collector: Collector): boolean {
  const params = collectorConfigureParams(collector)
  const sent = collectorHub.notify(collector.id, 'agent.configure', params)
  if (sent && params.metricsIntervalSeconds > 0) {
    stateFor(collector.id).scheduleSetAt = Date.now()
  }
  return sent
}

type PushParams = {
  summary?: unknown
  meta?: unknown
  devices?: unknown
  gateway?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The ingestible part of `collector.push` params, or null when it is not one. */
function snapshotOf(params: unknown): CollectorSnapshot | null {
  if (!isObject(params)) return null
  const push = params as PushParams
  if (!isObject(push.summary) || !Array.isArray(push.devices)) return null
  return {
    summary: push.summary as CollectorSnapshot['summary'],
    meta: isObject(push.meta) ? (push.meta as CollectorSnapshot['meta']) : null,
    devices: push.devices as CollectorSnapshot['devices'],
    gateway: isObject(push.gateway) ? (push.gateway as CollectorSnapshot['gateway']) : null,
  }
}

/**
 * One `collector.push`. Validated right away; ingestion runs one push at a
 * time per collector and, while one runs, keeps only the newest waiting (the
 * older one resolves as `superseded`). Resolves once this push has been
 * ingested or dropped.
 */
export function handleCollectorPush(
  collectorId: number,
  params: unknown,
  options: { receivedAt?: DateTime } = {}
): Promise<CollectorPushOutcome> {
  const receivedAt = options.receivedAt ?? DateTime.utc()
  const snapshot = snapshotOf(params)
  if (!snapshot) {
    logger.warn({ collectorId }, 'collector_agent: push without summary and devices; dropped')
    return Promise.resolve({ status: 'dropped', reason: 'invalid' })
  }

  const state = stateFor(collectorId)
  if (state.running) {
    state.queued?.resolve({ status: 'dropped', reason: 'superseded' })
    return new Promise((resolve) => {
      state.queued = { snapshot, receivedAt, resolve }
    })
  }
  return runPush(collectorId, state, snapshot, receivedAt)
}

async function runPush(
  collectorId: number,
  state: PushState,
  snapshot: CollectorSnapshot,
  receivedAt: DateTime
): Promise<CollectorPushOutcome> {
  state.running = true
  try {
    return await ingestPush(collectorId, state, snapshot, receivedAt)
  } catch (error) {
    logger.error({ collectorId, err: error }, 'collector_agent: push ingestion threw')
    return { status: 'dropped', reason: 'invalid' }
  } finally {
    state.running = false
    const next = state.queued
    state.queued = null
    if (next) {
      void runPush(collectorId, state, next.snapshot, next.receivedAt).then(next.resolve)
    }
  }
}

async function ingestPush(
  collectorId: number,
  state: PushState,
  snapshot: CollectorSnapshot,
  receivedAt: DateTime
): Promise<CollectorPushOutcome> {
  const collector = await Collector.find(collectorId)
  if (!collector) {
    // Purged or merged away by the CLI, which cannot reach this process's hub.
    logger.debug({ collectorId }, 'collector_agent: push for a row that no longer exists')
    collectorHub.disconnect(collectorId, CLOSE_CODES.REVOKED, 'collector deleted')
    return { status: 'dropped', reason: 'missing' }
  }
  if (collector.lifecycle !== 'adopted') {
    logger.debug({ collectorId }, 'collector_agent: push from a collector not adopted yet')
    return { status: 'dropped', reason: 'not_adopted' }
  }
  if (!collector.enabled) {
    logger.debug({ collectorId }, 'collector_agent: push for a disabled collector ignored')
    return { status: 'dropped', reason: 'disabled' }
  }
  if (collector.transport !== 'agent') {
    logger.debug({ collectorId }, 'collector_agent: push for a polled collector ignored')
    return { status: 'dropped', reason: 'not_agent' }
  }

  const received = receivedAt.toMillis()
  const minGapMs = collector.pollIntervalSeconds * 1000 - EARLY_PUSH_SLACK_MS
  if (state.lastAcceptedAt !== null && received - state.lastAcceptedAt < minGapMs) {
    logger.debug(
      { collectorId, sinceLastMs: received - state.lastAcceptedAt, minGapMs },
      'collector_agent: push arrived too early; dropped'
    )
    return { status: 'dropped', reason: 'too_early' }
  }
  state.lastAcceptedAt = received

  const outcome = await ingestCollectorSnapshot(collector, snapshot, { now: receivedAt })
  if (outcome.status === 'failed') {
    logger.warn({ collectorId, error: outcome.error }, 'collector_agent: push ingestion failed')
  }
  return { status: 'ingested', outcome }
}

type StatusResult = {
  startedAt?: unknown
  totalDevices?: unknown
  captureInterface?: unknown
  version?: unknown
  uptimeSeconds?: unknown
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The socket's probe: `collector.status` on the live session, shaped like
 * `probeCollector`'s result so the registry can persist either. Never throws.
 */
export async function probeCollectorAgent(collector: Collector): Promise<CollectorStatus> {
  const checkedAt = new Date().toISOString()
  const started = performance.now()
  const latency = () => Math.round(performance.now() - started)
  try {
    const result = await collectorHub.request<StatusResult | null>(
      collector.id,
      'collector.status',
      {},
      { timeoutMs: COLLECTOR_STATUS_TIMEOUT_MS }
    )
    const status = isObject(result) ? result : {}
    return {
      ok: true,
      checkedAt,
      latencyMs: latency(),
      totalDevices: optionalCount(status.totalDevices),
      captureInterface: optionalString(status.captureInterface),
      version: optionalString(status.version),
    }
  } catch (error) {
    if (error instanceof AgentOfflineError) {
      return { ok: false, checkedAt, error: 'collector is not connected' }
    }
    if (error instanceof AgentTimeoutError) {
      return { ok: false, checkedAt, latencyMs: latency(), error: error.message }
    }
    if (error instanceof AgentRpcError) {
      return { ok: false, checkedAt, latencyMs: latency(), error: error.message }
    }
    return { ok: false, checkedAt, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Pulls the collector's protocol → category table over the socket (once per
 * adopted session; the table only changes with a collector build). Never throws.
 */
export async function syncCollectorProtocols(collectorId: number): Promise<number> {
  try {
    const result = await collectorHub.request<{ protocols?: ProtocolCategoryInput[] } | null>(
      collectorId,
      'collector.protocols',
      {},
      { timeoutMs: PROTOCOLS_TIMEOUT_MS }
    )
    const protocols = isObject(result) && Array.isArray(result.protocols) ? result.protocols : []
    const written = await upsertProtocolCategories(protocols)
    if (written > 0) {
      logger.info({ collectorId, written }, 'collector_agent: refreshed protocol categories')
    }
    return written
  } catch (error) {
    logger.debug(
      { collectorId, error: error instanceof Error ? error.message : String(error) },
      'collector_agent: protocol categories unavailable from collector'
    )
    return 0
  }
}

/**
 * The 5 s poll task's liveness check: a collector that is connected, adopted
 * and enabled but has not had a push accepted for max(3 × interval, 30 s) —
 * counted from its last accepted push, its connect, or the moment it was given
 * a schedule, whichever is latest — gets a failed `last_status`. Once per
 * episode: a new push or a new session starts the next one. Returns the ids
 * it reported.
 */
export async function checkCollectorPushFreshness(
  now: DateTime = DateTime.utc()
): Promise<number[]> {
  const online = collectorHub.onlineIds()
  if (online.length === 0) return []

  const rows = await Collector.query()
    .whereIn('id', online)
    .where('transport', 'agent')
    .where('lifecycle', 'adopted')
    .where('enabled', true)
  const reported: number[] = []

  for (const collector of rows) {
    const session = collectorHub.session(collector.id)
    if (!session) continue
    const state = stateFor(collector.id)
    const reference = Math.max(
      state.lastAcceptedAt ?? 0,
      session.connectedAt.toMillis(),
      state.scheduleSetAt ?? 0
    )
    const ageMs = now.toMillis() - reference
    const thresholdMs =
      Math.max(STALE_INTERVALS * collector.pollIntervalSeconds, STALE_MIN_SECONDS) * 1000
    if (ageMs < thresholdMs || state.staleReportedFor === reference) continue

    state.staleReportedFor = reference
    const gateway = collector.lastStatus?.gateway
    collector.lastStatus = {
      ok: false,
      checkedAt: now.toISO()!,
      error: `no data from the collector for ${Math.round(ageMs / 1000)}s`,
      ...(gateway ? { gateway } : {}),
    }
    await collector.save()
    reported.push(collector.id)
  }
  return reported
}
