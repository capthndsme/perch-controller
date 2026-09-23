import Portal from '#models/portal'
import PortalGrant from '#models/portal_grant'
import PortalTemplate from '#models/portal_template'
import {
  GUEST_NET,
  IOT_NET,
  LAN_NET,
  MAC_A,
  MAC_B,
  bodyOf,
  outboxKeys,
  call,
  clearOutbox,
  outbox,
  resetPortalTests,
  seedGrant,
  seedPortal,
  seedPortalWorld,
} from '#tests/helpers/portal'
import { test } from '@japa/runner'

test.group('portal | portals', (group) => {
  group.each.setup(resetPortalTests)

  test('an admin creates a portal on a network; the router gets configure + template', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const response = await call(client, 'post', '/api/v1/portal/portals', world.adminToken).json({
      gatewayId: world.gatewayId,
      name: 'Guest Wi-Fi',
      networkPerchId: GUEST_NET,
      methods: { voucher: true, password: true },
      cspConnectSrc: ['http://192.168.20.5:8080', 'WS://coinbox.example.com'],
      privacyNotice: 'We keep your MAC address for 30 days.',
    })
    response.assertStatus(201)
    const { portal, delivery } = bodyOf(response).data
    assert.equal(delivery, 'pending')
    assert.deepInclude(portal, {
      gatewayId: world.gatewayId,
      name: 'Guest Wi-Fi',
      templateId: world.builtinTemplateId,
      enforcement: 'opennds',
      instance: null,
      native: null,
      cspConnectSrc: ['http://192.168.20.5:8080', 'ws://coinbox.example.com'],
      privacyNotice: 'We keep your MAC address for 30 days.',
      methods: { voucher: true, password: true },
    })
    assert.deepEqual(portal.network, {
      perchId: GUEST_NET,
      name: 'guest',
      label: 'Guests',
      purpose: 'guest',
    })
    assert.deepInclude(portal.gateway, {
      id: world.gatewayId,
      name: 'gateway',
      online: false,
      mode: 'managed',
      authoritative: false,
      portalCapable: null,
    })
    assert.deepInclude(portal.status, {
      openNds: 'unknown',
      fas: 'unknown',
      revision: 1,
      appliedRevision: null,
      delivery: 'pending',
    })
    assert.deepEqual(portal.status.clients, { authenticated: 0, pending: 0, paused: 0, queued: 0 })
    assert.deepEqual(await outboxKeys(world.gatewayId), [
      `configure:${portal.id}`,
      `template:${portal.id}`,
    ])
  })

  test('refusals on create', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    await seedPortal(world.gatewayId, GUEST_NET)
    const post = (body: object) =>
      call(client, 'post', '/api/v1/portal/portals', world.adminToken).json({
        gatewayId: world.gatewayId,
        name: 'Portal',
        ...body,
      })

    let r = await post({ gatewayId: 999, networkPerchId: IOT_NET })
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'gateway_not_found')

    r = await post({ networkPerchId: 'n_nope' })
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'network_not_found')

    r = await post({ networkPerchId: GUEST_NET })
    r.assertStatus(409)
    assert.equal(bodyOf(r).error, 'portal_exists')

    r = await post({ networkPerchId: LAN_NET })
    r.assertStatus(422)
    assert.equal(bodyOf(r).error, 'network_hosts_controller')

    r = await post({ networkPerchId: IOT_NET, templateId: 999 })
    r.assertStatus(404)
    assert.equal(bodyOf(r).error, 'template_not_found')

    // CSP origins are strict: nothing that could break out of the header.
    for (const bad of [
      'http://a.example.com/path',
      "http://x.example.com; script-src 'unsafe-eval'",
      '*',
      'javascript://x',
    ]) {
      r = await post({ networkPerchId: IOT_NET, cspConnectSrc: [bad] })
      assert.equal(r.status(), 422, bad)
      assert.isArray(bodyOf(r).errors)
    }

    r = await post({ networkPerchId: IOT_NET, name: '' })
    r.assertStatus(422)

    // `force` puts a portal on the management network anyway.
    r = await post({ networkPerchId: LAN_NET, force: true })
    r.assertStatus(201)
    assert.equal(
      await Portal.query()
        .whereNull('deleted_at')
        .count('* as n')
        .then((x) => Number(x[0].$extras.n)),
      2
    )
  })

  test('several portals per gateway; list, filter and show', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const a = await seedPortal(world.gatewayId, GUEST_NET)
    const b = await seedPortal(world.gatewayId, IOT_NET)
    await seedGrant({ portalId: a.id, mac: MAC_A, state: 'active' })
    await seedGrant({ portalId: a.id, mac: MAC_B, state: 'queued' })

    const list = await call(
      client,
      'get',
      `/api/v1/portal/portals?gatewayId=${world.gatewayId}`,
      world.operatorToken
    )
    list.assertStatus(200)
    const items = bodyOf(list).data
    assert.deepEqual(
      items.map((p: { id: number }) => p.id),
      [a.id, b.id]
    )
    assert.deepEqual(items[0].status.clients, {
      authenticated: 1,
      pending: 0,
      paused: 0,
      queued: 1,
    })
    assert.deepEqual(
      bodyOf(await call(client, 'get', '/api/v1/portal/portals?gatewayId=999', world.operatorToken))
        .data,
      []
    )

    const show = await call(client, 'get', `/api/v1/portal/portals/${b.id}`, world.viewerToken)
    show.assertStatus(200)
    assert.equal(bodyOf(show).data.network.name, 'iot')

    for (const id of ['999', 'abc']) {
      const missing = await call(client, 'get', `/api/v1/portal/portals/${id}`, world.viewerToken)
      missing.assertStatus(404)
      assert.equal(bodyOf(missing).error, 'portal_not_found')
    }
  })

  test('PATCH bumps the revision and queues configure; a new template queues template', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId, GUEST_NET, {
      templateId: world.builtinTemplateId,
    })
    const custom = await PortalTemplate.create({
      name: 'Custom',
      builtin: false,
      sha256: 'a'.repeat(64),
      totalBytes: 0,
    })

    let r = await call(
      client,
      'patch',
      `/api/v1/portal/portals/${portal.id}`,
      world.adminToken
    ).json({
      name: 'Renamed',
      methods: { password: true },
    })
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.portal, {
      name: 'Renamed',
      methods: { voucher: true, password: true },
    })
    assert.equal(bodyOf(r).data.portal.status.revision, 2)
    assert.equal(bodyOf(r).data.delivery, 'pending')
    assert.deepEqual(await outboxKeys(world.gatewayId), [`configure:${portal.id}`])

    // No change: no new revision.
    await clearOutbox()
    r = await call(client, 'patch', `/api/v1/portal/portals/${portal.id}`, world.adminToken).json({
      name: 'Renamed',
    })
    assert.equal(bodyOf(r).data.portal.status.revision, 2)
    assert.deepEqual(await outbox(world.gatewayId), [])

    r = await call(client, 'patch', `/api/v1/portal/portals/${portal.id}`, world.adminToken).json({
      templateId: custom.id,
      privacyNotice: null,
      networkPerchId: IOT_NET,
    })
    r.assertStatus(200)
    assert.deepInclude(bodyOf(r).data.portal, { templateId: custom.id, privacyNotice: null })
    assert.equal(bodyOf(r).data.portal.network.perchId, IOT_NET)
    assert.sameMembers(await outboxKeys(world.gatewayId), [
      `configure:${portal.id}`,
      `template:${portal.id}`,
    ])

    // Moving onto a network that has a portal, or a missing one.
    const other = await seedPortal(world.gatewayId, GUEST_NET)
    r = await call(client, 'patch', `/api/v1/portal/portals/${other.id}`, world.adminToken).json({
      networkPerchId: IOT_NET,
    })
    r.assertStatus(409)
    assert.equal(bodyOf(r).error, 'portal_exists')
    r = await call(client, 'patch', '/api/v1/portal/portals/999', world.adminToken).json({
      name: 'x',
    })
    r.assertStatus(404)
  })

  test('DELETE: live grants need force; force ends them and frees the network', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    const live = await seedGrant({ portalId: portal.id, mac: MAC_A })
    const queued = await seedGrant({ portalId: portal.id, mac: MAC_A, state: 'queued' })

    let r = await call(client, 'delete', `/api/v1/portal/portals/${portal.id}`, world.adminToken)
    r.assertStatus(409)
    assert.deepInclude(bodyOf(r), { error: 'portal_active_grants', activeGrants: 1 })

    r = await call(
      client,
      'delete',
      `/api/v1/portal/portals/${portal.id}?force=1`,
      world.adminToken
    )
    r.assertStatus(204)
    await live.refresh()
    await queued.refresh()
    assert.deepInclude(live.$attributes, {
      state: 'ended',
      endReason: 'revoked',
      delivery: 'pending',
    })
    assert.deepInclude(queued.$attributes, { state: 'ended', endReason: 'revoked' })
    const rows = await outbox(world.gatewayId)
    assert.deepEqual(
      rows.map((x) => x.dedupe_key),
      ['deauthorize', `configure:${portal.id}`]
    )
    assert.deepEqual(rows[0].grant_ids, [Number(live.id)])

    r = await call(client, 'get', `/api/v1/portal/portals/${portal.id}`, world.adminToken)
    r.assertStatus(404)
    // History is kept, the network is free again.
    assert.isNotNull(await PortalGrant.find(live.id))
    r = await call(client, 'post', '/api/v1/portal/portals', world.adminToken).json({
      gatewayId: world.gatewayId,
      name: 'Again',
      networkPerchId: GUEST_NET,
    })
    r.assertStatus(201)
  })

  test('DELETE without grants needs no force', async ({ client }) => {
    const world = await seedPortalWorld()
    const portal = await seedPortal(world.gatewayId)
    await seedGrant({ portalId: portal.id, mac: MAC_A, state: 'ended', endReason: 'expired' })
    const r = await call(client, 'delete', `/api/v1/portal/portals/${portal.id}`, world.adminToken)
    r.assertStatus(204)
  })
})
