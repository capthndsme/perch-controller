import SystemSetting from '#models/system_setting'
import { getQosSettings, QOS_DEFAULTS, QOS_LIMITS, QOS_SETTING_KEY } from '#services/qos_settings'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/qos'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

test.group('qos settings API', (group) => {
  group.each.setup(resetDb)

  test('anonymous 401, operators 403 (settings are admin-only)', async ({ client }) => {
    const { operatorToken } = await seedSetupComplete()
    const anonymous = await client.get(ENDPOINT)
    anonymous.assertStatus(401)
    const read = await client.get(ENDPOINT).bearerToken(operatorToken)
    read.assertStatus(403)
    read.assertBodyContains({ error: 'admin_required' })
    const write = await client.patch(ENDPOINT).bearerToken(operatorToken).json({ leafFlows: 32 })
    write.assertStatus(403)
    const anonymousWrite = await client.patch(ENDPOINT).json({ leafFlows: 32 })
    anonymousWrite.assertStatus(401)
  })

  test('defaults and ranges when nothing is stored', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const response = await client.get(ENDPOINT).bearerToken(adminToken)
    response.assertStatus(200)
    assert.deepEqual(response.body().data, {
      settings: { ...QOS_DEFAULTS },
      defaults: { ...QOS_DEFAULTS },
      limits: JSON.parse(JSON.stringify(QOS_LIMITS)),
    })
    assert.equal(QOS_DEFAULTS.maxBucketDepth, 4)
    assert.equal(QOS_LIMITS.maxBucketDepth.max, 4)
  })

  test('a subset is saved; the rest keeps its value', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const first = await client
      .patch(ENDPOINT)
      .bearerToken(adminToken)
      .json({ minWanKbit: 2000, maxBucketDepth: 2 })
    first.assertStatus(200)
    assert.containsSubset(first.body().data.settings, {
      minWanKbit: 2000,
      maxBucketDepth: 2,
      leafFlows: QOS_DEFAULTS.leafFlows,
    })
    const second = await client.patch(ENDPOINT).bearerToken(adminToken).json({ leafMemoryKb: 512 })
    assert.containsSubset(second.body().data.settings, {
      minWanKbit: 2000,
      maxBucketDepth: 2,
      leafMemoryKb: 512,
    })
    const stored = await getQosSettings()
    assert.equal(stored.minWanKbit, 2000)
  })

  test('out of range and fractional values are refused', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    for (const body of [
      { maxBucketDepth: 5 },
      { minWanKbit: 10 },
      { leafFlows: 64.5 },
      { quotaPersistSeconds: 'soon' },
    ]) {
      const response = await client.patch(ENDPOINT).bearerToken(adminToken).json(body)
      response.assertStatus(422)
    }
    assert.deepEqual(await getQosSettings(), QOS_DEFAULTS)
  })

  test("a stored value outside today's range is clamped, junk reads as the default", async ({
    assert,
  }) => {
    await SystemSetting.set(QOS_SETTING_KEY, {
      maxBucketDepth: 6,
      leafFlows: 'many',
      minWanKbit: 5000,
    })
    const settings = await getQosSettings()
    assert.equal(settings.maxBucketDepth, 4)
    assert.equal(settings.leafFlows, QOS_DEFAULTS.leafFlows)
    assert.equal(settings.minWanKbit, 5000)
  })
})
