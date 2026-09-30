import AlertWatch from '#models/alert_watch'
import { alertNow } from '#services/alerts/clock'
import { resolveSubjectLabel } from '#services/alerts/subjects'

/**
 * Watched devices (events.md §3.5), set from the device page: mode `offline`
 * raises `device.offline` for that MAC, mode `arrival` posts
 * `device.arrived`. The devices detector reads `watchedMacs`.
 */

export const WATCH_LIMIT = 200

export type WatchView = { mac: string; label: string | null; offline: boolean; arrival: boolean }

export class WatchLimitError extends Error {
  constructor() {
    super(`at most ${WATCH_LIMIT} devices can be watched`)
  }
}

async function viewFor(mac: string, modes: Set<string>): Promise<WatchView> {
  const { label } = await resolveSubjectLabel({ kind: 'device', mac })
  return {
    mac,
    label: label && label !== mac ? label : null,
    offline: modes.has('offline'),
    arrival: modes.has('arrival'),
  }
}

export async function listWatches(mac?: string): Promise<WatchView[]> {
  const query = AlertWatch.query().where('subject_kind', 'device').orderBy('subject_ref')
  if (mac) query.where('subject_ref', mac.toLowerCase())
  const rows = await query
  const byMac = new Map<string, Set<string>>()
  for (const row of rows) {
    const modes = byMac.get(row.subjectRef) ?? new Set<string>()
    modes.add(row.mode)
    byMac.set(row.subjectRef, modes)
  }
  const views: WatchView[] = []
  for (const [m, modes] of byMac) views.push(await viewFor(m, modes))
  return views
}

/** Sets both modes of one device; both false removes the watch. */
export async function setDeviceWatch(
  rawMac: string,
  wanted: { offline: boolean; arrival: boolean },
  userId: number | null
): Promise<WatchView> {
  const mac = rawMac.toLowerCase()
  const existing = await AlertWatch.query()
    .where('subject_kind', 'device')
    .where('subject_ref', mac)
  if ((wanted.offline || wanted.arrival) && existing.length === 0) {
    const watched = await AlertWatch.query()
      .where('subject_kind', 'device')
      .countDistinct('subject_ref as n')
      .first()
    if (Number(watched?.$extras.n ?? 0) >= WATCH_LIMIT) throw new WatchLimitError()
  }
  const now = alertNow()
  for (const mode of ['offline', 'arrival'] as const) {
    const row = existing.find((w) => w.mode === mode)
    if (wanted[mode] && !row) {
      await AlertWatch.create({
        subjectKind: 'device',
        subjectRef: mac,
        mode,
        params: null,
        createdByUserId: userId,
        createdAt: now,
      })
    } else if (!wanted[mode] && row) {
      await row.delete()
    }
  }
  const modes = new Set<string>()
  if (wanted.offline) modes.add('offline')
  if (wanted.arrival) modes.add('arrival')
  return viewFor(mac, modes)
}

/** MACs watched in one mode (lowercase), for the devices detector. */
export async function watchedMacs(mode: 'offline' | 'arrival'): Promise<string[]> {
  const rows = await AlertWatch.query()
    .where('subject_kind', 'device')
    .where('mode', mode)
    .select('subject_ref')
  return rows.map((r) => r.subjectRef)
}
