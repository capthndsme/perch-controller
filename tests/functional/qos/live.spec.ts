import QosAssignment from '#models/qos_assignment'
import { handleCollectorPush } from '#services/collector_agent'
import {
  handleQosEvent,
  onQuotaExhausted,
  persistQuotas,
  qosLive,
  recordQosReport,
} from '#services/qos_live'
import { updateQosSettings } from '#services/qos_settings'
import { flushQosSync } from '#services/qos_sync'
import { recordRouterSqm } from '#services/qos_wan_queues'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { FakeCollector, device, reading } from '#tests/helpers/collector_agent'
import { PROBE, resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import { sqmFixtureConfig } from '#tests/helpers/uci'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const CAPPED = '02:00:00:00:00:21'
const VOUCHER = '02:00:00:00:00:22'
const GUEST = '02:00:00:00:0a:07'
const T0 = DateTime.utc().minus({ minutes: 5 }).startOf('second')

async function usedBytes(id: number): Promise<number> {
  const row = await QosAssignment.findOrFail(id)
  return Number(row.quotaUsedBytes)
}

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

function post(client: ApiClient, token: string, path: string, body: Record<string, unknown>) {
  return client.post(`/api/v1/qos/${path}`).bearerToken(token).json(body)
}

/** A `qos` push section (plan 3 section 6) at a counter level. */
function qosSection(
  level: number,
  options: {
    epoch?: string
    quotaUsed?: number
    exhausted?: boolean
    devicesRevision?: number
  } = {}
) {
  return {
    epoch: options.epoch ?? 'boot-1',
    state: 'active',
    pausedBy: null,
    configRevision: 0,
    devicesRevision: options.devicesRevision ?? 1,
    wan: [
      {
        device: 'wan0',
        egress: {
          kind: 'cake',
          bandwidthKbit: 10000,
          bytes: 1_000_000 + level * 625_000,
          packets: 1000 + level * 500,
          drops: level,
          overlimits: 0,
          backlogBytes: 0,
          ecnMarks: 0,
          peakDelayUs: 1500,
        },
        ingress: {
          kind: 'cake',
          bandwidthKbit: 50000,
          bytes: 2_000_000 + level * 3_125_000,
          packets: 2000 + level * 2000,
          drops: 0,
          overlimits: 0,
          backlogBytes: 0,
          ecnMarks: null,
          peakDelayUs: null,
        },
      },
    ],
    classes: [
      // 1250 kB per 5 s = 2000 kbit/s down, 625 kB = 1000 kbit/s up.
      {
        id: '1:200',
        key: `d:${CAPPED}`,
        dir: 'down',
        rateKbit: 64,
        ceilKbit: 2000,
        bytes: level * 1_250_000,
        packets: level * 1000,
        drops: level * 10,
        overlimits: 0,
        backlogBytes: 0,
      },
      {
        id: '1:200',
        key: `d:${CAPPED}`,
        dir: 'up',
        rateKbit: 64,
        ceilKbit: 1000,
        bytes: level * 625_000,
        packets: level * 500,
        drops: 0,
        overlimits: 0,
        backlogBytes: 0,
      },
      {
        id: '1:2',
        key: 'b:1',
        dir: 'down',
        rateKbit: 50000,
        ceilKbit: 50000,
        bytes: level * 3_125_000,
        packets: 0,
        drops: 0,
        overlimits: 0,
        backlogBytes: 0,
      },
      {
        id: '1:2',
        key: 'b:1',
        dir: 'up',
        rateKbit: 10000,
        ceilKbit: 10000,
        bytes: level * 625_000,
        packets: 0,
        drops: 0,
        overlimits: 0,
        backlogBytes: 0,
      },
      {
        id: '1:201',
        key: `d:${GUEST}`,
        dir: 'down',
        rateKbit: 64,
        ceilKbit: 5000,
        bytes: level * 625_000,
        packets: level * 400,
        drops: 0,
        overlimits: 0,
        backlogBytes: 0,
      },
      {
        id: '1:201',
        key: `d:${GUEST}`,
        dir: 'up',
        rateKbit: 64,
        ceilKbit: 1000,
        bytes: level * 62_500,
        packets: level * 50,
        drops: 0,
        overlimits: 0,
        backlogBytes: 0,
      },
    ],
    devices: [
      { mac: CAPPED, classId: '1:200', network: 'lan', dynamic: false },
      { mac: VOUCHER, classId: '1:102', network: 'guest', dynamic: false, state: 'shaped' },
      { mac: GUEST, classId: '1:201', network: 'guest', dynamic: true },
    ],
    quotas: [
      {
        mac: VOUCHER,
        usedBytes: options.quotaUsed ?? 1000,
        limitBytes: 50_000_000,
        exhausted: options.exhausted ?? false,
      },
    ],
    schedules: [{ name: 's1', active: false, since: null, until: '2026-09-23T18:00:00Z' }],
    errors: [],
  }
}

/** A `collector.push` with the traffic and the `qos` section, received at T0 + seconds. */
function push(collectorId: number, seconds: number, qos: Record<string, unknown>) {
  return handleCollectorPush(
    collectorId,
    { ...reading([device(CAPPED, { bytesIn: 1000 + seconds, bytesOut: 2000 })]), qos },
    { receivedAt: T0.plus({ seconds }) }
  )
}

async function setup(client: ApiClient) {
  const tokens = await seedSetupComplete()
  const { gateway, collector } = await seedQosGateway({ agent: true, wanInterfaces: ['wan0'] })
  const { adminToken } = tokens
  const guest = bodyOf(
    await post(client, adminToken, 'policies', {
      name: 'Guest',
      shared: { downloadKbit: 50000, uploadKbit: 10000 },
      each: { downloadKbit: 5000, uploadKbit: 1000 },
    })
  ).data
  const capped = bodyOf(
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: CAPPED },
      rate: { downloadKbit: 2000, uploadKbit: 1000 },
    })
  ).data
  const voucher = bodyOf(
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: VOUCHER },
      policyId: guest.id,
      quota: {
        limitBytes: 50_000_000,
        onExhausted: 'throttle',
        throttle: { downloadKbit: 256, uploadKbit: 128 },
      },
    })
  ).data
  await post(client, adminToken, 'assignments', {
    target: { type: 'network', network: 'guest' },
    policyId: guest.id,
  })
  const agent = await FakeCollector.connect({
    handlers: {
      'qos.probe': () => PROBE,
      'qos.devices.set': (params) => ({
        revision: params.revision,
        accepted: (params.devices as unknown[]).length,
        rejected: [],
      }),
    },
  })
  await agent.hello()
  await agent.waitFor('qos.devices.set')
  await flushQosSync()
  return { ...tokens, gateway, collector, guest, capped, voucher, agent }
}

test.group('qos | live ingest (WP-D)', (group) => {
  let agent: FakeCollector | null = null
  group.each.setup(async () => {
    await resetQosTests()
    return async () => {
      await agent?.close()
      agent = null
    }
  })

  test('the push section feeds /qos, /qos/devices, /devices/:mac/shaping and /devices', async ({
    client,
    assert,
  }) => {
    const seeded = await setup(client)
    agent = seeded.agent
    const { collector, operatorToken, guest, capped } = seeded
    await recordRouterSqm(seeded.gateway.id, sqmFixtureConfig('live-layer-cake.uci'))

    const first = await push(collector.id, 0, qosSection(0))
    assert.equal(first.status, 'ingested')
    await push(collector.id, 5, qosSection(1))

    // Device shaping, usage from the class counters (exact, per direction).
    const devices = await client.get('/api/v1/qos/devices').bearerToken(operatorToken)
    devices.assertStatus(200)
    const byMac = Object.fromEntries(bodyOf(devices).data.map((d: any) => [d.mac, d]))
    assert.containsSubset(byMac[CAPPED], {
      via: 'device',
      assignmentId: capped.id,
      policy: null,
      cap: { downloadKbit: 2000, uploadKbit: 1000 },
      bucket: null,
      state: 'enforced',
      classId: '1:200',
      dynamic: false,
      network: 'lan',
      usage: {
        downloadKbit: 2000,
        uploadKbit: 1000,
        dropPct: { download: 1, upload: 0 },
        source: 'class',
      },
    })
    assert.containsSubset(byMac[VOUCHER], {
      via: 'device',
      policy: { id: guest.id, name: 'Guest' },
      cap: { downloadKbit: 5000, uploadKbit: 1000 },
      bucket: {
        policyId: guest.id,
        name: 'Guest',
        rate: { downloadKbit: 50000, uploadKbit: 10000 },
      },
      state: 'enforced',
      // In the bucket's rest leaf: shared, so no per-device usage.
      classId: '1:102',
      routerState: 'shaped',
      usage: null,
      quota: { limitBytes: 50_000_000, onExhausted: 'throttle' },
    })
    // Dynamic: a guest the router capped from the network default.
    assert.containsSubset(byMac[GUEST], {
      via: 'network',
      dynamic: true,
      network: 'guest',
      cap: { downloadKbit: 5000, uploadKbit: 1000 },
      bucket: { policyId: guest.id },
      usage: { downloadKbit: 1000, uploadKbit: 100 },
    })
    assert.equal(bodyOf(devices).data[bodyOf(devices).data.length - 1].mac, GUEST)

    const one = await client
      .get(`/api/v1/devices/${CAPPED.toUpperCase()}/shaping`)
      .bearerToken(operatorToken)
    one.assertStatus(200)
    assert.equal(bodyOf(one).data.classId, '1:200')
    const none = await client
      .get('/api/v1/devices/02:00:00:00:99:99/shaping')
      .bearerToken(operatorToken)
    none.assertStatus(200)
    assert.isNull(bodyOf(none).data)
    const bad = await client.get('/api/v1/devices/nope/shaping').bearerToken(operatorToken)
    bad.assertStatus(422)

    // The overview: WAN live counters, bucket rates, counts, schedules.
    const overview = await client
      .get(`/api/v1/qos?collectorId=${collector.id}`)
      .bearerToken(operatorToken)
    overview.assertStatus(200)
    const view = bodyOf(overview).data
    assert.containsSubset(view, {
      counts: { shapedDevices: 2, dynamicDevices: 1, quotasExhausted: 0 },
      report: { epoch: 'boot-1', state: 'active', devicesRevision: 1 },
      schedules: { reported: [{ name: 's1', active: false }] },
    })
    assert.containsSubset(view.wan[0], {
      device: 'wan0',
      live: {
        egress: { kind: 'cake', bandwidthKbit: 10000, rateKbit: 1000, drops: 1, peakDelayUs: 1500 },
        ingress: { kind: 'cake', rateKbit: 5000 },
      },
    })
    const guestPolicy = view.policies.find((p: any) => p.id === guest.id)
    assert.containsSubset(guestPolicy.live, { downloadKbit: 5000, uploadKbit: 1000 })
    // The WAN queue list carries the same live counters.
    const queues = await client.get('/api/v1/qos/wan-queues').bearerToken(operatorToken)
    assert.equal(bodyOf(queues).data[0].live.egress.rateKbit, 1000)

    // /devices rows carry `shaping`, read per request.
    const list = await client.get('/api/v1/devices?range=1h').bearerToken(operatorToken)
    list.assertStatus(200)
    const row = bodyOf(list).data.find((d: any) => d.mac === CAPPED)
    assert.exists(row, 'the pushed device is listed')
    assert.containsSubset(row.shaping, { mac: CAPPED, state: 'enforced', classId: '1:200' })

    // A new epoch resets the rates (null until the next report).
    await push(collector.id, 10, qosSection(2, { epoch: 'boot-2' }))
    const after = await client.get(`/api/v1/devices/${CAPPED}/shaping`).bearerToken(operatorToken)
    assert.isNull(bodyOf(after).data.usage)
  })

  test('quota usage is persisted every quotaPersistSeconds and at once on exhaustion', async ({
    client,
    assert,
  }) => {
    const seeded = await setup(client)
    agent = seeded.agent
    const { collector, gateway, voucher, operatorToken } = seeded
    await updateQosSettings({ quotaPersistSeconds: 60 })
    const exhausted: Array<{ mac: string; sourceRef: string | null }> = []
    const stop = onQuotaExhausted((event) => exhausted.push(event))

    await recordQosReport(collector.id, qosSection(0, { quotaUsed: 1000 }), T0)
    assert.equal(await usedBytes(voucher.id), 1000)
    // Within the interval: not written.
    await recordQosReport(collector.id, qosSection(1, { quotaUsed: 2000 }), T0.plus({ seconds: 5 }))
    assert.equal(await usedBytes(voucher.id), 1000)
    // Exhaustion: written at once, the portal hears it once.
    await recordQosReport(
      collector.id,
      qosSection(2, { quotaUsed: 50_000_000, exhausted: true }),
      T0.plus({ seconds: 10 })
    )
    let row = await QosAssignment.findOrFail(voucher.id)
    assert.equal(Number(row.quotaUsedBytes), 50_000_000)
    assert.isNotNull(row.exhaustedAt)
    await recordQosReport(
      collector.id,
      qosSection(3, { quotaUsed: 50_000_000, exhausted: true }),
      T0.plus({ seconds: 15 })
    )
    assert.lengthOf(exhausted, 1)
    assert.containsSubset(exhausted[0], { mac: VOUCHER, sourceRef: null })

    const devices = await client.get('/api/v1/qos/devices').bearerToken(operatorToken)
    const voucherView = bodyOf(devices).data.find((d: any) => d.mac === VOUCHER)
    assert.equal(voucherView.state, 'exhausted')
    const overview = await client.get('/api/v1/qos').bearerToken(operatorToken)
    assert.equal(bodyOf(overview).data.counts.quotasExhausted, 1)

    // An admin reset is not overwritten by the router's old count until it
    // has accepted the entries carrying the reset.
    const reset = await client
      .post(`/api/v1/qos/assignments/${voucher.id}/quota/reset`)
      .bearerToken(seeded.adminToken)
      .json({})
    reset.assertStatus(200)
    await flushQosSync()
    await db
      .from('qos_gateway_states')
      .where('gateway_id', gateway.id)
      .update({
        devices_acked_at: T0.minus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm:ss'),
      })
    await persistQuotas(
      collector.id,
      gateway.id,
      [{ mac: VOUCHER, usedBytes: 50_000_000, limitBytes: 50_000_000, exhausted: true }],
      DateTime.utc(),
      { force: true }
    )
    row = await QosAssignment.findOrFail(voucher.id)
    assert.equal(Number(row.quotaUsedBytes), 0)
    assert.isNull(row.exhaustedAt)
    // The entry carries the reset for the agent.
    const lastSet = seeded.agent.calls.filter((c) => c.method === 'qos.devices.set').at(-1)!
    const entry = (lastSet.params.devices as any[]).find((d) => d.mac === VOUCHER)
    assert.isString(entry.quota.resetAt)
    stop()
  })

  test('qos.event: kept in a ring, quota_exhausted marks the assignment', async ({
    client,
    assert,
  }) => {
    const seeded = await setup(client)
    agent = seeded.agent
    const { collector, voucher, operatorToken } = seeded
    const heard: string[] = []
    const stop = onQuotaExhausted((event) => heard.push(event.mac))

    // Over the socket, like the agent sends it.
    seeded.agent.notifyServer('qos.event', {
      type: 'pool_exhausted',
      at: '2026-09-23T12:00:00Z',
      detail: { network: 'guest', limit: 1024 },
    })
    await eventually(
      () => qosLive(collector.id)?.events.length ?? 0,
      (n) => n >= 1
    )
    await handleQosEvent(collector.id, {
      type: 'quota_exhausted',
      at: '2026-09-23T12:00:05Z',
      mac: VOUCHER,
      detail: { usedBytes: 50_000_123 },
    })
    await handleQosEvent(collector.id, { nope: true })
    const row = await QosAssignment.findOrFail(voucher.id)
    assert.isNotNull(row.exhaustedAt)
    assert.equal(Number(row.quotaUsedBytes), 50_000_123)
    assert.deepEqual(heard, [VOUCHER])

    const overview = await client.get('/api/v1/qos').bearerToken(operatorToken)
    const events = bodyOf(overview).data.events
    assert.containsSubset(events, [
      { type: 'quota_exhausted', mac: VOUCHER },
      { type: 'pool_exhausted', detail: { network: 'guest', limit: 1024 } },
    ])
    stop()
  })
})
