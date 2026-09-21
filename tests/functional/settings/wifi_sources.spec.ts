import Collector from '#models/collector'
import User from '#models/user'
import SystemSetting from '#models/system_setting'
import WifiAccessPoint from '#models/wifi_access_point'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/wifi-sources'

const PROBE_METRICS = `
# HELP node_openwrt_info OpenWrt release metadata.
# TYPE node_openwrt_info gauge
node_openwrt_info{model="OpenWrt One",release="24.10.0"} 1
# HELP node_uname_info Linux uname metadata.
# TYPE node_uname_info gauge
node_uname_info{nodename="ap-living-room"} 1
`

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

function mockFetch() {
  const original = globalThis.fetch
  let impl: typeof fetch = original
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => impl(...args)) as typeof fetch
  return {
    set: (next: typeof fetch) => {
      impl = next
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

async function seedSetupComplete(): Promise<{ adminToken: string; operatorToken: string }> {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const operator = await User.create({
    fullName: 'Operator',
    email: 'operator@example.com',
    password: 'operator-pass-123',
    role: 'operator',
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

  const adminToken = await User.accessTokens.create(admin)
  const operatorToken = await User.accessTokens.create(operator)

  return {
    adminToken: adminToken.value!.release(),
    operatorToken: operatorToken.value!.release(),
  }
}

test.group('wifi source settings API', (group) => {
  let fetchMock: ReturnType<typeof mockFetch>

  group.each.setup(resetDb)
  group.each.setup(() => {
    fetchMock = mockFetch()
    return () => fetchMock.restore()
  })

  test('admin can create/list/probe/update/delete wifi source', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(async () => new Response(PROBE_METRICS, { status: 200 }))

    const createResponse = await client.post(ENDPOINT).bearerToken(adminToken).json({
      name: 'living-room',
      friendlyName: 'Living Room AP',
      metricsUrl: 'http://192.168.1.17:9100/metrics',
      pollIntervalSeconds: 15,
      enabled: true,
      enableTwoWayCommands: true,
      sshHost: '192.168.1.17',
      sshPort: 22,
      sshUsername: 'root',
      sshPrivateKey: '/home/app/.ssh/openwrt',
    })

    createResponse.assertStatus(200)
    const createData = createResponse.body().data as {
      source: { id: number; model: string | null }
      probe: { ok: boolean }
    }
    assert.equal(createData.probe.ok, true)
    assert.equal(createData.source.model, 'OpenWrt One')
    const sourceId = createData.source.id

    const listResponse = await client.get(ENDPOINT).bearerToken(adminToken)
    listResponse.assertStatus(200)
    const listData = listResponse.body().data as Array<{ id: number }>
    assert.lengthOf(listData, 1)
    assert.equal(listData[0].id, sourceId)

    const probeResponse = await client.post(`${ENDPOINT}/${sourceId}/probe`).bearerToken(adminToken)
    probeResponse.assertStatus(200)
    assert.equal(probeResponse.body().data.probe.ok, true)

    const updateResponse = await client
      .put(`${ENDPOINT}/${sourceId}`)
      .bearerToken(adminToken)
      .json({
        pollIntervalSeconds: 60,
        enabled: false,
      })
    updateResponse.assertStatus(200)
    assert.equal(updateResponse.body().data.source.pollIntervalSeconds, 60)
    assert.equal(updateResponse.body().data.source.enabled, false)

    const deleteResponse = await client.delete(`${ENDPOINT}/${sourceId}`).bearerToken(adminToken)
    deleteResponse.assertStatus(204)
    assert.lengthOf(await WifiAccessPoint.query(), 0)
  })

  test('admin can probe unsaved wifi source and receive a suggested name', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(async () => new Response(PROBE_METRICS, { status: 200 }))

    const response = await client.post(`${ENDPOINT}/probe`).bearerToken(adminToken).json({
      metricsUrl: 'http://192.168.1.17:9100/metrics',
    })

    response.assertStatus(200)
    const data = response.body().data as {
      probe: { ok: boolean; nodename?: string }
      suggestedName: string | null
    }
    assert.equal(data.probe.ok, true)
    assert.equal(data.probe.nodename, 'ap-living-room')
    assert.equal(data.suggestedName, 'ap-living-room')
  })

  test('non-admin callers receive 403', async ({ client }) => {
    const { operatorToken } = await seedSetupComplete()
    const response = await client.get(ENDPOINT).bearerToken(operatorToken)
    response.assertStatus(403)
    response.assertBodyContains({ error: 'admin_required' })
  })

  test('unauthenticated callers receive 401', async ({ client }) => {
    await seedSetupComplete()
    const response = await client.get(ENDPOINT)
    response.assertStatus(401)
  })
})
