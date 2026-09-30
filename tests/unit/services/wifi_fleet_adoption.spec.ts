import {
  countryForTimeZone,
  planAdoption,
  proposeAdoption,
} from '#services/wifi_config/fleet/adoption'
import { reconcileAp } from '#services/wifi_config/fleet/reconcile'
import { renderAp } from '#services/wifi_config/fleet/render'
import { adopt, adoptionInput, fleetAps } from '#tests/unit/services/fixtures/wifi/fleet'
import { AX23, configsOf, RAX3000M, WRX36 } from '#tests/unit/services/fixtures/wifi/helpers'
import { test } from '@japa/runner'

test.group('wifi fleet | adoption of the live APs', () => {
  test('five proposals, as the design expects (controller.md 5.4)', ({ assert }) => {
    const result = proposeAdoption(adoptionInput(fleetAps()))
    const summary = result.proposals.map((p) => ({
      name: p.name,
      security: p.security,
      bands: p.bands,
      scope: p.apScope,
      binding: p.binding.kind,
      members: p.members.map((m) => `${m.apId}:${m.section}`).sort(),
      warnings: p.warnings,
      exclude: p.exclude,
    }))
    assert.deepEqual(summary, [
      {
        name: '@Example_FreeWifi',
        security: 'open',
        bands: ['2g', '5g'],
        scope: 'selected',
        binding: 'lan',
        members: ['2:wifinet4', '2:wifinet5', '3:wifinet8'],
        warnings: ['open_on_lan'],
        exclude: false,
      },
      {
        name: 'OpenWrt',
        security: 'open',
        bands: ['5g'],
        scope: 'selected',
        binding: 'ap_network',
        members: ['3:wifinet14'],
        warnings: [],
        exclude: true,
      },
      {
        name: 'Scanning IOT',
        security: 'wpa2',
        bands: ['2g'],
        scope: 'selected',
        binding: 'lan',
        members: ['3:wifinet16'],
        warnings: [],
        exclude: false,
      },
      {
        name: 'Scanning...',
        security: 'wpa2',
        bands: ['2g', '5g'],
        scope: 'all',
        binding: 'lan',
        members: [
          '2:default_radio1',
          '2:wifinet2',
          '3:default_radio2',
          '3:wifinet15',
          '4:default_radio0',
          '4:default_radio1',
        ],
        warnings: ['orphans_skipped'],
        exclude: false,
      },
      {
        name: 'The Cave',
        security: 'wpa2',
        bands: ['5g'],
        scope: 'all',
        binding: 'lan',
        members: ['2:default_radio0', '3:wifinet13', '4:wifinet3'],
        warnings: ['orphans_skipped'],
        exclude: false,
      },
    ])
    const free = result.proposals.find((p) => p.name === '@Example_FreeWifi')!
    assert.deepEqual(free.memberships, [
      { apId: 2, included: true, bands: null, radios: null, overrides: {}, radioOverrides: {} },
      {
        apId: 3,
        included: true,
        bands: ['2g'],
        radios: null,
        overrides: {},
        radioOverrides: { radio2: { enabled: false } },
      },
    ])
    assert.isTrue(free.template.enabled)
    assert.deepEqual(result.proposals.find((p) => p.name === 'The Cave')!.choices, [])
    // Keys are never read: the group key is the fingerprint the APs report.
    assert.match(result.proposals.find((p) => p.name === 'The Cave')!.keyFingerprint!, /^hmac:/)
  })

  test('countries per AP, the PH suggestion, skipped interfaces', ({ assert }) => {
    const result = proposeAdoption(adoptionInput(fleetAps()))
    assert.deepEqual(result.countries, [
      { apId: 2, values: ['TW', 'US'], unset: false, suggested: 'PH' },
      { apId: 3, values: ['PH'], unset: true, suggested: 'PH' },
      { apId: 4, values: ['PH', 'TW'], unset: false, suggested: 'PH' },
    ])
    assert.equal(result.suggestedCountry, 'PH')
    const skipped = result.skipped.map((s) => `${s.apId}:${s.section}:${s.reason}`).sort()
    assert.deepEqual(skipped, [
      '2:wifinet3:unmodeled',
      '3:default_radio3:orphan',
      '3:wifinet10:orphan',
      '3:wifinet2:orphan',
      '3:wifinet3:orphan',
      '3:wifinet4:orphan',
      '3:wifinet6:orphan',
      '3:wifinet7:orphan',
      '3:wifinet9:orphan',
    ])
    assert.equal(countryForTimeZone('Europe/Berlin'), 'DE')
    assert.isNull(countryForTimeZone('Mars/Olympus'))
    // No time zone: the most common country among the radios.
    assert.equal(proposeAdoption(adoptionInput(fleetAps(), [], null)).suggestedCountry, 'PH')
  })

  test('zero diff: the adopted fleet renders nothing and reconciles clean', ({ assert }) => {
    const aps = fleetAps({ mode: 'managed' })
    const fleet = adopt(aps)
    assert.lengthOf(fleet.networks, 4, 'OpenWrt suggested out')
    for (const { fleet: ap, rows } of aps) {
      const input = {
        ap,
        rows,
        ...fleet,
        secrets: {},
      }
      const render = renderAp({ ...input, holds: [] })
      assert.deepEqual(render.edits, [], `${ap.name} renders no edit`)
      assert.deepEqual(
        render.issues.filter((i) => i.severity === 'error'),
        [],
        `${ap.name} has no render error`
      )
      assert.isTrue(
        render.slots.every((s) => s.state === 'linked'),
        `${ap.name}: every slot is linked`
      )
      const reconciled = reconcileAp({ ...input, open: [] })
      assert.deepEqual(reconciled.open, [], `${ap.name} has no divergence`)
      assert.deepEqual(reconciled.links.add, [])
      assert.deepEqual(reconciled.newNetworks, [], 'the excluded OpenWrt stays the router’s')
      assert.equal(reconciled.fleetState, 'in_line', ap.name)
    }
  })

  test('a fleet country opens country divergences and renders once they are resolved', ({
    assert,
  }) => {
    const aps = fleetAps({ mode: 'managed', country: { mode: 'fleet', code: 'PH' } })
    const fleet = adopt(aps)
    const found: string[] = []
    for (const { fleet: ap, rows } of aps) {
      const reconciled = reconcileAp({ ap, rows, ...fleet, secrets: {}, open: [] })
      found.push(...reconciled.open.map((d) => `${ap.id}:${d.radio}:${d.apValue}->${d.fleetValue}`))
      // Held while open: nothing written.
      const held = renderAp({ ap, rows, ...fleet, secrets: {}, holds: reconciled.open })
      assert.deepEqual(held.edits, [], ap.name)
    }
    assert.deepEqual(found.sort(), [
      '2:radio0:US->PH',
      '2:radio1:TW->PH',
      '3:radio1:null->PH',
      '4:radio0:TW->PH',
    ])
    // Resolved as "apply the fleet country": the radios get it, nothing else moves.
    const [, ff] = aps
    const render = renderAp({ ap: ff.fleet, rows: ff.rows, ...fleet, secrets: {}, holds: [] })
    assert.deepEqual(
      render.edits.map((e) => e.domain),
      ['wifi_radios']
    )
    const [put] = render.edits[0].edits
    assert.deepEqual(put.op === 'put' ? put.options : null, {
      type: 'mac80211',
      path: 'platform/soc/18000000.wifi+1',
      channel: '36',
      band: '5g',
      htmode: 'HE80',
      cell_density: '0',
      country: 'PH',
    })
  })

  test('minority values: choices, then option divergences where the admin left them', ({
    assert,
  }) => {
    const ax = configsOf(AX23)
    const cave = ax[1].sections.find((s) => s.name === 'wifinet3')!
    cave.options = { ...cave.options, ieee80211r: '1', mobility_domain: '4f57', hidden: '1' }
    const aps = fleetAps({ mode: 'managed', configs: { [AX23.id]: ax } })
    const proposal = proposeAdoption(adoptionInput(aps)).proposals.find(
      (p) => p.name === 'The Cave'
    )!
    assert.deepEqual(proposal.choices, [
      {
        field: 'roaming.ft',
        values: [
          { value: false, apIds: [2, 3] },
          { value: true, apIds: [4] },
        ],
      },
      {
        field: 'roaming.mobilityDomain',
        values: [
          { value: null, apIds: [2, 3] },
          { value: '4f57', apIds: [4] },
        ],
      },
    ])
    // Hidden is overridable: the AP keeps it as an override, no choice.
    assert.deepEqual(proposal.memberships.find((m) => m.apId === 4)!.overrides, { hidden: true })

    const fleet = adopt(aps)
    const garage = aps[2]
    const reconciled = reconcileAp({
      ap: garage.fleet,
      rows: garage.rows,
      ...fleet,
      secrets: {},
      open: [],
    })
    assert.deepEqual(
      reconciled.open.map(
        (d) =>
          `${d.perchId === garage.rows.find((r) => r.name === 'wifinet3')!.perchId}:${d.option}:${d.apValue}`
      ),
      ['true:ieee80211r:1', 'true:mobility_domain:4f57']
    )
    // Settling the choice the other way makes the whole fleet take FT.
    const withFt = adopt(aps, (keys) =>
      keys.map((k) => ({
        key: k.key,
        exclude: k.name === 'OpenWrt',
        ...(k.name === 'The Cave'
          ? { choices: { 'roaming.ft': true, 'roaming.mobilityDomain': '4f57' } }
          : {}),
      }))
    )
    const cave2 = withFt.networks.find((n) => n.name === 'The Cave')!
    assert.deepEqual(cave2.roaming, { ft: true, mobilityDomain: '4f57', rrm: false, btm: false })
    const render = renderAp({
      ap: aps[0].fleet,
      rows: aps[0].rows,
      ...withFt,
      secrets: {},
      holds: [],
    })
    const put = render.edits[0].edits[0]
    assert.deepEqual(put.op === 'put' ? put.options : null, {
      device: 'radio0',
      network: 'lan',
      mode: 'ap',
      ssid: 'The Cave',
      encryption: 'psk2+ccmp',
      ieee80211r: '1',
      mobility_domain: '4f57',
      ft_over_ds: '0',
      ft_psk_generate_local: '1',
    })
  })

  test('the same SSID with two keys: separate proposals, both flagged', ({ assert }) => {
    const ax = configsOf(AX23)
    const cave = ax[1].sections.find((s) => s.name === 'wifinet3')!
    cave.secrets = { key: 'hmac:00000000000000aa' }
    const result = proposeAdoption(adoptionInput(fleetAps({ configs: { [AX23.id]: ax } })))
    const caves = result.proposals.filter((p) => p.ssid === 'The Cave')
    assert.deepEqual(
      caves.map((p) => [
        p.name,
        p.members.length,
        p.apScope,
        p.warnings.includes('ssid_key_mismatch'),
      ]),
      [
        ['The Cave', 2, 'selected', true],
        ['The Cave (2)', 1, 'selected', true],
      ]
    )
    // Merged on request: one network, the key is then unknown ("mixed").
    const input = adoptionInput(fleetAps({ configs: { [AX23.id]: ax } }))
    const plan = planAdoption(input, [{ key: caves[0].key, merge: [caves[1].key] }])
    assert.isTrue(plan.ok)
    if (plan.ok) {
      assert.lengthOf(plan.networks, 1)
      assert.equal(plan.networks[0].spec.apScope, 'all')
      assert.lengthOf(plan.networks[0].links, 3)
    }
    const other = result.proposals.find((p) => p.ssid === 'Scanning...')!
    assert.deepEqual(planAdoption(input, [{ key: caves[0].key, merge: [other.key] }]), {
      ok: false,
      error: 'merge_incompatible',
      key: caves[0].key,
      with: other.key,
    })
    assert.deepEqual(planAdoption(input, [{ key: 'gone' }]), {
      ok: false,
      error: 'adoption_changed',
      keys: ['gone'],
    })
  })

  test('linked interfaces are not proposed again; off APs do not take part', ({ assert }) => {
    const aps = fleetAps()
    const fleet = adopt(aps)
    const again = proposeAdoption(adoptionInput(aps, fleet.links))
    // Linked ones are done; the left-out OpenWrt is excluded (router-only).
    assert.deepEqual(again.proposals, [])
    const off = fleetAps({ mode: 'off' })
    assert.deepEqual(proposeAdoption(adoptionInput(off)).proposals, [])
    // A network on an AP network other than the management one hints its VLAN.
    const rax = configsOf(RAX3000M)
    rax[0].sections.push({
      name: 'iot',
      type: 'interface',
      anonymous: false,
      index: 8,
      options: { proto: 'none', device: 'br-lan.30' },
    })
    const iot = rax[1].sections.find((s) => s.name === 'wifinet16')!
    iot.options = { ...iot.options, network: 'iot' }
    const vlan = proposeAdoption(adoptionInput(fleetAps({ configs: { [RAX3000M.id]: rax } })))
    const p = vlan.proposals.find((x) => x.name === 'Scanning IOT')!
    assert.equal(p.binding.kind, 'ap_network')
    assert.deepEqual(p.memberships[0].overrides, { apNetwork: 'iot' })
    assert.deepEqual(p.hints, ['VLAN 30'])
    assert.equal(WRX36.id, 2)
  })
})
