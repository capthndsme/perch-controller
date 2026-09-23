import WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import {
  AGENT_METRIC_COLLECTORS,
  MAX_PUSH_TEXT_BYTES,
  _resetAgentMetricsState,
  checkAgentPushFreshness,
  handleMetricsPush,
} from '#services/ap_agent_metrics'
import { _resetInfraPortsState } from '#services/infra_ports'
import { updatePresenceSettings } from '#services/presence_settings'
import { _resetWifiPollerState, pollWifiOnce } from '#services/wifi_metrics_poller'
import PollWifiAccessPointsTask from '#tasks/poll_wifi_access_points.task'
import { FakeAgent, eventually, seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * What a Perch AP Daemon pushes: node_exporter-lua names and labels, plus the
 * station byte counters the lua exporter never emitted. Scrubbed:
 * placeholder MACs, SSID "Example".
 */
function agentMetrics(input: { stationRx: number; stationTx: number; ifRx: number; ifTx: number }) {
  const labels =
    'mode="Master",ifname="phy0-ap0",ssid="Example",channel="6",device="radio0",bssid="02:00:00:00:00:11",country="PH",frequency="2437"'
  const station = 'mac="02:00:00:00:00:01",ifname="phy0-ap0"'
  return [
    '# TYPE node_openwrt_info gauge',
    'node_openwrt_info{board_name="example,ap-1",id="OpenWrt",model="Example AP 1",release="25.12.4",revision="r1-abcdef",system="Example SoC",target="ramips/mt7621"} 1',
    '# TYPE node_uname_info gauge',
    'node_uname_info{domainname="(none)",machine="mips",nodename="ap-garage",release="6.12.87",sysname="Linux",version="#0 SMP"} 1',
    '# TYPE node_boot_time_seconds gauge',
    'node_boot_time_seconds 1789796464',
    '# TYPE node_load1 gauge',
    'node_load1 0.04',
    '# TYPE node_load5 gauge',
    'node_load5 0.03',
    '# TYPE node_load15 gauge',
    'node_load15 0.02',
    '# TYPE node_memory_MemTotal_bytes gauge',
    'node_memory_MemTotal_bytes 121618432',
    '# TYPE node_memory_MemAvailable_bytes gauge',
    'node_memory_MemAvailable_bytes 34385920',
    '# TYPE node_nf_conntrack_entries gauge',
    'node_nf_conntrack_entries 7',
    '# TYPE node_nf_conntrack_entries_limit gauge',
    'node_nf_conntrack_entries_limit 15360',
    '# TYPE node_network_receive_bytes_total counter',
    `node_network_receive_bytes_total{device="phy0-ap0"} ${input.ifRx}`,
    `node_network_receive_bytes_total{device="br-lan"} 388927646`,
    '# TYPE node_network_transmit_bytes_total counter',
    `node_network_transmit_bytes_total{device="phy0-ap0"} ${input.ifTx}`,
    '# TYPE wifi_network_quality gauge',
    `wifi_network_quality{${labels}} 94`,
    '# TYPE wifi_network_bitrate gauge',
    `wifi_network_bitrate{${labels}} 72200`,
    '# TYPE wifi_network_noise_dbm gauge',
    `wifi_network_noise_dbm{${labels}} -92`,
    '# TYPE wifi_network_signal_dbm gauge',
    `wifi_network_signal_dbm{${labels}} -44`,
    '# TYPE wifi_stations gauge',
    'wifi_stations{ifname="phy0-ap0"} 1',
    '# TYPE wifi_station_signal_dbm gauge',
    `wifi_station_signal_dbm{${station}} -43`,
    '# TYPE wifi_station_inactive_milliseconds gauge',
    `wifi_station_inactive_milliseconds{${station}} 10`,
    '# TYPE wifi_station_expected_throughput_kilobits_per_second gauge',
    `wifi_station_expected_throughput_kilobits_per_second{${station}} 64960`,
    '# TYPE wifi_station_transmit_kilobits_per_second gauge',
    `wifi_station_transmit_kilobits_per_second{${station}} 72200`,
    '# TYPE wifi_station_receive_kilobits_per_second gauge',
    `wifi_station_receive_kilobits_per_second{${station}} 72200`,
    '# TYPE wifi_station_transmit_bytes_total counter',
    `wifi_station_transmit_bytes_total{${station}} ${input.stationTx}`,
    '# TYPE wifi_station_receive_bytes_total counter',
    `wifi_station_receive_bytes_total{${station}} ${input.stationRx}`,
    '# TYPE wifi_station_transmit_packets_total counter',
    `wifi_station_transmit_packets_total{${station}} 7001002`,
    '# TYPE wifi_station_receive_packets_total counter',
    `wifi_station_receive_packets_total{${station}} 9006173`,
    '',
  ].join('\n')
}

function pushParams(
  seq: number,
  counters = { stationRx: 7_366_133_107, stationTx: 465_137_575, ifRx: 1_005_000, ifTx: 3_009_000 }
) {
  return {
    format: 'prometheus-text',
    text: agentMetrics(counters),
    collectedAt: '2001-01-01T00:00:00Z',
    durationMs: 12,
    seq,
  }
}

async function countRows(table: string) {
  const rows = await db.from(table).select('*')
  return rows.length
}

async function setPollInterval(apId: number, seconds: number) {
  await db.from('wifi_access_points').where('id', apId).update({ poll_interval_seconds: seconds })
}

test.group('perch-apd metrics push', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetWifiPollerState()
    _resetAgentMetricsState()
    _resetInfraPortsState()
    return () => {
      hub.closeAll(1000, 'test reset')
    }
  })

  test('agent.configure is the first frame, then system.info', async ({ assert }) => {
    const { agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')

    assert.equal(agent.calls[0].method, 'agent.configure')
    assert.isNull(agent.calls[0].id)
    assert.deepEqual(agent.calls[0].params, {
      metricsIntervalSeconds: 15,
      collectors: [...AGENT_METRIC_COLLECTORS],
    })
    assert.equal(agent.calls[1].method, 'system.info')
    await agent.close()
  })

  test('a push is ingested like a scrape, station bytes included', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')

    agent.notifyServer('metrics.push', pushParams(1))
    // The ingest writes the snapshots, then the latest tables (networks, then
    // stations): wait for its last write, or a busy run reads in between.
    await eventually(
      () => countRows('wifi_station_latest'),
      (count) => count === 1
    )

    const station = await db.from('wifi_station_snapshots').firstOrFail()
    assert.equal(station.mac, '02:00:00:00:00:01')
    assert.equal(station.ssid, 'Example')
    assert.equal(Number(station.rx_bytes), 7_366_133_107)
    assert.equal(Number(station.tx_bytes), 465_137_575)
    assert.equal(station.expected_throughput_kbps, 64960)
    const latest = await db.from('wifi_station_latest').firstOrFail()
    assert.equal(Number(latest.rx_bytes), 7_366_133_107)
    const network = await db.from('wifi_network_latest').firstOrFail()
    assert.equal(network.bssid, '02:00:00:00:00:11')
    assert.equal(network.radio, 'radio0')

    const row = await eventually(
      () => WifiAccessPoint.findOrFail(ap.id),
      (current) => current.lastStatus?.ok === true
    )
    assert.equal(row.lastStatus?.latencyMs, 12)
    assert.equal(row.model, 'Example AP 1')
    assert.equal(row.nodename, 'ap-garage')
    assert.isNotNull(row.lastSeenAt)
    // Recorded at server time, not at the agent's (bogus) clock.
    assert.isAbove(row.lastSeenAt!.year, 2020)
    await agent.close()
  })

  test('a push over a compressed session (perch-apd 0.1.1) is ingested', async ({ assert }) => {
    const { agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret, perMessageDeflate: true })
    assert.include(String(agent.socket.extensions), 'permessage-deflate')
    await agent.waitFor('system.info')

    // Comment lines pad the frame far past the deflate threshold, so the push
    // is compressed on the way in, like a real 20-40 KB one.
    const params = pushParams(1)
    params.text = '# padding past the compression threshold\n'.repeat(300) + params.text
    agent.notifyServer('metrics.push', params)
    await eventually(
      () => countRows('wifi_station_snapshots'),
      (count) => count === 1
    )
    const station = await db.from('wifi_station_snapshots').firstOrFail()
    assert.equal(Number(station.rx_bytes), 7_366_133_107)
    await agent.close()
  })

  test('two accepted pushes write interface deltas', async ({ assert }) => {
    const { ap } = await seedAgentAp()
    await setPollInterval(ap.id, 1)
    const t0 = DateTime.utc()

    const first = await handleMetricsPush(ap.id, pushParams(1), { receivedAt: t0 })
    assert.equal(first.status, 'ingested')
    const second = await handleMetricsPush(
      ap.id,
      pushParams(2, { stationRx: 1, stationTx: 2, ifRx: 1_010_000, ifTx: 3_018_000 }),
      { receivedAt: t0.plus({ seconds: 1 }) }
    )
    assert.equal(second.status, 'ingested')
    assert.equal(second.status === 'ingested' && second.outcome.status, 'wrote')

    const buckets = await db.from('wifi_interface_buckets').select('*')
    assert.lengthOf(buckets, 1)
    assert.equal(Number(buckets[0].bytes_in), 5000)
    assert.equal(Number(buckets[0].bytes_out), 9000)
  })

  test('a push sooner than the interval (minus 1.5 s slack) is dropped', async ({ assert }) => {
    const { ap } = await seedAgentAp()
    const t0 = DateTime.utc()

    const accepted = await handleMetricsPush(ap.id, pushParams(1), { receivedAt: t0 })
    assert.equal(accepted.status, 'ingested')
    const early = await handleMetricsPush(ap.id, pushParams(2), {
      receivedAt: t0.plus({ seconds: 13 }),
    })
    assert.deepEqual(early, { status: 'dropped', reason: 'too_early' })
    // 15 s interval − 1.5 s slack = 13.5 s.
    const onTime = await handleMetricsPush(ap.id, pushParams(3), {
      receivedAt: t0.plus({ milliseconds: 13_600 }),
    })
    assert.equal(onTime.status, 'ingested')
    assert.equal(await countRows('wifi_station_snapshots'), 2)
  })

  test('concurrent pushes of one AP are ingested one after the other', async ({ assert }) => {
    const { ap } = await seedAgentAp()
    await setPollInterval(ap.id, 1)
    const t0 = DateTime.utc()
    const outcomes = await Promise.all([
      handleMetricsPush(ap.id, pushParams(1), { receivedAt: t0 }),
      handleMetricsPush(
        ap.id,
        pushParams(2, { stationRx: 1, stationTx: 2, ifRx: 1_010_000, ifTx: 3_018_000 }),
        { receivedAt: t0.plus({ seconds: 1 }) }
      ),
    ])
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status === 'ingested' && outcome.outcome.status),
      ['baseline', 'wrote']
    )
  })

  test('a disabled AP gets interval 0 and its pushes are ignored', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp({ enabled: false })
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    assert.equal(agent.calls[0].params.metricsIntervalSeconds, 0)

    const dropped = await handleMetricsPush(ap.id, pushParams(1))
    assert.deepEqual(dropped, { status: 'dropped', reason: 'disabled' })
    assert.equal(await countRows('wifi_station_snapshots'), 0)
    await agent.close()
  })

  test('changing the interval or enabled re-sends agent.configure', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')

    const slower = await client
      .put(`/api/v1/settings/wifi-sources/${ap.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ pollIntervalSeconds: 30 })
    slower.assertStatus(200)
    const second = await agent.waitForCount('agent.configure', 2)
    assert.equal(second[1].params.metricsIntervalSeconds, 30)

    const renamed = await client
      .put(`/api/v1/settings/wifi-sources/${ap.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ friendlyName: 'Garage' })
    renamed.assertStatus(200)

    const disabled = await client
      .put(`/api/v1/settings/wifi-sources/${ap.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ enabled: false })
    disabled.assertStatus(200)
    const third = await agent.waitForCount('agent.configure', 3)
    assert.equal(third[2].params.metricsIntervalSeconds, 0)
    // The rename in between sent nothing.
    assert.lengthOf(
      agent.calls.filter((call) => call.method === 'agent.configure'),
      3
    )
    await agent.close()
  })

  test('a disconnect marks last_status agent offline', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    await agent.close()

    const row = await eventually(
      () => WifiAccessPoint.findOrFail(ap.id),
      (current) => current.lastStatus?.error === 'agent offline'
    )
    assert.equal(row.lastStatus?.ok, false)
    assert.isNotNull(row.agentDisconnectedAt)
  })

  test('a session whose credentials were forgotten cannot touch the row', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp({
      metricsUrl: 'http://192.168.1.6:9100/metrics',
    })
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    const forgotten = await client
      .delete(`/api/v1/settings/wifi-sources/${ap.id}/agent`)
      .bearerToken(adminToken)
    forgotten.assertStatus(200)
    const closed = await agent.closed
    assert.equal(closed.code, 4001)

    await new Promise((resolve) => setTimeout(resolve, 100))
    const row = await WifiAccessPoint.findOrFail(ap.id)
    assert.equal(row.transport, 'scrape')
    // No 'agent offline' stamped on what is now a scrape row.
    assert.notEqual(row.lastStatus?.error, 'agent offline')
  })

  test('no push for max(3 × interval, 30 s) is reported once per episode', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    const connectedAt = hub.session(ap.id)!.connectedAt

    // 15 s interval → 45 s threshold, counted from the connect.
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 40 })), [])
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 46 })), [ap.id])
    const stale = await WifiAccessPoint.findOrFail(ap.id)
    assert.equal(stale.lastStatus?.ok, false)
    assert.equal(stale.lastStatus?.error, 'no metrics from the agent for 46s')

    // Same episode: not reported again.
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 90 })), [])

    // A push starts a new episode.
    const pushedAt = connectedAt.plus({ seconds: 100 })
    await handleMetricsPush(ap.id, pushParams(1), { receivedAt: pushedAt })
    assert.deepEqual(await checkAgentPushFreshness(pushedAt.plus({ seconds: 44 })), [])
    assert.deepEqual(await checkAgentPushFreshness(pushedAt.plus({ seconds: 45 })), [ap.id])
    await agent.close()
  })

  test('the 30 s floor applies to short intervals', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp()
    await setPollInterval(ap.id, 5)
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    const connectedAt = hub.session(ap.id)!.connectedAt
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 29 })), [])
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 31 })), [ap.id])
    await agent.close()
  })

  test('the silence bound follows Settings → Presence', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp()
    await setPollInterval(ap.id, 5)
    await updatePresenceSettings({ apStaleMinSeconds: 60 })
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')
    const connectedAt = hub.session(ap.id)!.connectedAt
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 31 })), [])
    assert.deepEqual(await checkAgentPushFreshness(connectedAt.plus({ seconds: 61 })), [ap.id])
    await agent.close()
  })

  test('pushes with another format, no text or over 4 MiB are ignored', async ({ assert }) => {
    const { ap } = await seedAgentAp()
    assert.deepEqual(await handleMetricsPush(ap.id, { ...pushParams(1), format: 'openmetrics' }), {
      status: 'dropped',
      reason: 'invalid',
    })
    assert.deepEqual(await handleMetricsPush(ap.id, { format: 'prometheus-text' }), {
      status: 'dropped',
      reason: 'invalid',
    })
    assert.deepEqual(
      await handleMetricsPush(ap.id, {
        format: 'prometheus-text',
        text: 'x'.repeat(MAX_PUSH_TEXT_BYTES + 1),
      }),
      { status: 'dropped', reason: 'invalid' }
    )
    assert.equal(await countRows('wifi_station_snapshots'), 0)
  })

  test('the poll task never fetches agent rows; pollWifiOnce refuses them', async ({ assert }) => {
    const { ap } = await seedAgentAp({ metricsUrl: 'http://192.168.1.6:9100/metrics' })
    const original = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched += 1
      throw new Error('must not fetch')
    }) as unknown as typeof fetch
    try {
      await new PollWifiAccessPointsTask().run()
    } finally {
      globalThis.fetch = original
    }
    assert.equal(fetched, 0)
    const outcome = await pollWifiOnce(ap)
    assert.equal(outcome.status, 'failed')
    const row = await WifiAccessPoint.findOrFail(ap.id)
    assert.isNull(row.lastStatus)
  })

  test('a scrape row without a metrics URL fails cleanly', async ({ assert }) => {
    const ap = await WifiAccessPoint.create({
      name: 'no-url',
      friendlyName: null,
      metricsUrl: null,
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
    const outcome = await pollWifiOnce(ap, {
      fetcher: (async () => {
        throw new Error('must not fetch')
      }) as unknown as typeof fetch,
    })
    assert.deepEqual(outcome, { status: 'failed', error: 'no metrics URL configured' })
  })
})
