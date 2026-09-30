import type { ApCapabilities, ApChannel, ApRadioCaps } from '#services/wifi_config/types'

/**
 * `wifi.capabilities` of the fixture APs (protocol.md 3.1), built from what
 * the devices report: radio presence from `network.wireless status` (the
 * RAX3000M's radio0 is stale: `up: false, retry_setup_failed: true`),
 * hostapd features from `hostapd -v<feature>` (the WRX36's
 * wpad-mesh-openssl has no OWE; wpad-basic-mbedtls has no EAP), the
 * regulatory state (the WRX36's ath11k manages its own regdomain, the lab
 * AP is an unprivileged container that cannot set a country). Channel lists
 * are a plausible FCC-style plan: 2.4 GHz 1–13 (12–13 disabled under US),
 * 5 GHz 36–64, 100–144 (52–144 DFS, 60 s radar check) and 149–165.
 */

function channels2g(country: string): ApChannel[] {
  return Array.from({ length: 13 }, (_, i) => {
    const channel = i + 1
    return {
      channel,
      mhz: 2407 + channel * 5,
      maxDbm: 20,
      dfs: false,
      noIr: false,
      disabled: country === 'US' && channel > 11,
    }
  })
}

function channels5g(maxDbm: number): ApChannel[] {
  const numbers = [
    36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149,
    153, 157, 161, 165,
  ]
  return numbers.map((channel) => {
    const dfs = channel >= 52 && channel <= 144
    return {
      channel,
      mhz: 5000 + channel * 5,
      maxDbm,
      dfs,
      noIr: false,
      disabled: false,
      ...(dfs ? { cacSeconds: 60 } : {}),
    }
  })
}

function radio(
  partial: Partial<ApRadioCaps> & { section: string; band: ApRadioCaps['band'] }
): ApRadioCaps {
  const is5 = partial.band === '5g'
  return {
    phy: null,
    path: null,
    present: true,
    up: true,
    retrySetupFailed: false,
    country: null,
    txpowerMaxDbm: is5 ? 23 : 20,
    maxBss: 16,
    widths: is5 ? [20, 40, 80, 160] : [20, 40],
    modes: is5 ? ['HT', 'VHT', 'HE'] : ['HT', 'HE'],
    channels: is5 ? channels5g(23) : channels2g('PH'),
    current: null,
    ...partial,
  }
}

const MBEDTLS = {
  '11r': true,
  'sae': true,
  'owe': true,
  'eap': false,
  'wps': false,
  'mesh': false,
  '11ac': true,
  '11ax': true,
  '11be': true,
  'acs': true,
  'ocv': true,
}

export const WRX36_CAPS: ApCapabilities = {
  protocol: 1,
  access: 'read',
  allowedConfigs: ['wireless', 'network'],
  transportOk: true,
  allowInsecure: false,
  confirmMaxSeconds: 900,
  guard: 'self_installed',
  openwrt: { release: '24.10-SNAPSHOT', target: 'qualcommax/ipq807x', board: 'dynalink,dl-wrx36' },
  packageManager: 'opkg',
  wifiScripts: 'ucode',
  schema: false,
  hostapd: {
    variant: 'wpad-mesh-openssl',
    ubus: true,
    features: { ...MBEDTLS, 'owe': false, 'eap': true, 'wps': true, 'mesh': true, '11be': false },
  },
  regulatory: { global: 'US', settable: true, reason: null, selfManaged: ['phy0', 'phy1'] },
  radios: [
    radio({
      section: 'radio0',
      phy: 'phy0',
      path: 'platform/soc@0/c000000.wifi',
      band: '5g',
      country: 'US',
      txpowerMaxDbm: 30,
      maxBss: 8,
      channels: channels5g(30),
      current: { channel: 149, htmode: 'HE80', txpowerDbm: 30 },
    }),
    radio({
      section: 'radio1',
      phy: 'phy1',
      path: 'platform/soc@0/c000000.wifi+1',
      band: '2g',
      country: 'US',
      maxBss: 8,
      channels: channels2g('US'),
      current: { channel: 1, htmode: 'HE20', txpowerDbm: 20 },
    }),
  ],
  trunk: { port: 'wan', bridge: 'br-lan', vlanFiltering: false, source: 'auto' },
  networks: [
    { name: 'lan', device: 'br-lan', proto: 'static', up: true },
    { name: 'lan6', device: 'br-lan', proto: 'none', up: true },
    { name: 'wan', device: 'lan1', proto: 'dhcp', up: false },
  ],
  management: { network: 'lan', device: 'br-lan', radios: [] },
  uncommitted: [],
  luciPending: false,
  apply: { state: 'idle' },
  groups: { engine: true, enabled: false, state: 'idle', handedOver: false },
}

export const RAX3000M_CAPS: ApCapabilities = {
  protocol: 1,
  access: 'read',
  allowedConfigs: ['wireless', 'network'],
  transportOk: true,
  allowInsecure: false,
  confirmMaxSeconds: 900,
  guard: 'self_installed',
  openwrt: { release: '24.10.0-rc4', target: 'mediatek/filogic', board: 'cmcc,rax3000m' },
  packageManager: 'opkg',
  wifiScripts: 'ucode',
  schema: false,
  hostapd: { variant: 'wpad-basic-mbedtls', ubus: true, features: { ...MBEDTLS } },
  regulatory: { global: 'PH', settable: true, reason: null, selfManaged: [] },
  radios: [
    // The stale section of the old path: no hardware behind it.
    radio({
      section: 'radio0',
      path: 'platform/18000000.wifi',
      band: '2g',
      present: false,
      up: false,
      retrySetupFailed: true,
      widths: [],
      modes: [],
      channels: [],
    }),
    radio({
      section: 'radio1',
      phy: 'phy1',
      path: 'platform/soc/18000000.wifi+1',
      band: '5g',
      current: { channel: 36, htmode: 'HE80', txpowerDbm: 23 },
    }),
    radio({
      section: 'radio2',
      phy: 'phy0',
      path: 'platform/soc/18000000.wifi',
      band: '2g',
      country: 'PH',
      current: { channel: 13, htmode: 'HE20', txpowerDbm: 20 },
    }),
  ],
  trunk: { port: 'lan1', bridge: 'br-lan', vlanFiltering: true, source: 'auto' },
  networks: [
    { name: 'lan', device: 'br-lan.1', proto: 'static', up: true },
    { name: 'neth', device: '@lan', proto: 'dhcpv6', up: true },
    { name: 'wan', device: 'eth1', proto: 'dhcp', up: false },
    { name: 'wan6', device: 'eth1', proto: 'dhcpv6', up: false },
  ],
  management: { network: 'lan', device: 'br-lan.1', radios: [] },
  uncommitted: [],
  luciPending: false,
  apply: { state: 'idle' },
  groups: { engine: true, enabled: false, state: 'idle', handedOver: false },
}

export const AX23_CAPS: ApCapabilities = {
  protocol: 1,
  access: 'read',
  allowedConfigs: ['wireless', 'network'],
  transportOk: true,
  allowInsecure: false,
  confirmMaxSeconds: 900,
  guard: 'self_installed',
  openwrt: { release: '25.12.4', target: 'ramips/mt7621', board: 'tplink,archer-ax23-v1' },
  packageManager: 'apk',
  wifiScripts: 'ucode',
  schema: true,
  hostapd: { variant: 'wpad-basic-mbedtls', ubus: true, features: { ...MBEDTLS } },
  regulatory: { global: 'PH', settable: true, reason: null, selfManaged: [] },
  radios: [
    radio({
      section: 'radio0',
      phy: 'phy0',
      path: '1e140000.pcie/pci0000:00/0000:00:01.0/0000:02:00.0',
      band: '2g',
      country: 'TW',
      current: { channel: 6, htmode: 'HE20', txpowerDbm: 20 },
    }),
    radio({
      section: 'radio1',
      phy: 'phy1',
      path: '1e140000.pcie/pci0000:00/0000:00:01.0/0000:02:00.0+1',
      band: '5g',
      country: 'PH',
      current: { channel: 100, htmode: 'HE80', txpowerDbm: 23 },
    }),
  ],
  trunk: { port: 'wan', bridge: 'br-lan', vlanFiltering: true, source: 'auto' },
  networks: [{ name: 'lan', device: 'br-lan.1', proto: 'static', up: true }],
  management: { network: 'lan', device: 'br-lan.1', radios: [] },
  uncommitted: [],
  luciPending: false,
  apply: { state: 'idle' },
  groups: { engine: true, enabled: false, state: 'idle', handedOver: false },
}

export const LAB_AP_CAPS: ApCapabilities = {
  protocol: 1,
  access: 'write',
  allowedConfigs: ['wireless', 'network'],
  transportOk: false,
  allowInsecure: true,
  confirmMaxSeconds: 900,
  guard: 'installed',
  openwrt: { release: '24.10.2', target: 'x86/64' },
  packageManager: 'opkg',
  wifiScripts: 'ucode',
  schema: false,
  hostapd: { variant: 'wpad-basic-mbedtls', ubus: true, features: { ...MBEDTLS } },
  regulatory: { global: '00', settable: false, reason: 'user_namespace', selfManaged: [] },
  radios: [
    radio({
      section: 'radio0',
      phy: 'phy0',
      path: 'virtual/mac80211_hwsim/hwsim0',
      band: '2g',
      widths: [20, 40],
      modes: ['HT'],
      current: { channel: 6, htmode: 'HT20', txpowerDbm: 20 },
    }),
  ],
  trunk: { port: 'lan0', bridge: 'br-lan', vlanFiltering: true, source: 'auto' },
  networks: [
    { name: 'lan', device: 'br-lan.1', proto: 'dhcp', up: true },
    { name: 'onboard', device: 'br-lan.132', proto: 'none', up: true },
  ],
  management: { network: 'lan', device: 'br-lan.1', radios: [] },
  uncommitted: [],
  luciPending: false,
  apply: { state: 'idle' },
  groups: { engine: true, enabled: true, state: 'idle', handedOver: false, appliedRevision: 3 },
}
