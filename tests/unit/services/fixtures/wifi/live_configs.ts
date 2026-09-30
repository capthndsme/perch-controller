import type { ApReadConfig } from '#services/wifi_config/types'

/**
 * The committed `wireless` and `network` configs of three real OpenWrt
 * access points and the lab AP, in the shape `wifi.config.read` returns
 * (protocol.md 3.2), for the Wi-Fi plane's round-trip and fleet tests.
 * Taken read-only from `uci show` on 2026-09-30 and anonymised: secrets
 * replaced by made-up `hmac:` fingerprints (one per SSID: each network uses
 * one passphrase everywhere), SSIDs, interface names and mesh ids renamed,
 * addresses moved to 192.168.x.x, BSSIDs to 02:00:00:…, ULA prefixes to
 * fd00:…; anonymous sections got `cfg…` names. Everything else (order,
 * spelling, stale radios, orphaned and station interfaces, custom
 * `ifname`s) is as the devices have it.
 *
 * - WRX36: DL-WRX36 (ipq807x, OpenWrt 24.10-SNAPSHOT), untagged br-lan, a
 *   disabled mesh interface, an open SSID on both bands.
 * - RAX3000M: mt7981 (24.10.0-rc4), VLAN-filtering br-lan, a stale radio0
 *   (old path), radio2 is the working 2.4 GHz radio, eight interfaces on a
 *   radio3 that does not exist (four of them stations), custom ifnames.
 * - AX23: Archer AX23 (mt7621, 25.12.4), VLAN-filtering br-lan, 5 GHz on a
 *   DFS channel.
 * - LAB_AP: the lab's hwsim AP: the device-groups engine's sections
 *   (`owner: 'groups'`, `dynamic_vlan` on its interface) and an SSID bound
 *   to a router-made VLAN network.
 */

export const WRX36_CONFIGS: ApReadConfig[] = [
  {
    name: 'network',
    hash: '26069271ea1782949fbde0ae44f328537c875fe8002ae4dcddb470a45abbaaf7',
    sections: [
      {
        name: 'loopback',
        type: 'interface',
        anonymous: false,
        index: 0,
        options: {
          device: 'lo',
          proto: 'static',
          ipaddr: '127.0.0.1',
          netmask: '255.0.0.0',
        },
      },
      {
        name: 'globals',
        type: 'globals',
        anonymous: false,
        index: 1,
        options: {
          ula_prefix: 'fd00:0:1::/48',
          packet_steering: '0',
        },
      },
      {
        name: 'cfg030f15',
        type: 'device',
        anonymous: true,
        index: 2,
        options: {
          name: 'br-lan',
          type: 'bridge',
          ports: ['lan2', 'lan3', 'lan4', 'wan'],
        },
      },
      {
        name: 'lan',
        type: 'interface',
        anonymous: false,
        index: 3,
        options: {
          device: 'br-lan',
          proto: 'static',
          ipaddr: '192.168.1.16',
          netmask: '255.255.128.0',
          ip6assign: '60',
          gateway: '192.168.0.1',
          dns: '192.168.0.1',
          dns_search: 'lan',
        },
      },
      {
        name: 'lan6',
        type: 'interface',
        anonymous: false,
        index: 4,
        options: {
          proto: 'none',
          device: 'br-lan',
        },
      },
      {
        name: 'wan',
        type: 'interface',
        anonymous: false,
        index: 5,
        options: {
          proto: 'dhcp',
          device: 'lan1',
        },
      },
      {
        name: 'cfg050f15',
        type: 'device',
        anonymous: true,
        index: 6,
        options: {
          name: 'wan',
        },
      },
    ],
  },
  {
    name: 'wireless',
    hash: '2d0695c004f39d77d257e15f93b76114c67f70115f5326d2ab10344ff3c7226a',
    sections: [
      {
        name: 'radio0',
        type: 'wifi-device',
        anonymous: false,
        index: 0,
        options: {
          type: 'mac80211',
          path: 'platform/soc@0/c000000.wifi',
          band: '5g',
          channel: '149',
          htmode: 'HE80',
          txpower: '30',
          country: 'US',
          cell_density: '0',
        },
      },
      {
        name: 'default_radio0',
        type: 'wifi-iface',
        anonymous: false,
        index: 1,
        options: {
          device: 'radio0',
          network: 'lan',
          mode: 'ap',
          ssid: 'The Cave',
          encryption: 'psk2+ccmp',
        },
        secrets: {
          key: 'hmac:431073830e468ba6',
        },
      },
      {
        name: 'radio1',
        type: 'wifi-device',
        anonymous: false,
        index: 2,
        options: {
          type: 'mac80211',
          path: 'platform/soc@0/c000000.wifi+1',
          band: '2g',
          channel: '1',
          htmode: 'HE20',
          country: 'TW',
          cell_density: '0',
        },
      },
      {
        name: 'default_radio1',
        type: 'wifi-iface',
        anonymous: false,
        index: 3,
        options: {
          device: 'radio1',
          network: 'lan',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'wifinet2',
        type: 'wifi-iface',
        anonymous: false,
        index: 4,
        options: {
          device: 'radio0',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
          network: 'lan',
          macaddr: 'random',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'wifinet3',
        type: 'wifi-iface',
        anonymous: false,
        index: 5,
        options: {
          device: 'radio0',
          mode: 'mesh',
          encryption: 'sae',
          mesh_id: 'ExampleMesh1',
          mesh_fwding: '1',
          mesh_rssi_threshold: '0',
          network: 'lan',
          disabled: '1',
        },
        secrets: {
          key: 'hmac:bca2ba53e01028d9',
        },
      },
      {
        name: 'wifinet4',
        type: 'wifi-iface',
        anonymous: false,
        index: 6,
        options: {
          device: 'radio1',
          mode: 'ap',
          ssid: '@Example_FreeWifi',
          encryption: 'none',
          network: 'lan',
        },
      },
      {
        name: 'wifinet5',
        type: 'wifi-iface',
        anonymous: false,
        index: 7,
        options: {
          device: 'radio0',
          mode: 'ap',
          ssid: '@Example_FreeWifi',
          encryption: 'none',
          network: 'lan',
        },
      },
    ],
  },
]

export const RAX3000M_CONFIGS: ApReadConfig[] = [
  {
    name: 'network',
    hash: '54fd61a391fceea29be28ca96f00f53914793e4a6d1bacb0afa87bcea4130f62',
    sections: [
      {
        name: 'loopback',
        type: 'interface',
        anonymous: false,
        index: 0,
        options: {
          device: 'lo',
          proto: 'static',
          ipaddr: '127.0.0.1',
          netmask: '255.0.0.0',
        },
      },
      {
        name: 'globals',
        type: 'globals',
        anonymous: false,
        index: 1,
        options: {
          ula_prefix: 'fd00:0:2::/48',
          packet_steering: '2',
          steering_flows: '128',
        },
      },
      {
        name: 'cfg030f15',
        type: 'device',
        anonymous: true,
        index: 2,
        options: {
          name: 'br-lan',
          type: 'bridge',
          ports: ['lan1', 'lan2', 'lan3'],
        },
      },
      {
        name: 'lan',
        type: 'interface',
        anonymous: false,
        index: 3,
        options: {
          device: 'br-lan.1',
          proto: 'static',
          gateway: '192.168.0.1',
          dns: '192.168.0.1',
          delegate: '0',
          ipaddr: '192.168.1.17/17',
        },
      },
      {
        name: 'cfg040f15',
        type: 'bridge-vlan',
        anonymous: true,
        index: 4,
        options: {
          device: 'br-lan',
          vlan: '1',
          ports: ['lan1:u*', 'lan2:u*', 'lan3:u*'],
        },
      },
      {
        name: 'neth',
        type: 'interface',
        anonymous: false,
        index: 5,
        options: {
          proto: 'dhcpv6',
          device: '@lan',
          reqaddress: 'try',
          reqprefix: 'auto',
        },
      },
      {
        name: 'wan',
        type: 'interface',
        anonymous: false,
        index: 6,
        options: {
          proto: 'dhcp',
          device: 'eth1',
        },
      },
      {
        name: 'wan6',
        type: 'interface',
        anonymous: false,
        index: 7,
        options: {
          proto: 'dhcpv6',
          device: 'eth1',
        },
      },
    ],
  },
  {
    name: 'wireless',
    hash: '28f6a1e9cf887b8052aafdeafd9c210f32be2f8a7f23322852fbab02c7615be5',
    sections: [
      {
        name: 'radio0',
        type: 'wifi-device',
        anonymous: false,
        index: 0,
        options: {
          type: 'mac80211',
          path: 'platform/18000000.wifi',
          channel: '1',
          band: '2g',
          htmode: 'HE20',
          disabled: '0',
        },
      },
      {
        name: 'radio1',
        type: 'wifi-device',
        anonymous: false,
        index: 1,
        options: {
          type: 'mac80211',
          path: 'platform/soc/18000000.wifi+1',
          channel: '36',
          band: '5g',
          htmode: 'HE80',
          cell_density: '0',
        },
      },
      {
        name: 'radio2',
        type: 'wifi-device',
        anonymous: false,
        index: 2,
        options: {
          type: 'mac80211',
          path: 'platform/soc/18000000.wifi',
          band: '2g',
          channel: '13',
          htmode: 'HE20',
          country: 'PH',
          cell_density: '0',
        },
      },
      {
        name: 'default_radio2',
        type: 'wifi-iface',
        anonymous: false,
        index: 3,
        options: {
          device: 'radio2',
          network: 'lan',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
          ifname: 'ff-main',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'default_radio3',
        type: 'wifi-iface',
        anonymous: false,
        index: 4,
        options: {
          device: 'radio3',
          network: 'lan',
          mode: 'ap',
          ssid: 'The Cave',
          encryption: 'psk2+ccmp',
          ifname: 'ff-dedi-5g',
          disabled: '1',
        },
        secrets: {
          key: 'hmac:431073830e468ba6',
        },
      },
      {
        name: 'wifinet2',
        type: 'wifi-iface',
        anonymous: false,
        index: 5,
        options: {
          device: 'radio3',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
          network: 'lan',
          ifname: 'ff-main-5g',
          disabled: '1',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'wifinet3',
        type: 'wifi-iface',
        anonymous: false,
        index: 6,
        options: {
          device: 'radio3',
          mode: 'ap',
          ssid: 'Test-Wifi6',
          encryption: 'none',
          network: 'lan',
          disabled: '1',
        },
      },
      {
        name: 'wifinet4',
        type: 'wifi-iface',
        anonymous: false,
        index: 7,
        options: {
          device: 'radio3',
          mode: 'ap',
          ssid: 'Test5G',
          encryption: 'psk2+ccmp',
          network: 'lan',
          disabled: '1',
        },
        secrets: {
          key: 'hmac:c34374191aa85e16',
        },
      },
      {
        name: 'wifinet6',
        type: 'wifi-iface',
        anonymous: false,
        index: 8,
        options: {
          device: 'radio3',
          mode: 'sta',
          ssid: "Phone's Hotspot",
          encryption: 'psk2',
          disabled: '1',
        },
        secrets: {
          key: 'hmac:cf6ae25a7e20242d',
        },
      },
      {
        name: 'wifinet7',
        type: 'wifi-iface',
        anonymous: false,
        index: 9,
        options: {
          device: 'radio3',
          mode: 'sta',
          ssid: ' Tablet Hotspot',
          encryption: 'psk2',
          disabled: '1',
        },
        secrets: {
          key: 'hmac:9bcbd057e1a68f32',
        },
      },
      {
        name: 'wifinet8',
        type: 'wifi-iface',
        anonymous: false,
        index: 10,
        options: {
          device: 'radio2',
          mode: 'ap',
          ssid: '@Example_FreeWifi',
          encryption: 'none',
          network: 'lan',
          disabled: '1',
        },
      },
      {
        name: 'wifinet9',
        type: 'wifi-iface',
        anonymous: false,
        index: 11,
        options: {
          device: 'radio3',
          mode: 'sta',
          ssid: 'Neighbour-PUBLIC-3',
          encryption: 'psk2',
          bssid: '02:00:00:00:10:01',
        },
        secrets: {
          key: 'hmac:d1316490481481f8',
        },
      },
      {
        name: 'wifinet10',
        type: 'wifi-iface',
        anonymous: false,
        index: 12,
        options: {
          device: 'radio3',
          mode: 'sta',
          ssid: 'Neighbour-PUBLIC-3',
          bssid: '02:00:00:00:1A:02',
          encryption: 'psk2',
        },
        secrets: {
          key: 'hmac:d1316490481481f8',
        },
      },
      {
        name: 'wifinet13',
        type: 'wifi-iface',
        anonymous: false,
        index: 13,
        options: {
          device: 'radio1',
          mode: 'ap',
          ssid: 'The Cave',
          encryption: 'psk2+ccmp',
          network: 'lan',
        },
        secrets: {
          key: 'hmac:431073830e468ba6',
        },
      },
      {
        name: 'wifinet14',
        type: 'wifi-iface',
        anonymous: false,
        index: 14,
        options: {
          device: 'radio1',
          mode: 'ap',
          ssid: 'OpenWrt',
          encryption: 'none',
          disabled: '1',
        },
      },
      {
        name: 'wifinet15',
        type: 'wifi-iface',
        anonymous: false,
        index: 15,
        options: {
          device: 'radio1',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
          network: 'lan',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'wifinet16',
        type: 'wifi-iface',
        anonymous: false,
        index: 16,
        options: {
          device: 'radio2',
          mode: 'ap',
          ssid: 'Scanning IOT',
          encryption: 'psk2+ccmp',
          network: 'lan',
        },
        secrets: {
          key: 'hmac:ac1bd984d8895c40',
        },
      },
    ],
  },
]

export const AX23_CONFIGS: ApReadConfig[] = [
  {
    name: 'network',
    hash: '86347b184319dda391a762477bf9e2376bacc6752b0db1cdb581d2466c12cea8',
    sections: [
      {
        name: 'loopback',
        type: 'interface',
        anonymous: false,
        index: 0,
        options: {
          device: 'lo',
          proto: 'static',
          ipaddr: '127.0.0.1',
          netmask: '255.0.0.0',
        },
      },
      {
        name: 'globals',
        type: 'globals',
        anonymous: false,
        index: 1,
        options: {
          ula_prefix: 'fd00:0:3::/48',
          packet_steering: '1',
          dhcp_default_duid: '000400000000000000000000000000000001',
        },
      },
      {
        name: 'cfg030f15',
        type: 'device',
        anonymous: true,
        index: 2,
        options: {
          name: 'br-lan',
          type: 'bridge',
          ports: ['lan1', 'lan2', 'lan3', 'lan4', 'wan'],
        },
      },
      {
        name: 'lan',
        type: 'interface',
        anonymous: false,
        index: 3,
        options: {
          device: 'br-lan.1',
          proto: 'static',
          ipaddr: '192.168.1.6',
          netmask: '255.255.128.0',
          gateway: '192.168.0.1',
          dns: '192.168.0.1',
        },
      },
      {
        name: 'cfg040f15',
        type: 'bridge-vlan',
        anonymous: true,
        index: 4,
        options: {
          device: 'br-lan',
          vlan: '1',
          ports: ['lan1:u*', 'lan2:u*', 'lan3:u*', 'lan4:u*', 'wan:u*'],
        },
      },
    ],
  },
  {
    name: 'wireless',
    hash: '1bee15bbfa3a73e71af8c6c39c005878a9801dbc9a97c49d92077f3273b16bef',
    sections: [
      {
        name: 'radio0',
        type: 'wifi-device',
        anonymous: false,
        index: 0,
        options: {
          type: 'mac80211',
          path: '1e140000.pcie/pci0000:00/0000:00:01.0/0000:02:00.0',
          band: '2g',
          channel: '6',
          htmode: 'HE20',
          country: 'TW',
          cell_density: '0',
        },
      },
      {
        name: 'default_radio0',
        type: 'wifi-iface',
        anonymous: false,
        index: 1,
        options: {
          device: 'radio0',
          network: 'lan',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'radio1',
        type: 'wifi-device',
        anonymous: false,
        index: 2,
        options: {
          type: 'mac80211',
          path: '1e140000.pcie/pci0000:00/0000:00:01.0/0000:02:00.0+1',
          band: '5g',
          channel: '100',
          htmode: 'HE80',
          country: 'PH',
          cell_density: '0',
        },
      },
      {
        name: 'default_radio1',
        type: 'wifi-iface',
        anonymous: false,
        index: 3,
        options: {
          device: 'radio1',
          network: 'lan',
          mode: 'ap',
          ssid: 'Scanning...',
          encryption: 'psk2+ccmp',
        },
        secrets: {
          key: 'hmac:d8a49cdd8fdf6e1f',
        },
      },
      {
        name: 'wifinet3',
        type: 'wifi-iface',
        anonymous: false,
        index: 4,
        options: {
          device: 'radio1',
          mode: 'ap',
          ssid: 'The Cave',
          encryption: 'psk2+ccmp',
          network: 'lan',
        },
        secrets: {
          key: 'hmac:431073830e468ba6',
        },
      },
    ],
  },
]

export const LAB_AP_CONFIGS: ApReadConfig[] = [
  {
    name: 'network',
    hash: 'ba3e1ccd200028c2b1950c84d709466a53473287a522a12eed1d90b0adb80f57',
    sections: [
      {
        name: 'loopback',
        type: 'interface',
        anonymous: false,
        index: 0,
        options: {
          device: 'lo',
          proto: 'static',
          ipaddr: '127.0.0.1',
          netmask: '255.0.0.0',
        },
      },
      {
        name: 'cfg030f15',
        type: 'device',
        anonymous: true,
        index: 1,
        options: {
          name: 'br-lan',
          type: 'bridge',
          ports: ['lan0'],
        },
      },
      {
        name: 'cfg040f15',
        type: 'bridge-vlan',
        anonymous: true,
        index: 2,
        options: {
          device: 'br-lan',
          vlan: '1',
          ports: ['lan0:u*'],
        },
      },
      {
        name: 'cfg050f15',
        type: 'bridge-vlan',
        anonymous: true,
        index: 3,
        options: {
          device: 'br-lan',
          vlan: '132',
          ports: ['lan0:t'],
        },
      },
      {
        name: 'lan',
        type: 'interface',
        anonymous: false,
        index: 4,
        options: {
          device: 'br-lan.1',
          proto: 'dhcp',
        },
      },
      {
        name: 'onboard',
        type: 'interface',
        anonymous: false,
        index: 5,
        options: {
          device: 'br-lan.132',
          proto: 'none',
        },
      },
      {
        name: 'perch_bv130',
        type: 'bridge-vlan',
        anonymous: false,
        index: 6,
        options: {
          device: 'br-lan',
          vlan: '130',
          ports: ['lan0:t'],
        },
        owner: 'groups',
      },
      {
        name: 'perch_bv131',
        type: 'bridge-vlan',
        anonymous: false,
        index: 7,
        options: {
          device: 'br-lan',
          vlan: '131',
          ports: ['lan0:t'],
        },
        owner: 'groups',
      },
      {
        name: 'perch_v130',
        type: 'interface',
        anonymous: false,
        index: 8,
        options: {
          proto: 'none',
          device: 'br-lan.130',
        },
        owner: 'groups',
      },
      {
        name: 'perch_v131',
        type: 'interface',
        anonymous: false,
        index: 9,
        options: {
          proto: 'none',
          device: 'br-lan.131',
        },
        owner: 'groups',
      },
    ],
  },
  {
    name: 'wireless',
    hash: '6ebe94bf55cfa66a5a147c44a599e08bfdbb46d5f1ac0625eb3ae5bd55dad06c',
    sections: [
      {
        name: 'radio0',
        type: 'wifi-device',
        anonymous: false,
        index: 0,
        options: {
          type: 'mac80211',
          path: 'virtual/mac80211_hwsim/hwsim0',
          band: '2g',
          channel: '6',
          htmode: 'HT20',
        },
      },
      {
        name: 'default_radio0',
        type: 'wifi-iface',
        anonymous: false,
        index: 1,
        options: {
          device: 'radio0',
          network: 'onboard',
          mode: 'ap',
          ssid: 'Apartment',
          encryption: 'psk2',
          dynamic_vlan: '1',
        },
        secrets: {
          key: 'hmac:f8db1c3ac2017671',
        },
      },
      {
        name: 'perch_wv130_default_radio0',
        type: 'wifi-vlan',
        anonymous: false,
        index: 2,
        options: {
          iface: 'default_radio0',
          name: 'g130',
          vid: '130',
          network: 'perch_v130',
        },
        owner: 'groups',
      },
      {
        name: 'perch_wv131_default_radio0',
        type: 'wifi-vlan',
        anonymous: false,
        index: 3,
        options: {
          iface: 'default_radio0',
          name: 'g131',
          vid: '131',
          network: 'perch_v131',
        },
        owner: 'groups',
      },
      {
        name: 'perch_ws0',
        type: 'wifi-station',
        anonymous: false,
        index: 4,
        options: {
          iface: 'default_radio0',
          vid: '130',
        },
        secrets: {
          key: 'hmac:580f03cd55bc75df',
        },
        owner: 'groups',
      },
      {
        name: 'perch_ws1',
        type: 'wifi-station',
        anonymous: false,
        index: 5,
        options: {
          iface: 'default_radio0',
          vid: '131',
        },
        secrets: {
          key: 'hmac:b6bac14654ba2dd4',
        },
        owner: 'groups',
      },
      {
        name: 'perch_ws2',
        type: 'wifi-station',
        anonymous: false,
        index: 6,
        options: {
          iface: 'default_radio0',
          vid: '131',
          mac: '02:00:00:00:01:00',
        },
        secrets: {
          key: 'hmac:c7a1f1d5f31d152f',
        },
        owner: 'groups',
      },
    ],
  },
]
