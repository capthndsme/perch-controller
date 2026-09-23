import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import {
  GATEWAY_CONFIG_DEFAULTS,
  GATEWAY_CONFIG_LIMITS,
  GATEWAY_CONFIG_SETTING_KEY,
  getGatewayConfigSettings,
} from '#services/gateway_config/gateway_config_settings'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/gateway'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function seed(role: 'admin' | 'operator' = 'admin'): Promise<string> {
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  // Setup counts as complete once a collector exists.
  await Collector.create({
    name: 'gateway',
    baseUrl: 'http://192.168.1.1:9800',
    pollIntervalSeconds: 5,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  if (role !== 'admin') {
    await User.create({
      fullName: 'admin',
      email: 'admin@example.com',
      password: 'admin-pass-123',
      role: 'admin',
    })
  }
  const user = await User.create({
    fullName: role,
    email: `${role}@example.com`,
    password: `${role}-pass-123`,
    role,
  })
  const token = await User.accessTokens.create(user)
  return token.value!.release()
}

test.group('gateway settings API', (group) => {
  group.each.setup(resetDb)

  test('unauthenticated 401, non-admin 403', async ({ client }) => {
    const operator = await seed('operator')
    const anonymous = await client.get(ENDPOINT)
    anonymous.assertStatus(401)
    const read = await client.get(ENDPOINT).bearerToken(operator)
    read.assertStatus(403)
    read.assertBodyContains({ error: 'admin_required' })
    const write = await client.patch(ENDPOINT).bearerToken(operator).json({ keepRevisions: 60 })
    write.assertStatus(403)
  })

  test('defaults when nothing is stored: grace 90 s, confirm 90 s, admin_and_agent', async ({
    client,
    assert,
  }) => {
    const token = await seed()
    const response = await client.get(ENDPOINT).bearerToken(token)
    response.assertStatus(200)
    const data = response.body().data
    assert.deepEqual(data.settings, { ...GATEWAY_CONFIG_DEFAULTS })
    assert.equal(data.settings.authoritativeRevertDelaySeconds, 90)
    assert.equal(data.settings.confirmTimeoutSeconds, 90)
    assert.equal(data.settings.confirmMode, 'admin_and_agent')
    assert.isFalse(data.settings.allowInsecureTransport)
    assert.deepEqual(data.limits, GATEWAY_CONFIG_LIMITS)
    assert.deepEqual(data.choices, { confirmMode: ['agent', 'admin_and_agent'] })
  })

  test('patch changes only the fields it sends and persists them', async ({ client, assert }) => {
    const token = await seed()
    const first = await client.patch(ENDPOINT).bearerToken(token).json({
      authoritativeRevertDelaySeconds: 120,
      confirmMode: 'agent',
      allowInsecureTransport: true,
      localStatePath: '/mnt/usb/perch-state',
    })
    first.assertStatus(200)
    const expected = {
      ...GATEWAY_CONFIG_DEFAULTS,
      authoritativeRevertDelaySeconds: 120,
      confirmMode: 'agent',
      allowInsecureTransport: true,
      localStatePath: '/mnt/usb/perch-state',
    }
    assert.deepEqual(first.body().data.settings, expected)

    const second = await client.patch(ENDPOINT).bearerToken(token).json({ keepRevisions: 1000 })
    second.assertStatus(200)
    assert.deepEqual(second.body().data.settings, { ...expected, keepRevisions: 1000 })
    assert.deepEqual(await getGatewayConfigSettings(), { ...expected, keepRevisions: 1000 })
  })

  test('out-of-range, fractional, wrong-typed and unsafe values are rejected with 422', async ({
    client,
    assert,
  }) => {
    const token = await seed()
    for (const body of [
      { confirmTimeoutSeconds: 10 },
      { confirmTimeoutSeconds: 601 },
      { keepRevisions: 60.5 },
      { authoritativeRevertDelaySeconds: -1 },
      { enforcementMaxFailures: 0 },
      { confirmMode: 'router' },
      { allowInsecureTransport: 'yes' },
      { localStatePath: 'relative/path' },
      { localStatePath: '/' },
      { localStatePath: '/etc/../tmp' },
      { localStatePath: '/tmp/state; rm -rf /' },
    ]) {
      const response = await client.patch(ENDPOINT).bearerToken(token).json(body)
      response.assertStatus(422)
    }
    assert.isNull(await SystemSetting.get(GATEWAY_CONFIG_SETTING_KEY), 'nothing stored')
  })

  test('stored values are normalised: clamped, wrong kinds read as defaults', async ({
    client,
    assert,
  }) => {
    const token = await seed()
    await SystemSetting.set(GATEWAY_CONFIG_SETTING_KEY, {
      confirmTimeoutSeconds: 5,
      keepRevisions: 99999,
      auditRetentionDays: 'forever',
      confirmMode: 'nobody',
      allowInsecureTransport: 1,
      localStatePath: '/../etc',
    })
    const response = await client.get(ENDPOINT).bearerToken(token)
    assert.deepEqual(response.body().data.settings, {
      ...GATEWAY_CONFIG_DEFAULTS,
      confirmTimeoutSeconds: 30,
      keepRevisions: 10000,
    })
  })
})
