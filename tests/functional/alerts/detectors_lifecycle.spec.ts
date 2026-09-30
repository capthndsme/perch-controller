import {
  DbProbeState,
  HEARTBEAT_KEY,
  PROBE_FAILURES,
  SHUTDOWN_KEY,
  _resetControllerLifecycle,
  _setDbProbeForTesting,
  announceStart,
  probeOnce,
  startControllerLifecycle,
  startedVerdict,
  stopControllerLifecycle,
} from '#services/alerts/detectors/controller_lifecycle'
import {
  _resetHeartbeat,
  heartbeatStatus,
  pingHeartbeat,
} from '#services/alerts/detectors/heartbeat'
import {
  renderDbUnreachable,
  setOutOfBandTransport,
  type OutOfBandMessage,
} from '#services/alerts/detectors/out_of_band'
import { detectorState } from '#services/alerts/detector_context'
import { captureAlertEvents } from '#tests/helpers/alerts'
import { resetDetectorTests } from '#tests/helpers/alert_detectors'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { createServer, type Server } from 'node:http'

/**
 * WP-A5a acceptance, controller side (events.md sections 3.9, 3.10):
 * `controller.started` clean/unclean, the heartbeat and shutdown marker, the
 * database probe's out-of-band path (at most one notice per outage) and the
 * heartbeat URL pinger.
 */

const T0 = DateTime.fromISO('2026-09-30T06:00:00Z', { zone: 'utc' })

test.group('alerts detectors | controller lifecycle', (group) => {
  group.each.setup(async () => {
    _resetControllerLifecycle()
    await resetDetectorTests()
  })
  group.each.teardown(() => {
    _resetControllerLifecycle()
    setOutOfBandTransport(null)
  })

  test('controller.started: clean vs unclean, downtime and severity', ({ assert }) => {
    const heartbeat = { at: '2026-09-30T05:59:00Z', version: '1.1.0-pre.4', bootId: 'b1' }
    const clean = startedVerdict({
      heartbeat,
      shutdown: { at: '2026-09-30T05:59:20Z', bootId: 'b1' },
      now: T0,
      version: '1.2.0',
      downWarnMinutes: 10,
    })!
    assert.equal(clean.severity, 'info')
    assert.deepEqual(clean.payload, {
      version: '1.2.0',
      previousVersion: '1.1.0-pre.4',
      clean: true,
      downSeconds: 40,
      lastHeartbeatAt: '2026-09-30T05:59:00Z',
    })
    // The marker belongs to an older boot: the last run died.
    const unclean = startedVerdict({
      heartbeat: { ...heartbeat, at: '2026-09-30T05:48:00Z' },
      shutdown: { at: '2026-09-29T00:00:00Z', bootId: 'b0' },
      now: T0,
      version: '1.2.0',
      downWarnMinutes: 10,
    })!
    assert.equal(unclean.severity, 'warning')
    assert.isFalse(unclean.payload.clean)
    assert.equal(unclean.payload.downSeconds, 12 * 60)
    // Clean but down for longer than downWarnMinutes: warning.
    const long = startedVerdict({
      heartbeat,
      shutdown: { at: '2026-09-30T05:00:00Z', bootId: 'b1' },
      now: T0,
      version: '1.2.0',
      downWarnMinutes: 10,
    })!
    assert.equal(long.severity, 'warning')
    // First start ever: nothing to report.
    assert.isNull(
      startedVerdict({
        heartbeat: null,
        shutdown: null,
        now: T0,
        version: '1',
        downWarnMinutes: 10,
      })
    )
  })

  test('start writes a heartbeat and announces; stop writes the shutdown marker', async ({
    assert,
    cleanup,
  }) => {
    const alerts = captureAlertEvents()
    cleanup(() => alerts.restore())
    const state = detectorState('controller')
    await state.set(HEARTBEAT_KEY, {
      at: DateTime.utc().minus({ minutes: 2 }).toISO(),
      version: '1.0.0',
      bootId: 'old',
    })
    await state.set(SHUTDOWN_KEY, {
      at: DateTime.utc().minus({ minutes: 1 }).toISO(),
      bootId: 'old',
    })

    await startControllerLifecycle()
    const [started] = alerts.ofType('controller.started')
    assert.equal(started.severity, 'info')
    assert.equal(started.phase, 'instant')
    assert.match(started.dedupeKey!, /^controller\.started:[0-9a-f-]{36}$/)
    assert.include(started.payload!, { clean: true, previousVersion: '1.0.0' })
    const heartbeat = await state.get<{ bootId: string }>(HEARTBEAT_KEY)
    assert.notEqual(heartbeat!.bootId, 'old')

    await stopControllerLifecycle()
    const marker = await state.get<{ bootId: string }>(SHUTDOWN_KEY)
    assert.equal(marker!.bootId, heartbeat!.bootId)

    // Killed instead (no marker for the last boot): the next start is unclean.
    alerts.clear()
    await state.set(SHUTDOWN_KEY, { at: DateTime.utc().toISO(), bootId: 'someone-else' })
    await announceStart()
    // No boot id outside a running lifecycle: nothing emitted by a bare announce.
    assert.lengthOf(alerts.ofType('controller.started'), 0)
  })

  test('probe bookkeeping: the third failure in a row starts an outage, a success ends it', ({
    assert,
  }) => {
    const probe = new DbProbeState()
    const t = (s: number) => T0.plus({ seconds: s })
    assert.isNull(probe.record(false, t(0)))
    assert.isNull(probe.record(false, t(15)))
    const started = probe.record(false, t(30))
    assert.equal(started?.kind, 'outage_started')
    assert.equal(started?.since.toISO(), t(0).toISO())
    assert.isNull(probe.record(false, t(45)))
    const ended = probe.record(true, t(60))
    assert.equal(ended?.kind, 'outage_ended')
    assert.equal(ended?.since.toISO(), t(0).toISO())
    assert.isNull(probe.record(true, t(75)))
    // Two failures then a success: no outage.
    assert.isNull(probe.record(false, t(90)))
    assert.isNull(probe.record(false, t(105)))
    assert.isNull(probe.record(true, t(120)))
    assert.equal(PROBE_FAILURES, 3)
  })

  test('out of band: one notice per outage and one recovery; the outage is written after', async ({
    assert,
    cleanup,
  }) => {
    const alerts = captureAlertEvents()
    cleanup(() => alerts.restore())
    const sent: OutOfBandMessage[] = []
    setOutOfBandTransport({ refresh: async () => {}, send: async (m) => void sent.push(m) })
    let up = false
    _setDbProbeForTesting(async () => {
      if (!up) throw new Error('ECONNREFUSED')
    })
    for (let i = 0; i < 6; i++) await probeOnce(T0.plus({ seconds: 15 * i }))
    assert.lengthOf(sent, 1)
    assert.equal(sent[0].transition, 'opened')
    assert.equal(sent[0].severity, 'critical')
    assert.equal(sent[0].title, 'Perch cannot reach its database')
    assert.lengthOf(alerts.ofType('system.db_unreachable'), 0)

    up = true
    await probeOnce(T0.plus({ seconds: 120 }))
    await probeOnce(T0.plus({ seconds: 135 }))
    assert.lengthOf(sent, 2)
    assert.equal(sent[1].transition, 'resolved')
    assert.equal(sent[1].title, 'Database is back')
    const written = alerts.ofType('system.db_unreachable')
    assert.deepEqual(
      written.map((e) => e.phase),
      ['raise', 'clear']
    )
    assert.equal(written[0].occurredAt?.toISO(), T0.toISO())
  })

  test('renders the database texts from the catalogue', ({ assert }) => {
    const opened = renderDbUnreachable('opened', T0, T0.plus({ minutes: 1 }))
    assert.equal(opened.type, 'system.db_unreachable')
    assert.match(opened.body, /Charts and alerts are paused/)
  })
})

test.group('alerts detectors | heartbeat URL', (group) => {
  let server: Server
  let port = 0
  let reply = 200
  const hits: string[] = []
  group.setup(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      if (reply === 302) {
        res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' })
        res.end()
        return
      }
      res.writeHead(reply)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    return () => new Promise<void>((resolve) => server.close(() => resolve()))
  })
  group.each.setup(() => {
    _resetHeartbeat()
    hits.length = 0
  })

  test('a 2xx is a ping; errors and redirects are kept for the settings page', async ({
    assert,
  }) => {
    reply = 200
    const url = `http://127.0.0.1:${port}/api/push/token?status=up`
    assert.deepEqual(await pingHeartbeat(url), { ok: true, status: 200, error: null })
    assert.deepEqual(hits, ['/api/push/token?status=up'])
    const okAt = heartbeatStatus().lastOkAt
    assert.isNotNull(okAt)

    reply = 500
    assert.deepEqual(await pingHeartbeat(url), { ok: false, status: 500, error: 'HTTP 500' })
    assert.equal(heartbeatStatus().lastOkAt, okAt)
    assert.equal(heartbeatStatus().lastError, 'HTTP 500')

    // Redirects are not followed.
    reply = 302
    assert.deepEqual(await pingHeartbeat(url), { ok: false, status: 302, error: 'HTTP 302' })
    assert.lengthOf(hits, 3)

    // Unreachable: an error, never a throw.
    const down = await pingHeartbeat('http://127.0.0.1:1/')
    assert.isFalse(down.ok)
    assert.isNull(down.status)
  })
})
