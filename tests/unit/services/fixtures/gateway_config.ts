import type { UciConfig, UciSection } from '#services/gateway_config/types'

/**
 * Router configs as `gateway.config.read` returns them (ubus `uci get`
 * shape: lists as arrays, `.anonymous`/`.index` flattened), for the config
 * plane's unit tests. Placeholders only: 192.168.x.x, 02:00:00 MACs.
 */

export function section(
  name: string,
  type: string,
  options: UciSection['options'],
  extra: Partial<UciSection> = {}
): UciSection {
  return { name, type, anonymous: false, index: 0, options, ...extra }
}

/** Sets `.index` in order, the way the agent reports it. */
export function config(name: string, sections: UciSection[], hash = `${name}-h1`): UciConfig {
  return { name, hash, sections: sections.map((s, index) => ({ ...s, index })) }
}

/**
 * A realistic `/etc/config/dhcp` of an OpenWrt 24.10 router: dnsmasq and
 * odhcpd sections, pools, and host reservations spelled every way LuCI and
 * `uci` produce them.
 */
export function dhcpConfig(): UciConfig {
  return config('dhcp', [
    section(
      'cfg01411c',
      'dnsmasq',
      {
        domainneeded: '1',
        localise_queries: '1',
        rebind_protection: '1',
        local: '/lan/',
        domain: 'lan',
        expandhosts: '1',
        authoritative: '1',
        readethers: '1',
        leasefile: '/tmp/dhcp.leases',
        localservice: '1',
        server: ['192.168.1.53', '/example.com/192.168.1.54'],
        rebind_domain: ['example.com'],
      },
      { anonymous: true }
    ),
    section('lan', 'dhcp', {
      interface: 'lan',
      start: '100',
      limit: '150',
      leasetime: '12h',
      dhcpv4: 'server',
      dhcp_option: ['6,192.168.1.53', '42,192.168.1.1'],
    }),
    section('wan', 'dhcp', { interface: 'wan', ignore: '1' }),
    section('odhcpd', 'odhcpd', {
      maindhcp: '0',
      leasefile: '/tmp/hosts/odhcpd',
      leasetrigger: '/usr/sbin/odhcpd-update',
      loglevel: '4',
    }),
    // LuCI "Static leases": anonymous, list mac.
    section(
      'cfg07fe63',
      'host',
      { name: 'printer', dns: '1', mac: ['02:00:00:00:00:11'], ip: '192.168.1.20' },
      { anonymous: true }
    ),
    // `uci set` style: a string MAC, uppercase, lease time, carried options.
    section('nas', 'host', {
      name: 'nas',
      mac: '02:00:00:00:00:AA',
      ip: '192.168.1.21',
      leasetime: 'infinite',
      tag: 'known',
      match_tag: 'known',
      duid: '0001000102000000000000aa',
    }),
    // Two MACs in one string (dnsmasq's "either of these").
    section('laptop', 'host', {
      name: 'laptop',
      mac: '02:00:00:00:00:21 02:00:00:00:00:22',
      ip: '192.168.1.22',
    }),
    // Name-only host: the name follows the dynamic lease.
    section('phone', 'host', { name: 'phone', mac: ['02:00:00:00:00:31'], dns: '1' }),
    // DHCP deny.
    section('blocked', 'host', { mac: '02:00:00:00:00:41', ip: 'ignore' }),
    // Wildcard: imported, never adoptable.
    section('vendor', 'host', { mac: '02:00:00:00:*:*', tag: 'vendor' }),
    // No MAC: not a reservation.
    section('nameonly', 'host', { name: 'static-name', ip: '192.168.1.99' }),
  ])
}

export function networkConfig(): UciConfig {
  return config('network', [
    section('loopback', 'interface', {
      device: 'lo',
      proto: 'static',
      ipaddr: '127.0.0.1',
      netmask: '255.0.0.0',
    }),
    section('globals', 'globals', { ula_prefix: 'fd00:db8::/48' }),
    section(
      'cfg030f15',
      'device',
      { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3'] },
      { anonymous: true }
    ),
    section('lan', 'interface', { device: 'br-lan', proto: 'static', ipaddr: ['192.168.1.1/24'] }),
    section('guest', 'interface', {
      device: 'br-guest',
      proto: 'static',
      ipaddr: ['192.168.3.1/24'],
    }),
    section('wan', 'interface', { device: 'wan', proto: 'dhcp' }),
  ])
}

export function firewallConfig(): UciConfig {
  return config('firewall', [
    section(
      'cfg01e63d',
      'defaults',
      { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', syn_flood: '1' },
      { anonymous: true }
    ),
    section(
      'cfg02dc81',
      'zone',
      { name: 'lan', network: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' },
      { anonymous: true }
    ),
    section(
      'cfg03dc81',
      'zone',
      { name: 'guest', network: ['guest'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' },
      { anonymous: true }
    ),
    section(
      'cfg04dc81',
      'zone',
      {
        name: 'wan',
        network: ['wan', 'wan6'],
        input: 'REJECT',
        output: 'ACCEPT',
        forward: 'REJECT',
        masq: '1',
      },
      { anonymous: true }
    ),
  ])
}
