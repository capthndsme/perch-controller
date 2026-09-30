import { emitAlertEvent } from '#services/alerts/emit'
import AgentUpdateEvent from '#models/agent_update_event'
import type { DeviceKind } from '#services/agent_updates/state'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The agent-updates audit trail (`agent_update_events`, controller.md
 * section 2.7) and the events for alerts (README section 16).
 *
 * Every write names who did it: a user (`userId`) or Perch itself
 * (`systemActor`: `rollout`, `auto_update`, `github_check`, `agent`, `tick`).
 * The alerts area's `emitAlertEvent` is wired in wave 2 (BUILD-PLAN agreement
 * 5) at `forwardToAlerts`; until then this table is the record and alerts can
 * backfill from it.
 */

/** README section 16: the events alerts can route, with their severity. */
export const ALERT_EVENTS = {
  'agent_update.available': 'info',
  'agent_update.started': 'info',
  'agent_update.confirmed': 'info',
  'agent_update.failed': 'warning',
  'agent_update.rolled_back': 'warning',
  'agent_update.unknown': 'warning',
  'agent_update.rollback_failed': 'critical',
  'agent_update.rollback_unavailable': 'critical',
  'agent_update.rollout_paused': 'warning',
  'agent_update.rollout_completed': 'info',
  'agent_update.release_rejected': 'critical',
  'agent_update.version_changed': 'info',
} as const

/** Audit-only events (controller.md section 2.7). */
export const AUDIT_EVENTS = [
  'settings_changed',
  'device_settings_changed',
  'release_imported',
  'release_withdrawn',
  'release_restored',
  'release_deleted',
  'preflight',
  'job_created',
  'job_aborted',
  'rollout_created',
  'rollout_resumed',
  'rollout_cancelled',
] as const

export type AlertEventName = keyof typeof ALERT_EVENTS
export type AuditEventName = (typeof AUDIT_EVENTS)[number]
export type UpdateEventName = AlertEventName | AuditEventName

export type EventDevice = { kind: DeviceKind; id: number; name: string }

export type RecordEventOptions = {
  device?: EventDevice | null
  jobId?: number | null
  rolloutId?: number | null
  releaseId?: number | null
  userId?: number | null
  systemActor?: string | null
  detail?: Record<string, unknown> | null
  severity?: 'info' | 'warning' | 'critical'
}

function severityOf(event: UpdateEventName): 'info' | 'warning' | 'critical' {
  return (ALERT_EVENTS as Record<string, 'info' | 'warning' | 'critical'>)[event] ?? 'info'
}

/**
 * Writes one audit row (and, for README section 16 names, hands it to the
 * alerts area). Never throws: an audit failure is logged, the action stands.
 */
export async function recordUpdateEvent(
  event: UpdateEventName,
  options: RecordEventOptions = {}
): Promise<AgentUpdateEvent | null> {
  try {
    const row = new AgentUpdateEvent()
    row.createdAt = DateTime.utc()
    row.event = event
    row.severity = options.severity ?? severityOf(event)
    row.apId = options.device?.kind === 'ap' ? options.device.id : null
    row.collectorId = options.device?.kind === 'collector' ? options.device.id : null
    row.deviceName = options.device?.name.slice(0, 120) ?? null
    row.jobId = options.jobId ?? null
    row.rolloutId = options.rolloutId ?? null
    row.releaseId = options.releaseId ?? null
    row.userId = options.userId ?? null
    row.systemActor = options.userId ? null : (options.systemActor ?? null)
    row.detail = options.detail ?? null
    await row.save()
    if (event in ALERT_EVENTS) forwardToAlerts(row)
    return row
  } catch (error) {
    logger.error({ err: error, event }, 'agent_updates: could not record an event')
    return null
  }
}

/** Events about one device (the others are the fleet's: the controller is their subject). */
const DEVICE_EVENTS = new Set<string>([
  'agent_update.started',
  'agent_update.confirmed',
  'agent_update.failed',
  'agent_update.rolled_back',
  'agent_update.unknown',
  'agent_update.rollback_failed',
  'agent_update.rollback_unavailable',
  'agent_update.version_changed',
])

/**
 * Hands a README section 16 event to the alerts area (catalogue
 * `app/services/alerts/catalogue/agent_updates.ts`, same names). Dedupe key
 * per job (else per rollout, release or event row); the payload is the row's
 * detail with the device and ids. Never throws.
 */
function forwardToAlerts(row: AgentUpdateEvent): void {
  const kind = row.apId !== null ? 'ap' : row.collectorId !== null ? 'collector' : null
  const id = row.apId ?? row.collectorId
  const onDevice = kind !== null && id !== null && DEVICE_EVENTS.has(row.event)
  const scope = row.jobId ?? row.rolloutId ?? row.releaseId ?? row.id
  emitAlertEvent({
    type: row.event,
    subject: onDevice ? { kind: kind!, id: Number(id) } : { kind: 'controller' },
    severity: row.severity as 'info' | 'warning' | 'critical',
    dedupeKey: `${row.event}:${scope}`,
    payload: {
      ...(row.detail ?? {}),
      ...(kind !== null && id !== null
        ? { device: { kind, id: Number(id), name: row.deviceName } }
        : {}),
      ...(row.jobId !== null ? { jobId: Number(row.jobId) } : {}),
      ...(row.rolloutId !== null ? { rolloutId: Number(row.rolloutId) } : {}),
    },
    source: 'agent_updates',
  })
}
