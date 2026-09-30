import type { HttpContext } from '@adonisjs/core/http'

/**
 * Webhook endpoints (docs/design/alerts/api.md §3.6). Stub from WP-A1:
 * every action answers 501 until WP-A4 replaces this file.
 */
function notImplemented({ response }: HttpContext) {
  return response.status(501).send({
    error: 'not_implemented',
    message: 'Webhooks are not built yet on this controller.',
  })
}

export default class AlertWebhooksController {
  index = notImplemented
  store = notImplemented
  show = notImplemented
  update = notImplemented
  destroy = notImplemented
  test = notImplemented
  rotateSecret = notImplemented
}
