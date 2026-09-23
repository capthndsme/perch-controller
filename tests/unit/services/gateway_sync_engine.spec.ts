import { contentsEqual, DEFAULT_RULES, type MergeRules } from '#services/gateway_config/canonical'
import { DomainRegistry, rulesFor, type ConfigDomain } from '#services/gateway_config/domain'
import { dhcpHostsDomain } from '#services/gateway_config/domains/dhcp_hosts'
import {
  acceptDrift,
  applyControllerEdit,
  checkEnableAuthoritative,
  checkModeChange,
  computeSyncStatus,
  computeUnledgered,
  controllerWins,
  deriveStatus,
  enforcementAfterFailure,
  isGone,
  markConfirmed,
  markInFlight,
  markRolledBack,
  mergeKeyedItems,
  mergeSection,
  mergeSetItems,
  nextApplyState,
  reconcileRead,
  resolveConflict,
  revertDueAt,
  rollupSyncState,
  sectionsDueForRevert,
  type ReconcileReadInput,
  type SectionState,
  type SyncStatusInput,
} from '#services/gateway_config/sync_engine'
import type { LedgerEntry, SectionContent, UciConfig } from '#services/gateway_config/types'
import { config, dhcpConfig, section } from '#tests/unit/services/fixtures/gateway_config'
import { test } from '@japa/runner'

const NOW = '2026-09-23T10:00:00.000Z'
const LATER = '2026-09-23T10:05:00.000Z'

function content(options: SectionContent['options'], type = 'host'): SectionContent {
  return { type, options }
}

function row(partial: Partial<SectionState> & { perchId: string }): SectionState {
  const c = partial.base ?? null
  return {
    config: 'dhcp',
    name: `perch_${partial.perchId}`,
    type: c?.type ?? 'host',
    anonymous: false,
    scope: 'synced',
    domain: 'dhcp_hosts',
    ownership: null,
    issue: null,
    base: null,
    baseRevision: null,
    router: c,
    desired: c,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: null,
    ...partial,
  }
}

const registry = new DomainRegistry([dhcpHostsDomain as ConfigDomain])
const hostRules = registry.rules('dhcp_hosts')

let ids = 0
function idFactory() {
  ids = 0
  return () => `p${++ids}`
}

function read(
  rows: SectionState[],
  configs: UciConfig[],
  extra: Partial<ReconcileReadInput> = {}
): ReturnType<typeof reconcileRead> {
  const { read: readExtra, ...rest } = extra
  return reconcileRead({
    rows,
    read: { configs, ledger: readExtra?.ledger ?? [] },
    registry,
    mode: 'managed',
    authoritative: false,
    now: NOW,
    newPerchId: idFactory(),
    ...rest,
  })
}

/** Rows after applying a reconcile result (what the caller would persist). */
function persist(rows: SectionState[], result: ReturnType<typeof reconcileRead>): SectionState[] {
  const out = rows.filter((r) => !result.changes.some((c) => c.perchId === r.perchId))
  for (const change of result.changes) if (change.after) out.push(change.after)
  return out
}

function byName(rows: SectionState[], name: string): SectionState {
  const found = rows.find((r) => r.name === name)
  if (!found) throw new Error(`no row ${name}`)
  return found
}

// ── section 5.1: the merge table ─────────────────────────────────────────

test.group('sync engine | three-way merge (section 5.1)', () => {
  const B = content({ ip: '192.168.1.20', name: 'printer', mac: '02:00:00:00:00:11' })

  test('R = B and C = B: unchanged', ({ assert }) => {
    assert.deepEqual(mergeSection({ base: B, router: B, desired: B }), { kind: 'unchanged' })
  })

  test('R = B, C moved: unchanged, the pending controller edit stands', ({ assert }) => {
    const C = content({ ...B.options, ip: '192.168.1.30' })
    assert.deepEqual(mergeSection({ base: B, router: B, desired: C }), { kind: 'unchanged' })
  })

  test('C = B, R moved: import (C := B := R)', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    const result = mergeSection({ base: B, router: R, desired: B })
    assert.equal(result.kind, 'merged')
    if (result.kind !== 'merged') return
    assert.isTrue(result.imported)
    assert.deepEqual(result.base, R)
    assert.deepEqual(result.desired, R)
  })

  test('both moved on different options: merged per option, B := R', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    const C = content({ ...B.options, name: 'printer2' })
    const result = mergeSection({ base: B, router: R, desired: C })
    assert.equal(result.kind, 'merged')
    if (result.kind !== 'merged') return
    assert.isFalse(result.imported)
    assert.deepEqual(result.base, R)
    assert.deepEqual(
      result.desired,
      content({ ...B.options, ip: '192.168.1.40', name: 'printer2' })
    )
  })

  test('both moved to the same value: no conflict', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    const result = mergeSection({ base: B, router: R, desired: R })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') assert.isTrue(result.imported)
  })

  test('both moved on the same option differently: conflict on that option only', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40', dns: '1' })
    const C = content({ ...B.options, ip: '192.168.1.50' })
    const result = mergeSection({ base: B, router: R, desired: C })
    assert.equal(result.kind, 'conflict')
    if (result.kind !== 'conflict') return
    assert.equal(result.conflict.kind, 'options')
    assert.deepEqual(result.conflict.options, [
      { name: 'ip', base: '192.168.1.20', router: '192.168.1.40', controller: '192.168.1.50' },
    ])
  })

  test('an option added on one side and removed on the other merge', ({ assert }) => {
    const R = content({ ...B.options, leasetime: '12h' })
    const rest = { ...B.options }
    delete rest.name
    const C = content(rest)
    const result = mergeSection({ base: B, router: R, desired: C })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') {
      assert.deepEqual(result.desired, content({ ...rest, leasetime: '12h' }))
    }
  })

  test('deleted on the router, edited on the controller: delete_vs_edit conflict', ({ assert }) => {
    const C = content({ ...B.options, ip: '192.168.1.50' })
    const result = mergeSection({ base: B, router: null, desired: C })
    assert.equal(result.kind, 'conflict')
    if (result.kind === 'conflict') assert.equal(result.conflict.kind, 'delete_vs_edit')
  })

  test('deleted by the controller, edited on the router: delete_vs_edit conflict', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    const result = mergeSection({ base: B, router: R, desired: null })
    assert.equal(result.kind, 'conflict')
    if (result.kind === 'conflict') assert.equal(result.conflict.kind, 'delete_vs_edit')
  })

  test('deleted on both sides: gone', ({ assert }) => {
    assert.deepEqual(mergeSection({ base: B, router: null, desired: null }), {
      kind: 'merged',
      base: null,
      desired: null,
      imported: true,
      ownership: null,
    })
  })

  test('deleted on the router, untouched by the controller: the deletion imports', ({ assert }) => {
    const result = mergeSection({ base: B, router: null, desired: B })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') {
      assert.isNull(result.base)
      assert.isNull(result.desired)
    }
  })

  test('type changed on the router while the controller moved: type conflict', ({ assert }) => {
    const R = content(B.options, 'domain')
    const C = content({ ...B.options, ip: '192.168.1.50' })
    const result = mergeSection({ base: B, router: R, desired: C })
    assert.equal(result.kind, 'conflict')
    if (result.kind === 'conflict') assert.equal(result.conflict.kind, 'type')
  })

  test('type changed on the router, controller untouched: imported', ({ assert }) => {
    const R = content(B.options, 'domain')
    const result = mergeSection({ base: B, router: R, desired: B })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') assert.equal(result.desired?.type, 'domain')
  })

  test('both created a section of the same name: options merged against an empty base', ({
    assert,
  }) => {
    const R = content({ mac: '02:00:00:00:00:11', ip: '192.168.1.20' })
    const C = content({ mac: '02:00:00:00:00:11', name: 'printer' })
    const result = mergeSection({ base: null, router: R, desired: C })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') {
      assert.deepEqual(
        result.desired,
        content({ mac: '02:00:00:00:00:11', ip: '192.168.1.20', name: 'printer' })
      )
    }
  })

  test('the domain normaliser: 12h vs 43200, mac string vs list are not changes', ({ assert }) => {
    const base = content({
      mac: '02:00:00:00:00:AA 02:00:00:00:00:bb',
      leasetime: '12h',
      dns: 'true',
    })
    const router = content({
      mac: ['02:00:00:00:00:bb', '02:00:00:00:00:aa'],
      leasetime: '720m',
      dns: '1',
    })
    assert.deepEqual(mergeSection({ base, router, desired: base, rules: hostRules }), {
      kind: 'unchanged',
    })
    assert.equal(mergeSection({ base, router, desired: base }).kind, 'merged', 'not without rules')
  })

  test('secrets compare by fingerprint; the router rotating a key merges with an option edit', ({
    assert,
  }) => {
    const base: SectionContent = {
      type: 'interface',
      options: { proto: 'wireguard', listen_port: '51820' },
      secrets: { private_key: { fingerprint: 'hmac:0000000000000001' } },
    }
    const router: SectionContent = {
      ...base,
      secrets: { private_key: { fingerprint: 'hmac:0000000000000002' } },
    }
    const desired: SectionContent = { ...base, options: { ...base.options, listen_port: '51821' } }
    const result = mergeSection({ base, router, desired })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') {
      assert.deepEqual(result.desired?.secrets, {
        private_key: { fingerprint: 'hmac:0000000000000002' },
      })
      assert.equal(result.desired?.options.listen_port, '51821')
    }
    const both: SectionContent = {
      ...base,
      secrets: { private_key: { fingerprint: 'hmac:0000000000000003', ref: 's1' } },
    }
    const conflict = mergeSection({ base, router, desired: both })
    assert.equal(conflict.kind, 'conflict')
    if (conflict.kind === 'conflict') {
      assert.deepEqual(conflict.conflict.options[0].router, { secret: 'hmac:0000000000000002' })
    }
  })
})

test.group('sync engine | lists', () => {
  test('atomic lists (list ports): a reorder on both sides conflicts', ({ assert }) => {
    const base = content({ ports: ['lan1', 'lan2'] }, 'bridge-vlan')
    const router = content({ ports: ['lan2', 'lan1'] }, 'bridge-vlan')
    const desired = content({ ports: ['lan1', 'lan2', 'lan3'] }, 'bridge-vlan')
    assert.equal(mergeSection({ base, router, desired }).kind, 'conflict')
  })

  test('set lists merge item by item and never conflict', ({ assert }) => {
    assert.deepEqual(mergeSetItems(['lan'], ['lan', 'guest'], ['lan', 'iot']), [
      'lan',
      'guest',
      'iot',
    ])
    assert.deepEqual(mergeSetItems(['lan', 'guest'], ['lan'], ['lan', 'guest', 'iot']), [
      'lan',
      'iot',
    ])
    assert.deepEqual(
      mergeSetItems(['a', 'b'], ['b', 'a'], ['a', 'b']),
      ['b', 'a'],
      "router's order"
    )
    const rules: MergeRules = { ...DEFAULT_RULES, listSemantics: () => 'set' }
    const result = mergeSection({
      base: content({ network: ['lan'] }, 'zone'),
      router: content({ network: ['lan', 'guest'] }, 'zone'),
      desired: content({ network: ['lan', 'iot'] }, 'zone'),
      rules,
    })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged')
      assert.deepEqual(result.desired?.options.network, ['lan', 'guest', 'iot'])
  })

  test('keyed lists: dhcp_option by code; the same code changed twice conflicts', ({ assert }) => {
    const code = (item: string) => item.split(',')[0]
    assert.deepEqual(
      mergeKeyedItems(
        code,
        ['6,192.168.1.53'],
        ['6,192.168.1.53', '42,192.168.1.1'],
        ['6,192.168.1.54']
      ),
      ['6,192.168.1.54', '42,192.168.1.1']
    )
    assert.isNull(mergeKeyedItems(code, ['6,a'], ['6,b'], ['6,c']))
    const rules: MergeRules = { ...DEFAULT_RULES, listSemantics: () => ({ keyed: code }) }
    const result = mergeSection({
      base: content({ dhcp_option: ['6,a'] }, 'dhcp'),
      router: content({ dhcp_option: ['6,b'] }, 'dhcp'),
      desired: content({ dhcp_option: ['6,c'] }, 'dhcp'),
      rules,
    })
    assert.equal(result.kind, 'conflict')
  })
})

test.group('sync engine | option-level ownership (README 3.2)', () => {
  const ownership = { kind: 'options' as const, options: ['ip', 'name'] }
  const B = content({ ip: '192.168.1.20', name: 'printer', tag: 'known' })

  test('router-owned options take the router whatever C says; no conflict', ({ assert }) => {
    const R = content({ ...B.options, tag: 'other' })
    const C = content({ ...B.options, tag: 'mine', name: 'printer2' })
    const result = mergeSection({ base: B, router: R, desired: C, ownership })
    assert.equal(result.kind, 'merged')
    if (result.kind === 'merged') {
      assert.deepEqual(
        result.desired,
        content({ ip: '192.168.1.20', name: 'printer2', tag: 'other' })
      )
    }
  })

  test('owned projection: foreign edits are not drift, owned ones are', ({ assert }) => {
    const foreign = content({ ...B.options, tag: 'other' })
    const owned = content({ ...B.options, ip: '192.168.1.99' })
    assert.isTrue(contentsEqual(foreign, B, DEFAULT_RULES, ownership))
    assert.isFalse(contentsEqual(owned, B, DEFAULT_RULES, ownership))
  })

  test('item-owned list option: foreign items are the router’s, owned items merge', ({
    assert,
  }) => {
    const items = { kind: 'options' as const, options: [], items: { server: ['192.168.1.53'] } }
    const base = content({ server: ['192.168.1.1', '192.168.1.53'], domain: 'lan' }, 'dnsmasq')
    const router = content(
      { server: ['192.168.1.1', '192.168.1.2', '192.168.1.53'], domain: 'home' },
      'dnsmasq'
    )
    const desired = content(
      { server: ['192.168.1.1', '192.168.1.53', '192.168.1.54'], domain: 'lan' },
      'dnsmasq'
    )
    const withNew = { ...items, items: { server: ['192.168.1.53', '192.168.1.54'] } }
    const result = mergeSection({ base, router, desired, ownership: withNew })
    assert.equal(result.kind, 'merged')
    if (result.kind !== 'merged') return
    assert.deepEqual(result.desired?.options.server, [
      '192.168.1.1',
      '192.168.1.2',
      '192.168.1.53',
      '192.168.1.54',
    ])
    assert.equal(result.desired?.options.domain, 'home', 'domain is not owned')

    // The router drops an owned item while the controller did not touch it: imported, no longer owned.
    const dropped = mergeSection({
      base,
      router: content({ server: ['192.168.1.1'], domain: 'lan' }, 'dnsmasq'),
      desired: base,
      ownership: items,
    })
    assert.equal(dropped.kind, 'merged')
    if (dropped.kind === 'merged') {
      assert.deepEqual(dropped.ownership, { kind: 'options', options: [], items: { server: [] } })
    }
  })

  test('controllerWins writes owned options from C and foreign ones from R', ({ assert }) => {
    const R = content({ ip: '192.168.1.20', name: 'x', tag: 'router' })
    const C = content({ ip: '192.168.1.30', name: 'printer', tag: 'stale' })
    assert.deepEqual(
      controllerWins(R, C, ownership),
      content({ ip: '192.168.1.30', name: 'printer', tag: 'router' })
    )
    assert.deepEqual(controllerWins(R, C, null), C)
    assert.isNull(controllerWins(R, null, ownership))
  })
})

// ── reconcileRead ────────────────────────────────────────────────────────

test.group('sync engine | reconciling a read', () => {
  test('first read: reservations are synced, everything else mirrored, one import revision', ({
    assert,
  }) => {
    const result = read([], [dhcpConfig(), config('perch-managed', []), config('rpcd', [])])
    const rows = persist([], result)
    const synced = rows
      .filter((r) => r.scope === 'synced')
      .map((r) => r.name)
      .sort()
    assert.deepEqual(synced, ['blocked', 'cfg07fe63', 'laptop', 'nas', 'phone'])
    const unmodeled = rows
      .filter((r) => r.scope === 'unmodeled')
      .map((r) => r.name)
      .sort()
    assert.deepEqual(unmodeled, ['cfg01411c', 'lan', 'nameonly', 'odhcpd', 'vendor', 'wan'])
    assert.isFalse(rows.some((r) => r.config === 'rpcd' || r.config === 'perch-managed'))
    assert.equal(result.revisionSource, 'import')
    assert.deepEqual(result.unledgered.length, 5, 'nothing is ledgered yet')
    const nas = byName(rows, 'nas')
    assert.deepEqual(nas.ownership, {
      kind: 'options',
      options: ['mac', 'ip', 'name', 'dns', 'leasetime'],
    })
    assert.equal(nas.status, 'in_sync')
    assert.deepEqual(nas.base, nas.router)
    assert.equal(nas.position, 5)

    const again = read(rows, [dhcpConfig()])
    assert.lengthOf(again.changes, 0, 'an unchanged read changes nothing')
    assert.isNull(again.revisionSource)
  })

  test('the ledger maps perchIds to sections; a synced row follows it', ({ assert }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const nas = byName(rows, 'nas')
    const ledger: LedgerEntry[] = rows
      .filter((r) => r.scope === 'synced')
      .map((r) => ({ perchId: r.perchId, config: 'dhcp', section: r.name, domain: 'dhcp_hosts' }))
    assert.deepEqual(computeUnledgered(rows, ledger), [])
    // The ledger now says nas lives in perch_x (an adopt renamed it).
    const renamed = dhcpConfig()
    renamed.sections = renamed.sections.map((s) =>
      s.name === 'nas' ? { ...s, name: `perch_${nas.perchId}` } : s
    )
    const ledger2 = ledger.map((e) =>
      e.perchId === nas.perchId ? { ...e, section: `perch_${nas.perchId}` } : e
    )
    const result = read(rows, [renamed], { read: { configs: [], ledger: ledger2 } })
    assert.lengthOf(result.changes, 1)
    assert.equal(result.changes[0].after?.name, `perch_${nas.perchId}`)
    assert.isFalse(result.changes[0].baseChanged)
  })

  test('two-way: a router edit imports, with an event and a router revision', ({ assert }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.121'
    const result = read(rows, [edited])
    assert.lengthOf(result.changes, 1)
    const change = result.changes[0]
    assert.equal(change.kind, 'imported')
    assert.isTrue(change.baseChanged)
    assert.equal(change.after?.base?.options.ip, '192.168.1.121')
    assert.equal(change.after?.desired?.options.ip, '192.168.1.121')
    assert.equal(result.revisionSource, 'router')
    assert.deepEqual(
      result.events.map((e) => e.event),
      ['imported']
    )
  })

  test('two-way: overlapping edits open a conflict; the router value stays live', ({ assert }) => {
    let rows = persist([], read([], [dhcpConfig()]))
    const nas = byName(rows, 'nas')
    const edited = applyControllerEdit(
      nas,
      content({ ...nas.desired!.options, ip: '192.168.1.130' }),
      {
        authoritative: false,
        rules: hostRules,
      }
    )
    assert.equal(edited.status, 'ahead')
    rows = rows.map((r) => (r.perchId === nas.perchId ? edited : r))

    const routerEdit = dhcpConfig()
    routerEdit.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.140'
    const result = read(rows, [routerEdit])
    const change = result.changes[0]
    assert.equal(change.kind, 'conflict')
    assert.equal(change.after?.status, 'conflict')
    assert.equal(change.after?.router?.options.ip, '192.168.1.140')
    assert.equal(change.after?.desired?.options.ip, '192.168.1.130', 'C kept')
    assert.equal(change.after?.base?.options.ip, '192.168.1.21', 'B kept')
    assert.deepEqual(
      change.after?.conflict?.options.map((o) => o.name),
      ['ip']
    )
    assert.equal(change.after?.conflict?.detectedAt, NOW)
    assert.deepEqual(
      result.events.map((e) => e.event),
      ['conflict_opened']
    )

    // The router reverts its edit: the conflict settles by itself, C stays ahead.
    rows = persist(rows, result)
    const settled = read(rows, [dhcpConfig()])
    const after = settled.changes[0].after!
    assert.isNull(after.conflict)
    assert.equal(after.status, 'ahead')
    assert.deepEqual(
      settled.events.map((e) => e.event),
      ['conflict_resolved']
    )
  })

  test('two-way: a router edit to a router-owned option imports silently into B and C', ({
    assert,
  }) => {
    let rows = persist([], read([], [dhcpConfig()]))
    const nas = byName(rows, 'nas')
    rows = rows.map((r) =>
      r.perchId === nas.perchId
        ? applyControllerEdit(nas, content({ ...nas.desired!.options, name: 'nas2' }), {
            authoritative: false,
            rules: hostRules,
          })
        : r
    )
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.tag = 'other'
    const change = read(rows, [edited]).changes[0]
    assert.equal(change.kind, 'merged')
    assert.equal(change.after?.desired?.options.tag, 'other')
    assert.equal(change.after?.desired?.options.name, 'nas2')
    assert.equal(change.after?.status, 'ahead')
  })

  test('deleted on the router, untouched here: the row goes with a revision', ({ assert }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const gone = dhcpConfig()
    gone.sections = gone.sections.filter((s) => s.name !== 'laptop')
    const result = read(rows, [gone])
    assert.lengthOf(result.changes, 1)
    assert.equal(result.changes[0].kind, 'removed')
    assert.isNull(result.changes[0].after)
    assert.isTrue(result.changes[0].baseChanged)
  })

  test('re-link by identity: a lost synced section found under a new name', ({ assert }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const laptop = byName(rows, 'laptop')
    const renamed = dhcpConfig()
    renamed.sections.find((s) => s.name === 'laptop')!.name = 'cfg0a0b0c'
    const result = read(rows, [renamed])
    assert.lengthOf(result.changes, 1)
    const change = result.changes[0]
    assert.equal(change.kind, 'relinked')
    assert.equal(change.perchId, laptop.perchId)
    assert.equal(change.after?.name, 'cfg0a0b0c')
    assert.include(result.unledgered, laptop.perchId)
  })

  test('a copied section (same MAC): the copy is ambiguous, the managed one keeps its id', ({
    assert,
  }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const copied = dhcpConfig()
    const nas = copied.sections.find((s) => s.name === 'nas')!
    copied.sections.push({ ...nas, name: 'cfg0ffee1', anonymous: true, index: 99 })
    const result = read(rows, [copied])
    assert.lengthOf(result.changes, 1)
    const change = result.changes[0]
    assert.equal(change.kind, 'created')
    assert.equal(change.after?.scope, 'unmodeled')
    assert.equal(change.after?.issue, 'ambiguous')
    assert.deepEqual(
      result.events.map((e) => e.event),
      ['section_ambiguous']
    )
  })

  test('two new hosts on one MAC are both ambiguous (plan 2: unmanageable until fixed)', ({
    assert,
  }) => {
    const dup = config('dhcp', [
      section('a', 'host', { mac: '02:00:00:00:00:51', ip: '192.168.1.51' }),
      section('b', 'host', { mac: '02:00:00:00:00:51', ip: '192.168.1.52' }),
    ])
    const rows = persist([], read([], [dup]))
    assert.deepEqual(
      rows.map((r) => [r.name, r.scope, r.issue]),
      [
        ['a', 'unmodeled', 'ambiguous'],
        ['b', 'unmodeled', 'ambiguous'],
      ]
    )
  })

  test('a section the domain cannot round-trip stays unmodeled', ({ assert }) => {
    const lossy: ConfigDomain = {
      ...(dhcpHostsDomain as ConfigDomain),
      key: 'lossy',
      render: (obj: any) => [
        {
          op: 'put',
          perchId: obj.perchId,
          config: 'dhcp',
          type: 'host',
          options: { mac: obj.macs.join(' ') },
        },
      ],
    }
    const result = reconcileRead({
      rows: [],
      read: {
        configs: [
          config('dhcp', [section('h', 'host', { mac: '02:00:00:00:00:61', ip: '192.168.1.61' })]),
        ],
        ledger: [],
      },
      registry: new DomainRegistry([lossy]),
      mode: 'managed',
      authoritative: false,
      now: NOW,
      newPerchId: idFactory(),
    })
    assert.equal(result.changes[0].after?.scope, 'unmodeled')
    assert.equal(result.changes[0].after?.issue, 'no_round_trip')
  })

  test('a router edit the domain no longer claims (wildcard MAC) rescopes the section', ({
    assert,
  }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'blocked')!.options.mac = '02:00:00:00:*:*'
    const change = read(rows, [edited]).changes[0]
    assert.equal(change.kind, 'rescoped')
    assert.equal(change.after?.scope, 'unmodeled')
  })

  test('mirrors follow the router and log changes; excluded stays excluded', ({ assert }) => {
    let rows = persist(
      [],
      read([], [dhcpConfig()], {
        initialScope: (_c, s) => (s.name === 'phone' ? 'excluded' : null),
      })
    )
    assert.equal(byName(rows, 'phone').scope, 'excluded')
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'odhcpd')!.options.loglevel = '7'
    edited.sections.find((s) => s.name === 'phone')!.options.dns = '0'
    edited.sections = edited.sections.filter((s) => s.name !== 'wan')
    const result = read(rows, [edited])
    rows = persist(rows, result)
    assert.equal(byName(rows, 'odhcpd').router?.options.loglevel, '7')
    assert.equal(byName(rows, 'phone').scope, 'excluded')
    assert.equal(byName(rows, 'phone').router?.options.dns, '0')
    assert.isFalse(rows.some((r) => r.name === 'wan'))
    assert.sameMembers(
      result.events.map((e) => e.event),
      ['unmodeled_changed', 'unmodeled_changed', 'section_removed']
    )
    assert.isNull(result.revisionSource, 'mirrors are not revisions')
  })

  test('sections carried by an apply in flight are deferred (section 5.5)', ({ assert }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const nas = byName(rows, 'nas')
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.150'
    const result = read(rows, [edited], { inFlight: new Map([[nas.perchId, 'apply']]) })
    assert.equal(result.changes[0].kind, 'deferred')
    assert.equal(result.changes[0].after?.router?.options.ip, '192.168.1.150')
    assert.equal(result.changes[0].after?.base?.options.ip, '192.168.1.21', 'not merged yet')
  })

  test('observe mode: the router always wins, drafts are dropped', ({ assert }) => {
    let rows = persist([], read([], [dhcpConfig()]))
    const nas = byName(rows, 'nas')
    rows = rows.map((r) =>
      r.perchId === nas.perchId
        ? applyControllerEdit(nas, content({ ...nas.desired!.options, ip: '192.168.1.130' }), {
            authoritative: false,
          })
        : r
    )
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.140'
    const change = read(rows, [edited], { mode: 'observe' }).changes[0]
    assert.equal(change.after?.desired?.options.ip, '192.168.1.140')
    assert.isNull(change.after?.conflict)
  })
})

// ── Authoritative Mode ───────────────────────────────────────────────────

test.group('sync engine | Authoritative Mode (section 5.3)', () => {
  function authoritativeRows() {
    return persist([], read([], [dhcpConfig()]))
  }

  test('a router edit to an owned option is drift; B and C stay, driftSince is kept', ({
    assert,
  }) => {
    let rows = authoritativeRows()
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.160'
    const first = read(rows, [edited], { authoritative: true })
    const change = first.changes[0]
    assert.equal(change.kind, 'drift')
    assert.equal(change.after?.status, 'drift')
    assert.equal(change.after?.driftSince, NOW)
    assert.equal(change.after?.desired?.options.ip, '192.168.1.21')
    assert.isFalse(change.baseChanged)
    assert.deepEqual(
      first.events.map((e) => e.event),
      ['drift_detected']
    )

    rows = persist(rows, first)
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.161'
    const second = read(rows, [edited], { authoritative: true, now: LATER })
    assert.equal(second.changes[0].after?.driftSince, NOW, 'the delay runs from the first edit')
    assert.lengthOf(second.events, 0)
  })

  test('a router edit to a router-owned option is never drift', ({ assert }) => {
    const rows = authoritativeRows()
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.tag = 'other'
    const change = read(rows, [edited], { authoritative: true }).changes[0]
    assert.equal(change.kind, 'imported')
    assert.equal(change.after?.status, 'in_sync')
    assert.equal(change.after?.desired?.options.tag, 'other')
    assert.equal(change.after?.base?.options.tag, 'other')
  })

  test('the router going back clears the drift', ({ assert }) => {
    let rows = authoritativeRows()
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.160'
    rows = persist(rows, read(rows, [edited], { authoritative: true }))
    const back = read(rows, [dhcpConfig()], { authoritative: true })
    assert.equal(back.changes[0].kind, 'drift_cleared')
    assert.equal(back.changes[0].after?.status, 'in_sync')
    assert.isNull(back.changes[0].after?.driftSince)
  })

  test('a new router section of a modeled type is drift; deleting it again drops the row', ({
    assert,
  }) => {
    let rows = authoritativeRows()
    const added = dhcpConfig()
    added.sections.push(
      section('extra', 'host', { mac: '02:00:00:00:00:71', ip: '192.168.1.71' }, { index: 50 })
    )
    const result = read(rows, [added], { authoritative: true })
    const change = result.changes[0]
    assert.equal(change.kind, 'drift')
    assert.isNull(change.after?.base)
    assert.isNull(change.after?.desired)
    assert.equal(change.after?.status, 'drift')

    rows = persist(rows, result)
    const removed = read(rows, [dhcpConfig()], { authoritative: true })
    assert.equal(removed.changes[0].kind, 'removed')
  })

  test('accept keeps the router version (C := B := R); an accepted deletion drops the row', ({
    assert,
  }) => {
    let rows = authoritativeRows()
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.160'
    edited.sections = edited.sections.filter((s) => s.name !== 'laptop')
    rows = persist(rows, read(rows, [edited], { authoritative: true }))
    const nas = acceptDrift(byName(rows, 'nas'), { rules: hostRules })!
    assert.equal(nas.status, 'in_sync')
    assert.equal(nas.base?.options.ip, '192.168.1.160')
    assert.equal(nas.desired?.options.ip, '192.168.1.160')
    assert.isNull(acceptDrift(byName(rows, 'laptop')), 'deleted on the router: accepted = gone')
  })

  test('revert timing: due after the grace delay, never while suspended', ({ assert }) => {
    let rows = authoritativeRows()
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.160'
    rows = persist(rows, read(rows, [edited], { authoritative: true }))
    const nas = byName(rows, 'nas')
    assert.equal(revertDueAt(nas, 90), '2026-09-23T10:01:30.000Z')
    const ctx = { delaySeconds: 90, enforcement: 'active' as const, authoritative: true }
    assert.deepEqual(sectionsDueForRevert(rows, { ...ctx, now: '2026-09-23T10:01:29.000Z' }), [])
    assert.deepEqual(sectionsDueForRevert(rows, { ...ctx, now: '2026-09-23T10:01:30.000Z' }), [
      nas.perchId,
    ])
    assert.deepEqual(
      sectionsDueForRevert(rows, { ...ctx, now: LATER, enforcement: 'suspended' }),
      []
    )
    assert.deepEqual(sectionsDueForRevert(rows, { ...ctx, now: LATER, authoritative: false }), [])
    assert.isNull(revertDueAt(byName(rows, 'laptop'), 90))
  })

  test('enforcement suspends after max failures inside the window', ({ assert }) => {
    const ctx = { now: NOW, maxFailures: 2, windowMinutes: 60 }
    assert.equal(enforcementAfterFailure([NOW], ctx), 'active')
    assert.equal(enforcementAfterFailure(['2026-09-23T09:30:00.000Z', NOW], ctx), 'suspended')
    assert.equal(
      enforcementAfterFailure(['2026-09-23T08:30:00.000Z', NOW], ctx),
      'active',
      'outside the hour'
    )
  })
})

// ── section 5.6: state diagrams ──────────────────────────────────────────

test.group('sync engine | section state diagram, two-way (section 5.6)', () => {
  const B = content({ mac: '02:00:00:00:00:11', ip: '192.168.1.20' })
  const ctx = { authoritative: false, rules: hostRules }

  test('in_sync → edit → ahead → sent → pending → confirmed → in_sync', ({ assert }) => {
    let s = row({ perchId: 'a', base: B })
    assert.equal(s.status, 'in_sync')
    const C = content({ ...B.options, ip: '192.168.1.30' })
    s = applyControllerEdit(s, C, ctx)
    assert.equal(s.status, 'ahead')
    s = markInFlight(s, 'apply')
    assert.equal(s.status, 'pending')
    s = markConfirmed(s, C, ctx)
    assert.equal(s.status, 'in_sync')
    assert.deepEqual(s.base, C)
    assert.deepEqual(s.router, C)
  })

  test('pending → rolled back → ahead, the draft kept', ({ assert }) => {
    const C = content({ ...B.options, ip: '192.168.1.30' })
    let s = markInFlight(applyControllerEdit(row({ perchId: 'a', base: B }), C, ctx), 'apply')
    s = markRolledBack(s, { ...ctx, now: NOW })
    assert.equal(s.status, 'ahead')
    assert.deepEqual(s.desired, C)
    assert.deepEqual(s.base, B)
  })

  test('rolled back with discarded router edits → conflict; taking the router restores them', ({
    assert,
  }) => {
    const C = content({ ...B.options, ip: '192.168.1.30' })
    const discarded = content({ ...B.options, name: 'typed-in-luci' })
    let s = markInFlight(applyControllerEdit(row({ perchId: 'a', base: B }), C, ctx), 'apply')
    s = markRolledBack(s, { ...ctx, now: NOW, discarded })
    assert.equal(s.status, 'conflict')
    assert.equal(s.conflict?.origin, 'rollback_discarded')
    assert.deepEqual(s.conflict?.discarded, discarded)
    const resolved = resolveConflict(s, { take: 'router' }, ctx)!
    assert.deepEqual(resolved.desired, discarded, 'the lost edit comes back as C')
    assert.deepEqual(resolved.base, B, 'B is what the router runs')
    assert.equal(resolved.status, 'ahead')
  })

  test('ahead → overlapping router edit → conflict → resolve → ahead | in_sync', ({ assert }) => {
    const ownership = { kind: 'options' as const, options: ['mac', 'ip', 'name'] }
    let s = row({ perchId: 'a', base: B, ownership })
    s = applyControllerEdit(s, content({ ...B.options, ip: '192.168.1.30' }), ctx)
    const R = content({ ...B.options, ip: '192.168.1.40', name: 'luci-name' })
    const merge = mergeSection({
      base: s.base,
      router: R,
      desired: s.desired,
      ownership,
      rules: hostRules,
    })
    assert.equal(merge.kind, 'conflict')
    if (merge.kind !== 'conflict') return
    s = { ...s, router: R, conflict: { ...merge.conflict, detectedAt: NOW }, status: 'conflict' }
    assert.equal(deriveStatus(s, ctx), 'conflict')

    const takeRouter = resolveConflict(s, { take: 'router' }, ctx)!
    assert.equal(takeRouter.status, 'in_sync')
    assert.deepEqual(takeRouter.base, R)

    const takeController = resolveConflict(s, { take: 'controller' }, ctx)!
    assert.equal(takeController.status, 'ahead')
    assert.equal(takeController.desired?.options.ip, '192.168.1.30')
    assert.deepEqual(takeController.base, R)

    const custom = resolveConflict(
      s,
      { take: 'custom', options: { ip: { take: 'custom', value: '192.168.1.99' } } },
      ctx
    )!
    assert.equal(custom.desired?.options.ip, '192.168.1.99')
    assert.equal(custom.desired?.options.name, 'luci-name', "the router's other edit is merged in")
    assert.equal(custom.status, 'ahead')

    assert.isNull(resolveConflict(s, { take: 'custom', options: {} }, ctx), 'ip left undecided')
    assert.isNull(resolveConflict({ ...s, conflict: null }, { take: 'router' }, ctx))
  })

  test('delete-vs-edit resolved to the router’s deletion leaves nothing to track', ({ assert }) => {
    const s = row({
      perchId: 'a',
      base: B,
      router: null,
      desired: content({ ...B.options, ip: '192.168.1.30' }),
      conflict: { kind: 'delete_vs_edit', options: [], detectedAt: NOW },
      status: 'conflict',
    })
    const resolved = resolveConflict(s, { take: 'router' }, ctx)!
    assert.isTrue(isGone(resolved))
    const kept = resolveConflict(s, { take: 'controller' }, ctx)!
    assert.isFalse(isGone(kept))
    assert.equal(kept.status, 'ahead', 'the next apply re-creates it')
  })
})

test.group('sync engine | section state diagram, authoritative (section 5.6)', () => {
  const B = content({ mac: '02:00:00:00:00:11', ip: '192.168.1.20' })
  const ctx = { authoritative: true, rules: hostRules }

  test('in_sync → router edit → drift → accept → in_sync', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    let s = row({ perchId: 'a', base: B, router: R, driftSince: NOW })
    assert.equal(deriveStatus(s, ctx), 'drift')
    assert.equal(deriveStatus(s, { ...ctx, authoritative: false }), 'ahead', 'two-way: never drift')
    s = acceptDrift({ ...s, status: 'drift' }, ctx)!
    assert.equal(s.status, 'in_sync')
  })

  test('drift → revert sent → reverting → confirmed → in_sync', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    let s = row({ perchId: 'a', base: B, router: R, driftSince: NOW, status: 'drift' })
    s = markInFlight(s, 'revert')
    assert.equal(s.status, 'reverting')
    assert.equal(deriveStatus(s, { ...ctx, inFlight: 'revert' }), 'reverting')
    s = markConfirmed(s, B, ctx)
    assert.equal(s.status, 'in_sync')
    assert.isNull(s.driftSince)
  })

  test('revert fails → drift stays visible', ({ assert }) => {
    const R = content({ ...B.options, ip: '192.168.1.40' })
    let s = markInFlight(
      row({ perchId: 'a', base: B, router: R, driftSince: NOW, status: 'drift' }),
      'revert'
    )
    s = markRolledBack(s, { ...ctx, now: NOW })
    assert.equal(s.status, 'drift')
  })
})

test.group('sync engine | gateway diagrams (section 5.6)', () => {
  const ok = {
    hasCapability: true,
    routerAccess: 'write' as const,
    transportOk: true,
    passwordVerified: true,
  }

  test('mode: off → observe → managed, with the preconditions', ({ assert }) => {
    assert.isNull(checkModeChange('off', 'observe', { ...ok, routerAccess: 'read' }))
    assert.equal(
      checkModeChange('off', 'observe', { ...ok, routerAccess: 'none' }),
      'router_access_insufficient'
    )
    assert.equal(
      checkModeChange('off', 'observe', { ...ok, hasCapability: false }),
      'no_capability'
    )
    assert.isNull(checkModeChange('observe', 'managed', ok))
    assert.equal(
      checkModeChange('observe', 'managed', { ...ok, routerAccess: 'read' }),
      'router_access_insufficient'
    )
    assert.equal(
      checkModeChange('observe', 'managed', { ...ok, transportOk: false }),
      'insecure_transport'
    )
    assert.equal(
      checkModeChange('observe', 'managed', { ...ok, passwordVerified: false }),
      'password_required'
    )
    assert.isNull(checkModeChange('managed', 'off', { ...ok, routerAccess: null }), 'off any time')
    assert.isNull(checkModeChange('managed', 'managed', { ...ok, routerAccess: null }))
  })

  test('apply: queued → sending → pending_confirm → confirmed | rolled_back', ({ assert }) => {
    assert.equal(nextApplyState('queued', 'send'), 'sending')
    assert.equal(nextApplyState('queued', 'expired'), 'expired')
    assert.equal(nextApplyState('queued', 'cancel'), 'cancelled')
    assert.equal(nextApplyState('sending', 'stale_base'), 'sending')
    assert.equal(nextApplyState('sending', 'refused'), 'failed')
    assert.equal(nextApplyState('sending', 'committed'), 'pending_confirm')
    assert.equal(nextApplyState('sending', 'applied'), 'confirmed', 'adopt-only')
    assert.equal(nextApplyState('pending_confirm', 'confirmed'), 'confirmed')
    assert.equal(nextApplyState('pending_confirm', 'rolled_back'), 'rolled_back')
    assert.equal(nextApplyState('pending_confirm', 'failed'), 'failed')
    assert.isNull(nextApplyState('confirmed', 'rolled_back'), 'terminal')
    assert.isNull(nextApplyState('queued', 'confirmed'))
    assert.isNull(nextApplyState('pending_confirm', 'send'))
  })

  test('sync_state rollup precedence', ({ assert }) => {
    const base = { mode: 'managed' as const, observedAt: NOW, applyInFlight: false }
    assert.equal(rollupSyncState({ ...base, mode: 'off', statuses: [] }), 'unknown')
    assert.equal(rollupSyncState({ ...base, observedAt: null, statuses: [] }), 'unknown')
    assert.equal(rollupSyncState({ ...base, statuses: [] }), 'in_sync')
    assert.equal(rollupSyncState({ ...base, statuses: ['in_sync', 'ahead'] }), 'ahead')
    assert.equal(rollupSyncState({ ...base, statuses: ['ahead', 'drift'] }), 'drift')
    assert.equal(rollupSyncState({ ...base, statuses: ['reverting'] }), 'drift')
    assert.equal(rollupSyncState({ ...base, statuses: ['drift', 'conflict'] }), 'conflict')
    assert.equal(rollupSyncState({ ...base, statuses: ['pending'] }), 'applying')
    assert.equal(
      rollupSyncState({ ...base, applyInFlight: true, statuses: ['conflict'] }),
      'applying'
    )
  })
})

// ── section 5.4: in sync and enabling Authoritative Mode ─────────────────

test.group('sync engine | "in sync" (section 5.4)', () => {
  function status(rows: SectionState[], extra: Partial<SyncStatusInput> = {}) {
    return computeSyncStatus({
      mode: 'managed',
      online: true,
      enforcement: 'active',
      headRevision: 7,
      observedAt: NOW,
      applyInFlight: false,
      luciPending: false,
      uncommitted: [],
      sections: rows,
      unledgered: [],
      registry,
      ...extra,
    })
  }
  const B = content({ mac: '02:00:00:00:00:11', ip: '192.168.1.20' })

  test('all synced sections equal and ledgered: in sync; mirrors never block', ({ assert }) => {
    const rows = [
      row({ perchId: 'a', base: B }),
      row({ perchId: 'm', base: content({ x: '1' }, 'dnsmasq'), scope: 'unmodeled', domain: null }),
      row({
        perchId: 'e',
        base: B,
        router: content({ ...B.options, ip: '192.168.1.9' }),
        scope: 'excluded',
      }),
    ]
    const s = status(rows, { uncommitted: ['network'] })
    assert.isTrue(s.inSync)
    assert.deepEqual(s.blockers, [])
    assert.deepEqual(s.uncommitted, ['network'], 'reported, not blocking')
    assert.equal(s.headRevision, 7)
  })

  test('every blocker kind', ({ assert }) => {
    const C = content({ ...B.options, ip: '192.168.1.30' })
    const R = content({ ...B.options, ip: '192.168.1.40' })
    const rows = [
      row({
        perchId: 'c',
        base: B,
        router: R,
        desired: C,
        conflict: { kind: 'options', options: [], detectedAt: NOW },
      }),
      row({ perchId: 'd', base: B, desired: C }),
      row({ perchId: 'r', base: B, router: R }),
      row({ perchId: 'n', base: null, router: R, desired: null }),
      row({ perchId: 'u', base: B }),
    ]
    const s = status(rows, {
      online: false,
      mode: 'observe',
      applyInFlight: true,
      enforcement: 'suspended',
      unledgered: ['u'],
    })
    assert.isFalse(s.inSync)
    assert.deepEqual(
      s.blockers.map((b) => ('perchId' in b ? `${b.kind}:${b.perchId}` : b.kind)),
      [
        'offline',
        'mode_not_managed',
        'apply_in_flight',
        'enforcement_suspended',
        'conflict:c',
        'controller_ahead:d',
        'unimported_section:n',
        'router_ahead:r',
        'unimported_section:u',
      ]
    )
    const ahead = s.blockers.find((b) => 'perchId' in b && b.perchId === 'd')!
    assert.deepEqual('diff' in ahead ? ahead.diff.options : null, [
      { name: 'ip', before: '192.168.1.20', after: '192.168.1.30' },
    ])
  })

  test('a pending LuCI apply means not in sync, without a blocker entry', ({ assert }) => {
    const s = status([row({ perchId: 'a', base: B })], { luciPending: true })
    assert.isFalse(s.inSync)
    assert.deepEqual(s.blockers, [])
  })

  test('enable check: sync_changed first, then not_in_sync, else ok', ({ assert }) => {
    const inSync = status([row({ perchId: 'a', base: B })])
    assert.deepEqual(checkEnableAuthoritative(inSync, 7), { ok: true })
    const changed = checkEnableAuthoritative(inSync, 6)
    assert.equal(changed.ok ? 'ok' : changed.error, 'sync_changed')
    const blocked = status([
      row({ perchId: 'd', base: B, desired: content({ ...B.options, ip: '192.168.1.30' }) }),
    ])
    const refused = checkEnableAuthoritative(blocked, 7)
    assert.equal(refused.ok ? 'ok' : refused.error, 'not_in_sync')
  })

  test('the race: a router edit after the fresh read is drift under the new mode, not a silent enable', ({
    assert,
  }) => {
    const rows = persist([], read([], [dhcpConfig()]))
    const ledger = rows
      .filter((r) => r.scope === 'synced')
      .map((r) => ({ perchId: r.perchId, config: 'dhcp', section: r.name, domain: 'dhcp_hosts' }))
    const before = status(rows, { unledgered: computeUnledgered(rows, ledger) })
    assert.deepEqual(checkEnableAuthoritative(before, 7), { ok: true })
    // Enabled. The edit that raced the switch arrives next and is judged under the new mode.
    const edited = dhcpConfig()
    edited.sections.find((s) => s.name === 'nas')!.options.ip = '192.168.1.199'
    const result = read(rows, [edited], { authoritative: true, read: { configs: [], ledger } })
    assert.equal(result.changes[0].kind, 'drift')
  })
})

test.group('sync engine | rules plumbing', () => {
  test('rulesFor maps a domain’s list semantics, normaliser and secrets', ({ assert }) => {
    const domain = {
      ...(dhcpHostsDomain as ConfigDomain),
      listSemantics: { 'zone.network': 'set' as const },
      secretOptions: ['host.hostid'],
    }
    const rules = rulesFor(domain)
    assert.equal(rules.listSemantics('zone', 'network'), 'set')
    assert.equal(rules.listSemantics('zone', 'device'), 'atomic')
    assert.isTrue(rules.isSecret('host', 'hostid'))
    assert.isTrue(rules.isSecret('host', 'password'), 'kit list')
    assert.isFalse(rules.isSecret('host', 'ip'))
    assert.deepEqual(rules.normalize('host', 'mac', '02:00:00:00:00:BB 02:00:00:00:00:aa'), [
      '02:00:00:00:00:aa',
      '02:00:00:00:00:bb',
    ])
  })
})
