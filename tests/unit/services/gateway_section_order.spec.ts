import { planApply, type PlanApplyInput } from '#services/gateway_config/apply_plan'
import { plannedOrders } from '#services/gateway_config/apply_lifecycle'
import { DomainRegistry, type ConfigDomain } from '#services/gateway_config/domain'
import { firewallDomain } from '#services/gateway_config/domains/firewall'
import {
  integrateMembers,
  orderKeys,
  ordersDueForRevert,
  positionsAfterOps,
  reconcileOrder,
  resolveOrder,
  setDesiredOrder,
  type OrderState,
} from '#services/gateway_config/section_order'
import { computeSyncStatus, type SectionState } from '#services/gateway_config/sync_engine'
import type { LedgerEntry, SectionContent } from '#services/gateway_config/types'
import { test } from '@japa/runner'

const registry = new DomainRegistry([firewallDomain as ConfigDomain])
const KEY = { config: 'firewall', type: 'rule' }
const NOW = '2026-09-23T10:00:00.000Z'

function content(name: string, extra: Record<string, string> = {}): SectionContent {
  return { type: 'rule', options: { name, src: 'lan', dest: 'wan', target: 'ACCEPT', ...extra } }
}

/** A synced rule on the router at `position` (null = not on the router yet). */
function row(
  id: string,
  position: number | null,
  partial: Partial<SectionState> = {}
): SectionState {
  const c = content(id)
  return {
    perchId: id,
    config: 'firewall',
    name: `perch_${id}`,
    type: 'rule',
    anonymous: false,
    scope: 'synced',
    domain: 'firewall',
    ownership: null,
    issue: null,
    base: position === null ? null : c,
    baseRevision: null,
    router: position === null ? null : c,
    desired: c,
    status: position === null ? 'ahead' : 'in_sync',
    conflict: null,
    driftSince: null,
    position,
    ...partial,
  }
}

function state(base: string[], desired: string[], partial: Partial<OrderState> = {}): OrderState {
  return { ...KEY, base, desired, status: 'in_sync', conflict: null, driftSince: null, ...partial }
}

function reconcile(prev: OrderState | null, states: SectionState[], authoritative = false) {
  return reconcileOrder({ prev, states, key: KEY, mode: 'managed', authoritative, now: NOW })
}

test.group('section order | reconcile', () => {
  test('the registry names the firewall orders', ({ assert }) => {
    assert.deepEqual(orderKeys(registry), [
      { config: 'firewall', type: 'rule' },
      { config: 'firewall', type: 'redirect' },
    ])
  })

  test('first sight: in sync with the router', ({ assert }) => {
    const out = reconcile(null, [row('b', 1), row('a', 0)])!
    assert.deepEqual(out.next.desired, ['a', 'b'])
    assert.deepEqual(out.next.base, ['a', 'b'])
    assert.equal(out.next.status, 'in_sync')
    assert.isNull(out.event)
    assert.isNull(reconcile(null, []))
  })

  test('two-way: a router reorder is imported', ({ assert }) => {
    const out = reconcile(state(['a', 'b', 'c'], ['a', 'b', 'c']), [
      row('c', 0),
      row('a', 1),
      row('b', 2),
    ])!
    assert.deepEqual(out.next.desired, ['c', 'a', 'b'])
    assert.equal(out.next.status, 'in_sync')
    assert.equal(out.event?.event, 'order_imported')
  })

  test('a controller reorder is ahead until the router has it', ({ assert }) => {
    const states = [row('a', 0), row('b', 1), row('c', 2)]
    const out = reconcile(state(['a', 'b', 'c'], ['c', 'a', 'b']), states)!
    assert.equal(out.next.status, 'ahead')
    assert.deepEqual(out.next.desired, ['c', 'a', 'b'])
    const done = reconcile(out.next, [row('c', 0), row('a', 1), row('b', 2)])!
    assert.equal(done.next.status, 'in_sync')
    assert.deepEqual(done.next.base, ['c', 'a', 'b'])
  })

  test('both reordered differently: a conflict (two-way); taking a side settles it', ({
    assert,
  }) => {
    const prev = state(['a', 'b', 'c'], ['c', 'a', 'b'], { status: 'ahead' })
    const states = [row('b', 0), row('a', 1), row('c', 2)]
    const out = reconcile(prev, states)!
    assert.equal(out.next.status, 'conflict')
    assert.deepEqual(out.next.conflict?.router, ['b', 'a', 'c'])
    assert.equal(out.event?.event, 'order_conflict')
    const router = resolveOrder(out.next, states, 'router')
    assert.equal(router.status, 'in_sync')
    assert.deepEqual(router.desired, ['b', 'a', 'c'])
    const controller = resolveOrder(out.next, states, 'controller')
    assert.equal(controller.status, 'ahead')
    assert.deepEqual(controller.desired, ['c', 'a', 'b'])
    assert.deepEqual(controller.base, ['b', 'a', 'c'])
  })

  test('Authoritative: a router reorder is drift; the router coming back clears it', ({
    assert,
  }) => {
    const prev = state(['a', 'b'], ['a', 'b'])
    const drift = reconcile(prev, [row('b', 0), row('a', 1)], true)!
    assert.equal(drift.next.status, 'drift')
    assert.equal(drift.next.driftSince, NOW)
    assert.deepEqual(drift.next.desired, ['a', 'b'])
    assert.equal(drift.event?.event, 'order_drift')
    const again = reconcile(drift.next, [row('b', 0), row('a', 1)], true)!
    assert.isNull(again.event, 'logged once')
    const back = reconcile(drift.next, [row('a', 0), row('b', 1)], true)!
    assert.equal(back.next.status, 'in_sync')
    assert.equal(back.event?.event, 'order_drift_cleared')
    assert.lengthOf(
      ordersDueForRevert([drift.next], { now: '2026-09-23T10:01:31.000Z', delaySeconds: 90 }),
      1
    )
    assert.lengthOf(
      ordersDueForRevert([drift.next], { now: '2026-09-23T10:01:00.000Z', delaySeconds: 90 }),
      0
    )
  })

  test('new and removed members never count as a reorder', ({ assert }) => {
    // The router added x between a and b; the controller created n (not on the router).
    const prev = state(['a', 'b'], ['a', 'b', 'n'])
    const out = reconcile(prev, [row('a', 0), row('x', 1), row('b', 2), row('n', null)], true)!
    assert.equal(out.next.status, 'in_sync')
    assert.deepEqual(out.next.desired, ['a', 'x', 'b', 'n'])
    assert.deepEqual(integrateMembers(['a', 'gone', 'b'], ['b', 'a', 'c'], ['c', 'a', 'b']), [
      'c',
      'a',
      'b',
    ])
  })

  test('observe mode follows the router', ({ assert }) => {
    const out = reconcileOrder({
      prev: state(['a', 'b'], ['b', 'a'], { status: 'ahead' }),
      states: [row('a', 0), row('b', 1)],
      key: KEY,
      mode: 'observe',
      authoritative: false,
      now: NOW,
    })!
    assert.deepEqual(out.next.desired, ['a', 'b'])
    assert.equal(out.next.status, 'in_sync')
  })

  test('setDesiredOrder', ({ assert }) => {
    const states = [row('a', 0), row('b', 1)]
    assert.equal(setDesiredOrder(null, KEY, states, ['b', 'a']).status, 'ahead')
    assert.equal(setDesiredOrder(null, KEY, states, ['a', 'b']).status, 'in_sync')
    const drift = state(['a', 'b'], ['a', 'b'], { status: 'drift', driftSince: NOW })
    assert.equal(
      setDesiredOrder(drift, KEY, [row('b', 0), row('a', 1)], ['a', 'b']).status,
      'drift'
    )
  })

  test('the order blocks "in sync" (Authoritative precondition)', ({ assert }) => {
    const states = [row('a', 0), row('b', 1)]
    const status = computeSyncStatus({
      mode: 'managed',
      online: true,
      enforcement: 'active',
      headRevision: 3,
      observedAt: NOW,
      applyInFlight: false,
      luciPending: false,
      uncommitted: [],
      sections: states,
      unledgered: [],
      registry,
      orders: [state(['a', 'b'], ['b', 'a'], { status: 'ahead' })],
    })
    assert.isFalse(status.inSync)
    assert.deepEqual(status.blockers, [
      {
        kind: 'order',
        config: 'firewall',
        type: 'rule',
        status: 'ahead',
        router: ['a', 'b'],
        desired: ['b', 'a'],
      },
    ])
  })
})

test.group('section order | positions after a job', () => {
  test('order ops take the slots the listed sections occupy together', ({ assert }) => {
    const rows = [
      { perchId: 'z', config: 'firewall', name: 'cfg01', position: 0, onRouter: true },
      { perchId: 'a', config: 'firewall', name: 'perch_a', position: 1, onRouter: true },
      { perchId: 'o', config: 'firewall', name: 'cfg03', position: 2, onRouter: true },
      { perchId: 'b', config: 'firewall', name: 'perch_b', position: 3, onRouter: true },
      { perchId: 'n', config: 'firewall', name: 'perch_n', position: null, onRouter: false },
    ]
    const out = positionsAfterOps(
      rows,
      [
        {
          op: 'put',
          config: 'firewall',
          section: 'perch_n',
          type: 'rule',
          options: {},
          position: { before: 'perch_a' },
        },
        { op: 'order', config: 'firewall', type: 'rule', sections: ['perch_b', 'perch_a'] },
      ],
      new Map([['perch_n', 'n']])
    )
    // z, n, b, o, a: n placed before a; then b and a swap their slots.
    assert.deepEqual(
      [...out.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id),
      ['z', 'n', 'b', 'o', 'a']
    )
  })

  test('adopt renames and deletes', ({ assert }) => {
    const rows = [
      { perchId: 'a', config: 'firewall', name: 'cfg01', position: 0, onRouter: true },
      { perchId: 'b', config: 'firewall', name: 'cfg02', position: 1, onRouter: true },
      { perchId: 'c', config: 'firewall', name: 'cfg03', position: 2, onRouter: true },
    ]
    const out = positionsAfterOps(
      rows,
      [
        { op: 'adopt', config: 'firewall', section: 'cfg03', perchId: 'c', renameTo: 'perch_c' },
        { op: 'delete', config: 'firewall', section: 'cfg01' },
        { op: 'order', config: 'firewall', type: 'rule', sections: ['perch_c', 'cfg02'] },
      ],
      new Map()
    )
    assert.deepEqual(Object.fromEntries(out), { c: 0, b: 1 })
  })
})

test.group('section order | planning', () => {
  function ledgerOf(rows: SectionState[], except: string[] = []): LedgerEntry[] {
    return rows
      .filter((r) => r.router && !except.includes(r.perchId))
      .map((r) => ({ perchId: r.perchId, config: r.config, section: r.name, domain: 'firewall' }))
  }
  function plan(rows: SectionState[], extra: Partial<PlanApplyInput> = {}) {
    return planApply({
      sections: rows,
      kind: 'apply',
      ledger: ledgerOf(rows),
      hashes: { firewall: 'f1' },
      management: { network: 'lan', device: 'br-lan' },
      registry,
      ...extra,
    })
  }

  test('a created rule is placed next to its neighbour; no order op needed', ({ assert }) => {
    const rows = [row('a', 0), row('n', null), row('b', 1)]
    const { jobs } = plan(rows, {
      perchIds: ['n'],
      orders: [{ ...KEY, perchIds: ['n', 'a', 'b'] }],
    })
    assert.lengthOf(jobs, 1)
    assert.deepEqual(jobs[0].ops, [
      {
        op: 'put',
        config: 'firewall',
        section: 'perch_n',
        type: 'rule',
        options: content('n').options,
        position: { before: 'perch_a' },
      },
    ])
  })

  test('a reorder lists the members; unledgered ones are adopted in the same job', ({ assert }) => {
    const rows = [row('a', 0, { name: 'cfg0a', anonymous: true }), row('b', 1), row('c', 2)]
    const { jobs } = plan(rows, {
      ledger: ledgerOf(rows, ['a']),
      orders: [{ ...KEY, perchIds: ['c', 'a', 'b'] }],
    })
    assert.lengthOf(jobs, 1)
    const job = jobs[0]
    assert.equal(job.kind, 'apply')
    assert.deepEqual(job.ops, [
      { op: 'adopt', config: 'firewall', section: 'cfg0a', perchId: 'a', renameTo: 'perch_a' },
      {
        op: 'order',
        config: 'firewall',
        type: 'rule',
        sections: ['perch_c', 'perch_a', 'perch_b'],
      },
    ])
    assert.deepEqual(job.perchIds, ['a'])
    const order = job.changes.find((c) => c.action === 'order')!
    assert.deepEqual(order.options[0], {
      name: '.order',
      before: ['perch_a', 'perch_b', 'perch_c'],
      after: ['perch_c', 'perch_a', 'perch_b'],
    })
  })

  test('nothing to do when the router already has the order', ({ assert }) => {
    const rows = [row('a', 0), row('b', 1)]
    assert.lengthOf(plan(rows, { orders: [{ ...KEY, perchIds: ['a', 'b'] }] }).jobs, 0)
  })

  test('scope: an unrelated request does not carry the order; a revert forces it', ({ assert }) => {
    const rows = [row('a', 0), row('b', 1)]
    const other = row('h', 0, { config: 'dhcp', domain: 'dhcp_hosts', type: 'host' })
    const orders = [{ ...KEY, perchIds: ['b', 'a'] }]
    const dhcpHost: SectionContent = { type: 'host', options: { mac: '02:00:00:00:00:01' } }
    const edited = {
      ...other,
      base: dhcpHost,
      router: dhcpHost,
      desired: { ...dhcpHost, options: { ...dhcpHost.options, ip: '192.168.1.9' } },
    }
    const unrelated = plan([...rows, edited], { perchIds: ['h'], orders })
    assert.isFalse(unrelated.jobs.some((j) => j.ops.some((op) => op.op === 'order')))
    const revert = plan(rows, {
      kind: 'revert',
      perchIds: [],
      orders: plannedOrders(
        [state(['a', 'b'], ['b', 'a'], { status: 'drift', driftSince: NOW })],
        'revert'
      ),
    })
    assert.equal(revert.jobs[0].kind, 'revert')
    assert.deepEqual(revert.jobs[0].ops.at(-1), {
      op: 'order',
      config: 'firewall',
      type: 'rule',
      sections: ['perch_b', 'perch_a'],
    })
  })

  test('an order in conflict only places created members', ({ assert }) => {
    const rows = [row('a', 0), row('b', 1)]
    const orders = plannedOrders([state(['a', 'b'], ['b', 'a'], { status: 'conflict' })], 'apply')
    assert.lengthOf(plan(rows, { orders }).jobs, 0)
  })
})
