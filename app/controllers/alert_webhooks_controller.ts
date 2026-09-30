import AlertWebhook from '#models/alert_webhook'
import {
  DELIVERY_DISABLED_ERROR,
  DeliveryTestError,
  sendTestDelivery,
} from '#services/alerts/delivery_worker'
import {
  applyWebhookInput,
  newSigningSecret,
  readSecrets,
  WebhookInputError,
  webhookAuthOf,
  webhookView,
} from '#services/alerts/webhooks/destinations'
import { deliveryView } from '#transformers/alert_deliveries'
import { webhookCreateValidator, webhookUpdateValidator } from '#validators/alert_webhooks'
import type { HttpContext } from '@adonisjs/core/http'
import encryption from '@adonisjs/core/services/encryption'

/**
 * Webhook destinations (docs/design/alerts/api.md §3.6), admin-only (the
 * routes add `requireAdmin`). The URL, auth and signing secret are write-only:
 * the secret of a `standard` webhook is shown once, on create and on
 * rotate-secret.
 */

type Ctx = HttpContext

function inputError(response: Ctx['response'], error: WebhookInputError) {
  return response.unprocessableEntity({ error: error.code, message: error.message })
}

async function findWebhook({ params, response }: Ctx): Promise<AlertWebhook | null> {
  const row = await AlertWebhook.find(Number(params.id))
  if (!row) response.notFound({ error: 'webhook_not_found', message: 'No such webhook.' })
  return row
}

export default class AlertWebhooksController {
  /**
   * GET /api/v1/settings/alerts/webhooks
   */
  async index() {
    const rows = await AlertWebhook.query().orderBy('id', 'asc')
    // `serialize` leaves arrays unwrapped; the contract is `{ data: WebhookView[] }`.
    return { data: rows.map(webhookView) }
  }

  /**
   * POST /api/v1/settings/alerts/webhooks
   */
  async store({ auth, request, response, serialize }: Ctx) {
    const body = await request.validateUsing(webhookCreateValidator)
    const row = new AlertWebhook()
    let secret: string | null
    try {
      secret = applyWebhookInput(row, { ...body, auth: webhookAuthOf(body.auth) }, 'create')
    } catch (error) {
      if (error instanceof WebhookInputError) return inputError(response, error)
      throw error
    }
    row.createdByUserId = auth.user?.id ?? null
    await row.save()
    response.status(201)
    return serialize({ webhook: webhookView(row), secret })
  }

  /**
   * GET /api/v1/settings/alerts/webhooks/:id
   */
  async show(ctx: Ctx) {
    const row = await findWebhook(ctx)
    if (!row) return
    return ctx.serialize(webhookView(row))
  }

  /**
   * PATCH /api/v1/settings/alerts/webhooks/:id
   */
  async update(ctx: Ctx) {
    const row = await findWebhook(ctx)
    if (!row) return
    const body = await ctx.request.validateUsing(webhookUpdateValidator)
    try {
      applyWebhookInput(row, { ...body, auth: webhookAuthOf(body.auth) }, 'update')
    } catch (error) {
      if (error instanceof WebhookInputError) return inputError(ctx.response, error)
      throw error
    }
    await row.save()
    return ctx.serialize(webhookView(row))
  }

  /**
   * DELETE /api/v1/settings/alerts/webhooks/:id (its deliveries go with it)
   */
  async destroy(ctx: Ctx) {
    const row = await findWebhook(ctx)
    if (!row) return
    await row.delete()
    return ctx.response.noContent()
  }

  /**
   * POST /api/v1/settings/alerts/webhooks/:id/test
   */
  async test(ctx: Ctx) {
    const row = await findWebhook(ctx)
    if (!row) return
    const { response, serialize } = ctx
    if (!readSecrets(row)) {
      if (row.state !== 'needs_secret') {
        row.state = 'needs_secret'
        await row.save()
      }
      return response.conflict({
        error: 'webhook_needs_secret',
        message: 'The URL, auth or secret is unreadable (APP_KEY changed): enter them again.',
      })
    }
    try {
      const { delivery, result } = await sendTestDelivery('webhook', row)
      const maps = { push: new Map(), webhooks: new Map([[row.id, row]]) }
      return serialize({
        delivery: deliveryView(delivery, maps),
        result: {
          outcome: result.outcome,
          statusCode: result.statusCode ?? null,
          error: result.outcome === 'sent' ? null : result.error,
          durationMs: Math.round(result.durationMs),
          responseExcerpt: result.responseExcerpt ?? '',
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
   * POST /api/v1/settings/alerts/webhooks/:id/rotate-secret
   *
   * Also signs a `standard` webhook that has no (readable) secret yet.
   */
  async rotateSecret(ctx: Ctx) {
    const row = await findWebhook(ctx)
    if (!row) return
    if (row.format !== 'standard') {
      return ctx.response.conflict({
        error: 'webhook_not_signed',
        message: 'Only webhooks in the standard format are signed.',
      })
    }
    const secret = newSigningSecret()
    row.secretEncrypted = encryption.encrypt(secret)
    if (row.state === 'needs_secret' && readSecrets(row)) row.state = 'active'
    await row.save()
    return ctx.serialize({ webhook: webhookView(row), secret })
  }
}
