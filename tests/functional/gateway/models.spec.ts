import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import GatewayRevision from '#models/gateway_revision'
import GatewaySecret from '#models/gateway_secret'
import GatewaySection from '#models/gateway_section'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function seedGateway(): Promise<Gateway> {
  const collector = await Collector.create({
    name: 'gateway',
    baseUrl: null,
    pollIntervalSeconds: 5,
    enabled: true,
    lifecycle: 'adopted',
    source: 'announced',
  } as Partial<Collector>)
  return Gateway.create({
    collectorId: collector.id,
    mode: 'observe',
    capabilities: { protocol: 1, access: 'read', transportOk: true },
    managementPath: { network: 'lan', device: 'br-lan' },
  })
}

test.group('gateway models', (group) => {
  group.each.setup(resetDb)

  test('JSON columns round-trip and default columns hold their defaults', async ({ assert }) => {
    const created = await seedGateway()
    const gateway = await Gateway.findOrFail(created.id)
    assert.deepEqual(gateway.capabilities, { protocol: 1, access: 'read', transportOk: true })
    assert.deepEqual(gateway.managementPath, { network: 'lan', device: 'br-lan' })
    assert.isNull(gateway.pinnedHashes)
    assert.equal(gateway.headRevision, 0)
    assert.equal(gateway.syncState, 'unknown')
    assert.equal(gateway.enforcement, 'active')
    assert.isFalse(Boolean(gateway.authoritative))

    const content = { type: 'host', options: { mac: '02:00:00:00:00:01', ip: '192.168.1.50' } }
    await GatewaySection.create({
      gatewayId: gateway.id,
      perchId: 'h1',
      config: 'dhcp',
      sectionName: 'perch_h1',
      sectionType: 'host',
      scope: 'synced',
      domain: 'dhcp_hosts',
      ownership: { kind: 'options', options: ['mac', 'ip'] },
      baseContent: content,
      routerContent: content,
      desiredContent: null,
      status: 'in_sync',
    })
    const section = await GatewaySection.findByOrFail('perchId', 'h1')
    assert.deepEqual(section.baseContent, content)
    assert.isNull(section.desiredContent)
    assert.deepEqual(section.ownership, { kind: 'options', options: ['mac', 'ip'] })

    const apply = await GatewayApply.create({
      gatewayId: gateway.id,
      applyKey: 'g1-a1',
      kind: 'apply',
      state: 'queued',
      ops: [{ op: 'delete', config: 'dhcp', section: 'perch_h1' }],
      baseHashes: { dhcp: 'abc' },
      perchIds: ['h1'],
      confirmMode: 'agent',
      confirmTimeoutSeconds: 90,
      requestedAt: DateTime.utc(),
    })
    const revision = await GatewayRevision.create({
      gatewayId: gateway.id,
      number: 1,
      source: 'import',
      summary: 'Imported',
      snapshot: [],
      diff: [],
      hashes: { dhcp: 'abc' },
      applyId: apply.id,
    })
    const reread = await GatewayRevision.findOrFail(revision.id)
    assert.deepEqual(reread.hashes, { dhcp: 'abc' })
    assert.isNull(reread.confirmedAt)
  })

  test('secret values are encrypted at rest and never serialised', async ({ assert }) => {
    const gateway = await seedGateway()
    const secret = await GatewaySecret.create({
      gatewayId: gateway.id,
      ref: 's1',
      value: 'correct horse battery staple',
      fingerprint: 'hmac:0011223344556677',
    })
    const raw = await db.from('gateway_secrets').where('id', secret.id).first()
    assert.notInclude(raw.value, 'battery')
    const reread = await GatewaySecret.findOrFail(secret.id)
    assert.equal(reread.value, 'correct horse battery staple')
    assert.notProperty(reread.serialize(), 'value')
  })

  test('deleting the collector detaches the gateway; deleting the gateway cascades', async ({
    assert,
  }) => {
    const gateway = await seedGateway()
    await GatewaySection.create({
      gatewayId: gateway.id,
      perchId: 'x1',
      config: 'network',
      sectionName: 'lan',
      sectionType: 'interface',
      scope: 'unmodeled',
      status: 'in_sync',
    })
    await Collector.query().where('id', gateway.collectorId!).delete()
    const detached = await Gateway.findOrFail(gateway.id)
    assert.isNull(detached.collectorId)
    assert.lengthOf(await GatewaySection.query().where('gatewayId', gateway.id), 1)

    await detached.delete()
    assert.lengthOf(await GatewaySection.query().where('gatewayId', gateway.id), 0)
  })
})
