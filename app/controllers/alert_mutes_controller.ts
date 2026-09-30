import AlertMute from '#models/alert_mute'
import { getAlertType } from '#services/alerts/catalogue/index'
import { alertNow } from '#services/alerts/clock'
import { releaseMutedAlerts } from '#services/alerts/engine'
import { createMute, listActiveMutes } from '#services/alerts/mutes'
import { resolveSubjectLabel, subjectFromRef } from '#services/alerts/subjects'
import { listWatches, setDeviceWatch, WatchLimitError } from '#services/alerts/watches'
import { loadUserRefs, muteView } from '#transformers/alerts'
import {
  alertMuteValidator,
  alertWatchListValidator,
  alertWatchValidator,
} from '#validators/alerts'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

/**
 * Mutes and watched devices (docs/design/alerts/api.md §3.2). Reads for
 * every user; writes admin-only (the routes add `requireAdmin`).
 */

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

function unprocessable(
  response: HttpContext['response'],
  field: string,
  rule: string,
  message: string
) {
  return response.unprocessableEntity({ errors: [{ field, rule, message }] })
}

async function muteViews(mutes: AlertMute[]) {
  const users = await loadUserRefs(mutes.map((m) => m.createdByUserId))
  const labels = new Map<string, string | null>()
  for (const mute of mutes) {
    if (!mute.subjectKind) continue
    const key = `${mute.subjectKind}:${mute.subjectRef ?? ''}`
    if (labels.has(key)) continue
    const subject = subjectFromRef(mute.subjectKind, mute.subjectRef ?? '')
    const resolved = subject ? await resolveSubjectLabel(subject) : null
    labels.set(key, resolved?.label ?? null)
  }
  return mutes.map((m) => muteView(m, { users, labels }))
}

export default class AlertMutesController {
  /**
   * GET /api/v1/alerts/mutes
   */
  async index() {
    // `serialize` leaves arrays unwrapped; the contract is `{ data: MuteView[] }`.
    return { data: await muteViews(await listActiveMutes(alertNow())) }
  }

  /**
   * POST /api/v1/alerts/mutes
   */
  async store({ request, response, auth, serialize }: HttpContext) {
    const body = await request.validateUsing(alertMuteValidator)
    if (!body.type && !body.subject) {
      return response.unprocessableEntity({
        error: 'mute_scope_required',
        message: 'A mute needs a type, a subject or both.',
        errors: [
          { field: 'type', rule: 'mute_scope_required', message: 'Give a type or a subject.' },
        ],
      })
    }
    if (body.type && !getAlertType(body.type)) {
      return response.unprocessableEntity({
        error: 'unknown_alert_type',
        message: `Unknown alert type "${body.type}".`,
        errors: [{ field: 'type', rule: 'alert_type', message: 'Unknown alert type.' }],
      })
    }
    if (body.minutes !== undefined && body.until !== undefined) {
      return unprocessable(
        response,
        'until',
        'exclusive',
        'Give either minutes or until, not both.'
      )
    }
    const subject = body.subject ? subjectFromRef(body.subject.kind, body.subject.ref) : null
    if (body.subject && !subject) {
      return unprocessable(response, 'subject', 'subject', 'Unknown subject kind or malformed ref.')
    }
    const now = alertNow()
    let until: DateTime | null = null
    if (body.minutes !== undefined) until = now.plus({ minutes: body.minutes })
    if (body.until !== undefined) {
      const parsed = DateTime.fromISO(body.until, { zone: 'utc' })
      if (!parsed.isValid)
        return unprocessable(response, 'until', 'date', 'Expected an ISO-8601 time.')
      if (parsed <= now) return unprocessable(response, 'until', 'future', 'Must be in the future.')
      until = parsed
    }
    const mute = await createMute({
      type: body.type ?? null,
      subject,
      until,
      reason: 'manual',
      note: body.note ?? null,
      createdByUserId: auth.user!.id,
    })
    const [view] = await muteViews([mute])
    response.status(201)
    return serialize(view)
  }

  /**
   * DELETE /api/v1/alerts/mutes/:id
   */
  async destroy({ params, response }: HttpContext) {
    const mute = await AlertMute.find(Number(params.id))
    if (!mute) {
      return response.notFound({
        error: 'mute_not_found',
        message: `Mute ${params.id} does not exist.`,
      })
    }
    await mute.delete()
    await releaseMutedAlerts([
      { type: mute.type, subjectKind: mute.subjectKind, subjectRef: mute.subjectRef },
    ])
    return response.noContent()
  }

  /**
   * GET /api/v1/alerts/watches
   */
  async watches({ request, response }: HttpContext) {
    const q = await request.validateUsing(alertWatchListValidator, { data: request.qs() })
    if (q.mac && !MAC.test(q.mac.toLowerCase())) {
      return unprocessable(response, 'mac', 'mac', 'Expected a MAC like 02:00:00:5e:10:22.')
    }
    return { data: await listWatches(q.mac) }
  }

  /**
   * PUT /api/v1/alerts/watches/devices/:mac
   */
  async updateWatch({ params, request, response, auth, serialize }: HttpContext) {
    const mac = String(params.mac ?? '').toLowerCase()
    if (!MAC.test(mac)) {
      return unprocessable(response, 'mac', 'mac', 'Expected a MAC like 02:00:00:5e:10:22.')
    }
    const body = await request.validateUsing(alertWatchValidator)
    try {
      return serialize(await setDeviceWatch(mac, body, auth.user!.id))
    } catch (error) {
      if (error instanceof WatchLimitError) {
        return response.unprocessableEntity({
          error: 'watch_limit',
          message: error.message,
          errors: [{ field: 'mac', rule: 'watch_limit', message: error.message }],
        })
      }
      throw error
    }
  }
}
