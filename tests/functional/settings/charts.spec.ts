import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { CHART_DEFAULTS, CHART_SETTING_KEY, getChartSettings } from '#services/chart_settings'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/charts'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function userToken(role: 'admin'): Promise<string> {
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 5,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  const user = await User.create({
    fullName: role,
    email: `${role}@example.com`,
    password: 'admin-pass-123',
    role,
  })
  const token = await User.accessTokens.create(user)
  return token.value!.release()
}

test.group('chart settings API', (group) => {
  group.each.setup(resetDb)

  test('defaults, limits and the native retention come back for an admin', async ({
    client,
    assert,
  }) => {
    const token = await userToken('admin')
    const r = await client.get(ENDPOINT).bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.deepEqual(body.settings, { minBucketSeconds: 15, maxPoints: 1500 })
    assert.deepEqual(body.defaults, CHART_DEFAULTS)
    assert.deepEqual(body.limits.minBucketSeconds, { min: 5, max: 300 })
    assert.deepEqual(body.limits.maxPoints, { min: 100, max: 1500 })
    assert.isAtLeast(body.nativeRetentionDays, 1)
  })

  test('a non-admin is refused', async ({ client }) => {
    await userToken('admin')
    const operator = await User.create({
      fullName: 'Operator',
      email: 'operator@example.com',
      password: 'operator-pass-123',
      role: 'operator',
    })
    const accessToken = await User.accessTokens.create(operator)
    const token = accessToken.value!.release()
    const r = await client.get(ENDPOINT).bearerToken(token)
    r.assertStatus(403)
  })

  test('PATCH stores a subset and keeps the rest; out of range is a 422', async ({
    client,
    assert,
  }) => {
    const token = await userToken('admin')
    const ok = await client.patch(ENDPOINT).bearerToken(token).json({ minBucketSeconds: 30 })
    ok.assertStatus(200)
    assert.deepEqual(ok.body().data.settings, { minBucketSeconds: 30, maxPoints: 1500 })
    assert.deepEqual(await getChartSettings(), { minBucketSeconds: 30, maxPoints: 1500 })

    const tooFine = await client.patch(ENDPOINT).bearerToken(token).json({ minBucketSeconds: 1 })
    tooFine.assertStatus(422)
    const tooMany = await client.patch(ENDPOINT).bearerToken(token).json({ maxPoints: 5000 })
    tooMany.assertStatus(422)
    const fraction = await client.patch(ENDPOINT).bearerToken(token).json({ maxPoints: 150.5 })
    fraction.assertStatus(422)
    assert.deepEqual(await getChartSettings(), { minBucketSeconds: 30, maxPoints: 1500 })
  })

  test('a stored value out of range is clamped, garbage reads as the default', async ({
    assert,
  }) => {
    await SystemSetting.set(CHART_SETTING_KEY, { minBucketSeconds: 1, maxPoints: 'lots' })
    assert.deepEqual(await getChartSettings(), { minBucketSeconds: 5, maxPoints: 1500 })
  })
})
