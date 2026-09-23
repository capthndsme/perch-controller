import { config, section } from '#tests/unit/services/fixtures/gateway_config'
import type { UciConfig, UciConfigSet } from '#services/gateway_config/types'

/**
 * Router configs of the networks domain's tests (docs/gateway/networks.md):
 * a DSA router (OpenWrt ≥ 21.02 `config device` syntax) with an untagged
 * `br-lan`, a guest bridge, a VLAN-filtering trunk bridge carrying VLANs
 * 110 and 120 through `bridge-vlan` (the lab's layout), an 802.1q VLAN on a
 * plain NIC, two WANs (DHCP and static with a gateway) and the sections the
 * domain leaves alone (loopback, globals, a port's MAC override, a swconfig
 * switch). Placeholders only: 192.168.x.x, 203.0.113.x.
 */

export function dsaNetworkConfig(): UciConfig {
  return config('network', [
    section('loopback', 'interface', {
      device: 'lo',
      proto: 'static',
      ipaddr: '127.0.0.1',
      netmask: '255.0.0.0',
    }),
    section('globals', 'globals', { ula_prefix: 'fd00:db8::/48', packet_steering: '1' }),
    section(
      'cfg030f15',
      'device',
      { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3'] },
      { anonymous: true }
    ),
    section(
      'cfg040f15',
      'device',
      { name: 'wan', macaddr: '02:00:00:00:00:99' },
      { anonymous: true }
    ),
    section('lan', 'interface', {
      device: 'br-lan',
      proto: 'static',
      ipaddr: '192.168.1.1',
      netmask: '255.255.255.0',
      ip6assign: '60',
    }),
    section('guest_dev', 'device', {
      name: 'br-guest',
      type: 'bridge',
      ports: ['lan4'],
      bridge_empty: '1',
    }),
    section('guest', 'interface', {
      device: 'br-guest',
      proto: 'static',
      ipaddr: ['192.168.3.1/24'],
    }),
    section(
      'cfg050f15',
      'device',
      { name: 'br-trunk', type: 'bridge', ports: ['trunk'] },
      { anonymous: true }
    ),
    section(
      'cfg060f15',
      'bridge-vlan',
      { device: 'br-trunk', vlan: '110', ports: ['trunk:t'] },
      { anonymous: true }
    ),
    section(
      'cfg070f15',
      'bridge-vlan',
      { device: 'br-trunk', vlan: '120', ports: 'trunk:t' },
      { anonymous: true }
    ),
    section('vlan110', 'interface', {
      device: 'br-trunk.110',
      proto: 'static',
      ipaddr: '192.168.110.1',
      netmask: '255.255.255.0',
    }),
    section('vlan120', 'interface', {
      device: 'br-trunk.120',
      proto: 'static',
      ipaddr: '192.168.120.1',
      netmask: '255.255.255.0',
    }),
    section('iot_vlan', 'device', { type: '8021q', ifname: 'eth1', vid: '30', name: 'eth1.30' }),
    section('iot', 'interface', {
      device: 'eth1.30',
      proto: 'static',
      ipaddr: '192.168.30.1',
      netmask: '255.255.255.0',
      force_link: '1',
    }),
    section('wan', 'interface', { device: 'wan', proto: 'dhcp', peerdns: '0' }),
    section('wan6', 'interface', { device: 'wan', proto: 'dhcpv6' }),
    section('wan2', 'interface', {
      device: 'wan2',
      proto: 'static',
      ipaddr: '203.0.113.2',
      netmask: '255.255.255.0',
      gateway: '203.0.113.1',
      metric: '20',
    }),
    section('cfg0a0f15', 'switch', { name: 'switch0', reset: '1' }, { anonymous: true }),
    section(
      'cfg0b0f15',
      'switch_vlan',
      { device: 'switch0', vlan: '1', ports: '0 1 2 6t' },
      { anonymous: true }
    ),
  ])
}

export function networksFirewallConfig(): UciConfig {
  return config('firewall', [
    section(
      'cfg01e63d',
      'defaults',
      { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' },
      { anonymous: true }
    ),
    section(
      'cfg02dc81',
      'zone',
      { name: 'lan', network: ['lan', 'vlan110', 'vlan120'], input: 'ACCEPT', forward: 'ACCEPT' },
      { anonymous: true }
    ),
    section(
      'cfg03dc81',
      'zone',
      { name: 'guest', network: 'guest', input: 'REJECT', forward: 'REJECT' },
      { anonymous: true }
    ),
    section(
      'cfg04dc81',
      'zone',
      { name: 'wan', network: ['wan', 'wan6', 'wan2'], masq: '1', input: 'REJECT' },
      { anonymous: true }
    ),
  ])
}

export function networksDhcpConfig(): UciConfig {
  return config('dhcp', [
    section('cfg01411c', 'dnsmasq', { domainneeded: '1', local: '/lan/' }, { anonymous: true }),
    section('lan', 'dhcp', {
      interface: 'lan',
      start: '100',
      limit: '150',
      leasetime: '12h',
      dhcpv4: 'server',
      ra: 'server',
      dhcp_option: ['6,192.168.1.2', '42,192.168.1.1'],
    }),
    section('guest', 'dhcp', { interface: 'guest', start: '50', limit: '100', leasetime: '1h' }),
    section('wan', 'dhcp', { interface: 'wan', ignore: '1' }),
    section('odhcpd', 'odhcpd', { maindhcp: '0', leasefile: '/tmp/hosts/odhcpd' }),
  ])
}

export function networkConfigSet(): UciConfigSet {
  return {
    network: dsaNetworkConfig(),
    firewall: networksFirewallConfig(),
    dhcp: networksDhcpConfig(),
  }
}
