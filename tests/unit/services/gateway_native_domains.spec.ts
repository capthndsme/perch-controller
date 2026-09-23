import {
  checkRoundTrip,
  compareConfigs,
  DomainRegistry,
  syncedFromRouter,
  validateDesired,
  type ConfigDomain,
  type SyncedSection,
} from '#services/gateway_config/domain'
import { dhcpHostsDomain } from '#services/gateway_config/domains/dhcp_hosts'
import { dhcpTagsDomain, parseDhcpOption } from '#services/gateway_config/domains/dhcp_tags'
import {
  dnsEditGuard,
  dnsInstanceSettings,
  dnsSettingsDomain,
  editOwnedItems,
  nameCovered,
  parseAddressItem,
  parseRebindItem,
  parseServerItem,
  suggestRebindDomain,
  type ControllerHost,
} from '#services/gateway_config/domains/dns_settings'
import { DOMAINS, domainRegistry } from '#services/gateway_config/domains/index'
import {
  managementPathPrefix,
  routeFacts,
  routesDomain,
  routeStealsPath,
} from '#services/gateway_config/domains/routes'
import { systemDomain, tzForZone } from '#services/gateway_config/domains/system'
import {
  isPrivateAddress,
  parsePrefix,
  prefixContains,
} from '#services/gateway_config/domains/verbatim'
import { dhcpOptionsView, editDhcpOptions } from '#services/gateway_config/dhcp_service'
import { patchedDnsOptions } from '#services/gateway_config/dns_service'
import {
  featureSyncIssues,
  reconcileRead,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import type { UciConfig, UciOptions } from '#services/gateway_config/types'
import { parseUci } from '#tests/helpers/uci'
import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'

/**
 * The plan 2 phase 4 domains (docs/gateway/native-sync.md): `system`,
 * `routes`, `dns_settings`, `dhcp_tags` and the host tags of `dhcp_hosts`,
 * against UCI fixtures shaped like real OpenWrt configs (placeholders only).
 */

function fixture(name: 'dhcp' | 'network' | 'system'): UciConfig {
  const text = readFileSync(new URL(`./fixtures/native/${name}`, import.meta.url), 'utf8')
  return parseUci(text, name)
}

function claimedBy(domain: ConfigDomain, config: UciConfig): SyncedSection[] {
  const all = { [config.name]: config }
  return config.sections
    .filter((s) => domain.configs.includes(config.name) && domain.types.includes(s.type))
    .filter((s) => domain.claims({ ...s, config: config.name }, all))
    .map((s, i) => syncedFromRouter(config.name, s, `p${i}`))
}

const host = (over: Partial<ControllerHost> = {}): ControllerHost => ({
  name: 'perch.example.com',
  addresses: ['192.168.1.5'],
  localNames: [],
  ...over,
})

test.group('native sync | registry', () => {
  test('domains registered in apply order: system → network → dhcp → firewall', ({ assert }) => {
    const keys = DOMAINS.map((d) => d.key)
    assert.includeMembers(keys, ['system', 'routes', 'dns_settings', 'dhcp_tags'])
    const configs = DOMAINS.map((d) => d.configs[0])
    const sorted = [...configs].sort(compareConfigs)
    // Registration order follows the apply order (claim order does not matter: no overlap).
    assert.deepEqual(
      configs.filter((c) => ['system', 'network', 'dhcp', 'firewall'].includes(c)),
      sorted.filter((c) => ['system', 'network', 'dhcp', 'firewall'].includes(c))
    )
    assert.doesNotThrow(() => domainRegistry())
  })

  test('each fixture section is claimed by at most one domain; unclaimed ones stay unmodeled', ({
    assert,
  }) => {
    const registry = domainRegistry()
    const claims: Record<string, string | null> = {}
    for (const config of [fixture('dhcp'), fixture('network'), fixture('system')]) {
      const all = { [config.name]: config }
      for (const s of config.sections) {
        claims[`${config.name}.${s.type}.${s.name}`] =
          registry.claim({ ...s, config: config.name }, all)?.domain.key ?? null
      }
    }
    assert.equal(claims['system.system.@system[0]'], 'system')
    assert.equal(claims['system.timeserver.ntp'], 'system')
    assert.isNull(claims['system.led.led_wan'], 'LEDs are "later"')
    assert.equal(claims['network.route.@route[4]'], 'routes')
    assert.equal(claims['network.route.lab'], 'routes')
    assert.equal(claims['network.route6.@route6[6]'], 'routes')
    assert.isNull(claims['network.rule.@rule[8]'], 'policy rules are observe only')
    assert.isNull(claims['network.rule6.@rule6[9]'])
    assert.equal(claims['dhcp.dnsmasq.@dnsmasq[0]'], 'dns_settings')
    assert.equal(claims['dhcp.tag.kids'], 'dhcp_tags')
    assert.equal(claims['dhcp.host.@host[5]'], 'dhcp_hosts')
    assert.isNull(claims['dhcp.odhcpd.odhcpd'], 'odhcpd stays router-owned')
  })
})

test.group('native sync | round trips (section 7 invariant)', () => {
  test('every new domain round-trips its fixture sections exactly', ({ assert }) => {
    const cases: Array<[ConfigDomain, UciConfig, number]> = [
      [systemDomain as ConfigDomain, fixture('system'), 2],
      [routesDomain as ConfigDomain, fixture('network'), 4],
      [dnsSettingsDomain as ConfigDomain, fixture('dhcp'), 1],
      [dhcpTagsDomain as ConfigDomain, fixture('dhcp'), 1],
      [dhcpHostsDomain as ConfigDomain, fixture('dhcp'), 2],
    ]
    for (const [domain, config, count] of cases) {
      const sections = claimedBy(domain, config)
      assert.lengthOf(sections, count, domain.key)
      const report = checkRoundTrip(domain, sections)
      assert.isTrue(report.ok, `${domain.key}: ${JSON.stringify(report.failures)}`)
    }
  })

  test('ownership: option level, router-owned options stay out', ({ assert }) => {
    const sys = fixture('system').sections
    assert.deepEqual(systemDomain.ownership!({ ...sys[0], config: 'system' }), {
      kind: 'options',
      options: ['hostname', 'timezone', 'zonename'],
    })
    const dns = dnsSettingsDomain.ownership!({ ...fixture('dhcp').sections[0], config: 'dhcp' })
    assert.deepEqual(dns, {
      kind: 'options',
      options: ['domain', 'local', 'rebind_protection', 'noresolv'],
      items: { server: [], rebind_domain: [], address: [] },
    })
    assert.notInclude((dns as { options: string[] }).options, 'port', 'port is router-owned')
    const hostOwnership = dhcpHostsDomain.ownership!({
      ...fixture('dhcp').sections[5],
      config: 'dhcp',
    })
    assert.include((hostOwnership as { options: string[] }).options, 'tag')
  })
})

test.group('native sync | system', () => {
  test('validation: host name, POSIX TZ, zone pairs, NTP servers', ({ assert }) => {
    const main = (options: UciOptions): SyncedSection => ({
      perchId: 'a',
      config: 'system',
      name: 'cfg01',
      type: 'system',
      anonymous: true,
      options,
    })
    const codes = (options: UciOptions) =>
      systemDomain.validate([main(options)], { capabilities: null, all: [] }).map((i) => i.code)
    assert.deepEqual(codes({ hostname: 'gateway', timezone: 'PST-8', zonename: 'Asia/Manila' }), [])
    assert.deepEqual(codes({ hostname: 'bad host' }), ['system_hostname_invalid'])
    assert.deepEqual(codes({ timezone: 'not a tz!' }), ['system_timezone_invalid'])
    assert.deepEqual(codes({ timezone: 'UTC0', zonename: 'Asia/Manila' }), [
      'system_timezone_mismatch',
    ])
    assert.deepEqual(codes({ zonename: 'Mars/Olympus' }), ['system_zone_unknown'])
    const ntp: SyncedSection = {
      perchId: 'b',
      config: 'system',
      name: 'ntp',
      type: 'timeserver',
      anonymous: false,
      options: { enabled: '0', enable_server: '1', server: ['pool.example.com', 'bad!server'] },
    }
    assert.deepEqual(
      systemDomain.validate([ntp], { capabilities: null, all: [] }).map((i) => i.code),
      ['system_ntp_server_invalid', 'system_ntp_server_unsynced']
    )
    assert.equal(tzForZone('Asia/Manila'), 'PST-8')
    assert.equal(tzForZone('UTC'), 'UTC0')
    assert.isNull(tzForZone('Nowhere/Else'))
  })

  test('in sync: the host name the router runs with must be the configured one', ({ assert }) => {
    const rows = [
      {
        perchId: 'a',
        name: 'cfg01',
        type: 'system',
        scope: 'synced' as const,
        issue: null,
        options: { hostname: 'gateway' },
      },
    ]
    assert.deepEqual(systemDomain.inSync!(rows, { hostname: 'gateway' }), [])
    assert.deepEqual(systemDomain.inSync!(rows, { hostname: null }), [], 'unverifiable: skipped')
    assert.equal(
      systemDomain.inSync!(rows, { hostname: 'OpenWrt' })[0].code,
      'system_hostname_not_live'
    )
  })
})

test.group('native sync | routes', () => {
  test('facts: netmask or prefix, families, flags', ({ assert }) => {
    const a = routeFacts('route', { target: '192.168.50.0', netmask: '255.255.255.0' })
    assert.deepEqual(a.prefix, { family: 4, address: '192.168.50.0', prefix: 24 })
    assert.isTrue(a.enabled)
    const b = routeFacts('route6', { target: 'fd00:50::/64', disabled: '1' })
    assert.equal(b.prefix?.prefix, 64)
    assert.isFalse(b.enabled)
    assert.isNull(routeFacts('route', { target: 'fd00::/64' }).prefix, 'family mismatch')
    assert.isNull(routeFacts('route', { target: '10.0.0.0', netmask: '255.0.255.0' }).prefix)
  })

  test('the management path: a more specific route elsewhere steals it, one on the path does not', ({
    assert,
  }) => {
    const path = { network: 'lan', controllerAddress: '192.168.1.5', pathPrefix: 24 }
    const steal = (options: UciOptions) => routeStealsPath(routeFacts('route', options), path)
    assert.isTrue(steal({ interface: 'wan', target: '192.168.1.0/25' }))
    assert.isTrue(steal({ interface: 'wan', target: '192.168.1.5/32' }))
    assert.isTrue(steal({ interface: 'wan', target: '192.168.1.0/24' }), 'same length: metric race')
    assert.isFalse(steal({ interface: 'wan', target: '0.0.0.0/0' }), 'less specific than the LAN')
    assert.isFalse(steal({ interface: 'lan', target: '192.168.1.5/32' }), 'on the path')
    assert.isTrue(steal({ interface: 'lan', target: '192.168.1.5/32', type: 'blackhole' }))
    assert.isFalse(steal({ interface: 'wan', target: '192.168.1.5/32', disabled: '1' }))
    assert.isFalse(steal({ interface: 'wan', target: '192.168.1.5/32', table: '100' }))
    assert.isFalse(steal({ interface: 'wan', target: '10.0.0.0/8' }), 'does not cover it')
    // Controller beyond the WAN: every covering route elsewhere is more specific than the default.
    const far = { network: 'wan', controllerAddress: '198.51.100.7', pathPrefix: 0 }
    assert.isTrue(
      routeStealsPath(routeFacts('route', { interface: 'lan', target: '198.51.100.0/24' }), far)
    )
    assert.equal(
      managementPathPrefix(
        { network: 'lan', device: 'br-lan', controllerAddress: '192.168.1.5' },
        [{ name: 'lan', ipv4: ['192.168.1.1/24'] }],
        []
      ),
      24
    )
    assert.equal(
      managementPathPrefix(
        { network: 'wan', device: 'eth1', controllerAddress: '198.51.100.7' },
        [],
        [routeFacts('route', { interface: 'wan', target: '198.51.100.0/24' })]
      ),
      24
    )
  })

  test('validation: prefix, gateway, interface, duplicates; the path as a warning', ({
    assert,
  }) => {
    const network = fixture('network')
    const interfaces = network.sections
      .filter((s) => s.type === 'interface')
      .map((s) => syncedFromRouter('network', s, s.name))
    const route = (options: UciOptions, perchId = 'r1'): SyncedSection => ({
      perchId,
      config: 'network',
      name: `perch_${perchId}`,
      type: 'route',
      anonymous: false,
      options,
    })
    const codes = (desired: SyncedSection[]) =>
      routesDomain
        .validate(desired, {
          capabilities: null,
          all: [...interfaces, ...desired],
          networks: [{ name: 'lan', ipv4: ['192.168.1.1/24'] }],
          managementPath: { network: 'lan', device: 'br-lan', controllerAddress: '192.168.1.5' },
        })
        .map((i) => `${i.severity}:${i.code}`)
    assert.deepEqual(codes([route({ interface: 'lan', target: '192.168.50.0/24' })]), [])
    assert.deepEqual(codes([route({ interface: 'lan', target: '300.1.1.0/24' })]), [
      'error:routing_target_invalid',
    ])
    assert.deepEqual(
      codes([route({ interface: 'lan', target: '192.168.50.0/24', gateway: 'fd00::1' })]),
      ['error:routing_gateway_invalid']
    )
    assert.deepEqual(codes([route({ interface: 'nope', target: '192.168.50.0/24' })]), [
      'error:routing_interface_unknown',
    ])
    assert.deepEqual(
      codes([
        route({ interface: 'lan', target: '192.168.50.0/24' }, 'r1'),
        route({ interface: 'lan', target: '192.168.50.0', netmask: '255.255.255.0' }, 'r2'),
      ]),
      ['error:duplicate_route']
    )
    assert.deepEqual(codes([route({ interface: 'wan', target: '192.168.1.0/28' })]), [
      'warning:routing_controller_path',
    ])
  })

  test('identity keys and the protected job', ({ assert }) => {
    assert.deepEqual(
      routesDomain.identityKeys!({
        type: 'route',
        options: { interface: 'lan', target: '192.168.50.0', netmask: '255.255.255.0' },
      }),
      ['route4:lan|192.168.50.0/24|main|unicast']
    )
    const path = { network: 'lan', device: 'br-lan', controllerAddress: '192.168.1.5' }
    assert.isTrue(
      routesDomain.touchesManagement!(
        { type: 'route', name: 'x', options: { interface: 'wan', target: '192.168.0.0/16' } },
        path
      )
    )
    assert.isFalse(
      routesDomain.touchesManagement!(
        { type: 'route', name: 'x', options: { interface: 'wan', target: '10.0.0.0/8' } },
        path
      )
    )
  })

  test('in sync: an enabled route needs its interface in netifd', ({ assert }) => {
    const rows = [
      {
        perchId: 'r',
        name: 'x',
        type: 'route',
        scope: 'synced' as const,
        issue: null,
        options: { interface: 'wan2', target: '198.51.100.0/24' },
      },
    ]
    assert.deepEqual(routesDomain.inSync!(rows, { interfaces: null }), [])
    assert.equal(
      routesDomain.inSync!(rows, { interfaces: [{ network: 'wan', up: true }] })[0].code,
      'route_interface_missing'
    )
  })
})

test.group('native sync | DNS settings', () => {
  test('item syntax: servers, forwards, addresses, rebind domains', ({ assert }) => {
    assert.deepEqual(parseServerItem('203.0.113.53'), { kind: 'upstream', server: '203.0.113.53' })
    assert.deepEqual(parseServerItem('203.0.113.53#5353'), {
      kind: 'upstream',
      server: '203.0.113.53#5353',
    })
    assert.deepEqual(parseServerItem('/corp.example.com/192.168.1.53'), {
      kind: 'forward',
      domains: ['corp.example.com'],
      server: '192.168.1.53',
    })
    assert.deepEqual(parseServerItem('/local.example.com/'), {
      kind: 'local',
      domains: ['local.example.com'],
    })
    assert.isNull(parseServerItem('not a server'))
    assert.isNull(parseServerItem('/x.example.com/999.1.1.1'))
    assert.deepEqual(parseAddressItem('/ads.example.com/'), {
      domains: ['ads.example.com'],
      address: '',
    })
    assert.isNull(parseAddressItem('ads.example.com'))
    assert.deepEqual(parseRebindItem('perch.example.com'), ['perch.example.com'])
    assert.deepEqual(parseRebindItem('/a.example.com/b.example.com/'), [
      'a.example.com',
      'b.example.com',
    ])
    assert.isTrue(nameCovered('perch.example.com', ['example.com']))
    assert.isFalse(nameCovered('perchexample.com', ['example.com']))
    assert.isTrue(nameCovered('anything.example.org', ['#']))
    assert.isTrue(isPrivateAddress('192.168.1.5'))
    assert.isTrue(isPrivateAddress('fd00::5'))
    assert.isFalse(isPrivateAddress('203.0.113.5'))
    assert.isTrue(prefixContains(parsePrefix('fd00::/8')!, 'fd00::5'))
  })

  test('the instance view splits router and Perch items; the router port is shown only', ({
    assert,
  }) => {
    const options = fixture('dhcp').sections[0].options
    const view = dnsInstanceSettings(options, { server: [], rebind_domain: [], address: [] })
    assert.equal(view.port, 54)
    assert.equal(view.domain, 'lan')
    assert.isTrue(view.rebindProtection)
    assert.deepEqual(view.upstreams, [{ value: '203.0.113.53', owner: 'router' }])
    assert.equal(view.forwards[0].server, '192.168.1.53')
    assert.equal(view.addresses[0].address, '')
    assert.deepEqual(view.rebindDomains, [{ value: 'perch.example.com', owner: 'router' }])
    const owned = dnsInstanceSettings(
      { server: ['203.0.113.53', '198.51.100.53'] },
      { server: ['198.51.100.53'] }
    )
    assert.deepEqual(
      owned.upstreams.map((u) => u.owner),
      ['router', 'perch']
    )
  })

  test('editing owned items keeps the router’s items and other categories', ({ assert }) => {
    const current = ['203.0.113.53', '/corp.example.com/192.168.1.53', '198.51.100.53']
    const owned = ['198.51.100.53']
    const upstream = (i: string) => parseServerItem(i)?.kind === 'upstream'
    assert.deepEqual(editOwnedItems(current, owned, ['198.51.100.54'], upstream), [
      '203.0.113.53',
      '/corp.example.com/192.168.1.53',
      '198.51.100.54',
    ])
    assert.deepEqual(
      editOwnedItems(current, owned, ['203.0.113.53'], upstream),
      ['203.0.113.53', '/corp.example.com/192.168.1.53'],
      'a wanted router item stays the router’s, no duplicate'
    )
    const patched = patchedDnsOptions(
      { server: current, rebind_domain: ['perch.example.com'] },
      { server: owned, rebind_domain: [] },
      {
        forwards: [{ domain: 'lab.example.com', server: '192.168.1.60' }],
        rebindDomains: ['nas.example.com'],
        local: 'lan',
        rebindProtection: true,
      }
    )
    assert.deepEqual(patched.server, [...current, '/lab.example.com/192.168.1.60'])
    assert.deepEqual(patched.rebind_domain, ['perch.example.com', 'nas.example.com'])
    assert.equal(patched.local, '/lan/')
    assert.equal(patched.rebind_protection, '1')
  })

  test('the name guard: resolution and the controller’s answer are pinned', ({ assert }) => {
    const base: UciOptions = {
      rebind_protection: '1',
      server: ['203.0.113.53', '192.168.1.53'],
      rebind_domain: ['perch.example.com'],
    }
    const guard = (after: UciOptions, h = host(), before = base) =>
      dnsEditGuard(before, after, h)?.code ?? null
    assert.isNull(guard({ ...base, server: ['203.0.113.53', '192.168.1.53', '198.51.100.1'] }))
    assert.equal(guard({ ...base, noresolv: '1', server: [] }), 'dns_no_upstream')
    assert.equal(
      guard({ ...base, address: ['/perch.example.com/192.168.1.99'] }),
      'dns_controller_name_pinned'
    )
    assert.isNull(
      guard({ ...base, address: ['/perch.example.com/192.168.1.5'] }),
      'the same answer is fine'
    )
    assert.equal(
      guard({ ...base, server: [...(base.server as string[]), '/example.com/192.168.1.2'] }),
      'dns_controller_name_pinned'
    )
    assert.equal(
      guard({ ...base, rebind_domain: [] }),
      'dns_controller_name_pinned',
      'rebind protection would drop the private answer'
    )
    assert.isNull(
      guard({ ...base, rebind_domain: [] }, host({ addresses: ['203.0.113.80'] })),
      'a public answer is not a rebind'
    )
    assert.equal(
      guard({ ...base, server: ['203.0.113.53'] }),
      'dns_controller_name_pinned',
      'the private upstream may be what answers the name'
    )
    assert.isNull(
      guard({ ...base, server: ['203.0.113.53'] }, host({ localNames: ['perch.example.com'] })),
      'answered locally'
    )
    assert.equal(guard({ ...base, local: '/example.com/' }), 'dns_controller_name_pinned')
    const withForward = { ...base, server: ['203.0.113.53', '/example.com/192.168.1.2'] }
    assert.equal(
      guard({ ...withForward, server: ['203.0.113.53'] }, host(), withForward),
      'dns_controller_name_pinned',
      'dropping the forward that answers it'
    )
    assert.isNull(guard({ ...base, rebind_domain: [] }, host({ name: null })))
    assert.isTrue(suggestRebindDomain({ rebind_protection: '1' }, host()))
    assert.isFalse(suggestRebindDomain(base, host()))
  })

  test('validation and the in-sync check', ({ assert }) => {
    const s: SyncedSection = {
      perchId: 'd',
      config: 'dhcp',
      name: 'cfg01',
      type: 'dnsmasq',
      anonymous: true,
      options: {
        server: ['bad'],
        address: ['nope'],
        rebind_domain: ['/ok.example.com/'],
        noresolv: '1',
      },
    }
    assert.deepEqual(
      dnsSettingsDomain.validate([s], { capabilities: null, all: [s] }).map((i) => i.code),
      ['dns_server_invalid', 'dns_address_invalid', 'dns_no_upstream']
    )
    const rows = [
      {
        perchId: 'd',
        name: 'cfg01',
        type: 'dnsmasq',
        scope: 'synced' as const,
        issue: null,
        options: { port: '54' },
      },
    ]
    assert.deepEqual(
      dnsSettingsDomain.inSync!(rows, {
        resolver: {
          dnsmasqPort: 54,
          controllerHost: { name: 'perch.example.com', addresses: ['192.168.1.5'], error: null },
        },
      }),
      []
    )
    assert.deepEqual(
      dnsSettingsDomain.inSync!(rows, {
        resolver: {
          dnsmasqPort: null,
          controllerHost: { name: 'perch.example.com', addresses: [], error: 'not_found' },
        },
      }).map((i) => i.code),
      ['dns_dnsmasq_not_running', 'dns_controller_name_unresolved']
    )
  })
})

test.group('native sync | DHCP options and tags', () => {
  test('options by code: view and edit keep other items and their places', ({ assert }) => {
    const items = ['6,192.168.1.1,203.0.113.53', '42,192.168.1.1', 'option:domain-search,lan']
    const view = dhcpOptionsView(items)
    assert.deepEqual(view.dnsServers, ['192.168.1.1', '203.0.113.53'])
    assert.deepEqual(view.ntpServers, ['192.168.1.1'])
    assert.isNull(view.gateway)
    assert.equal(view.other[0].name, 'domain-search')
    assert.deepEqual(
      editDhcpOptions(items, { dnsServers: ['192.168.1.2'], gateway: '192.168.1.1' }),
      ['6,192.168.1.2', '42,192.168.1.1', 'option:domain-search,lan', '3,192.168.1.1']
    )
    assert.deepEqual(editDhcpOptions(items, { ntpServers: [], other: [] }), [
      '6,192.168.1.1,203.0.113.53',
    ])
    assert.deepEqual(editDhcpOptions(['tag:kids,6,192.168.1.2'], { dnsServers: null }), [
      'tag:kids,6,192.168.1.2',
    ])
    assert.deepEqual(parseDhcpOption('option:router,192.168.1.1'), {
      tags: [],
      code: 3,
      name: 'router',
      value: '192.168.1.1',
    })
    assert.isNull(parseDhcpOption('999,x'))
  })

  test('tags: names and options validated; a host’s tags compare as a set', ({ assert }) => {
    const tag: SyncedSection = {
      perchId: 't',
      config: 'dhcp',
      name: 'bad-name',
      type: 'tag',
      anonymous: false,
      options: { dhcp_option: ['6,192.168.1.2', 'zzz'] },
    }
    assert.deepEqual(
      dhcpTagsDomain.validate([tag], { capabilities: null, all: [tag] }).map((i) => i.code),
      ['dhcp_tag_invalid', 'dhcp_option_invalid']
    )
    const rules = new DomainRegistry([dhcpHostsDomain as ConfigDomain]).rules('dhcp_hosts')
    assert.deepEqual(
      rules.normalize('host', 'tag', 'b a'),
      rules.normalize('host', 'tag', ['a', 'b'])
    )
    const hostSection: SyncedSection = {
      perchId: 'h',
      config: 'dhcp',
      name: 'h',
      type: 'host',
      anonymous: false,
      options: { mac: '02:00:00:00:10:21', tag: ['ok', 'no-good'] },
    }
    assert.include(
      dhcpHostsDomain
        .validate([hostSection], { capabilities: null, all: [hostSection] })
        .map((i) => i.code),
      'dhcp_tag_invalid'
    )
  })
})

test.group('native sync | engine: feature checks and upgrades', () => {
  test('ambiguous sections and domain checks become feature blockers', ({ assert }) => {
    const base = {
      config: 'dhcp',
      anonymous: true,
      ownership: null,
      base: null,
      baseRevision: null,
      desired: null,
      status: 'in_sync' as const,
      conflict: null,
      driftSince: null,
      position: 0,
    }
    const rows: SectionState[] = [
      {
        ...base,
        perchId: 'h1',
        name: 'cfg01',
        type: 'host',
        scope: 'unmodeled',
        domain: 'dhcp_hosts',
        issue: 'ambiguous',
        router: { type: 'host', options: { mac: '02:00:00:00:10:21' } },
      },
      {
        ...base,
        perchId: 'd1',
        name: 'cfg02',
        type: 'dnsmasq',
        scope: 'synced',
        domain: 'dns_settings',
        issue: null,
        router: { type: 'dnsmasq', options: {} },
        desired: { type: 'dnsmasq', options: {} },
      },
    ]
    const issues = featureSyncIssues(domainRegistry(), rows, {
      resolver: { dnsmasqPort: null, controllerHost: null },
    })
    assert.deepEqual(
      issues.map((i) => [i.feature, i.objectId, i.code]),
      [
        ['dhcp_hosts', 'h1', 'section_ambiguous'],
        ['dns_settings', 'd1', 'dns_dnsmasq_not_running'],
      ]
    )
  })

  test('a mirror a new domain claims is promoted to synced, never drift', ({ assert }) => {
    const system = fixture('system')
    const mirror: SectionState = {
      perchId: 'sys1',
      config: 'system',
      name: system.sections[0].name,
      type: 'system',
      anonymous: true,
      scope: 'unmodeled',
      domain: null,
      ownership: null,
      issue: null,
      base: { type: 'system', options: system.sections[0].options },
      baseRevision: null,
      router: { type: 'system', options: system.sections[0].options },
      desired: { type: 'system', options: system.sections[0].options },
      status: 'in_sync',
      conflict: null,
      driftSince: null,
      position: 0,
    }
    let n = 0
    const result = reconcileRead({
      rows: [mirror],
      read: { configs: [system], ledger: [] },
      registry: domainRegistry(),
      mode: 'managed',
      authoritative: true,
      now: '2026-09-23T10:00:00.000Z',
      newPerchId: () => `new${++n}`,
    })
    const promoted = result.changes.find((c) => c.perchId === 'sys1')!
    assert.equal(promoted.kind, 'rescoped')
    assert.equal(promoted.after?.scope, 'synced')
    assert.equal(promoted.after?.domain, 'system')
    assert.equal(promoted.after?.status, 'in_sync')
    assert.deepEqual(promoted.after?.ownership, {
      kind: 'options',
      options: ['hostname', 'timezone', 'zonename'],
    })
    // The NTP section had no row: it is new, and under Authoritative Mode a new router section is drift.
    const ntp = result.changes.find((c) => c.after?.name === 'ntp')!
    assert.equal(ntp.kind, 'drift')
    // The LED stays a plain mirror.
    const led = result.changes.find((c) => c.after?.name === 'led_wan')!
    assert.equal(led.after?.scope, 'unmodeled')
    assert.include(result.unledgered, 'sys1', 'the next apply adopts it')
  })

  test('validateDesired runs the new domains over the registry', ({ assert }) => {
    const bad: SyncedSection & { domain: string } = {
      perchId: 'x',
      config: 'system',
      name: 'cfg01',
      type: 'system',
      anonymous: true,
      options: { hostname: '-bad-' },
      domain: 'system',
    }
    assert.deepEqual(
      validateDesired(domainRegistry(), [bad], { capabilities: null }).map((i) => i.code),
      ['system_hostname_invalid']
    )
  })
})
