import { planSectionEdits } from '#services/gateway_config/apply_plan'
import {
  checkRoundTrip,
  DomainRegistry,
  syncedFromRouter,
  type ConfigDomain,
  type SyncedSection,
} from '#services/gateway_config/domain'
import { domainRegistry } from '#services/gateway_config/domains/index'
import {
  authoritativeFor,
  pauseHeld,
  pauseTransition,
  reclaimPending,
  reconcileRead,
  sectionsDueForRevert,
  settleReclaim,
  type ReconcileReadInput,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import {
  actorColumns,
  parseSystemActor,
  type SectionContent,
  type UciConfig,
} from '#services/gateway_config/types'
import {
  normalizePerchQosOption,
  perchQosDomain,
  perchQosOwnership,
  perchQosPaused,
} from '#services/perch_qos_domain'
import { planQos, type PlanInput, type PlanPolicy, type PlanSection } from '#services/qos_plan'
import { sqmDomain } from '#services/sqm_domain'
import { config, section } from '#tests/unit/services/fixtures/gateway_config'
import { test } from '@japa/runner'

/**
 * The `perch_qos` domain (docs/gateway/qos.md section 6.3) and the engine
 * features it relies on (config-plane.md section 6.8): the round trip on
 * what the planner renders, validation, the decision-15 pause hold and its
 * release, one-way enforcement without Authoritative Mode, the explicit
 * reclaim, and the system actor.
 */

const NOW = '2026-09-23T10:00:00.000Z'
const AT = new Date('2026-09-23T04:00:00Z')

function policy(id: number, fields: Partial<PlanPolicy> = {}): PlanPolicy {
  return {
    id,
    name: `p${id}`,
    shared: null,
    each: null,
    fairness: 'per_host',
    includeLan: false,
    parentId: null,
    enabled: true,
    classMinor: 0x10 + id,
    ...fields,
  }
}

function plan(input: Partial<PlanInput>) {
  return planQos({ policies: [], groups: [], assignments: [], at: AT, ...input })
}

/** A plan with nesting, a network default, device caps, schedules and exemptions. */
function richPlan() {
  return plan({
    policies: [
      policy(1, { shared: { downKbit: 100000, upKbit: 20000 } }),
      policy(2, { shared: { downKbit: 50000, upKbit: 10000 }, parentId: 1 }),
      policy(3, { each: { downKbit: 5000, upKbit: 1000 }, includeLan: true, fairness: 'per_flow' }),
    ],
    assignments: [
      {
        id: 1,
        policyId: 2,
        target: { type: 'network', network: 'guest' },
        rate: null,
        quota: null,
        expiresAt: null,
      },
      {
        id: 2,
        policyId: 3,
        target: { type: 'device', mac: '02:00:00:00:00:61' },
        rate: null,
        quota: null,
        expiresAt: null,
      },
    ],
    schedules: [
      {
        id: 7,
        enabled: true,
        target: { type: 'policy', policyId: 2 },
        action: 'limit',
        usePolicyId: null,
        shared: { downKbit: 25000, upKbit: null },
        each: null,
        rate: null,
        days: 0b0011111,
        startMinute: 18 * 60,
        endMinute: 23 * 60,
      },
    ],
    exempt: ['198.51.100.0/24'],
  })
}

function asSynced(sections: PlanSection[]): SyncedSection[] {
  return sections.map((s, i) => ({
    perchId: `q${i}`,
    config: 'perch-qos',
    name: s.name,
    type: s.type,
    anonymous: false,
    options: s.options,
  }))
}

function content(options: SectionContent['options'], type = 'globals'): SectionContent {
  return { type, options }
}

function row(partial: Partial<SectionState> & { perchId: string }): SectionState {
  return {
    config: 'perch-qos',
    name: 'globals',
    type: 'globals',
    anonymous: false,
    scope: 'synced',
    domain: 'perch_qos',
    ownership: null,
    issue: null,
    base: null,
    baseRevision: null,
    router: null,
    desired: null,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: 0,
    ...partial,
  }
}

const registry = new DomainRegistry([sqmDomain as ConfigDomain, perchQosDomain as ConfigDomain])

function read(rows: SectionState[], configs: UciConfig[], extra: Partial<ReconcileReadInput> = {}) {
  let n = 0
  return reconcileRead({
    rows,
    read: {
      configs,
      ledger: rows.map((r) => ({
        perchId: r.perchId,
        config: r.config,
        section: r.name,
        domain: r.domain ?? '',
      })),
    },
    registry,
    mode: 'managed',
    authoritative: false,
    now: NOW,
    newPerchId: () => `n${++n}`,
    ...extra,
  })
}

const GLOBALS = { enabled: '1', revision: '3', min_wan_kbit: '1000' }

test.group('perch_qos domain | the package the planner renders', () => {
  test('parse then render is the identity on planner output', ({ assert }) => {
    for (const p of [plan({}), richPlan(), plan({ paused: true })]) {
      const synced = asSynced(p.sections)
      assert.deepEqual(checkRoundTrip(perchQosDomain as ConfigDomain, synced), {
        ok: true,
        failures: [],
      })
      for (const one of synced) {
        assert.isTrue(checkRoundTrip(perchQosDomain as ConfigDomain, [one]).ok, one.name)
      }
    }
    // The rich plan has every section type.
    assert.sameMembers(
      [...new Set(richPlan().sections.map((s) => s.type))],
      ['globals', 'bucket', 'network', 'schedule']
    )
  })

  test('planner output validates clean; broken packages do not', ({ assert }) => {
    const ok = perchQosDomain.validate(asSynced(richPlan().sections))
    assert.deepEqual(
      ok.filter((i) => i.severity === 'error'),
      []
    )
    const bad = perchQosDomain.validate([
      {
        perchId: 'a',
        config: 'perch-qos',
        name: 'globals',
        type: 'globals',
        anonymous: false,
        options: {},
      },
      {
        perchId: 'b',
        config: 'perch-qos',
        name: 'g2',
        type: 'globals',
        anonymous: false,
        options: {},
      },
      {
        perchId: 'c',
        config: 'perch-qos',
        name: 'b12',
        type: 'bucket',
        anonymous: false,
        options: { class: '0x1', parent: 'b99', down_kbit: 'fast', fairness: 'odd' },
      },
      {
        perchId: 'd',
        config: 'perch-qos',
        name: 'guest',
        type: 'network',
        anonymous: false,
        options: { bucket: 'b77', schedule: ['s9'] },
      },
      {
        perchId: 'e',
        config: 'perch-qos',
        name: 's1',
        type: 'schedule',
        anonymous: false,
        options: { window: ['mon-fri 18:00-25:00'], action: 'nap' },
      },
    ])
    assert.sameMembers(
      bad.map((i) => `${i.section}:${i.code}:${i.severity}`),
      [
        'g2:perch_qos_duplicate_globals:error',
        'b12:perch_qos_bad_rate:error',
        'b12:perch_qos_bad_class:error',
        'b12:perch_qos_unknown_bucket:error',
        'b12:perch_qos_bad_value:error',
        'guest:perch_qos_unknown_bucket:error',
        'guest:perch_qos_unknown_schedule:warning',
        's1:perch_qos_bad_window:error',
        's1:perch_qos_bad_value:error',
      ]
    )
  })

  test('claims, requires, normalize, registry order', ({ assert }) => {
    const base = { name: 'x', anonymous: false, index: 0, options: {} }
    assert.isTrue(perchQosDomain.claims({ ...base, config: 'perch-qos', type: 'bucket' }))
    assert.isFalse(perchQosDomain.claims({ ...base, config: 'perch-qos', type: 'other' }))
    assert.isFalse(perchQosDomain.claims({ ...base, config: 'sqm', type: 'bucket' }))
    assert.isFalse(
      perchQosDomain.claims({ ...base, anonymous: true, config: 'perch-qos', type: 'bucket' })
    )
    assert.isTrue(
      perchQosDomain.claims({ ...base, anonymous: true, config: 'perch-qos', type: 'globals' })
    )
    assert.equal(perchQosDomain.requires({ packages: {} }), 'perch-qos is not installed')
    assert.isNull(perchQosDomain.requires({ packages: { 'perch-qos': '1.0.0' } }))
    assert.equal(normalizePerchQosOption('enabled', 'on'), '1')
    assert.equal(normalizePerchQosOption('down_kbit', '050000'), '50000')
    assert.deepEqual(
      domainRegistry()
        .list()
        .map((d) => d.key)
        .slice(-2),
      ['sqm', 'perch_qos']
    )
    assert.isTrue(perchQosDomain.oneWay)
  })

  test('decision 15: a paused globals leaves enabled to the router', ({ assert }) => {
    assert.deepEqual(perchQosOwnership({ type: 'globals', options: GLOBALS }), { kind: 'section' })
    const held = perchQosOwnership({ type: 'globals', options: { ...GLOBALS, enabled: '0' } })
    assert.equal(held.kind, 'options')
    assert.isTrue(pauseHeld(held, 'enabled'))
    assert.isFalse(pauseHeld(held, 'revision'))
    assert.deepEqual(perchQosOwnership({ type: 'bucket', options: { enabled: '0' } }), {
      kind: 'section',
    })
    assert.isTrue(perchQosPaused('off'))
    assert.isFalse(perchQosPaused(undefined))
  })
})

test.group('config plane | router-side pauses and one-way domains', () => {
  test('a router pause is held, never drift; the router resuming releases it', ({ assert }) => {
    const agreed = content(GLOBALS)
    const r0 = row({ perchId: 'g1', base: agreed, router: agreed, desired: agreed })
    const paused = config('perch-qos', [
      section('globals', 'globals', { ...GLOBALS, enabled: '0' }),
    ])

    for (const authoritative of [false, true]) {
      const result = read([r0], [paused], { authoritative })
      const [change] = result.changes
      assert.isTrue(pauseHeld(change.after!.ownership, 'enabled'))
      assert.equal(change.after!.status, 'in_sync')
      assert.equal(change.after!.desired!.options.enabled, '0')
      assert.isNull(change.after!.driftSince)
      assert.deepInclude(
        result.events.map((e) => e.event),
        'router_paused'
      )
      assert.deepEqual(
        sectionsDueForRevert([change.after!], {
          now: '2026-09-23T11:00:00.000Z',
          delaySeconds: 0,
          enforcement: 'active',
          authoritative: true,
        }),
        []
      )

      // The router switches it back: Perch owns it again, nothing to revert.
      const back = read(
        [change.after!],
        [config('perch-qos', [section('globals', 'globals', GLOBALS)])],
        {
          authoritative,
        }
      )
      const [released] = back.changes
      assert.isNull(released.after!.ownership)
      assert.equal(released.after!.status, 'in_sync')
      assert.equal(released.after!.base!.options.enabled, '1')
      assert.deepInclude(
        back.events.map((e) => e.event),
        'router_resumed'
      )
    }
  })

  test('Perch’s own pause (the base is paused) is not a router pause', ({ assert }) => {
    const pausedByPerch = content({ ...GLOBALS, enabled: '0' })
    const r0 = row({
      perchId: 'g1',
      base: pausedByPerch,
      router: pausedByPerch,
      desired: pausedByPerch,
    })
    assert.isNull(pauseTransition(r0, pausedByPerch, registry))
    // …and resuming it (C = '1') writes '1': the option is Perch's.
    const edits = planSectionEdits({
      rows: [r0],
      edits: [{ op: 'put', perchId: 'g1', config: 'perch-qos', type: 'globals', options: GLOBALS }],
      domain: 'perch_qos',
      registry,
      authoritative: false,
      newPerchId: () => 'x',
    })
    assert.equal(edits.upserts[0].desired!.options.enabled, '1')
  })

  test('a held option keeps the router’s value in edits unless reclaimed', ({ assert }) => {
    const held = row({
      perchId: 'g1',
      base: content({ ...GLOBALS, enabled: '0' }),
      router: content({ ...GLOBALS, enabled: '0' }),
      desired: content({ ...GLOBALS, enabled: '0' }),
      ownership: perchQosOwnership({ type: 'globals', options: { ...GLOBALS, enabled: '0' } }),
    })
    const next = { ...GLOBALS, revision: '4', enabled: '1' }
    const kept = planSectionEdits({
      rows: [held],
      edits: [{ op: 'put', perchId: 'g1', config: 'perch-qos', type: 'globals', options: next }],
      domain: 'perch_qos',
      registry,
      authoritative: false,
      newPerchId: () => 'x',
    })
    assert.equal(kept.upserts[0].desired!.options.enabled, '0')
    assert.equal(kept.upserts[0].desired!.options.revision, '4')
    assert.isTrue(pauseHeld(kept.upserts[0].ownership, 'enabled'))

    const reclaimed = planSectionEdits({
      rows: [held],
      edits: [
        {
          op: 'put',
          perchId: 'g1',
          config: 'perch-qos',
          type: 'globals',
          options: next,
          reclaim: ['enabled'],
        },
      ],
      domain: 'perch_qos',
      registry,
      authoritative: false,
      newPerchId: () => 'x',
    })
    assert.equal(reclaimed.upserts[0].desired!.options.enabled, '1')
    // Owned from the draft on, marked until the apply carrying it ends.
    assert.isFalse(pauseHeld(reclaimed.upserts[0].ownership, 'enabled'))
    assert.isTrue(reclaimPending(reclaimed.upserts[0].ownership, 'enabled'))
    assert.equal(reclaimed.upserts[0].status, 'ahead')
  })

  test('a reclaim that does not land goes back to the router; one that lands is Perch’s', ({
    assert,
  }) => {
    const held = row({
      perchId: 'g1',
      base: content({ ...GLOBALS, enabled: '0' }),
      router: content({ ...GLOBALS, enabled: '0' }),
      desired: content({ ...GLOBALS, enabled: '0' }),
      ownership: perchQosOwnership({ type: 'globals', options: { ...GLOBALS, enabled: '0' } }),
    })
    const pending = planSectionEdits({
      rows: [held],
      edits: [
        {
          op: 'put',
          perchId: 'g1',
          config: 'perch-qos',
          type: 'globals',
          options: { ...GLOBALS, revision: '4', enabled: '1' },
          reclaim: ['enabled'],
        },
      ],
      domain: 'perch_qos',
      registry,
      authoritative: false,
      newPerchId: () => 'x',
    }).upserts[0]
    const domain = registry.get('perch_qos')

    // Rolled back / failed: the router still has it paused.
    const back = settleReclaim(pending, domain, false)
    assert.deepEqual(back.ownership, held.ownership)
    assert.isTrue(pauseHeld(back.ownership, 'enabled'))
    assert.isFalse(reclaimPending(back.ownership, 'enabled'))
    assert.equal(back.desired!.options.enabled, '0')
    assert.equal(back.desired!.options.revision, '4')

    // Landed: the domain's full claim (the whole section for perch-qos).
    assert.isNull(settleReclaim(pending, domain, true).ownership)

    // Did not land, but the router resumed by itself meanwhile: Perch's.
    const resumed = settleReclaim(
      { ...pending, router: content({ ...GLOBALS, enabled: '1' }) },
      domain,
      false
    )
    assert.isNull(resumed.ownership)
    assert.equal(resumed.desired!.options.enabled, '1')

    // Rows without a pending reclaim are left alone.
    assert.strictEqual(settleReclaim(held, domain, false), held)
  })

  test('a section Perch creates disabled stays Perch’s (sqm enabled 0 is not a pause)', ({
    assert,
  }) => {
    const created = planSectionEdits({
      rows: [],
      edits: [
        {
          op: 'put',
          perchId: null,
          config: 'sqm',
          type: 'queue',
          options: { enabled: '0', interface: 'wan2', download: '50000', upload: '10000' },
        },
      ],
      domain: 'sqm',
      registry,
      authoritative: false,
      newPerchId: () => 'new1',
    })
    assert.isNull(created.upserts[0].ownership)
  })

  test('one-way: a router edit is drift and due for revert without Authoritative Mode', ({
    assert,
  }) => {
    const bucket = content(
      { policy: '2', class: '0x12', down_kbit: '50000', up_kbit: '10000' },
      'bucket'
    )
    const r0 = row({
      perchId: 'b1',
      name: 'b12',
      type: 'bucket',
      base: bucket,
      router: bucket,
      desired: bucket,
    })
    const edited = config('perch-qos', [
      section('b12', 'bucket', { ...bucket.options, down_kbit: '99999' }),
    ])
    const result = read([r0], [edited])
    const [change] = result.changes
    assert.equal(change.kind, 'drift')
    assert.equal(change.after!.status, 'drift')
    assert.deepEqual(
      sectionsDueForRevert([change.after!], {
        now: '2026-09-23T11:00:00.000Z',
        delaySeconds: 90,
        enforcement: 'active',
        authoritative: true,
      }),
      ['b1']
    )
    // Observe mode: the router always wins.
    const observed = read([r0], [edited], { mode: 'observe' })
    assert.notEqual(observed.changes[0].kind, 'drift')
    // The first import of the package is never drift.
    const first = read([], [config('perch-qos', [section('globals', 'globals', { enabled: '1' })])])
    assert.equal(first.changes[0].kind, 'created')
    assert.equal(first.changes[0].after!.scope, 'synced')
    // A two-way domain stays two-way.
    assert.isFalse(authoritativeFor({ mode: 'managed', authoritative: false }, registry, 'sqm'))
    assert.isTrue(
      authoritativeFor({ mode: 'managed', authoritative: false }, registry, 'perch_qos')
    )
    assert.isFalse(
      authoritativeFor({ mode: 'observe', authoritative: false }, registry, 'perch_qos')
    )
  })

  test('sqm: the live queue imported paused is held; synced from the router', ({ assert }) => {
    const queue = section('eth1', 'queue', { enabled: '0', interface: 'eth1', download: '85000' })
    const result = read([], [config('sqm', [queue])])
    assert.isTrue(pauseHeld(result.changes[0].after!.ownership, 'enabled'))
    assert.isTrue(checkRoundTrip(sqmDomain as ConfigDomain, [syncedFromRouter('sqm', queue)]).ok)
  })
})

test.group('config plane | actors', () => {
  test('users and Perch itself', ({ assert }) => {
    assert.deepEqual(actorColumns(7), { userId: 7, systemActor: null })
    assert.deepEqual(actorColumns({ userId: 7 }), { userId: 7, systemActor: null })
    assert.deepEqual(actorColumns({ system: 'qos' }), { userId: null, systemActor: 'qos' })
    assert.deepEqual(actorColumns(null), { userId: null, systemActor: null })
    assert.equal(parseSystemActor('enforcement'), 'enforcement')
    assert.isNull(parseSystemActor('root'))
    assert.isNull(parseSystemActor(null))
  })
})
