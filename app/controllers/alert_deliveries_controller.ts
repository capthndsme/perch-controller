import AlertDelivery from '#models/alert_delivery'
import AlertDeliveryAttempt from '#models/alert_delivery_attempt'
import { DELIVERY_STATUSES } from '#services/alerts/model'
import { attemptView, deliveryView, loadDestinations } from '#transformers/alert_deliveries'
import { alertDeliveryListValidator } from '#validators/alert_settings'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * The delivery log (docs/design/alerts/api.md §3.3). Admin-only.
 */
function unprocessable(
  response: HttpContext['response'],
  field: string,
  rule: string,
  message: string
) {
  return response.unprocessableEntity({ errors: [{ field, rule, message }] })
}

export default class AlertDeliveriesController {
  /**
   * GET /api/v1/alerts/deliveries
   */
  async index({ request, response, serialize }: HttpContext) {
    const q = await request.validateUsing(alertDeliveryListValidator, { data: request.qs() })
    const limit = q.limit ?? 50
    const query = AlertDelivery.query().orderBy('id', 'desc')
    if (q.destination) {
      const match = /^(push|webhook):(\d+)$/.exec(q.destination)
      if (!match) {
        return unprocessable(
          response,
          'destination',
          'destination',
          'Expected push:<id> or webhook:<id>.'
        )
      }
      query.where(match[1] === 'push' ? 'push_subscription_id' : 'webhook_id', Number(match[2]))
    }
    if (q.alertId) {
      const id = q.alertId
      query.where((w) =>
        w.where('alert_id', id).orWhereRaw('JSON_CONTAINS(items, ?)', [String(id)])
      )
    }
    if (q.status) {
      const statuses = q.status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const bad = statuses.find((s) => !(DELIVERY_STATUSES as readonly string[]).includes(s))
      if (bad) return unprocessable(response, 'status', 'enum', `Unknown status "${bad}".`)
      if (statuses.length > 0) query.whereIn('status', statuses)
    }
    if (q.before) query.where('id', '<', q.before)
    const rows = await query.limit(limit + 1)
    const page = rows.slice(0, limit)
    const maps = await loadDestinations(page)
    return serialize({
      deliveries: page.map((d) => deliveryView(d, maps)),
      nextCursor: rows.length > limit ? Number(page[page.length - 1].id) : null,
    })
  }

  /**
   * GET /api/v1/alerts/deliveries/:id
   */
  async show({ params, response, serialize }: HttpContext) {
    const delivery = await AlertDelivery.find(params.id)
    if (!delivery) {
      return response.notFound({
        error: 'delivery_not_found',
        message: `Delivery ${params.id} does not exist.`,
      })
    }
    const attempts = await AlertDeliveryAttempt.query()
      .where('delivery_id', delivery.id)
      .orderBy('id', 'desc')
      .limit(20)
    const maps = await loadDestinations([delivery])
    return serialize({ ...deliveryView(delivery, maps), attempts: attempts.map(attemptView) })
  }
}
