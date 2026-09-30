import { planApply, planSectionEdits } from '#services/gateway_config/apply_plan'
import type { SectionEdit } from '#services/gateway_config/domain'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { ConfigDiffEntry } from '#services/gateway_config/types'
import { apRegistry } from '#services/wifi_config/domains/index'
import { WIFI_IFACES_DOMAIN } from '#services/wifi_config/domains/wifi_ifaces'
import { cacFor, impactForAp, previewImpact } from '#services/wifi_config/fleet/impact'
import {
  carries,
  mobilityDomainFor,
  slotRadios,
  slotSectionName,
} from '#services/wifi_config/fleet/model'
import { fleetStateOf, reconcileAp } from '#services/wifi_config/fleet/reconcile'
import { renderAp, type RenderInput } from '#services/wifi_config/fleet/render'
import {
  expectedKeyFingerprints,
  passphraseDigest,
  passphraseError,
  passphraseMatches,
  pmfError,
  supportsSecurity,
} from '#services/wifi_config/fleet/security'
import { WIFI_CONFIG_DEFAULTS } from '#services/wifi_config/settings'
import type { OpenDivergence, WifiNetworkSpec } from '#services/wifi_config/types'
import { adopt, fleetAps } from '#tests/unit/services/fixtures/wifi/fleet'
import {
  AX23,
  configsOf,
  importAp,
  rowNamed,
  RAX3000M,
  WRX36,
} from '#tests/unit/services/fixtures/wifi/helpers'
import { test } from '@japa/runner'

const KEY_FP = 'hmac:1111111111111111'

function network(
  partial: Partial<WifiNetworkSpec> & { id: number; ssid: string }
): WifiNetworkSpec {
  return {
    name: partial.ssid,
    enabled: true,
    security: 'wpa2',
    passphraseRef: null,
    hidden: false,
    isolate: false,
    binding: { kind: 'lan' },
    bands: ['2g', '5g'],
    apScope: 'all',
    roaming: { ft: false, mobilityDomain: null, rrm: false, btm: false },
    advanced: { pmf: 'default', multicastToUnicast: null, maxClients: null, dtimPeriod: null },
    groups: false,
    origin: 'perch',
    revision: 1,
    ...partial,
  }
}

function puts(edits: SectionEdit[]) {
  return edits.map((e) =>
    e.op === 'put'
      ? { perchId: e.perchId, name: e.name ?? null, options: e.options, secrets: e.secrets ?? null }
      : e
  )
}

/** The adopted live fleet, managed (the zero-diff starting point). */
function adopted() {
  const aps = fleetAps({ mode: 'managed' })
  const fleet = adopt(aps)
  const inputOf = (i: number, extra: Partial<RenderInput> = {}): RenderInput => ({
    ap: aps[i].fleet,
    rows: aps[i].rows,
    ...fleet,
    secrets: {},
    holds: [],
    ...extra,
  })
  return { aps, fleet, inputOf }
}

test.group('wifi fleet | model and security helpers', () => {
  test('scope, slots, names, mobility domain', ({ assert }) => {
    assert.isTrue(carries({ apScope: 'all' }, null))
    assert.isFalse(carries({ apScope: 'all' }, { included: false }))
    assert.isFalse(carries({ apScope: 'selected' }, null))
    assert.isTrue(carries({ apScope: 'selected' }, { included: true }))
    const rax = slotRadios({ id: 1, bands: ['2g', '5g'] }, null, RAX3000M.caps)
    assert.deepEqual(
      rax.radios.map((r) => r.section),
      ['radio1', 'radio2'],
      'never the stale radio0'
    )
    const only = slotRadios(
      { id: 1, bands: ['2g'] },
      { radios: ['radio0'], bands: null },
      RAX3000M.caps
    )
    assert.deepEqual(
      only.issues.map((i) => i.code),
      ['radio_unknown']
    )
    assert.equal(slotSectionName(12, 'radio1'), 'perch_n12_radio1')
    assert.equal(mobilityDomainFor(12), '0e68')
  })

  test('securities, passphrases, fingerprints', ({ assert }) => {
    assert.isFalse(supportsSecurity(WRX36.caps, 'owe'))
    assert.isTrue(supportsSecurity(WRX36.caps, 'wpa3'))
    assert.isTrue(supportsSecurity(AX23.caps, 'owe'))
    assert.isNull(supportsSecurity(null, 'wpa3'))
    assert.isNull(passphraseError('correct horse battery'))
    assert.isNull(passphraseError('a'.repeat(64)))
    assert.equal(passphraseError('short'), 'passphrase_invalid')
    assert.equal(passphraseError('x'.repeat(64)), 'passphrase_invalid')
    assert.equal(passphraseError('tab\tinside'), 'passphrase_invalid')
    assert.equal(pmfError('wpa3', 'disabled'), 'pmf_required')
    assert.isNull(pmfError('wpa2_wpa3', 'optional'))
    assert.equal(passphraseDigest('correct horse battery').length, 64)
    assert.deepEqual(
      passphraseMatches(KEY_FP, [
        { apId: 2, radio: 'radio0', fingerprint: KEY_FP },
        { apId: 4, radio: 'radio1', fingerprint: 'hmac:2222222222222222' },
      ]),
      {
        all: false,
        matches: [
          { apId: 2, radio: 'radio0', match: true },
          { apId: 4, radio: 'radio1', match: false },
        ],
      }
    )
    const nets = [
      { id: 1, passphraseRef: 's1', security: 'wpa2' as const },
      { id: 2, passphraseRef: null, security: 'wpa2' as const },
      { id: 3, passphraseRef: null, security: 'wpa2' as const },
      { id: 4, passphraseRef: null, security: 'open' as const },
    ]
    const slots = [
      { networkId: 2, fingerprint: 'hmac:a' },
      { networkId: 2, fingerprint: 'hmac:a' },
      { networkId: 2, fingerprint: 'hmac:b' },
      { networkId: 3, fingerprint: 'hmac:a' },
      { networkId: 3, fingerprint: 'hmac:b' },
    ]
    assert.deepEqual(expectedKeyFingerprints(nets, { s1: { fingerprint: KEY_FP } }, slots), {
      1: KEY_FP,
      2: 'hmac:a',
      3: null,
      4: null,
    })
  })
})

test.group('wifi fleet | render', () => {
  test('a new network lands on every AP’s radios of its band, through editSections', ({
    assert,
  }) => {
    const { aps, fleet, inputOf } = adopted()
    const kids = network({
      id: 10,
      ssid: 'Kids',
      security: 'wpa2_wpa3',
      passphraseRef: 's1',
      bands: ['5g'],
    })
    const expected = { 0: 'radio0', 1: 'radio1', 2: 'radio1' } as Record<number, string>
    for (const i of [0, 1, 2]) {
      const input = inputOf(i, {
        networks: [...fleet.networks, kids],
        secrets: { s1: { fingerprint: KEY_FP } },
      })
      const render = renderAp(input)
      assert.deepEqual(
        render.edits.map((e) => e.domain),
        [WIFI_IFACES_DOMAIN]
      )
      const radio = expected[i]
      assert.deepEqual(puts(render.edits[0].edits), [
        {
          perchId: null,
          name: `perch_n10_${radio}`,
          options: {
            device: radio,
            mode: 'ap',
            ssid: 'Kids',
            encryption: 'sae-mixed',
            network: 'lan',
          },
          secrets: { key: { ref: 's1', fingerprint: KEY_FP } },
        },
      ])
      // Through the core's editSections path: a new synced row, ahead.
      let n = 0
      const out = planSectionEdits({
        rows: aps[i].rows,
        edits: render.edits[0].edits,
        domain: WIFI_IFACES_DOMAIN,
        registry: apRegistry(aps[i].fleet.caps),
        authoritative: false,
        newPerchId: () => `new${++n}`,
      })
      assert.lengthOf(out.upserts, 1)
      assert.equal(out.upserts[0].name, `perch_n10_${radio}`)
      assert.equal(out.upserts[0].status, 'ahead')
      const plan = planApply({
        sections: [...aps[i].rows, ...out.upserts],
        kind: 'apply',
        ledger: [],
        hashes: { wireless: 'w', network: 'n' },
        management: { network: 'lan', device: 'br-lan.1' },
        registry: apRegistry(aps[i].fleet.caps),
        orders: [],
      })
      const job = plan.jobs.find((j) => j.kind === 'apply')!
      assert.deepEqual(job.secretRefs, ['s1'])
    }
  })

  test('features, passphrases and the LAN decide whether a slot can be rendered', ({ assert }) => {
    const { fleet, inputOf } = adopted()
    const guest = network({ id: 11, ssid: 'Guest', security: 'owe', bands: ['2g'] })
    const wrx = renderAp(inputOf(0, { networks: [...fleet.networks, guest] }))
    assert.deepEqual(
      wrx.issues.map((i) => `${i.code}:${i.severity}`),
      ['security_unsupported:warning'],
      'WRX36 has no OWE'
    )
    assert.deepEqual(wrx.edits, [])
    const ff = renderAp(inputOf(1, { networks: [...fleet.networks, guest] }))
    assert.equal(ff.slots.find((s) => s.networkId === 11)?.state, 'create')
    const nokey = network({ id: 12, ssid: 'Secret', bands: ['5g'] })
    const blocked = renderAp(inputOf(2, { networks: [...fleet.networks, nokey] }))
    assert.deepEqual(
      blocked.issues.map((i) => i.code),
      ['passphrase_unknown']
    )
    assert.deepEqual(blocked.edits, [])
    const noLan = renderAp(
      inputOf(2, {
        ap: { ...inputOf(2).ap, management: { network: null } },
        networks: [...fleet.networks, guest],
      })
    )
    assert.includeMembers(
      noLan.issues.map((i) => i.code),
      ['lan_unknown']
    )
  })

  test('a template edit reaches every slot; an option hold keeps the AP’s value', ({ assert }) => {
    const { fleet, inputOf, aps } = adopted()
    const networks = fleet.networks.map((n) =>
      n.ssid === 'The Cave' ? { ...n, ssid: 'The Cave 2', hidden: true } : n
    )
    const render = renderAp(inputOf(0, { networks }))
    assert.deepEqual(puts(render.edits[0].edits), [
      {
        perchId: rowNamed(aps[0].rows, 'default_radio0').perchId,
        name: null,
        options: {
          device: 'radio0',
          network: 'lan',
          mode: 'ap',
          ssid: 'The Cave 2',
          encryption: 'psk2+ccmp',
          hidden: '1',
        },
        secrets: { key: { keep: true } },
      },
    ])
    const hold: OpenDivergence = {
      id: 7,
      apId: WRX36.id,
      networkId: 1,
      perchId: rowNamed(aps[0].rows, 'default_radio0').perchId,
      radio: 'radio0',
      kind: 'option',
      option: 'hidden',
      fleetValue: '1',
      apValue: null,
      routerAuthor: null,
    }
    const held = renderAp(inputOf(0, { networks, holds: [hold] }))
    const put = held.edits[0].edits[0]
    assert.notProperty(put.op === 'put' ? put.options : {}, 'hidden')
    assert.equal(put.op === 'put' ? put.options.ssid : null, 'The Cave 2')
  })

  test('scope: a slot no longer carried is deleted, unless an `added` hold keeps it', ({
    assert,
  }) => {
    const { fleet, inputOf, aps } = adopted()
    const cave = fleet.networks.find((n) => n.ssid === 'The Cave')!
    const memberships = fleet.memberships.map((m) =>
      m.networkId === cave.id && m.apId === AX23.id ? { ...m, included: false } : m
    )
    const perchId = rowNamed(aps[2].rows, 'wifinet3').perchId
    const render = renderAp(inputOf(2, { memberships }))
    assert.deepEqual(render.edits[0].edits, [{ op: 'delete', perchId }])
    const hold: OpenDivergence = {
      id: 3,
      apId: AX23.id,
      networkId: cave.id,
      perchId,
      radio: 'radio1',
      kind: 'added',
      option: null,
      fleetValue: null,
      apValue: null,
      routerAuthor: null,
    }
    assert.deepEqual(renderAp(inputOf(2, { memberships, holds: [hold] })).edits, [])
  })

  test('a typed passphrase that matches: refs recorded, nothing to apply', ({ assert }) => {
    const { fleet, inputOf, aps } = adopted()
    const fp = rowNamed(aps[2].rows, 'wifinet3').desired!.secrets!.key.fingerprint
    const networks = fleet.networks.map((n) =>
      n.ssid === 'The Cave' ? { ...n, passphraseRef: 's9' } : n
    )
    const render = renderAp(inputOf(2, { networks, secrets: { s9: { fingerprint: fp } } }))
    const edits = render.edits[0].edits
    assert.lengthOf(edits, 1)
    const out = planSectionEdits({
      rows: aps[2].rows,
      edits,
      domain: WIFI_IFACES_DOMAIN,
      registry: apRegistry(AX23.caps),
      authoritative: false,
      newPerchId: () => 'x',
    })
    assert.equal(out.upserts[0].desired?.secrets?.key.ref, 's9')
    assert.equal(out.upserts[0].status, 'in_sync', 'same fingerprint: nothing to apply')
    const rows = aps[2].rows.map((r) => out.upserts.find((u) => u.perchId === r.perchId) ?? r)
    const plan = planApply({
      sections: rows,
      kind: 'apply',
      ledger: rows
        .filter((r) => r.scope === 'synced')
        .map((r) => ({ perchId: r.perchId, config: r.config, section: r.name, domain: r.domain! })),
      hashes: { wireless: 'w', network: 'n' },
      management: null,
      registry: apRegistry(AX23.caps),
      orders: [],
    })
    assert.deepEqual(plan.jobs, [])
  })

  test('a slot whose section the AP deleted is not re-created until reconcile decides', ({
    assert,
  }) => {
    const { inputOf, aps } = adopted()
    const gone = rowNamed(aps[0].rows, 'default_radio0')
    const rows = aps[0].rows.filter((r) => r !== gone)
    const render = renderAp(inputOf(0, { rows }))
    assert.deepEqual(render.edits, [])
    assert.equal(render.slots.find((s) => s.perchId === gone.perchId)?.state, 'missing')
    const reconciled = reconcileAp({ ...inputOf(0, { rows }), open: [] })
    assert.deepEqual(
      reconciled.open.map((d) => [d.kind, d.perchId]),
      [['removed', gone.perchId]]
    )
  })

  test('fingerprint: stable, moved by a network edit, not by section contents', ({ assert }) => {
    const { fleet, inputOf, aps } = adopted()
    const a = renderAp(inputOf(1)).fingerprint
    assert.equal(renderAp(inputOf(1)).fingerprint, a)
    const edited = fleet.networks.map((n, i) => (i === 0 ? { ...n, hidden: !n.hidden } : n))
    assert.notEqual(renderAp(inputOf(1, { networks: edited })).fingerprint, a)
    const rows = aps[1].rows.map((r) =>
      r.name === 'wifinet13'
        ? { ...r, desired: { ...r.desired!, options: { ...r.desired!.options, hidden: '1' } } }
        : r
    )
    assert.equal(renderAp(inputOf(1, { rows })).fingerprint, a)
  })

  test('VLAN binding (phase 3): the plumbing first, then the SSID on it', ({ assert }) => {
    const aps = fleetAps({ mode: 'managed', aps: [AX23] })
    const guest = network({
      id: 20,
      ssid: 'Guest',
      security: 'open',
      bands: ['2g'],
      binding: { kind: 'vlan', vlanId: 30, gatewayId: 1, networkPerchId: null },
    })
    const rows = fleetAps({ mode: 'managed', aps: [AX23] })[0].rows
    // Rows as a registry with ap_vlans claims them.
    const vlanRows = importAp(AX23, { vlans: true }).rows
    const base: RenderInput = {
      ap: aps[0].fleet,
      rows: vlanRows,
      networks: [guest],
      memberships: [],
      links: [],
      holds: [],
      secrets: {},
      vlans: true,
    }
    const render = renderAp(base)
    assert.deepEqual(
      render.edits.map((e) => e.domain),
      ['ap_vlans', WIFI_IFACES_DOMAIN]
    )
    assert.deepEqual(
      render.edits[0].edits.map((e) => (e.op === 'put' ? e.name : e.op)),
      ['perch_nbv30', 'perch_nv30']
    )
    const iface = render.edits[1].edits[0]
    assert.equal(iface.op === 'put' ? iface.options.network : null, 'perch_nv30')
    const without = renderAp({ ...base, rows, vlans: false })
    assert.deepEqual(without.edits, [])
    assert.deepEqual(
      without.issues.map((i) => i.code),
      ['vlan_unsupported']
    )
  })
})

test.group('wifi fleet | reconcile', () => {
  function withOption(rows: SectionState[], name: string, options: Record<string, string>) {
    return rows.map((r) =>
      r.name === name && r.config === 'wireless'
        ? { ...r, desired: { ...r.desired!, options: { ...r.desired!.options, ...options } } }
        : r
    )
  }

  test('a LuCI edit on one AP is a divergence; it closes when the AP comes back', ({ assert }) => {
    const { inputOf, aps } = adopted()
    const perchId = rowNamed(aps[0].rows, 'default_radio0').perchId
    const rows = withOption(aps[0].rows, 'default_radio0', { hidden: '1' })
    const author = { kind: 'luci' as const, user: 'root', via: 'trigger' as const }
    const first = reconcileAp({ ...inputOf(0, { rows }), open: [], authors: { [perchId]: author } })
    assert.deepEqual(first.open, [
      {
        id: null,
        apId: WRX36.id,
        networkId: first.open[0].networkId,
        perchId,
        radio: 'radio0',
        kind: 'option',
        option: 'hidden',
        fleetValue: null,
        apValue: '1',
        routerAuthor: author,
      },
    ])
    assert.equal(first.fleetState, 'diverged')
    const open = [{ ...first.open[0], id: 7 }]
    // Respelled on the AP: the same divergence, refreshed.
    const again = reconcileAp({
      ...inputOf(0, { rows: withOption(aps[0].rows, 'default_radio0', { hidden: 'on' }) }),
      open,
    })
    assert.deepEqual(
      again.open.map((d) => [d.id, d.apValue]),
      [[7, 'on']]
    )
    assert.deepEqual(again.close, [])
    // Back to the fleet's value: closed.
    const back = reconcileAp({ ...inputOf(0), open })
    assert.deepEqual(back.close, [7])
    assert.deepEqual(back.open, [])
    assert.equal(back.fleetState, 'in_line')
  })

  test('new router SSIDs: linked, a new router network, or left for adoption', ({ assert }) => {
    const { inputOf, aps } = adopted()
    const ax = configsOf(AX23)
    ax[1].sections.push(
      {
        name: 'wifinet9',
        type: 'wifi-iface',
        anonymous: false,
        index: 9,
        options: {
          device: 'radio0',
          mode: 'ap',
          ssid: 'Kids',
          encryption: 'sae-mixed',
          network: 'lan',
        },
        secrets: { key: 'hmac:3333333333333333' },
      },
      {
        name: 'wifinet10',
        type: 'wifi-iface',
        anonymous: false,
        index: 10,
        options: {
          device: 'radio0',
          mode: 'ap',
          ssid: 'The Cave',
          encryption: 'psk2',
          network: 'lan',
        },
        secrets: { key: 'hmac:3333333333333333' },
      }
    )
    const rows = fleetAps({ mode: 'managed', configs: { [AX23.id]: ax }, aps: [AX23] })[0].rows
    const kids = rowNamed(rows, 'wifinet9').perchId
    const cave2g = rowNamed(rows, 'wifinet10').perchId
    const managed = reconcileAp({ ...inputOf(2, { rows }), open: [] })
    assert.deepEqual(
      managed.links.add.map((l) => [l.perchId, l.radio, l.origin]),
      [[cave2g, 'radio0', 'router']]
    )
    assert.deepEqual(
      managed.open.map((d) => [d.kind, d.perchId]),
      [['added', cave2g]],
      'The Cave is a 5 GHz network: on 2.4 GHz it is an addition to settle'
    )
    assert.deepEqual(
      managed.newNetworks.map((n) => [
        n.perchId,
        n.spec.ssid,
        n.spec.security,
        n.spec.apScope,
        n.spec.bands,
        n.spec.origin,
      ]),
      [[kids, 'Kids', 'wpa2_wpa3', 'selected', ['2g'], 'router']]
    )
    const observe = reconcileAp({
      ...inputOf(2, { rows, ap: { ...aps[2].fleet, mode: 'observe', managed: false } }),
      open: [],
    })
    assert.deepEqual(observe.newNetworks, [])
    assert.deepEqual(observe.unlinked, [kids])
    assert.equal(observe.fleetState, 'diverged')
  })

  test('two networks with one SSID and security: unassigned', ({ assert }) => {
    const { inputOf, fleet, aps } = adopted()
    const cave = fleet.networks.find((n) => n.ssid === 'The Cave')!
    const twin = { ...cave, id: 50, name: 'Twin', apScope: 'selected' as const }
    const links = fleet.links.filter((l) => !(l.apId === AX23.id && l.networkId === cave.id))
    const result = reconcileAp({
      ...inputOf(2, { networks: [...fleet.networks, twin], links }),
      open: [],
    })
    assert.deepEqual(
      result.open.map((d) => [d.kind, d.fleetValue]),
      [['unassigned', [cave.id, 50]]]
    )
    assert.equal(result.open[0].perchId, rowNamed(aps[2].rows, 'wifinet3').perchId)
  })

  test('a changed key on one AP is a key divergence (fingerprints only)', ({ assert }) => {
    const { inputOf, fleet, aps } = adopted()
    const cave = fleet.networks.find((n) => n.ssid === 'The Cave')!
    const fp = rowNamed(aps[0].rows, 'default_radio0').desired!.secrets!.key.fingerprint
    const rows = aps[2].rows.map((r) =>
      r.name === 'wifinet3'
        ? {
            ...r,
            desired: { ...r.desired!, secrets: { key: { fingerprint: 'hmac:9999999999999999' } } },
          }
        : r
    )
    const result = reconcileAp({
      ...inputOf(2, { rows }),
      open: [],
      expectedKeys: { [cave.id]: fp },
    })
    assert.deepEqual(
      result.open.map((d) => [d.option, d.fleetValue, d.apValue]),
      [['key', { fingerprint: fp }, { fingerprint: 'hmac:9999999999999999' }]]
    )
  })

  test('fleet state', ({ assert }) => {
    assert.equal(
      fleetStateOf({ mode: 'off', openDivergences: 3, unlinked: 0, rows: [] }),
      'unknown'
    )
    assert.equal(
      fleetStateOf({ mode: 'managed', openDivergences: 0, unlinked: 1, rows: [] }),
      'unassigned'
    )
    assert.equal(
      fleetStateOf({
        mode: 'managed',
        openDivergences: 0,
        unlinked: 0,
        rows: [{ status: 'ahead' }],
      }),
      'behind'
    )
  })
})

test.group('wifi fleet | impact', () => {
  const settings = { ...WIFI_CONFIG_DEFAULTS }
  function change(section: string, type: string, options: string[]): ConfigDiffEntry {
    return {
      perchId: null,
      config: 'wireless',
      section,
      type,
      domain: null,
      action: 'update',
      options: options.map((name) => ({ name, before: '1', after: '2' })),
    }
  }

  test('a DFS radio restart: radar allowance, the whole radio’s clients', ({ assert }) => {
    const rows = fleetAps({ aps: [AX23] })[0].rows
    const impact = impactForAp({
      ap: { id: AX23.id, name: 'AX23', online: true, caps: AX23.caps },
      order: 0,
      jobs: [
        {
          kind: 'apply',
          protected: false,
          changes: [change('radio1', 'wifi-device', ['txpower'])],
        },
      ],
      rows,
      clientsBySection: { default_radio0: 2, default_radio1: 5, wifinet3: 7 },
      adminDevice: { apId: AX23.id, section: 'wifinet3' },
      settings,
    })
    assert.deepEqual(impact.restartsRadio, ['radio1'])
    assert.equal(impact.clientsAffected, 12)
    assert.deepEqual(impact.dfs, { radio: 'radio1', cacSeconds: 60 })
    assert.equal(impact.windowSeconds, 180)
    assert.isTrue(impact.adminDeviceHere)
    const preview = previewImpact([impact], {
      mac: '02:00:00:00:00:01',
      apId: AX23.id,
      ssid: 'The Cave',
    })
    assert.deepEqual(
      preview.warnings.map((w) => w.code),
      ['admin_device_affected', 'dfs_radar_check']
    )
  })

  test('a BSS-only change: no restart, its own clients, the normal window', ({ assert }) => {
    const rows = fleetAps({ aps: [AX23] })[0].rows
    const impact = impactForAp({
      ap: { id: AX23.id, name: 'AX23', online: false, caps: AX23.caps },
      order: 1,
      jobs: [
        {
          kind: 'apply',
          protected: false,
          changes: [change('wifinet3', 'wifi-iface', ['hidden'])],
        },
      ],
      rows,
      clientsBySection: { default_radio1: 5, wifinet3: 7 },
      adminDevice: null,
      settings,
    })
    assert.deepEqual(
      [
        impact.restartsRadio,
        impact.touchedBss,
        impact.clientsAffected,
        impact.dfs,
        impact.windowSeconds,
      ],
      [[], 1, 7, null, 120]
    )
    const protectedJob = impactForAp({
      ap: { id: AX23.id, name: 'AX23', online: true, caps: AX23.caps },
      order: 0,
      jobs: [{ kind: 'apply', protected: true, changes: [] }],
      rows,
      clientsBySection: {},
      adminDevice: null,
      settings,
    })
    assert.equal(protectedJob.windowSeconds, 300)
    assert.deepEqual(
      previewImpact([impact], null).warnings.map((w) => w.code),
      ['ap_offline']
    )
  })

  test('radar check by channel, width and allowed list', ({ assert }) => {
    const rows = fleetAps({ aps: [AX23] })[0].rows
    const radio = rowNamed(rows, 'radio1')
    const at = (options: Record<string, string | string[]>) =>
      cacFor(AX23.caps, 'radio1', {
        ...radio,
        desired: { ...radio.desired!, options: { ...radio.desired!.options, ...options } },
      })
    assert.equal(at({ channel: '100' }), 60)
    assert.equal(at({ channel: '36', htmode: 'HE80' }), 0)
    assert.equal(at({ channel: '36', htmode: 'HE160' }), 60, '36–64 includes DFS channels')
    assert.equal(at({ channel: 'auto', channels: ['36', '40', '44', '48'] }), 0)
    assert.equal(at({ channel: 'auto' }), 60)
    assert.equal(cacFor(AX23.caps, 'radio0', rowNamed(rows, 'radio0')), 0, '2.4 GHz')
  })
})
