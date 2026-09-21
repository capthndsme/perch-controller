import { test } from '@japa/runner'

/**
 * Before the WebSocket gateway is attached (the moment after the server
 * starts listening), upgrades on the agents' paths reach the router. Node
 * hands a request to the router instead of the gateway when it lacks
 * `Connection: upgrade`, so an `Upgrade` header alone reproduces that here.
 */
test.group('device agent WebSocket paths without the gateway', () => {
  for (const path of ['/api/v1/ap-agent/ws', '/api/v1/collector-agent/ws']) {
    test(`an upgrade on ${path} that reaches the router gets 503 + Retry-After`, async ({
      client,
    }) => {
      const response = await client.get(path).header('Upgrade', 'websocket')
      response.assertStatus(503)
      response.assertHeader('retry-after', '1')
      response.assertBodyContains({ error: 'gateway_starting' })
    })

    test(`a plain GET on ${path} is told to upgrade`, async ({ client }) => {
      const response = await client.get(path)
      response.assertStatus(426)
      response.assertBodyContains({ error: 'upgrade_required' })
    })
  }
})
