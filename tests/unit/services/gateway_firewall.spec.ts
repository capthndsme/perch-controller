import { contentsEqual } from '#services/gateway_config/canonical'
import {
  checkRoundTrip,
  DomainRegistry,
  rulesFor,
  syncedFromRouter,
  validateDesired,
  type ConfigDomain,
  type SyncedSection,
} from '#services/gateway_config/domain'
import {
  addNetworkToZone,
  checkRulePath,
  firewallDomain,
  parsePorts,
  redirectShadows,
  removeNetworkFromZone,
  ruleShadows,
  wanZones,
  zoneObjectsForNetwork,
  zonesOf,
  type FirewallObject,
} from '#services/gateway_config/domains/firewall'
import { domainRegistry } from '#services/gateway_config/domains/index'
import type { UciConfig } from '#services/gateway_config/types'
import { HOME_NETWORKS, homeFirewallConfig } from '#tests/unit/services/fixtures/gateway_firewall'
import { test } from '@japa/runner'

const domain = firewallDomain as ConfigDomain
const rules = rulesFor(domain)
const MGMT = {
  network: 'lan',
  device: 'br-lan',
  controllerAddress: '192.168.1.5',
}

function claimedOf(cfg: UciConfig): SyncedSection[] {
  const all = { firewall: cfg }
  return cfg.sections
    .filter((s) => domain.claims({ ...s, config: 'firewall' }, all))
    .map((s) => ({ ...syncedFromRouter('firewall', s, `p${s.index}`), position: s.index }))
}

function unclaimedOf(cfg: UciConfig): SyncedSection[] {
  const all = { firewall: cfg }
  return cfg.sections
    .filter((s) => !domain.claims({ ...s, config: 'firewall' }, all))
    .map((s) => ({ ...syncedFromRouter('firewall', s, `u${s.index}`), position: s.index }))
}

function validate(desired: SyncedSection[], unmanaged: SyncedSection[] = []) {
  return validateDesired(
    new DomainRegistry([domain]),
    desired.map((s) => ({ ...s, domain: 'firewall' })),
    { capabilities: null, unmanaged, networks: HOME_NETWORKS, managementPath: MGMT }
  )
}

function rule(name: string, options: Record<string, string | string[]>, i = 0): SyncedSection {
  return {
    perchId: `r_${name}`,
    config: 'firewall',
    name: `rule_${name}`,
    type: 'rule',
    anonymous: false,
    options: { name, ...options },
    position: 100 + i,
  }
}

test.group('firewall domain | claims and the round trip', () => {
  test('claims zones, forwardings, rules, DNAT redirects and the block set only', ({ assert }) => {
    const cfg = homeFirewallConfig()
    const claimed = claimedOf(cfg)
    const count = (type: string) => claimed.filter((s) => s.type === type).length
    assert.equal(count('zone'), 4)
    assert.equal(count('forwarding'), 4)
    assert.equal(count('redirect'), 40, '39 port forwards + the DNS intercept')
    assert.equal(count('ipset'), 1)
    assert.isAbove(count('rule'), 12)
    const unclaimed = unclaimedOf(cfg).map((s) => `${s.type}:${s.name}`)
    assert.sameMembers(unclaimed, [
      'defaults:cfg01e63d',
      'redirect:cfg6592bd',
      'nat:cfg6692bd',
      'include:miniupnpd',
      'ipset:cfg6892bd',
    ])
  })

  test('the realistic home config passes checkRoundTrip exactly', ({ assert }) => {
    const report = checkRoundTrip(domain, claimedOf(homeFirewallConfig()))
    assert.isTrue(report.ok, JSON.stringify(report.failures.slice(0, 3)))
  })

  test('every section round-trips alone (the engine checks per section)', ({ assert }) => {
    for (const s of claimedOf(homeFirewallConfig())) {
      assert.isTrue(checkRoundTrip(domain, [s]).ok, s.name)
    }
  })

  test('registered after the DHCP and DNS domains', ({ assert }) => {
    assert.equal(domainRegistry().get('firewall'), firewallDomain)
    assert.deepEqual(firewallDomain.orderedTypes, ['rule', 'redirect'])
  })
})

test.group('firewall domain | identity and normalisation', () => {
  test('identity keys are unique in the realistic config', ({ assert }) => {
    const keys = claimedOf(homeFirewallConfig()).flatMap(
      (s) => domain.identityKeys?.({ type: s.type, options: s.options }) ?? []
    )
    assert.equal(new Set(keys).size, keys.length)
    assert.include(keys, 'zone:lan')
    assert.include(keys, 'fwd:lan>wan:any')
    assert.include(keys, 'redirect:minecraft')
    assert.include(keys, 'ipset:perch_block_wan')
    assert.isTrue(
      keys.some((k) => k.startsWith('redirect#')),
      'the unnamed forward'
    )
  })

  test('two rules with one name share a key (ambiguous until renamed)', ({ assert }) => {
    const a = domain.identityKeys!({ type: 'rule', options: { name: 'Block', src: 'lan' } })
    const b = domain.identityKeys!({ type: 'rule', options: { name: 'block', src: 'iot' } })
    assert.deepEqual(a, b)
  })

  test('fw4 aliases compare equal, stored spelling does not change', ({ assert }) => {
    const eq = (type: string, a: Record<string, any>, b: Record<string, any>) =>
      contentsEqual({ type, options: a }, { type, options: b }, rules)
    assert.isTrue(eq('redirect', { proto: 'tcpudp' }, { proto: ['udp', 'tcp'] }))
    assert.isTrue(eq('redirect', { proto: 'tcp udp' }, { proto: ['tcp', 'udp'] }))
    assert.isTrue(eq('rule', { enabled: 'yes' }, { enabled: '1' }))
    assert.isTrue(eq('redirect', { src_dport: '27015:27030' }, { src_dport: '27015-27030' }))
    assert.isTrue(eq('rule', { family: '4' }, { family: 'ipv4' }))
    assert.isTrue(eq('rule', { target: 'accept' }, { target: 'ACCEPT' }))
    assert.isTrue(eq('zone', { network: 'lan guest' }, { network: ['guest', 'lan'] }))
    assert.isTrue(eq('ipset', { entry: ['02:00:00:00:00:AA'] }, { entry: ['02:00:00:00:00:aa'] }))
    assert.isFalse(eq('rule', { enabled: '0' }, { enabled: '1' }))
    assert.isFalse(eq('redirect', { src_dport: '8080' }, { src_dport: '8081' }))
  })

  test('list semantics: zone networks and block set entries merge item by item', ({ assert }) => {
    assert.equal(domain.listSemantics?.['zone.network'], 'set')
    assert.equal(domain.listSemantics?.['ipset.entry'], 'set')
  })
})

test.group('firewall domain | validation (pre-flight)', () => {
  test('the realistic config has no errors, and reports the overlapping forward', ({ assert }) => {
    const cfg = homeFirewallConfig()
    const issues = validate(claimedOf(cfg), unclaimedOf(cfg))
    assert.deepEqual(
      issues.filter((i) => i.severity === 'error'),
      []
    )
    const shadowed = issues.filter((i) => i.code === 'firewall_redirect_shadowed')
    assert.isTrue(shadowed.some((i) => i.message.includes('Switch-P2P')))
    // IoT-NTP-only is a narrow exception: it does not shadow IoT-no-internet.
    assert.isFalse(issues.some((i) => i.code === 'managed_rule_shadowed'))
  })

  test('unknown zones, bad ports, addresses and MACs are errors', ({ assert }) => {
    const cfg = homeFirewallConfig()
    const base = claimedOf(cfg)
    const bad = [
      rule('a', { src: 'dmz', target: 'ACCEPT' }),
      rule('b', { src: 'lan', dest: 'wan', proto: 'tcp', dest_port: '70000', target: 'DROP' }),
      rule('c', { src: 'lan', src_ip: '999.1.1.1', target: 'DROP', dest: 'wan' }),
      rule('d', { src: 'lan', dest: 'wan', src_mac: 'nope', target: 'REJECT' }),
      rule('e', { src: 'lan', dest: 'wan', ipset: 'missing', target: 'REJECT' }),
      rule('f', { src: 'lan', dest: 'wan', target: 'BOUNCE' }),
      {
        ...rule('g', {}),
        type: 'redirect',
        options: { name: 'x', src: 'wan', src_dport: '9000-8000', dest_ip: '192.168.1.9' },
      },
    ]
    const codes = validate([...base, ...bad], unclaimedOf(cfg))
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.perchId}:${i.code}`)
    assert.includeMembers(codes, [
      'r_a:firewall_zone_unknown',
      'r_b:firewall_port_invalid',
      'r_c:firewall_ip_invalid',
      'r_d:invalid_mac',
      'r_e:firewall_ipset_unknown',
      'r_f:firewall_target_invalid',
      'r_g:firewall_port_invalid',
    ])
  })

  test('a rule on the management path is an error (README 3.8, T-F3)', ({ assert }) => {
    const cfg = homeFirewallConfig()
    const bad = [
      // "zone lan output REJECT": the router's own traffic to the controller.
      rule('out', { dest: 'lan', target: 'REJECT' }),
      rule('in', { src: 'lan', target: 'DROP' }),
      rule('ssh', { src: 'lan', proto: 'tcp', dest_port: '22', target: 'REJECT' }),
    ]
    const errors = validate([...claimedOf(cfg), ...bad], unclaimedOf(cfg)).filter(
      (i) => i.severity === 'error'
    )
    assert.deepEqual(errors.map((i) => `${i.perchId}:${i.code}`).sort(), [
      'r_in:firewall_controller_path',
      'r_out:firewall_controller_path',
      'r_ssh:firewall_admin_path',
    ])
  })

  test('parsePorts', ({ assert }) => {
    assert.deepEqual(parsePorts('22'), [{ from: 22, to: 22 }])
    assert.deepEqual(parsePorts('8000:8100'), [{ from: 8000, to: 8100 }])
    assert.deepEqual(parsePorts(['22', '80 443']), [
      { from: 22, to: 22 },
      { from: 80, to: 80 },
      { from: 443, to: 443 },
    ])
    assert.deepEqual(parsePorts(undefined), [])
    assert.isNull(parsePorts('0'))
    assert.isNull(parsePorts('65536'))
    assert.isNull(parsePorts('90-80'))
    assert.isNull(parsePorts('http'))
  })
})

test.group('firewall domain | shadowing and paths', () => {
  test('redirects that overlap: the later one never matches', ({ assert }) => {
    const r = (id: string, options: Record<string, string | string[]>) => ({ id, options })
    const shadows = redirectShadows([
      r('a', { src: 'wan', proto: 'tcp', src_dport: '8000-8100' }),
      r('b', { src: 'wan', proto: 'udp', src_dport: '8050' }),
      r('c', { src: 'wan', proto: 'tcp udp', src_dport: '8050' }),
      r('d', { src: 'wan', proto: 'tcp', src_dport: '8050', enabled: '0' }),
      r('e', { src: 'lan', proto: 'tcp', src_dport: '8050' }),
    ])
    assert.equal(shadows.get('c'), 'a')
    assert.isFalse(shadows.has('b'))
    assert.isFalse(shadows.has('d'), 'disabled')
    assert.isFalse(shadows.has('e'), 'another zone')
  })

  test('T-F4: the block rule dragged below an operator ACCEPT to wan is shadowed', ({ assert }) => {
    const block = {
      id: 'block',
      options: { src: '*', dest: 'wan', ipset: 'perch_block_wan', proto: 'all', target: 'REJECT' },
    }
    const accept = { id: 'accept', options: { src: 'lan', dest: 'wan', target: 'ACCEPT' } }
    const narrow = {
      id: 'ntp',
      options: { src: 'lan', dest: 'wan', proto: 'udp', dest_port: '123', target: 'ACCEPT' },
    }
    assert.equal(ruleShadows([accept, block]).get('block'), 'accept')
    assert.isFalse(ruleShadows([block, accept]).has('block'))
    assert.isFalse(ruleShadows([narrow, block]).has('block'), 'a narrow exception')
  })

  test('checkRulePath', ({ assert }) => {
    const ctx = { managementZone: 'lan', controllerAddress: '192.168.1.5', adminZone: 'lan' }
    const code = (o: Record<string, string | string[]>) => checkRulePath(o, ctx)?.code ?? null
    assert.equal(code({ dest: 'lan', target: 'REJECT' }), 'firewall_controller_path')
    assert.equal(code({ dest: '*', target: 'DROP' }), 'firewall_controller_path')
    assert.isNull(code({ dest: 'lan', dest_ip: '192.168.1.77', target: 'REJECT' }))
    assert.isNull(code({ dest: 'wan', target: 'REJECT' }), 'output to another zone')
    assert.isNull(code({ dest: 'lan', target: 'ACCEPT' }))
    assert.isNull(code({ dest: 'lan', target: 'REJECT', enabled: '0' }))
    assert.equal(code({ src: 'lan', target: 'REJECT' }), 'firewall_controller_path')
    assert.equal(
      code({ src: 'lan', proto: 'tcp', dest_port: '443', target: 'REJECT' }),
      'firewall_admin_path'
    )
    assert.isNull(code({ src: 'lan', proto: 'udp', dest_port: '1900', target: 'REJECT' }))
    assert.isNull(code({ src: 'wan', proto: 'tcp', dest_port: '22', target: 'REJECT' }))
    assert.equal(
      code({ src: 'lan', dest: 'lan', proto: 'tcp', target: 'REJECT' }),
      'firewall_admin_path',
      'forward from the admin zone to the controller'
    )
    assert.isNull(
      code({ src: 'lan', dest: 'lan', src_mac: '02:00:00:00:00:99', target: 'REJECT' }),
      'one device only'
    )
    assert.isNull(
      checkRulePath(
        { src: 'lan', dest: 'lan', target: 'REJECT' },
        { managementZone: 'lan', controllerAddress: '192.168.1.5' }
      ),
      'no admin zone known'
    )
  })
})

test.group('firewall domain | zone helpers for networks', () => {
  const zone = (network: string | string[]): FirewallObject => ({
    perchId: 'z1',
    section: 'cfg02dc81',
    type: 'zone',
    options: { name: 'lan', network, input: 'ACCEPT' },
    secretNames: [],
  })

  test('add and remove a network, keeping the spelling', ({ assert }) => {
    assert.deepEqual(addNetworkToZone(zone(['lan']), 'lab').options.network, ['lan', 'lab'])
    assert.equal(addNetworkToZone(zone('lan'), 'lab').options.network, 'lan lab')
    const same = zone(['lan'])
    assert.strictEqual(addNetworkToZone(same, 'lan'), same)
    assert.deepEqual(removeNetworkFromZone(zone(['lan', 'lab']), 'lab').options.network, ['lan'])
    assert.equal(removeNetworkFromZone(zone('lan lab'), 'lan').options.network, 'lab')
    assert.notProperty(removeNetworkFromZone(zone(['lab']), 'lab').options, 'network')
  })

  test('a new zone per purpose', ({ assert }) => {
    const guest = zoneObjectsForNetwork({
      network: 'guest2',
      purpose: 'guest',
      wanZones: ['wan'],
      existingZones: ['lan', 'wan'],
    })
    assert.deepEqual(
      guest.map((o) => o.type),
      ['zone', 'forwarding', 'rule', 'rule']
    )
    assert.deepInclude(guest[0].options, { name: 'guest2', input: 'REJECT', forward: 'REJECT' })
    assert.deepEqual(guest[1].options, { src: 'guest2', dest: 'wan' })
    const lan = zoneObjectsForNetwork({
      network: 'lab',
      purpose: 'lan',
      wanZones: ['wan', 'wan_b'],
      existingZones: [],
    })
    assert.deepInclude(lan[0].options, { input: 'ACCEPT', forward: 'ACCEPT' })
    assert.lengthOf(lan, 3)
    assert.throws(() =>
      zoneObjectsForNetwork({
        network: 'lan',
        purpose: 'lan',
        wanZones: [],
        existingZones: ['lan'],
      })
    )
    assert.throws(() =>
      zoneObjectsForNetwork({
        network: 'x',
        zoneName: 'far-too-long-name',
        purpose: 'custom',
        wanZones: [],
        existingZones: [],
      })
    )
  })

  test('WAN zones: masquerading ones', ({ assert }) => {
    const cfg = homeFirewallConfig()
    assert.deepEqual(wanZones(zonesOf(cfg.sections)), ['wan'])
    assert.deepEqual(wanZones(zonesOf([{ type: 'zone', options: { name: 'wan' } }])), ['wan'])
  })
})
