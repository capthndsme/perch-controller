import { handleMetricsPush } from '#services/ap_agent_metrics'
import { ensureNodeFor } from '#services/infra_ports'
import { FakeAgent, eventually, seedAgentAp } from '#tests/helpers/ap_agent'
import {
  apPorts,
  closeAgentSessions,
  metricsPush,
  nodeFor,
  portReport,
  portRows,
  resetInfraTests,
  seedLink,
  seedManualNode,
} from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/** Receive times well in the past, one push per second (the AP's interval is set to 1 s). */
const T0 = DateTime.utc().minus({ minutes: 10 }).startOf('second')
const at = (seconds: number) => T0.plus({ seconds })
const sql = (time: DateTime) => time.toFormat('yyyy-MM-dd HH:mm:ss')

async function fastAp(overrides: Parameters<typeof seedAgentAp>[0] = {}) {
  const seeded = await seedAgentAp(overrides)
  await db.from('wifi_access_points').where('id', seeded.ap.id).update({ poll_interval_seconds: 1 })
  return seeded.ap
}

async function push(apId: number, seq: number, ports: unknown, seconds: number) {
  const outcome = await handleMetricsPush(apId, metricsPush(seq, ports), {
    receivedAt: at(seconds),
  })
  return outcome
}

async function apNodeId(apId: number): Promise<number> {
  const node = await nodeFor({ apId })
  if (!node) throw new Error(`AP ${apId} has no node`)
  return Number(node.id)
}

function dateOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

test.group('infra | port ingest over metrics.push', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('a push with ports creates the AP node and one row per port', async ({ assert }) => {
    const { ap, agentId, agentSecret } = await seedAgentAp({
      capabilities: ['metrics', 'clients', 'kick', 'locate', 'reboot', 'ports'],
    })
    const agent = await FakeAgent.connect({ agentId, agentSecret })
    await agent.waitFor('system.info')

    agent.notifyServer('metrics.push', metricsPush(1, apPorts({ lan2: { carrier: false } })))
    // The ports are the last write of a push: wait for all four rows.
    await eventually(
      () => db.from('infra_ports').select('id'),
      (rows) => rows.length === 4
    )

    const node = await nodeFor({ apId: ap.id })
    assert.equal(node.kind, 'access_point')
    assert.equal(node.origin, 'agent')
    assert.isNull(node.name, 'the display name follows the AP')
    assert.isNull(node.pos_x, 'agent nodes are created unplaced')
    const ports = await portRows(Number(node.id))
    assert.deepEqual(Object.keys(ports), ['wan', 'lan1', 'lan2', 'lan3'])
    assert.equal(ports.wan.origin, 'agent')
    assert.equal(ports.wan.reported_role, 'wan')
    assert.isNull(ports.wan.role, 'no operator override')
    assert.equal(ports.wan.reported_medium, 'copper')
    assert.equal(ports.wan.mac, '02:00:00:00:00:10')
    assert.equal(ports.lan1.position, 1)
    assert.equal(ports.lan1.speed_mbps, 1000)
    assert.equal(ports.lan1.duplex, 'full')
    assert.equal(Number(ports.lan1.carrier), 1)
    assert.equal(Number(ports.lan2.carrier), 0)
    assert.equal(ports.lan2.operstate, 'down')
    assert.isNull(ports.lan2.speed_mbps)
    assert.equal(Number(ports.lan3.present), 1)
    await agent.close()
  })

  test('an identical second push writes nothing', async ({ assert }) => {
    const ap = await fastAp()
    await push(ap.id, 1, apPorts(), 0)
    const nodeId = await apNodeId(ap.id)
    const before = await db.from('infra_ports').where('node_id', nodeId).orderBy('id')

    const second = await push(ap.id, 2, apPorts(), 2)
    assert.equal(second.status, 'ingested')
    const after = await db.from('infra_ports').where('node_id', nodeId).orderBy('id')
    assert.deepEqual(
      after.map((row) => [dateOf(row.updated_at), dateOf(row.reported_at)]),
      before.map((row) => [dateOf(row.updated_at), dateOf(row.reported_at)])
    )
    assert.deepEqual(after, before)
  })

  test('a changed carrier updates that port and its state_changed_at only', async ({ assert }) => {
    const ap = await fastAp()
    await push(ap.id, 1, apPorts({ lan2: { carrierChanges: 3 } }), 0)
    const nodeId = await apNodeId(ap.id)
    const before = await portRows(nodeId)

    await push(ap.id, 2, apPorts({ lan2: { carrier: false, carrierChanges: 4 } }), 2)
    const after = await portRows(nodeId)
    assert.equal(Number(after.lan2.carrier), 0)
    assert.equal(after.lan2.operstate, 'down')
    assert.isNull(after.lan2.speed_mbps)
    assert.equal(after.lan2.carrier_changes, 4)
    assert.notEqual(dateOf(after.lan2.state_changed_at), dateOf(before.lan2.state_changed_at))
    const changedAt = await db
      .from('infra_ports')
      .where('id', after.lan2.id)
      .where('state_changed_at', sql(at(2)))
      .first()
    assert.exists(changedAt, 'state_changed_at is the receive time of the push')
    for (const key of ['wan', 'lan1', 'lan3']) {
      assert.deepEqual(after[key], before[key], `${key} untouched`)
    }

    // Only the counter moved: a write, but no state change.
    await push(ap.id, 3, apPorts({ lan2: { carrier: false, carrierChanges: 5 } }), 4)
    const counted = await portRows(nodeId)
    assert.equal(counted.lan2.carrier_changes, 5)
    assert.equal(dateOf(counted.lan2.state_changed_at), dateOf(after.lan2.state_changed_at))
  })

  test('a push without ports (an older agent) changes nothing', async ({ assert }) => {
    const ap = await fastAp()
    await push(ap.id, 1, apPorts(), 0)
    const nodeId = await apNodeId(ap.id)
    const before = await db.from('infra_ports').where('node_id', nodeId).orderBy('id')

    for (const [seq, ports] of [
      [2, undefined],
      [3, null],
      [4, { wan: {} }],
      [5, 'none'],
    ] as const) {
      const outcome = await push(ap.id, seq, ports, seq * 2)
      assert.equal(outcome.status, 'ingested')
    }
    assert.deepEqual(await db.from('infra_ports').where('node_id', nodeId).orderBy('id'), before)
  })

  test('an old agent never creates a node from its pushes', async ({ assert }) => {
    const ap = await fastAp()
    await push(ap.id, 1, undefined, 0)
    assert.isNull(await nodeFor({ apId: ap.id }))
    assert.lengthOf(await db.from('infra_ports').select('id'), 0)
  })

  test('a missing port keeps its cable; an unclaimed one is pruned', async ({ assert }) => {
    const ap = await fastAp()
    await push(ap.id, 1, apPorts(), 0)
    const nodeId = await apNodeId(ap.id)
    const switchNode = await seedManualNode('switch', 'Switch', ['1', '2'])
    const ports = await portRows(nodeId)
    const linkId = await seedLink(ports.lan3.id, switchNode.ports['1'])
    await db.from('infra_ports').where('id', ports.lan1.id).update({ label: 'Office' })

    // lan1 (labelled), lan2 (nothing) and lan3 (cabled) disappear.
    await push(ap.id, 2, [portReport('wan', { role: 'wan' })], 2)
    const after = await portRows(nodeId)
    assert.notProperty(after, 'lan2', 'nothing of the operator on it: deleted')
    assert.equal(Number(after.lan3.present), 0)
    assert.exists(
      await db
        .from('infra_ports')
        .where('id', ports.lan3.id)
        .where('missing_since', sql(at(2)))
        .first()
    )
    assert.equal(Number(after.lan1.present), 0, 'the label keeps it')
    assert.exists(await db.from('infra_links').where('id', linkId).first(), 'the cable stays')

    // Still missing: missing_since is the first time only.
    await push(ap.id, 3, [portReport('wan', { role: 'wan', carrier: false })], 4)
    assert.exists(
      await db
        .from('infra_ports')
        .where('id', ports.lan3.id)
        .where('missing_since', sql(at(2)))
        .first()
    )

    // Back again: present, no missing_since, same row and cable.
    await push(ap.id, 4, apPorts(), 6)
    const back = await portRows(nodeId)
    assert.equal(back.lan3.id, ports.lan3.id)
    assert.equal(Number(back.lan3.present), 1)
    assert.isNull(back.lan3.missing_since)
    assert.exists(await db.from('infra_links').where('id', linkId).first())
    assert.notEqual(back.lan2.id, ports.lan2.id, 'the pruned port comes back as a new row')
  })

  test('"ports": [] means no ports: every unclaimed agent port goes', async ({ assert }) => {
    const ap = await fastAp()
    await push(ap.id, 1, apPorts(), 0)
    const nodeId = await apNodeId(ap.id)
    await push(ap.id, 2, [], 2)
    assert.deepEqual(await portRows(nodeId), {})
    assert.exists(await nodeFor({ apId: ap.id }), 'the node stays')
  })

  test('a port pinned by hand is adopted when the agent reports its key', async ({ assert }) => {
    const ap = await fastAp()
    const nodeId = (await ensureNodeFor({ type: 'ap', id: ap.id }))!
    const now = sql(DateTime.utc())
    const [pinnedId] = await db.table('infra_ports').insert({
      node_id: nodeId,
      port_key: 'WAN',
      origin: 'manual',
      label: 'Uplink',
      role: 'wan',
      medium: 'sfp',
      position: 7,
      hidden: false,
      present: true,
      created_at: now,
      updated_at: now,
    })
    const switchNode = await seedManualNode('switch', 'Switch', ['1'])
    const linkId = await seedLink(Number(pinnedId), switchNode.ports['1'])

    await push(ap.id, 1, apPorts(), 0)
    const ports = await portRows(nodeId)
    assert.deepEqual(Object.keys(ports), ['wan', 'lan1', 'lan2', 'lan3'])
    assert.equal(ports.wan.id, Number(pinnedId), 'same row')
    assert.equal(ports.wan.origin, 'agent')
    assert.equal(ports.wan.label, 'Uplink', "the operator's label stays")
    assert.equal(ports.wan.role, 'wan', "the operator's role stays")
    assert.isNull(ports.wan.medium, "the agent's medium from now on")
    assert.equal(ports.wan.reported_medium, 'copper')
    assert.equal(ports.wan.position, 0, 'the report order')
    assert.equal(Number(ports.wan.carrier), 1)
    assert.exists(await db.from('infra_links').where('id', linkId).first(), 'the cable stays')
  })

  test('65 ports are capped at 64; junk entries are dropped', async ({ assert }) => {
    const ap = await fastAp()
    const many = Array.from({ length: 65 }, (_, i) => portReport(`lan${i + 1}`))
    await push(ap.id, 1, many, 0)
    const nodeId = await apNodeId(ap.id)
    assert.lengthOf(Object.keys(await portRows(nodeId)), 64)

    const other = await fastAp({ name: 'ap-porch', macs: ['02:00:00:00:00:30'] })
    await push(
      other.id,
      1,
      [
        portReport('wan', { role: 'wan' }),
        'junk',
        { label: 'no name' },
        { name: 'lan 1' },
        { name: 'lan1', role: 'dmz', speedMbps: -1, medium: 'coax', carrier: 'yes' },
      ],
      0
    )
    const ports = await portRows(await apNodeId(other.id))
    assert.deepEqual(Object.keys(ports), ['wan', 'lan1'])
    assert.isNull(ports.lan1.reported_role)
    assert.isNull(ports.lan1.speed_mbps)
    assert.isNull(ports.lan1.reported_medium)
    assert.isNull(ports.lan1.carrier)
  })

  test('only accepted pushes write ports', async ({ assert }) => {
    const { ap } = await seedAgentAp()
    const first = await handleMetricsPush(ap.id, metricsPush(1, apPorts()), { receivedAt: T0 })
    assert.equal(first.status, 'ingested')
    const nodeId = await apNodeId(ap.id)

    // 15 s interval: a push 5 s later is dropped, ports included.
    const early = await handleMetricsPush(
      ap.id,
      metricsPush(2, apPorts({ lan1: { carrier: false } })),
      { receivedAt: T0.plus({ seconds: 5 }) }
    )
    assert.deepEqual(early, { status: 'dropped', reason: 'too_early' })
    const kept = await portRows(nodeId)
    assert.equal(Number(kept.lan1.carrier), 1)

    const disabled = await fastAp({ name: 'ap-off', enabled: false, macs: ['02:00:00:00:00:40'] })
    const dropped = await push(disabled.id, 1, apPorts(), 0)
    assert.deepEqual(dropped, { status: 'dropped', reason: 'disabled' })
    assert.isNull(await nodeFor({ apId: disabled.id }))
  })

  test('a failing port write never costs the Wi-Fi ingest', async ({ assert }) => {
    const ap = await fastAp()
    await db.rawQuery('RENAME TABLE infra_ports TO infra_ports_unavailable')
    try {
      const outcome = await push(ap.id, 1, apPorts(), 0)
      assert.equal(outcome.status, 'ingested')
      assert.notEqual(outcome.status === 'ingested' && outcome.outcome.status, 'failed')
      const row = await db.from('wifi_access_points').where('id', ap.id).first()
      assert.isNotNull(row.last_seen_at, 'the Wi-Fi ingest ran')
      assert.lengthOf(await db.from('ap_system_snapshots').where('ap_id', ap.id), 1)
    } finally {
      await db.rawQuery('RENAME TABLE infra_ports_unavailable TO infra_ports')
    }

    // Not remembered as written: the next identical push writes the ports.
    await push(ap.id, 2, apPorts(), 2)
    assert.lengthOf(Object.keys(await portRows(await apNodeId(ap.id))), 4)
  })
})
