import type { HttpContext } from '@adonisjs/core/http'

/**
 * Web Push endpoints (docs/design/alerts/api.md §3.4). Stub from WP-A1:
 * every action answers 501 until WP-A3 replaces this file.
 */
function notImplemented({ response }: HttpContext) {
  return response.status(501).send({
    error: 'not_implemented',
    message: 'Web Push is not built yet on this controller.',
  })
}

export default class AlertPushController {
  config = notImplemented
  index = notImplemented
  store = notImplemented
  update = notImplemented
  destroy = notImplemented
  unsubscribe = notImplemented
  test = notImplemented
  renew = notImplemented
  rotate = notImplemented
}
