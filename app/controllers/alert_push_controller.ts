import AlertPushSubscription from '#models/alert_push_subscription'
import {
  DELIVERY_DISABLED_ERROR,
  deliveryEnabled,
  DeliveryTestError,
  sendTestDelivery,
} from '#services/alerts/delivery_worker'
import { mergeFilters, PUSH_FILTER_DEFAULTS } from '#services/alerts/filters'
import { allowedPushServices } from '#services/alerts/push/push_services'
import {
  chargeRenew,
  checkSubscription,
  endpointHash,
  platformFromUserAgent,
  PushSubscriptionError,
  pushSubscriptionView,
  renewSubscription,
  upsertSubscription,
} from '#services/alerts/push/subscriptions'
import { rotateVapidKeys, vapidKeys } from '#services/alerts/push/vapid'
import { getAlertsSettings } from '#services/alerts/settings'
import { deliveryView } from '#transformers/alert_deliveries'
import {
  pushRenewValidator,
  pushSubscribeValidator,
  pushUnsubscribeValidator,
  pushUpdateValidator,
  vapidRotateValidator,
} from '#validators/alert_push'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Web Push endpoints (docs/design/alerts/api.md §3.4) and the VAPID rotation
 * of Settings → Alerts. Any signed-in user manages their own devices; an admin
 * sees and manages everyone's. The renew route has no bearer: the service
 * worker proves itself with the renew token the page stored.
 */

type Ctx = HttpContext

function subscriptionError(response: Ctx['response'], error: PushSubscriptionError) {
  if (error.code === 'push_service_not_allowed') {
    return response.unprocessableEntity({ error: error.code, message: error.message })
  }
  return response.unprocessableEntity({
    errors: [{ field: error.field, rule: error.code, message: error.message }],
  })
}

/** The row, or the 404 / 403 answer. */
async function ownedSubscription({
  auth,
  params,
  response,
}: Ctx): Promise<AlertPushSubscription | { answered: true }> {
  const row = await AlertPushSubscription.find(Number(params.id))
  if (!row) {
    response.notFound({ error: 'subscription_not_found', message: 'No such push subscription.' })
    return { answered: true }
  }
  const user = auth.getUserOrFail()
  if (Number(row.userId) !== Number(user.id) && !user.isAdmin) {
    response.forbidden({ error: 'not_owner', message: 'This device belongs to another user.' })
    return { answered: true }
  }
  return row
}

export default class AlertPushController {
  /**
   * GET /api/v1/alerts/push/config
   */
  async config({ serialize }: Ctx) {
    const [keys, settings] = await Promise.all([vapidKeys(), getAlertsSettings()])
    const reason = !keys.privateKey
      ? 'keys_unreadable'
      : !deliveryEnabled()
        ? 'delivery_disabled'
        : null
    return serialize({
      available: reason === null,
      reason,
      vapidPublicKey: keys.publicKey,
      vapidKeyId: keys.keyId,
      allowedServices: allowedPushServices(settings.allowAnyPushService),
    })
  }

  /**
   * GET /api/v1/alerts/push/subscriptions (`?all=1`: everyone's, admin only)
   */
  async index({ auth, request, response }: Ctx) {
    const user = auth.getUserOrFail()
    const all = ['1', 'true'].includes(String(request.input('all', '')))
    if (all && !user.isAdmin) {
      return response.forbidden({
        error: 'admin_required',
        message: 'This endpoint requires an admin role.',
      })
    }
    const query = AlertPushSubscription.query().orderBy('id', 'asc')
    if (!all) query.where('user_id', user.id)
    const rows = await query
    // `serialize` leaves arrays unwrapped; the contract is `{ data: PushSubscriptionView[] }`.
    return { data: rows.map(pushSubscriptionView) }
  }

  /**
   * POST /api/v1/alerts/push/subscriptions
   */
  async store({ auth, request, response, serialize }: Ctx) {
    const user = auth.getUserOrFail()
    const body = await request.validateUsing(pushSubscribeValidator)
    const settings = await getAlertsSettings()
    let service
    try {
      service = checkSubscription(body.subscription, settings.allowAnyPushService)
    } catch (error) {
      if (error instanceof PushSubscriptionError) return subscriptionError(response, error)
      throw error
    }
    const keys = await vapidKeys()
    if (!keys.privateKey) {
      return response.serviceUnavailable({
        error: 'push_unavailable',
        message:
          'The VAPID keys are unreadable (APP_KEY changed): an admin rotates them in Settings → Alerts.',
      })
    }
    if (body.vapidKeyId !== keys.keyId) {
      return response.conflict({
        error: 'vapid_key_mismatch',
        message: 'The controller has a new VAPID key: unsubscribe and subscribe again.',
      })
    }
    const result = await upsertSubscription({
      userId: user.id,
      subscription: body.subscription,
      service,
      vapidKeyId: keys.keyId,
      label: body.label,
      filters: body.filters,
      platform: platformFromUserAgent(request.header('user-agent')),
    })
    response.status(result.created ? 201 : 200)
    return serialize({
      subscription: pushSubscriptionView(result.row),
      renewToken: result.renewToken,
    })
  }

  /**
   * PATCH /api/v1/alerts/push/subscriptions/:id
   */
  async update(ctx: Ctx) {
    const row = await ownedSubscription(ctx)
    if (!(row instanceof AlertPushSubscription)) return
    const body = await ctx.request.validateUsing(pushUpdateValidator)
    if (body.label !== undefined) row.label = body.label || null
    if (body.enabled !== undefined) row.enabled = body.enabled
    if (body.filters) row.filters = mergeFilters(row.filters, body.filters, PUSH_FILTER_DEFAULTS)
    await row.save()
    return ctx.serialize(pushSubscriptionView(row))
  }

  /**
   * DELETE /api/v1/alerts/push/subscriptions/:id
   */
  async destroy(ctx: Ctx) {
    const row = await ownedSubscription(ctx)
    if (!(row instanceof AlertPushSubscription)) return
    await row.delete()
    return ctx.response.noContent()
  }

  /**
   * POST /api/v1/alerts/push/subscriptions/unsubscribe
   *
   * 204 even when nothing matched: logout must never fail on it.
   */
  async unsubscribe({ auth, request, response }: Ctx) {
    const user = auth.getUserOrFail()
    const { endpoint } = await request.validateUsing(pushUnsubscribeValidator)
    const query = AlertPushSubscription.query().where('endpoint_hash', endpointHash(endpoint))
    if (!user.isAdmin) query.where('user_id', user.id)
    await query.delete()
    return response.noContent()
  }

  /**
   * POST /api/v1/alerts/push/subscriptions/:id/test
   */
  async test(ctx: Ctx) {
    const row = await ownedSubscription(ctx)
    if (!(row instanceof AlertPushSubscription)) return
    const { response, serialize } = ctx
    if (row.state === 'gone') {
      return response.conflict({
        error: 'subscription_gone',
        message:
          'The push service dropped this subscription: enable notifications on the device again.',
      })
    }
    try {
      const { delivery, result } = await sendTestDelivery('push', row)
      const maps = { push: new Map([[row.id, row]]), webhooks: new Map() }
      return serialize({
        delivery: deliveryView(delivery, maps),
        result: {
          outcome: result.outcome,
          statusCode: result.statusCode ?? null,
          error: result.outcome === 'sent' ? null : result.error,
          durationMs: Math.round(result.durationMs),
          pushService: row.pushService,
        },
      })
    } catch (error) {
      if (!(error instanceof DeliveryTestError)) throw error
      if (error.code === 'delivery_disabled') {
        return response.conflict({ error: error.code, message: DELIVERY_DISABLED_ERROR })
      }
      response.header('Retry-After', String(error.retryAfterSeconds ?? 10))
      return response.tooManyRequests({ error: error.code, message: error.message })
    }
  }

  /**
   * POST /api/v1/alerts/push/renew (renew token, no bearer)
   */
  async renew({ request, response, serialize }: Ctx) {
    const wait = chargeRenew(request.ip())
    if (wait !== null) {
      response.header('Retry-After', String(wait))
      return response.tooManyRequests({
        error: 'renew_rate_limited',
        message: 'Too many renew calls from this address.',
      })
    }
    const body = await request.validateUsing(pushRenewValidator)
    const settings = await getAlertsSettings()
    let service
    try {
      service = checkSubscription(body.subscription, settings.allowAnyPushService)
    } catch (error) {
      if (error instanceof PushSubscriptionError) return subscriptionError(response, error)
      throw error
    }
    const renewed = await renewSubscription({
      oldEndpoint: body.oldEndpoint,
      renewToken: body.renewToken,
      subscription: body.subscription,
      service,
    })
    if (!renewed) {
      return response.unauthorized({
        error: 'renew_denied',
        message: 'Unknown subscription or renew token.',
      })
    }
    return serialize({ renewToken: renewed.renewToken })
  }

  /**
   * POST /api/v1/settings/alerts/vapid/rotate (admin)
   */
  async rotate({ request, serialize }: Ctx) {
    await request.validateUsing(vapidRotateValidator)
    const { stored, invalidated } = await rotateVapidKeys()
    return serialize({
      keyId: stored.keyId,
      publicKey: stored.publicKey,
      createdAt: stored.createdAt,
      invalidated,
    })
  }
}
