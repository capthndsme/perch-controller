import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/users'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/** Admin + instance + collector, so the setup gate lets settings routes through. */
async function seedAdmin(): Promise<string> {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  const token = await User.accessTokens.create(admin)
  return token.value!.release()
}

test.group('users settings API', (group) => {
  group.each.setup(resetDb)

  test('creating a user answers 201 with the created user', async ({ client, assert }) => {
    const adminToken = await seedAdmin()

    const response = await client.post(ENDPOINT).bearerToken(adminToken).json({
      fullName: 'Viewer',
      email: 'viewer@example.com',
      password: 'viewer-pass-123',
      passwordConfirmation: 'viewer-pass-123',
      role: 'viewer',
    })

    response.assertStatus(201)
    const body = response.body() as { data: { user: { id: number; email: string; role: string } } }
    assert.equal(body.data.user.email, 'viewer@example.com')
    assert.equal(body.data.user.role, 'viewer')
    assert.isNumber(body.data.user.id)

    const stored = await User.findByOrFail('email', 'viewer@example.com')
    assert.equal(stored.id, body.data.user.id)
  })
})
