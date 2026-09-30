import { runGatewayDetector } from '#services/alerts/detectors/gateway'
import { runPortalDetector } from '#services/alerts/detectors/portal'
import { portKey, runPortsDetector } from '#services/alerts/detectors/ports'
import { runScans } from '#services/alerts/detectors/scans'
import { failoverKey, runWanDetector, wanDownKey } from '#services/alerts/detectors/wan'
import {
  ago,
  fakeDetectorContext,
  resetDetectorTests,
  seedAp,
  seedCollector,
  seedGateway,
  seedLiveAlert,
} from '#tests/helpers/alert_detectors'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * WP-A5b acceptance (docs/design/alerts/README.md section 9): WAN, gateway
 * config, ports, portal / hotspot and the watermark scans against seeded
 * tables. Placeholder addresses only.
 */

type Iface = Record<string, unknown>
const wanIface = (network: string, device: string, metric: number, extra: Iface = {}): Iface => ({
  network,
  device,
  up: true,
  proto: 'dhcp',
  ipv4: ['203.0.113.10/24'],
  ipv6: [],
  defaultRoute: true,
  metric,
  error: null,
  ...extra,
})
const LAN = { network: 'lan', device: 'lan0', up: true, proto: 'static', ipv4: ['192.168.1.1/24'] }

async function observe(collectorId: number, interfaces: Iface[], ageSeconds = 5) {
  await db
    .from('gateway_observations')
    .where('collector_id', collectorId)
    .where('kind', 'interfaces')
    .delete()
  await db.table('gateway_observations').insert({
    collector_id: collectorId,
    kind: 'interfaces',
    fingerprint: String(Math.random()),
    payload: JSON.stringify(interfaces),
    observed_at: ago(ageSeconds),
    changed_at: ago(ageSeconds),
  })
}

test.group('alerts detectors | wan (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  test('WAN memory, down, failover, all down → critical, failback', async ({ assert }) => {
    const collector = await seedCollector()
    const gateway = await seedGateway(collector)
    const t0 = DateTime.fromISO('2026-09-30T00:00:00Z', { zone: 'utc' })
    const ctx = fakeDetectorContext({ now: t0 })
    await observe(collector, [
      wanIface('wan', 'wan0', 1),
      wanIface('lan2', 'wan2', 2),
      { network: 'globe', device: 'globe', up: false, proto: 'dhcp', defaultRoute: false },
      LAN,
    ])
    await runWanDetector(ctx)
    assert.deepEqual(ctx.held('wan.down'), [])
    assert.deepEqual(ctx.held('wan.failover'), [])
    assert.sameMembers(Object.keys(ctx.store.get(`wans:${gateway}`) as object), ['wan', 'lan2'])

    // wan loses its link: down (warning) and a failover to lan2.
    await observe(collector, [
      wanIface('wan', 'wan0', 1, { up: false, defaultRoute: false, metric: null, ipv4: [] }),
      wanIface('lan2', 'wan2', 2),
      LAN,
    ])
    const down = fakeDetectorContext({ now: t0.plus({ minutes: 1 }) })
    for (const [k, v] of ctx.store) down.store.set(k, v)
    await runWanDetector(down)
    assert.deepEqual(down.held('wan.down'), [wanDownKey(gateway, 'wan')])
    const cond = down.condition(wanDownKey(gateway, 'wan'))!
    assert.equal(cond.severity, 'warning')
    assert.deepEqual(cond.subject, { kind: 'network', gatewayId: gateway, name: 'wan' })
    assert.include(cond.payload!, { reason: 'link_down', allDown: false, metric: 1 })
    assert.deepEqual(cond.payload!.activeWan, { network: 'lan2', device: 'wan2' })
    assert.deepEqual(down.held('wan.failover'), [failoverKey(gateway)])

    // lan2 too: every down WAN escalates to critical; no active WAN, failover not judged.
    await observe(collector, [
      wanIface('wan', 'wan0', 1, { up: false, defaultRoute: false, metric: null, ipv4: [] }),
      wanIface('lan2', 'wan2', 2, { up: false, defaultRoute: false, metric: null, ipv4: [] }),
      LAN,
    ])
    await seedLiveAlert('wan.failover', failoverKey(gateway))
    const all = fakeDetectorContext({ now: t0.plus({ minutes: 2 }) })
    for (const [k, v] of down.store) all.store.set(k, v)
    await runWanDetector(all)
    assert.sameMembers(all.held('wan.down'), [
      wanDownKey(gateway, 'wan'),
      wanDownKey(gateway, 'lan2'),
    ])
    for (const key of all.held('wan.down')) assert.equal(all.condition(key)!.severity, 'critical')
    // The live failover is kept (not evaluated), not cleared.
    assert.deepEqual(all.held('wan.failover'), [failoverKey(gateway)])

    // Everything back: all clear.
    await observe(collector, [wanIface('wan', 'wan0', 1), wanIface('lan2', 'wan2', 2), LAN])
    const back = fakeDetectorContext({ now: t0.plus({ minutes: 9 }) })
    for (const [k, v] of all.store) back.store.set(k, v)
    await runWanDetector(back)
    assert.deepEqual(back.held('wan.down'), [])
    assert.deepEqual(back.held('wan.failover'), [])
  })

  test('a silent collector or a stale report: nothing judged, live alerts kept', async ({
    assert,
  }) => {
    const collector = await seedCollector({ silentSeconds: 120 })
    const gateway = await seedGateway(collector)
    await observe(collector, [
      wanIface('wan', 'wan0', 1, { up: false, defaultRoute: false }),
      wanIface('lan2', 'wan2', 2),
    ])
    await seedLiveAlert('wan.down', wanDownKey(gateway, 'wan'))
    const silent = fakeDetectorContext()
    await runWanDetector(silent)
    assert.deepEqual(silent.held('wan.down'), [wanDownKey(gateway, 'wan')])
    assert.deepEqual(silent.condition(wanDownKey(gateway, 'wan'))!.subject, {
      kind: 'network',
      gatewayId: gateway,
      name: 'wan',
    })

    await db.from('collectors').update({ last_seen_at: ago(2) })
    await observe(collector, [wanIface('wan', 'wan0', 1)], 3600)
    const stale = fakeDetectorContext()
    await runWanDetector(stale)
    assert.deepEqual(stale.held('wan.down'), [wanDownKey(gateway, 'wan')])

    // A gateway row that is gone: its alerts clear.
    await db.from('gateways').delete()
    const gone = fakeDetectorContext()
    await runWanDetector(gone)
    assert.deepEqual(gone.held('wan.down'), [])
  })

  test('public address change is a notice, only when the rule is on', async ({ assert }) => {
    const collector = await seedCollector()
    await seedGateway(collector)
    await observe(collector, [wanIface('wan', 'wan0', 1, { ipv4: ['203.0.113.10/24'] })])
    const first = fakeDetectorContext({ rules: { 'wan.public_ip_changed': { enabled: true } } })
    await runWanDetector(first)
    await observe(collector, [wanIface('wan', 'wan0', 1, { ipv4: ['203.0.113.99/24'] })])
    const next = fakeDetectorContext({ rules: { 'wan.public_ip_changed': { enabled: true } } })
    for (const [k, v] of first.store) next.store.set(k, v)
    await runWanDetector(next)
    assert.lengthOf(next.emitted('wan.public_ip_changed'), 1)
    assert.include(next.emitted('wan.public_ip_changed')[0].payload!, {
      from: '203.0.113.10',
      to: '203.0.113.99',
    })
  })
})

test.group('alerts detectors | gateway (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  test('drift and conflict counts, suspended, awaiting confirm, SQM paused, AP groups', async ({
    assert,
  }) => {
    const collector = await seedCollector()
    const gateway = await seedGateway(collector)
    const section = (n: number, status: string) =>
      db.table('gateway_sections').insert({
        gateway_id: gateway,
        perch_id: `p${n}`,
        config: 'dhcp',
        section_name: `s${n}`,
        section_type: 'host',
        scope: 'synced',
        status,
        drift_since: status === 'drift' ? ago(600 - n) : null,
        created_at: ago(3600),
      })
    await section(1, 'drift')
    await section(2, 'drift')
    await section(3, 'drift')
    await section(4, 'conflict')
    await section(5, 'in_sync')
    await db
      .from('gateways')
      .where('id', gateway)
      .update({
        enforcement: 'suspended',
        enforcement_changed_at: ago(60),
      })
    const [applyId] = await db.table('gateway_applies').insert({
      gateway_id: gateway,
      apply_key: 'g1-abc',
      kind: 'apply',
      state: 'pending_confirm',
      ops: '[]',
      base_hashes: '{}',
      perch_ids: '[]',
      confirm_mode: 'admin_and_agent',
      confirm_timeout_seconds: 300,
      protected: true,
      deadline_at: ago(-240),
      requested_at: ago(60),
    })
    const [queueId] = await db.table('qos_wan_queues').insert({
      gateway_id: gateway,
      device: 'wan0',
      options: '{}',
      router_paused_at: ago(120),
      created_at: ago(3600),
    })
    const failed = await seedAp({ name: 'failed' })
    const applied = await seedAp({ name: 'applied' })
    const offlineLive = await seedAp({ name: 'offline-live' })
    const offline = await seedAp({ name: 'offline' })
    for (const [apId, state] of [
      [failed, 'failed'],
      [applied, 'applied'],
      [offlineLive, 'offline'],
      [offline, 'offline'],
    ] as const) {
      await db
        .table('ap_group_states')
        .insert({ ap_id: apId, state, revision: 3, error: 'unsafe_binding' })
    }
    await seedLiveAlert('ap.groups_failed', `ap.groups_failed:ap:${offlineLive}`)
    await seedLiveAlert('ap.groups_failed', `ap.groups_failed:ap:${applied}`)

    const ctx = fakeDetectorContext()
    await runGatewayDetector(ctx)
    const drift = ctx.condition(`gateway.drift:gateway:${gateway}`)!
    assert.equal(drift.payload!.sections, 3)
    assert.lengthOf(drift.payload!.examples as unknown[], 3)
    assert.equal(ctx.condition(`gateway.conflict:gateway:${gateway}`)!.payload!.sections, 1)
    assert.deepEqual(ctx.held('gateway.enforcement_suspended'), [
      `gateway.enforcement_suspended:gateway:${gateway}`,
    ])
    assert.deepEqual(ctx.held('gateway.apply_awaiting_confirm'), [
      `gateway.apply_awaiting_confirm:${applyId}`,
    ])
    assert.include(ctx.condition(`gateway.apply_awaiting_confirm:${applyId}`)!.payload!, {
      protected: true,
    })
    assert.deepEqual(ctx.held('gateway.sqm_paused'), [`gateway.sqm_paused:${queueId}`])
    assert.equal(ctx.condition(`gateway.sqm_paused:${queueId}`)!.payload!.interface, 'wan0')
    // failed holds; applied clears (left out); offline keeps a live one, raises nothing new.
    assert.sameMembers(ctx.held('ap.groups_failed'), [
      `ap.groups_failed:ap:${failed}`,
      `ap.groups_failed:ap:${offlineLive}`,
    ])

    // An admin confirmed: the awaiting-confirm condition clears.
    await db.from('gateway_applies').update({ admin_confirmed_at: ago(1) })
    const after = fakeDetectorContext()
    await runGatewayDetector(after)
    assert.deepEqual(after.held('gateway.apply_awaiting_confirm'), [])
  })
})

test.group('alerts detectors | ports (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  async function node(binding: { apId?: number; collectorId?: number }) {
    const [id] = await db.table('infra_nodes').insert({
      kind: binding.apId ? 'access_point' : 'gateway',
      origin: 'agent',
      ap_id: binding.apId ?? null,
      collector_id: binding.collectorId ?? null,
      created_at: ago(3600),
    })
    return Number(id)
  }
  async function port(nodeId: number, key: string, fields: Record<string, unknown> = {}) {
    const [id] = await db.table('infra_ports').insert({
      node_id: nodeId,
      port_key: key,
      origin: 'agent',
      present: true,
      carrier: true,
      operstate: 'up',
      carrier_changes: 0,
      speed_mbps: 1000,
      state_changed_at: ago(600),
      created_at: ago(3600),
      ...fields,
    })
    return Number(id)
  }
  async function cable(a: number, b: number) {
    await db
      .table('infra_links')
      .insert({ a_port_id: a, b_port_id: b, medium: 'ethernet', created_at: ago(60) })
  }

  test('down only on cabled or uplink ports of an online agent', async ({ assert }) => {
    const ap = await seedAp({ name: 'First Floor AP' })
    const silentAp = await seedAp({ name: 'Garage AP', silentSeconds: 600 })
    const collector = await seedCollector()
    const apNode = await node({ apId: ap })
    const silentNode = await node({ apId: silentAp })
    const gwNode = await node({ collectorId: collector })
    const uplink = await port(gwNode, 'lan0')
    const cabledDown = await port(apNode, 'lan2', {
      carrier: false,
      operstate: 'down',
      speed_mbps: null,
    })
    const looseDown = await port(apNode, 'lan1', { carrier: false, operstate: 'down' })
    const roleUplink = await port(apNode, 'wan', {
      carrier: null,
      operstate: 'lowerlayerdown',
      role: 'uplink',
    })
    const silentDown = await port(silentNode, 'lan3', { carrier: false, operstate: 'down' })
    await cable(uplink, cabledDown)
    await cable(await port(gwNode, 'lan1'), silentDown)

    const ctx = fakeDetectorContext()
    await runPortsDetector(ctx)
    assert.sameMembers(ctx.held('port.down'), [
      portKey('port.down', cabledDown),
      portKey('port.down', roleUplink),
    ])
    const payload = ctx.condition(portKey('port.down', cabledDown))!.payload!
    assert.equal(payload.node, 'First Floor AP')
    assert.equal(payload.port, 'lan2')
    assert.equal(payload.farEnd, 'gateway lan0')
    assert.notInclude(ctx.held('port.down'), portKey('port.down', looseDown))
    assert.notInclude(ctx.held('port.down'), portKey('port.down', silentDown))

    // Scope `all` takes the loose port too; a silent agent's port stays unknown.
    const all = fakeDetectorContext({ rules: { 'port.down': { params: { scope: 'all' } } } })
    await runPortsDetector(all)
    assert.include(all.held('port.down'), portKey('port.down', looseDown))
    assert.notInclude(all.held('port.down'), portKey('port.down', silentDown))

    // A live alert on the silent agent's port is kept, not cleared.
    await seedLiveAlert('port.down', portKey('port.down', silentDown))
    const kept = fakeDetectorContext()
    await runPortsDetector(kept)
    assert.include(kept.held('port.down'), portKey('port.down', silentDown))
  })

  test('flapping from carrier_changes deltas; a counter reset re-baselines', async ({ assert }) => {
    const ap = await seedAp({ name: 'First Floor AP' })
    const apNode = await node({ apId: ap })
    // The live First Floor AP's lan2: 103 cumulative changes when the detector starts.
    const lan2 = await port(apNode, 'lan2', { carrier_changes: 103 })
    const key = portKey('port.flapping', lan2)
    const t0 = DateTime.fromISO('2026-09-30T00:00:00Z', { zone: 'utc' })
    const tick = async (minutes: number, counter: number) => {
      await db.from('infra_ports').where('id', lan2).update({ carrier_changes: counter })
      const ctx = fakeDetectorContext({ now: t0.plus({ minutes }) })
      await runPortsDetector(ctx)
      return ctx.held('port.flapping')
    }
    // A high cumulative count on its own is history, not a flap.
    assert.deepEqual(await tick(0, 103), [])
    assert.deepEqual(await tick(2, 106), [])
    await db.from('infra_ports').where('id', lan2).update({ carrier_changes: 111 })
    const flapping = fakeDetectorContext({ now: t0.plus({ minutes: 4 }) })
    await runPortsDetector(flapping)
    assert.deepEqual(flapping.held('port.flapping'), [key])
    assert.include(flapping.condition(key)!.payload!, {
      changes: 8,
      windowMinutes: 15,
      port: 'lan2',
    })

    // Raised and still moving slowly: holds.
    await seedLiveAlert('port.flapping', key)
    assert.deepEqual(await tick(12, 112), [key])
    // Quiet for a whole window after the last move: clears.
    assert.deepEqual(await tick(28, 112), [])

    // The AP rebooted: the counter starts over; no event.
    await db.from('alerts').delete()
    assert.deepEqual(await tick(30, 2), [])
    assert.deepEqual(await tick(31, 4), [])
  })

  test('baselines persist every 5 minutes; speed drops are a notice when on', async ({
    assert,
  }) => {
    const ap = await seedAp({ name: 'Garage AP' })
    const collector = await seedCollector()
    const apNode = await node({ apId: ap })
    const gwNode = await node({ collectorId: collector })
    const lan4 = await port(apNode, 'lan4', { speed_mbps: 1000 })
    await cable(lan4, await port(gwNode, 'lan0'))
    const t0 = DateTime.fromISO('2026-09-30T00:00:00Z', { zone: 'utc' })
    const first = fakeDetectorContext({
      now: t0,
      rules: { 'port.speed_degraded': { enabled: true } },
    })
    await runPortsDetector(first)
    assert.property(Object.fromEntries(first.store), `carrier:${lan4}`)

    await db.from('infra_ports').where('id', lan4).update({ speed_mbps: 100 })
    const slow = fakeDetectorContext({
      now: t0.plus({ minutes: 1 }),
      rules: { 'port.speed_degraded': { enabled: true } },
    })
    await runPortsDetector(slow)
    assert.lengthOf(slow.emitted('port.speed_degraded'), 1)
    assert.include(slow.emitted('port.speed_degraded')[0].payload!, {
      speedMbps: 100,
      previousMbps: 1000,
    })
    // Once per drop.
    const again = fakeDetectorContext({
      now: t0.plus({ minutes: 2 }),
      rules: { 'port.speed_degraded': { enabled: true } },
    })
    await runPortsDetector(again)
    assert.lengthOf(again.emitted('port.speed_degraded'), 0)
  })
})

test.group('alerts detectors | portal (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  async function portal(gatewayId: number, name: string, state: string | null) {
    const [id] = await db.table('portals').insert({
      gateway_id: gatewayId,
      name,
      network_perch_id: `n-${name}`,
      methods: '{}',
      status: state
        ? JSON.stringify({ state, issues: ['no_device'], at: new Date().toISOString() })
        : null,
      created_at: ago(3600),
    })
    return Number(id)
  }
  async function terminal(
    portalId: number,
    name: string,
    silentSeconds: number,
    error: string | null
  ) {
    const [id] = await db.table('hotspot_terminals').insert({
      portal_id: portalId,
      name,
      enabled: true,
      token_prefix: 'tk',
      token_hash: `h-${name}`,
      token_encrypted: 'x',
      last_seen_at: ago(silentSeconds),
      status: JSON.stringify({
        online: true,
        error,
        acceptor: 'ok',
        firmware: '1.0',
        at: new Date(Date.now() - silentSeconds * 1000).toISOString(),
      }),
      created_at: ago(3600),
    })
    return Number(id)
  }

  test('not enforcing, terminals offline and in error; not while the gateway is silent', async ({
    assert,
  }) => {
    const collector = await seedCollector()
    const gateway = await seedGateway(collector)
    const broken = await portal(gateway, 'Lobby', 'waiting_device')
    const fine = await portal(gateway, 'Cafe', 'active')
    await portal(gateway, 'Off', 'disabled')
    const offline = await terminal(fine, 'Coin 1', 120, null)
    const jammed = await terminal(fine, 'Coin 2', 10, 'coin_jam')
    await terminal(fine, 'Coin 3', 10, null)

    const ctx = fakeDetectorContext()
    await runPortalDetector(ctx)
    assert.deepEqual(ctx.held('portal.not_enforcing'), [`portal.not_enforcing:portal:${broken}`])
    assert.include(ctx.condition(`portal.not_enforcing:portal:${broken}`)!.payload!, {
      state: 'waiting_device',
      name: 'Lobby',
    })
    assert.deepEqual(ctx.held('hotspot.terminal_offline'), [
      `hotspot.terminal_offline:terminal:${offline}`,
    ])
    assert.deepEqual(ctx.held('hotspot.terminal_error'), [
      `hotspot.terminal_error:terminal:${jammed}`,
    ])
    assert.include(ctx.condition(`hotspot.terminal_error:terminal:${jammed}`)!.payload!, {
      error: 'coin_jam',
    })

    // Delivery failures make an active portal not enforcing.
    await db.table('portal_gateway_states').insert({
      gateway_id: gateway,
      delivery_failures: 3,
      delivery_error: 'timeout',
      created_at: ago(60),
    })
    const failing = fakeDetectorContext()
    await runPortalDetector(failing)
    assert.include(failing.held('portal.not_enforcing'), `portal.not_enforcing:portal:${fine}`)

    // The gateway's collector goes silent: nothing new, live ones kept.
    await db.from('collectors').update({ last_seen_at: ago(600) })
    await seedLiveAlert('hotspot.terminal_offline', `hotspot.terminal_offline:terminal:${offline}`)
    const silent = fakeDetectorContext()
    await runPortalDetector(silent)
    assert.deepEqual(silent.held('portal.not_enforcing'), [])
    assert.deepEqual(silent.held('hotspot.terminal_offline'), [
      `hotspot.terminal_offline:terminal:${offline}`,
    ])
    assert.deepEqual(silent.held('hotspot.terminal_error'), [])
  })
})

test.group('alerts detectors | scans (db)', (group) => {
  group.each.setup(() => resetDetectorTests())

  test('watermarks start at the current max (no history flood), each row once', async ({
    assert,
  }) => {
    const collector = await seedCollector()
    const gateway = await seedGateway(collector)
    const event = (name: string, detail: Record<string, unknown>, userId: number | null = null) =>
      db.table('gateway_config_events').insert({
        gateway_id: gateway,
        event: name,
        user_id: userId,
        detail: JSON.stringify(detail),
        created_at: ago(1),
      })
    await event('rolled_back', { applyId: 'g1-old', reason: 'confirm_timeout' })
    await db
      .table('collectors')
      .insert({ name: 'old-pending', lifecycle: 'pending', created_at: ago(60) })
    await seedAp({ name: 'ap' })
    await db.from('wifi_access_points').update({ agent_joined_at: ago(3600) })

    const ctx = fakeDetectorContext()
    assert.equal(await runScans(ctx), 0)
    assert.lengthOf(ctx.emits, 0)

    // New rows after the first pass.
    await event('rolled_back', {
      applyId: 'g1-new',
      reason: 'confirm_timeout',
      discardedConfigs: [],
    })
    await event('rolled_back', { applyId: 'g1-admin', requested: true })
    await event('section_ambiguous', { config: 'firewall', section: 'cfg1', domain: 'firewall' })
    await event('applied', { applyId: 'g1-ok' })
    await db.table('collectors').insert({
      name: 'new-pending',
      lifecycle: 'pending',
      hostname: 'router',
      announced_base_url: 'http://192.168.1.1:9800',
      created_at: ago(1),
    })
    await db.table('hotspot_checkouts').insert({
      gateway_id: gateway,
      kind: 'unclaimed',
      state: 'unclaimed',
      event_key: 'coin:1:e1',
      amount: 500,
      currency: 'PHP',
      decimals: 2,
      reason: 'late',
      mac: '02:00:00:00:aa:01',
      created_at: ago(1),
    })
    await db.table('portal_events').insert({
      gateway_id: gateway,
      type: 'checkout_rejected',
      mac: '02:00:00:00:aa:01',
      detail: JSON.stringify({ reason: 'bad_signature', checkoutRef: 'c1' }),
      created_at: ago(1),
    })
    await db.from('wifi_access_points').update({ agent_joined_at: ago(0) })

    const next = fakeDetectorContext()
    for (const [k, v] of ctx.store) next.store.set(k, v)
    await runScans(next)
    assert.sameMembers(
      next.emits.map((e) => e.type),
      [
        'gateway.apply_rolled_back',
        'gateway.section_ambiguous',
        'collector.pending',
        'hotspot.checkout_rejected',
        'ap.joined',
      ]
    )
    // The unclaimed coins have no terminal or portal to name: skipped, never a guest MAC.
    for (const e of next.emits) assert.notInclude(JSON.stringify(e.payload), '02:00:00:00:aa:01')

    // Nothing twice.
    const again = fakeDetectorContext()
    for (const [k, v] of next.store) again.store.set(k, v)
    assert.equal(await runScans(again), 0)
  })

  test('a disabled notice type is not emitted, the watermark still moves', async ({ assert }) => {
    const collector = await seedCollector()
    const gateway = await seedGateway(collector)
    const ctx = fakeDetectorContext()
    await runScans(ctx)
    await db.table('gateway_config_events').insert({
      gateway_id: gateway,
      event: 'unmodeled_changed',
      detail: JSON.stringify({ config: 'network', section: 'wan' }),
      created_at: ago(1),
    })
    const off = fakeDetectorContext({ rules: { 'gateway.unmodeled_changed': { enabled: false } } })
    for (const [k, v] of ctx.store) off.store.set(k, v)
    assert.equal(await runScans(off), 0)
    const on = fakeDetectorContext()
    for (const [k, v] of off.store) on.store.set(k, v)
    assert.equal(await runScans(on), 0)
  })
})
