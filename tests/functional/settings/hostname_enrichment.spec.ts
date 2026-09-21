import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import {
  HOSTNAME_ENRICHMENT_MODE,
  HOSTNAME_ENRICHMENT_SETTING_KEY,
  defaultHostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/hostname-enrichment'

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

test.group('hostname enrichment settings API', (group) => {
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

    const response = await client.get(ENDPOINT).bearerToken(token)
    response.assertStatus(403)
    response.assertBodyContains({ error: 'admin_required' })
  })

  test('returns defaults when no hostname settings are stored', async ({ client, assert }) => {
    const admin = await seedSetupComplete()
    const token = await issueToken(admin)

    const response = await client.get(ENDPOINT).bearerToken(token)
    response.assertStatus(200)
    assert.deepEqual(response.body().data, defaultHostnameEnrichmentSettings())
  })

  test('patch persists and round-trips structured ssh config', async ({ client, assert }) => {
    const admin = await seedSetupComplete()
    const token = await issueToken(admin)

    const payload = {
      enabled: true,
      mode: HOSTNAME_ENRICHMENT_MODE,
      transport: 'ssh' as const,
      leaseFilePath: '/tmp/dhcp.leases',
      refreshSeconds: 45,
      timeoutMs: 3000,
      ssh: {
        host: '192.168.0.1',
        port: 22,
        username: 'root',
        privateKeyPath: '/root/.ssh/id_ed25519',
      },
    }

    const patchResponse = await client.patch(ENDPOINT).bearerToken(token).json(payload)
    patchResponse.assertStatus(200)
    assert.deepEqual(patchResponse.body().data, payload)
    assert.deepEqual(await SystemSetting.get(HOSTNAME_ENRICHMENT_SETTING_KEY), payload)

    const getResponse = await client.get(ENDPOINT).bearerToken(token)
    getResponse.assertStatus(200)
    assert.deepEqual(getResponse.body().data, payload)
  })

  test('validation fails when transport-specific object is missing', async ({ client, assert }) => {
    const admin = await seedSetupComplete()
    const token = await issueToken(admin)

    const response = await client.patch(ENDPOINT).bearerToken(token).json({
      enabled: true,
      mode: HOSTNAME_ENRICHMENT_MODE,
      transport: 'lxc',
      leaseFilePath: '/tmp/dhcp.leases',
      refreshSeconds: 30,
      timeoutMs: 2000,
    })

    response.assertStatus(422)
    const errors = (response.body() as unknown as { errors: Array<{ field?: string }> }).errors
    assert.isTrue(errors.some((error) => error.field === 'lxc'))
  })

  test('validation fails on out-of-range refresh and timeout values', async ({
    client,
    assert,
  }) => {
    const admin = await seedSetupComplete()
    const token = await issueToken(admin)

    const response = await client
      .patch(ENDPOINT)
      .bearerToken(token)
      .json({
        enabled: true,
        mode: HOSTNAME_ENRICHMENT_MODE,
        transport: 'lxc',
        leaseFilePath: '/tmp/dhcp.leases',
        refreshSeconds: 2,
        timeoutMs: 200,
        lxc: {
          containerName: 'openwrt',
        },
      })

    response.assertStatus(422)
    const errors = (response.body() as unknown as { errors: Array<{ field?: string }> }).errors
    assert.isTrue(errors.some((error) => error.field === 'refreshSeconds'))
    assert.isTrue(errors.some((error) => error.field === 'timeoutMs'))
  })
})
