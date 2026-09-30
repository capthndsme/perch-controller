import AlertMute from '#models/alert_mute'
import { alertNow, sqlTime } from '#services/alerts/clock'
import type { AlertSubject } from '#services/alerts/model'
import { subjectRef } from '#services/alerts/subjects'
import type { DateTime } from 'luxon'

/**
 * Mutes and maintenance windows (README §2.3 item 9): a mute matches an
 * alert by type and/or subject until a time (or until removed). At notify
 * time a matching mute marks the alert `muted` and creates no deliveries; the
 * engine still records everything.
 */

export type MuteInput = {
  type?: string | null
  subject?: AlertSubject | null
  until?: DateTime | null
  reason?: 'manual' | 'maintenance'
  source?: string | null
  note?: string | null
  createdByUserId?: number | null
}

export async function createMute(input: MuteInput): Promise<AlertMute> {
  if (!input.type && !input.subject) throw new Error('a mute needs a type or a subject')
  return AlertMute.create({
    type: input.type ?? null,
    subjectKind: input.subject?.kind ?? null,
    subjectRef: input.subject ? subjectRef(input.subject) : null,
    until: input.until ? input.until.toUTC() : null,
    reason: input.reason ?? 'manual',
    source: input.source ? input.source.slice(0, 48) : null,
    note: input.note ? input.note.slice(0, 200) : null,
    createdByUserId: input.createdByUserId ?? null,
    createdAt: alertNow(),
  })
}

export async function deleteMute(id: number): Promise<boolean> {
  const mute = await AlertMute.find(id)
  if (!mute) return false
  await mute.delete()
  return true
}

/** Mutes in force: `until` NULL or in the future. */
export async function listActiveMutes(now: DateTime = alertNow()): Promise<AlertMute[]> {
  return AlertMute.query()
    .where((q) => q.whereNull('until').orWhere('until', '>', sqlTime(now)))
    .orderBy('id', 'desc')
}

/** The mute in force for an alert, if any (a maintenance window wins over a manual mute). */
export async function findMatchingMute(
  alert: { type: string; subjectKind: string; subjectRef: string },
  now: DateTime = alertNow()
): Promise<AlertMute | null> {
  const rows = await AlertMute.query()
    .where((q) => q.whereNull('until').orWhere('until', '>', sqlTime(now)))
    .where((q) => q.whereNull('type').orWhere('type', alert.type))
    .where((q) =>
      q
        .whereNull('subject_kind')
        .orWhere((s) =>
          s.where('subject_kind', alert.subjectKind).where('subject_ref', alert.subjectRef)
        )
    )
    .where((q) => q.whereNotNull('type').orWhereNotNull('subject_kind'))
    .orderBy('id', 'asc')
  if (rows.length === 0) return null
  return rows.find((m) => m.reason === 'maintenance') ?? rows[0]
}
