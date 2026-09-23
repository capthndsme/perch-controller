import type { UciConfig, UciSection } from '#services/gateway_config/types'
import { config, section } from '#tests/unit/services/fixtures/gateway_config'

/**
 * A realistic `/etc/config/firewall` of a busy home gateway (fw4, OpenWrt
 * 23.05/24.10), as `gateway.config.read` returns it: the stock defaults,
 * zones and rules LuCI ships, guest and IoT zones, 39 port forwards spelled
 * every way LuCI and `uci` write them (proto lists and strings, `tcpudp`,
 * port ranges with `-` and `:`, disabled ones, reflection off, an unnamed
 * one, a DNS intercept), a SNAT redirect and a `nat` section (observed only),
 * a package include (miniupnpd), an operator ipset, and Perch's WAN block.
 * Placeholders only: 192.168.x.x, 203.0.113.x, 02:00:00 MACs.
 */

const anon = { anonymous: true }

type Forward = {
  name?: string
  proto?: string | string[]
  ext: string
  ip: string
  port?: string
  extra?: Record<string, string | string[]>
}

/** 39 DNAT port forwards (plan 2 section 1: the live gateway has 39). */
const FORWARDS: Forward[] = [
  { name: 'Minecraft', proto: 'tcp', ext: '25565', ip: '192.168.1.20' },
  { name: 'Plex', proto: 'tcp', ext: '32400', ip: '192.168.1.21' },
  { name: 'NAS-HTTPS', proto: 'tcp', ext: '5001', ip: '192.168.1.22' },
  { name: 'Game-UDP', proto: 'udp', ext: '27015:27030', ip: '192.168.1.23' },
  { name: 'Game-TCP', proto: 'tcp', ext: '27015-27030', ip: '192.168.1.23' },
  { name: 'SSH-Jump', proto: 'tcp', ext: '2222', ip: '192.168.1.24', port: '22' },
  { name: 'Web-Dev', proto: 'tcp', ext: '8080', ip: '192.168.1.25', port: '80' },
  { name: 'Web-Dev-TLS', proto: 'tcp', ext: '8443', ip: '192.168.1.25', port: '443' },
  { name: 'VoIP-SIP', proto: 'udp', ext: '5060', ip: '192.168.1.26' },
  { name: 'VoIP-RTP', proto: 'udp', ext: '10000-10100', ip: '192.168.1.26' },
  { name: 'Torrent', proto: 'tcp udp', ext: '51413', ip: '192.168.1.27' },
  { name: 'Camera-1-RTSP', proto: 'tcp', ext: '8554', ip: '192.168.1.30', port: '554' },
  { name: 'Camera-2-RTSP', proto: 'tcp', ext: '8555', ip: '192.168.1.31', port: '554' },
  { name: 'Camera-3-RTSP', proto: 'tcp', ext: '8556', ip: '192.168.1.32', port: '554' },
  { name: 'Home-Assistant', proto: ['tcp'], ext: '8123', ip: '192.168.1.40' },
  { name: 'MQTT-TLS', proto: 'tcp', ext: '8883', ip: '192.168.1.40' },
  { name: 'WireGuard-Pi', proto: 'udp', ext: '51821', ip: '192.168.1.41', port: '51820' },
  { name: 'Syncthing', proto: ['tcp', 'udp'], ext: '22000', ip: '192.168.1.22' },
  { name: 'Nextcloud', proto: 'tcp', ext: '4443', ip: '192.168.1.22', port: '443' },
  { name: 'Jellyfin', proto: 'tcp', ext: '8096', ip: '192.168.1.21' },
  { name: 'Valheim', proto: 'udp', ext: '2456-2458', ip: '192.168.1.23' },
  { name: 'Factorio', proto: 'udp', ext: '34197', ip: '192.168.1.23' },
  { name: 'Terraria', proto: 'tcp', ext: '7777', ip: '192.168.1.23' },
  { name: 'Satisfactory', proto: 'udp', ext: '15777', ip: '192.168.1.23' },
  { name: 'TeamSpeak-Voice', proto: 'udp', ext: '9987', ip: '192.168.1.28' },
  { name: 'TeamSpeak-Query', proto: 'tcp', ext: '10011', ip: '192.168.1.28' },
  { name: 'TeamSpeak-Files', proto: 'tcp', ext: '30033', ip: '192.168.1.28' },
  { name: 'Printer-IPP', proto: 'tcp', ext: '6310', ip: '192.168.1.50', port: '631' },
  {
    name: 'Old-FTP',
    proto: 'tcp',
    ext: '2121',
    ip: '192.168.1.22',
    port: '21',
    extra: { enabled: '0' },
  },
  {
    name: 'Xbox-Live',
    proto: 'tcpudp',
    ext: '3074',
    ip: '192.168.1.60',
    extra: { reflection: '0' },
  },
  { name: 'Xbox-Live-UDP', proto: 'udp', ext: '88', ip: '192.168.1.60' },
  { name: 'PS-Remote', proto: 'tcp', ext: '9295-9297', ip: '192.168.1.61' },
  { name: 'Switch-P2P', proto: 'udp', ext: '45000:65535', ip: '192.168.1.62' },
  {
    name: 'Gitea-SSH',
    proto: 'tcp',
    ext: '2223',
    ip: '192.168.1.42',
    port: '22',
    extra: { family: 'ipv4' },
  },
  { name: 'Gitea-Web', proto: 'tcp', ext: '3000', ip: '192.168.1.42' },
  { name: 'Grafana', proto: 'tcp', ext: '3001', ip: '192.168.1.43', port: '3000' },
  {
    name: 'Restricted-RDP',
    proto: 'tcp',
    ext: '3390',
    ip: '192.168.1.44',
    port: '3389',
    extra: { src_ip: '203.0.113.7' },
  },
  { name: 'Vaultwarden', proto: 'tcp', ext: '8444', ip: '192.168.1.45', port: '443' },
  // Unnamed: identified by its content.
  { proto: 'udp', ext: '1194', ip: '192.168.1.46' },
]

function forward(f: Forward, i: number): UciSection {
  const options: Record<string, string | string[]> = {
    target: 'DNAT',
    src: 'wan',
    dest: 'lan',
    ...(f.name ? { name: f.name } : {}),
    ...(f.proto ? { proto: f.proto } : {}),
    src_dport: f.ext,
    dest_ip: f.ip,
    ...(f.port ? { dest_port: f.port } : {}),
    ...(f.extra ?? {}),
  }
  // Every few, LuCI's newer spelling (anonymous) vs an older named section.
  return i % 5 === 3
    ? section(`fwd_${i}`, 'redirect', options)
    : section(`cfg${(0x40 + i).toString(16)}a1b2`, 'redirect', options, anon)
}

export function homeFirewallConfig(): UciConfig {
  const sections: UciSection[] = [
    section(
      'cfg01e63d',
      'defaults',
      {
        syn_flood: '1',
        input: 'REJECT',
        output: 'ACCEPT',
        forward: 'REJECT',
        flow_offloading: '1',
      },
      anon
    ),
    section(
      'cfg02dc81',
      'zone',
      { name: 'lan', network: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' },
      anon
    ),
    section(
      'cfg03dc81',
      'zone',
      {
        name: 'wan',
        network: ['wan', 'wan6', 'wan2'],
        input: 'REJECT',
        output: 'ACCEPT',
        forward: 'REJECT',
        masq: '1',
        mtu_fix: '1',
      },
      anon
    ),
    section(
      'guest',
      'zone',
      { name: 'guest', network: 'guest', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' },
      {}
    ),
    section(
      'iot',
      'zone',
      { name: 'iot', network: ['iot'], input: 'reject', output: 'accept', forward: 'reject' },
      {}
    ),
    section('cfg06ad58', 'forwarding', { src: 'lan', dest: 'wan' }, anon),
    section('cfg07ad58', 'forwarding', { src: 'guest', dest: 'wan' }, anon),
    section('cfg08ad58', 'forwarding', { src: 'iot', dest: 'wan' }, anon),
    section('cfg09ad58', 'forwarding', { src: 'lan', dest: 'iot' }, anon),
    // Perch's WAN block, first among the rules toward WAN.
    section('perch_block_wan', 'ipset', {
      name: 'perch_block_wan',
      match: 'src_mac',
      entry: ['02:00:00:00:00:70', '02:00:00:00:00:71'],
    }),
    section('perch_block_wan_wan', 'rule', {
      name: 'Perch: block internet (wan)',
      src: '*',
      dest: 'wan',
      ipset: 'perch_block_wan',
      proto: 'all',
      target: 'REJECT',
    }),
    // The stock rules of /etc/config/firewall.
    section(
      'cfg0c92bd',
      'rule',
      {
        name: 'Allow-DHCP-Renew',
        src: 'wan',
        proto: 'udp',
        dest_port: '68',
        target: 'ACCEPT',
        family: 'ipv4',
      },
      anon
    ),
    section(
      'cfg0d92bd',
      'rule',
      {
        name: 'Allow-Ping',
        src: 'wan',
        proto: 'icmp',
        icmp_type: 'echo-request',
        family: 'ipv4',
        target: 'ACCEPT',
      },
      anon
    ),
    section(
      'cfg0e92bd',
      'rule',
      { name: 'Allow-IGMP', src: 'wan', proto: 'igmp', family: 'ipv4', target: 'ACCEPT' },
      anon
    ),
    section(
      'cfg0f92bd',
      'rule',
      {
        name: 'Allow-DHCPv6',
        src: 'wan',
        proto: 'udp',
        dest_port: '546',
        family: 'ipv6',
        target: 'ACCEPT',
      },
      anon
    ),
    section(
      'cfg1092bd',
      'rule',
      {
        name: 'Allow-MLD',
        src: 'wan',
        proto: 'icmp',
        src_ip: 'fe80::/10',
        icmp_type: ['130/0', '131/0', '132/0', '143/0'],
        family: 'ipv6',
        target: 'ACCEPT',
      },
      anon
    ),
    section(
      'cfg1192bd',
      'rule',
      {
        name: 'Allow-ICMPv6-Input',
        src: 'wan',
        proto: 'icmp',
        icmp_type: [
          'echo-request',
          'echo-reply',
          'destination-unreachable',
          'packet-too-big',
          'time-exceeded',
          'bad-header',
          'unknown-header-type',
          'router-solicitation',
          'neighbour-solicitation',
          'router-advertisement',
          'neighbour-advertisement',
        ],
        limit: '1000/sec',
        family: 'ipv6',
        target: 'ACCEPT',
      },
      anon
    ),
    section(
      'cfg1292bd',
      'rule',
      {
        name: 'Allow-ICMPv6-Forward',
        src: 'wan',
        dest: '*',
        proto: 'icmp',
        icmp_type: [
          'echo-request',
          'echo-reply',
          'destination-unreachable',
          'packet-too-big',
          'time-exceeded',
          'bad-header',
          'unknown-header-type',
        ],
        limit: '1000/sec',
        family: 'ipv6',
        target: 'ACCEPT',
      },
      anon
    ),
    section(
      'cfg1392bd',
      'rule',
      { name: 'Allow-IPSec-ESP', src: 'wan', dest: 'lan', proto: 'esp', target: 'ACCEPT' },
      anon
    ),
    section(
      'cfg1492bd',
      'rule',
      {
        name: 'Allow-ISAKMP',
        src: 'wan',
        dest: 'lan',
        dest_port: '500',
        proto: 'udp',
        target: 'ACCEPT',
      },
      anon
    ),
    // Guest and IoT: DHCP, DNS and ping to the router only.
    section('guest_dhcp', 'rule', {
      name: 'Guest-DHCP',
      src: 'guest',
      proto: 'udp',
      dest_port: '67-68',
      target: 'ACCEPT',
      family: 'ipv4',
    }),
    section('guest_dns', 'rule', {
      name: 'Guest-DNS',
      src: 'guest',
      proto: 'tcp udp',
      dest_port: '53',
      target: 'ACCEPT',
    }),
    section(
      'cfg1792bd',
      'rule',
      { name: 'IoT-DNS', src: 'iot', proto: ['tcp', 'udp'], dest_port: '53', target: 'ACCEPT' },
      anon
    ),
    section(
      'cfg1892bd',
      'rule',
      {
        name: 'IoT-NTP-only',
        src: 'iot',
        dest: 'wan',
        proto: 'udp',
        dest_port: '123',
        target: 'ACCEPT',
      },
      anon
    ),
    section(
      'cfg1992bd',
      'rule',
      { name: 'IoT-no-internet', src: 'iot', dest: 'wan', proto: 'all', target: 'REJECT' },
      anon
    ),
    section(
      'cfg1a92bd',
      'rule',
      {
        name: 'Kids-bedtime',
        src: 'lan',
        dest: 'wan',
        src_mac: ['02:00:00:00:00:51', '02:00:00:00:00:52'],
        start_time: '22:00:00',
        stop_time: '06:30:00',
        weekdays: 'Mon Tue Wed Thu Sun',
        target: 'REJECT',
        enabled: '0',
      },
      anon
    ),
    // A DNS intercept: every LAN DNS query to the router's resolver.
    section('dns_intercept', 'redirect', {
      name: 'Intercept-DNS',
      src: 'lan',
      src_dport: '53',
      proto: 'tcp udp',
      dest_port: '53',
      target: 'DNAT',
      src_ip: '!192.168.1.2',
    }),
    ...FORWARDS.map(forward),
    // Observed only: SNAT, nat, a package include, an operator ipset.
    section(
      'cfg6592bd',
      'redirect',
      {
        name: 'SNAT-VPN',
        src: 'lan',
        dest: 'wan',
        target: 'SNAT',
        src_ip: '192.168.1.0/24',
        snat_ip: '203.0.113.10',
        proto: 'all',
      },
      anon
    ),
    section(
      'cfg6692bd',
      'nat',
      {
        name: 'Masq-VPN',
        src: 'wan',
        src_ip: '192.168.9.0/24',
        target: 'MASQUERADE',
        proto: 'all',
      },
      anon
    ),
    section('miniupnpd', 'include', {
      type: 'script',
      path: '/usr/share/miniupnpd/firewall.include',
      family: 'any',
      reload: '1',
    }),
    section(
      'cfg6892bd',
      'ipset',
      { name: 'vpn_domains', match: ['dst_net'], family: 'ipv4' },
      anon
    ),
  ]
  return config('firewall', sections)
}

/** The LAN networks of the fixture (validation context). */
export const HOME_NETWORKS = [
  { name: 'lan', ipv4: ['192.168.1.1/24'] },
  { name: 'guest', ipv4: ['192.168.3.1/24'] },
  { name: 'iot', ipv4: ['192.168.4.1/24'] },
]
