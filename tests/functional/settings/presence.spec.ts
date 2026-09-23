import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import {
  PRESENCE_LIMITS,
  PRESENCE_SETTING_KEY,
  getPresenceSettings,
} from '#services/presence_settings'
import { PRESENCE_DEFAULTS } from '#services/wifi_presence'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/presence'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function seedSetupComplete(): Promise<User> {
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

  return admin
}

async function issueToken(user: User): Promise<string> {
  const token = await User.accessTokens.create(user)
  return token.value!.release()
}

test.group('presence settings API', (group) => {
  group.each.setup(resetDb)

  test('unauthenticated request is rejected with 401', async ({ client }) => {
    await seedSetupComplete()
    const response = await client.get(ENDPOINT)
    response.assertStatus(401)
  })

  test('non-admin request is rejected with 403', async ({ client }) => {
    await seedSetupComplete()
    const operator = await User.create({
      fullName: 'Operator',
      email: 'operator@example.com',
      password: 'operator-pass-123',
      role: 'operator',
    })
    const token = await issueToken(operator)

    const read = await client.get(ENDPOINT).bearerToken(token)
    read.assertStatus(403)
    read.assertBodyContains({ error: 'admin_required' })
    const write = await client.patch(ENDPOINT).bearerToken(token).json({ lanQuietMinutes: 5 })
    write.assertStatus(403)
  })

  test('returns the defaults, ranges and fixed idle limit when nothing is stored', async ({
    client,
    assert,
  }) => {
    const token = await issueToken(await seedSetupComplete())

    const response = await client.get(ENDPOINT).bearerToken(token)
    response.assertStatus(200)
    assert.deepEqual(response.body().data, {
      settings: {
        lanQuietMinutes: 30,
        wifiTrailingTrafficMinutes: 10,
        apStaleIntervals: 3,
        apStaleMinSeconds: 30,
        nowRateIntervals: 3,
      },
      defaults: PRESENCE_DEFAULTS,
      limits: PRESENCE_LIMITS,
      wifiIdleSeconds: 200,
    })
  })

  test('patch changes only the fields it sends and persists them', async ({ client, assert }) => {
    const token = await issueToken(await seedSetupComplete())

    const first = await client
      .patch(ENDPOINT)
      .bearerToken(token)
      .json({ lanQuietMinutes: 45, apStaleMinSeconds: 60 })
    first.assertStatus(200)
    assert.deepEqual(first.body().data.settings, {
      ...PRESENCE_DEFAULTS,
      lanQuietMinutes: 45,
      apStaleMinSeconds: 60,
    })

    const second = await client.patch(ENDPOINT).bearerToken(token).json({ nowRateIntervals: 5 })
    second.assertStatus(200)
    const expected = {
      ...PRESENCE_DEFAULTS,
      lanQuietMinutes: 45,
      apStaleMinSeconds: 60,
      nowRateIntervals: 5,
    }
    assert.deepEqual(second.body().data.settings, expected)

    const read = await client.get(ENDPOINT).bearerToken(token)
    assert.deepEqual(read.body().data.settings, expected)
    assert.deepEqual(await SystemSetting.get(PRESENCE_SETTING_KEY), expected)
  })

  test('values outside the range or not whole numbers are rejected with 422', async ({
    client,
    assert,
  }) => {
    const token = await issueToken(await seedSetupComplete())

    for (const body of [
      { lanQuietMinutes: 0 },
      { lanQuietMinutes: PRESENCE_LIMITS.lanQuietMinutes.max + 1 },
      { wifiTrailingTrafficMinutes: 2.5 },
      { apStaleIntervals: 1 },
      { apStaleMinSeconds: 'soon' },
      { nowRateIntervals: PRESENCE_LIMITS.nowRateIntervals.max + 1 },
    ]) {
      const response = await client.patch(ENDPOINT).bearerToken(token).json(body)
      response.assertStatus(422)
    }
    assert.deepEqual(await getPresenceSettings(), PRESENCE_DEFAULTS, 'nothing was stored')
  })
})
