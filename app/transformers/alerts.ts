import type Alert from '#models/alert'
import type AlertEvent from '#models/alert_event'
import type AlertMute from '#models/alert_mute'
import User from '#models/user'
import { isoOrNull } from '#services/alerts/clock'
import type {
  AlertKind,
  AlertState,
  AlertTypeDef,
  Category,
  EventPhase,
  ParamDef,
  Rule,
  Severity,
  SubjectKind,
  TypeOwner,
} from '#services/alerts/model'
import { catalogueRule } from '#services/alerts/settings'
import type { DateTime } from 'luxon'

/**
 * Wire shapes of the alerts inbox (docs/design/alerts/api.md §2): `AlertView`,
 * `AlertEventView`, `MuteView`, `AlertTypeView`. Times are ISO-8601 UTC.
 * No `generatedAt`-style fields: they would defeat the ETag.
 */

export type UserRef = { id: number; name: string }

export type AlertView = {
  id: number
  type: string
  category: Category
  kind: AlertKind
  state: AlertState
  severity: Severity
  flapping: boolean
  title: string
  body: string
  path: string | null
  subject: { kind: SubjectKind; ref: string; label: string | null }
  firstRaisedAt: string
  openedAt: string | null
  lastEventAt: string
  resolvedAt: string | null
  /** When it last became news (opened, posted, escalated, reopened, flapping): the unread reference and the inbox order. */
  bumpedAt: string
  quietResolve: boolean
  eventCount: number
  transitions: number
  notified: boolean
  muted: boolean
  unread: boolean
  acknowledged: { at: string; by: UserRef | null; note: string | null } | null
  resolvedBy: UserRef | null
}

/** Users referenced by alerts and mutes, as `{ id, name }` (fullName ?? email). */
export async function loadUserRefs(
  ids: Array<number | null | undefined>
): Promise<Map<number, UserRef>> {
  const wanted = [...new Set(ids.filter((id): id is number => typeof id === 'number'))]
  const map = new Map<number, UserRef>()
  if (wanted.length === 0) return map
  const users = await User.query().whereIn('id', wanted).select('id', 'full_name', 'email')
  for (const u of users) map.set(u.id, { id: u.id, name: u.fullName || u.email })
  return map
}

/** Shown in the inbox by default: not pending, not a quiet resolve (blip). */
export function isVisible(alert: Pick<Alert, 'state' | 'quietResolve'>): boolean {
  if (alert.state === 'pending') return false
  if (alert.state === 'resolved' && alert.quietResolve) return false
  return true
}

export function isUnread(alert: Alert, readAt: DateTime | null): boolean {
  if (!isVisible(alert)) return false
  return readAt === null || alert.bumpedAt > readAt
}

export function alertView(
  alert: Alert,
  context: { readAt: DateTime | null; users: Map<number, UserRef> }
): AlertView {
  const userRef = (id: number | null) => (id === null ? null : (context.users.get(id) ?? null))
  return {
    id: Number(alert.id),
    type: alert.type,
    category: alert.category as Category,
    kind: alert.kind,
    state: alert.state,
    severity: alert.severity,
    flapping: alert.flapping,
    title: alert.title,
    body: alert.body,
    path: alert.path,
    subject: {
      kind: alert.subjectKind as SubjectKind,
      ref: alert.subjectRef,
      label: alert.subjectLabel,
    },
    firstRaisedAt: isoOrNull(alert.firstRaisedAt)!,
    openedAt: isoOrNull(alert.openedAt),
    lastEventAt: isoOrNull(alert.lastEventAt)!,
    resolvedAt: isoOrNull(alert.resolvedAt),
    bumpedAt: isoOrNull(alert.bumpedAt)!,
    quietResolve: alert.quietResolve,
    eventCount: alert.eventCount,
    transitions: alert.transitions,
    notified: alert.notified,
    muted: alert.muted,
    unread: isUnread(alert, context.readAt),
    acknowledged: alert.acknowledgedAt
      ? {
          at: isoOrNull(alert.acknowledgedAt)!,
          by: userRef(alert.acknowledgedByUserId),
          note: alert.ackNote,
        }
      : null,
    resolvedBy: userRef(alert.resolvedByUserId),
  }
}

export type AlertEventView = {
  id: number
  phase: EventPhase
  severity: Severity
  outcome: string
  occurredAt: string
  source: string | null
  data: Record<string, unknown> | null
}

export function alertEventView(event: AlertEvent): AlertEventView {
  return {
    id: Number(event.id),
    phase: event.phase,
    severity: event.severity,
    outcome: event.outcome,
    occurredAt: isoOrNull(event.occurredAt)!,
    source: event.source,
    data: event.payload,
  }
}

export type MuteView = {
  id: number
  type: string | null
  subject: { kind: SubjectKind; ref: string; label: string | null } | null
  until: string | null
  reason: 'manual' | 'maintenance'
  source: string | null
  note: string | null
  createdBy: UserRef | null
  createdAt: string
}

export function muteView(
  mute: AlertMute,
  context: { users: Map<number, UserRef>; labels?: Map<string, string | null> }
): MuteView {
  const key = mute.subjectKind ? `${mute.subjectKind}:${mute.subjectRef ?? ''}` : null
  return {
    id: mute.id,
    type: mute.type,
    subject: mute.subjectKind
      ? {
          kind: mute.subjectKind as SubjectKind,
          ref: mute.subjectRef ?? '',
          label: (key && context.labels?.get(key)) ?? null,
        }
      : null,
    until: isoOrNull(mute.until),
    reason: mute.reason,
    source: mute.source,
    note: mute.note,
    createdBy:
      mute.createdByUserId !== null ? (context.users.get(mute.createdByUserId) ?? null) : null,
    createdAt: isoOrNull(mute.createdAt)!,
  }
}

export type AlertTypeView = {
  type: string
  category: Category
  kind: AlertKind
  severity: Severity
  label: string
  description: string
  owner: TypeOwner
  subjects: SubjectKind[]
  params: ParamDef[]
  defaults: Rule
  available: boolean
  unavailableReason: string | null
}

export function alertTypeView(def: AlertTypeDef, unavailableReason: string | null): AlertTypeView {
  return {
    type: def.type,
    category: def.category,
    kind: def.kind,
    severity: def.severity,
    label: def.label,
    description: def.description,
    owner: def.owner,
    subjects: [...def.subjects],
    params: (def.params ?? []).map((p) => ({ ...p })),
    defaults: catalogueRule(def),
    available: unavailableReason === null,
    unavailableReason,
  }
}

/** Every catalogue type as `AlertTypeView`, with its availability checked now. */
export async function catalogueTypeViews(defs: AlertTypeDef[]): Promise<AlertTypeView[]> {
  const views: AlertTypeView[] = []
  for (const def of defs) {
    let reason: string | null = null
    if (def.available) {
      try {
        reason = await def.available()
      } catch {
        reason = null
      }
    }
    views.push(alertTypeView(def, reason))
  }
  return views
}
