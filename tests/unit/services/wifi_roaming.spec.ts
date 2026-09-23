import {
  _resetWifiPollerState,
  _trackedStationCount,
  resolveStationOwners,
} from '#services/wifi_metrics_poller'
import { test } from '@japa/runner'

const T0 = Date.parse('2026-09-23T07:02:00Z')
const SQL = '2026-09-23 07:02:00'
const PHONE = '02:00:00:00:00:01'

function station(mac: string, ifname: string, inactiveMs: number | null) {
  return {
    mac,
    ifname,
    ssid: 'Home',
    radio: null,
    channel: null,
    frequencyMhz: null,
    band: ifname.startsWith('phy0') ? '2.4' : '5',
    signalDbm: -55,
    snrDb: null,
    txRateKbps: null,
    rxRateKbps: null,
    expectedThroughputKbps: null,
    inactiveMs,
    txBytes: null,
    rxBytes: null,
    txPackets: null,
    rxPackets: null,
  }
}

/** One AP's report of the phone at T0 + `seconds`, idle for `idleMs`. */
function report(apId: number, seconds: number, idleMs: number, ifname = 'phy1-ap0') {
  return resolveStationOwners(apId, T0 + seconds * 1000, [station(PHONE, ifname, idleMs)], SQL)
}

test.group('roaming: which AP owns a station', (group) => {
  group.each.setup(() => _resetWifiPollerState())

  test('a client that left stays listed on its old AP: one roam, not one per report', ({
    assert,
  }) => {
    assert.lengthOf(report(1, 0, 100).events, 0, 'first sighting')
    const roam = report(2, 10, 100)
    assert.lengthOf(roam.events, 1)
    assert.containsSubset(roam.events[0], { event_type: 'ap_roam', from_ap_id: 1, to_ap_id: 2 })

    // AP 1 keeps listing it, idle since it left; AP 2 hears it all along.
    for (const [at, ap, idle] of [
      [12, 1, 12_000],
      [15, 2, 200],
      [17, 1, 17_000],
      [20, 2, 300],
      [22, 1, 22_000],
    ] as const) {
      const outcome = report(ap, at, idle)
      assert.lengthOf(outcome.events, 0, `no roam at +${at}s`)
      assert.lengthOf(outcome.owned, ap === 2 ? 1 : 0, `AP ${ap} owns it at +${at}s: ${ap === 2}`)
    }
  })

  test('a real roam back is recorded', ({ assert }) => {
    report(1, 0, 100)
    report(2, 10, 100)
    report(2, 15, 200) // last heard on AP 2 at +14.8 s
    const back = report(1, 30, 100) // back on AP 1, heard at +29.9 s
    assert.lengthOf(back.events, 1)
    assert.containsSubset(back.events[0], { event_type: 'ap_roam', from_ap_id: 2, to_ap_id: 1 })
    assert.lengthOf(report(2, 32, 17_000).owned, 0, 'AP 2 now only has a stale listing')
  })

  test('within the hysteresis the current AP keeps the station', ({ assert }) => {
    report(1, 0, 0)
    const close = report(2, 1, 0) // heard only 1 s later: not enough to move it
    assert.lengthOf(close.events, 0)
    assert.lengthOf(close.owned, 0)
    const moved = report(2, 6, 0)
    assert.lengthOf(moved.events, 1)
    assert.lengthOf(moved.owned, 1)
  })

  test('the owner AP moving it to another radio is a band steer, without the margin', ({
    assert,
  }) => {
    report(1, 0, 100, 'phy1-ap0')
    const steer = report(1, 0.5, 100, 'phy0-ap0')
    assert.lengthOf(steer.events, 1)
    assert.containsSubset(steer.events[0], {
      event_type: 'band_steer',
      from_ifname: 'phy1-ap0',
      to_ifname: 'phy0-ap0',
    })
  })

  test('a MAC listed on two radios of one report counts once, by the fresher entry', ({
    assert,
  }) => {
    const both = resolveStationOwners(
      1,
      T0,
      [station(PHONE, 'phy0-ap0', 50_000), station(PHONE, 'phy1-ap0', 100)],
      SQL
    )
    assert.lengthOf(both.events, 0)
    assert.deepEqual(
      both.owned.map((s) => s.ifname),
      ['phy1-ap0']
    )
  })

  test('the station map stays bounded', ({ assert }) => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      station(
        `02:00:00:00:${Math.floor(i / 256)
          .toString(16)
          .padStart(2, '0')}:${(i % 256).toString(16).padStart(2, '0')}`,
        'phy1-ap0',
        0
      )
    )
    resolveStationOwners(1, T0, many, SQL)
    assert.isAtMost(_trackedStationCount(), 4096)
  })
})
