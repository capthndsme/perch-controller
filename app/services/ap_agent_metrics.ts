import WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import { ingestWifiMetrics, type WifiPollOutcome } from '#services/wifi_metrics_poller'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * ap-controller metrics are PUSHED (docs/ap-controller.md section 3.1).
 *
 * On every session the server tells the agent its schedule with the
 * `agent.configure` notification; the agent then sends `metrics.push`
 * notifications carrying the same Prometheus text the HTTP poller fetches
 * from node_exporter. Each accepted push goes through `ingestWifiMetrics`,
 * so parsing, deltas, snapshots, latest tables, roaming and `last_status`
 * are exactly the scrape path's. Rows are bucketed by server receive time;
 * the agent's clock is ignored.
 */

/** The families the server parses; the agent skips every other collector. */
export const AGENT_METRIC_COLLECTORS = [
  'openwrt',
  'uname',
  'stat',
  'loadavg',
  'meminfo',
  'conntrack',
  'netdev',
  'wifi',
  'wifi_stations',
] as const

/** Same slack the poll task gives a due row. */
const EARLY_PUSH_SLACK_MS = 1500
/** A push carries one exposition; anything bigger is not one. */
export const MAX_PUSH_TEXT_BYTES = 4 * 1024 * 1024
/** Stale after max(3 intervals, 30 s) without an accepted push. */
const STALE_INTERVALS = 3
const STALE_MIN_SECONDS = 30

type PushState = {
  /** Server receive time (ms) of the last accepted push. */
  lastAcceptedAt: number | null
  /** Pushes of one AP are ingested one after the other. */
  chain: Promise<unknown>
  /** Reference time of the stale episode already reported, if any. */
  staleReportedFor: number | null
}

const states = new Map<number, PushState>()

function stateFor(apId: number): PushState {
  let state = states.get(apId)
  if (!state) {
    state = { lastAcceptedAt: null, chain: Promise.resolve(), staleReportedFor: null }
    states.set(apId, state)
  }
  return state
}

/** Test-only: forget every AP's push state. */
export function _resetAgentMetricsState(): void {
  states.clear()
}

export type AgentConfigureParams = {
  metricsIntervalSeconds: number
  collectors: string[]
}

/** `metricsIntervalSeconds: 0` pauses pushing (the AP is disabled). */
export function agentConfigureParams(ap: WifiAccessPoint): AgentConfigureParams {
  return {
    metricsIntervalSeconds: ap.enabled ? ap.pollIntervalSeconds : 0,
    collectors: [...AGENT_METRIC_COLLECTORS],
  }
}

/** Sends `agent.configure` when the AP's agent is online. */
export function sendAgentConfigure(ap: WifiAccessPoint): boolean {
  return hub.notify(ap.id, 'agent.configure', agentConfigureParams(ap))
}

export type PushOutcome =
  | { status: 'ingested'; outcome: WifiPollOutcome }
  | { status: 'dropped'; reason: 'too_early' | 'disabled' | 'not_agent' | 'invalid' }

type PushParams = {
  format?: unknown
  text?: unknown
  durationMs?: unknown
}

/**
 * One `metrics.push` from the AP's agent. Validated right away; ingestion is
 * chained per AP so two pushes of one AP never run concurrently. Resolves
 * once this push has been ingested or dropped.
 */
export function handleMetricsPush(
  apId: number,
  params: unknown,
  options: { receivedAt?: DateTime } = {}
): Promise<PushOutcome> {
  const receivedAt = options.receivedAt ?? DateTime.utc()
  const push = (params ?? {}) as PushParams

  if (push.format !== 'prometheus-text') {
    logger.warn({ apId, format: push.format }, 'ap_agent_metrics: push with an unknown format')
    return Promise.resolve({ status: 'dropped', reason: 'invalid' })
  }
  if (typeof push.text !== 'string') {
    logger.warn({ apId }, 'ap_agent_metrics: push without text')
    return Promise.resolve({ status: 'dropped', reason: 'invalid' })
  }
  if (Buffer.byteLength(push.text, 'utf8') > MAX_PUSH_TEXT_BYTES) {
    logger.warn({ apId }, 'ap_agent_metrics: push text over 4 MiB')
    return Promise.resolve({ status: 'dropped', reason: 'invalid' })
  }

  const text = push.text
  const latencyMs =
    typeof push.durationMs === 'number' && Number.isFinite(push.durationMs)
      ? Math.max(0, Math.round(push.durationMs))
      : undefined

  const state = stateFor(apId)
  const run = state.chain.then(() => ingestPush(apId, state, text, latencyMs, receivedAt))
  state.chain = run.catch(() => {})
  return run
}

async function ingestPush(
  apId: number,
  state: PushState,
  text: string,
  latencyMs: number | undefined,
  receivedAt: DateTime
): Promise<PushOutcome> {
  const ap = await WifiAccessPoint.find(apId)
  if (!ap || ap.transport !== 'agent') {
    logger.debug({ apId }, 'ap_agent_metrics: push for a row that is not an agent row')
    return { status: 'dropped', reason: 'not_agent' }
  }
  if (!ap.enabled) {
    logger.debug({ apId }, 'ap_agent_metrics: push for a disabled AP ignored')
    return { status: 'dropped', reason: 'disabled' }
  }

  const received = receivedAt.toMillis()
  const minGapMs = ap.pollIntervalSeconds * 1000 - EARLY_PUSH_SLACK_MS
  if (state.lastAcceptedAt !== null && received - state.lastAcceptedAt < minGapMs) {
    logger.debug(
      { apId, sinceLastMs: received - state.lastAcceptedAt, minGapMs },
      'ap_agent_metrics: push arrived too early; dropped'
    )
    return { status: 'dropped', reason: 'too_early' }
  }
  state.lastAcceptedAt = received

  const outcome = await ingestWifiMetrics(ap, text, { now: receivedAt, latencyMs })
  if (outcome.status === 'failed') {
    logger.warn({ apId, error: outcome.error }, 'ap_agent_metrics: push ingestion failed')
  }
  return { status: 'ingested', outcome }
}

/**
 * The 5 s task's liveness check: an agent that is connected and enabled but
 * has not had a push accepted for max(3 × interval, 30 s) — counted from
 * its last accepted push, or from the connect if it never pushed — gets a
 * failed `last_status`. Once per episode: a new push or a new session starts
 * the next one. Returns the ids it reported.
 */
export async function checkAgentPushFreshness(now: DateTime = DateTime.utc()): Promise<number[]> {
  const online = hub.onlineIds()
  if (online.length === 0) return []

  const rows = await WifiAccessPoint.query()
    .whereIn('id', online)
    .where('transport', 'agent')
    .where('enabled', true)
  const reported: number[] = []

  for (const ap of rows) {
    const session = hub.session(ap.id)
    if (!session) continue
    const state = stateFor(ap.id)
    const connectedAt = session.connectedAt.toMillis()
    const reference = Math.max(state.lastAcceptedAt ?? 0, connectedAt)
    const ageMs = now.toMillis() - reference
    const thresholdMs = Math.max(STALE_INTERVALS * ap.pollIntervalSeconds, STALE_MIN_SECONDS) * 1000
    if (ageMs < thresholdMs || state.staleReportedFor === reference) continue

    state.staleReportedFor = reference
    ap.lastStatus = {
      ok: false,
      checkedAt: now.toISO()!,
      error: `no metrics from the agent for ${Math.round(ageMs / 1000)}s`,
    }
    await ap.save()
    reported.push(ap.id)
  }
  return reported
}
