import type { SyncedSection, ValidationCtx } from '#services/gateway_config/domain'
import { ddnsDomain, isDdnsDomain, serviceOf } from '#services/gateway_config/domains/ddns'
import {
  normalizePorts,
  portRange,
  ruleCovers,
  shadowedRules,
  upnpDomain,
} from '#services/gateway_config/domains/upnp'
import {
  normalizeDdns,
  normalizeInterfaces,
  normalizeWireguard,
} from '#services/gateway_observation_parts'
import { test } from '@japa/runner'

/**
 * Gateway sync Phase C, pure parts (docs/design/gateway-sync/domains.md 4,
 * 7–9, protocol.md 6.1): the domains' claims, validation codes and in-sync
 * checks, and the observation parts the collector added (ddns, WireGuard
 * network/keepalive, IPv6 prefixes).
 */

function section(
  config: string,
  name: string,
  type: string,
  options: SyncedSection['options']
): SyncedSection {
  return { perchId: `p_${name}`, config, name, type, anonymous: false, options }
}

const NETWORK = [
  section('network', 'lan', 'interface', { proto: 'static', ipaddr: '192.168.1.1' }),
  section('network', 'wan', 'interface', { proto: 'dhcp' }),
]

function ctx(all: SyncedSection[]): ValidationCtx {
  return { capabilities: null, all, unmanaged: NETWORK }
}

test.group('gateway sync Phase C | ddns domain', () => {
  test('claims the global section by one option and services whole', ({ assert }) => {
    const global = { config: 'ddns', name: 'global', type: 'ddns', anonymous: false, options: {} }
    const svc = { config: 'ddns', name: 'home', type: 'service', anonymous: false, options: {} }
    assert.isTrue(ddnsDomain.claims(global as any, {}))
    assert.isTrue(ddnsDomain.claims(svc as any, {}))
    assert.isFalse(ddnsDomain.claims({ ...svc, config: 'network' } as any, {}))
    assert.deepEqual(ddnsDomain.ownership!(global as any), {
      kind: 'options',
      options: ['upd_privateip'],
    })
    assert.deepEqual(ddnsDomain.ownership!(svc as any), { kind: 'section' })
    assert.isNotNull(ddnsDomain.requires!({ allowedConfigs: ['network'] } as any))
    assert.isNull(ddnsDomain.requires!({ allowedConfigs: ['network', 'ddns'] } as any))
  })

  test('domain names: host names and the host@zone form', ({ assert }) => {
    for (const ok of ['home.example.com', 'home@example.com', '*.example.com', '@example.com']) {
      assert.isTrue(isDdnsDomain(ok), ok)
    }
    for (const bad of ['', 'not a host', 'a@b@c', 'x'.repeat(254), 'bad_label-.com.']) {
      assert.isFalse(isDdnsDomain(bad), bad)
    }
  })

  test('validation codes', ({ assert }) => {
    const svc = (options: SyncedSection['options']) =>
      section('ddns', 'home', 'service', {
        service_name: 'duckdns.org',
        domain: 'home.example.com',
        ip_network: 'wan',
        interface: 'wan',
        ...options,
      })
    const codes = (options: SyncedSection['options']) =>
      ddnsDomain.validate([svc(options)], ctx([])).map((i) => `${i.severity}:${i.code}`)
    assert.deepEqual(codes({}), [])
    assert.deepEqual(codes({ domain: 'bad host' }), ['error:ddns_domain_invalid'])
    assert.deepEqual(codes({ update_url: 'ftp://x' }), ['error:ddns_update_url_invalid'])
    assert.deepEqual(codes({ update_url: 'http://x.example.com/?h=[DOMAIN]' }), [
      'warning:ddns_update_url_plain',
    ])
    assert.deepEqual(codes({ ip_source: 'magic' }), ['error:ddns_ip_source_invalid'])
    assert.deepEqual(codes({ ip_network: 'nope', interface: 'nope' }), [
      'error:ddns_interface_unknown',
      'error:ddns_interface_unknown',
    ])
    assert.deepEqual(codes({ check_interval: '0' }), ['error:ddns_interval_invalid'])
    assert.deepEqual(codes({ force_unit: 'weeks', force_interval: '1' }), [
      'error:ddns_interval_invalid',
    ])
  })

  test('serviceOf: units become minutes and hours', ({ assert }) => {
    const svc = serviceOf('home', {
      enabled: 'yes',
      check_interval: '2',
      check_unit: 'hours',
      force_interval: '3',
      force_unit: 'days',
      ip_source: 'WEB',
    })
    assert.deepInclude(svc, {
      enabled: true,
      checkIntervalMinutes: 120,
      forceIntervalHours: 72,
      ipSource: 'web',
    })
  })

  test('in sync: an enabled service whose updater is not running', ({ assert }) => {
    const rows = [
      {
        perchId: 'a',
        name: 'home',
        type: 'service',
        scope: 'synced' as const,
        issue: null,
        options: { enabled: '1' },
      },
      {
        perchId: 'b',
        name: 'off',
        type: 'service',
        scope: 'synced' as const,
        issue: null,
        options: { enabled: '0' },
      },
    ]
    const issues = ddnsDomain.inSync!(rows, {
      ddns: {
        services: [
          { name: 'home', running: false },
          { name: 'off', running: false },
        ],
      },
    })
    assert.deepEqual(
      issues.map((i) => [i.objectId, i.code]),
      [['a', 'ddns_not_running']]
    )
    assert.deepEqual(ddnsDomain.inSync!(rows, {}), [])
  })
})

test.group('gateway sync Phase C | observation parts', () => {
  test('ddns: no password, times as ISO, idempotent', ({ assert }) => {
    const raw = {
      installed: true,
      serviceEnabled: true,
      providers: ['no-ip.com', 'duckdns.org', 'duckdns.org'],
      services: [
        {
          name: 'home',
          enabled: true,
          domain: 'home.example.com',
          registeredIp: '203.0.113.10',
          lastUpdate: 1790000000,
          running: true,
          lastError: null,
          password: 'x',
        },
        { name: 'never', enabled: false, lastUpdate: 0, running: false },
      ],
    }
    const once = normalizeDdns(raw)!
    assert.deepEqual(once.providers, ['duckdns.org', 'no-ip.com'])
    assert.equal(once.services[0].lastUpdate, '2026-09-21T14:13:20Z')
    assert.isNull(once.services[1].lastUpdate)
    assert.notInclude(JSON.stringify(once), 'password')
    assert.deepEqual(normalizeDdns(once), once)
  })

  test('wireguard: network and keepalive; interfaces: IPv6 prefixes', ({ assert }) => {
    const wg = normalizeWireguard({
      interfaces: [
        {
          name: 'wg0',
          network: 'wg0',
          publicKey: 'x'.repeat(43) + '=',
          privateKey: 'must-not-survive',
          peers: [{ publicKey: 'y'.repeat(43) + '=', keepalive: 25, latestHandshake: 0 }],
        },
      ],
    })!
    assert.equal(wg.interfaces[0].network, 'wg0')
    assert.equal(wg.interfaces[0].peers[0].keepalive, 25)
    assert.notInclude(JSON.stringify(wg), 'must-not-survive')
    const ifs = normalizeInterfaces([
      {
        network: 'wan6',
        up: true,
        ipv6Prefixes: [
          { prefix: '2001:db8:10::/56', preferredUntil: 1790003600, validUntil: 1790007200 },
        ],
        ipv6Assigned: ['2001:db8:10:1::/64', 'garbage'],
      },
    ])!
    assert.deepEqual(ifs[0].ipv6Prefixes, [
      {
        prefix: '2001:db8:10::/56',
        preferredUntil: '2026-09-21T15:13:20Z',
        validUntil: '2026-09-21T16:13:20Z',
      },
    ])
    assert.deepEqual(ifs[0].ipv6Assigned, ['2001:db8:10:1::/64'])
    assert.deepEqual(normalizeInterfaces(ifs), ifs)
  })
})

test.group('gateway sync Phase C | upnp domain', () => {
  const rule = (name: string, action: string, ext: string, addr: string, int: string) =>
    section('upnpd', name, 'perm_rule', { action, ext_ports: ext, int_addr: addr, int_ports: int })

  test('ports and ranges; a:b is a-b', ({ assert }) => {
    assert.deepEqual(portRange('1024-65535'), { from: 1024, to: 65535 })
    assert.deepEqual(portRange('80:90'), { from: 80, to: 90 })
    assert.deepEqual(portRange('53'), { from: 53, to: 53 })
    assert.isNull(portRange('90-80'))
    assert.isNull(portRange('70000'))
    assert.equal(normalizePorts(' 80:90 '), '80-90')
    assert.equal(normalizePorts('53-53'), '53')
  })

  test('identity keys: action, address and both ranges; settings by type', ({ assert }) => {
    const r = rule('a', 'Allow', '1024:65535', '0.0.0.0/0', '1024-65535')
    assert.deepEqual(upnpDomain.identityKeys!(r), ['perm:allow:0.0.0.0/0:1024-65535:1024-65535'])
    assert.deepEqual(upnpDomain.identityKeys!({ type: 'upnpd', options: {} }), ['upnpd'])
    assert.deepEqual(
      upnpDomain.ownership!({ config: 'upnpd', name: 'config', type: 'upnpd', options: {} } as any),
      {
        kind: 'options',
        options: [
          'enabled',
          'enable_upnp',
          'enable_natpmp',
          'secure_mode',
          'log_output',
          'internal_iface',
          'external_iface',
          'igdv1',
        ],
      }
    )
  })

  test('shadowing: an earlier opposite rule that covers a later one', ({ assert }) => {
    const deny = rule('d', 'deny', '0-65535', '192.168.1.0/24', '0-65535')
    const allow = rule('a', 'allow', '3074', '192.168.1.30', '3074')
    const other = rule('o', 'allow', '3074', '192.168.2.30', '3074')
    assert.isTrue(ruleCovers(deny.options, allow.options))
    assert.isFalse(ruleCovers(allow.options, deny.options))
    const shadows = shadowedRules(
      [deny, allow, other].map((r) => ({ id: r.name, options: r.options }))
    )
    assert.deepEqual([...shadows], [['a', 'd']])
  })

  test('validation codes and the secure-mode warning', ({ assert }) => {
    const codes = (sections: SyncedSection[]) =>
      upnpDomain.validate(sections, ctx([])).map((i) => `${i.severity}:${i.code}`)
    assert.deepEqual(codes([rule('a', 'allow', '1024-65535', '0.0.0.0/0', '1024-65535')]), [])
    assert.deepEqual(codes([rule('a', 'maybe', '1', '10.0.0.1', '1')]), [
      'error:upnp_action_invalid',
    ])
    assert.deepEqual(codes([rule('a', 'allow', 'x', '10.0.0.1', '1')]), [
      'error:upnp_ports_invalid',
    ])
    assert.deepEqual(codes([rule('a', 'allow', '1', 'lan', '1')]), ['error:upnp_addr_invalid'])
    assert.deepEqual(
      codes([section('upnpd', 'config', 'upnpd', { enabled: '1', secure_mode: '0' })]),
      ['warning:upnp_secure_mode_off']
    )
  })

  test('in sync: enabled but not running, running while disabled', ({ assert }) => {
    const row = (enabled: string) => [
      {
        perchId: 's',
        name: 'config',
        type: 'upnpd',
        scope: 'synced' as const,
        issue: null,
        options: { enabled },
      },
    ]
    assert.deepEqual(
      upnpDomain.inSync!(row('1'), { upnp: { running: false } }).map((i) => i.code),
      ['upnp_not_running']
    )
    assert.deepEqual(
      upnpDomain.inSync!(row('0'), { upnp: { running: true } }).map((i) => i.code),
      ['upnp_running_while_disabled']
    )
    assert.deepEqual(upnpDomain.inSync!(row('1'), { upnp: { running: null } }), [])
  })
})
