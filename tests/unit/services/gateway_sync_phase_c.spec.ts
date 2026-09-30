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
  isWgKey,
  prefixesOverlap,
  roleOf,
  wireguardDomain,
} from '#services/gateway_config/domains/wireguard'
import { applySectionEdits } from '#services/gateway_config/domain'
import { packageInstalled } from '#services/gateway_config/types'
import { wireOptions } from '#services/gateway_config/secrets'
import { clientConfigText, wgKeyPair } from '#services/gateway_config/wireguard_keys'
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

test.group('gateway sync Phase C | wireguard domain', () => {
  const pair = wgKeyPair()
  const all = (sections: SyncedSection[]): any => ({
    network: {
      name: 'network',
      hash: '',
      sections: sections.map((x) => ({
        name: x.name,
        type: x.type,
        anonymous: false,
        options: x.options,
      })),
    },
  })

  test('keys: X25519 pairs are 32 bytes of base64', ({ assert }) => {
    assert.isTrue(isWgKey(pair.privateKey))
    assert.isTrue(isWgKey(pair.publicKey))
    assert.notEqual(pair.privateKey, pair.publicKey)
    assert.isFalse(isWgKey('x'.repeat(44)))
    assert.isFalse(isWgKey(null))
    const text = clientConfigText({
      privateKey: pair.privateKey,
      addresses: ['10.7.0.2/32'],
      dns: ['10.7.0.1'],
      serverPublicKey: pair.publicKey,
      presharedKey: null,
      endpoint: 'vpn.example.com:51820',
      allowedIps: ['192.168.1.0/24'],
      keepalive: 25,
    })
    assert.include(text, '[Interface]\nPrivateKey = ')
    assert.include(text, 'PersistentKeepalive = 25')
    assert.notInclude(text, 'PresharedKey')
  })

  test('claims wireguard interfaces and their peers only; identity by interface and key', ({
    assert,
  }) => {
    const wg0 = section('network', 'wg0', 'interface', { proto: 'wireguard' })
    const lan = section('network', 'lan', 'interface', { proto: 'static' })
    const peer = section('network', 'p1', 'wireguard_wg0', { public_key: pair.publicKey })
    const orphan = section('network', 'p2', 'wireguard_gone', { public_key: pair.publicKey })
    const set = all([wg0, lan, peer, orphan])
    assert.isTrue(wireguardDomain.claims({ ...wg0 } as any, set))
    assert.isFalse(wireguardDomain.claims({ ...lan } as any, set))
    assert.isTrue(wireguardDomain.claims({ ...peer } as any, set))
    assert.isFalse(wireguardDomain.claims({ ...orphan } as any, set))
    assert.deepEqual(wireguardDomain.identityKeys!(peer), [`wgpeer:wg0:${pair.publicKey}`])
    assert.isNotNull(wireguardDomain.requires!({ features: [] } as any))
    assert.isNull(wireguardDomain.requires!({ features: ['config.plain_public_key'] } as any))
    assert.equal(roleOf({ listen_port: '51820' }, [{}]), 'server')
    assert.equal(roleOf({}, [{ endpoint_host: 'x' }]), 'client')
    assert.equal(roleOf({ listen_port: '1' }, [{ endpoint_host: 'x' }]), 'site')
  })

  test('validation codes', ({ assert }) => {
    const wg = (options: SyncedSection['options']) =>
      section('network', 'wg0', 'interface', {
        proto: 'wireguard',
        addresses: ['10.7.0.1/24'],
        listen_port: '51820',
        ...options,
      })
    const peer = (name: string, options: SyncedSection['options']) =>
      section('network', name, 'wireguard_wg0', {
        public_key: pair.publicKey,
        allowed_ips: ['10.7.0.2/32'],
        ...options,
      })
    const codes = (sections: SyncedSection[], path?: any) =>
      wireguardDomain
        .validate(sections, {
          capabilities: null,
          all: sections,
          unmanaged: NETWORK_WITH_LAN,
          managementPath: path,
        })
        .map((i) => `${i.severity}:${i.code}`)
    assert.deepEqual(codes([wg({}), peer('a', {})]), [])
    assert.deepEqual(codes([wg({ listen_port: '70000' })]), ['error:wg_port_invalid'])
    assert.deepEqual(
      codes([
        wg({}),
        section('network', 'wg1', 'interface', { proto: 'wireguard', listen_port: '51820' }),
      ]),
      ['error:wg_port_in_use']
    )
    assert.deepEqual(codes([wg({ addresses: ['10.7.0.999/24'] })]), ['error:wg_address_invalid'])
    assert.deepEqual(codes([wg({ addresses: ['192.168.1.200/24'] })]), ['error:wg_subnet_overlap'])
    assert.deepEqual(codes([wg({}), peer('a', { public_key: 'nope' })]), [
      'error:wg_public_key_invalid',
    ])
    assert.deepEqual(codes([wg({}), peer('a', { allowed_ips: ['nope'] })]), [
      'error:wg_allowed_ips_invalid',
    ])
    assert.deepEqual(
      codes([
        wg({}),
        peer('a', {}),
        peer('b', { public_key: wgKeyPair().publicKey, allowed_ips: ['10.7.0.0/24'] }),
      ]),
      ['error:wg_allowed_ips_overlap']
    )
    assert.deepEqual(
      codes([wg({}), peer('a', { allowed_ips: ['0.0.0.0/0'], route_allowed_ips: '1' })]),
      ['warning:wg_default_route']
    )
    assert.deepEqual(
      codes([wg({}), peer('a', { allowed_ips: ['192.168.1.0/25'], route_allowed_ips: '1' })], {
        network: 'lan',
        device: 'br-lan',
        controllerAddress: '192.168.1.10',
      }),
      ['error:wg_route_steals_path']
    )
    assert.isTrue(
      prefixesOverlap(
        { family: 4, address: '10.0.0.0', prefix: 8 },
        { family: 4, address: '10.1.2.3', prefix: 32 }
      )
    )
  })

  test('a generated key: $generate on the wire, a gen: placeholder, imported once the router has it', ({
    assert,
  }) => {
    const [after] = applySectionEdits(
      [],
      [
        {
          op: 'put',
          perchId: null,
          config: 'network',
          type: 'interface',
          name: 'wg0',
          options: { proto: 'wireguard' },
          secrets: { private_key: { generate: 'wg_private_key', nonce: 'abc' } },
        },
      ]
    )
    assert.deepEqual(after.secrets, {
      private_key: { fingerprint: 'gen:abc', generate: 'wg_private_key' },
    })
    const wire = wireOptions({ type: 'interface', options: after.options, secrets: after.secrets })
    assert.deepEqual(wire.options.private_key, { $generate: 'wg_private_key' })
    assert.deepEqual(wire.refs, [])
    const base = { type: 'interface', options: {}, secrets: after.secrets! }
    assert.equal(wireguardDomain.authoritative!(null, { base, router: null }), 'import')
    assert.equal(
      wireguardDomain.authoritative!(null, {
        base: {
          type: 'interface',
          options: {},
          secrets: { private_key: { fingerprint: 'hmac:1' } },
        },
        router: null,
      }),
      'follow'
    )
  })
})

const NETWORK_WITH_LAN = [
  section('network', 'lan', 'interface', {
    proto: 'static',
    ipaddr: '192.168.1.1',
    netmask: '255.255.255.0',
  }),
]

test.group('gateway sync Phase C | installed packages', () => {
  test('the agent’s package report wins over leftover config; unknown for older agents', ({
    assert,
  }) => {
    const caps = (features: string[], packages?: Record<string, string>) =>
      ({ access: 'write', features, ...(packages ? { packages } : {}) }) as any
    const wg = (c: any) => packageInstalled(c, ['wireguard-tools'], 'config.plain_public_key')
    assert.isTrue(wg(caps(['config.plain_public_key'], { 'wireguard-tools': '1.0-r4' })))
    // Removed, although /etc/config/network still has the interface.
    assert.isFalse(wg(caps(['config.plain_public_key'], { dnsmasq: '2.90-r1' })))
    // An agent that does not watch it, or reports nothing: unknown.
    assert.isNull(wg(caps([], { dnsmasq: '2.90-r1' })))
    assert.isNull(wg(caps(['config.plain_public_key'])))
    assert.isTrue(
      packageInstalled(
        caps(['upnp.delete'], { 'miniupnpd-nftables': '2.3-r1' }),
        ['miniupnpd-nftables', 'miniupnpd'],
        'upnp.delete'
      )
    )
  })
})
