import User from '#models/user'
import { bodyOf, call, resetPortalTests, seedPortal, seedPortalWorld } from '#tests/helpers/portal'
import { test } from '@japa/runner'

type Method = 'get' | 'post' | 'patch' | 'delete' | 'put'

/** Readable by any signed-in user. */
function reads(portalId: number): Array<[Method, string]> {
  return [
    ['get', '/api/v1/portal/portals'],
    ['get', `/api/v1/portal/portals/${portalId}`],
    ['get', '/api/v1/portal/grants'],
    ['get', '/api/v1/portal/sessions'],
  ]
}

/** Admin-only, with bodies that would be valid for an admin. */
function adminOnly(portalId: number, templateId: number): Array<[Method, string, object]> {
  return [
    ['post', '/api/v1/portal/portals', { gatewayId: 1, name: 'x', networkPerchId: 'n_iot' }],
    ['patch', `/api/v1/portal/portals/${portalId}`, { name: 'y' }],
    ['delete', `/api/v1/portal/portals/${portalId}`, {}],
    ['post', '/api/v1/portal/grants/1/extend', { minutes: 5 }],
    ['post', '/api/v1/portal/grants/1/revoke', {}],
    ['get', '/api/v1/portal/templates', {}],
    ['get', `/api/v1/portal/templates/${templateId}`, {}],
    ['get', `/api/v1/portal/templates/${templateId}/preview`, {}],
    ['post', `/api/v1/portal/templates/${templateId}/duplicate`, { name: 'copy' }],
    ['patch', `/api/v1/portal/templates/${templateId}`, { name: 'x' }],
    ['delete', `/api/v1/portal/templates/${templateId}`, {}],
    ['delete', `/api/v1/portal/templates/${templateId}/files/login.html`, {}],
    ['post', '/api/v1/portal/voucher-batches', { name: 'b', count: 1, durationMinutes: 60 }],
    ['get', '/api/v1/portal/voucher-batches', {}],
    ['get', '/api/v1/portal/voucher-batches/1', {}],
    ['get', '/api/v1/portal/voucher-batches/1/codes', {}],
    ['get', '/api/v1/portal/voucher-batches/1/codes.csv', {}],
    ['post', '/api/v1/portal/voucher-batches/1/revoke', {}],
    ['delete', '/api/v1/portal/voucher-batches/1', {}],
    ['get', '/api/v1/portal/vouchers', {}],
    ['post', '/api/v1/portal/vouchers/lookup', { code: 'K7Q2M9XH4D' }],
    ['post', '/api/v1/portal/vouchers/1/revoke', {}],
    ['get', '/api/v1/portal/users', {}],
    ['post', '/api/v1/portal/users', { username: 'guest', password: 'guest-pass-1' }],
    ['patch', '/api/v1/portal/users/1', { enabled: false }],
    ['put', '/api/v1/portal/users/1/password', { password: 'guest-pass-2' }],
    ['delete', '/api/v1/portal/users/1', {}],
    ['get', '/api/v1/portal/api-clients', {}],
    ['post', '/api/v1/portal/api-clients', { name: 'c', portalIds: [portalId], scopes: ['read'] }],
    ['patch', '/api/v1/portal/api-clients/1', { name: 'd' }],
    ['post', '/api/v1/portal/api-clients/1/rotate', {}],
    ['delete', '/api/v1/portal/api-clients/1', {}],
    ['get', '/api/v1/settings/portal', {}],
    ['patch', '/api/v1/settings/portal', { sessionRetentionDays: 10 }],
  ]
}

test.group('portal | authorization', (group) => {
  group.each.setup(resetPortalTests)

  test('operators and viewers read; only admins write', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    for (const token of [world.operatorToken, world.viewerToken]) {
      for (const [method, path] of reads(portal.id)) {
        const response = await call(client, method, path, token)
        response.assertStatus(200)
      }
      for (const [method, path, body] of adminOnly(portal.id, world.builtinTemplateId)) {
        const response = await call(client, method, path, token).json(body)
        assert.equal(response.status(), 403, `${method} ${path}`)
        assert.equal(bodyOf(response).error, 'admin_required', `${method} ${path}`)
      }
    }
    // Nothing was written.
    const list = await call(client, 'get', '/api/v1/portal/portals', world.adminToken)
    assert.deepEqual(
      bodyOf(list).data.map((p: { name: string }) => p.name),
      [portal.name]
    )
  })

  test('anonymous requests get 401', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    for (const [method, path] of reads(portal.id)) {
      const response = await call(client, method, path)
      assert.equal(response.status(), 401, `${method} ${path}`)
    }
    for (const [method, path, body] of adminOnly(portal.id, world.builtinTemplateId)) {
      const response = await call(client, method, path).json(body)
      assert.equal(response.status(), 401, `${method} ${path}`)
    }
  })

  test('a user who must change the password is held back', async ({ client, assert }) => {
    await seedPortalWorld()
    const invited = await User.create({
      fullName: 'Invited',
      email: 'invited@example.com',
      password: 'temporary-pass-123',
      role: 'admin',
      mustChangePassword: true,
    })
    const access = await User.accessTokens.create(invited)
    const token = access.value!.release()
    const response = await call(client, 'get', '/api/v1/portal/portals', token)
    response.assertStatus(403)
    assert.equal(bodyOf(response).error, 'password_change_required')
  })

  test('before setup the endpoints answer 503', async ({ client }) => {
    for (const path of [
      '/api/v1/portal/portals',
      '/api/v1/portal/templates',
      '/api/v1/portal/authorizations/02:00:00:00:aa:01?portalId=1',
    ]) {
      const response = await call(client, 'get', path)
      response.assertStatus(503)
    }
  })
})
