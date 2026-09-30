import db from '@adonisjs/lucid/services/db'

/**
 * Which devices are in the middle of an update, answered synchronously for
 * the other areas (BUILD-PLAN agreement 4): the Wi-Fi tick and the gateway
 * apply queue hold their sends to a device while
 * `deviceUpdateInFlight(kind, id)` is true.
 *
 * "In flight" = a job past its download and not final: `staged` (the install
 * goes out on the next tick), `installing`, `probation`, `unknown`. A job
 * still downloading does not hold anything (the device keeps working; its
 * busy hooks refuse the install while an apply waits for its confirm).
 *
 * In-process like the scheduler (single API instance): the job code marks
 * each transition, and every tick rebuilds the set from the database, so a
 * restart is at most one tick (5 s) behind. One entry per device with an
 * open job, so the set is bounded by the fleet.
 */

export type DeviceKind = 'ap' | 'collector'

export const IN_FLIGHT_STATES = ['staged', 'installing', 'probation', 'unknown'] as const

const inFlight = new Set<string>()

/** `ap:4`, `collector:1`: the REST API's device key and `active_key` of open jobs. */
export function deviceKey(kind: DeviceKind, id: number): string {
  return `${kind}:${id}`
}

export function parseDeviceKey(value: unknown): { kind: DeviceKind; id: number } | null {
  if (typeof value !== 'string') return null
  const match = /^(ap|collector):([1-9]\d{0,9})$/.exec(value)
  if (!match) return null
  return { kind: match[1] as DeviceKind, id: Number(match[2]) }
}

/** True while the device's update may stop or restart its agent. */
export function deviceUpdateInFlight(kind: DeviceKind, id: number): boolean {
  return inFlight.has(deviceKey(kind, id))
}

/** The design's name for the same check (controller.md section 1, `busy.ts`). */
export const isAgentUpdating = deviceUpdateInFlight

/** Called by the job code on every state change. */
export function markDeviceInFlight(kind: DeviceKind, id: number, value: boolean): void {
  if (value) inFlight.add(deviceKey(kind, id))
  else inFlight.delete(deviceKey(kind, id))
}

/** Rebuilds the set from the open jobs (every tick). */
export async function refreshInFlight(): Promise<void> {
  const rows = (await db
    .from('agent_update_jobs')
    .whereIn('state', [...IN_FLIGHT_STATES])
    .select('ap_id', 'collector_id')) as Array<{
    ap_id: number | null
    collector_id: number | null
  }>
  inFlight.clear()
  for (const row of rows) {
    if (row.ap_id !== null) inFlight.add(deviceKey('ap', Number(row.ap_id)))
    if (row.collector_id !== null) inFlight.add(deviceKey('collector', Number(row.collector_id)))
  }
}

/** Test-only. */
export function _resetInFlight(): void {
  inFlight.clear()
}
