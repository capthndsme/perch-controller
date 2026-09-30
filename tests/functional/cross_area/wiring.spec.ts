import AlertMute from '#models/alert_mute'
import Collector from '#models/collector'
import {
  _resetUpdateWindows,
  closeUpdateWindow,
  openUpdateWindow,
} from '#services/agent_updates/alert_window'
import { applyPending } from '#services/agent_updates/busy'
import { recordUpdateEvent } from '#services/agent_updates/events'
import {
  _resetInFlight,
  deviceUpdateInFlight,
  markDeviceInFlight,
} from '#services/agent_updates/state'
import { getAlertType } from '#services/alerts/catalogue/index'
import { setCollectorUpdateHold, sendApply } from '#services/gateway_config/apply_lifecycle'
import { installCrossAreaWiring } from '#services/cross_area_wiring'
import { forwardWifiAlert } from '#services/wifi_config/alerts'
import { emitWifiAlert, setWifiAlertSink } from '#services/wifi_config/events'
import { apUpdateInFlight, setDeviceUpdateHold } from '#services/wifi_config/registry'
import { captureAlertEvents, truncateAllTables } from '#tests/helpers/alerts'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * The seams between the 2026-09-30 areas (BUILD-PLAN agreements 4 and 5):
 * Wi-Fi events into alerts (S9), agent-update events into alerts and the
 * maintenance window around an install, and the update holds of the Wi-Fi
 * plane and the gateway apply queue.
 */

test.group('cross-area wiring', (group) => {
  group.each.setup(async () => {
    await truncateAllTables()
    _resetInFlight()
    _resetUpdateWindows()
    return () => {
      setWifiAlertSink(null)
      setDeviceUpdateHold(null)
      setCollectorUpdateHold(null)
      _resetInFlight()
    }
  })

  test('every forwarded name is a catalogue type', ({ assert }) => {
    for (const type of [
      'wifi.apply.rolled_back',
      'wifi.apply.failed',
      'wifi.rollout.stopped',
      'wifi.rollout.completed',
      'wifi.ap.behind',
      'wifi.divergence.opened',
      'wifi.drift.detected',
      'wifi.drift.reverted',
      'wifi.enforcement.suspended',
      'wifi.radio.down',
      'wifi.bss.down',
      'wifi.passphrase.changed',
      'wifi.passphrase.revealed',
    ]) {
      assert.isNotNull(getAlertType(type), type)
      assert.equal(getAlertType(type)!.owner, 'wifi')
    }
  })

  test('Wi-Fi (S9): raises, notices on the controller, recoveries clear', ({ assert }) => {
    const capture = captureAlertEvents()
    try {
      installCrossAreaWiring()
      emitWifiAlert({
        name: 'wifi.radio.down',
        severity: 'warning',
        source: { kind: 'ap', id: 4 },
        dedupeKey: 'wifi.radio.down:4:radio1',
        payload: { apId: 4, radio: 'radio1', problem: 'radio_down' },
      })
      emitWifiAlert({
        name: 'wifi.rollout.stopped',
        severity: 'warning',
        source: { kind: 'wifi_rollout', id: 9 },
        dedupeKey: 'wifi.rollout.stopped:9',
        payload: { rolloutId: 9, apId: 4, reason: 'health_failed', completedApIds: [3] },
      })
      forwardWifiAlert({
        name: 'wifi.health.recovered',
        severity: 'info',
        source: { kind: 'ap', id: 4 },
        at: new Date().toISOString(),
        dedupeKey: 'wifi.health:4',
        payload: { apId: 4 },
      })
      forwardWifiAlert({
        name: 'wifi.ap.caught_up',
        severity: 'info',
        source: { kind: 'wifi_rollout', id: 10 },
        at: new Date().toISOString(),
        dedupeKey: 'wifi.rollout.completed:10',
        payload: { rolloutId: 10, apIds: [4, 5] },
      })
      const radio = capture.ofType('wifi.radio.down')[0]
      assert.deepInclude(radio, { phase: 'raise', dedupeKey: 'wifi.radio.down:4:radio1' })
      assert.deepEqual(radio.subject, { kind: 'ap', id: 4 })
      assert.deepEqual(capture.ofType('wifi.rollout.stopped')[0].subject, { kind: 'controller' })
      assert.sameDeepMembers(
        capture.reconciles.map((r) => ({ types: r.types, scope: r.scope })),
        [
          { types: ['wifi.radio.down'], scope: 'wifi.radio.down:4:' },
          { types: ['wifi.bss.down'], scope: 'wifi.bss.down:4:' },
        ]
      )
      const behind = capture.ofType('wifi.ap.behind')
      assert.deepEqual(
        behind.map((e) => [e.phase, e.dedupeKey]),
        [
          ['clear', 'wifi.ap.behind:4'],
          ['clear', 'wifi.ap.behind:5'],
        ]
      )
    } finally {
      capture.restore()
    }
  })

  test('agent updates: events forwarded with the device; fleet events on the controller', async ({
    assert,
  }) => {
    const collector = await Collector.create({
      name: 'gateway',
      baseUrl: null,
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const capture = captureAlertEvents()
    try {
      await recordUpdateEvent('agent_update.failed', {
        device: { kind: 'collector', id: collector.id, name: 'gateway' },
        detail: { toVersion: '1.2.0', reason: 'download', detail: 'hash mismatch' },
      })
      await recordUpdateEvent('agent_update.available', {
        detail: { product: 'perch-apd', version: '1.2.0', devices: [] },
      })
      await recordUpdateEvent('job_created', { detail: {} })
      const failed = capture.ofType('agent_update.failed')[0]
      assert.deepEqual(failed.subject, { kind: 'collector', id: collector.id })
      assert.equal(failed.severity, 'warning')
      assert.deepInclude(failed.payload!, { toVersion: '1.2.0', reason: 'download' })
      assert.deepEqual(failed.payload!.device, {
        kind: 'collector',
        id: collector.id,
        name: 'gateway',
      })
      assert.deepEqual(capture.ofType('agent_update.available')[0].subject, { kind: 'controller' })
      assert.lengthOf(capture.ofType('job_created'), 0, 'audit-only events stay in the log')
    } finally {
      capture.restore()
    }
  })

  test('the maintenance window: offline alerts muted while installing, released at the end', async ({
    assert,
  }) => {
    const collector = await Collector.create({
      name: 'gateway',
      baseUrl: null,
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const job = {
      id: 42,
      toVersion: '1.2.0',
      deadlineAt: DateTime.utc().plus({ minutes: 5 }),
    } as any
    await openUpdateWindow(job, { kind: 'collector', id: collector.id })
    const mutes = await AlertMute.all()
    assert.lengthOf(mutes, 1)
    const m = mutes[0]
    assert.deepEqual(
      [m.type, m.reason, m.source, m.subjectKind, m.subjectRef],
      ['collector.offline', 'maintenance', 'agent_update:42', 'collector', String(collector.id)]
    )
    await openUpdateWindow(job, { kind: 'collector', id: collector.id })
    assert.lengthOf(await AlertMute.all(), 1, 'one window per job')
    await closeUpdateWindow(42)
    assert.lengthOf(await AlertMute.all(), 0)

    const ap = { id: 43, toVersion: '1.2.0', deadlineAt: null } as any
    await openUpdateWindow(ap, { kind: 'ap', id: 4 })
    const apMutes = await AlertMute.all()
    assert.sameMembers(
      apMutes.map((row) => row.type),
      ['ap.offline', 'wifi.radio.down', 'wifi.bss.down']
    )
  })

  test('holds: the Wi-Fi plane and the gateway queue wait while a device updates', async ({
    assert,
  }) => {
    installCrossAreaWiring()
    assert.isFalse(apUpdateInFlight(4))
    markDeviceInFlight('ap', 4, true)
    assert.isTrue(apUpdateInFlight(4))
    assert.isTrue(deviceUpdateInFlight('ap', 4))
    markDeviceInFlight('ap', 4, false)
    assert.isFalse(apUpdateInFlight(4))

    // The gateway queue returns before touching the job while its collector updates.
    markDeviceInFlight('collector', 7, true)
    const apply = { kind: 'apply', state: 'queued' } as any
    await sendApply({ id: 1, collectorId: 7 } as any, apply)
    assert.equal(apply.state, 'queued')
    assert.isNull(await applyPending('ap', 999))
  })
})
