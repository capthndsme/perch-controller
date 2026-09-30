import type AgentUpdateJob from '#models/agent_update_job'
import { endSuppression, suppressAlerts } from '#services/alerts/emit'
import type { DeviceKind } from '#services/agent_updates/state'
import { DateTime } from 'luxon'

/**
 * The maintenance window around an update (BUILD-PLAN agreement 4, alerts
 * events.md §4): from the moment the install can restart the agent until the
 * job ends, the device's "offline" alerts (and an AP's radio/BSS ones) are
 * recorded but notify nobody. A job's end closes the window early: alerts it
 * held that are still active notify then. The mute's `until` (the job's
 * deadline + 5 min) bounds it if the controller restarts mid-update; the map
 * holds one entry per open job, so it is bounded by the fleet.
 */

const GRACE_MINUTES = 5

const TYPES: Record<DeviceKind, string[]> = {
  ap: ['ap.offline', 'wifi.radio.down', 'wifi.bss.down'],
  collector: ['collector.offline'],
}

const windows = new Map<number, number>()

export async function openUpdateWindow(
  job: AgentUpdateJob,
  device: { kind: DeviceKind; id: number }
): Promise<void> {
  if (windows.has(Number(job.id))) return
  const until = (job.deadlineAt ?? DateTime.utc().plus({ minutes: 15 })).plus({
    minutes: GRACE_MINUTES,
  })
  const muteId = await suppressAlerts({
    subject: { kind: device.kind, id: device.id },
    types: TYPES[device.kind],
    until,
    source: `agent_update:${job.id}`,
    note: `Updating to ${job.toVersion}`,
  })
  if (muteId) windows.set(Number(job.id), muteId)
}

export async function closeUpdateWindow(jobId: number): Promise<void> {
  const muteId = windows.get(Number(jobId))
  if (!muteId) return
  windows.delete(Number(jobId))
  await endSuppression(muteId)
}

/** Tests only. */
export function _resetUpdateWindows(): void {
  windows.clear()
}
