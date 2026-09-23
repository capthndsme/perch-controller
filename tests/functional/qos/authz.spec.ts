import QosWanQueue from '#models/qos_wan_queue'
import User from '#models/user'
import { recordRouterSqm } from '#services/qos_wan_queues'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import { sqmFixtureConfig } from '#tests/helpers/uci'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'

type Method = 'get' | 'post' | 'patch' | 'delete'

/** Every read: any signed-in user (owner decision 16: operators see every cap). */
function reads(gatewayId: number): Array<[Method, string]> {
  return [
    ['get', `/api/v1/qos/wan-queues?gatewayId=${gatewayId}`],
    ['get', `/api/v1/qos/policies?gatewayId=${gatewayId}`],
    ['get', `/api/v1/qos/groups?gatewayId=${gatewayId}`],
    ['get', `/api/v1/qos/assignments?gatewayId=${gatewayId}`],
    ['get', `/api/v1/qos/schedules?gatewayId=${gatewayId}`],
  ]
}

/** Every write, with a body that would be valid for an admin. */
function writes(
  gatewayId: number,
  queueId: number
): Array<[Method, string, Record<string, unknown>]> {
  return [
    [
      'post',
      '/api/v1/qos/wan-queues',
      { gatewayId, device: 'wan0', downloadKbit: 50000, uploadKbit: 10000 },
    ],
    ['patch', `/api/v1/qos/wan-queues/${queueId}`, { downloadKbit: 900000 }],
    ['delete', `/api/v1/qos/wan-queues/${queueId}`, {}],
    ['patch', '/api/v1/settings/qos', { minWanKbit: 2000 }],
  ]
}

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

function call(client: ApiClient, method: Method, path: string, token?: string) {
  const request = client[method](path)
  return token ? request.bearerToken(token) : request
}

async function seed() {
  const tokens = await seedSetupComplete()
  const { gateway } = await seedQosGateway()
  await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
  const queue = await QosWanQueue.findByOrFail('gatewayId', gateway.id)
  return { ...tokens, gateway, queue }
}

test.group('qos | authorization', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('operators read every cap; only admins write', async ({ client, assert }) => {
    const { operatorToken, adminToken, gateway, queue } = await seed()
    for (const [method, path] of reads(gateway.id)) {
      const response = await call(client, method, path, operatorToken)
      response.assertStatus(200)
    }
    for (const [method, path, body] of writes(gateway.id, queue.id)) {
      const response = await call(client, method, path, operatorToken).json(body)
      response.assertStatus(403)
      assert.equal(bodyOf(response).error, 'admin_required', `${method} ${path}`)
    }
    // Settings are admin-only, reads included (the settings group).
    const settings = await call(client, 'get', '/api/v1/settings/qos', operatorToken)
    settings.assertStatus(403)
    const adminSettings = await call(client, 'get', '/api/v1/settings/qos', adminToken)
    adminSettings.assertStatus(200)
    // Nothing changed.
    const after = await QosWanQueue.findOrFail(queue.id)
    assert.deepEqual(after.options, queue.options)
  })

  test('anonymous requests get 401', async ({ client }) => {
    const { gateway, queue } = await seed()
    for (const [method, path] of reads(gateway.id)) {
      const response = await call(client, method, path)
      response.assertStatus(401)
    }
    for (const [method, path, body] of writes(gateway.id, queue.id)) {
      const response = await call(client, method, path).json(body)
      response.assertStatus(401)
    }
    const settings = await call(client, 'get', '/api/v1/settings/qos')
    settings.assertStatus(401)
  })

  test('a user who must change the password is held back', async ({ client, assert }) => {
    const { gateway } = await seed()
    const invited = await User.create({
      fullName: 'Invited',
      email: 'invited@example.com',
      password: 'invited-pass-123',
      role: 'operator',
      mustChangePassword: true,
    })
    const created = await User.accessTokens.create(invited)
    const token = created.value!.release()
    const response = await call(
      client,
      'get',
      `/api/v1/qos/wan-queues?gatewayId=${gateway.id}`,
      token
    )
    response.assertStatus(403)
    assert.equal(bodyOf(response).error, 'password_change_required')
  })
})
