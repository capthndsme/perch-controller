import { ambiguityGroups, memberSummary } from '#services/gateway_config/ambiguity_service'
import {
  checkRoundTrip,
  syncedFromRouter,
  type ConfigDomain,
  type SyncedSection,
} from '#services/gateway_config/domain'
import { dnsRecordsDomain, isDnsHost } from '#services/gateway_config/domains/dns_records'
import {
  defaultsOf,
  FIREWALL_DEFAULTS_OWNED,
  firewallDefaultsDomain,
} from '#services/gateway_config/domains/firewall_defaults'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { reconcileRead, type SectionState } from '#services/gateway_config/sync_engine'
import type { UciConfig } from '#services/gateway_config/types'
import {
  gatewaySyncConfig,
  gatewaySyncSet,
  rowsAfter,
} from '#tests/unit/services/fixtures/gateway_sync'
import { test } from '@japa/runner'

/**
 * Gateway sync domains built in Phase A (docs/design/gateway-sync/domains.md
 * 5 and 6; work package B3) over fixtures shaped like the live gateway:
 * `firewall_defaults`, the `dns_records` host type, and the ambiguity groups
 * with their suggested names (the four-redirect fixture).
 */

function claimed(domain: ConfigDomain, config: UciConfig): SyncedSection[] {
  const all = { [config.name]: config }
  return config.sections
    .filter((s) => domainRegistry().claim({ ...s, config: config.name }, all)?.domain === domain)
    .map((s, i) => syncedFromRouter(config.name, s, `p${i}`))
}

function firstRead(configs: UciConfig[]): SectionState[] {
  let n = 0
  const result = reconcileRead({
    rows: [],
    read: { configs, ledger: [] },
    registry: domainRegistry(),
    mode: 'managed',
    authoritative: false,
    now: '2026-09-30T10:00:00.000Z',
    newPerchId: () => `id${++n}`,
  })
  return rowsAfter([], result.changes)
}

test.group('gateway sync domains | firewall_defaults (domains.md 5)', () => {
  test('claims the defaults section with option ownership; round trip exact', ({ assert }) => {
    const firewall = gatewaySyncConfig('firewall')
    const sections = claimed(firewallDefaultsDomain as ConfigDomain, firewall)
    assert.lengthOf(sections, 1)
    assert.equal(sections[0].type, 'defaults')
    assert.isTrue(sections[0].anonymous)
    const report = checkRoundTrip(firewallDefaultsDomain as ConfigDomain, sections)
    assert.isTrue(report.ok, JSON.stringify(report.failures))
    assert.deepEqual(
      firewallDefaultsDomain.ownership!({ ...firewall.sections[0], config: 'firewall' }),
      {
        kind: 'options',
        options: [
          'input',
          'output',
          'forward',
          'synflood_protect',
          'drop_invalid',
          'flow_offloading',
          'flow_offloading_hw',
        ],
      }
    )
    assert.deepEqual(defaultsOf(sections[0].options), {
      input: 'ACCEPT',
      output: 'ACCEPT',
      forward: 'ACCEPT',
      synfloodProtect: true,
      dropInvalid: false,
      flowOffloading: false,
      flowOffloadingHw: false,
    })
  })

  test('policies uppercase and flags 0/1 for equality; validation codes', ({ assert }) => {
    const n = firewallDefaultsDomain.normalize!
    assert.equal(n('defaults', 'input', 'reject'), 'REJECT')
    assert.equal(n('defaults', 'flow_offloading', 'yes'), '1')
    assert.equal(n('defaults', 'tcp_syncookies', 'yes'), 'yes', 'router-owned options untouched')
    const bad: SyncedSection = {
      perchId: 'd1',
      config: 'firewall',
      name: 'cfg01e63d',
      type: 'defaults',
      anonymous: true,
      options: { input: 'ALLOW', output: 'ACCEPT', forward: 'REJECT', flow_offloading_hw: '1' },
    }
    const issues = firewallDefaultsDomain.validate([bad], { capabilities: null, all: [bad] })
    assert.deepEqual(
      issues.map((i) => [i.code, i.severity, i.option]),
      [
        ['firewall_policy_invalid', 'error', 'input'],
        ['firewall_offloading_blinds_collector', 'warning', 'flow_offloading_hw'],
      ]
    )
  })

  test('in sync: offloading the router runs must match UCI (stale or absent: skipped)', ({
    assert,
  }) => {
    const row = {
      perchId: 'd1',
      name: 'cfg01e63d',
      type: 'defaults',
      scope: 'synced' as const,
      issue: null,
      options: { input: 'ACCEPT', flow_offloading: '1' },
    }
    const inSync = firewallDefaultsDomain.inSync!
    assert.deepEqual(inSync([row], {}), [])
    assert.deepEqual(
      inSync([row], { offloading: { flowOffloading: true, flowOffloadingHw: false } }),
      []
    )
    assert.deepEqual(
      inSync([row], { offloading: { flowOffloading: false, flowOffloadingHw: false } }).map(
        (i) => i.code
      ),
      ['firewall_offloading_not_live']
    )
  })

  test('the firewall domain still leaves defaults alone; the first read claims them', ({
    assert,
  }) => {
    const rows = firstRead([gatewaySyncConfig('firewall')])
    const defaults = rows.find((r) => r.type === 'defaults')!
    assert.equal(defaults.scope, 'synced')
    assert.equal(defaults.domain, 'firewall_defaults')
    assert.deepEqual(defaults.ownership, { kind: 'options', options: [...FIREWALL_DEFAULTS_OWNED] })
    const include = rows.find((r) => r.name === 'miniupnpd')!
    assert.equal(include.scope, 'unmodeled', 'package includes stay observed')
  })
})

test.group('gateway sync domains | dns_records host records (domains.md 6)', () => {
  test('a MAC-less host is a record; a reservation stays dhcp_hosts; round trip exact', ({
    assert,
  }) => {
    const dhcp = gatewaySyncConfig('dhcp')
    const rows = firstRead([dhcp])
    const record = rows.find((r) => r.router?.options.name === 'controller-box')!
    assert.equal(record.scope, 'synced')
    assert.equal(record.domain, 'dns_records')
    assert.deepEqual(record.ownership, { kind: 'options', options: ['name', 'ip', 'dns'] })
    const nas = rows.find((r) => r.router?.options.name === 'nas')!
    assert.equal(nas.domain, 'dhcp_hosts')
    assert.equal(
      rows.find((r) => r.name === 'odhcpd')!.scope,
      'unmodeled',
      'odhcpd stays unmodeled'
    )

    const sections = claimed(dnsRecordsDomain as ConfigDomain, dhcp)
    assert.lengthOf(sections, 1)
    const report = checkRoundTrip(dnsRecordsDomain as ConfigDomain, sections)
    assert.isTrue(report.ok, JSON.stringify(report.failures))
    const [parsed] = dnsRecordsDomain.parse(sections)
    assert.deepInclude(parsed, { type: 'host', name: 'controller-box', value: '192.168.1.5' })
    assert.deepEqual(parsed.extra, { dns: '1', hostid: '10' })
    assert.deepEqual(dnsRecordsDomain.identityKeys!(sections[0]), ['host:controller-box'])
  })

  test('only hosts without mac or duid and with a plain name and ip', ({ assert }) => {
    assert.isTrue(isDnsHost({ name: 'box', ip: '192.168.1.5', dns: '1' }))
    assert.isFalse(isDnsHost({ name: 'box', ip: '192.168.1.5', mac: '02:00:00:00:00:05' }))
    assert.isFalse(isDnsHost({ name: 'box', ip: '192.168.1.5', duid: '0001' }))
    assert.isFalse(isDnsHost({ name: 'box' }))
    assert.isFalse(isDnsHost({ name: ['a', 'b'], ip: '192.168.1.5' }))
  })

  test('the controller address is a warning; a bad address an error', ({ assert }) => {
    const host = (ip: string): SyncedSection => ({
      perchId: 'h1',
      config: 'dhcp',
      name: 'cfg08fe63',
      type: 'host',
      anonymous: true,
      options: { name: 'controller-box', ip, dns: '1' },
    })
    const ctx = (s: SyncedSection) => ({
      capabilities: null,
      all: [s],
      managementPath: { network: 'lan', device: 'br-lan', controllerAddress: '192.168.1.5' },
    })
    const warned = dnsRecordsDomain.validate([host('192.168.1.5')], ctx(host('192.168.1.5')))
    assert.deepEqual(
      warned.map((i) => [i.code, i.severity]),
      [['dns_controller_address', 'warning']]
    )
    const bad = dnsRecordsDomain.validate([host('not-an-ip')], ctx(host('not-an-ip')))
    assert.deepEqual(
      bad.map((i) => i.code),
      ['dns_value_invalid']
    )
  })
})

test.group('gateway sync domains | ambiguity groups (the four redirects)', () => {
  test('two groups with summaries and unique suggested names', ({ assert }) => {
    const rows = firstRead(Object.values(gatewaySyncSet('firewall')))
    const groups = ambiguityGroups(rows)
    assert.deepEqual(
      groups.map((g) => [g.key, g.domain, g.type, g.reason, g.nameOption, g.members.length]),
      [
        ['redirect:game', 'firewall', 'redirect', 'ambiguous', 'name', 2],
        ['redirect:wgx', 'firewall', 'redirect', 'ambiguous', 'name', 2],
      ]
    )
    const [game, wgx] = groups
    assert.deepEqual(
      game.members.map((m) => [m.suggestedName, m.enabled, m.anonymous]),
      [
        ['GAME 25500-25600', false, true],
        ['GAME 45565', true, true],
      ]
    )
    assert.equal(
      game.members[0].summary,
      'GAME: wan tcp/udp 25500-25600 → 192.168.1.10:25500-25600 (disabled)'
    )
    assert.deepEqual(
      wgx.members.map((m) => m.suggestedName),
      ['WGX 63329', 'wgx 3022']
    )
    assert.equal(wgx.members[1].summary, 'wgx: wan tcp/udp 3022 → 192.168.1.10:22')
  })

  test('equal external ports fall back to the destination port, then -2', ({ assert }) => {
    const firewall = gatewaySyncConfig('firewall')
    const games = firewall.sections.filter((s) => s.options.name === 'GAME')
    games[1].options.src_dport = '25500-25600'
    const taken = firewall.sections.find((s) => s.options.name === 'Camera')!
    taken.options.name = 'GAME 3389'
    const groups = ambiguityGroups(firstRead([firewall]))
    assert.deepEqual(
      groups[0].members.map((m) => m.suggestedName),
      ['GAME 25500-25600', 'GAME 3389-2']
    )
  })

  test('summaries of other section types', ({ assert }) => {
    assert.equal(
      memberSummary(
        'firewall',
        'rule',
        { name: 'Block', src: 'lan', dest: 'wan', target: 'reject' },
        'r'
      ),
      'Block: lan → wan tcp/udp REJECT'
    )
    assert.equal(
      memberSummary(
        'dhcp',
        'host',
        { name: 'tv', mac: '02:00:00:00:00:07', ip: '192.168.1.7' },
        'h'
      ),
      'host tv (02:00:00:00:00:07, 192.168.1.7)'
    )
  })
})
