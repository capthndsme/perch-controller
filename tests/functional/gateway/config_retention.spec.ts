import { pruneOldBuckets } from '#services/bucket_retention'
import { pruneGatewayConfigHistory } from '#services/gateway_config/config_retention'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const NOW = DateTime.fromISO('2026-09-23T03:30:00.000Z', { zone: 'utc' })
const sql = (dt: DateTime) => dt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
}

async function gateway(): Promise<number> {
  const [id] = await db.table('gateways').insert({ mode: 'managed', created_at: sql(NOW) })
  return Number(id)
}

async function revisions(gatewayId: number, count: number, confirmed: number[] = []) {
  for (let n = 1; n <= count; n++) {
    await db.table('gateway_revisions').insert({
      gateway_id: gatewayId,
      number: n,
      source: 'router',
      summary: `r${n}`,
      snapshot: '[]',
      diff: '[]',
      hashes: '{}',
      confirmed_at: confirmed.includes(n) ? sql(NOW.minus({ days: 100 - n })) : null,
      created_at: sql(NOW.minus({ days: 100 - n })),
    })
  }
}

test.group('gateway config retention', (group) => {
  group.each.setup(resetDb)

  test('events past auditRetentionDays go; newer stay', async ({ assert }) => {
    const id = await gateway()
    for (const days of [800, 731, 729, 1]) {
      await db.table('gateway_config_events').insert({
        gateway_id: id,
        event: 'read',
        detail: '{}',
        created_at: sql(NOW.minus({ days })),
      })
    }
    const dry = await pruneGatewayConfigHistory(
      { auditRetentionDays: 730, keepRevisions: 500 },
      { now: NOW, dryRun: true }
    )
    assert.equal(dry.events, 2)
    assert.lengthOf(await db.from('gateway_config_events'), 4, 'a dry run deletes nothing')

    const result = await pruneGatewayConfigHistory(
      { auditRetentionDays: 730, keepRevisions: 500 },
      { now: NOW }
    )
    assert.equal(result.events, 2)
    assert.lengthOf(await db.from('gateway_config_events'), 2)
  })

  test('revisions beyond keepRevisions go per gateway, the newest confirmed one stays', async ({
    assert,
  }) => {
    const a = await gateway()
    const b = await gateway()
    await revisions(a, 60, [3])
    await revisions(b, 40)
    const result = await pruneGatewayConfigHistory(
      { auditRetentionDays: 730, keepRevisions: 50 },
      { now: NOW }
    )
    assert.equal(result.revisions, 9)
    const kept = await db
      .from('gateway_revisions')
      .where('gateway_id', a)
      .orderBy('number')
      .select('number')
    const left = kept.map((r) => Number(r.number))
    assert.deepEqual(left, [3, ...Array.from({ length: 50 }, (_, i) => i + 11)])
    assert.lengthOf(
      await db.from('gateway_revisions').where('gateway_id', b),
      40,
      'under the limit'
    )
  })

  test('per-network samples are pruned with router samples', async ({ assert }) => {
    const id = await gateway()
    for (const days of [100, 1]) {
      await db.table('gateway_network_samples').insert({
        gateway_id: id,
        network: 'lan',
        recorded_at: sql(NOW.minus({ days })),
        rx_bytes: 1,
        tx_bytes: 1,
      })
    }
    const result = await pruneOldBuckets(30, { now: NOW })
    assert.equal(result.tables.find((t) => t.table === 'gateway_network_samples')?.deleted, 1)
    assert.lengthOf(await db.from('gateway_network_samples'), 1)
  })
})
