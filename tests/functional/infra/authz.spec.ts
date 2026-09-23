import User from '#models/user'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetInfraTests, seedManualNode } from '#tests/helpers/infra'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'

type Method = 'get' | 'post' | 'patch' | 'delete' | 'put'

const READS: Array<[Method, string]> = [
  ['get', '/api/v1/infra/layout'],
  ['get', '/api/v1/infra/state'],
]

/** Every write, with a body that would be valid for an admin. */
function writes(nodeId: number, portId: number): Array<[Method, string, Record<string, unknown>]> {
  return [
    ['post', '/api/v1/infra/nodes', { kind: 'switch', name: 'Switch' }],
    ['patch', `/api/v1/infra/nodes/${nodeId}`, { notes: 'x' }],
    ['delete', `/api/v1/infra/nodes/${nodeId}`, {}],
    ['post', `/api/v1/infra/nodes/${nodeId}/bind`, { apId: 1 }],
    ['post', `/api/v1/infra/nodes/${nodeId}/ports`, { ports: [{ key: 'x1' }] }],
    ['patch', `/api/v1/infra/ports/${portId}`, { label: 'x' }],
    ['delete', `/api/v1/infra/ports/${portId}`, {}],
    ['post', '/api/v1/infra/links', { aPortId: portId, bPortId: portId + 1 }],
    ['patch', '/api/v1/infra/links/1', { label: 'x' }],
    ['delete', '/api/v1/infra/links/1', {}],
    ['put', '/api/v1/infra/positions', { positions: [{ nodeId, x: 1, y: 1 }] }],
  ]
}

/** Response bodies are untyped JSON. */
function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

function call(client: ApiClient, method: Method, path: string, token?: string) {
  const request = client[method](path)
  return token ? request.bearerToken(token) : request
}

test.group('infra | authorization', (group) => {
  group.each.setup(resetInfraTests)

  test('any signed-in user reads; only admins write', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const node = await seedManualNode('switch', 'Switch', ['1', '2'])

    for (const [method, path] of READS) {
      const response = await call(client, method, path, operatorToken)
      response.assertStatus(200)
    }
    for (const [method, path, body] of writes(node.id, node.ports['1'])) {
      const response = await call(client, method, path, operatorToken).json(body)
      response.assertStatus(403)
      assert.equal(bodyOf(response).error, 'admin_required', `${method} ${path}`)
    }
    // Nothing was written.
    const layout = await call(client, 'get', '/api/v1/infra/layout', operatorToken)
    assert.deepEqual(
      bodyOf(layout).data.nodes.map((n: { id: number }) => n.id),
      [node.id]
    )
  })

  test('anonymous requests get 401', async ({ client }) => {
    await seedSetupComplete()
    const node = await seedManualNode('switch', 'Switch', ['1', '2'])
    for (const [method, path] of READS) {
      const response = await call(client, method, path)
      response.assertStatus(401)
    }
    for (const [method, path, body] of writes(node.id, node.ports['1'])) {
      const response = await call(client, method, path).json(body)
      response.assertStatus(401)
    }
  })

  test('a user who must change the password is held back', async ({ client, assert }) => {
    await seedSetupComplete()
    const invited = await User.create({
      fullName: 'Invited',
      email: 'invited@example.com',
      password: 'temporary-pass-123',
      role: 'admin',
      mustChangePassword: true,
    })
    const created = await User.accessTokens.create(invited)
    const token = created.value!.release()
    const response = await call(client, 'get', '/api/v1/infra/layout', token)
    response.assertStatus(403)
    assert.equal(bodyOf(response).error, 'password_change_required')
  })

  test('before setup the endpoints answer 503', async ({ client }) => {
    for (const path of ['/api/v1/infra/layout', '/api/v1/infra/state']) {
      const response = await call(client, 'get', path)
      response.assertStatus(503)
    }
  })
})
