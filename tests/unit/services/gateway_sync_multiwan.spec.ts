import {
  buildMultiwanView,
  multiwanProfile,
  type Mwan3Section,
} from '#services/gateway_config/multiwan_view'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { Mwan3Observation } from '#services/gateway_observation_parts'
import { gatewaySyncConfig } from '#tests/unit/services/fixtures/gateway_sync'
import { test } from '@japa/runner'

/**
 * Multi-WAN read view (docs/design/gateway-sync/rest.md 10, domains.md 10
 * "Profiles"; work package B7a) over an mwan3 config shaped like the live
 * gateway's: WAN 1 and WAN 2 share metric 1 (balance), WAN 3 sits outside the
 * policy, a sticky HTTPS/QUIC rule uses the default rule's policy.
 */

function fixture(): Mwan3Section[] {
  return gatewaySyncConfig('mwan3').sections.map((s) => ({
    name: s.name,
    type: s.type,
    options: { ...s.options },
  }))
}

function edit(sections: Mwan3Section[], name: string, options: Record<string, string>) {
  const s = sections.find((x) => x.name === name)!
  s.options = { ...s.options, ...options }
  return sections
}

/** The live observation's shape (service disabled, nothing tracked). */
const LIVE: Mwan3Observation = {
  service: { installed: true, enabled: false, running: false },
  configInterfaces: [],
  configPolicies: { balanced_failover: ['wan_member', 'lan2_member'], wan_only: ['wan_member'] },
  interfaces: [],
  policies: {},
}

function rows(sections: Mwan3Section[]): SectionState[] {
  return sections.map((s, i) => ({
    perchId: `m${i}`,
    config: 'mwan3',
    name: s.name,
    type: s.type,
    anonymous: false,
    scope: 'unmodeled',
    domain: null,
    ownership: null,
    issue: null,
    base: { type: s.type, options: s.options },
    baseRevision: null,
    router: { type: s.type, options: s.options },
    desired: { type: s.type, options: s.options },
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: i,
  }))
}

test.group('gateway sync | multi-WAN profile (B7a)', () => {
  test('the live-shaped config is "balance" with a sticky rule', ({ assert }) => {
    const profile = multiwanProfile(fixture())!
    assert.equal(profile.kind, 'balance')
    assert.equal(profile.policy, 'balanced_failover')
    assert.deepEqual(profile.members, [
      { wan: 'wan', metric: 1, weight: 1 },
      { wan: 'lan2', metric: 1, weight: 1 },
    ])
    assert.deepEqual(profile.tracking, {
      targets: ['203.0.113.1', '198.51.100.1'],
      reliability: 2,
      count: 3,
      timeout: 2,
      interval: 5,
      down: 3,
      up: 8,
    })
    assert.equal(profile.lastResort, 'unreachable')
    assert.deepEqual(profile.rules, [
      {
        name: 'HTTPS_QUIC_Sticky_Balanced',
        summary: 'tcp/udp dest port 443 → balanced_failover (sticky)',
        policy: 'balanced_failover',
        sticky: true,
      },
    ])
    assert.includeMembers(profile.notes, [
      'wan and lan2 share metric 1: traffic is balanced, not failed over.',
      'globe (metric 2) is configured but not in the default policy.',
      'Policy wan_only is not used by any rule.',
    ])
  })

  test('strictly increasing metrics are a failover; a rule to another policy is custom', ({
    assert,
  }) => {
    const failover = multiwanProfile(edit(fixture(), 'lan2_member', { metric: '2' }))!
    assert.equal(failover.kind, 'failover')
    assert.deepEqual(
      failover.members.map((m) => [m.wan, m.metric]),
      [
        ['wan', 1],
        ['lan2', 2],
      ]
    )

    const custom = multiwanProfile(
      edit(fixture(), 'https_quic_sticky', { use_policy: 'wan_only' })
    )!
    assert.equal(custom.kind, 'custom')
    assert.include(
      custom.notes,
      'Rule HTTPS_QUIC_Sticky_Balanced sends traffic to policy wan_only.'
    )

    const tiers = fixture()
    tiers.push({ name: 'globe_in', type: 'member', options: { interface: 'globe', metric: '2' } })
    tiers.push({ name: 'x_in', type: 'member', options: { interface: 'x', metric: '2' } })
    tiers.find((s) => s.name === 'balanced_failover')!.options.use_member = [
      'wan_member',
      'globe_in',
      'x_in',
    ]
    assert.equal(multiwanProfile(tiers)!.kind, 'custom', 'a lower tier sharing a metric')
  })

  test('no rule for all traffic: custom; nothing configured: no profile', ({ assert }) => {
    const noDefault = fixture().filter((s) => s.name !== 'default_rule')
    const profile = multiwanProfile(noDefault)!
    assert.equal(profile.kind, 'custom')
    assert.isNull(profile.policy)
    assert.include(
      profile.notes,
      'No rule sends all traffic through mwan3: only the listed rules are balanced.'
    )
    assert.isNull(multiwanProfile(fixture().filter((s) => s.type === 'globals')))
  })

  test('the view: read only by decision 12; config mirrors or none; the live part', ({
    assert,
  }) => {
    const gateway = { id: 1, capabilities: { packages: { mwan3: '2.11.8-2' } } }
    const readable = buildMultiwanView(gateway, rows(fixture()), LIVE)
    assert.isFalse(readable.writable)
    assert.equal(readable.writeBlockedReason, 'owner_decision_12')
    assert.equal(readable.package, 'mwan3')
    assert.deepEqual(readable.service, { enabled: false, running: false })
    assert.equal(readable.profile!.kind, 'balance')
    assert.include(
      readable.profile!.notes,
      'mwan3 is installed but disabled: none of this is in effect.'
    )
    assert.lengthOf(readable.config!, fixture().length)
    assert.deepEqual(readable.live, LIVE)

    // Today's live gateway: mwan3 installed, its config not on the agent's allowlist.
    const unreadable = buildMultiwanView(gateway, [], LIVE)
    assert.isTrue(unreadable.installed)
    assert.isNull(unreadable.config)
    assert.isNull(unreadable.profile)

    const none = buildMultiwanView({ id: 1, capabilities: { packages: {} } }, [], null)
    assert.isFalse(none.installed)
    assert.isNull(none.package)
    assert.equal(none.writeBlockedReason, 'not_installed')
    assert.deepEqual(none.pbr, { installed: false, config: null })
  })
})
