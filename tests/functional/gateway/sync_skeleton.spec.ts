import { seedSetupComplete } from '#tests/helpers/ap_agent'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * The gateway-sync route skeleton (docs/design/gateway-sync/rest.md 0 and 12;
 * work package B8): every route is registered before the SPA catch-all,
 * admin-only (anonymous 401, viewer 403). Every work package is built since
 * Phase C (2026-09-30): no route answers 501 `not_built` any more.
 */

const PHASE_C: Array<
  [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, wp: string]
> = [
  ['get', '/api/v1/gateways/1/wireguard/config', 'B2'],
  ['post', '/api/v1/gateways/1/wireguard/interfaces', 'B2'],
  ['patch', '/api/v1/gateways/1/wireguard/interfaces/abc123', 'B2'],
  ['delete', '/api/v1/gateways/1/wireguard/interfaces/abc123', 'B2'],
  ['post', '/api/v1/gateways/1/wireguard/interfaces/abc123/rotate-key', 'B2'],
  ['post', '/api/v1/gateways/1/wireguard/interfaces/abc123/peers', 'B2'],
  ['patch', '/api/v1/gateways/1/wireguard/peers/abc123', 'B2'],
  ['delete', '/api/v1/gateways/1/wireguard/peers/abc123', 'B2'],
  ['get', '/api/v1/gateways/1/ipv6', 'B4'],
  ['patch', '/api/v1/gateways/1/ipv6', 'B4'],
  ['patch', '/api/v1/gateways/1/ipv6/lans/lan', 'B4'],
  ['get', '/api/v1/gateways/1/upnp/config', 'B5'],
  ['patch', '/api/v1/gateways/1/upnp/config', 'B5'],
  ['post', '/api/v1/gateways/1/upnp/acl', 'B5'],
  ['put', '/api/v1/gateways/1/upnp/acl/order', 'B5'],
  ['patch', '/api/v1/gateways/1/upnp/acl/abc123', 'B5'],
  ['delete', '/api/v1/gateways/1/upnp/acl/abc123', 'B5'],
  ['post', '/api/v1/gateways/1/upnp/mappings/delete', 'B5'],
  ['put', '/api/v1/gateways/1/upnp/devices/02:00:00:00:00:01', 'B5'],
  ['get', '/api/v1/gateways/1/ddns', 'B6'],
  ['post', '/api/v1/gateways/1/ddns/services', 'B6'],
  ['patch', '/api/v1/gateways/1/ddns/services/abc123', 'B6'],
  ['delete', '/api/v1/gateways/1/ddns/services/abc123', 'B6'],
  ['post', '/api/v1/gateways/1/ddns/services/abc123/update-now', 'B6'],
]

/** Every route of rest.md 12 built so far (mwan3 writes are not built: decision 12). */
const ALL_ADMIN: Array<[method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string]> = [
  ...PHASE_C.map(([m, p]) => [m, p] as [typeof m, string]),
  // B1 (Phase B): WAN and Settings → Gateway sync.
  ['get', '/api/v1/gateways/1/wan'],
  ['get', '/api/v1/gateways/1/wan/history'],
  ['put', '/api/v1/gateways/1/wan/order'],
  ['post', '/api/v1/gateways/1/wan'],
  ['get', '/api/v1/gateways/1/wan/abc123'],
  ['patch', '/api/v1/gateways/1/wan/abc123'],
  ['delete', '/api/v1/gateways/1/wan/abc123'],
  ['post', '/api/v1/gateways/1/wan/abc123/aliases'],
  ['patch', '/api/v1/gateways/1/wan/aliases/abc123'],
  ['delete', '/api/v1/gateways/1/wan/aliases/abc123'],
  ['get', '/api/v1/settings/gateway-sync'],
  ['patch', '/api/v1/settings/gateway-sync'],
  ['get', '/api/v1/gateways/1/ambiguities'],
  ['post', '/api/v1/gateways/1/ambiguities/resolve'],
  ['get', '/api/v1/gateways/1/firewall/defaults'],
  ['patch', '/api/v1/gateways/1/firewall/defaults'],
  ['get', '/api/v1/gateways/1/multiwan'],
]

test.group('gateway sync | route skeleton', (group) => {
  group.each.setup(async () => {
    const teardown = await testUtils.db().truncate()
    await teardown()
  })

  test('every route is admin-only: anonymous 401, viewer 403', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    for (const [method, path] of ALL_ADMIN) {
      const anonymous = await client[method](path)
      assert.equal(anonymous.status(), 401, `${method} ${path} anonymous`)
      const viewer = await client[method](path).bearerToken(operatorToken)
      assert.equal(viewer.status(), 403, `${method} ${path} viewer`)
    }
  })

  test('every work package is built: no route answers 501 not_built', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    for (const [method, path, wp] of PHASE_C) {
      const r = await client[method](path).bearerToken(adminToken)
      assert.notEqual(r.status(), 501, `${method} ${path} (${wp})`)
      assert.notEqual((r.body() as { error?: string }).error, 'not_built', `${method} ${path}`)
    }
  })

  test('mwan3 writes stay unrouted (decision 12): PUT /multiwan is not an API route', async ({
    client,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const r = await client.put('/api/v1/gateways/1/multiwan').bearerToken(adminToken).json({})
    r.assertStatus(404)
  })
})
