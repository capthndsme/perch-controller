import WifiAccessPoint from '#models/wifi_access_point'
import { _resetWifiPollerState, ingestWifiMetrics } from '#services/wifi_metrics_poller'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const PHONE = '02:00:00:00:00:01'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetWifiPollerState()
  return teardown
}

async function makeAp(name: string) {
  return WifiAccessPoint.create({
    name,
    friendlyName: name,
    metricsUrl: `http://${name}.test:9100/metrics`,
    pollIntervalSeconds: 5,
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

/** One AP's report: a 5 GHz network and the phone, idle for `idleMs`. */
function exposition(bssid: string, idleMs: number): string {
  const net = `ifname="phy1-ap0",ssid="Home",bssid="${bssid}",channel="36",device="phy1-ap0",frequency="5180"`
  return [
    `wifi_network_quality{${net}} 70`,
    `wifi_network_noise_dbm{${net}} -95`,
    `wifi_station_signal_dbm{mac="${PHONE}",ifname="phy1-ap0"} -55`,
    `wifi_station_inactive_milliseconds{mac="${PHONE}",ifname="phy1-ap0"} ${idleMs}`,
    'node_boot_time_seconds 1700000000',
    '',
  ].join('\n')
}

/**
 * A client that walks from one AP to another stays in the old AP's station
 * list, idle, until hostapd drops it minutes later. Each AP's report used to
 * move it back and forth: a roaming event per report ("30+ roams today", five
 * in one minute) and a latest row that flipped between the two APs.
 */
test.group('wifi | roaming between access points', (group) => {
  group.each.setup(resetDb)

  test('a phone that moved: one roam, and its latest row stays on the AP it is on', async ({
    assert,
  }) => {
    const hall = await makeAp('hall')
    const garage = await makeAp('garage')
    const bssid = new Map([
      [hall.id, '02:00:00:00:ff:01'],
      [garage.id, '02:00:00:00:ff:02'],
    ])
    const t0 = DateTime.utc().minus({ minutes: 5 })

    /** Ingests one report and returns the AP the phone's latest row points at. */
    const push = async (ap: WifiAccessPoint, seconds: number, idleMs: number) => {
      const outcome = await ingestWifiMetrics(ap, exposition(bssid.get(ap.id)!, idleMs), {
        now: t0.plus({ seconds }),
      })
      assert.notEqual(outcome.status, 'failed')
      const row = await db.from('wifi_station_latest').where('mac', PHONE).firstOrFail()
      return Number(row.ap_id)
    }

    assert.equal(await push(hall, 0, 100), hall.id)
    assert.equal(await push(garage, 10, 100), garage.id, 'it walked to the garage')
    // The hall AP keeps listing it, idle since it left; the garage AP hears it all along.
    assert.equal(await push(hall, 12, 12_000), garage.id)
    assert.equal(await push(garage, 15, 200), garage.id)
    assert.equal(await push(hall, 17, 17_000), garage.id)
    assert.equal(await push(garage, 20, 300), garage.id)
    assert.equal(await push(hall, 22, 22_000), garage.id)

    const events = await db.from('wifi_roaming_events').where('mac', PHONE)
    assert.lengthOf(events, 1)
    assert.equal(events[0].event_type, 'ap_roam')
    assert.equal(Number(events[0].from_ap_id), hall.id)
    assert.equal(Number(events[0].to_ap_id), garage.id)

    // History is not rewritten: every AP's listing is still in the snapshots.
    const snapshots = await db.from('wifi_station_snapshots').where('mac', PHONE)
    assert.lengthOf(snapshots, 7)
  })

  test('walking back is a second roam', async ({ assert }) => {
    const hall = await makeAp('hall')
    const garage = await makeAp('garage')
    const t0 = DateTime.utc().minus({ minutes: 5 })
    const push = (ap: WifiAccessPoint, seconds: number, idleMs: number, bssid: string) =>
      ingestWifiMetrics(ap, exposition(bssid, idleMs), { now: t0.plus({ seconds }) })

    await push(hall, 0, 100, '02:00:00:00:ff:01')
    await push(garage, 10, 100, '02:00:00:00:ff:02')
    await push(garage, 15, 200, '02:00:00:00:ff:02')
    await push(hall, 30, 100, '02:00:00:00:ff:01') // back in the hall
    await push(garage, 32, 17_000, '02:00:00:00:ff:02') // the garage's stale listing

    const events = await db.from('wifi_roaming_events').where('mac', PHONE).orderBy('id')
    assert.deepEqual(
      events.map((e) => [Number(e.from_ap_id), Number(e.to_ap_id)]),
      [
        [hall.id, garage.id],
        [garage.id, hall.id],
      ]
    )
    const row = await db.from('wifi_station_latest').where('mac', PHONE).firstOrFail()
    assert.equal(Number(row.ap_id), hall.id)
  })
})
