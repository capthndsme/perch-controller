import { planApply } from '#services/gateway_config/apply_plan'
import { checkRoundTrip, syncedFromRouter, type ChecksCtx } from '#services/gateway_config/domain'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { networksDomain } from '#services/gateway_config/domains/networks'
import { dhcpPoolsDomain } from '#services/gateway_config/domains/dhcp_pools'
import { sidesOf, sidesOfSet, type SideFacts } from '#services/gateway_config/domains/side'
import {
  primaryUplink,
  validateWan,
  wanDomain,
  wanTopology,
} from '#services/gateway_config/domains/wan'
import {
  GATEWAY_SYNC_DEFAULTS,
  type GatewaySyncSettings,
} from '#services/gateway_config/gateway_sync_settings'
import { reconcileRead, type SectionState } from '#services/gateway_config/sync_engine'
import type {
  GatewayCapabilities,
  SectionContent,
  UciConfigSet,
  UciSection,
} from '#services/gateway_config/types'
import { deriveWanChecks } from '#services/gateway_config/wan_checks'
import {
  gatewaySyncConfig,
  gatewaySyncSet,
  rowsAfter,
} from '#tests/unit/services/fixtures/gateway_sync'
import { test } from '@japa/runner'

/**
 * Gateway sync B1 (docs/design/gateway-sync/domains.md 2 and 3): the side
 * rule in the collector's order on the live-shaped fixture (README section
 * 2), the `wan` domain's claims, round trip, topology, validation, the
 * checks it derives, the planner's checked job, and the Authoritative policy
 * (owner decision D2).
 */

const NOW = '2026-09-30T10:00:00.000Z'
const CAPS: GatewayCapabilities = {
  features: ['config.checks.v1'],
  allowedConfigs: ['network', 'dhcp', 'firewall'],
  writableConfigs: ['network', 'dhcp', 'firewall'],
}
const settings: GatewaySyncSettings = {
  ...GATEWAY_SYNC_DEFAULTS,
  checkTargets: [...GATEWAY_SYNC_DEFAULTS.checkTargets],
}

function live(): UciConfigSet {
  return gatewaySyncSet('network', 'firewall_zones', 'dhcp')
}

function section(all: UciConfigSet, config: string, name: string): UciSection {
  const s = all[config].sections.find((x) => x.name === name)
  if (!s) throw new Error(`no ${config}.${name}`)
  return s
}

let ids = 0
function firstRead(all: UciConfigSet, capabilities: GatewayCapabilities | null = CAPS) {
  ids = 0
  const result = reconcileRead({
    rows: [],
    read: { configs: Object.values(all), ledger: [] },
    registry: domainRegistry(),
    mode: 'managed',
    authoritative: false,
    now: NOW,
    newPerchId: () => `p${String(++ids).padStart(3, '0')}`,
    capabilities,
  })
  return rowsAfter([], result.changes)
}

function row(rows: SectionState[], config: string, name: string): SectionState {
  const r = rows.find((x) => x.config === config && x.name === name)
  if (!r) throw new Error(`no row ${config}.${name}`)
  return r
}

function content(all: UciConfigSet, config: string, name: string): SectionContent {
  const s = section(all, config, name)
  return { type: s.type, options: { ...s.options } }
}

/** A ChecksCtx for a job that changes the given sections (after = the new options, null = deleted). */
function checksCtx(
  all: UciConfigSet,
  changes: Array<{ config: string; name: string; after: SectionContent | null }>,
  up: Record<string, boolean>,
  extra: Partial<ChecksCtx> = {}
): ChecksCtx {
  const after: UciConfigSet = structuredClone(all)
  for (const c of changes) {
    const sections = after[c.config].sections
    const i = sections.findIndex((s) => s.name === c.name)
    if (c.after === null) sections.splice(i, 1)
    else if (i === -1) {
      sections.push({
        name: c.name,
        type: c.after.type,
        anonymous: false,
        index: sections.length,
        options: c.after.options,
      })
    } else sections[i] = { ...sections[i], type: c.after.type, options: c.after.options }
  }
  return {
    sections: changes.map((c, i) => ({
      perchId: `s${i}`,
      config: c.config,
      name: c.name,
      before: all[c.config].sections.some((s) => s.name === c.name)
        ? content(all, c.config, c.name)
        : null,
      after: c.after,
    })),
    before: all,
    after,
    observed: {
      interfaces: Object.entries(up).map(([network, isUp]) => ({ network, up: isUp })),
    },
    settings,
    managementPath: { network: 'lan', device: 'lan0' },
    ...extra,
  }
}

const LIVE_UP = { wan: true, wan6: false, lan2: true, globe: false, globev6: false, lan: true }

// ── the side rule (domains.md 2) ──────────────────────────────────────────

test.group('gateway sync | the side rule (collector order)', () => {
  test('the live topology classifies as README section 2', ({ assert }) => {
    const sides = Object.fromEntries(sidesOfSet(live()))
    assert.deepEqual(sides, {
      loopback: 'loopback',
      wan: 'wan',
      wan6: 'wan',
      lan: 'lan',
      ADDR: 'wan',
      globe: 'wan',
      globe_force: 'wan',
      globev6: 'wan',
      LANX: 'wan',
      lan2: 'wan',
      wgfix: 'vpn',
    })
    // Without the firewall read: ADDR still an alias on wan0 (rule 4), LANX a LAN.
    const noFw = Object.fromEntries(sidesOfSet({ network: gatewaySyncConfig('network') }))
    assert.equal(noFw.ADDR, 'wan')
    assert.equal(noFw.globe_force, 'wan')
    assert.equal(noFw.LANX, 'lan')
  })

  test('order: loopback, then tunnels, then WAN signals, then aliases, else lan', ({ assert }) => {
    const net = (name: string, options: Record<string, string>) => ({
      name,
      type: 'interface',
      options,
    })
    const zones = [{ type: 'zone', options: { name: 'z', masq: '1', network: 'wgm' } }]
    const sides = sidesOf(
      [
        net('loopback', { proto: 'dhcp' }),
        net('lo2', { proto: 'static', device: 'lo' }),
        net('wgm', { proto: 'wireguard' }), // a tunnel in a masq zone stays vpn
        net('gw', { proto: 'static', device: 'eth9', gateway: '192.168.9.1' }),
        net('relay', { proto: 'relay' }), // unknown proto: falls through to lan
        net('onalias', { proto: 'none', device: 'eth9' }), // alias on gw's device
        net('atalias', { proto: 'static', device: '@gw' }),
        net('dhcpalias', { proto: 'dhcp', device: 'eth9' }), // a WAN proto of its own
        net('routed', { proto: 'static', device: 'eth7' }),
        net('conf', { proto: 'static', device: 'eth8' }),
        net('conf2', { proto: 'static', device: 'eth6' }),
        net('plain', { proto: 'static', device: 'eth5' }),
      ],
      zones,
      { defaultRoute: ['routed'], configuredWan: ['conf', 'eth6'], l3Devices: { conf2: 'eth6' } }
    )
    assert.deepEqual(Object.fromEntries(sides), {
      loopback: 'loopback',
      lo2: 'loopback',
      wgm: 'vpn',
      gw: 'wan',
      relay: 'lan',
      onalias: 'wan',
      atalias: 'wan',
      dhcpalias: 'wan',
      routed: 'wan',
      conf: 'wan',
      conf2: 'wan',
      plain: 'lan',
    })
  })

  test('a UCI default route counts as a default route (disabled ones do not)', ({ assert }) => {
    const sides = sidesOf(
      [
        { name: 'up', type: 'interface', options: { proto: 'static', device: 'eth1' } },
        { name: 'off', type: 'interface', options: { proto: 'static', device: 'eth2' } },
        {
          name: 'r1',
          type: 'route',
          options: { interface: 'up', target: '0.0.0.0', netmask: '0.0.0.0' },
        },
        {
          name: 'r2',
          type: 'route',
          options: { interface: 'off', target: '0.0.0.0/0', disabled: '1' },
        },
      ],
      []
    )
    assert.equal(sides.get('up'), 'wan')
    assert.equal(sides.get('off'), 'lan')
  })

  test('networks and dhcp_pools no longer claim WAN-side sections', ({ assert }) => {
    const all = live()
    const net = (name: string) => ({ ...section(all, 'network', name), config: 'network' })
    assert.isTrue(networksDomain.claims(net('lan'), all))
    for (const name of ['globe_force', 'ADDR', 'LANX', 'wgfix', 'wan', 'loopback']) {
      assert.isFalse(networksDomain.claims(net(name), all), name)
    }
    const pool = (name: string) => ({ ...section(all, 'dhcp', name), config: 'dhcp' })
    assert.isTrue(dhcpPoolsDomain.claims(pool('lan'), all))
    assert.isFalse(dhcpPoolsDomain.claims(pool('wan'), all))
  })
})

// ── the wan domain (domains.md 3) ─────────────────────────────────────────

test.group('gateway sync | wan domain claims and round trip', () => {
  test('claims every WAN-side interface, the uplink port and the WAN pool', ({ assert }) => {
    const rows = firstRead(live())
    const byDomain = (d: string) =>
      rows
        .filter((r) => r.domain === d && r.scope === 'synced')
        .map((r) => `${r.config}.${r.name}`)
        .sort()
    assert.deepEqual(byDomain('wan'), [
      'dhcp.wan',
      'network.ADDR',
      'network.LANX',
      'network.cfg0b3837',
      'network.globe',
      'network.globe_force',
      'network.globev6',
      'network.lan2',
      'network.wan',
      'network.wan6',
    ])
    assert.deepEqual(byDomain('networks'), ['network.lan'])
    assert.equal(row(rows, 'network', 'loopback').scope, 'unmodeled')
    assert.equal(row(rows, 'network', 'wgfix').scope, 'unmodeled', 'WireGuard is B2')
    assert.deepEqual(row(rows, 'dhcp', 'wan').ownership, {
      kind: 'options',
      options: ['interface', 'ignore', 'ra', 'dhcpv6', 'ndp', 'master', 'ra_flags'],
    })
  })

  test('without config.checks.v1 (or network writable) nothing is claimed', ({ assert }) => {
    for (const caps of [
      { ...CAPS, features: [] },
      { ...CAPS, writableConfigs: ['dhcp'] },
    ]) {
      const rows = firstRead(live(), caps)
      assert.isFalse(rows.some((r) => r.domain === 'wan'))
      assert.equal(row(rows, 'network', 'globe_force').scope, 'unmodeled')
    }
    assert.match(wanDomain.requires!({ features: [] }) ?? '', /too old/)
  })

  test('round-trips every claimed section exactly', ({ assert }) => {
    const all = live()
    const claimed = [...all.network.sections, ...all.dhcp.sections]
      .map((s) => ({ s, config: all.network.sections.includes(s) ? 'network' : 'dhcp' }))
      .filter(({ s, config }) => wanDomain.claims({ ...s, config }, all))
      .map(({ s, config }, i) => syncedFromRouter(config, s, `w${i}`))
    assert.lengthOf(claimed, 10)
    const report = checkRoundTrip(wanDomain, claimed)
    assert.isTrue(report.ok, JSON.stringify(report.failures))
  })

  test('topology: three uplinks by metric, companions, aliases, NAT link, port, pool', ({
    assert,
  }) => {
    const t = wanTopology(live())
    assert.deepEqual(
      t.uplinks.map((u) => [u.network, u.rank, u.companion, u.aliases, u.deviceSection, u.pool]),
      [
        ['wan', 1, 'wan6', ['ADDR'], 'cfg0b3837', 'wan'],
        ['lan2', 2, null, [], null, null],
        ['globe', 3, 'globev6', ['globe_force'], null, null],
      ]
    )
    assert.deepEqual(
      t.natLinks.map((l) => [l.network, l.role, l.rank]),
      [['LANX', 'nat_link', null]]
    )
    assert.equal(primaryUplink(t)?.network, 'wan')
    const promoted = wanTopology(live(), { roles: { LANX: 'internet' } })
    assert.deepEqual(
      promoted.uplinks.map((u) => u.network),
      ['LANX', 'wan', 'lan2', 'globe'],
      'a role override makes it an uplink (metric 0 sorts first)'
    )
  })
})

test.group('gateway sync | wan validation (domains.md 3.4)', () => {
  function issuesFor(edit: (all: UciConfigSet) => void) {
    const all = live()
    edit(all)
    const desired = [...all.network.sections, ...all.dhcp.sections, ...all.firewall.sections].map(
      (s, i) => {
        const config = all.network.sections.includes(s)
          ? 'network'
          : all.dhcp.sections.includes(s)
            ? 'dhcp'
            : 'firewall'
        return { ...syncedFromRouter(config, s, `v${i}`), position: s.index }
      }
    )
    const mine = desired.filter((s) =>
      wanDomain.claims(
        {
          name: s.name,
          type: s.type,
          anonymous: s.anonymous,
          index: 0,
          options: s.options,
          config: s.config,
        },
        all
      )
    )
    return validateWan(mine, { capabilities: CAPS, all: desired })
  }
  const codes = (issues: Array<{ code: string; section?: string }>) =>
    issues.map((i) => `${i.code}@${i.section}`).sort()

  test('the live topology validates with warnings only', ({ assert }) => {
    const issues = issuesFor(() => {})
    assert.isFalse(
      issues.some((i) => i.severity === 'error'),
      JSON.stringify(issues)
    )
    assert.deepInclude(codes(issues), 'wan_mac_override_ignored@wan')
  })

  test('errors: addresses, gateway outside the subnet, alias overlap, MAC, MTU, metric, PPPoE', ({
    assert,
  }) => {
    const issues = issuesFor((all) => {
      const set = (name: string, o: Record<string, string | string[]>) =>
        Object.assign(section(all, 'network', name).options, o)
      set('lan2', {
        proto: 'static',
        ipaddr: '203.0.113.10/24',
        gateway: '203.0.114.1',
        metric: 'x',
      })
      set('globe_force', { ipaddr: '192.168.254.2/24' })
      set('globe', { proto: 'static', ipaddr: '192.168.254.9/24', gateway: '192.168.254.1' })
      set('wan', { proto: 'pppoe', macaddr: 'zz', mtu: '100' })
      set('ADDR', { ipaddr: ['192.168.100.300/24'] })
    })
    const errors = codes(issues.filter((i) => i.severity === 'error'))
    for (const want of [
      'wan_gateway_outside_subnet@lan2',
      'wan_metric_invalid@lan2',
      'wan_alias_overlaps_uplink@globe_force',
      'wan_mac_invalid@wan',
      'wan_mtu_invalid@wan',
      'wan_pppoe_username_required@wan',
      'wan_static_address_invalid@ADDR',
    ]) {
      assert.include(errors, want)
    }
  })

  test('warnings: no zone, duplicate metric, option not for the proto', ({ assert }) => {
    const issues = issuesFor((all) => {
      Object.assign(section(all, 'network', 'lan2').options, { metric: '1', username: 'x' })
      const wanZone = all.firewall.sections.find((s) => s.options.name === 'globe')!
      wanZone.options.network = []
    })
    const warnings = codes(issues.filter((i) => i.severity === 'warning'))
    assert.include(warnings, 'wan_duplicate_metric@lan2')
    assert.include(warnings, 'wan_option_not_for_proto@lan2')
    assert.include(warnings, 'wan_no_zone@globe')
  })
})

// ── checks (domains.md 3.8) ───────────────────────────────────────────────

test.group('gateway sync | wan checks', () => {
  test('a metric change of a down WAN: its own check optional, internet checks via the primary', ({
    assert,
  }) => {
    const all = live()
    const globe = content(all, 'network', 'globe')
    const plan = deriveWanChecks(
      checksCtx(
        all,
        [
          {
            config: 'network',
            name: 'globe',
            after: { ...globe, options: { ...globe.options, metric: '101' } },
          },
        ],
        LIVE_UP
      )
    )
    assert.deepEqual(plan, {
      timeoutSeconds: 60,
      items: [
        { id: 'up:globe', kind: 'interface_up', network: 'globe', family: 4 },
        { id: 'route4', kind: 'default_route', family: 4 },
        {
          id: 'reach4',
          kind: 'reach',
          family: 4,
          targets: ['$gateway:wan', '1.1.1.1', '8.8.8.8'],
          tcpPort: 443,
        },
        { id: 'dns', kind: 'resolve', name: 'example.com' },
      ],
    })
  })

  test('mustPass: a proto change of an up WAN, enabling one, a MAC change on its port', ({
    assert,
  }) => {
    const all = live()
    const wan = content(all, 'network', 'wan')
    const proto = deriveWanChecks(
      checksCtx(
        all,
        [
          {
            config: 'network',
            name: 'wan',
            after: {
              ...wan,
              options: { ...wan.options, proto: 'pppoe', username: 'u' },
            },
          },
        ],
        LIVE_UP
      )
    )!
    assert.deepInclude(proto.items, {
      id: 'up:wan',
      kind: 'interface_up',
      network: 'wan',
      family: 4,
      mustPass: true,
    })
    assert.equal(proto.timeoutSeconds, 90, 'PPPoE budget')

    Object.assign(section(all, 'network', 'lan2').options, { disabled: '1' })
    const lan2 = content(all, 'network', 'lan2')
    const enable = deriveWanChecks(
      checksCtx(
        all,
        [
          {
            config: 'network',
            name: 'lan2',
            after: { ...lan2, options: { proto: 'dhcp', device: 'wan2', metric: '2' } },
          },
        ],
        { ...LIVE_UP, lan2: false }
      )
    )!
    assert.isTrue(enable.items.find((i) => i.id === 'up:lan2')?.mustPass)

    const port = content(all, 'network', 'cfg0b3837')
    const mac = deriveWanChecks(
      checksCtx(
        live(),
        [
          {
            config: 'network',
            name: 'cfg0b3837',
            after: { ...port, options: { ...port.options, macaddr: '02:00:00:00:00:0c' } },
          },
        ],
        LIVE_UP
      )
    )!
    assert.deepInclude(mac.items, {
      id: 'up:wan',
      kind: 'interface_up',
      network: 'wan',
      family: 4,
      mustPass: true,
    })
  })

  test('a disabled or deleted uplink gets no interface_up; the internet checks stay', ({
    assert,
  }) => {
    const all = live()
    const plan = deriveWanChecks(
      checksCtx(all, [{ config: 'network', name: 'lan2', after: null }], LIVE_UP)
    )!
    assert.deepEqual(
      plan.items.map((i) => i.id),
      ['route4', 'reach4', 'dns']
    )
  })

  test('aliases and the WAN pool are checked jobs; a NAT link alone is not', ({ assert }) => {
    const all = live()
    const addr = content(all, 'network', 'ADDR')
    const alias = deriveWanChecks(
      checksCtx(
        all,
        [
          {
            config: 'network',
            name: 'ADDR',
            after: { ...addr, options: { ...addr.options, ipaddr: ['192.168.100.22/24'] } },
          },
        ],
        LIVE_UP
      )
    )!
    assert.deepEqual(
      alias.items.map((i) => i.id),
      ['route4', 'reach4', 'dns']
    )
    const pool = content(all, 'dhcp', 'wan')
    assert.isNotNull(
      deriveWanChecks(
        checksCtx(
          all,
          [
            {
              config: 'dhcp',
              name: 'wan',
              after: { ...pool, options: { ...pool.options, ignore: '0' } },
            },
          ],
          LIVE_UP
        )
      )
    )
    const lanx = content(all, 'network', 'LANX')
    assert.isNull(
      deriveWanChecks(
        checksCtx(
          all,
          [
            {
              config: 'network',
              name: 'LANX',
              after: { ...lanx, options: { ...lanx.options, ipaddr: '192.168.201.1' } },
            },
          ],
          LIVE_UP
        )
      )
    )
  })

  test('the IPv6 default route when a companion was up; targets per WAN; resolve off', ({
    assert,
  }) => {
    const all = live()
    const wan = content(all, 'network', 'wan')
    const plan = deriveWanChecks(
      checksCtx(
        all,
        [
          {
            config: 'network',
            name: 'wan',
            after: { ...wan, options: { ...wan.options, metric: '5' } },
          },
        ],
        { ...LIVE_UP, wan6: true },
        {
          settings: { ...settings, checkResolveName: '' },
          targets: { lan2: ['192.0.2.1'] },
        }
      )
    )!
    // wan moved to metric 5: lan2 (metric 2) is the primary after the job.
    assert.deepEqual(
      plan.items.map((i) => i.id),
      ['up:wan', 'route4', 'reach4', 'route6']
    )
    assert.deepEqual(plan.items.find((i) => i.id === 'reach4')?.targets, ['192.0.2.1'])
  })
})

// ── the planner's checked job (domains.md 1.5) ────────────────────────────

test.group('gateway sync | checked jobs in the planner', () => {
  function planned(options: { caps?: GatewayCapabilities; none?: boolean; path?: string } = {}) {
    const all = live()
    const rows = firstRead(all)
    const edit = (r: SectionState, set: Record<string, string>): SectionState => ({
      ...r,
      desired: { ...r.desired!, options: { ...r.desired!.options, ...set } },
      status: 'ahead',
    })
    const next = rows.map((r) => {
      if (r.config === 'network' && r.name === 'globe') return edit(r, { metric: '101' })
      if (r.config === 'network' && r.name === 'lan') return edit(r, { dns_search: 'home' })
      return r
    })
    return planApply({
      sections: next,
      kind: 'apply',
      ledger: next
        .filter((r) => r.scope === 'synced')
        .map((r) => ({ perchId: r.perchId, config: r.config, section: r.name, domain: r.domain! })),
      hashes: {},
      management: {
        network: options.path ?? 'lan',
        device: options.path === 'wan' ? 'wan0' : 'lan0',
      },
      registry: domainRegistry(),
      capabilities: options.caps ?? CAPS,
      checks: {
        settings,
        observed: { interfaces: Object.entries(LIVE_UP).map(([network, up]) => ({ network, up })) },
        none: options.none,
      },
    })
  }

  test('LAN edit in the protected job, the WAN edit in its own checked job', ({ assert }) => {
    const plan = planned()
    assert.deepEqual(
      plan.jobs.map((j) => [j.protected, j.checked, j.perchIds.length]),
      [
        [false, true, 1],
        [true, false, 1],
      ]
    )
    const checked = plan.jobs[0]
    assert.equal(checked.changes[0].section, 'globe')
    assert.deepEqual(
      checked.checks?.items.map((i) => i.id),
      ['up:globe', 'route4', 'reach4', 'dns']
    )
    assert.equal(checked.checks?.timeoutSeconds, 60)
  })

  test('a WAN-side management path: every WAN section protected, with its checks', ({ assert }) => {
    const plan = planned({ path: 'wan' })
    const wanJob = plan.jobs.find((j) => j.changes.some((c) => c.section === 'globe'))!
    assert.isTrue(wanJob.protected)
    assert.isTrue(wanJob.checked)
    assert.isNotNull(wanJob.checks)
  })

  test('no config.checks.v1: no checked job; `none`: an explicitly empty check list', ({
    assert,
  }) => {
    // Without the feature the wan domain is unavailable: its sections are not
    // planned at all (never sent without checks), the LAN edit goes alone.
    const without = planned({ caps: { ...CAPS, features: [] } })
    assert.isFalse(without.jobs.some((j) => j.checked))
    assert.isFalse(without.jobs.some((j) => j.changes.some((c) => c.section === 'globe')))
    assert.isTrue(without.jobs.some((j) => j.changes.some((c) => c.section === 'lan')))
    const none = planned({ none: true })
    assert.deepEqual(none.jobs.find((j) => j.checked)?.checks, { timeoutSeconds: 0, items: [] })
  })
})

// ── Authoritative Mode and WAN sections (domains.md 3.7, D2) ──────────────

test.group('gateway sync | Authoritative policy for WAN sections', () => {
  function routerEdit(
    policy: 'import' | 'enforce',
    set: Record<string, string>,
    facts?: SideFacts
  ) {
    const all = live()
    const rows = firstRead(all)
    const next = structuredClone(all)
    Object.assign(section(next, 'network', 'lan2').options, set)
    const result = reconcileRead({
      rows,
      read: { configs: Object.values(next), ledger: [] },
      registry: domainRegistry(),
      mode: 'managed',
      authoritative: true,
      now: NOW,
      newPerchId: () => 'x1',
      capabilities: CAPS,
      gatewaySync: { ...settings, authoritativeWan: policy },
      sideFacts: facts ?? null,
    })
    return rowsAfter(rows, result.changes)
  }

  test('import (default): a router edit of a WAN is imported, never drift', ({ assert }) => {
    const after = row(routerEdit('import', { metric: '7' }), 'network', 'lan2')
    assert.equal(after.status, 'in_sync')
    assert.equal(after.desired?.options.metric, '7')
  })

  test('enforce: a WAN edit is drift; enabling or disabling it is imported', ({ assert }) => {
    const drift = row(routerEdit('enforce', { metric: '7' }), 'network', 'lan2')
    assert.equal(drift.status, 'drift')
    assert.equal(drift.desired?.options.metric, '2')
    const paused = row(routerEdit('enforce', { disabled: '1' }), 'network', 'lan2')
    assert.equal(paused.status, 'in_sync')
    assert.equal(paused.desired?.options.disabled, '1')
  })

  test('LAN sections still follow the gateway flag', ({ assert }) => {
    const all = live()
    const rows = firstRead(all)
    const next = structuredClone(all)
    Object.assign(section(next, 'network', 'lan').options, { dns_search: 'home' })
    const result = reconcileRead({
      rows,
      read: { configs: Object.values(next), ledger: [] },
      registry: domainRegistry(),
      mode: 'managed',
      authoritative: true,
      now: NOW,
      newPerchId: () => 'x1',
      capabilities: CAPS,
      gatewaySync: settings,
    })
    assert.equal(row(rowsAfter(rows, result.changes), 'network', 'lan').status, 'drift')
  })
})

// ── re-homing globe_force (domains.md 1.3, README 10) ─────────────────────

test.group('gateway sync | globe_force moves from networks to wan', () => {
  test('synced by networks before the upgrade, re-homed in place with B/C/R kept', ({ assert }) => {
    const all = live()
    // Before: the old rule (a collector without checks: wan claims nothing),
    // and networks had taken globe_force as a LAN (built by hand here).
    const before = firstRead(all, { ...CAPS, features: [] })
    const gf = row(before, 'network', 'globe_force')
    const legacy: SectionState = {
      ...gf,
      scope: 'synced',
      domain: 'networks',
      ownership: null,
    }
    const rows = before.map((r) => (r.perchId === gf.perchId ? legacy : r))
    const result = reconcileRead({
      rows,
      read: { configs: Object.values(all), ledger: [] },
      registry: domainRegistry(),
      mode: 'managed',
      authoritative: false,
      now: NOW,
      newPerchId: () => 'x1',
      capabilities: CAPS,
    })
    const after = row(rowsAfter(rows, result.changes), 'network', 'globe_force')
    assert.equal(after.domain, 'wan')
    assert.equal(after.scope, 'synced')
    assert.deepEqual(after.base, legacy.base)
    assert.isTrue(
      result.events.some(
        (e) =>
          e.event === 'section_rehomed' && e.detail?.from === 'networks' && e.detail?.to === 'wan'
      )
    )
  })
})
