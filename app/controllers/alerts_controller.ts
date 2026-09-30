import Alert from '#models/alert'
import AlertDelivery from '#models/alert_delivery'
import AlertEvent from '#models/alert_event'
import AlertUserState from '#models/alert_user_state'
import { getAlertType, listAlertTypes } from '#services/alerts/catalogue/index'
import { alertNow, sqlTime } from '#services/alerts/clock'
import { acknowledgeAlert, AlertActionError, resolveAlertManually } from '#services/alerts/engine'
import { CATEGORIES, CATEGORY_LABELS, SEVERITIES, type Severity } from '#services/alerts/model'
import { findMatchingMute } from '#services/alerts/mutes'
import { effectiveRule, getAlertsSettings } from '#services/alerts/settings'
import {
  parseSubjectKey,
  resolveSubjectLabel,
  subjectFromRef,
  subjectRef,
} from '#services/alerts/subjects'
import { deliveryView, loadDestinations } from '#transformers/alert_deliveries'
import {
  alertEventView,
  alertTypeView,
  alertView,
  loadUserRefs,
  muteView,
} from '#transformers/alerts'
import { alertListValidator, alertNoteValidator, alertReadValidator } from '#validators/alerts'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The alerts inbox (docs/design/alerts/api.md §3.1): list, bell summary,
 * catalogue, detail, read marker; acknowledge and resolve for admins.
 */

function unprocessable(
  response: HttpContext['response'],
  field: string,
  rule: string,
  message: string
) {
  return response.unprocessableEntity({ errors: [{ field, rule, message }] })
}

function notFound(response: HttpContext['response'], id: unknown) {
  return response.notFound({ error: 'alert_not_found', message: `Alert ${id} does not exist.` })
}

async function readAtFor(userId: number): Promise<DateTime | null> {
  const state = await AlertUserState.find(userId)
  return state?.readAt ?? null
}

function severitiesFrom(min: Severity): Severity[] {
  return SEVERITIES.slice(SEVERITIES.indexOf(min)) as Severity[]
}

/** Visible in the inbox by default: not pending, not a quiet resolve. */
function whereVisible(query: ReturnType<typeof Alert.query>) {
  query.where((q) =>
    q
      .whereIn('state', ['active', 'posted'])
      .orWhere((r) => r.where('state', 'resolved').where('quiet_resolve', false))
  )
}

async function unreadCount(readAt: DateTime | null): Promise<number> {
  const query = Alert.query()
  whereVisible(query)
  if (readAt) query.where('bumped_at', '>', sqlTime(readAt))
  const row = await query.count('* as n').first()
  return Number(row?.$extras.n ?? 0)
}

function cursorOf(alert: Alert): string {
  return `${alert.bumpedAt.toMillis()}:${alert.id}`
}

export default class AlertsController {
  /**
   * GET /api/v1/alerts
   */
  async index({ request, response, auth, serialize }: HttpContext) {
    const q = await request.validateUsing(alertListValidator, { data: request.qs() })
    const limit = q.limit ?? 50
    const blips = q.blips === '1' || q.blips === 'true'
    const query = Alert.query()

    if (q.view === 'active') {
      query.whereIn('state', blips ? ['active', 'pending'] : ['active'])
    } else if (!blips) {
      whereVisible(query)
    }
    if (q.minSeverity && q.minSeverity !== 'info') {
      query.whereIn('severity', severitiesFrom(q.minSeverity))
    }
    if (q.category) {
      const categories = q.category
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
      const bad = categories.find((c) => !(CATEGORIES as readonly string[]).includes(c))
      if (bad) return unprocessable(response, 'category', 'enum', `Unknown category "${bad}".`)
      if (categories.length > 0) query.whereIn('category', categories)
    }
    if (q.type) {
      const types = q.type
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      if (types.length > 20)
        return unprocessable(response, 'type', 'maxLength', 'At most 20 types.')
      if (types.length > 0) query.whereIn('type', types)
    }
    if (q.subject) {
      const subject = parseSubjectKey(q.subject)
      if (!subject) {
        return unprocessable(response, 'subject', 'subject', 'Expected <kind>:<ref>, e.g. ap:4.')
      }
      query.where('subject_kind', subject.kind).where('subject_ref', subjectRef(subject))
    }
    if (q.before) {
      const match = /^(\d{1,15}):(\d{1,20})$/.exec(q.before)
      if (!match) return unprocessable(response, 'before', 'cursor', 'Malformed cursor.')
      const at = sqlTime(DateTime.fromMillis(Number(match[1]), { zone: 'utc' }))
      const id = Number(match[2])
      query.where((c) =>
        c.where('bumped_at', '<', at).orWhere((e) => e.where('bumped_at', at).where('id', '<', id))
      )
    }
    const rows = await query
      .orderBy('bumped_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const readAt = await readAtFor(auth.user!.id)
    const users = await loadUserRefs(
      page.flatMap((a) => [a.acknowledgedByUserId, a.resolvedByUserId])
    )
    return serialize({
      alerts: page.map((a) => alertView(a, { readAt, users })),
      nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]) : null,
    })
  }

  /**
   * GET /api/v1/alerts/summary
   */
  async summary({ auth, serialize }: HttpContext) {
    const counts = (await db
      .from('alerts')
      .where('state', 'active')
      .groupBy('severity')
      .select('severity')
      .count('* as n')) as Array<{ severity: Severity; n: number | string }>
    const active: Record<Severity, number> = { critical: 0, warning: 0, info: 0 }
    for (const row of counts) active[row.severity] = Number(row.n)
    const readAt = await readAtFor(auth.user!.id)
    const latestQuery = Alert.query()
    whereVisible(latestQuery)
    const latest = await latestQuery.orderBy('bumped_at', 'desc').orderBy('id', 'desc').limit(6)
    const users = await loadUserRefs(
      latest.flatMap((a) => [a.acknowledgedByUserId, a.resolvedByUserId])
    )
    return serialize({
      active,
      unread: await unreadCount(readAt),
      latest: latest.map((a) => alertView(a, { readAt, users })),
    })
  }

  /**
   * GET /api/v1/alerts/catalogue
   */
  async catalogue({ serialize }: HttpContext) {
    const types = []
    for (const def of listAlertTypes()) {
      let reason: string | null = null
      if (def.available) {
        try {
          reason = await def.available()
        } catch (error) {
          logger.debug({ err: error, type: def.type }, 'alerts: availability check failed')
          reason = null
        }
      }
      types.push(alertTypeView(def, reason))
    }
    return serialize({
      categories: CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] })),
      types,
    })
  }

  /**
   * GET /api/v1/alerts/:id
   */
  async show({ params, response, auth, serialize }: HttpContext) {
    const alert = await Alert.find(params.id)
    if (!alert) return notFound(response, params.id)
    const [events, deliveries, readAt, settings] = await Promise.all([
      AlertEvent.query().where('alert_id', alert.id).orderBy('id', 'desc').limit(50),
      AlertDelivery.query().where('alert_id', alert.id).orderBy('id', 'desc').limit(50),
      readAtFor(auth.user!.id),
      getAlertsSettings(),
    ])
    const mute = await findMatchingMute(alert, alertNow())
    const users = await loadUserRefs([
      alert.acknowledgedByUserId,
      alert.resolvedByUserId,
      mute?.createdByUserId,
    ])
    const def = getAlertType(alert.type)
    const labels = new Map<string, string | null>()
    if (mute?.subjectKind) {
      const subject = subjectFromRef(mute.subjectKind, mute.subjectRef ?? '')
      if (subject) {
        const { label } = await resolveSubjectLabel(subject)
        labels.set(`${mute.subjectKind}:${mute.subjectRef ?? ''}`, label)
      }
    }
    const maps = await loadDestinations(deliveries)
    return serialize({
      ...alertView(alert, { readAt, users }),
      data: alert.payload,
      events: events.map(alertEventView),
      deliveries: deliveries.map((d) => deliveryView(d, maps)),
      rule: def ? effectiveRule(def, settings) : null,
      mutedBy: mute ? muteView(mute, { users, labels }) : null,
    })
  }

  /**
   * POST /api/v1/alerts/read
   */
  async read({ request, response, auth, serialize }: HttpContext) {
    const body = await request.validateUsing(alertReadValidator)
    const now = alertNow()
    let through = now
    if (body.through) {
      const parsed = DateTime.fromISO(body.through, { zone: 'utc' })
      if (!parsed.isValid) {
        return unprocessable(response, 'through', 'date', 'Expected an ISO-8601 time.')
      }
      through = parsed < now ? parsed : now
    }
    const userId = auth.user!.id
    const state = (await AlertUserState.find(userId)) ?? new AlertUserState()
    state.userId = userId
    if (!state.readAt || through > state.readAt) state.readAt = through.startOf('second')
    await state.save()
    return serialize({
      readAt: state.readAt!.toUTC().toISO({ suppressMilliseconds: true }),
      unread: await unreadCount(state.readAt),
    })
  }

  /**
   * POST /api/v1/alerts/:id/acknowledge
   */
  async acknowledge({ params, request, response, auth, serialize }: HttpContext) {
    const body = await request.validateUsing(alertNoteValidator)
    try {
      const alert = await acknowledgeAlert(Number(params.id), auth.user!.id, body.note ?? null)
      return serialize(await this.viewFor(alert, auth.user!.id))
    } catch (error) {
      return this.actionError(error, response)
    }
  }

  /**
   * POST /api/v1/alerts/:id/resolve
   */
  async resolve({ params, request, response, auth, serialize }: HttpContext) {
    const body = await request.validateUsing(alertNoteValidator)
    try {
      const alert = await resolveAlertManually(Number(params.id), auth.user!.id, body.note ?? null)
      return serialize(await this.viewFor(alert, auth.user!.id))
    } catch (error) {
      return this.actionError(error, response)
    }
  }

  private async viewFor(alert: Alert, userId: number) {
    const users = await loadUserRefs([alert.acknowledgedByUserId, alert.resolvedByUserId])
    return alertView(alert, { readAt: await readAtFor(userId), users })
  }

  private actionError(error: unknown, response: HttpContext['response']) {
    if (error instanceof AlertActionError) {
      const body = { error: error.code, message: error.message }
      return error.code === 'alert_not_found' ? response.notFound(body) : response.conflict(body)
    }
    throw error
  }
}
