import { touchesManagementPath } from '#services/gateway_config/apply_plan'
import { contentsEqual } from '#services/gateway_config/canonical'
import {
  applySectionEdits,
  checkRoundTrip,
  syncedFromRouter,
  validateDesired,
  type SyncedSection,
} from '#services/gateway_config/domain'
import type { Issue } from '#services/gateway_config/types'
import {
  AP_VLANS_DOMAIN,
  apVlansDomain,
  planVlanPlumbing,
  trunkOf,
  type NetworkRow,
} from '#services/wifi_config/domains/ap_vlans'
import { apDomains, apRegistry } from '#services/wifi_config/domains/index'
import { channelSet, encryptionKey, keepFlag } from '#services/wifi_config/domains/normalize'
import {
  encryptionFor,
  ifaceFields,
  securityOfEncryption,
  WIFI_IFACES_DOMAIN,
  wifiIfacesDomain,
  type IfaceObject,
} from '#services/wifi_config/domains/wifi_ifaces'
import {
  channelBlock,
  htmodeFor,
  WIFI_RADIOS_DOMAIN,
  wifiRadiosDomain,
  type RadioObject,
} from '#services/wifi_config/domains/wifi_radios'
import {
  ALL_APS,
  AX23,
  configsOf,
  desiredOf,
  importAp,
  LAB_AP,
  LIVE_APS,
  RAX3000M,
  rowNamed,
  unmanagedOf,
  WRX36,
  type FixtureAp,
} from '#tests/unit/services/fixtures/wifi/helpers'
import { test } from '@japa/runner'

function names(
  rows: Array<{ name: string; config: string; scope: string; domain: string | null }>,
  domain: string
) {
  return rows
    .filter((r) => r.scope === 'synced' && r.domain === domain)
    .map((r) => r.name)
    .sort()
}

function sectionsOf(ap: FixtureAp, config: string): SyncedSection[] {
  const c = configsOf(ap).find((x) => x.name === config)!
  return c.sections.map((s, i) => syncedFromRouter(config, s, `rt${i}`))
}

function validate(ap: FixtureAp, rows = importAp(ap).rows, vlans = false): Issue[] {
  return validateDesired(apRegistry(ap.caps, { vlans }), desiredOf(rows), {
    capabilities: ap.caps,
    unmanaged: unmanagedOf(rows),
    managementPath: ap.caps.management ?? null,
  })
}

test.group('wifi domains | claims on the live APs', () => {
  test('WRX36: both radios, five AP interfaces; the mesh interface stays unmodeled', ({
    assert,
  }) => {
    const { rows } = importAp(WRX36)
    assert.deepEqual(names(rows, WIFI_RADIOS_DOMAIN), ['radio0', 'radio1'])
    assert.deepEqual(names(rows, WIFI_IFACES_DOMAIN), [
      'default_radio0',
      'default_radio1',
      'wifinet2',
      'wifinet4',
      'wifinet5',
    ])
    assert.equal(rowNamed(rows, 'wifinet3').scope, 'unmodeled')
    assert.isTrue(rows.filter((r) => r.config === 'network').every((r) => r.scope === 'unmodeled'))
  })

  test('RAX3000M: the stale radio is claimed, interfaces on the missing radio3 are not', ({
    assert,
  }) => {
    const { rows } = importAp(RAX3000M)
    assert.deepEqual(names(rows, WIFI_RADIOS_DOMAIN), ['radio0', 'radio1', 'radio2'])
    assert.deepEqual(names(rows, WIFI_IFACES_DOMAIN), [
      'default_radio2',
      'wifinet13',
      'wifinet14',
      'wifinet15',
      'wifinet16',
      'wifinet8',
    ])
    const orphans = rows
      .filter((r) => r.type === 'wifi-iface' && r.scope === 'unmodeled')
      .map((r) => r.name)
      .sort()
    assert.deepEqual(orphans, [
      'default_radio3',
      'wifinet10',
      'wifinet2',
      'wifinet3',
      'wifinet4',
      'wifinet6',
      'wifinet7',
      'wifinet9',
    ])
    // Router-owned options ride along: the custom ifname is kept on the row.
    assert.equal(rowNamed(rows, 'default_radio2').desired?.options.ifname, 'ff-main')
  })

  test('AX23 and the lab AP; device-groups sections never claimed', ({ assert }) => {
    const ax = importAp(AX23).rows
    assert.deepEqual(names(ax, WIFI_RADIOS_DOMAIN), ['radio0', 'radio1'])
    assert.deepEqual(names(ax, WIFI_IFACES_DOMAIN), [
      'default_radio0',
      'default_radio1',
      'wifinet3',
    ])
    const lab = importAp(LAB_AP).rows
    assert.deepEqual(names(lab, WIFI_IFACES_DOMAIN), ['default_radio0'])
    for (const name of ['perch_ws0', 'perch_ws1', 'perch_ws2', 'perch_wv130_default_radio0']) {
      assert.equal(rowNamed(lab, name).scope, 'unmodeled', name)
    }
    // `dynamic_vlan` (set by the device groups) is the router's option.
    const iface = rowNamed(lab, 'default_radio0')
    assert.notInclude(
      iface.ownership?.kind === 'options' ? iface.ownership.options : [],
      'dynamic_vlan'
    )
  })

  test('every modeled section imports synced: none fails the round trip', ({ assert }) => {
    for (const ap of ALL_APS) {
      for (const vlans of [false, true]) {
        const { rows } = importAp(ap, { vlans })
        const failed = rows.filter((r) => r.issue !== null)
        assert.deepEqual(
          failed.map((r) => `${r.name}:${r.issue}`),
          [],
          `${ap.name} vlans=${vlans}`
        )
        const synced = rows.filter((r) => r.scope === 'synced')
        assert.isAbove(synced.length, 0, ap.name)
        for (const r of synced) assert.deepEqual(r.desired, r.router, `${ap.name} ${r.name}`)
      }
    }
  })

  test('round trip: render(parse(x)) is a no-op for every domain on every AP', ({ assert }) => {
    for (const ap of ALL_APS) {
      const registry = apRegistry(ap.caps, { vlans: true })
      for (const config of ['wireless', 'network']) {
        const all = Object.fromEntries(configsOf(ap).map((c) => [c.name, c]))
        const sections = configsOf(ap).find((c) => c.name === config)!.sections
        for (const domain of registry.list()) {
          const claimed = sections
            .filter((s) => domain.configs.includes(config) && domain.types.includes(s.type))
            .filter((s) => domain.claims({ ...s, config }, all))
            .map((s, i) => syncedFromRouter(config, s, `rt${i}`))
          const report = checkRoundTrip(domain, claimed)
          assert.isTrue(report.ok, `${ap.name} ${domain.key}: ${JSON.stringify(report.failures)}`)
        }
      }
    }
  })

  test('secrets travel as fingerprints; the SSID key fingerprint is shared across APs', ({
    assert,
  }) => {
    const fps = LIVE_APS.flatMap((ap) =>
      importAp(ap)
        .rows.filter((r) => r.type === 'wifi-iface' && r.router?.options.ssid === 'The Cave')
        .filter((r) => r.scope === 'synced')
        .map((r) => r.router?.secrets?.key?.fingerprint)
    )
    assert.lengthOf(fps, 3)
    assert.lengthOf(new Set(fps), 1)
  })
})

test.group('wifi domains | ownership and normalisation', () => {
  test('radios own six options; country not where the AP cannot set it', ({ assert }) => {
    const wrx = rowNamed(importAp(WRX36).rows, 'radio0')
    assert.deepEqual(wrx.ownership, {
      kind: 'options',
      options: ['channel', 'channels', 'htmode', 'txpower', 'country', 'disabled'],
    })
    const lab = rowNamed(importAp(LAB_AP).rows, 'radio0')
    assert.deepEqual(lab.ownership, {
      kind: 'options',
      options: ['channel', 'channels', 'htmode', 'txpower', 'disabled'],
    })
  })

  test('equality follows the normalisers, stored spelling does not', ({ assert }) => {
    const radios = apRegistry(WRX36.caps).rules(WIFI_RADIOS_DOMAIN)
    const ifaces = apRegistry(WRX36.caps).rules(WIFI_IFACES_DOMAIN)
    const dev = (options: Record<string, string | string[]>) => ({ type: 'wifi-device', options })
    const iface = (options: Record<string, string | string[]>) => ({ type: 'wifi-iface', options })
    assert.isTrue(contentsEqual(dev({ channel: 'Auto' }), dev({ channel: 'auto' }), radios))
    assert.isFalse(contentsEqual(dev({ channel: 'auto' }), dev({}), radios), 'absent is not auto')
    assert.isTrue(
      contentsEqual(dev({ channels: '36-48' }), dev({ channels: ['48', '36', '40', '44'] }), radios)
    )
    assert.isTrue(contentsEqual(dev({ htmode: 'he80' }), dev({ htmode: 'HE80' }), radios))
    assert.isTrue(contentsEqual(dev({ disabled: 'true' }), dev({ disabled: '1' }), radios))
    assert.isTrue(contentsEqual(dev({ country: 'ph' }), dev({ country: 'PH' }), radios))
    assert.isTrue(
      contentsEqual(iface({ encryption: 'psk2+ccmp' }), iface({ encryption: 'psk2' }), ifaces)
    )
    assert.isTrue(
      contentsEqual(iface({ encryption: 'psk2+aes' }), iface({ encryption: 'psk2' }), ifaces)
    )
    assert.isFalse(
      contentsEqual(iface({ encryption: 'psk2+tkip+ccmp' }), iface({ encryption: 'psk2' }), ifaces)
    )
    assert.isTrue(contentsEqual(iface({ network: 'lan' }), iface({ network: ['lan'] }), ifaces))
    assert.isTrue(contentsEqual(iface({ hidden: 'on' }), iface({ hidden: '1' }), ifaces))
    assert.isFalse(contentsEqual(iface({ ssid: 'Home' }), iface({ ssid: 'home' }), ifaces))
  })

  test('helpers: channel sets, encryption keys, flags', ({ assert }) => {
    assert.deepEqual(channelSet('36-48 149'), [36, 40, 44, 48, 149])
    assert.deepEqual(channelSet(['1-3'], '2g'), [1, 2, 3])
    assert.deepEqual(channelSet('1-9', '6g'), [1, 5, 9])
    assert.isNull(channelSet('x'))
    assert.equal(encryptionKey('sae-mixed+ccmp'), 'sae-mixed')
    assert.equal(keepFlag('on', true), 'on')
    assert.equal(keepFlag('0', false), '0')
    assert.isNull(keepFlag(undefined, false))
    assert.equal(keepFlag(undefined, false, { offAs: '0' }), '0')
    assert.equal(keepFlag('0', true), '1')
  })

  test('encryption ↔ security (controller.md 5.1)', ({ assert }) => {
    const cases: Array<[string | null, string | null]> = [
      [null, 'open'],
      ['none', 'open'],
      ['owe', 'owe'],
      ['psk2', 'wpa2'],
      ['psk2+ccmp', 'wpa2'],
      ['psk2+tkip+ccmp', 'wpa2'],
      ['sae', 'wpa3'],
      ['sae-mixed+ccmp', 'wpa2_wpa3'],
      ['psk-mixed+ccmp', 'wpa_wpa2'],
      ['psk', null],
      ['psk+ccmp', null],
      ['wpa2', null],
      ['wpa3', null],
      ['wep-open', null],
      ['owe+ccmp', null],
    ]
    for (const [encryption, security] of cases) {
      assert.equal(securityOfEncryption(encryption), security, String(encryption))
    }
    assert.equal(encryptionFor('wpa2', 'psk2+ccmp'), 'psk2+ccmp')
    assert.equal(encryptionFor('wpa3', 'psk2+ccmp'), 'sae')
    assert.equal(encryptionFor('wpa2_wpa3', null), 'sae-mixed')
  })
})

test.group('wifi domains | rendering edits', () => {
  test('radio: only changed fields are respelled; the htmode family is kept', ({ assert }) => {
    const domain = wifiRadiosDomain(AX23.caps)
    const sections = sectionsOf(AX23, 'wireless').filter((s) => s.type === 'wifi-device')
    const [r0, r1] = domain.parse(sections)
    const edit = (obj: RadioObject) => {
      const [put] = domain.render(obj, sections)
      return put.op === 'put' ? put.options : {}
    }
    assert.deepEqual(edit({ ...r1, width: 160 }), { ...r1.options, htmode: 'HE160' })
    assert.deepEqual(edit({ ...r1, channelMode: 'auto', channel: null }), {
      ...r1.options,
      channel: 'auto',
    })
    assert.deepEqual(edit({ ...r1, allowed: [36, 40, 44, 48] }), {
      ...r1.options,
      channels: ['36', '40', '44', '48'],
    })
    assert.deepEqual(edit({ ...r0, txpower: { mode: 'fixed', dbm: 17 } }), {
      ...r0.options,
      txpower: '17',
    })
    assert.deepEqual(edit({ ...r0, enabled: false }), { ...r0.options, disabled: '1' })
    const off = { ...r0, options: { ...r0.options, disabled: '0' } }
    assert.deepEqual(edit({ ...off, enabled: true }), off.options, 'an unchanged "0" stays')
    assert.deepEqual(edit({ ...r0, country: 'PH' }), { ...r0.options, country: 'PH' })
    assert.deepEqual(edit(r0), r0.options)
  })

  test('htmode: the router family unless it cannot express the width', ({ assert }) => {
    const five = { band: '5g' as const, modes: ['HT', 'VHT', 'HE'] }
    assert.equal(htmodeFor('VHT', 80, five), 'VHT80')
    assert.equal(htmodeFor('HT', 80, five), 'HE80')
    assert.equal(htmodeFor('HE', 320, { band: '6g', modes: ['HE', 'EHT'] }), 'EHT320')
    assert.equal(htmodeFor('VHT', 20, { band: '2g', modes: ['HT', 'VHT', 'HE'] }), 'HE20')
    assert.equal(htmodeFor(null, 40, { band: '2g', modes: ['HT'] }), 'HT40')
    assert.deepEqual(channelBlock(100, 80), [100, 104, 108, 112])
    assert.deepEqual(channelBlock(157, 40), [157, 161])
    assert.deepEqual(channelBlock(149, 80), [149, 153, 157, 161])
    assert.deepEqual(channelBlock(165, 80), [165, 169, 173, 177])
    assert.isNull(channelBlock(144, 160))
  })

  test('interface: a security change writes Perch spelling, the rest stays', ({ assert }) => {
    const domain = wifiIfacesDomain(RAX3000M.caps)
    const sections = sectionsOf(RAX3000M, 'wireless')
    const main = domain.parse(sections.filter((s) => s.name === 'default_radio2'))[0]
    const render = (obj: IfaceObject) => domain.render(obj, sections)[0]
    const wpa3 = render({
      ...main,
      security: 'wpa3',
      ft: true,
      mobilityDomain: '0e68',
      ftOverDs: false,
    })
    assert.deepEqual(wpa3.op === 'put' ? wpa3.options : null, {
      ...main.options,
      encryption: 'sae',
      ieee80211r: '1',
      mobility_domain: '0e68',
      ft_over_ds: '0',
    })
    assert.deepEqual(wpa3.op === 'put' ? wpa3.secrets : null, { key: { keep: true } })
    const hidden = render({ ...main, hidden: true, networks: ['lan', 'guest'] })
    assert.deepEqual(hidden.op === 'put' ? hidden.options : null, {
      ...main.options,
      hidden: '1',
      network: ['lan', 'guest'],
    })
    const same = render(main)
    assert.deepEqual(same.op === 'put' ? same.options : null, main.options)
  })

  test('interface: a new section writes every template option under its name', ({ assert }) => {
    const domain = wifiIfacesDomain(AX23.caps)
    const fresh: IfaceObject = {
      ...ifaceFields({}),
      perchId: null,
      section: 'perch_n12_radio1',
      radio: 'radio1',
      ssid: 'Kids',
      security: 'wpa2_wpa3',
      networks: ['lan'],
      key: { ref: 's1', fingerprint: 'hmac:0000000000000001' },
      options: {},
      secretNames: [],
    }
    const [put] = domain.render(fresh, [])
    assert.deepEqual(put, {
      op: 'put',
      perchId: null,
      config: 'wireless',
      type: 'wifi-iface',
      name: 'perch_n12_radio1',
      options: {
        device: 'radio1',
        mode: 'ap',
        ssid: 'Kids',
        encryption: 'sae-mixed',
        network: 'lan',
      },
      secrets: { key: { ref: 's1', fingerprint: 'hmac:0000000000000001' } },
    })
    const after = applySectionEdits([], [put], () => 'q1')
    assert.equal(after[0].name, 'perch_n12_radio1')
  })
})

test.group('wifi domains | validation', () => {
  function codes(issues: Issue[]) {
    return issues.map((i) => `${i.section}:${i.code}:${i.severity}`).sort()
  }

  test('the live configs validate: only the stale radio and the open LAN SSIDs are flagged', ({
    assert,
  }) => {
    assert.deepEqual(codes(validate(WRX36)), [
      'wifinet4:open_on_lan:warning',
      'wifinet5:open_on_lan:warning',
    ])
    assert.deepEqual(codes(validate(RAX3000M)), ['radio0:radio_absent:error'])
    assert.deepEqual(codes(validate(AX23)), [])
    assert.deepEqual(codes(validate(LAB_AP)), [])
  })

  test('radios: channel, width, block, power, country', ({ assert }) => {
    const { rows } = importAp(WRX36)
    const set = (name: string, options: Record<string, string>) => {
      const row = rowNamed(rows, name)
      row.desired = { ...row.desired!, options: { ...row.desired!.options, ...options } }
    }
    set('radio1', { channel: '12', htmode: 'HE80' })
    set('radio0', { channel: '165', htmode: 'HE80', txpower: '33' })
    assert.deepEqual(codes(validate(WRX36, rows)), [
      'radio0:txpower_over_max:warning',
      'radio0:width_channel:error',
      'radio1:invalid_channel:error',
      'radio1:invalid_width:error',
      'wifinet4:open_on_lan:warning',
      'wifinet5:open_on_lan:warning',
    ])
    const lab = importAp(LAB_AP).rows
    const radio = rowNamed(lab, 'radio0')
    radio.desired = { ...radio.desired!, options: { ...radio.desired!.options, country: 'PH' } }
    assert.deepEqual(codes(validate(LAB_AP, lab)), ['radio0:country_not_settable:warning'])
  })

  test('interfaces: features, duplicates, BSS limit, networks, PMF', ({ assert }) => {
    const { rows } = importAp(WRX36)
    const set = (name: string, options: Record<string, string>) => {
      const row = rowNamed(rows, name)
      row.desired = { ...row.desired!, options: { ...row.desired!.options, ...options } }
    }
    set('default_radio0', { encryption: 'owe' })
    set('wifinet2', { ssid: '@Example_FreeWifi', network: 'guest' })
    set('default_radio1', { encryption: 'sae', ieee80211w: '0' })
    const found = codes(validate(WRX36, rows))
    assert.includeMembers(found, [
      'default_radio0:security_unsupported:error',
      'wifinet2:duplicate_ssid_on_radio:error',
      'wifinet5:duplicate_ssid_on_radio:error',
      'wifinet2:network_unknown:error',
      'default_radio1:pmf_required:error',
    ])
    const many = importAp(AX23).rows
    const caps = { ...AX23.caps, radios: AX23.caps.radios!.map((r) => ({ ...r, maxBss: 1 })) }
    const issues = validateDesired(apRegistry(caps), desiredOf(many), { capabilities: caps })
    assert.includeMembers(codes(issues), [
      'default_radio1:too_many_bss:error',
      'wifinet3:too_many_bss:error',
    ])
  })

  test('management path: a backhaul radio is protected, AP interfaces never', ({ assert }) => {
    const registry = apRegistry(WRX36.caps)
    const path = { network: 'lan', device: 'br-lan', radios: ['radio0'] }
    const radio0 = rowNamed(importAp(WRX36).rows, 'radio0')
    const iface = rowNamed(importAp(WRX36).rows, 'default_radio0')
    assert.isTrue(
      touchesManagementPath(
        'wireless',
        'radio0',
        radio0.desired,
        path,
        registry,
        WIFI_RADIOS_DOMAIN
      )
    )
    assert.isFalse(
      touchesManagementPath(
        'wireless',
        'radio1',
        radio0.desired,
        path,
        registry,
        WIFI_RADIOS_DOMAIN
      )
    )
    assert.isFalse(
      touchesManagementPath(
        'wireless',
        'default_radio0',
        iface.desired,
        path,
        registry,
        WIFI_IFACES_DOMAIN
      )
    )
  })
})

test.group('wifi domains | ap_vlans (phase 3)', () => {
  function networkRows(ap: FixtureAp): NetworkRow[] {
    const { rows } = importAp(ap, { vlans: true })
    return rows
      .filter((r) => r.config === 'network')
      .map((r) => ({
        perchId: r.perchId,
        name: r.name,
        type: (r.desired ?? r.router)!.type,
        options: { ...(r.desired ?? r.router)!.options },
        domain: r.scope === 'synced' ? r.domain : null,
        groups: /^perch_(v|bv|dv|bd)\d+$/.test(r.name),
      }))
  }

  test('claims the trunk bridge’s VLANs and interfaces, never the device groups’', ({ assert }) => {
    assert.deepEqual(names(importAp(AX23, { vlans: true }).rows, AP_VLANS_DOMAIN), [
      'cfg040f15',
      'lan',
    ])
    assert.deepEqual(names(importAp(WRX36, { vlans: true }).rows, AP_VLANS_DOMAIN), ['lan', 'lan6'])
    assert.deepEqual(names(importAp(LAB_AP, { vlans: true }).rows, AP_VLANS_DOMAIN), [
      'cfg040f15',
      'cfg050f15',
      'lan',
      'onboard',
    ])
    const lan = rowNamed(importAp(AX23, { vlans: true }).rows, 'lan', 'network')
    assert.deepEqual(lan.ownership, { kind: 'options', options: ['device'] })
    assert.lengthOf(apDomains(AX23.caps), 2, 'not registered before phase 3')
  })

  test('an untagged bridge is converted before the first VLAN (WRX36)', ({ assert }) => {
    const plan = planVlanPlumbing({
      vids: [30],
      rows: networkRows(WRX36),
      trunk: trunkOf(WRX36.caps),
    })
    assert.isTrue(plan.converts)
    assert.deepEqual(plan.issues, [])
    assert.deepEqual(plan.networkFor, { 30: 'perch_nv30' })
    const puts = plan.edits.map((e) => (e.op === 'put' ? [e.name ?? e.perchId, e.options] : null))
    assert.deepEqual(puts, [
      [
        'perch_nbvu',
        { device: 'br-lan', vlan: '1', ports: ['lan2:u*', 'lan3:u*', 'lan4:u*', 'wan:u*'] },
      ],
      [
        rowNamed(importAp(WRX36, { vlans: true }).rows, 'lan', 'network').perchId,
        {
          device: 'br-lan.1',
          proto: 'static',
          ipaddr: '192.168.1.16',
          netmask: '255.255.128.0',
          ip6assign: '60',
          gateway: '192.168.0.1',
          dns: '192.168.0.1',
          dns_search: 'lan',
        },
      ],
      [
        rowNamed(importAp(WRX36, { vlans: true }).rows, 'lan6', 'network').perchId,
        { proto: 'none', device: 'br-lan.1' },
      ],
      ['perch_nbv30', { device: 'br-lan', vlan: '30', ports: ['wan:t'] }],
      ['perch_nv30', { proto: 'none', device: 'br-lan.30' }],
    ])
    // The conversion and the uplink interface are the core's management path.
    const path = { network: 'lan', device: 'br-lan' }
    assert.isTrue(
      touchesManagementPath(
        'network',
        'perch_nbvu',
        {
          type: 'bridge-vlan',
          options: { device: 'br-lan', vlan: '1' },
        },
        path
      )
    )
  })

  test('a VLAN-filtering bridge gets its VLAN; a router VLAN is reused (AX23, lab)', ({
    assert,
  }) => {
    const ax = planVlanPlumbing({ vids: [30], rows: networkRows(AX23), trunk: trunkOf(AX23.caps) })
    assert.isFalse(ax.converts)
    assert.deepEqual(
      ax.edits.map((e) => (e.op === 'put' ? e.name : e.op)),
      ['perch_nbv30', 'perch_nv30']
    )
    const lab = planVlanPlumbing({
      vids: [132],
      rows: networkRows(LAB_AP),
      trunk: trunkOf(LAB_AP.caps),
    })
    assert.deepEqual(lab.edits, [])
    assert.deepEqual(lab.networkFor, { 132: 'onboard' })
    const groups = planVlanPlumbing({
      vids: [130],
      rows: networkRows(LAB_AP),
      trunk: trunkOf(LAB_AP.caps),
    })
    assert.deepEqual(
      groups.issues.map((i) => i.code),
      ['vlan_in_use']
    )
    const unknown = planVlanPlumbing({
      vids: [30],
      rows: networkRows(AX23),
      trunk: { bridge: null, port: null, vlanFiltering: false },
    })
    assert.deepEqual(
      unknown.issues.map((i) => i.code),
      ['trunk_unknown']
    )
  })

  test('Perch VLAN sections of a VID no longer needed are removed', ({ assert }) => {
    const rows: NetworkRow[] = [
      ...networkRows(AX23),
      {
        perchId: 'v1',
        name: 'perch_nbv30',
        type: 'bridge-vlan',
        options: { device: 'br-lan', vlan: '30', ports: ['wan:t'] },
        domain: AP_VLANS_DOMAIN,
      },
      {
        perchId: 'v2',
        name: 'perch_nv30',
        type: 'interface',
        options: { proto: 'none', device: 'br-lan.30' },
        domain: AP_VLANS_DOMAIN,
      },
    ]
    const plan = planVlanPlumbing({ vids: [], rows, trunk: trunkOf(AX23.caps) })
    assert.deepEqual(plan.edits, [
      { op: 'delete', perchId: 'v1' },
      { op: 'delete', perchId: 'v2' },
    ])
    const kept = planVlanPlumbing({ vids: [30], rows, trunk: trunkOf(AX23.caps) })
    assert.deepEqual(kept.edits, [], 'already in place: nothing to write')
  })

  test('validation: a Perch VLAN the bridge already carries', ({ assert }) => {
    const domain = apVlansDomain(LAB_AP.caps)
    const ours: SyncedSection = {
      perchId: 'v1',
      config: 'network',
      name: 'perch_nbv132',
      type: 'bridge-vlan',
      anonymous: false,
      options: { device: 'br-lan', vlan: '132', ports: ['lan0:t'] },
    }
    const theirs = sectionsOf(LAB_AP, 'network')
    const issues = domain.validate([ours], {
      capabilities: LAB_AP.caps,
      all: [ours],
      unmanaged: theirs,
    })
    assert.deepEqual(
      issues.map((i) => i.code),
      ['vlan_in_use']
    )
  })
})
