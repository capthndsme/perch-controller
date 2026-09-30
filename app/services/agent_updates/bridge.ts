import AgentUpdateJob from '#models/agent_update_job'
import type { AgentHub, AgentSession } from '#services/agent_hub'
import { ensureDeviceRow, loadDevice, mergeFacts } from '#services/agent_updates/devices'
import { recordUpdateEvent } from '#services/agent_updates/events'
import { checkConfirm, resyncFromReport, settleResult } from '#services/agent_updates/jobs'
import {
  UPDATE_ID_REGEX,
  sanitizeResult,
  sanitizeUpdateReport,
  type UpdateReport,
} from '#services/agent_updates/report'
import { hubFor, sessionState } from '#services/agent_updates/sessions'
import { getAgentUpdateSettings } from '#services/agent_updates/settings'
import { deviceUpdateInFlight, type DeviceKind } from '#services/agent_updates/state'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The agent sockets' side of agent updates (controller.md section 4): the
 * gateways call these at the moments that matter, and they never throw into
 * the gateway (errors are logged).
 *
 * - `recordUpdateReport`: after `system.info` (perch-apd) or the hello
 *   (perch-collector), and after `agent.update.status`: stores the `update`
 *   block, settles and acks its `results`, resyncs the open job with its
 *   `active` entry and notices manual version changes.
 * - `noteAgentPush`: after every accepted push, counts it on the session and
 *   runs the confirm check when the device has an update in flight.
 * - `attachAgentUpdates`: `agent.update.progress` and `agent.update.result`.
 */

const ACK_TIMEOUT_MS = 10_000
/** A job progress row is written at most this often (controller.md 4.3). */
const PROGRESS_WRITE_MS = 5_000
const progressWrittenAt = new Map<string, number>()
const MAX_PROGRESS_ENTRIES = 1000

type ReportContext = {
  /** The version the reporting process runs (AP: `agentVersion`; collector: hello `version`). */
  version: string | null
  /** The session the block came from, when known. */
  session?: AgentSession | null
  /** Host facts from the hello (collector `system`). */
  facts?: { arch?: string | null; os?: string | null }
}

async function ack(kind: DeviceKind, id: number, updateIds: string[]): Promise<void> {
  if (updateIds.length === 0) return
  try {
    await hubFor(kind).request(id, 'agent.update.ack', { updateIds }, { timeoutMs: ACK_TIMEOUT_MS })
  } catch (error) {
    // Not acked: the device sends them again on its next session.
    logger.debug({ kind, id, err: error }, 'agent_updates: ack not delivered')
  }
}

/** Was a version change explained by one of our jobs (open, or finished lately)? */
async function explainedByJob(kind: DeviceKind, id: number, version: string): Promise<boolean> {
  const recent = DateTime.utc().minus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm:ss')
  const job = await AgentUpdateJob.query()
    .where(kind === 'ap' ? 'ap_id' : 'collector_id', id)
    .where((query) => {
      query.whereNotNull('active_key').orWhere('finished_at', '>=', recent)
    })
    .where((query) => {
      query.where('to_version', version).orWhere('from_version', version)
    })
    .first()
  return job !== null
}

/**
 * Stores a device's `update` block (null for agents that send none) and acts
 * on it. Returns the sanitised report.
 */
export async function recordUpdateReport(
  kind: DeviceKind,
  id: number,
  block: unknown,
  context: ReportContext
): Promise<UpdateReport | null> {
  try {
    const report = sanitizeUpdateReport(block)
    if (context.session) {
      const state = sessionState(context.session)
      state.version = context.version
      state.report = report
    }
    const row = await ensureDeviceRow(kind, id)
    const now = DateTime.utc()
    row.report = report
    row.reportedAt = report ? now : row.reportedAt
    if (context.facts) row.facts = mergeFacts(row.facts, context.facts)

    const version = context.version
    const previous = row.versionSeen
    if (version && previous && version !== previous && !(await explainedByJob(kind, id, version))) {
      const device = await loadDevice(kind, id)
      await recordUpdateEvent('agent_update.version_changed', {
        device: device ? { kind, id, name: device.name } : null,
        systemActor: 'agent',
        detail: { fromVersion: previous, toVersion: version },
      })
    }
    if (version) row.versionSeen = version
    row.updatedAt = now
    await row.save()

    if (!report) return null
    const settled: string[] = []
    for (const result of report.results) {
      await settleResult(kind, id, result)
      settled.push(result.updateId)
    }
    const settings = await getAgentUpdateSettings()
    await resyncFromReport(kind, id, report, version, settings)
    await ack(kind, id, settled)
    return report
  } catch (error) {
    logger.error({ kind, id, err: error }, 'agent_updates: could not record an update report')
    return null
  }
}

/**
 * The version a session's process runs, for agents whose version arrives
 * apart from the block.
 */
export function noteSessionVersion(session: AgentSession, version: string | null): void {
  sessionState(session).version = version
}

/**
 * After every accepted push. Cheap when nothing is updating (one Set lookup);
 * otherwise counts the push on the live session and runs the confirm check.
 */
export async function noteAgentPush(kind: DeviceKind, id: number): Promise<void> {
  const session = hubFor(kind).liveSession(id)
  if (!session) return
  sessionState(session).pushes += 1
  if (!deviceUpdateInFlight(kind, id)) return
  try {
    await checkConfirm(kind, id, await getAgentUpdateSettings())
  } catch (error) {
    logger.error({ kind, id, err: error }, 'agent_updates: confirm check failed')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function onProgress(kind: DeviceKind, id: number, params: unknown): Promise<void> {
  if (!isObject(params) || typeof params.updateId !== 'string') return
  if (!UPDATE_ID_REGEX.test(params.updateId)) return
  const bytes = typeof params.bytes === 'number' && params.bytes >= 0 ? params.bytes : null
  const total =
    typeof params.totalBytes === 'number' && params.totalBytes >= 0 ? params.totalBytes : null
  if (bytes === null || total === null) return
  const now = Date.now()
  const last = progressWrittenAt.get(params.updateId) ?? 0
  if (now - last < PROGRESS_WRITE_MS && bytes < total) return
  if (progressWrittenAt.size >= MAX_PROGRESS_ENTRIES) progressWrittenAt.clear()
  progressWrittenAt.set(params.updateId, now)
  const job = await AgentUpdateJob.query()
    .where('update_key', params.updateId)
    .where(kind === 'ap' ? 'ap_id' : 'collector_id', id)
    .whereIn('state', ['staging', 'staged'])
    .first()
  if (!job) return
  job.progressBytes = Math.trunc(bytes)
  job.progressTotal = Math.trunc(total)
  job.updatedAt = DateTime.utc()
  await job.save()
}

async function onResult(kind: DeviceKind, id: number, params: unknown): Promise<void> {
  const result = sanitizeResult(params)
  if (!result) return
  await settleResult(kind, id, result)
  await ack(kind, id, [result.updateId])
}

/** Registers the agent → server notifications on a hub (`attach()` of each gateway). */
export function attachAgentUpdates(hub: AgentHub, kind: DeviceKind): void {
  hub.onNotification('agent.update.progress', (id, params) => onProgress(kind, id, params))
  hub.onNotification('agent.update.result', (id, params) => onResult(kind, id, params))
}
