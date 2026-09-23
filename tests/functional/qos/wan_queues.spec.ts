import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewaySection from '#models/gateway_section'
import InfraNode from '#models/infra_node'
import InfraPort from '#models/infra_port'
import QosWanQueue from '#models/qos_wan_queue'
import { recordRouterSqm } from '#services/qos_wan_queues'
import {
  setSqmPlaneWriter,
  SqmPlaneError,
  type SqmPlaneAccepted,
  type SqmPlaneWriter,
  type SqmQueueChange,
  type StubSqmPlaneWriter,
} from '#services/sqm_plane'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import { sqmFixture, sqmFixtureConfig } from '#tests/helpers/uci'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

/** A plane that accepts every change (what the config plane will do once it exists). */
class AcceptingWriter implements SqmPlaneWriter {
  readonly changes: SqmQueueChange[] = []
  revision = 7
  async submit(change: SqmQueueChange): Promise<SqmPlaneAccepted> {
    this.changes.push(change)
    return {
      perchId: change.perchId ?? 'k2v9',
      uciSection: change.uciSection,
      revision: ++this.revision,
    }
  }
}

let stub: StubSqmPlaneWriter

test.group('qos | wan queues: reads and the router import', (group) => {
  group.each.setup(async () => {
    stub = await resetQosTests()
  })

  test('the live queue is imported as it is, origin router (S0)', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const { gateway, collector } = await seedQosGateway({ mode: 'observe' })
    const result = await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
    assert.deepEqual(result, { created: 1, updated: 0, removed: 0, paused: [], resumed: [] })

    const response = await client
      .get(`/api/v1/qos/wan-queues?collectorId=${collector.id}`)
      .bearerToken(operatorToken)
    response.assertStatus(200)
    const [queue] = bodyOf(response).data
    const { options } = sqmFixture('live-layer-cake.uci')
    assert.containsSubset(queue, {
      gatewayId: gateway.id,
      collectorId: collector.id,
      device: 'wan0',
      enabled: true,
      downloadKbit: 970000,
      uploadKbit: 970000,
      qdisc: 'cake',
      diffserv: 'diffserv3',
      fairness: 'per_host',
      nat: true,
      linkLayer: 'none',
      overhead: null,
      uciSection: 'eth1',
      perchId: null,
      origin: 'router',
      flags: [],
      pausedByRouter: null,
      live: null,
    })
    assert.deepEqual(queue.options, options)
    // Not in the config plane's tables yet: in sync with what the router reported.
    assert.equal(queue.sync.state, 'in_sync')
    assert.equal(queue.sync.revision, 0)

    // The same read again changes nothing; `gatewayId` addresses it too.
    const again = await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
    assert.equal(again.updated, 0)
    const byGateway = await client
      .get(`/api/v1/qos/wan-queues?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    assert.lengthOf(bodyOf(byGateway).data, 1)
    // With one gateway, naming it is optional.
    const implicit = await client.get('/api/v1/qos/wan-queues').bearerToken(operatorToken)
    assert.lengthOf(bodyOf(implicit).data, 1)
  })

  test('router edits flow in; a router-side disable is a loud pause (decision 15)', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const config = sqmFixtureConfig('live-layer-cake.uci')
    await recordRouterSqm(gateway.id, config, DateTime.utc().minus({ minutes: 5 }))

    const edited = structuredClone(config)
    edited.sections[0].options.download = '800000'
    const at = DateTime.utc().startOf('second')
    const r1 = await recordRouterSqm(gateway.id, edited, at, { eth1: 'k2v9' })
    assert.equal(r1.updated, 1)
    let row = await QosWanQueue.findByOrFail('gatewayId', gateway.id)
    assert.equal(row.options.download, '800000')
    assert.equal(row.perchId, 'k2v9')
    assert.equal(row.routerUpdatedAt!.toMillis(), at.toMillis())

    const paused = structuredClone(edited)
    paused.sections[0].options.enabled = '0'
    const r2 = await recordRouterSqm(gateway.id, paused, at.plus({ minutes: 1 }))
    assert.deepEqual(r2.paused, [row.id])
    const response = await client
      .get(`/api/v1/qos/wan-queues?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    const [queue] = bodyOf(response).data
    assert.isFalse(queue.enabled)
    assert.include(queue.flags, 'router_paused')
    assert.equal(queue.pausedByRouter.at, at.plus({ minutes: 1 }).toISO())

    const resumed = await recordRouterSqm(gateway.id, edited, at.plus({ minutes: 2 }))
    assert.deepEqual(resumed.resumed, [row.id])
    row = await QosWanQueue.findByOrFail('gatewayId', gateway.id)
    assert.isNull(row.routerPausedAt)

    // A queue that was never on is not a pause.
    const off = structuredClone(config)
    off.sections.push({
      name: 'wan2',
      type: 'queue',
      anonymous: false,
      index: 1,
      options: { enabled: '0', interface: 'wan2', qdisc: 'cake' },
    })
    const r3 = await recordRouterSqm(gateway.id, off)
    assert.equal(r3.created, 1)
    assert.deepEqual(r3.paused, [])

    // Sections that vanish are removed; other configs' sections are ignored.
    const r4 = await recordRouterSqm(gateway.id, { name: 'sqm', hash: 'x', sections: [] })
    assert.equal(r4.removed, 2)
    assert.lengthOf(await QosWanQueue.query().where('gatewayId', gateway.id), 0)
  })

  test('sync state follows the config plane section', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
    const content = { type: 'queue', options: sqmFixture('live-layer-cake.uci').options }
    await GatewaySection.create({
      gatewayId: gateway.id,
      perchId: 'k2v9',
      config: 'sqm',
      sectionName: 'eth1',
      sectionType: 'queue',
      scope: 'synced',
      domain: 'sqm',
      baseContent: content,
      routerContent: content,
      desiredContent: content,
      status: 'drift',
    } as Partial<GatewaySection>)
    await Gateway.query().where('id', gateway.id).update({ head_revision: 4 })
    const response = await client
      .get(`/api/v1/qos/wan-queues?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    const [queue] = bodyOf(response).data
    assert.equal(queue.sync.state, 'drift')
    assert.equal(queue.sync.revision, 4)
  })

  test('two enabled queues on one device are both kept and flagged', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const config = sqmFixtureConfig('live-layer-cake.uci')
    config.sections.push({ ...structuredClone(config.sections[0]), name: 'copy', index: 1 })
    config.sections.push({
      ...structuredClone(sqmFixtureConfig('router-sfq.uci').sections[0]),
      index: 2,
    })
    await recordRouterSqm(gateway.id, config)
    const response = await client
      .get(`/api/v1/qos/wan-queues?gatewayId=${gateway.id}`)
      .bearerToken(operatorToken)
    const flags = Object.fromEntries(bodyOf(response).data.map((q: any) => [q.uciSection, q.flags]))
    assert.deepEqual(flags, {
      eth1: ['duplicate_device'],
      copy: ['duplicate_device'],
      lan_test: ['qdisc_unmodeled'],
    })
  })

  test('gateway addressing refusals', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const missing = await client
      .get('/api/v1/qos/wan-queues?collectorId=999')
      .bearerToken(operatorToken)
    missing.assertStatus(404)
    assert.equal(bodyOf(missing).error, 'collector_not_found')

    // seedSetupComplete made a plain collector without a gateway row.
    const plain = await Collector.firstOrFail()
    const notGateway = await client
      .get(`/api/v1/qos/wan-queues?collectorId=${plain.id}`)
      .bearerToken(operatorToken)
    notGateway.assertStatus(409)
    assert.equal(bodyOf(notGateway).error, 'qos_not_gateway')
    const none = await client.get('/api/v1/qos/wan-queues').bearerToken(operatorToken)
    none.assertStatus(409)
    assert.equal(bodyOf(none).error, 'qos_not_gateway')

    const noGateway = await client
      .get('/api/v1/qos/wan-queues?gatewayId=999')
      .bearerToken(operatorToken)
    noGateway.assertStatus(404)
    assert.equal(bodyOf(noGateway).error, 'gateway_not_found')

    await seedQosGateway({ name: 'gw-a' })
    await seedQosGateway({ name: 'gw-b' })
    const ambiguous = await client.get('/api/v1/qos/wan-queues').bearerToken(operatorToken)
    ambiguous.assertStatus(422)
    assert.equal(bodyOf(ambiguous).error, 'qos_gateway_required')

    const invalid = await client
      .get('/api/v1/qos/wan-queues?gatewayId=abc')
      .bearerToken(operatorToken)
    invalid.assertStatus(422)
  })

  test('deleting the gateway removes its queues', async ({ assert }) => {
    const { gateway } = await seedQosGateway()
    await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
    await gateway.delete()
    assert.lengthOf(await QosWanQueue.all(), 0)
    assert.lengthOf(stub.recorded, 0)
  })
})

test.group('qos | wan queues: writes through the stubbed config plane', (group) => {
  group.each.setup(async () => {
    stub = await resetQosTests()
  })

  test('create: refusals in order, then 409 plane_unavailable with the intended change', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway({ mode: 'observe', wanInterfaces: ['wan0', 'wan2'] })
    const post = (body: Record<string, unknown>) =>
      client.post('/api/v1/qos/wan-queues').bearerToken(adminToken).json(body)

    const invalid = await post({ gatewayId: gateway.id, device: 'bad name', downloadKbit: -1 })
    invalid.assertStatus(422)
    assert.isArray(bodyOf(invalid).errors)

    const body = { gatewayId: gateway.id, device: 'wan2', downloadKbit: 50000, uploadKbit: 10000 }
    const notManaged = await post(body)
    notManaged.assertStatus(409)
    assert.equal(bodyOf(notManaged).error, 'qos_not_managed')

    await Gateway.query().where('id', gateway.id).update({ mode: 'managed' })
    const unknown = await post({ ...body, device: 'eth9' })
    unknown.assertStatus(422)
    assert.containsSubset(bodyOf(unknown), {
      error: 'qos_unknown_device',
      device: 'eth9',
      known: ['wan0', 'wan2'],
    })

    const floor = await post({ ...body, uploadKbit: 500 })
    floor.assertStatus(422)
    assert.containsSubset(bodyOf(floor), {
      error: 'qos_rate_below_floor',
      field: 'uploadKbit',
      min: 1000,
    })

    const mapping = await post({ ...body, overhead: 44 })
    mapping.assertStatus(422)
    assert.equal(bodyOf(mapping).error, 'qos_overhead_needs_linklayer')

    const typed = await post({ ...body, advanced: { download: '1' } })
    typed.assertStatus(422)
    assert.equal(bodyOf(typed).error, 'qos_option_has_field')

    const refused = await post({ ...body, advanced: { tcMTU: '1500' } })
    refused.assertStatus(409)
    const refusal = bodyOf(refused)
    assert.equal(refusal.error, 'plane_unavailable')
    assert.deepEqual(refusal.warnings, [])
    assert.containsSubset(refusal.intended, {
      action: 'create',
      queueId: null,
      uciSection: null,
      options: {
        enabled: '1',
        interface: 'wan2',
        download: '50000',
        upload: '10000',
        qdisc: 'cake',
        script: 'piece_of_cake.qos',
        eqdisc_opts: 'nat dual-srchost',
        iqdisc_opts: 'nat dual-dsthost ingress',
        tcMTU: '1500',
      },
    })
    assert.lengthOf(stub.recorded, 1)
    assert.equal(stub.recorded[0].gatewayId, gateway.id)
    assert.lengthOf(await QosWanQueue.all(), 0)
  })

  test('create: a device already shaped is refused; sqm-scripts must be installed', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
    const duplicate = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(adminToken)
      .json({ gatewayId: gateway.id, device: 'wan0', downloadKbit: 50000, uploadKbit: 10000 })
    duplicate.assertStatus(409)
    assert.equal(bodyOf(duplicate).error, 'qos_duplicate_device')
    // A disabled one may sit beside it.
    const disabled = await client.post('/api/v1/qos/wan-queues').bearerToken(adminToken).json({
      gatewayId: gateway.id,
      device: 'wan0',
      downloadKbit: 50000,
      uploadKbit: 10000,
      enabled: false,
    })
    assert.equal(bodyOf(disabled).error, 'plane_unavailable')

    const bare = await seedQosGateway({ name: 'bare', packages: { dnsmasq: '2.90' } })
    const missing = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(adminToken)
      .json({ gatewayId: bare.gateway.id, device: 'wan0', downloadKbit: 50000, uploadKbit: 10000 })
    missing.assertStatus(409)
    assert.containsSubset(bodyOf(missing), {
      error: 'qos_capability_missing',
      missing: ['sqm-scripts'],
    })
  })

  test('the router ports count as devices (infrastructure view)', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway, collector } = await seedQosGateway()
    const node = await InfraNode.create({
      kind: 'router',
      name: 'Router',
      collectorId: collector.id,
      origin: 'agent',
    } as Partial<InfraNode>)
    await InfraPort.create({
      nodeId: node.id,
      portKey: 'lan4',
      origin: 'agent',
    } as Partial<InfraPort>)
    const response = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(adminToken)
      .json({ gatewayId: gateway.id, device: 'lan4', downloadKbit: 50000, uploadKbit: 10000 })
    assert.equal(bodyOf(response).error, 'plane_unavailable')
  })

  test('update: only the mapped options change; no-op patches skip the plane', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    await recordRouterSqm(gateway.id, sqmFixtureConfig('unknown-options.uci'), undefined, {
      wan: 'k2v9',
    })
    await Collector.query()
      .whereNotNull('id')
      .update({
        last_status: JSON.stringify({
          ok: true,
          checkedAt: new Date().toISOString(),
          gateway: {
            reportedAt: new Date().toISOString(),
            wanInterfaces: ['wan'],
            wanSource: 'default-route',
          },
        }),
      })
    const queue = await QosWanQueue.findByOrFail('gatewayId', gateway.id)
    const patch = (body: Record<string, unknown>, id = queue.id) =>
      client.patch(`/api/v1/qos/wan-queues/${id}`).bearerToken(adminToken).json(body)

    const notFound = await patch({ downloadKbit: 1000 }, 9999)
    notFound.assertStatus(404)
    assert.containsSubset(bodyOf(notFound), { error: 'qos_not_found', resource: 'wan_queue' })

    const moved = await patch({ gatewayId: gateway.id })
    moved.assertStatus(422)
    assert.equal(bodyOf(moved).error, 'qos_field_not_applicable')

    const same = await patch({ downloadKbit: 300000, fairness: 'per_host' })
    same.assertStatus(200)
    assert.equal(bodyOf(same).data.queue.id, queue.id)
    assert.lengthOf(stub.recorded, 0)

    const cakeOnly = await patch({ qdisc: 'fq_codel', nat: true })
    cakeOnly.assertStatus(422)
    assert.equal(bodyOf(cakeOnly).error, 'qos_field_needs_cake')

    const refused = await patch({ downloadKbit: 250000, advanced: { future_option: null } })
    refused.assertStatus(409)
    assert.containsSubset(bodyOf(refused), {
      error: 'plane_unavailable',
      intended: {
        action: 'update',
        queueId: queue.id,
        uciSection: 'wan',
        changed: ['download', 'future_option'],
      },
    })
    assert.equal(stub.recorded[0].perchId, 'k2v9')
    assert.deepEqual(stub.recorded[0].options!.future_list, ['a', 'b'])
    assert.notProperty(stub.recorded[0].options!, 'future_option')
    // Nothing stored.
    const after = await QosWanQueue.findOrFail(queue.id)
    assert.equal(after.options.download, '300000')
  })

  test('delete: refused by the stub, the row stays', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    await recordRouterSqm(gateway.id, sqmFixtureConfig('live-layer-cake.uci'))
    const queue = await QosWanQueue.findByOrFail('gatewayId', gateway.id)
    const response = await client
      .delete(`/api/v1/qos/wan-queues/${queue.id}`)
      .bearerToken(adminToken)
    response.assertStatus(409)
    assert.containsSubset(bodyOf(response), {
      error: 'plane_unavailable',
      intended: { action: 'delete', queueId: queue.id, uciSection: 'eth1', options: null },
    })
    assert.isNotNull(await QosWanQueue.find(queue.id))
    const missing = await client.delete('/api/v1/qos/wan-queues/9999').bearerToken(adminToken)
    missing.assertStatus(404)
  })

  test('a plane refusal of its own passes through', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    setSqmPlaneWriter({
      async submit() {
        throw new SqmPlaneError(409, 'apply_in_flight', 'An apply is running.', { applyId: 'a1' })
      },
    })
    const response = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(adminToken)
      .json({ gatewayId: gateway.id, device: 'wan0', downloadKbit: 50000, uploadKbit: 10000 })
    response.assertStatus(409)
    assert.containsSubset(bodyOf(response), { error: 'apply_in_flight', applyId: 'a1' })
  })
})

test.group('qos | wan queues: writes once the plane accepts them', (group) => {
  let writer: AcceptingWriter
  group.each.setup(async () => {
    await resetQosTests()
    writer = new AcceptingWriter()
    setSqmPlaneWriter(writer)
  })

  test('create, update and delete store the desired state', async ({ client, assert }) => {
    const { adminToken, adminId } = await seedSetupComplete()
    const { gateway, collector } = await seedQosGateway()

    const created = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(adminToken)
      .json({ collectorId: collector.id, device: 'wan0', downloadKbit: 50000, uploadKbit: 10000 })
    created.assertStatus(201)
    const { queue, warnings } = bodyOf(created).data
    assert.deepEqual(warnings, [])
    assert.containsSubset(queue, {
      gatewayId: gateway.id,
      device: 'wan0',
      downloadKbit: 50000,
      uploadKbit: 10000,
      diffserv: 'besteffort',
      fairness: 'per_host',
      nat: true,
      origin: 'controller',
      uciSection: null,
      perchId: 'k2v9',
    })
    // Not applied yet, and the agent is not connected in this test.
    assert.equal(queue.sync.state, 'offline')
    assert.equal(writer.changes[0].userId, adminId)

    const updated = await client
      .patch(`/api/v1/qos/wan-queues/${queue.id}`)
      .bearerToken(adminToken)
      .json({ diffserv: 'diffserv4', linkLayer: 'ethernet', overhead: 44 })
    updated.assertStatus(200)
    assert.containsSubset(bodyOf(updated).data.queue, {
      diffserv: 'diffserv4',
      linkLayer: 'ethernet',
      overhead: 44,
    })
    assert.deepEqual(writer.changes[1].changed, [
      'eqdisc_opts',
      'iqdisc_opts',
      'linklayer',
      'overhead',
      'script',
    ])

    const deleted = await client
      .delete(`/api/v1/qos/wan-queues/${queue.id}`)
      .bearerToken(adminToken)
    deleted.assertStatus(204)
    assert.isNull(await QosWanQueue.find(queue.id))
    assert.equal(writer.changes[2].action, 'delete')
  })

  test('a rate far below what the WAN carried is a warning (single WAN)', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { gateway } = await seedQosGateway()
    const now = DateTime.utc()
    await db.table('router_samples').multiInsert(
      Array.from({ length: 20 }, (_, i) => ({
        recorded_at: now.minus({ minutes: i }).toFormat('yyyy-MM-dd HH:mm:ss'),
        wan_rx_bps: 400_000_000,
        wan_tx_bps: 40_000_000,
      }))
    )
    const response = await client
      .post('/api/v1/qos/wan-queues')
      .bearerToken(adminToken)
      .json({ gatewayId: gateway.id, device: 'wan0', downloadKbit: 100000, uploadKbit: 30000 })
    response.assertStatus(201)
    assert.deepEqual(
      bodyOf(response).data.warnings.map((w: any) => [w.code, w.field, w.observedKbit]),
      [['qos_rate_far_below_observed', 'downloadKbit', 400000]]
    )
  })
})
