import { planApply, planSectionEdits } from '#services/gateway_config/apply_plan'
import { contentsEqual } from '#services/gateway_config/canonical'
import {
  checkRoundTrip,
  roundTripsSection,
  syncedFromRouter,
  validateDesired,
  type SectionEdit,
  type SyncedSection,
} from '#services/gateway_config/domain'
import { dhcpPoolsDomain } from '#services/gateway_config/domains/dhcp_pools'
import { DOMAINS, domainRegistry } from '#services/gateway_config/domains/index'
import {
  cidrsOverlap,
  interfaceCidrs,
  maskBits,
  networksDomain,
  parsePortSpec,
  portSpecText,
} from '#services/gateway_config/domains/networks'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import {
  composeNetworks,
  planCreateNetwork,
  planDeleteNetwork,
  planUpdateNetwork,
  type NetworkPlan,
} from '#services/gateway_config/network_model'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { ManagementPath, UciConfigSet } from '#services/gateway_config/types'
import { parseNetworksReport, reportScope } from '#services/gateway_network_accounting'
import {
  dsaNetworkConfig,
  networkConfigSet,
  networksDhcpConfig,
} from '#tests/unit/services/fixtures/gateway_networks'
import { test } from '@japa/runner'

const LAN: ManagementPath = { network: 'lan', device: 'br-lan' }

/** Rows as the engine would hold them after importing `set` (claimed = synced). */
function statesOf(set: UciConfigSet = networkConfigSet()): SectionState[] {
  const registry = domainRegistry()
  const out: SectionState[] = []
  let n = 0
  for (const cfg of Object.values(set)) {
    for (const s of cfg.sections) {
      const claim = registry.claim({ ...s, config: cfg.name }, set)
      const content = { type: s.type, options: { ...s.options } }
      const ownership = claim?.ownership ?? null
      out.push({
        perchId: `p${++n}`,
        config: cfg.name,
        name: s.name,
        type: s.type,
        anonymous: s.anonymous,
        scope: claim ? 'synced' : 'unmodeled',
        domain: claim?.domain.key ?? null,
        ownership: ownership && ownership.kind === 'options' ? ownership : null,
        issue: null,
        base: content,
        baseRevision: 1,
        router: content,
        desired: content,
        status: 'in_sync',
        conflict: null,
        driftSince: null,
        position: s.index,
      })
    }
  }
  return out
}

/** Applies a network plan the way `editDomainSections` does (pure). */
function applyPlan(states: SectionState[], plan: NetworkPlan): SectionState[] {
  let rows = states
  let k = 0
  for (const [domain, edits] of [
    ['networks', plan.network],
    ['dhcp_pools', plan.pools],
  ] as Array<[string, SectionEdit[]]>) {
    if (edits.length === 0) continue
    const result = planSectionEdits({
      rows,
      edits,
      domain,
      registry: domainRegistry(),
      authoritative: false,
      newPerchId: () => `new${++k}`,
    })
    const byId = new Map(rows.map((r) => [r.perchId, r]))
    for (const u of result.upserts) byId.set(u.perchId, u)
    for (const id of result.deleted) byId.delete(id)
    rows = [...byId.values()]
  }
  return rows
}

function desiredOf(rows: SectionState[], config: string, name: string) {
  return rows.find((r) => r.config === config && r.name === name)?.desired ?? null
}

function refusal(fn: () => unknown): GatewayPlaneError {
  try {
    fn()
  } catch (error) {
    if (error instanceof GatewayPlaneError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

function claimedNetwork(): SyncedSection[] {
  const set = networkConfigSet()
  return set.network.sections
    .filter((s) => networksDomain.claims({ ...s, config: 'network' }, set))
    .map((s, i) => syncedFromRouter('network', s, `n${i}`))
}

test.group('networks domain | claims and round trip (plan 1 section 8.1)', () => {
  test('claims LAN interfaces, L2 devices and bridge VLANs; leaves the rest unmodeled', ({
    assert,
  }) => {
    assert.deepEqual(
      claimedNetwork().map((s) => s.name),
      [
        'cfg030f15',
        'lan',
        'guest_dev',
        'guest',
        'cfg050f15',
        'cfg060f15',
        'cfg070f15',
        'vlan110',
        'vlan120',
        'iot_vlan',
        'iot',
      ]
    )
    const set = networkConfigSet()
    const reg = domainRegistry()
    for (const name of ['loopback', 'globals', 'cfg040f15', 'wan', 'wan6', 'wan2', 'cfg0a0f15']) {
      const s = set.network.sections.find((x) => x.name === name)!
      assert.isNull(reg.claim({ ...s, config: 'network' }, set), name)
    }
    // Without the firewall read, a static WAN is still known by its gateway.
    const noFw = { network: dsaNetworkConfig() }
    const wan2 = noFw.network.sections.find((s) => s.name === 'wan2')!
    assert.isFalse(networksDomain.claims({ ...wan2, config: 'network' }, noFw))
  })

  test('the default registry holds networks and dhcp_pools after the first domains', ({
    assert,
  }) => {
    assert.deepEqual(
      DOMAINS.map((d) => d.key),
      ['dhcp_hosts', 'dns_records', 'dhcp_pools', 'networks']
    )
    assert.deepEqual(domainRegistry().configs(), ['network', 'dhcp'])
  })

  test('round-trips the whole DSA config, VLANs via bridge-vlan included, exactly', ({
    assert,
  }) => {
    const report = checkRoundTrip(networksDomain, claimedNetwork())
    assert.isTrue(report.ok, JSON.stringify(report.failures))
    for (const s of claimedNetwork()) assert.isTrue(roundTripsSection(networksDomain, s), s.name)
    // A scalar `ports` stays scalar; list order and unknown options are kept.
    const [obj] = networksDomain.parse([claimedNetwork().find((s) => s.name === 'cfg070f15')!])
    assert.equal(obj.fields.ports, 'trunk:t')
    const [iot] = networksDomain.parse([claimedNetwork().find((s) => s.name === 'iot')!])
    assert.deepEqual(iot.extra, { force_link: '1' })
  })

  test('dhcp_pools: claims LAN pools, owns the IPv4 side, round-trips', ({ assert }) => {
    const set = networkConfigSet()
    const pools = networksDhcpConfig().sections.filter((s) =>
      dhcpPoolsDomain.claims({ ...s, config: 'dhcp' }, set)
    )
    assert.deepEqual(
      pools.map((s) => s.name),
      ['lan', 'guest']
    )
    const synced = pools.map((s, i) => syncedFromRouter('dhcp', s, `d${i}`))
    assert.isTrue(checkRoundTrip(dhcpPoolsDomain, synced).ok)
    const ownership = dhcpPoolsDomain.ownership!({ ...pools[0], config: 'dhcp' })
    assert.equal(ownership.kind, 'options')
    assert.notInclude((ownership as { options: string[] }).options, 'ra')
  })

  test('equality: bridge VLAN ids and ports, pool lease times and options', ({ assert }) => {
    const rules = domainRegistry().rules('networks')
    assert.isTrue(
      contentsEqual(
        { type: 'bridge-vlan', options: { device: 'br-trunk', vlan: '0110', ports: 'trunk:t' } },
        { type: 'bridge-vlan', options: { device: 'br-trunk', vlan: '110', ports: ['trunk:t'] } },
        rules
      )
    )
    const poolRules = domainRegistry().rules('dhcp_pools')
    assert.isTrue(
      contentsEqual(
        { type: 'dhcp', options: { interface: 'lan', leasetime: '12h', ignore: 'false' } },
        { type: 'dhcp', options: { interface: 'lan', leasetime: '720m', ignore: '0' } },
        poolRules
      )
    )
    assert.deepEqual(
      networksDomain.identityKeys!({
        type: 'bridge-vlan',
        options: { device: 'br-trunk', vlan: '110' },
      }),
      ['bridge-vlan:br-trunk.110']
    )
  })
})

test.group('networks domain | helpers and validation', () => {
  test('addresses, masks, overlaps, port specs', ({ assert }) => {
    assert.equal(maskBits('255.255.255.0'), 24)
    assert.isNull(maskBits('255.0.255.0'))
    assert.deepEqual(interfaceCidrs({ ipaddr: '192.168.1.1', netmask: '255.255.254.0' }), [
      '192.168.1.1/23',
    ])
    assert.deepEqual(interfaceCidrs({ ipaddr: ['192.168.3.1/24', 'x'] }), ['192.168.3.1/24'])
    assert.isTrue(cidrsOverlap('192.168.1.1/23', '192.168.0.9/24'))
    assert.isFalse(cidrsOverlap('192.168.1.1/24', '192.168.2.1/24'))
    assert.deepEqual(parsePortSpec('lan3:u*'), { port: 'lan3', tagged: false, pvid: true })
    assert.deepEqual(parsePortSpec('trunk:t'), { port: 'trunk', tagged: true, pvid: false })
    assert.deepEqual(parsePortSpec('lan1'), { port: 'lan1', tagged: false, pvid: false })
    assert.isNull(parsePortSpec('bad port'))
    assert.equal(portSpecText({ port: 'lan2', tagged: true, pvid: false }), 'lan2:t')
  })

  test('VID range and reuse, PVID per port, subnet overlap (WAN included), missing VLAN', ({
    assert,
  }) => {
    const base = claimedNetwork()
    const unmanaged = dsaNetworkConfig()
      .sections.filter((s) => !base.some((b) => b.name === s.name))
      .map((s) => syncedFromRouter('network', s, `u-${s.name}`))
    const broken: SyncedSection[] = [
      ...base,
      {
        perchId: 'x1',
        config: 'network',
        name: 'perch_x1',
        type: 'bridge-vlan',
        anonymous: false,
        options: { device: 'br-trunk', vlan: '110', ports: ['trunk:u*'] },
      },
      {
        perchId: 'x2',
        config: 'network',
        name: 'perch_x2',
        type: 'bridge-vlan',
        anonymous: false,
        options: { device: 'br-trunk', vlan: '5000', ports: ['trunk:t'] },
      },
      {
        perchId: 'x3',
        config: 'network',
        name: 'perch_x3',
        type: 'bridge-vlan',
        anonymous: false,
        options: { device: 'br-trunk', vlan: '130', ports: ['trunk:u*'] },
      },
      {
        perchId: 'x4',
        config: 'network',
        name: 'clash',
        type: 'interface',
        anonymous: false,
        options: {
          device: 'br-trunk.140',
          proto: 'static',
          ipaddr: '203.0.113.9',
          netmask: '255.255.255.0',
        },
      },
    ]
    const issues = validateDesired(
      domainRegistry(),
      broken.map((s) => ({ ...s, domain: 'networks' })),
      { capabilities: null, unmanaged }
    )
    const codes = (perchId: string) =>
      issues.filter((i) => i.perchId === perchId).map((i) => i.code)
    assert.include(codes('x1'), 'vlan_in_use')
    assert.include(codes('x2'), 'invalid_vlan')
    // x1 and x3 both make trunk the PVID port.
    assert.include([...codes('x1'), ...codes('x3')], 'port_pvid_conflict')
    assert.include(codes('x4'), 'subnet_overlap')
    assert.include(codes('x4'), 'vlan_missing')
    // The router's own config is clean.
    const clean = validateDesired(
      domainRegistry(),
      base.map((s) => ({ ...s, domain: 'networks' })),
      { capabilities: null, unmanaged }
    )
    assert.deepEqual(
      clean.filter((i) => i.severity === 'error'),
      []
    )
  })
})

test.group('networks | composition (network_model.ts)', () => {
  test('modes, ports, pools, zones and the management network', ({ assert }) => {
    const nets = composeNetworks(statesOf(), LAN)
    assert.deepEqual(
      nets.map((n) => [n.key, n.l2Mode, n.bridge, n.vlanId, n.parentDevice]),
      [
        ['lan', 'bridge', 'br-lan', null, null],
        ['guest', 'bridge', 'br-guest', null, null],
        ['vlan110', 'bridge_vlan', 'br-trunk', 110, null],
        ['vlan120', 'bridge_vlan', 'br-trunk', 120, null],
        ['iot', '8021q', null, 30, 'eth1'],
      ]
    )
    const lan = nets.find((n) => n.key === 'lan')!
    assert.isTrue(lan.management)
    assert.equal(lan.ipv4, '192.168.1.1/24')
    assert.deepEqual(
      lan.ports.map((p) => p.port),
      ['lan1', 'lan2', 'lan3']
    )
    assert.equal(lan.dhcp?.start, 100)
    assert.equal(lan.dhcp?.owner, 'perch')
    assert.equal(lan.firewallZone, 'lan')
    assert.equal(lan.owner, 'perch')
    const v110 = nets.find((n) => n.key === 'vlan110')!
    assert.deepEqual(v110.ports, [{ port: 'trunk', tagged: true, pvid: false }])
    assert.lengthOf(v110.sections, 2, 'interface + its bridge-vlan')
    assert.isFalse(v110.management)
    const guest = nets.find((n) => n.key === 'guest')!
    assert.equal(guest.ipv4, '192.168.3.1/24')
    assert.equal(guest.firewallZone, 'guest')
    assert.lengthOf(guest.sections, 2, 'the bridge serves guest alone')
    assert.equal(nets.find((n) => n.key === 'iot')!.dhcp, null)
  })
})

test.group('networks | planning edits', () => {
  test('a VLAN on an existing VLAN bridge: bridge-vlan + interface + pool; ordinary job', ({
    assert,
  }) => {
    const states = statesOf()
    const plan = planCreateNetwork(states, {
      key: 'cams',
      l2Mode: 'bridge_vlan',
      bridge: 'br-trunk',
      vlanId: 130,
      ports: [{ port: 'trunk', tagged: true, pvid: false }],
      ipv4: '192.168.130.1/24',
      dhcp: { start: 100, limit: 50, leaseTime: '12h' },
    })
    assert.isNull(plan.converted)
    const rows = applyPlan(states, plan)
    assert.deepEqual(desiredOf(rows, 'network', 'cams')?.options, {
      device: 'br-trunk.130',
      proto: 'static',
      ipaddr: '192.168.130.1',
      netmask: '255.255.255.0',
    })
    const bv = rows.find(
      (r) => r.config === 'network' && r.type === 'bridge-vlan' && r.desired?.options.vlan === '130'
    )!
    assert.deepEqual(bv.desired!.options, { device: 'br-trunk', vlan: '130', ports: ['trunk:t'] })
    assert.equal(bv.name, `perch_${bv.perchId}`)
    assert.deepEqual(desiredOf(rows, 'dhcp', 'cams')?.options, {
      interface: 'cams',
      start: '100',
      limit: '50',
      leasetime: '12h',
    })
    const composed = composeNetworks(rows, LAN).find((n) => n.key === 'cams')!
    assert.equal(composed.l2Mode, 'bridge_vlan')
    assert.equal(composed.vlanId, 130)
    assert.equal(composed.status, 'ahead')
    const applyPlanResult = planApply({
      sections: rows,
      perchIds: rows.filter((r) => r.status === 'ahead').map((r) => r.perchId),
      kind: 'apply',
      ledger: [],
      hashes: {},
      management: LAN,
      registry: domainRegistry(),
    })
    const jobs = applyPlanResult.jobs.filter((j) => j.kind === 'apply')
    assert.lengthOf(jobs, 1)
    assert.isFalse(jobs[0].protected)
    assert.deepEqual(jobs[0].configs, ['network', 'dhcp'])
  })

  test('the first VLAN on the management bridge converts it: VLAN 1 + move, protected job', ({
    assert,
  }) => {
    const states = statesOf()
    const plan = planCreateNetwork(states, {
      key: 'iot2',
      l2Mode: 'bridge_vlan',
      bridge: 'br-lan',
      vlanId: 40,
      ports: [
        { port: 'lan3', tagged: false, pvid: true },
        { port: 'lan1', tagged: true, pvid: false },
      ],
      ipv4: '192.168.40.1/24',
    })
    assert.deepEqual(plan.converted, { bridge: 'br-lan', untaggedVlan: 1, moved: ['lan'] })
    const rows = applyPlan(states, plan)
    assert.equal(desiredOf(rows, 'network', 'lan')?.options.device, 'br-lan.1')
    assert.equal(desiredOf(rows, 'network', 'lan')?.options.ip6assign, '60', 'other options kept')
    const vlans = rows
      .filter((r) => r.type === 'bridge-vlan' && r.desired?.options.device === 'br-lan')
      .map((r) => r.desired!.options)
    assert.sameDeepMembers(vlans, [
      // lan3 becomes the new VLAN's access port, so it leaves VLAN 1.
      { device: 'br-lan', vlan: '1', ports: ['lan1:u*', 'lan2:u*'] },
      { device: 'br-lan', vlan: '40', ports: ['lan3:u*', 'lan1:t'] },
    ])
    const plan2 = planApply({
      sections: rows,
      perchIds: rows.filter((r) => r.status === 'ahead').map((r) => r.perchId),
      kind: 'apply',
      ledger: [],
      hashes: {},
      management: LAN,
      registry: domainRegistry(),
    })
    const [normal, guarded] = plan2.jobs.filter((j) => j.kind === 'apply')
    assert.isFalse(normal.protected)
    assert.isTrue(guarded.protected)
    const names = (job: typeof normal) =>
      job.ops.map((op) => ('section' in op ? op.section : '')).sort()
    assert.include(names(normal), 'iot2')
    assert.include(names(guarded), 'lan')
    assert.lengthOf(
      guarded.ops.filter((op) => op.op === 'put' && op.type === 'bridge-vlan'),
      2
    )
  })

  test('refusals: key, VLAN in use, PVID clash, overlap, bridge, conversion without sync', ({
    assert,
  }) => {
    const states = statesOf()
    const base = {
      l2Mode: 'bridge_vlan' as const,
      bridge: 'br-trunk',
      vlanId: 150,
      ports: [{ port: 'trunk', tagged: true, pvid: false }],
    }
    assert.equal(
      refusal(() => planCreateNetwork(states, { ...base, key: 'Bad' })).code,
      'network_key_invalid'
    )
    assert.equal(
      refusal(() => planCreateNetwork(states, { ...base, key: 'guest' })).code,
      'network_key_taken'
    )
    assert.equal(
      refusal(() => planCreateNetwork(states, { ...base, key: 'x', vlanId: 110 })).code,
      'vlan_in_use'
    )
    assert.equal(
      refusal(() => planCreateNetwork(states, { ...base, key: 'x', vlanId: 5000 })).code,
      'vlan_invalid'
    )
    const pvidOnce = applyPlan(
      states,
      planCreateNetwork(states, {
        ...base,
        key: 'x',
        ports: [{ port: 'trunk', tagged: false, pvid: true }],
      })
    )
    const clash = refusal(() =>
      planCreateNetwork(pvidOnce, {
        ...base,
        key: 'y',
        vlanId: 160,
        ports: [{ port: 'trunk', tagged: false, pvid: true }],
      })
    )
    assert.equal(clash.code, 'port_pvid_conflict')
    assert.equal(clash.status, 422)
    const overlap = refusal(() =>
      planCreateNetwork(states, { ...base, key: 'x', ipv4: '203.0.113.50/24' })
    )
    assert.equal(overlap.code, 'subnet_overlap')
    assert.deepInclude(overlap.data, { network: 'wan2' })
    assert.equal(
      refusal(() => planCreateNetwork(states, { ...base, key: 'x', ipv4: '192.168.150.0/24' }))
        .code,
      'ipv4_invalid'
    )
    assert.equal(
      refusal(() => planCreateNetwork(states, { ...base, key: 'x', bridge: 'br-nope' })).code,
      'bridge_not_found'
    )
    // Converting br-lan needs `lan` synced.
    const unsynced = states.map((s) =>
      s.name === 'lan' && s.config === 'network' ? { ...s, scope: 'excluded' as const } : s
    )
    const conv = refusal(() =>
      planCreateNetwork(unsynced, {
        ...base,
        key: 'x',
        bridge: 'br-lan',
        vlanId: 40,
        ports: [{ port: 'lan1', tagged: true, pvid: false }],
      })
    )
    assert.equal(conv.code, 'conversion_needs_sync')
    // A port another bridge holds.
    assert.equal(
      refusal(() =>
        planCreateNetwork(states, {
          key: 'lab',
          l2Mode: 'bridge',
          ports: [{ port: 'lan4', tagged: false, pvid: true }],
        })
      ).code,
      'port_in_use'
    )
  })

  test('bridge and 802.1q networks', ({ assert }) => {
    const states = statesOf()
    const bridged = applyPlan(
      states,
      planCreateNetwork(states, {
        key: 'lab',
        l2Mode: 'bridge',
        ports: [{ port: 'lan5', tagged: false, pvid: true }],
        ipv4: '192.168.50.1/24',
      })
    )
    const lab = composeNetworks(bridged).find((n) => n.key === 'lab')!
    assert.equal(lab.l2Mode, 'bridge')
    assert.equal(lab.bridge, 'br-lab')
    assert.deepEqual(
      lab.ports.map((p) => p.port),
      ['lan5']
    )
    const tagged = applyPlan(
      states,
      planCreateNetwork(states, { key: 'cam', l2Mode: '8021q', parentDevice: 'eth1', vlanId: 31 })
    )
    const cam = composeNetworks(tagged).find((n) => n.key === 'cam')!
    assert.equal(cam.l2Mode, '8021q')
    assert.equal(cam.proto, 'none')
    assert.equal(cam.device, 'eth1.31')
  })

  test('edits keep the spelling; VLAN id, ports and the pool', ({ assert }) => {
    const states = statesOf()
    const guest = applyPlan(states, planUpdateNetwork(states, 'guest', { ipv4: '192.168.4.1/24' }))
    assert.deepEqual(desiredOf(guest, 'network', 'guest')?.options.ipaddr, ['192.168.4.1/24'])
    const lan = applyPlan(states, planUpdateNetwork(states, 'lan', { ipv4: '192.168.1.1/23' }))
    assert.deepInclude(desiredOf(lan, 'network', 'lan')!.options, {
      ipaddr: '192.168.1.1',
      netmask: '255.255.254.0',
    })
    const moved = applyPlan(states, planUpdateNetwork(states, 'vlan120', { vlanId: 121 }))
    assert.equal(desiredOf(moved, 'network', 'vlan120')?.options.device, 'br-trunk.121')
    assert.equal(desiredOf(moved, 'network', 'cfg070f15')?.options.vlan, '121')
    const ports = applyPlan(
      states,
      planUpdateNetwork(states, 'vlan110', {
        ports: [
          { port: 'trunk', tagged: true, pvid: false },
          { port: 'trunk2', tagged: false, pvid: true },
        ],
      })
    )
    assert.deepEqual(desiredOf(ports, 'network', 'cfg060f15')?.options.ports, [
      'trunk:t',
      'trunk2:u*',
    ])
    assert.deepEqual(desiredOf(ports, 'network', 'cfg050f15')?.options.ports, ['trunk', 'trunk2'])
    const pool = applyPlan(
      states,
      planUpdateNetwork(states, 'lan', { dhcp: { start: 10, limit: 20, leaseTime: '2h' } })
    )
    assert.deepInclude(desiredOf(pool, 'dhcp', 'lan')!.options, {
      start: '10',
      limit: '20',
      leasetime: '2h',
      ra: 'server',
      dhcp_option: ['6,192.168.1.2', '42,192.168.1.1'],
    })
    const noPool = applyPlan(states, planUpdateNetwork(states, 'guest', { dhcp: null }))
    assert.isNull(desiredOf(noPool, 'dhcp', 'guest'))
    assert.equal(
      refusal(() => planUpdateNetwork(states, 'iot', { ports: [] })).code,
      'ports_not_applicable'
    )
    assert.equal(
      refusal(() =>
        planUpdateNetwork(states, 'guest', { dhcp: { start: 250, limit: 50, leaseTime: '1h' } })
      ).code,
      'dhcp_range_outside_subnet'
    )
  })

  test('delete: its own L2 sections and pool go; the management network is refused', ({
    assert,
  }) => {
    const states = statesOf()
    assert.equal(refusal(() => planDeleteNetwork(states, 'lan', LAN)).code, 'management_network')
    const plan = planDeleteNetwork(states, 'vlan110', LAN)
    const rows = applyPlan(states, plan)
    assert.isNull(desiredOf(rows, 'network', 'vlan110'))
    assert.isNull(desiredOf(rows, 'network', 'cfg060f15'))
    assert.isNotNull(desiredOf(rows, 'network', 'cfg050f15'), 'the trunk bridge stays')
    const guest = applyPlan(states, planDeleteNetwork(states, 'guest', LAN))
    assert.isNull(desiredOf(guest, 'network', 'guest_dev'))
    assert.isNull(desiredOf(guest, 'dhcp', 'guest'))
  })
})

test.group('networks | the gateway report', () => {
  test('absent vs none; junk dropped; scope', ({ assert }) => {
    assert.isNull(parseNetworksReport(undefined))
    assert.deepEqual(parseNetworksReport([]), [])
    const parsed = parseNetworksReport([
      {
        name: 'lan',
        device: 'br-lan',
        proto: 'static',
        up: true,
        ipv4: ['192.168.1.1/24'],
        rxBytes: 10,
        txBytes: 20,
        rxRate: 1.5,
        captured: true,
        devices: 3,
        activeDevices: 2,
        capture: { bytesInLan: 5, scope: 'routed', kernelDrops: 0 },
      },
      { name: 'lan' },
      { name: 'much-too-long-network-name' },
      { name: 'bad name' },
      'nope',
      { name: 'office', up: false, captured: false },
    ])!
    assert.deepEqual(
      parsed.map((n) => n.name),
      ['lan', 'office']
    )
    assert.equal(parsed[0].capture?.bytesInLan, 5)
    assert.equal(parsed[0].capture?.bytesOutWan, 0)
    assert.isNull(parsed[1].rxBytes)
    assert.equal(reportScope(parsed), 'routed')
    assert.isNull(reportScope(parsed.slice(1)))
  })
})
