import {
  runAgentsDetector,
  apOfflineKey,
  collectorOfflineKey,
  MASS_KEY,
} from '#services/alerts/detectors/agents'
import { deviceKey, runNewDevices, runWatchedDevices } from '#services/alerts/detectors/devices'
import {
  _setStatfsForTesting,
  runDiskCheck,
  runDbSizeCheck,
  runRetentionCheck,
  runRollupCheck,
} from '#services/alerts/detectors/system'
import { updatePresenceSettings } from '#services/presence_settings'
import {
  ago,
  fakeDetectorContext,
  resetDetectorTests,
  seedAp,
  seedCollector,
  seedLiveAlert,
} from '#tests/helpers/alert_detectors'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

/**
 * WP-A5a acceptance (docs/design/alerts/README.md section 9): agents,
 * devices and system detectors against seeded tables. Placeholder MACs only.
 */

test.group('alerts detectors | agents (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  test('silence bounds: collectorStaleSeconds and apStaleSeconds with Presence', async ({
    assert,
  }) => {
    // Collector, 5 s interval: bound max(15, 30) = 30 s.
    const fresh = await seedCollector({ name: 'fresh', silentSeconds: 25 })
    const silent = await seedCollector({ name: 'silent', silentSeconds: 40 })
    // Pending, disabled and never-seen rows are not watched.
    await seedCollector({ name: 'pending', lifecycle: 'pending', silentSeconds: 400 })
    await seedCollector({ name: 'disabled', enabled: false, silentSeconds: 400 })
    await seedCollector({ name: 'never', silentSeconds: null })
    // AP, 15 s interval: bound max(3 × 15, 30) = 45 s by default.
    const ap = await seedAp({ name: 'garage', pollIntervalSeconds: 15, silentSeconds: 40 })
    await seedAp({ name: 'off', enabled: false, silentSeconds: 400 })

    const ctx = fakeDetectorContext()
    await runAgentsDetector(ctx)
    assert.deepEqual(ctx.held('collector.offline'), [collectorOfflineKey(silent)])
    assert.deepEqual(ctx.held('ap.offline'), [])
    assert.notInclude(ctx.held('collector.offline'), collectorOfflineKey(fresh))
    const payload = ctx.condition(collectorOfflineKey(silent))!.payload!
    assert.equal(payload.boundSeconds, 30)
    assert.isAtLeast(payload.silentSeconds as number, 40)
    assert.equal(ctx.condition(collectorOfflineKey(silent))!.subject.kind, 'collector')

    // Settings → Presence: two intervals → the AP's bound is 30 s, so 40 s is silent.
    await updatePresenceSettings({ apStaleIntervals: 2 })
    const next = fakeDetectorContext()
    await runAgentsDetector(next)
    assert.deepEqual(next.held('ap.offline'), [apOfflineKey(ap)])
    assert.equal(next.condition(apOfflineKey(ap))!.payload!.boundSeconds, 30)
  })

  test('clients on the AP at its last report', async ({ assert }) => {
    const ap = await seedAp({ name: 'garage', silentSeconds: 120 })
    const station = (mac: string, recordedBeforeLastSeen: number, inactiveMs: number) =>
      db.table('wifi_station_latest').insert({
        mac,
        ap_id: ap,
        ifname: 'phy0-ap0',
        inactive_ms: inactiveMs,
        recorded_at: ago(120 + recordedBeforeLastSeen),
      })
    await station('02:00:00:00:00:01', 0, 1000)
    await station('02:00:00:00:00:02', 5, 50_000)
    // Idle past the connected threshold, and listed long before the last report: not counted.
    await station('02:00:00:00:00:03', 0, 300_000)
    await station('02:00:00:00:00:04', 600, 1000)
    const ctx = fakeDetectorContext()
    await runAgentsDetector(ctx)
    assert.equal(ctx.condition(apOfflineKey(ap))!.payload!.clientsAtLastReport, 2)
  })

  test('mass offline: 3 of 4 silent → one system.agents_unreachable, no per-agent alerts', async ({
    assert,
  }) => {
    await seedCollector({ silentSeconds: 90 })
    await seedAp({ name: 'a', silentSeconds: 90 })
    await seedAp({ name: 'b', silentSeconds: 90 })
    await seedAp({ name: 'c', silentSeconds: 2 })
    const ctx = fakeDetectorContext()
    await runAgentsDetector(ctx)
    assert.deepEqual(ctx.held('system.agents_unreachable'), [MASS_KEY])
    assert.deepEqual(ctx.held('collector.offline'), [])
    assert.deepEqual(ctx.held('ap.offline'), [])
    assert.include(ctx.condition(MASS_KEY)!.payload!, { silent: 3, monitored: 4 })
    // The guard goes first, so the engine withholds per-agent raises while it is live.
    assert.deepEqual(ctx.reconciles[0].types, ['system.agents_unreachable'])
  })

  test('the guard off: each silent agent alerts on its own', async ({ assert }) => {
    const collector = await seedCollector({ silentSeconds: 90 })
    await seedAp({ name: 'a', silentSeconds: 90 })
    await seedAp({ name: 'b', silentSeconds: 90 })
    const ctx = fakeDetectorContext({
      massOffline: { enabled: false, fractionPercent: 75, minAgents: 3 },
    })
    await runAgentsDetector(ctx)
    assert.deepEqual(ctx.held('system.agents_unreachable'), [])
    assert.include(ctx.held('collector.offline'), collectorOfflineKey(collector))
    assert.lengthOf(ctx.held('ap.offline'), 2)
  })

  test('boot grace: nothing new raised, live alerts kept', async ({ assert }) => {
    const kept = await seedCollector({ name: 'kept', silentSeconds: 90 })
    const fresh = await seedCollector({ name: 'new', silentSeconds: 90 })
    await seedLiveAlert('collector.offline', collectorOfflineKey(kept))
    const ctx = fakeDetectorContext({ inBootGrace: true })
    await runAgentsDetector(ctx)
    assert.deepEqual(ctx.held('collector.offline'), [collectorOfflineKey(kept)])
    assert.notInclude(ctx.held('collector.offline'), collectorOfflineKey(fresh))
    // A live key is passed without a payload (it keeps its own).
    assert.isUndefined(ctx.condition(collectorOfflineKey(kept))!.payload)
  })
})

test.group('alerts detectors | devices (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  const identity = (collectorId: number, mac: string, firstAgo: number, lastAgo: number) =>
    db.table('device_identities').insert({
      collector_id: collectorId,
      mac,
      ips: '[]',
      primary_ip: '192.168.1.50',
      first_seen_at: ago(firstAgo),
      last_seen_at: ago(lastAgo),
      created_at: ago(firstAgo),
    })

  test('device.new: presence, exclusions, once per MAC ever', async ({ assert }) => {
    const collector = await seedCollector()
    await seedAp({ name: 'ap', macs: ['02:00:00:00:10:01'] })
    await identity(collector, '02:00:00:00:00:a1', 30 * 60, 5) // new, around 30 min: yes
    await identity(collector, '02:00:00:00:00:a2', 5 * 60, 5) // around 5 min: not yet
    await identity(collector, '02:00:00:00:00:a3', 3 * 86_400, 5) // old: no
    await identity(collector, '02:00:00:00:00:a4', 30 * 60, 5) // labelled: no
    await identity(collector, '02:00:00:00:10:01', 30 * 60, 5) // an AP's own MAC: no
    await identity(collector, '02:00:00:00:00:a5', 30 * 60, 5) // already alerted: no
    await db.table('device_labels').insert({
      mac: '02:00:00:00:00:a4',
      name: 'Printer',
      created_at: ago(60),
    })
    await seedLiveAlert('device.new', deviceKey('device.new', '02:00:00:00:00:a5'), 'active')

    const ctx = fakeDetectorContext()
    assert.equal(await runNewDevices(ctx), 1)
    const [emit] = ctx.emitted('device.new')
    assert.deepEqual(emit.subject, { kind: 'device', mac: '02:00:00:00:00:a1' })
    assert.equal(emit.phase, 'instant')
    assert.include(emit.payload!, {
      mac: '02:00:00:00:00:a1',
      ip: '192.168.1.50',
      via: 'lan',
      randomized: true,
    })

    // With minPresenceMinutes 0 the 5-minute one qualifies too.
    const eager = fakeDetectorContext({
      rules: { 'device.new': { params: { minPresenceMinutes: 0 } } },
    })
    await runNewDevices(eager)
    assert.sameMembers(
      eager.emitted('device.new').map((e) => (e.subject as { mac: string }).mac),
      ['02:00:00:00:00:a1', '02:00:00:00:00:a2']
    )
    // Randomised MACs ignored on request.
    const strict = fakeDetectorContext({
      rules: { 'device.new': { params: { ignoreRandomizedMacs: true } } },
    })
    assert.equal(await runNewDevices(strict), 0)
    // Off: nothing.
    const off = fakeDetectorContext({ rules: { 'device.new': { enabled: false } } })
    assert.equal(await runNewDevices(off), 0)
  })

  test('device.new: portal networks are excluded by default', async ({ assert }) => {
    const collector = await seedCollector()
    const [gatewayId] = await db
      .table('gateways')
      .insert({ collector_id: collector, created_at: ago(60) })
    await db.table('gateway_networks').insert({
      gateway_id: gatewayId,
      label: 'Guests',
      network: 'guest',
      interface_perch_id: 'p-guest',
      created_at: ago(60),
    })
    await db.table('portals').insert({
      gateway_id: gatewayId,
      name: 'Lobby',
      network_perch_id: 'p-guest',
      methods: '{}',
      created_at: ago(60),
    })
    await identity(collector, '00:11:22:33:44:01', 30 * 60, 5)
    await db.table('device_network_latest').insert({
      gateway_id: gatewayId,
      mac: '00:11:22:33:44:01',
      network: 'guest',
      seen_at: ago(5),
    })
    assert.equal(await runNewDevices(fakeDetectorContext()), 0)
    assert.equal(
      await runNewDevices(
        fakeDetectorContext({
          rules: { 'device.new': { params: { excludePortalNetworks: false } } },
        })
      ),
      1
    )
  })

  test('watched devices: offline through the presence rule, withheld while an agent is silent', async ({
    assert,
  }) => {
    const collector = await seedCollector()
    const gone = '02:00:00:00:00:b1'
    const here = '02:00:00:00:00:b2'
    await identity(collector, gone, 86_400, 3 * 3600) // quiet for 3 h: disconnected
    await identity(collector, here, 86_400, 20) // talking: connected
    for (const mac of [gone, here]) {
      await db.table('alert_watches').insert({
        subject_kind: 'device',
        subject_ref: mac,
        mode: 'offline',
        created_at: ago(60),
      })
    }
    await db.table('alert_watches').insert({
      subject_kind: 'device',
      subject_ref: here,
      mode: 'arrival',
      created_at: ago(60),
    })

    const ctx = fakeDetectorContext()
    await runWatchedDevices(ctx)
    assert.deepEqual(ctx.held('device.offline'), [deviceKey('device.offline', gone)])
    assert.include(ctx.condition(deviceKey('device.offline', gone))!.payload!, { via: 'lan' })
    assert.deepEqual(ctx.store.get('watch-status'), { [here]: 'connected' })

    // An AP falls silent: devices behind it look gone, so nothing new is raised.
    await seedAp({ name: 'silent', silentSeconds: 600 })
    const withheld = fakeDetectorContext()
    await runWatchedDevices(withheld)
    assert.deepEqual(withheld.held('device.offline'), [])

    // Arrival: the stored status was disconnected, now connected.
    await db.from('wifi_access_points').delete()
    const arriving = fakeDetectorContext()
    await arriving.state.set('watch-status', { [here]: 'disconnected' })
    await runWatchedDevices(arriving)
    assert.lengthOf(arriving.emitted('device.arrived'), 1)
    assert.deepEqual(arriving.emitted('device.arrived')[0].subject, { kind: 'device', mac: here })
  })
})

test.group('alerts detectors | system (db)', (group) => {
  group.each.setup(() => resetDetectorTests())
  group.each.teardown(() => _setStatfsForTesting(null))

  test('disk thresholds from a stubbed statfs', async ({ assert }) => {
    const disk = (freePercent: number) =>
      _setStatfsForTesting(async () => ({ bsize: 4096, blocks: 1000, bavail: freePercent * 10 }))
    disk(50)
    const ok = fakeDetectorContext()
    await runDiskCheck(ok)
    assert.deepEqual(ok.held('system.disk_low'), [])

    disk(6)
    const low = fakeDetectorContext()
    await runDiskCheck(low)
    assert.equal(low.condition('system.disk_low:controller')!.severity, 'warning')
    assert.include(low.condition('system.disk_low:controller')!.payload!, {
      path: '/data',
      freePercent: 6,
    })

    disk(2)
    const critical = fakeDetectorContext()
    await runDiskCheck(critical)
    assert.equal(critical.condition('system.disk_low:controller')!.severity, 'critical')

    // A path that cannot be read is not evaluated (no reconcile at all).
    _setStatfsForTesting(async () => {
      throw new Error('ENOENT')
    })
    const missing = fakeDetectorContext()
    await runDiskCheck(missing)
    assert.lengthOf(missing.reconciles, 0)
  })

  test('database size: off until warnGb is set', async ({ assert }) => {
    const off = fakeDetectorContext()
    await runDbSizeCheck(off)
    assert.deepEqual(off.held('system.db_size'), [])
    // Any database is larger than 0.000001 GB: the smallest positive setting is 1 GB,
    // so exercise the comparison through a 1 GB limit that the test DB never reaches.
    const on = fakeDetectorContext({ rules: { 'system.db_size': { params: { warnGb: 1 } } } })
    await runDbSizeCheck(on)
    assert.deepEqual(on.held('system.db_size'), [])
  })

  test('rollups stalled while native data arrives; retention past its grace', async ({
    assert,
  }) => {
    const collector = await seedCollector()
    const bucket = (secondsAgo: number) =>
      db.table('device_traffic_buckets').insert({
        collector_id: collector,
        mac: '02:00:00:00:00:c1',
        bucket_start: ago(secondsAgo),
        created_at: ago(secondsAgo),
      })
    await bucket(10)
    await db.table('device_traffic_buckets_5m').insert({
      collector_id: collector,
      mac: '02:00:00:00:00:c1',
      slot_start: ago(47 * 60),
      updated_at: ago(47 * 60),
    })
    const stalled = fakeDetectorContext()
    await runRollupCheck(stalled)
    assert.deepEqual(stalled.held('system.rollup_stalled'), ['system.rollup_stalled:controller'])
    assert.equal(stalled.condition('system.rollup_stalled:controller')!.payload!.ageMinutes, 47)

    await db.from('device_traffic_buckets_5m').update({ slot_start: ago(6 * 60) })
    const current = fakeDetectorContext()
    await runRollupCheck(current)
    assert.deepEqual(current.held('system.rollup_stalled'), [])

    // Retention (30 d by default) + 2 d grace.
    await bucket(31 * 86_400)
    const fine = fakeDetectorContext()
    await runRetentionCheck(fine)
    assert.deepEqual(fine.held('system.retention_stalled'), [])
    await bucket(33 * 86_400)
    const late = fakeDetectorContext()
    await runRetentionCheck(late)
    assert.deepEqual(late.held('system.retention_stalled'), ['system.retention_stalled:controller'])
    assert.include(late.condition('system.retention_stalled:controller')!.payload!, {
      oldestDays: 33,
      retentionDays: 30,
    })
  })
})
