import Collector from '#models/collector'
import DeviceGroup from '#models/device_group'
import DeviceGroupMember from '#models/device_group_member'
import Gateway from '#models/gateway'
import PortalGatewayState from '#models/portal_gateway_state'
import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import { apiKeyFingerprint } from '#services/collector_announce'
import {
  SocketPortalAgentSender,
  _resetPortalAgentState,
  _setPortalAgentTimings,
  buildConfigureParams,
  isPortalGatewayReady,
} from '#services/portal_agent'
import { setPortalAgentSender } from '#services/portal_agent_sender'
import { _resetPortalGuestLimits } from '#services/portal_guest'
import { portalGatewayKeys } from '#services/portal_keys'
import { updatePortalSettings } from '#services/portal_settings'
import { signGrant, signGroup } from '#services/portal/crypto'
import { eventually } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import {
  GUEST_NET,
  MAC_A,
  MAC_B,
  type PortalWorld,
  bodyOf,
  outbox,
  outboxKinds,
  resetPortalTests,
  seedApiClient,
  seedGrant,
  seedPortal,
  seedPortalWorld,
  seedVoucher,
} from '#tests/helpers/portal'
import { FakePortalRouter } from '#tests/helpers/portal_router'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

/**
 * The guest portal on the collector socket (docs/gateway/portal.md section
 * 13): a scripted router (`FakePortalRouter`, which verifies every
 * signature with the key it was handed) against the real hub, sender and
 * reconciliation.
 */

const CODE = 'K7Q2M9XH4D'
const CODE_2 = 'P3R8T2V6WZ'
const MAC_C = '02:00:00:00:aa:03'

let world: PortalWorld
let routers: FakePortalRouter[] = []

/** The world's gateway collector, dialable by the fake router. */
async function linkCollector(gatewayId: number) {
  const gateway = await Gateway.findOrFail(gatewayId)
  const collector = await Collector.findOrFail(gateway.collectorId!)
  collector.merge({
    instanceId: TEST_INSTANCE_ID,
    apiKey: TEST_API_KEY,
    apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    transport: 'agent',
    lifecycle: 'adopted',
  })
  await collector.save()
}

async function connected(router?: FakePortalRouter): Promise<FakePortalRouter> {
  const r = router ?? (await FakePortalRouter.connect())
  if (!router) routers.push(r)
  await r.hello()
  await eventually(
    () => isPortalGatewayReady(world.gatewayId),
    (ready) => ready,
    5000
  )
  return r
}

async function disconnect(router: FakePortalRouter) {
  await router.collector.close()
  await eventually(
    () => isPortalGatewayReady(world.gatewayId),
    (ready) => !ready
  )
}

async function grantRow(id: number) {
  return PortalGrant.findOrFail(id)
}

function rpcErrorOf(reply: Record<string, unknown>): string | null {
  const error = reply.error as { data?: { error?: string } } | undefined
  return error?.data?.error ?? null
}

test.group('portal | collector socket', (group) => {
  group.each.setup(async () => {
    const teardown = await resetPortalTests()
    _resetPortalAgentState()
    _resetPortalGuestLimits()
    setPortalAgentSender(new SocketPortalAgentSender())
    _setPortalAgentTimings({
      callTimeoutMs: 400,
      syncTimeoutMs: 400,
      retryBaseMs: 100,
      retryMaxMs: 400,
      eventSyncDelayMs: 30,
    })
    world = await seedPortalWorld()
    await linkCollector(world.gatewayId)
    return teardown
  })
  group.each.teardown(async () => {
    for (const r of routers) await r.collector.close()
    routers = []
    _resetPortalAgentState()
    _setPortalAgentTimings()
  })

  test('connect sequence: configure with the key, sync, full authorize, vouchers', async ({
    assert,
    client,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    const grant = await seedGrant({
      portalId: portal.id,
      state: 'pending_device',
      delivery: 'pending',
      timeBudgetSeconds: 3600,
      expiresAt: null,
    })
    const { voucher } = await seedVoucher(portal.id, CODE)

    const router = await connected()
    router.present.add(MAC_A)

    assert.deepEqual(router.methods(), [
      'portal.configure',
      'portal.sync',
      'portal.authorize',
      'portal.vouchers',
    ])
    const configure = router.calls('portal.configure')[0].params as any
    assert.equal(configure.gatewayId, world.gatewayId)
    assert.deepEqual(configure.keys.epoch, 1)
    assert.equal(configure.portals[0].network, 'guest')
    assert.equal(configure.portals[0].portalId, portal.id)
    assert.isFalse(configure.portals[0].relay)

    // The router holds the grant under the key it was handed.
    const held = router.grant(MAC_A)!
    assert.equal(held.grantId, Number(grant.id))
    const expected = portalGatewayKeys(world.gatewayId, 1)
    assert.equal(router.keys!.signKey.toString('hex'), expected.signKey.toString('hex'))
    assert.lengthOf(router.vouchers, 1)
    assert.equal(router.vouchers[0].voucherId, voucher.id)

    const row = await grantRow(Number(grant.id))
    assert.equal(row.delivery, 'applied')

    const state = await PortalGatewayState.findOrFail(world.gatewayId)
    assert.equal(state.routerKeyEpoch, 1)
    assert.equal(state.capabilities?.port, 2080)
    assert.isNotNull(state.lastSyncAt)

    const view = bodyOf(
      await client.get(`/api/v1/portal/portals/${portal.id}`).bearerToken(world.adminToken)
    ).data
    assert.isTrue(view.gateway.portalCapable)
    assert.isTrue(view.gateway.online)
    assert.equal(view.status.state, 'active')
    assert.equal(view.status.device, 'br-guest')
    assert.equal(view.status.delivery, 'applied')

    // A second hello does not re-send the key.
    await router.reconnect()
    await connected(router)
    const again = router.calls('portal.configure')[0].params as any
    assert.notProperty(again, 'keys')
  })

  test('a gateway without portal capability gets no portal calls', async ({ assert }) => {
    await seedPortal(world.gatewayId)
    const router = await FakePortalRouter.connect()
    routers.push(router)
    await router.collector.hello({ capabilities: ['gateway_stats'] })
    await eventually(
      async () => {
        const row = await PortalGatewayState.find(world.gatewayId)
        return row?.capabilitiesAt ?? null
      },
      (at) => at !== null
    )
    assert.deepEqual(router.methods(), [])
    assert.isFalse(isPortalGatewayReady(world.gatewayId))
    const state = await PortalGatewayState.findOrFail(world.gatewayId)
    assert.isNull(state.capabilities)
  })

  test('online: a REST change is delivered at once and answers applied', async ({
    assert,
    client,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    const router = await connected()
    const response = await client
      .post('/api/v1/portal/authorizations')
      .bearerToken(world.adminToken)
      .json({ portalId: portal.id, mac: MAC_B, minutes: 30 })
    response.assertStatus(201)
    const body = bodyOf(response).data
    assert.equal(body.delivery, 'applied')
    assert.equal(router.grant(MAC_B)?.grantId, body.grant.id)
    assert.lengthOf(await outbox(world.gatewayId), 0)

    // Revoke: deauthorize, acknowledged.
    const revoke = await client
      .post(`/api/v1/portal/grants/${body.grant.id}/revoke`)
      .bearerToken(world.adminToken)
    assert.equal(bodyOf(revoke).data.delivery, 'applied')
    assert.isUndefined(router.grant(MAC_B))
    const deauth = router.calls('portal.deauthorize')[0].params as any
    assert.deepEqual(deauth.grantIds, [body.grant.id])
    assert.equal(deauth.reason, 'revoked')
    const revokedRow = await grantRow(body.grant.id)
    assert.equal(revokedRow.delivery, 'applied')
  })

  test('outbox: changes made offline are drained on reconnect', async ({ assert, client }) => {
    const portal = await seedPortal(world.gatewayId)
    const old = await seedGrant({ portalId: portal.id, mac: MAC_C })
    const router = await connected()
    assert.equal(router.grant(MAC_C)?.grantId, Number(old.id))
    await disconnect(router)

    const created = await client
      .post('/api/v1/portal/authorizations')
      .bearerToken(world.adminToken)
      .json({ portalId: portal.id, mac: MAC_B, minutes: 30 })
    assert.equal(bodyOf(created).data.delivery, 'pending')
    const revoked = await client
      .post(`/api/v1/portal/grants/${old.id}/revoke`)
      .bearerToken(world.adminToken)
    assert.equal(bodyOf(revoked).data.delivery, 'pending')
    assert.sameMembers(await outboxKinds(world.gatewayId), ['authorize', 'deauthorize'])

    await router.reconnect()
    await connected(router)
    assert.equal(router.grant(MAC_B)?.grantId, bodyOf(created).data.grant.id)
    assert.isUndefined(router.grant(MAC_C))
    assert.lengthOf(await outbox(world.gatewayId), 0)
    const createdRow = await grantRow(bodyOf(created).data.grant.id)
    const oldRow = await grantRow(Number(old.id))
    assert.equal(createdRow.delivery, 'applied')
    assert.equal(oldRow.delivery, 'applied')
  })

  test('a failed delivery is re-enqueued and retried with backoff', async ({ assert, client }) => {
    const portal = await seedPortal(world.gatewayId)
    const router = await connected()
    router.failNext.set('portal.authorize', 'hang')
    const response = await client
      .post('/api/v1/portal/authorizations')
      .bearerToken(world.adminToken)
      .json({ portalId: portal.id, mac: MAC_B, minutes: 30 })
    const body = bodyOf(response).data
    assert.equal(body.delivery, 'pending')
    const state = await PortalGatewayState.findOrFail(world.gatewayId)
    assert.equal(state.deliveryFailures, 1)
    assert.match(state.deliveryError ?? '', /timeout/)

    await eventually(
      () => router.grant(MAC_B)?.grantId ?? null,
      (id) => id === body.grant.id,
      5000
    )
    await eventually(
      async () => {
        const row = await PortalGatewayState.findOrFail(world.gatewayId)
        return row.deliveryFailures
      },
      (n) => n === 0
    )
    assert.lengthOf(await outbox(world.gatewayId), 0)
  })

  test('portal.redeem: online redemption, signed answer, refusals, idempotent retry', async ({
    assert,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    const { voucher } = await seedVoucher(null, CODE, { durationMinutes: 60 })
    const router = await connected()

    const reply = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.30.20',
      hostname: 'phone',
      code: 'k7q2m-9xh4d',
    })
    const result = reply.result as any
    assert.isFalse(result.queued)
    const { sig: grantSig, ...grant } = result.grant
    const { sig: groupSig, ...wireGroup } = result.group
    assert.equal(signGrant(router.keys!, grant), grantSig)
    assert.equal(signGroup(router.keys!, wireGroup), groupSig)
    assert.equal(grant.groupKey, `v:${voucher.id}`)
    assert.equal(wireGroup.durationSeconds, 3600)
    assert.isNumber(wireGroup.expiresAt)

    const row = await grantRow(grant.grantId)
    assert.equal(row.source, 'voucher')
    assert.equal(row.hostname, 'phone')
    await voucher.refresh()
    assert.equal(voucher.boundPortalId, portal.id)
    assert.isNotNull(voucher.firstUsedAt)
    assert.isNotNull(voucher.expiresAt)

    // The same code again from the same device: the same grant.
    const retry = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.30.20',
      code: CODE,
    })
    assert.equal((retry.result as any).grant.grantId, grant.grantId)

    // The binding changed the offline list: it is resent.
    await eventually(
      () => router.vouchers.some((v) => v.voucherId === voucher.id),
      (x) => x
    )

    const wrong = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.21',
      code: 'ZZZZZ-ZZZZZ',
    })
    assert.equal(rpcErrorOf(wrong), 'invalid_code')
    const foreign = await router.collector.request('portal.redeem', {
      portalId: portal.id + 99,
      mac: MAC_B,
      ip: '192.168.30.21',
      code: CODE,
    })
    assert.equal(rpcErrorOf(foreign), 'wrong_portal')

    // Only failures count: 10 per device and portal in 15 minutes.
    for (let i = 0; i < 9; i++) {
      await router.collector.request('portal.redeem', {
        portalId: portal.id,
        mac: MAC_B,
        ip: '192.168.30.21',
        code: 'ZZZZZ-ZZZZZ',
      })
    }
    const limited = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.21',
      code: CODE_2,
    })
    assert.equal(rpcErrorOf(limited), 'rate_limited')
  })

  test('portal.redeem: a sign-in stuck behind a sync is given up, never run late', async ({
    assert,
  }) => {
    _setPortalAgentTimings({
      callTimeoutMs: 400,
      syncTimeoutMs: 1500,
      retryBaseMs: 5000,
      retryMaxMs: 5000,
      eventSyncDelayMs: 0,
      signInStartMs: 200,
    })
    const portal = await seedPortal(world.gatewayId)
    const { voucher } = await seedVoucher(portal.id, CODE)
    const router = await connected()
    router.failNext.set('portal.sync', 'hang')
    router.collector.notifyServer('portal.event', {
      seq: 1,
      at: Date.now(),
      type: 'noop',
      mac: MAC_A,
    })
    await router.collector.waitForCount('portal.sync', 2)
    const reply = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.30.20',
      code: CODE,
    })
    assert.equal(rpcErrorOf(reply), 'controller_unreachable')
    // The queue moves on after the sync times out; the redemption never ran.
    await new Promise((resolve) => setTimeout(resolve, 1800))
    assert.lengthOf(await PortalGrant.query().where('voucher_id', voucher.id), 0)
  })

  test('portal.redeem: a used-up voucher moves to the newest device (decision 23)', async ({
    assert,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    await seedVoucher(portal.id, CODE)
    const router = await connected()
    const first = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.30.20',
      code: CODE,
    })
    const firstId = (first.result as any).grant.grantId
    const second = await router.collector.request('portal.redeem', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.21',
      code: CODE,
    })
    assert.notEqual((second.result as any).grant.grantId, firstId)
    const moved = await grantRow(firstId)
    assert.equal(moved.state, 'ended')
    assert.equal(moved.endReason, 'moved')
    // The moved device is taken off the router after the answer.
    await eventually(
      () =>
        router
          .calls('portal.deauthorize')
          .some((c) => (c.params as any).grantIds.includes(firstId)),
      (x) => x
    )
  })

  test('portal.login: portal users, wrong password, disabled method', async ({ assert }) => {
    const portal = await seedPortal(world.gatewayId, GUEST_NET, {
      methods: { voucher: true, password: true },
    })
    const user = await PortalUser.create({
      username: 'guest.one',
      password: 'guest-pass-123',
      enabled: true,
      maxDevices: 1,
      sessionMinutes: 120,
      portalIds: null,
    } as Partial<PortalUser>)
    const router = await connected()

    const ok = await router.collector.request('portal.login', {
      portalId: portal.id,
      mac: MAC_A,
      ip: '192.168.30.20',
      username: 'guest.one',
      password: 'guest-pass-123',
    })
    const grant = (ok.result as any).grant
    assert.equal(grant.groupKey, `u:${user.id}`)
    assert.isNumber(grant.expiresAt)
    assert.equal(signGrant(router.keys!, { ...grant, sig: undefined } as any), grant.sig)

    const bad = await router.collector.request('portal.login', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.21',
      username: 'guest.one',
      password: 'wrong-password',
    })
    assert.equal(rpcErrorOf(bad), 'invalid_credentials')

    // Full (one device), a second device is refused unless it replaces.
    const full = await router.collector.request('portal.login', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.21',
      username: 'guest.one',
      password: 'guest-pass-123',
    })
    assert.equal(rpcErrorOf(full), 'device_limit')
    const replaced = await router.collector.request('portal.login', {
      portalId: portal.id,
      mac: MAC_B,
      ip: '192.168.30.21',
      username: 'guest.one',
      password: 'guest-pass-123',
      replace: true,
    })
    assert.isNumber((replaced.result as any).grant.grantId)
    const first = await grantRow(grant.grantId)
    assert.equal(first.endReason, 'replaced')

    const voucherOnly = await seedPortal(world.gatewayId, 'n_iot')
    const disabled = await router.collector.request('portal.login', {
      portalId: voucherOnly.id,
      mac: MAC_C,
      ip: '192.168.40.20',
      username: 'guest.one',
      password: 'guest-pass-123',
    })
    assert.equal(rpcErrorOf(disabled), 'disabled')
  })

  test("portal.login binds to the user's device group (decision 31); bypass in configure", async ({
    assert,
  }) => {
    const portal = await seedPortal(world.gatewayId, GUEST_NET, {
      methods: { voucher: true, password: true },
    })
    // A unit with its own network: the device moves there, no grant here.
    const unit = await DeviceGroup.create({
      gatewayId: world.gatewayId,
      name: 'Unit 1',
      networkPerchId: 'n_iot',
      internet: true,
      portalBypass: false,
    })
    const tenant = await PortalUser.create({
      username: 'tenant.one',
      password: 'tenant-pass-123',
      enabled: true,
      maxDevices: 1,
      sessionMinutes: null,
      portalIds: null,
      deviceGroupId: unit.id,
    } as Partial<PortalUser>)
    const router = await connected()
    const login = (mac: string, replace = false) =>
      router.collector.request('portal.login', {
        portalId: portal.id,
        mac,
        ip: '192.168.30.20',
        username: 'tenant.one',
        password: 'tenant-pass-123',
        ...(replace ? { replace: true } : {}),
      })
    const moved = await login(MAC_A)
    assert.isNull((moved.result as any).grant)
    assert.deepEqual((moved.result as any).bound, {
      groupId: unit.id,
      groupName: 'Unit 1',
      moved: true,
    })
    const bound = await DeviceGroupMember.query().where('groupId', unit.id)
    assert.deepEqual(
      bound.map((m) => [m.mac, m.source, m.portalUserId]),
      [[MAC_A, 'portal', tenant.id]]
    )
    assert.lengthOf(await PortalGrant.query().where('portal_user_id', tenant.id), 0)
    // Again from the same device: still one binding.
    await login(MAC_A)
    assert.lengthOf(await DeviceGroupMember.query().where('groupId', unit.id), 1)
    // One device only: a second is refused unless it replaces the first.
    assert.equal(rpcErrorOf(await login(MAC_B)), 'device_limit')
    await login(MAC_B, true)
    const after = await DeviceGroupMember.query().where('groupId', unit.id)
    assert.deepEqual(
      after.map((m) => m.mac),
      [MAC_B]
    )

    // A group without a network: the grant as before, plus the membership;
    // with a portal bypass, the router gets the member in portal.configure.
    const family = await DeviceGroup.create({
      gatewayId: world.gatewayId,
      name: 'Family',
      networkPerchId: null,
      internet: true,
      portalBypass: true,
    })
    await PortalUser.create({
      username: 'family.one',
      password: 'family-pass-123',
      enabled: true,
      maxDevices: 2,
      sessionMinutes: 60,
      portalIds: null,
      deviceGroupId: family.id,
    } as Partial<PortalUser>)
    const fam = await router.collector.request('portal.login', {
      portalId: portal.id,
      mac: MAC_C,
      ip: '192.168.30.22',
      username: 'family.one',
      password: 'family-pass-123',
    })
    assert.isNumber((fam.result as any).grant.grantId)
    assert.deepEqual((fam.result as any).bound, {
      groupId: family.id,
      groupName: 'Family',
      moved: false,
    })
    const { params } = await buildConfigureParams(world.gatewayId, 1, null)
    assert.deepEqual(params.portals.find((p) => p.portalId === portal.id)!.bypass, [MAC_C])
  })

  test('offline redemption is reconciled after the reconnect; no double spend', async ({
    assert,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    const { voucher } = await seedVoucher(portal.id, CODE)
    // Valid on any portal and never used: not offered offline.
    const { voucher: floating } = await seedVoucher(null, CODE_2)
    const router = await connected()
    assert.deepEqual(
      router.vouchers.map((v) => v.voucherId),
      [voucher.id]
    )
    assert.notInclude(
      router.vouchers.map((v) => v.voucherId),
      floating.id
    )

    await disconnect(router)
    assert.isTrue(router.redeemOffline(portal.id, MAC_A, CODE, 'o1'))
    assert.isFalse(router.redeemOffline(portal.id, MAC_B, CODE_2, 'o2'))

    await router.reconnect()
    await connected(router)
    const rows = await PortalGrant.query().where('voucher_id', voucher.id)
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].localRef, 'o1')
    assert.equal(rows[0].mac, MAC_A)
    // The router learned the grant id with the full set.
    assert.equal(router.grant(MAC_A)?.grantId, Number(rows[0].id))
    await voucher.refresh()
    assert.equal(voucher.boundPortalId, portal.id)
    assert.isNotNull(voucher.expiresAt)
    const events = await db.from('portal_events').where('type', 'offline_redeemed')
    assert.lengthOf(events, 1)

    // The router replays its journal (it lost the ack): still one grant.
    router.events = router.events.map((e) => ({ ...e }))
    await db.from('portal_gateway_states').update({ acked_event_seq: 0 })
    await router.reconnect()
    await connected(router)
    assert.lengthOf(await PortalGrant.query().where('voucher_id', voucher.id), 1)

    // A second gateway never holds this gateway's vouchers.
    const other = await Collector.create({
      name: 'gateway-2',
      baseUrl: null,
      pollIntervalSeconds: 5,
      enabled: true,
      lifecycle: 'adopted',
      source: 'announced',
      transport: 'agent',
      instanceId: 'f56204aa11bb22cc33dd44ee55ff6677',
      apiKey: 'collector-key-two-0123456789abcdef',
      apiKeyFingerprint: apiKeyFingerprint('collector-key-two-0123456789abcdef'),
    } as Partial<Collector>)
    const gateway2 = await Gateway.create({ collectorId: other.id, mode: 'managed' })
    await db.table('gateway_sections').insert({
      gateway_id: gateway2.id,
      perch_id: 'n_guest2',
      config: 'network',
      section_name: 'guest',
      section_type: 'interface',
      anonymous: false,
      scope: 'synced',
      domain: 'networks',
      status: 'in_sync',
      created_at: new Date(),
    })
    const portal2 = await seedPortal(gateway2.id, 'n_guest2')
    const router2 = await FakePortalRouter.connect({
      instanceId: 'f56204aa11bb22cc33dd44ee55ff6677',
      apiKey: 'collector-key-two-0123456789abcdef',
    })
    routers.push(router2)
    await router2.hello()
    await eventually(
      () => isPortalGatewayReady(gateway2.id),
      (x) => x,
      5000
    )
    assert.deepEqual(router2.vouchers, [])
    // And the other gateway's guest cannot redeem it online either.
    const reply = await router2.collector.request('portal.redeem', {
      portalId: portal2.id,
      mac: MAC_C,
      ip: '192.168.40.20',
      code: CODE,
    })
    assert.equal(rpcErrorOf(reply), 'wrong_portal')
  })

  test('an authorization made outside Perch is undone and logged', async ({ assert }) => {
    const portal = await seedPortal(world.gatewayId)
    const router = await connected()
    router.externals.push({ portalId: portal.id, mac: MAC_C })
    router.journal({ type: 'external_auth', portalId: portal.id, mac: MAC_C, ip: '192.168.30.99' })
    router.collector.notifyServer('portal.event', router.events[router.events.length - 1])

    await eventually(
      () => router.externals.length,
      (n) => n === 0,
      5000
    )
    const authorize = router.calls('portal.authorize').at(-1)!.params as any
    assert.deepEqual(authorize.revertExternals, [{ portalId: portal.id, mac: MAC_C }])
    const events = await db.from('portal_events').where('type', 'external_auth_reverted')
    assert.lengthOf(events, 1)
    assert.equal(events[0].mac, MAC_C)
    assert.equal(await PortalGrant.query().where('mac', MAC_C).first(), null)
  })

  test('portal.relay: Paid Hotspot API through the router, scope and rate limits', async ({
    assert,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    const other = await seedPortal(world.gatewayId, 'n_iot')
    const writer = await seedApiClient([portal.id])
    const reader = await seedApiClient([portal.id], ['read'])
    const elsewhere = await seedApiClient([other.id])
    const router = await connected()
    // A client for the portal turns its relay on.
    const configure = router.calls('portal.configure')[0].params as any
    assert.isTrue(configure.portals.find((p: any) => p.portalId === portal.id).relay)

    const relay = (params: Record<string, unknown>) =>
      router.collector
        .request('portal.relay', { portalId: portal.id, clientIp: '192.168.30.50', ...params })
        .then((r) => r.result as { status: number; body: any })

    const created = await relay({
      op: 'authorize',
      token: writer.token,
      body: { mac: MAC_B, minutes: 15, externalRef: 'pay-1', portalId: other.id },
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.data.outcome, 'created')
    assert.equal(created.body.data.grant.portalId, portal.id)
    assert.equal(created.body.data.delivery, 'applied')
    assert.equal(router.grant(MAC_B)?.grantId, created.body.data.grant.id)
    const ledger = await db.from('portal_authorizations').where('external_ref', 'pay-1').first()
    assert.equal(ledger.via, 'relay')
    assert.equal(ledger.address, '192.168.30.50')

    const status = await relay({ op: 'status', token: writer.token, mac: MAC_B })
    assert.equal(status.status, 200)
    assert.equal(status.body.data.grant.id, created.body.data.grant.id)

    const scope = await relay({
      op: 'authorize',
      token: reader.token,
      body: { mac: MAC_C, minutes: 5 },
    })
    assert.equal(scope.status, 403)
    assert.equal(scope.body.error, 'scope_required')
    const notAllowed = await relay({
      op: 'authorize',
      token: elsewhere.token,
      body: { mac: MAC_C, minutes: 5 },
    })
    assert.equal(notAllowed.status, 403)
    assert.equal(notAllowed.body.error, 'portal_not_allowed')
    const invalid = await relay({ op: 'authorize', token: writer.token, body: { mac: 'nope' } })
    assert.equal(invalid.status, 422)
    // Never a controller access token through a guest network.
    const adminToken = await relay({ op: 'status', token: world.adminToken, mac: MAC_B })
    assert.equal(adminToken.status, 401)
    assert.equal(adminToken.body.error, 'invalid_api_token')

    const removed = await relay({ op: 'deauthorize', token: writer.token, mac: MAC_B })
    assert.equal(removed.status, 200)
    assert.isUndefined(router.grant(MAC_B))

    // Per client per minute, as over HTTP.
    await updatePortalSettings({ apiRequestsPerClientPerMinute: 10 })
    let last = { status: 0, body: {} as any }
    for (let i = 0; i < 12; i++)
      last = await relay({ op: 'status', token: reader.token, mac: MAC_B })
    assert.equal(last.status, 429)
    assert.equal(last.body.error, 'rate_limited')

    // Failed tokens are charged to the relaying gateway: 20, then 429.
    for (let i = 0; i < 20; i++) await relay({ op: 'status', token: 'perch_pa_wrong', mac: MAC_B })
    const blocked = await relay({ op: 'status', token: writer.token, mac: MAC_B })
    assert.equal(blocked.status, 429)
  })

  test('key epoch rotation: new key, new verifiers, every message under it', async ({
    assert,
    client,
  }) => {
    const portal = await seedPortal(world.gatewayId)
    await seedVoucher(portal.id, CODE)
    await seedGrant({ portalId: portal.id, mac: MAC_A })
    const router = await connected()
    const verifier1 = router.vouchers[0].verifier

    const response = await client
      .post(`/api/v1/portal/gateways/${world.gatewayId}/rotate-key`)
      .bearerToken(world.adminToken)
    response.assertStatus(200)
    assert.deepEqual(bodyOf(response).data, { keyEpoch: 2, delivery: 'applied' })
    assert.equal(router.keys!.epoch, 2)
    assert.notEqual(router.vouchers[0].verifier, verifier1)
    assert.isDefined(router.grant(MAC_A))
    const state = await PortalGatewayState.findOrFail(world.gatewayId)
    assert.equal(state.keyEpoch, 2)
    assert.equal(state.routerKeyEpoch, 2)
    assert.lengthOf(await db.from('portal_events').where('type', 'key_rotated'), 1)

    // Operators may not rotate.
    const denied = await client
      .post(`/api/v1/portal/gateways/${world.gatewayId}/rotate-key`)
      .bearerToken(world.operatorToken)
    denied.assertStatus(403)

    // Offline rotation reaches the router on reconnect.
    await disconnect(router)
    await client
      .post(`/api/v1/portal/gateways/${world.gatewayId}/rotate-key`)
      .bearerToken(world.adminToken)
    await router.reconnect()
    await connected(router)
    assert.equal(router.keys!.epoch, 3)
  })

  test('a router holding a key the controller cannot sign for is re-keyed', async ({ assert }) => {
    const portal = await seedPortal(world.gatewayId)
    await seedGrant({ portalId: portal.id, mac: MAC_A })
    // The router says it holds epoch 1, but a key from another APP_KEY.
    const router = await FakePortalRouter.connect({
      keys: { gatewayId: world.gatewayId, epoch: 1, key: Buffer.alloc(32, 7) },
    })
    routers.push(router)
    await router.hello()
    await eventually(
      () => isPortalGatewayReady(world.gatewayId),
      (ready) => ready,
      5000
    )
    assert.isAbove(router.signatureFailures, 0)
    const expected = portalGatewayKeys(world.gatewayId, 1)
    assert.equal(router.keys!.signKey.toString('hex'), expected.signKey.toString('hex'))
    assert.isDefined(router.grant(MAC_A))
  })

  test('portal.event schedules a sync that records router facts', async ({ assert }) => {
    const portal = await seedPortal(world.gatewayId)
    const grant = await seedGrant({ portalId: portal.id, mac: MAC_A, state: 'pending_device' })
    const router = await connected()
    const held = router.grant(MAC_A)!
    held.state = 'active'
    held.bytesDown = 5000
    const seq = router.journal({
      type: 'grant_active',
      portalId: portal.id,
      mac: MAC_A,
      grantId: Number(grant.id),
      ip: '192.168.30.20',
    })
    router.collector.notifyServer('portal.event', router.events[seq - 1])
    const row = await eventually(
      () => grantRow(Number(grant.id)),
      (g) => g.state === 'active' && Number(g.bytesDown) === 5000,
      5000
    )
    assert.equal(row.ip, '192.168.30.20')
    const state = await PortalGatewayState.findOrFail(world.gatewayId)
    assert.equal(Number(state.ackedEventSeq), seq)
  })
})
