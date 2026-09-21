import WifiAccessPoint from '#models/wifi_access_point'
import { _resetWifiPollerState, pollWifiOnce } from '#services/wifi_metrics_poller'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

function metricsPayload(input: {
  ifname: string
  ssid: string
  frequency: number
  stationMac: string
  signalDbm: number
  noiseDbm: number
  rxBytes: number
  txBytes: number
  rxPackets: number
  txPackets: number
  bootTime: number
}) {
  return `
node_openwrt_info{model="OpenWrt One",release="24.10.0"} 1
node_uname_info{nodename="ap-living-room"} 1
wifi_network_quality{ifname="${input.ifname}",ssid="${input.ssid}",bssid="aa:bb:cc:dd:ee:ff",channel="36",device="${input.ifname}",frequency="${input.frequency}"} 70
wifi_network_signal_dbm{ifname="${input.ifname}",ssid="${input.ssid}",bssid="aa:bb:cc:dd:ee:ff",channel="36",device="${input.ifname}",frequency="${input.frequency}"} ${input.signalDbm}
wifi_network_noise_dbm{ifname="${input.ifname}",ssid="${input.ssid}",bssid="aa:bb:cc:dd:ee:ff",channel="36",device="${input.ifname}",frequency="${input.frequency}"} ${input.noiseDbm}
wifi_network_bitrate{ifname="${input.ifname}",ssid="${input.ssid}",bssid="aa:bb:cc:dd:ee:ff",channel="36",device="${input.ifname}",frequency="${input.frequency}"} 866700
wifi_station_signal_dbm{mac="${input.stationMac}",ifname="${input.ifname}"} ${input.signalDbm}
wifi_station_transmit_kilobits_per_second{mac="${input.stationMac}",ifname="${input.ifname}"} 12000
wifi_station_receive_kilobits_per_second{mac="${input.stationMac}",ifname="${input.ifname}"} 8000
wifi_station_inactive_milliseconds{mac="${input.stationMac}",ifname="${input.ifname}"} 200
wifi_station_transmit_bytes_total{mac="${input.stationMac}",ifname="${input.ifname}"} ${input.txBytes}
wifi_station_receive_bytes_total{mac="${input.stationMac}",ifname="${input.ifname}"} ${input.rxBytes}
wifi_station_transmit_packets_total{mac="${input.stationMac}",ifname="${input.ifname}"} ${input.txPackets}
wifi_station_receive_packets_total{mac="${input.stationMac}",ifname="${input.ifname}"} ${input.rxPackets}
node_network_receive_bytes_total{device="${input.ifname}"} ${input.rxBytes}
node_network_transmit_bytes_total{device="${input.ifname}"} ${input.txBytes}
node_network_receive_packets_total{device="${input.ifname}"} ${input.rxPackets}
node_network_transmit_packets_total{device="${input.ifname}"} ${input.txPackets}
node_network_receive_errs_total{device="${input.ifname}"} 0
node_network_transmit_errs_total{device="${input.ifname}"} 0
node_network_receive_drop_total{device="${input.ifname}"} 0
node_network_transmit_drop_total{device="${input.ifname}"} 0
node_load1 0.20
node_load5 0.15
node_load15 0.10
node_memory_MemTotal_bytes 256000000
node_memory_MemAvailable_bytes 128000000
node_nf_conntrack_entries 120
node_nf_conntrack_entries_limit 4096
node_boot_time_seconds ${input.bootTime}
`
}

async function makeAp() {
  return WifiAccessPoint.create({
    name: 'living-room',
    friendlyName: 'Living Room AP',
    metricsUrl: 'http://192.168.1.17:9100/metrics',
    pollIntervalSeconds: 15,
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

async function rowCount(table: string): Promise<number> {
  const rows = await db.from(table).select('id')
  return rows.length
}

test.group('wifi_metrics_poller', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetWifiPollerState()
  })

  test('writes snapshots and interface bucket deltas across polls', async ({ assert }) => {
    const ap = await makeAp()

    const first = await pollWifiOnce(ap, {
      fetcher: (async () =>
        new Response(
          metricsPayload({
            ifname: 'phy1-ap0',
            ssid: 'Home',
            frequency: 5180,
            stationMac: 'aa:bb:cc:dd:ee:ff',
            signalDbm: -58,
            noiseDbm: -95,
            rxBytes: 1000,
            txBytes: 2000,
            rxPackets: 10,
            txPackets: 20,
            bootTime: 1_700_000_000,
          }),
          { status: 200 }
        )) as unknown as typeof fetch,
    })

    assert.equal(first.status, 'baseline')
    assert.equal(await rowCount('wifi_network_snapshots'), 1)
    assert.equal(await rowCount('wifi_station_snapshots'), 1)
    assert.equal(await rowCount('ap_system_snapshots'), 1)
    assert.equal(await rowCount('wifi_interface_buckets'), 0)

    const second = await pollWifiOnce(ap, {
      fetcher: (async () =>
        new Response(
          metricsPayload({
            ifname: 'phy1-ap0',
            ssid: 'Home',
            frequency: 5180,
            stationMac: 'aa:bb:cc:dd:ee:ff',
            signalDbm: -56,
            noiseDbm: -94,
            rxBytes: 1800,
            txBytes: 2900,
            rxPackets: 15,
            txPackets: 27,
            bootTime: 1_700_000_000,
          }),
          { status: 200 }
        )) as unknown as typeof fetch,
    })
    assert.equal(second.status, 'wrote')
    const buckets = await db.from('wifi_interface_buckets').select('*')
    assert.equal(buckets.length, 1)
    assert.equal(Number(buckets[0].bytes_in), 800)
    assert.equal(Number(buckets[0].bytes_out), 900)
  })

  test('records roaming event when client changes interface/band', async ({ assert }) => {
    const ap = await makeAp()
    const baseFetcher = (payload: string) =>
      (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch

    await pollWifiOnce(ap, {
      fetcher: baseFetcher(
        metricsPayload({
          ifname: 'phy1-ap0',
          ssid: 'Home-5G',
          frequency: 5180,
          stationMac: 'aa:bb:cc:dd:ee:ff',
          signalDbm: -60,
          noiseDbm: -95,
          rxBytes: 1000,
          txBytes: 1500,
          rxPackets: 10,
          txPackets: 15,
          bootTime: 1_700_000_000,
        })
      ),
    })

    await pollWifiOnce(ap, {
      fetcher: baseFetcher(
        metricsPayload({
          ifname: 'phy1-ap0',
          ssid: 'Home-5G',
          frequency: 5180,
          stationMac: 'aa:bb:cc:dd:ee:ff',
          signalDbm: -59,
          noiseDbm: -95,
          rxBytes: 1300,
          txBytes: 1700,
          rxPackets: 12,
          txPackets: 18,
          bootTime: 1_700_000_000,
        })
      ),
    })

    await pollWifiOnce(ap, {
      fetcher: baseFetcher(
        metricsPayload({
          ifname: 'phy0-ap0',
          ssid: 'Home-2G',
          frequency: 2412,
          stationMac: 'aa:bb:cc:dd:ee:ff',
          signalDbm: -62,
          noiseDbm: -96,
          rxBytes: 100,
          txBytes: 140,
          rxPackets: 2,
          txPackets: 3,
          bootTime: 1_700_000_000,
        })
      ),
    })

    const events = await db.from('wifi_roaming_events').select('*')
    assert.equal(events.length, 1)
    assert.equal(events[0].event_type, 'band_steer')
    assert.equal(events[0].from_ifname, 'phy1-ap0')
    assert.equal(events[0].to_ifname, 'phy0-ap0')
  })

  test('poll failures persist failed status instead of throwing', async ({ assert }) => {
    const ap = await makeAp()
    const outcome = await pollWifiOnce(ap, {
      fetcher: (async () => {
        throw new Error('fetch failed')
      }) as unknown as typeof fetch,
    })

    assert.equal(outcome.status, 'failed')
    const refreshed = await WifiAccessPoint.findOrFail(ap.id)
    assert.equal(refreshed.lastStatus?.ok, false)
    assert.match(refreshed.lastStatus?.error ?? '', /fetch failed/)
  })
})
