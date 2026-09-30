import type { HttpContext } from '@adonisjs/core/http'

/**
 * Settings → Alerts (docs/design/alerts/api.md §3.5). Stub from WP-A1:
 * every action answers 501 until WP-A2 replaces this file.
 */
function notImplemented({ response }: HttpContext) {
  return response.status(501).send({
    error: 'not_implemented',
    message: 'Alert settings are not built yet on this controller.',
  })
}

export default class AlertSettingsController {
  show = notImplemented
  update = notImplemented
  test = notImplemented
}
