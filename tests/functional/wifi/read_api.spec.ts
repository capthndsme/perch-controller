import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { recomputeClientDistribution } from '#services/client_distribution_rollup'
import { rebuildWifiLatestTables } from '#services/wifi_bucket_writer'
import {
  resetHostnameEnrichmentCacheForTesting,
  setHostnameCommandRunnerForTesting,
} from '#services/hostname_enrichment'
import {
  HOSTNAME_ENRICHMENT_MODE,
  setHostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

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

  const now = DateTime.utc().startOf('minute')
  const nowSql = now.toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('wifi_access_points')
    .insert({
      name: 'living-room-ap',
      friendly_name: 'Living Room AP',
      metrics_url: 'http://192.168.1.17:9100/metrics',
      poll_interval_seconds: 15,
      enabled: 1,
      enable_two_way_commands: 0,
      ssh_host: null,
      ssh_port: 22,
      ssh_username: null,
      ssh_private_key: null,
      model: 'OpenWrt One',
      openwrt_release: '24.10.0',
      nodename: 'ap-living-room',
      last_seen_at: nowSql,
      last_status: JSON.stringify({ ok: true, checkedAt: now.toISO() }),
      created_at: nowSql,
      updated_at: nowSql,
    })
  const ap = await db.from('wifi_access_points').where('name', 'living-room-ap').firstOrFail()

  const older = now.minus({ minutes: 10 }).toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('wifi_network_snapshots')
    .multiInsert([
      {
        ap_id: ap.id,
        ifname: 'phy1-ap0',
        ssid: 'Home',
        bssid: 'aa:bb:cc:dd:ee:ff',
        radio: 'radio0',
        channel: 36,
        frequency_mhz: 5180,
        band: '5',
        quality: 70,
        signal_dbm: -55,
        noise_dbm: -95,
        bitrate_kbps: 866700,
        recorded_at: older,
      },
      {
        ap_id: ap.id,
        ifname: 'phy1-ap0',
        ssid: 'Home',
        bssid: 'aa:bb:cc:dd:ee:ff',
        radio: 'radio0',
        channel: 36,
        frequency_mhz: 5180,
        band: '5',
        quality: 72,
        signal_dbm: -54,
        noise_dbm: -94,
        bitrate_kbps: 866700,
        recorded_at: nowSql,
      },
    ])

  await db
    .insertQuery()
    .table('wifi_station_snapshots')
    .multiInsert([
      {
        ap_id: ap.id,
        mac: 'aa:bb:cc:dd:ee:ff',
        ifname: 'phy1-ap0',
        ssid: 'Home',
        radio: 'radio0',
        channel: 36,
        frequency_mhz: 5180,
        band: '5',
        signal_dbm: -58,
        snr_db: 36,
        tx_rate_kbps: 12000,
        rx_rate_kbps: 8000,
        expected_throughput_kbps: 15000,
        inactive_ms: 500,
        tx_bytes: 10000,
        rx_bytes: 20000,
        tx_packets: 100,
        rx_packets: 200,
        recorded_at: nowSql,
      },
      {
        ap_id: ap.id,
        mac: 'bb:cc:dd:ee:ff:00',
        ifname: 'phy1-ap0',
        ssid: 'Home',
        radio: 'radio0',
        channel: 36,
        frequency_mhz: 5180,
        band: '5',
        signal_dbm: -66,
        snr_db: 28,
        tx_rate_kbps: 6000,
        rx_rate_kbps: 4000,
        expected_throughput_kbps: 10000,
        inactive_ms: 1000,
        tx_bytes: 6000,
        rx_bytes: 9000,
        tx_packets: 60,
        rx_packets: 90,
        recorded_at: nowSql,
      },
    ])

  await db
    .insertQuery()
    .table('wifi_interface_buckets')
    .multiInsert([
      {
        ap_id: ap.id,
        ifname: 'phy1-ap0',
        ssid: 'Home',
        radio: 'radio0',
        band: '5',
        bucket_start: older,
        bytes_in: 1000,
        bytes_out: 800,
        packets_in: 10,
        packets_out: 8,
        errs_in: 0,
        errs_out: 0,
        drops_in: 0,
        drops_out: 0,
        created_at: nowSql,
        updated_at: nowSql,
      },
      {
        ap_id: ap.id,
        ifname: 'phy1-ap0',
        ssid: 'Home',
        radio: 'radio0',
        band: '5',
        bucket_start: nowSql,
        bytes_in: 3000,
        bytes_out: 2500,
        packets_in: 30,
        packets_out: 25,
        errs_in: 0,
        errs_out: 0,
        drops_in: 0,
        drops_out: 0,
        created_at: nowSql,
        updated_at: nowSql,
      },
    ])

  await db
    .insertQuery()
    .table('ap_system_snapshots')
    .multiInsert([
      {
        ap_id: ap.id,
        load_1: 0.2,
        load_5: 0.3,
        load_15: 0.4,
        mem_total: 256000000,
        mem_available: 128000000,
        conntrack_entries: 120,
        conntrack_limit: 4096,
        uptime_seconds: 3600,
        recorded_at: older,
      },
      {
        ap_id: ap.id,
        load_1: 0.25,
        load_5: 0.28,
        load_15: 0.35,
        mem_total: 256000000,
        mem_available: 120000000,
        conntrack_entries: 130,
        conntrack_limit: 4096,
        uptime_seconds: 4200,
        recorded_at: nowSql,
      },
    ])

  await db.insertQuery().table('wifi_roaming_events').insert({
    mac: 'aa:bb:cc:dd:ee:ff',
    from_ap_id: null,
    to_ap_id: ap.id,
    from_ifname: null,
    to_ifname: 'phy1-ap0',
    from_ssid: null,
    to_ssid: 'Home',
    from_band: null,
    to_band: '5',
    event_type: 'ap_roam',
    detected_at: nowSql,
  })

  // The clients/history endpoint reads the client-distribution rollup for
  // 1m–1h resolutions; populate it from the seeded snapshots the same way the
  // scheduled recompute task would.
  await recomputeClientDistribution({
    since: now.minus({ hours: 1 }),
    until: now.plus({ minutes: 5 }),
  })
  // The overview/clients/rf endpoints read the poller-maintained "latest"
  // tables; derive them from the seeded snapshots the way the migration does.
  await rebuildWifiLatestTables()

  const adminToken = await User.accessTokens.create(admin)
  const operatorToken = await User.accessTokens.create(operator)
  return {
    adminToken: adminToken.value!.release(),
    operatorToken: operatorToken.value!.release(),
    apId: Number(ap.id),
  }
}

test.group('wifi read API', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    resetHostnameEnrichmentCacheForTesting()
    setHostnameCommandRunnerForTesting(async (_settings, command) => {
      if (command[0] === 'cat') {
        return '1716649000 aa:bb:cc:dd:ee:ff 192.168.2.100 dynamic-name *\n'
      }
      if (command[0] === 'uci') {
        return `
dhcp.kitchen=host
dhcp.kitchen.name='Kitchen-Tablet'
dhcp.kitchen.mac='aa:bb:cc:dd:ee:ff'
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

  test('overview + ssid throughput endpoints return expected shape', async ({ client, assert }) => {
    const { adminToken } = await bootstrap()
    const overview = await client.get('/api/v1/wifi/overview?range=24h').bearerToken(adminToken)
    overview.assertStatus(200)
    assert.equal(overview.body().data.totalClients, 2)
    assert.equal(overview.body().data.ssidCount, 1)
    assert.equal(overview.body().data.ssids[0].ssid, 'Home')
    assert.equal(overview.body().data.peakClientsToday, 2)
    assert.equal(overview.body().data.peakClients7d, 2)
    assert.equal(overview.body().data.peakClientsAllTime, 2)

    const history = await client
      .get('/api/v1/wifi/clients/history?range=24h&resolution=5m')
      .bearerToken(adminToken)
    history.assertStatus(200)
    assert.isArray(history.body().data.buckets)
    assert.isArray(history.body().data.allBands)
    assert.isArray(history.body().data.allAps)
    assert.isAtLeast(history.body().data.buckets.length, 1)
    assert.deepEqual(history.body().data.allBands, ['5'])

    const throughput = await client
      .get('/api/v1/wifi/ssids/Home/throughput?range=24h&resolution=1m')
      .bearerToken(adminToken)
    throughput.assertStatus(200)
    assert.equal(throughput.body().data.ssid, 'Home')
    assert.isAtLeast(throughput.body().data.buckets.length, 1)
    assert.isNumber(throughput.body().data.buckets[0].mbpsIn)
  })

  test('clients endpoint includes hostname enrichment labels when enabled', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await bootstrap()
    await setHostnameEnrichmentSettings({
      enabled: true,
      mode: HOSTNAME_ENRICHMENT_MODE,
      transport: 'lxc',
      leaseFilePath: '/tmp/dhcp.leases',
      refreshSeconds: 60,
      timeoutMs: 1500,
      lxc: { containerName: 'openwrt' },
    })

    const clients = await client.get('/api/v1/wifi/clients?activeOnly=true').bearerToken(adminToken)
    clients.assertStatus(200)
    // The serializer passes plain arrays through unwrapped (transformer
    // collections get the `data` envelope); accept both shapes.
    const payload = clients.body()
    const rows = (Array.isArray(payload) ? payload : payload.data) as Array<{
      mac: string
      hostname: string | null
      hostnameSource: string | null
    }>
    const target = rows.find((row) => row.mac === 'aa:bb:cc:dd:ee:ff')
    assert.isDefined(target)
    assert.equal(target?.hostname, 'Kitchen-Tablet')
    assert.equal(target?.hostnameSource, 'openwrt_static')
  })

  test('client signal + ap health endpoints return historical buckets', async ({
    client,
    assert,
  }) => {
    const { adminToken, apId } = await bootstrap()
    const signal = await client
      .get('/api/v1/wifi/clients/aa:bb:cc:dd:ee:ff/signal?range=24h&resolution=1m')
      .bearerToken(adminToken)
    signal.assertStatus(200)
    assert.equal(signal.body().data.mac, 'aa:bb:cc:dd:ee:ff')
    assert.isAtLeast(signal.body().data.buckets.length, 1)

    const health = await client
      .get(`/api/v1/wifi/aps/${apId}/health?range=24h&resolution=1m`)
      .bearerToken(adminToken)
    health.assertStatus(200)
    assert.equal(health.body().data.ap.id, apId)
    assert.isAtLeast(health.body().data.buckets.length, 1)
  })

  test('command endpoints are admin-only and respect two-way enable flag', async ({ client }) => {
    const { adminToken, operatorToken, apId } = await bootstrap()

    const forbidden = await client
      .post('/api/v1/wifi/clients/aa:bb:cc:dd:ee:ff/kick')
      .bearerToken(operatorToken)
    forbidden.assertStatus(403)

    const disabled = await client.post(`/api/v1/wifi/aps/${apId}/reboot`).bearerToken(adminToken)
    disabled.assertStatus(400)
    disabled.assertBodyContains({ error: 'wifi_commands_not_enabled' })
  })
})
