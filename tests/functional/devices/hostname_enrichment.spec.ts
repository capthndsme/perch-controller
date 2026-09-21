import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import {
  resetHostnameEnrichmentCacheForTesting,
  setHostnameCommandRunnerForTesting,
} from '#services/hostname_enrichment'
import {
  HOSTNAME_ENRICHMENT_MODE,
  setHostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'

async function resetDb() {
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

  return { token: token.value!.release(), collector }
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

test.group('devices read API | hostname enrichment wiring', (group) => {
  group.each.setup(resetDb)

  group.each.setup(() => {
    resetHostnameEnrichmentCacheForTesting()
    setHostnameCommandRunnerForTesting(async (_settings, command) => {
      if (command[0] === 'cat') {
        return '1716649000 aa:aa:aa:aa:aa:aa 192.168.2.100 dynamic-name *\n'
      }
      if (command[0] === 'uci') {
        return `
dhcp.kitchen=host
dhcp.kitchen.name='Kitchen-Tablet'
dhcp.kitchen.mac='aa:aa:aa:aa:aa:aa'
dhcp.kitchen.ip='192.168.2.100'
`
      }
      return ''
    })

    return () => {
      resetHostnameEnrichmentCacheForTesting()
      setHostnameCommandRunnerForTesting(null)
    }
  })

  test('surfaces hostname on /devices and /devices/:mac/overview when enabled', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedTrafficAndIdentity(collector.id, 'aa:aa:aa:aa:aa:aa', '192.168.2.100')
    await setHostnameEnrichmentSettings({
      enabled: true,
      mode: HOSTNAME_ENRICHMENT_MODE,
      transport: 'lxc',
      leaseFilePath: '/tmp/dhcp.leases',
      refreshSeconds: 60,
      timeoutMs: 1500,
      lxc: { containerName: 'openwrt' },
    })

    const devices = await client.get('/api/v1/devices').bearerToken(token)
    devices.assertStatus(200)
    assert.equal(devices.body().data[0].hostname, 'Kitchen-Tablet')
    assert.equal(devices.body().data[0].hostnameSource, 'openwrt_static')

    const overview = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/overview?range=2m&resolution=1m')
      .bearerToken(token)
    overview.assertStatus(200)
    assert.equal(overview.body().data.identity[0].hostname, 'Kitchen-Tablet')
    assert.equal(overview.body().data.identity[0].hostnameSource, 'openwrt_static')
  })
})
