import { seedSetupComplete } from '#tests/helpers/ap_agent'
import { resetInfraTests, seedLink, seedManualNode } from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const LINKS = '/api/v1/infra/links'

function link(client: ApiClient, token: string, body: Record<string, unknown>) {
  return client.post(LINKS).bearerToken(token).json(body)
}

async function setMedium(portId: number, medium: string, column = 'medium') {
  await db
    .from('infra_ports')
    .where('id', portId)
    .update({ [column]: medium })
}

test.group('infra | links', (group) => {
  group.each.setup(resetInfraTests)

  test('a cable joins two ports; a is the smaller id', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])

    const created = await link(client, adminToken, {
      aPortId: pc.ports.eth0,
      bPortId: sw.ports['1'],
      label: 'cable run to the garage',
      notes: null,
    })
    created.assertStatus(201)
    const body = created.body().data.link
    assert.deepEqual(body, {
      id: body.id,
      medium: 'ethernet',
      label: 'cable run to the garage',
      notes: null,
      a: { nodeId: sw.id, portId: sw.ports['1'] },
      b: { nodeId: pc.id, portId: pc.ports.eth0 },
    })

    const layout = await client.get('/api/v1/infra/layout').bearerToken(adminToken)
    const data = layout.body().data
    assert.deepEqual(data.links, [body])
    const port = data.nodes
      .find((node: { id: number }) => node.id === sw.id)
      .ports.find((p: { key: string }) => p.key === '1')
    assert.equal(port.linkId, body.id)
  })

  test('one link per port: a busy port answers 409 with the cable it carries', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])
    const nas = await seedManualNode('device', 'NAS', ['eth0'])
    const first = await link(client, adminToken, { aPortId: sw.ports['1'], bPortId: pc.ports.eth0 })
    first.assertStatus(201)
    const firstId = first.body().data.link.id

    // Either end of the existing cable is busy, whichever column it sits in.
    for (const [aPortId, bPortId, busyPort] of [
      [nas.ports.eth0, sw.ports['1'], sw.ports['1']],
      [pc.ports.eth0, sw.ports['2'], pc.ports.eth0],
      [sw.ports['2'], pc.ports.eth0, pc.ports.eth0],
    ]) {
      const busy = await link(client, adminToken, { aPortId, bPortId })
      busy.assertStatus(409)
      assert.deepEqual(busy.body(), {
        error: 'infra_port_busy',
        message: busy.body().message,
        portId: busyPort,
        linkId: firstId,
      })
    }
    assert.lengthOf(await db.from('infra_links').select('id'), 1)
  })

  test('degenerate cables are refused', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])

    const samePort = await link(client, adminToken, {
      aPortId: sw.ports['1'],
      bPortId: sw.ports['1'],
    })
    samePort.assertStatus(422)
    assert.equal(samePort.body().error, 'infra_link_same_port')
    const sameNode = await link(client, adminToken, {
      aPortId: sw.ports['1'],
      bPortId: sw.ports['2'],
    })
    sameNode.assertStatus(422)
    assert.equal(sameNode.body().error, 'infra_link_same_node')
    const missing = await link(client, adminToken, { aPortId: sw.ports['1'], bPortId: 9999 })
    missing.assertStatus(404)
    assert.deepInclude(missing.body(), { error: 'infra_port_not_found', portId: 9999 })

    await db.from('infra_ports').where('id', pc.ports.eth0).update({ hidden: true })
    const hidden = await link(client, adminToken, {
      aPortId: sw.ports['1'],
      bPortId: pc.ports.eth0,
    })
    hidden.assertStatus(409)
    assert.deepInclude(hidden.body(), { error: 'infra_port_hidden', portId: pc.ports.eth0 })

    const invalid = await link(client, adminToken, { aPortId: sw.ports['1'] })
    invalid.assertStatus(422)
    assert.isArray(invalid.body().errors)
    assert.lengthOf(await db.from('infra_links').select('id'), 0)
  })

  test('the medium follows the ends unless given', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const a = await seedManualNode('switch', 'A', ['v1', 'v2', 'sfp1', 'w1', 'c1', 'c2'])
    const b = await seedManualNode('switch', 'B', ['v1', 'c1', 'c2', 'w1', 'c3', 'c4'])
    await setMedium(a.ports.v1, 'virtual')
    await setMedium(b.ports.v1, 'virtual', 'reported_medium')
    await setMedium(a.ports.v2, 'virtual')
    await setMedium(a.ports.sfp1, 'sfp')
    await setMedium(a.ports.w1, 'wireless')

    const medium = async (aPortId: number, bPortId: number, given?: string) => {
      const response = await link(client, adminToken, {
        aPortId,
        bPortId,
        ...(given ? { medium: given } : {}),
      })
      response.assertStatus(201)
      return response.body().data.link.medium
    }
    assert.equal(await medium(a.ports.v1, b.ports.v1), 'virtual', 'both ends virtual')
    assert.equal(await medium(a.ports.v2, b.ports.c1), 'ethernet', 'one virtual end')
    assert.equal(await medium(a.ports.sfp1, b.ports.c2), 'fiber')
    assert.equal(await medium(a.ports.w1, b.ports.w1), 'wireless')
    assert.equal(await medium(a.ports.c1, b.ports.c3), 'ethernet')
    assert.equal(await medium(a.ports.c2, b.ports.c4, 'fiber'), 'fiber', 'given wins')
  })

  test('PATCH moves one end with the same checks, and edits the rest', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1', '2', '3'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])
    const nas = await seedManualNode('device', 'NAS', ['eth0'])
    const linkId = await seedLink(sw.ports['1'], pc.ports.eth0)
    const otherId = await seedLink(sw.ports['3'], nas.ports.eth0)
    const patch = (body: Record<string, unknown>) =>
      client.patch(`${LINKS}/${linkId}`).bearerToken(adminToken).json(body)

    // a = switch port 1 (the smaller id): move it to port 2.
    const moved = await patch({ aPortId: sw.ports['2'], label: 'patch cable' })
    moved.assertStatus(200)
    assert.deepInclude(moved.body().data.link, {
      id: linkId,
      label: 'patch cable',
      a: { nodeId: sw.id, portId: sw.ports['2'] },
      b: { nodeId: pc.id, portId: pc.ports.eth0 },
    })
    // Move the far end past the other: the smaller id stays `a`.
    const swapped = await patch({ bPortId: sw.ports['1'], aPortId: pc.ports.eth0 })
    swapped.assertStatus(200)
    assert.deepEqual(swapped.body().data.link.a, { nodeId: sw.id, portId: sw.ports['1'] })
    assert.deepEqual(swapped.body().data.link.b, { nodeId: pc.id, portId: pc.ports.eth0 })

    const busy = await patch({ aPortId: sw.ports['3'] })
    busy.assertStatus(409)
    assert.deepInclude(busy.body(), { error: 'infra_port_busy', linkId: otherId })
    const sameNode = await patch({ bPortId: sw.ports['2'] })
    sameNode.assertStatus(422)
    assert.equal(sameNode.body().error, 'infra_link_same_node')
    const missing = await patch({ bPortId: 9999 })
    missing.assertStatus(404)
    assert.equal(missing.body().error, 'infra_port_not_found')

    const edited = await patch({ medium: 'fiber', label: null, notes: 'in the conduit' })
    assert.deepInclude(edited.body().data.link, {
      medium: 'fiber',
      label: null,
      notes: 'in the conduit',
    })
    const unknown = await client.patch(`${LINKS}/9999`).bearerToken(adminToken).json({ label: 'x' })
    unknown.assertStatus(404)
    assert.equal(unknown.body().error, 'infra_link_not_found')
  })

  test('a cable goes with its port, and can be deleted on its own', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])
    const nas = await seedManualNode('device', 'NAS', ['eth0'])
    const first = await seedLink(sw.ports['1'], pc.ports.eth0)
    const second = await seedLink(sw.ports['2'], nas.ports.eth0)

    const portGone = await client
      .delete(`/api/v1/infra/ports/${pc.ports.eth0}`)
      .bearerToken(adminToken)
    portGone.assertStatus(204)
    assert.isNull(await db.from('infra_links').where('id', first).first())

    const deleted = await client.delete(`${LINKS}/${second}`).bearerToken(adminToken)
    deleted.assertStatus(204)
    assert.lengthOf(await db.from('infra_links').select('id'), 0)
    const again = await client.delete(`${LINKS}/${second}`).bearerToken(adminToken)
    again.assertStatus(404)
    assert.equal(again.body().error, 'infra_link_not_found')
  })

  test('the map holds at most 400 cables', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    const left = await seedManualNode('switch', 'Left', [])
    const right = await seedManualNode('switch', 'Right', [])
    const ports = async (nodeId: number, prefix: string) => {
      await db.table('infra_ports').multiInsert(
        Array.from({ length: 401 }, (_, i) => ({
          node_id: nodeId,
          port_key: `${prefix}${i}`,
          origin: 'manual',
          position: i,
          hidden: false,
          present: true,
          created_at: now,
        }))
      )
      const rows = await db.from('infra_ports').where('node_id', nodeId).orderBy('id')
      return rows.map((row) => row.id as number)
    }
    const a = await ports(left.id, 'l')
    const b = await ports(right.id, 'r')
    await db.table('infra_links').multiInsert(
      Array.from({ length: 400 }, (_, i) => ({
        a_port_id: a[i],
        b_port_id: b[i],
        medium: 'ethernet',
        created_at: now,
      }))
    )
    const refused = await link(client, adminToken, { aPortId: a[400], bPortId: b[400] })
    refused.assertStatus(422)
    assert.equal(refused.body().error, 'infra_limit_reached')
  })
})
