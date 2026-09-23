import OneNodePerDevice from '#database/migrations/1779000000045_make_infra_nodes_device_mac_unique'
import { _infraRowCounts } from '#services/infra_topology'
import { resetInfraTests, seedLink, seedManualNode } from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

/**
 * Migration 1779000000045 (amendment A4 item 2): the container's entrypoint
 * loops on `migration:run`, so it must go through on any database: with
 * duplicate MACs, and from any partial index state.
 */

const PLAIN = 'infra_nodes_device_mac_idx'
const UNIQUE = 'infra_nodes_device_mac_unique_idx'
const FILE = 'database/migrations/1779000000045_make_infra_nodes_device_mac_unique'

async function up() {
  await new OneNodePerDevice(db.connection(), FILE).execUp()
}

async function down() {
  await new OneNodePerDevice(db.connection(), FILE).execDown()
}

/** The indexes on `infra_nodes.device_mac`, name → unique. */
async function deviceMacIndexes(): Promise<Record<string, boolean>> {
  const [found] = (await db.rawQuery(
    `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'infra_nodes' AND COLUMN_NAME = 'device_mac'`
  )) as [Array<{ name: string; nonUnique: number | string }>]
  return Object.fromEntries(found.map((row) => [row.name, Number(row.nonUnique) === 0]))
}

async function macsById(): Promise<Record<number, string | null>> {
  const rows = await db.from('infra_nodes').select('id', 'device_mac').orderBy('id')
  return Object.fromEntries(rows.map((row) => [Number(row.id), row.device_mac]))
}

test.group('infra | migration 045, one node per device', (group) => {
  group.each.setup(resetInfraTests)
  // Whatever a test did, leave the index as the migrated schema has it.
  group.each.teardown(async () => {
    await up()
  })

  test('duplicates keep the lowest node id; the others lose the MAC, not the node', async ({
    assert,
  }) => {
    await down()
    assert.deepEqual(await deviceMacIndexes(), { [PLAIN]: false })

    const mac = '02:00:00:00:00:21'
    const first = await seedManualNode('device', 'first', ['eth0'], { device_mac: mac })
    const second = await seedManualNode('switch', 'second', ['1', '2'], { device_mac: mac })
    // The same MAC as far as the index goes: its collation ignores case.
    const third = await seedManualNode('device', 'third', ['eth0'], {
      device_mac: mac.toUpperCase(),
    })
    const alone = await seedManualNode('device', 'alone', ['eth0'], {
      device_mac: '02:00:00:00:00:22',
    })
    const none = await seedManualNode('device', 'none', ['eth0'])
    const other = await seedManualNode('device', 'other', ['eth0'], {
      device_mac: '02:00:00:00:00:23',
    })
    const otherDuplicate = await seedManualNode('router', 'other again', ['wan'], {
      device_mac: '02:00:00:00:00:23',
    })
    await seedLink(second.ports['1'], first.ports.eth0)
    const before = await _infraRowCounts()

    await up()
    assert.deepEqual(await deviceMacIndexes(), { [UNIQUE]: true })
    assert.deepEqual(await macsById(), {
      [first.id]: mac,
      [second.id]: null,
      [third.id]: null,
      [alone.id]: '02:00:00:00:00:22',
      [none.id]: null,
      [other.id]: '02:00:00:00:00:23',
      [otherDuplicate.id]: null,
    })
    assert.deepEqual(await _infraRowCounts(), before, 'nodes, ports and cables stay')

    // Run again: nothing to do, nothing fails.
    await up()
    assert.deepEqual(await deviceMacIndexes(), { [UNIQUE]: true })
  })

  test('from any partial index state, up and down finish the job', async ({ assert }) => {
    // Neither index (someone dropped the plain one by hand).
    await db.rawQuery(`ALTER TABLE infra_nodes DROP INDEX ${UNIQUE}`)
    assert.deepEqual(await deviceMacIndexes(), {})
    await up()
    assert.deepEqual(await deviceMacIndexes(), { [UNIQUE]: true })

    // Both of them.
    await db.rawQuery(`ALTER TABLE infra_nodes ADD INDEX ${PLAIN} (device_mac)`)
    await up()
    assert.deepEqual(await deviceMacIndexes(), { [UNIQUE]: true })

    // Down, twice, and back up.
    await down()
    await down()
    assert.deepEqual(await deviceMacIndexes(), { [PLAIN]: false })
    await up()
    assert.deepEqual(await deviceMacIndexes(), { [UNIQUE]: true })
  })
})
