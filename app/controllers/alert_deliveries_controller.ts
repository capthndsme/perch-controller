import type { HttpContext } from '@adonisjs/core/http'

/**
 * The delivery log (docs/design/alerts/api.md §3.3). Stub from WP-A1:
 * every action answers 501 until WP-A2 replaces this file.
 */
function notImplemented({ response }: HttpContext) {
  return response.status(501).send({
    error: 'not_implemented',
    message: 'The delivery log is not built yet on this controller.',
  })
}

export default class AlertDeliveriesController {
  index = notImplemented
  show = notImplemented
}
