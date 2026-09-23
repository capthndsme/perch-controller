import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { _resetQueryCache } from '#services/query_cache'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'

const MAC = 'aa:aa:aa:aa:aa:aa'
const LABEL_ENDPOINT = `/api/v1/devices/${MAC}/label`

async function resetDb() {
  // Both caches are module-level singletons that outlive a test: the label
  // map would otherwise carry a previous test's rows past the truncate.
  _resetQueryCache()
  resetDeviceLabelCacheForTesting()
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function bootstrap() {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const token = await User.accessTokens.create(admin)
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  const collector = await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: { ok: true, checkedAt: DateTime.utc().toISO()! },
  })

  return { admin, token: token.value!.release(), collector }
}

async function issueToken(user: User): Promise<string> {
  const token = await User.accessTokens.create(user)
  return token.value!.release()
}

async function seedTrafficAndIdentity(collectorId: number, mac: string, ip: string) {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  // Two seconds back: the read window is half-open on a second-truncated
  // `until`, so a bucket stamped in the current second would be excluded.
  const bucketStart = DateTime.utc().minus({ seconds: 2 }).toFormat('yyyy-MM-dd HH:mm:ss')
  await db.insertQuery().table('device_traffic_buckets').insert({
    collector_id: collectorId,
    mac,
    bucket_start: bucketStart,
    bytes_in: 5000,
    bytes_out: 2000,
    packets_in: 50,
    packets_out: 20,
    bytes_in_wan: 4000,
    bytes_out_wan: 1500,
    packets_in_wan: 40,
    packets_out_wan: 15,
    bytes_in_lan: 1000,
    bytes_out_lan: 500,
    packets_in_lan: 10,
    packets_out_lan: 5,
    created_at: now,
    updated_at: now,
  })

  await db
    .insertQuery()
    .table('device_identities')
    .insert({
      collector_id: collectorId,
      mac,
      primary_ip: ip,
      ips: JSON.stringify([ip]),
      first_seen_at: now,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    })
}

test.group('device labels API', (group) => {
  group.each.setup(resetDb)

  test('unauthenticated request is rejected with 401', async ({ client }) => {
    await bootstrap()
    const response = await client.patch(LABEL_ENDPOINT).json({ name: 'Nope' })
    response.assertStatus(401)
  })

  test('any signed-in user may label a device', async ({ client, assert }) => {
    await bootstrap()
    const operator = await User.create({
      fullName: 'Operator',
      email: 'operator@example.com',
      password: 'operator-pass-123',
      role: 'operator',
    })
    const token = await issueToken(operator)

    const response = await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({
        name: 'Living-room Apple TV',
        deviceType: 'tv',
        tags: ['Lounge', 'kids'],
        notes: 'Wired to the switch behind the console.',
      })

    response.assertStatus(200)
    assert.equal(response.body().data.label.name, 'Living-room Apple TV')
    assert.equal(response.body().data.label.deviceType, 'tv')
    assert.equal(response.body().data.label.updatedByUserId, operator.id)
  })

  test('tags are lowercased and deduplicated, MAC case is normalized', async ({
    client,
    assert,
  }) => {
    const { token } = await bootstrap()

    const response = await client
      .patch('/api/v1/devices/AA:AA:AA:AA:AA:AA/label')
      .bearerToken(token)
      .json({ name: 'Desk NAS', deviceType: 'nas', tags: ['Office', 'office', ' OFFICE ', 'nas'] })

    response.assertStatus(200)
    assert.equal(response.body().data.mac, MAC)
    assert.deepEqual(response.body().data.label.tags, ['office', 'nas'])

    const stored = await db.from('device_labels').select('mac').first()
    assert.equal(stored.mac, MAC)
  })

  test('rejects an unknown device type and a malformed MAC', async ({ client }) => {
    const { token } = await bootstrap()

    const badType = await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ deviceType: 'toaster' })
    badType.assertStatus(422)

    const badMac = await client
      .patch('/api/v1/devices/not-a-mac/label')
      .bearerToken(token)
      .json({ name: 'Nope' })
    badMac.assertStatus(400)
    badMac.assertBodyContains({ error: 'invalid_mac' })
  })

  test('patch merges: an omitted field is kept, an explicit null clears it', async ({
    client,
    assert,
  }) => {
    const { token } = await bootstrap()

    await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ name: 'Work laptop', deviceType: 'laptop', tags: ['office'], notes: 'Dock on desk' })

    const merged = await client.patch(LABEL_ENDPOINT).bearerToken(token).json({ notes: 'Docked' })
    merged.assertStatus(200)
    assert.equal(merged.body().data.label.name, 'Work laptop')
    assert.equal(merged.body().data.label.notes, 'Docked')
    assert.deepEqual(merged.body().data.label.tags, ['office'])

    const cleared = await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ name: null, deviceType: null, tags: [], notes: null })
    cleared.assertStatus(200)
    // Nothing left to store: the row is dropped rather than kept blank.
    assert.isNull(cleared.body().data.label)
    assert.lengthOf(await db.from('device_labels').select('mac'), 0)
  })

  test('listing returns stored labels, the tags in use and the type catalog', async ({
    client,
    assert,
  }) => {
    const { token } = await bootstrap()
    await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ name: 'Garage cam', deviceType: 'camera', tags: ['cameras', 'garage'] })
    await client
      .patch('/api/v1/devices/bb:bb:bb:bb:bb:bb/label')
      .bearerToken(token)
      .json({ name: 'Kitchen tablet', deviceType: 'tablet', tags: ['kitchen'] })

    const response = await client.get('/api/v1/devices/labels').bearerToken(token)
    response.assertStatus(200)
    const body = response.body().data

    assert.lengthOf(body.labels, 2)
    assert.deepEqual(body.tags, ['cameras', 'garage', 'kitchen'])
    assert.includeMembers(
      body.types.map((type: { id: string }) => type.id),
      ['phone', 'laptop', 'tv', 'iot', 'other']
    )
  })

  test('devices index and overview surface the label', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedTrafficAndIdentity(collector.id, MAC, '192.168.2.100')
    await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ name: 'Living-room Apple TV', deviceType: 'tv', tags: ['lounge'], notes: 'Wired' })

    const index = await client.get('/api/v1/devices?range=5m').bearerToken(token)
    index.assertStatus(200)
    const device = index.body().data.find((row: { mac: string }) => row.mac === MAC)
    assert.equal(device.customName, 'Living-room Apple TV')
    assert.equal(device.deviceType, 'tv')
    assert.deepEqual(device.tags, ['lounge'])
    assert.equal(device.notes, 'Wired')

    const overview = await client.get(`/api/v1/devices/${MAC}/overview?range=5m`).bearerToken(token)
    overview.assertStatus(200)
    assert.equal(overview.body().data.identity[0].customName, 'Living-room Apple TV')
    assert.equal(overview.body().data.identity[0].deviceType, 'tv')
  })

  test('the Ethernet mark is stored, merged and cleared like the other fields', async ({
    client,
    assert,
  }) => {
    const { token } = await bootstrap()

    // On its own it is a label worth keeping.
    const marked = await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ connection: 'ethernet' })
    marked.assertStatus(200)
    assert.equal(marked.body().data.label.connection, 'ethernet')
    assert.lengthOf(await db.from('device_labels').select('mac'), 1)

    const named = await client.patch(LABEL_ENDPOINT).bearerToken(token).json({ name: 'Desk NAS' })
    assert.equal(named.body().data.label.connection, 'ethernet', 'an omitted mark is kept')

    const unmarked = await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ connection: null })
    unmarked.assertStatus(200)
    assert.isNull(unmarked.body().data.label.connection)
    assert.equal(unmarked.body().data.label.name, 'Desk NAS')

    const unknown = await client
      .patch(LABEL_ENDPOINT)
      .bearerToken(token)
      .json({ connection: 'bluetooth' })
    unknown.assertStatus(422)
  })

  test('a device marked Ethernet reads Ethernet, not Wired / unknown', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedTrafficAndIdentity(collector.id, MAC, '192.168.2.100')
    type Row = { mac: string; connection: string | null; presence: { via: string } }
    const listed = async () => {
      const index = await client.get('/api/v1/devices?range=5m').bearerToken(token)
      index.assertStatus(200)
      return (index.body().data as Row[]).find((row) => row.mac === MAC)!
    }

    const before = await listed()
    assert.isNull(before.connection)
    assert.equal(before.presence.via, 'lan')

    await client.patch(LABEL_ENDPOINT).bearerToken(token).json({ connection: 'ethernet' })

    // Labels and presence are read per request: no wait for the list's cache.
    const after = await listed()
    assert.equal(after.connection, 'ethernet')
    assert.containsSubset(after.presence, { status: 'connected', via: 'ethernet' })
    const presence = await client.get(`/api/v1/devices/${MAC}/presence`).bearerToken(token)
    assert.containsSubset(presence.body().data, { status: 'connected', via: 'ethernet' })
    const overview = await client.get(`/api/v1/devices/${MAC}/overview?range=5m`).bearerToken(token)
    assert.equal(overview.body().data.identity[0].connection, 'ethernet')
  })

  test('delete removes the label and the device reads unnamed again', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedTrafficAndIdentity(collector.id, MAC, '192.168.2.100')
    await client.patch(LABEL_ENDPOINT).bearerToken(token).json({ name: 'Temporary' })

    const destroyed = await client.delete(LABEL_ENDPOINT).bearerToken(token)
    destroyed.assertStatus(204)

    const show = await client.get(LABEL_ENDPOINT).bearerToken(token)
    show.assertStatus(200)
    assert.isNull(show.body().data.label)

    _resetQueryCache()
    const index = await client.get('/api/v1/devices?range=5m').bearerToken(token)
    const device = index.body().data.find((row: { mac: string }) => row.mac === MAC)
    assert.isNull(device.customName)
    assert.deepEqual(device.tags, [])
  })
})
