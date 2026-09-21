import type { HttpContext } from '@adonisjs/core/http'

/**
 * The device agents' WebSocket paths as the router sees them. Once the
 * gateway (providers/agent_gateway_provider.ts) is attached it takes every
 * upgrade request on the Node server before the router could; it attaches in
 * the provider's `ready()`, after the server starts listening. An upgrade that
 * arrives in that first moment lands here, and a 404 would read as "this
 * controller has no agent support": perch-apd and the collector back off for
 * five minutes on that. A 503 makes them retry within seconds. A plain GET
 * learns that the path wants an upgrade.
 */
export default class AgentSocketsController {
  async fallback({ request, response }: HttpContext) {
    if ((request.header('upgrade') ?? '').toLowerCase() === 'websocket') {
      response.header('Retry-After', '1')
      return response.serviceUnavailable({
        error: 'gateway_starting',
        message: 'The controller is starting; retry in a moment.',
      })
    }
    response.header('Upgrade', 'websocket')
    return response.status(426).send({
      error: 'upgrade_required',
      message: 'This is the WebSocket endpoint of the Perch device agents.',
    })
  }
}
