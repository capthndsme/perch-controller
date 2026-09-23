import SystemSetting from '#models/system_setting'
import User from '#models/user'
import WifiAccessPoint from '#models/wifi_access_point'
import { _resetQueryCache } from '#services/query_cache'
import { deferCollectors } from '#services/setup_state'
import { _resetWifiPollerState, ingestWifiMetrics } from '#services/wifi_metrics_poller'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
  _resetWifiPollerState()
  return teardown
}

async function signIn(): Promise<string> {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  // Wi-Fi only: setup finished with "skip for now" in the collector step.
  await deferCollectors()
  const token = await User.accessTokens.create(admin)
  return token.value!.release()
}

async function makeAp(name: string, pollIntervalSeconds: number) {
  return WifiAccessPoint.create({
    name,
    friendlyName: name,
    metricsUrl: `http://${name}.test:9100/metrics`,
    pollIntervalSeconds,
    enabled: true,
    enableTwoWayCommands: false,
    sshHost: null,
    sshPort: 22,
    sshUsername: null,
    sshPrivateKey: null,
    model: null,
    openwrtRelease: null,
    nodename: null,
    lastStatus: null,
    lastSeenAt: null,
  })
}

const fmt = (at: DateTime) => at.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

/** A `wifi_station_latest` row as the last report that listed the MAC left it. */
async function latest(
  apId: number,
  mac: string,
  row: { ssid: string; ifname: string; signalDbm: number; inactiveMs: number; ageSeconds: number }
) {
  await db.table('wifi_station_latest').insert({
    mac,
    ap_id: apId,
    ifname: row.ifname,
    ssid: row.ssid,
    radio: row.ifname.startsWith('phy1') ? 'radio1' : 'radio0',
    band: row.ifname.startsWith('phy1') ? '5' : '2.4',
    signal_dbm: row.signalDbm,
    inactive_ms: row.inactiveMs,
    recorded_at: fmt(DateTime.utc().minus({ seconds: row.ageSeconds })),
  })
}

async function network(apId: number, ifname: string, ssid: string) {
  await db.table('wifi_network_latest').insert({
    ap_id: apId,
    ifname,
    ssid,
    bssid: '02:00:00:00:ff:01',
    radio: ifname.startsWith('phy1') ? 'radio1' : 'radio0',
    band: ifname.startsWith('phy1') ? '5' : '2.4',
    recorded_at: fmt(DateTime.utc()),
  })
}

function exposition(stations: Array<{ mac: string; inactiveMs: number }>): string {
  const net =
    'ifname="phy1-ap0",ssid="Home",bssid="02:00:00:00:ff:01",channel="36",device="phy1-ap0",frequency="5180"'
  return [
    `wifi_network_quality{${net}} 70`,
    `wifi_network_noise_dbm{${net}} -95`,
    ...stations.flatMap((s) => [
      `wifi_station_signal_dbm{mac="${s.mac}",ifname="phy1-ap0"} -55`,
      `wifi_station_inactive_milliseconds{mac="${s.mac}",ifname="phy1-ap0"} ${s.inactiveMs}`,
    ]),
    'node_boot_time_seconds 1700000000',
    '',
  ].join('\n')
}

const macs = (rows: Array<{ mac: string }>) => rows.map((row) => row.mac).sort()
/** Plain arrays come back unwrapped (transformer collections get `data`). */
const rowsOf = <T>(body: unknown) =>
  (Array.isArray(body) ? body : (body as { data: T[] }).data) as T[]
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/**
 * `wifi_station_latest` keeps every MAC seen during the snapshot retention.
 * Only the stations their AP still lists, and that are not idle for 200 s or
 * more, are clients right now; every count and list of current clients has to
 * agree on that (the dashboard showed 34 now, a peak of 23 and 77 by SSID).
 */
test.group('wifi | connected clients', (group) => {
  group.each.setup(resetDb)

  test('counts, lists and breakdowns only include connected stations', async ({
    client,
    assert,
  }) => {
    const token = await signIn()
    const hall = await makeAp('hall', 5) // stale after 30 s
    const garage = await makeAp('garage', 60) // stale after 180 s
    await network(hall.id, 'phy1-ap0', 'Home')
    await network(hall.id, 'phy0-ap0', 'Guest')
    await network(garage.id, 'phy1-ap0', 'Guest')

    // Listed in the last report, active.
    await latest(hall.id, '02:00:00:00:00:01', {
      ssid: 'Home',
      ifname: 'phy1-ap0',
      signalDbm: -48,
      inactiveMs: 1_000,
      ageSeconds: 2,
    })
    // Listed, idle for a minute (a sleeping phone): still connected.
    await latest(hall.id, '02:00:00:00:00:02', {
      ssid: 'Home',
      ifname: 'phy1-ap0',
      signalDbm: -65,
      inactiveMs: 60_000,
      ageSeconds: 2,
    })
    // Listed, but idle past 200 s: on its way out, not counted (as in the history).
    await latest(hall.id, '02:00:00:00:00:03', {
      ssid: 'Home',
      ifname: 'phy1-ap0',
      signalDbm: -80,
      inactiveMs: 250_000,
      ageSeconds: 2,
    })
    // Left 10 minutes ago: its row still says "active 0.5 s ago".
    await latest(hall.id, '02:00:00:00:00:04', {
      ssid: 'Home',
      ifname: 'phy1-ap0',
      signalDbm: -85,
      inactiveMs: 500,
      ageSeconds: 600,
    })
    // Left three days ago.
    await latest(hall.id, '02:00:00:00:00:05', {
      ssid: 'Guest',
      ifname: 'phy0-ap0',
      signalDbm: -88,
      inactiveMs: 1_000,
      ageSeconds: 3 * 86_400,
    })
    // Last report 100 s ago, but this AP reports every 60 s: still connected.
    await latest(garage.id, '02:00:00:00:00:06', {
      ssid: 'Guest',
      ifname: 'phy1-ap0',
      signalDbm: -72,
      inactiveMs: 2_000,
      ageSeconds: 100,
    })
    const connected = ['02:00:00:00:00:01', '02:00:00:00:00:02', '02:00:00:00:00:06']

    const overview = await client.get('/api/v1/wifi/overview?range=24h').bearerToken(token)
    overview.assertStatus(200)
    const data = overview.body().data
    assert.equal(data.totalClients, 3)
    const bySsid = Object.fromEntries(
      data.ssids.map((s: { ssid: string; clientCount: number; accessPoints: string[] }) => [
        s.ssid,
        s,
      ])
    )
    assert.equal(bySsid.Home.clientCount, 2)
    assert.equal(bySsid.Guest.clientCount, 1)
    assert.deepEqual(bySsid.Guest.accessPoints, ['garage'], 'not the hall AP the ghost was on')
    assert.equal(sum(data.ssids.map((s: { clientCount: number }) => s.clientCount)), 3)
    assert.equal(sum(Object.values(data.signalDistribution) as number[]), 3)
    assert.equal(data.signalDistribution.excellent, 1)
    assert.equal(data.signalDistribution.veryWeak, 0, 'the far-away ghosts are gone')
    const byAp = Object.fromEntries(
      data.accessPoints.map((ap: { name: string; clientCount: number }) => [
        ap.name,
        ap.clientCount,
      ])
    )
    assert.deepEqual(byAp, { garage: 1, hall: 2 })
    // No rollup yet: a window that ends now peaks at no less than the count now.
    assert.equal(data.peakClientsToday, 3)
    assert.equal(data.peakClients7d, 3)
    assert.equal(data.peakClientsAllTime, 3)

    const active = await client.get('/api/v1/wifi/clients?activeOnly=true').bearerToken(token)
    active.assertStatus(200)
    const activeRows = rowsOf<{ mac: string; active: boolean }>(active.body())
    assert.deepEqual(macs(activeRows), connected)
    assert.isTrue(activeRows.every((row) => row.active))

    // Without the filter: the last known state of every MAC, flagged.
    const all = await client.get('/api/v1/wifi/clients').bearerToken(token)
    all.assertStatus(200)
    const allRows = rowsOf<{ mac: string; active: boolean }>(all.body())
    assert.lengthOf(allRows, 6)
    assert.deepEqual(macs(allRows.filter((row) => row.active)), connected)

    const home = await client.get('/api/v1/wifi/ssids/Home/clients').bearerToken(token)
    home.assertStatus(200)
    assert.equal(home.body().data.clientCount, 2)
    assert.deepEqual(macs(home.body().data.clients), ['02:00:00:00:00:01', '02:00:00:00:00:02'])

    const ssids = await client.get('/api/v1/wifi/ssids?range=1h').bearerToken(token)
    ssids.assertStatus(200)
    assert.equal(sum(ssids.body().data.ssids.map((s: { clientCount: number }) => s.clientCount)), 3)

    const rf = await client.get('/api/v1/wifi/rf').bearerToken(token)
    rf.assertStatus(200)
    const rfRows = rowsOf<{ ap: string; ifname: string; clientCount: number }>(rf.body())
    const rfCount = Object.fromEntries(rfRows.map((r) => [`${r.ap}/${r.ifname}`, r.clientCount]))
    assert.deepEqual(rfCount, { 'hall/phy1-ap0': 2, 'hall/phy0-ap0': 0, 'garage/phy1-ap0': 1 })

    // The client page still gets the last known state of a client that left.
    const gone = await client.get('/api/v1/wifi/clients/02:00:00:00:00:04').bearerToken(token)
    gone.assertStatus(200)
    assert.equal(gone.body().data.latest.ap, 'hall')
    assert.isFalse(gone.body().data.latest.active)
    // When the AP last heard from it: its last listing, 10 minutes ago.
    const lastSeen = Date.parse(gone.body().data.latest.lastSeenAt)
    assert.approximately(lastSeen, Date.now() - 600_000, 30_000)
  })

  test('Settings → Presence sets how long a silent AP keeps its clients', async ({
    client,
    assert,
  }) => {
    const token = await signIn()
    const ap = await makeAp('hall', 5) // silent after max(3 × 5 s, 30 s) by default
    await network(ap.id, 'phy1-ap0', 'Home')
    // Its last report, a minute ago, listed one active phone.
    await latest(ap.id, '02:00:00:00:00:01', {
      ssid: 'Home',
      ifname: 'phy1-ap0',
      signalDbm: -50,
      inactiveMs: 100,
      ageSeconds: 60,
    })

    const count = async () => {
      const overview = await client.get('/api/v1/wifi/overview').bearerToken(token)
      overview.assertStatus(200)
      return overview.body().data.totalClients as number
    }
    assert.equal(await count(), 0)

    const saved = await client
      .patch('/api/v1/settings/presence')
      .bearerToken(token)
      .json({ apStaleMinSeconds: 120 })
    saved.assertStatus(200)
    assert.equal(await count(), 1, 'at once, whatever the station cache holds')
    const phone = await client.get('/api/v1/wifi/clients/02:00:00:00:00:01').bearerToken(token)
    phone.assertStatus(200)
    assert.isTrue(phone.body().data.latest.active)
  })

  test('a client its AP stops listing drops out once the row goes stale', async ({
    client,
    assert,
  }) => {
    const token = await signIn()
    const ap = await makeAp('hall', 5)

    // Both phones in one report a minute ago, only one in the report now.
    const earlier = DateTime.utc().minus({ seconds: 60 })
    const first = await ingestWifiMetrics(
      ap,
      exposition([
        { mac: '02:00:00:00:00:01', inactiveMs: 200 },
        { mac: '02:00:00:00:00:02', inactiveMs: 200 },
      ]),
      { now: earlier }
    )
    assert.notEqual(first.status, 'failed')
    const second = await ingestWifiMetrics(
      ap,
      exposition([{ mac: '02:00:00:00:00:01', inactiveMs: 300 }]),
      { now: DateTime.utc() }
    )
    assert.notEqual(second.status, 'failed')

    // The row of the phone that left keeps its last values, 200 ms idle included.
    const leftRow = await db.from('wifi_station_latest').where('mac', '02:00:00:00:00:02').first()
    assert.equal(leftRow.inactive_ms, 200)

    const overview = await client.get('/api/v1/wifi/overview').bearerToken(token)
    overview.assertStatus(200)
    assert.equal(overview.body().data.totalClients, 1)
    assert.equal(overview.body().data.ssids[0].clientCount, 1)

    const active = await client.get('/api/v1/wifi/clients?activeOnly=true').bearerToken(token)
    assert.deepEqual(macs(rowsOf<{ mac: string }>(active.body())), ['02:00:00:00:00:01'])
  })
})
