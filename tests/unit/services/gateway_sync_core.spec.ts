import { planApply, planSectionEdits } from '#services/gateway_config/apply_plan'
import {
  DomainRegistry,
  rulesFor,
  typeMatches,
  type ConfigDomain,
} from '#services/gateway_config/domain'
import { domainRegistry } from '#services/gateway_config/domains/index'
import {
  featureSyncIssues,
  promoteForResolution,
  reconcileRead,
  routerConfigSet,
  type ReconcileReadInput,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import type {
  GatewayCapabilities,
  LedgerEntry,
  SectionContent,
  UciConfig,
} from '#services/gateway_config/types'
import { gatewaySyncConfig, rowsAfter } from '#tests/unit/services/fixtures/gateway_sync'
import { test } from '@japa/runner'

/**
 * Gateway sync, core extensions of the config plane (docs/design/gateway-sync/
 * domains.md 1, work package B0, Phase A parts): wildcard section types,
 * capability-gated claims and the downgrade path, re-homing a synced section,
 * excluded members leaving the identity-key census, promoting ambiguous
 * mirrors for resolution, and the planner's adopt-before-delete.
 */

const NOW = '2026-09-30T10:00:00.000Z'

// ── test domains ────────────────────────────────────────────────────────

/** Verbatim domain over `thing` sections of config `lab` (optionally only some). */
function thingDomain(
  key: string,
  extra: Partial<ConfigDomain> & { when?: (options: Record<string, unknown>) => boolean } = {}
): ConfigDomain {
  const { when, ...rest } = extra
  return {
    key,
    configs: ['lab'],
    types: ['thing'],
    claims: (s) => s.config === 'lab' && s.type === 'thing' && (when ? when(s.options) : true),
    parse: (sections) => sections.map((s) => ({ ...s })),
    render: (obj) => {
      const s = obj as { perchId: string; type: string; options: Record<string, string> }
      return [{ op: 'put', perchId: s.perchId, config: 'lab', type: s.type, options: s.options }]
    },
    validate: () => [],
    ...rest,
  }
}

const gated = (feature: string) => (caps: GatewayCapabilities) =>
  (caps.features ?? []).includes(feature) ? null : `needs ${feature}`

function labConfig(sections: Array<{ name: string; options: Record<string, string> }>): UciConfig {
  return {
    name: 'lab',
    hash: 'h1',
    sections: sections.map((s, index) => ({
      name: s.name,
      type: 'thing',
      anonymous: false,
      index,
      options: s.options,
    })),
  }
}

function content(options: Record<string, string>, type = 'thing'): SectionContent {
  return { type, options }
}

function syncedRow(partial: Partial<SectionState> & { perchId: string }): SectionState {
  const c = partial.base ?? null
  return {
    config: 'lab',
    name: partial.perchId,
    type: 'thing',
    anonymous: false,
    scope: 'synced',
    domain: 'a',
    ownership: null,
    issue: null,
    base: c,
    baseRevision: null,
    router: c,
    desired: c,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: 0,
    ...partial,
  }
}

let ids = 0
function read(
  registry: DomainRegistry,
  rows: SectionState[],
  configs: UciConfig[],
  extra: Partial<ReconcileReadInput> = {}
) {
  ids = 0
  return reconcileRead({
    rows,
    read: { configs, ledger: [] },
    registry,
    mode: 'managed',
    authoritative: false,
    now: NOW,
    newPerchId: () => `n${++ids}`,
    ...extra,
  })
}

// ── 1.1 wildcard types ──────────────────────────────────────────────────

test.group('gateway sync core | wildcard section types (1.1)', () => {
  test('a `*` entry matches section types by prefix; others must be equal', ({ assert }) => {
    assert.isTrue(typeMatches(['interface', 'wireguard_*'], 'wireguard_wg0'))
    assert.isTrue(typeMatches(['interface', 'wireguard_*'], 'interface'))
    assert.isFalse(typeMatches(['interface', 'wireguard_*'], 'wireguard'))
    assert.isFalse(typeMatches(['interface'], 'interfaces'))

    const wg: ConfigDomain = {
      ...thingDomain('wg'),
      configs: ['network'],
      types: ['wireguard_*'],
      claims: () => true,
      listSemantics: { 'wireguard_*.allowed_ips': 'set', 'wireguard_wg9.allowed_ips': 'atomic' },
    }
    const registry = new DomainRegistry([wg])
    const peer = {
      config: 'network',
      name: 'cfg1339b3',
      type: 'wireguard_wg0',
      anonymous: true,
      index: 0,
      options: {},
    }
    assert.equal(registry.claim(peer, {})?.domain.key, 'wg')
    assert.isNull(registry.claim({ ...peer, type: 'interface' }, {}))
    const rules = rulesFor(wg)
    assert.equal(rules.listSemantics('wireguard_wg0', 'allowed_ips'), 'set')
    assert.equal(rules.listSemantics('wireguard_wg9', 'allowed_ips'), 'atomic', 'exact key first')
    assert.equal(rules.listSemantics('wireguard_wg0', 'endpoint_host'), 'atomic')
  })
})

// ── 1.2 capability-gated claims ─────────────────────────────────────────

test.group('gateway sync core | capability-gated claims (1.2)', () => {
  const gatedDomain = thingDomain('a', { requires: gated('config.test.v1') })
  const fallback = thingDomain('fallback', { when: (o) => o.kind === 'plain' })
  const registry = new DomainRegistry([gatedDomain, fallback])
  const lab = labConfig([
    { name: 'one', options: { kind: 'x', value: '1' } },
    { name: 'two', options: { kind: 'plain', value: '2' } },
  ])
  const all = { lab }
  const withFeature: GatewayCapabilities = { features: ['config.test.v1'] }
  const without: GatewayCapabilities = { features: [] }

  test('claim skips a domain whose requirement is missing; no capabilities, no gating', ({
    assert,
  }) => {
    const one = { ...lab.sections[0], config: 'lab' }
    const two = { ...lab.sections[1], config: 'lab' }
    assert.equal(registry.claim(one, all)?.domain.key, 'a')
    assert.equal(registry.claim(one, all, null)?.domain.key, 'a')
    assert.equal(registry.claim(one, all, withFeature)?.domain.key, 'a')
    assert.isNull(registry.claim(one, all, without))
    assert.equal(registry.claim(two, all, without)?.domain.key, 'fallback', 'the next domain')
    assert.deepEqual([...registry.unavailable(without)], [['a', 'needs config.test.v1']])
    assert.equal(registry.unavailable(null).size, 0)
  })

  test('new sections of an unavailable domain stay mirrors; the feature promotes them', ({
    assert,
  }) => {
    const first = read(registry, [], [lab], { capabilities: without })
    const rows = rowsAfter([], first.changes)
    const one = rows.find((r) => r.name === 'one')!
    assert.equal(one.scope, 'unmodeled')
    assert.isNull(one.domain)
    assert.equal(rows.find((r) => r.name === 'two')!.domain, 'fallback')

    const second = read(registry, rows, [lab], { capabilities: withFeature })
    const promoted = rowsAfter(rows, second.changes).find((r) => r.name === 'one')!
    assert.equal(promoted.scope, 'synced')
    assert.equal(promoted.domain, 'a')
    assert.deepEqual(promoted.base, promoted.router)
    assert.deepEqual(promoted.desired, promoted.router)
    assert.isTrue(second.changes.find((c) => c.perchId === one.perchId)!.baseChanged)
  })

  test('downgrade: a synced row follows the router, never drift, a clean draft is kept', ({
    assert,
  }) => {
    const B = content({ kind: 'x', value: '1', note: 'a' })
    const row = syncedRow({
      perchId: 'one',
      base: B,
      router: B,
      desired: content({ kind: 'x', value: '1', note: 'draft' }),
      status: 'ahead',
    })
    const edited = labConfig([{ name: 'one', options: { kind: 'x', value: '9', note: 'a' } }])
    const result = read(new DomainRegistry([gatedDomain]), [row], [edited], {
      capabilities: without,
      authoritative: true,
    })
    const after = result.changes[0].after!
    assert.equal(after.scope, 'synced')
    assert.equal(after.domain, 'a')
    assert.deepEqual(after.base!.options, { kind: 'x', value: '9', note: 'a' }, 'B := R')
    assert.deepEqual(after.desired!.options, { kind: 'x', value: '9', note: 'draft' })
    assert.equal(after.status, 'ahead', 'never drift, even under Authoritative Mode')
    assert.isNull(after.driftSince)
    assert.equal(result.events[0].detail?.capabilityMissing, 'needs config.test.v1')

    // A draft that would conflict with the router's edit is dropped (the router wins).
    const clash = read(
      new DomainRegistry([gatedDomain]),
      [{ ...row, desired: content({ kind: 'x', value: '5', note: 'a' }) }],
      [edited],
      { capabilities: without }
    ).changes[0].after!
    assert.deepEqual(clash.desired, clash.router)
    assert.isNull(clash.conflict)
  })

  test('the planner refuses an unavailable domain; the sync status names it', ({ assert }) => {
    const B = content({ kind: 'x', value: '1' })
    const rows = [
      syncedRow({
        perchId: 'one',
        base: B,
        router: B,
        desired: content({ kind: 'x', value: '2' }),
      }),
    ]
    const input = {
      sections: rows,
      kind: 'apply' as const,
      ledger: [],
      hashes: { lab: 'h1' },
      management: null,
      registry,
    }
    assert.lengthOf(planApply(input).jobs, 1, 'without capabilities nothing is gated')
    const refused = planApply({ ...input, perchIds: ['one'], capabilities: without })
    assert.lengthOf(refused.jobs, 0)
    assert.deepEqual(refused.blocked, [
      {
        perchId: 'one',
        config: 'lab',
        section: 'one',
        reason: 'capability_missing',
        detail: 'needs config.test.v1',
      },
    ])
    assert.lengthOf(planApply({ ...input, capabilities: without }).jobs, 0)
    assert.lengthOf(planApply({ ...input, capabilities: withFeature }).jobs, 1)

    const issues = featureSyncIssues(registry, rows, {}, without)
    assert.deepEqual(issues, [
      {
        feature: 'a',
        objectId: null,
        code: 'capability_missing',
        message: 'needs config.test.v1',
      },
    ])
    assert.deepEqual(featureSyncIssues(registry, rows, {}, withFeature), [])
  })
})

// ── 1.3 re-homing ───────────────────────────────────────────────────────

test.group('gateway sync core | re-homing a synced section (1.3)', () => {
  const B = content({ side: 'wan', value: '1' })
  const lab = labConfig([{ name: 'globe_force', options: { side: 'wan', value: '1' } }])
  const oldReg = new DomainRegistry([thingDomain('networks')])
  const newReg = new DomainRegistry([
    thingDomain('wan', {
      when: (o) => o.side === 'wan',
      ownership: () => ({ kind: 'options', options: ['value'] }),
    }),
    thingDomain('networks', { when: (o) => o.side !== 'wan' }),
  ])
  const row = () =>
    syncedRow({
      perchId: 'gf',
      name: 'globe_force',
      domain: 'networks',
      base: B,
      router: B,
      desired: B,
    })

  test('a settled row moves to the domain that claims it now, B/C/R kept', ({ assert }) => {
    assert.lengthOf(read(oldReg, [row()], [lab]).changes, 0, 'same claim: nothing moves')
    const result = read(newReg, [row()], [lab])
    assert.lengthOf(result.changes, 1)
    const change = result.changes[0]
    assert.equal(change.kind, 'rescoped')
    assert.isFalse(change.baseChanged)
    assert.equal(change.after!.scope, 'synced')
    assert.equal(change.after!.domain, 'wan')
    assert.deepEqual(change.after!.ownership, { kind: 'options', options: ['value'] })
    assert.deepEqual(change.after!.base, B)
    assert.deepEqual(change.after!.desired, B)
    assert.equal(change.after!.status, 'in_sync')
    assert.deepEqual(
      result.events.map((e) => [e.event, e.detail]),
      [['section_rehomed', { from: 'networks', to: 'wan' }]]
    )
  })

  test('a row with a draft waits (rehome_deferred), in flight too', ({ assert }) => {
    const ahead = {
      ...row(),
      desired: content({ side: 'wan', value: '2' }),
      status: 'ahead' as const,
    }
    const result = read(newReg, [ahead], [lab])
    assert.isFalse(result.changes.some((c) => c.after?.domain === 'wan'))
    assert.deepEqual(
      result.events.map((e) => [e.event, e.detail]),
      [['rehome_deferred', { from: 'networks', to: 'wan' }]]
    )
    const flying = read(newReg, [row()], [lab], { inFlight: new Map([['gf', 'apply']]) })
    assert.lengthOf(flying.changes, 0)
    assert.lengthOf(flying.events, 0)
  })

  test('no domain claims it: left as it is; a failed round trip: no_round_trip', ({ assert }) => {
    // Domains write sections they would not import (the firewall's device-group
    // ipsets): an unclaimed synced row is not re-homed.
    const none = read(
      new DomainRegistry([thingDomain('other', { when: () => false })]),
      [row()],
      [lab]
    )
    assert.lengthOf(none.changes, 0)
    assert.lengthOf(none.events, 0)

    const lossy = thingDomain('wan', {
      render: (obj) => {
        const s = obj as { perchId: string; options: Record<string, string> }
        return [{ op: 'put', perchId: s.perchId, config: 'lab', type: 'thing', options: {} }]
      },
    })
    const broken = read(new DomainRegistry([lossy]), [row()], [lab])
    assert.equal(broken.changes[0].after!.scope, 'unmodeled')
    assert.equal(broken.changes[0].after!.issue, 'no_round_trip')
    assert.equal(broken.changes[0].after!.domain, 'wan')
  })

  test('the next job touching the config re-links the ledger entry to the new domain', ({
    assert,
  }) => {
    const rehomed = { ...row(), domain: 'wan' }
    const other = syncedRow({
      perchId: 'o1',
      name: 'other',
      domain: 'wan',
      base: content({ side: 'wan', value: '1' }),
      desired: content({ side: 'wan', value: '3' }),
    })
    const ledger: LedgerEntry[] = [
      { perchId: 'gf', config: 'lab', section: 'globe_force', domain: 'networks' },
      { perchId: 'o1', config: 'lab', section: 'other', domain: 'wan' },
    ]
    const plan = planApply({
      sections: [rehomed, other],
      perchIds: ['o1'],
      kind: 'apply',
      ledger,
      hashes: { lab: 'h1' },
      management: null,
      registry: newReg,
    })
    assert.deepEqual(plan.jobs[0].ledger.set, [
      { perchId: 'gf', config: 'lab', section: 'globe_force', domain: 'wan' },
    ])
    // An adopted entry (no domain) is left alone.
    const adopted = planApply({
      sections: [rehomed, other],
      perchIds: ['o1'],
      kind: 'apply',
      ledger: [{ ...ledger[0], domain: '' }, ledger[1]],
      hashes: { lab: 'h1' },
      management: null,
      registry: newReg,
    })
    assert.deepEqual(adopted.jobs[0].ledger.set, [])
  })
})

// ── 1.4 ambiguity: census, promotion, planning ──────────────────────────

test.group('gateway sync core | ambiguity (1.4) on the four-redirect fixture', () => {
  const firewall = () => gatewaySyncConfig('firewall')
  const registry = domainRegistry()

  function firstRead() {
    const result = read(registry, [], [firewall()])
    return rowsAfter([], result.changes)
  }
  const redirect = (rows: SectionState[], name: string) =>
    rows.filter((r) => r.type === 'redirect' && r.router?.options.name === name)

  test('two GAME and WGX/wgx redirects are ambiguous mirrors; the others sync', ({ assert }) => {
    const rows = firstRead()
    const ambiguous = rows.filter((r) => r.issue === 'ambiguous')
    assert.sameMembers(
      ambiguous.map((r) => r.router!.options.name as string),
      ['GAME', 'GAME', 'WGX', 'wgx']
    )
    for (const r of ambiguous) {
      assert.equal(r.scope, 'unmodeled')
      assert.equal(r.domain, 'firewall')
    }
    assert.equal(redirect(rows, 'NAS')[0].scope, 'synced')
    assert.equal(redirect(rows, 'Intercept-DNS')[0].scope, 'synced')
    const blockers = featureSyncIssues(registry, rows, {})
    assert.lengthOf(
      blockers.filter((b) => b.code === 'section_ambiguous'),
      4,
      'they block Authoritative Mode'
    )
  })

  test('excluding one member of a pair promotes the other on the next read', ({ assert }) => {
    const rows = firstRead()
    const [first, second] = redirect(rows, 'GAME')
    const excluded = rows.map((r) =>
      r.perchId === first.perchId ? { ...r, scope: 'excluded' as const } : r
    )
    const next = rowsAfter(excluded, read(registry, excluded, [firewall()]).changes)
    const byId = (id: string) => next.find((r) => r.perchId === id)!
    assert.equal(byId(first.perchId).scope, 'excluded')
    assert.equal(byId(first.perchId).issue, 'ambiguous', 'the exclusion keeps its issue')
    assert.equal(byId(second.perchId).scope, 'synced')
    assert.isNull(byId(second.perchId).issue)
    assert.lengthOf(
      next.filter((r) => r.issue === 'ambiguous' && r.scope === 'unmodeled'),
      2,
      'WGX and wgx are still ambiguous'
    )
  })

  test('promoteForResolution: B = R = C synced rows with the domain ownership', ({ assert }) => {
    const rows = firstRead()
    const four = rows.filter((r) => r.issue === 'ambiguous').map((r) => r.perchId)
    const nas = redirect(rows, 'NAS')[0].perchId
    const { promoted, refused } = promoteForResolution(rows, [...four, nas], registry)
    assert.deepEqual(refused, [{ perchId: nas, reason: 'not_ambiguous' }])
    assert.lengthOf(promoted, 4)
    for (const p of promoted) {
      assert.equal(p.scope, 'synced')
      assert.equal(p.domain, 'firewall')
      assert.isNull(p.issue)
      assert.isNull(p.ownership, 'the firewall owns whole sections')
      assert.deepEqual(p.base, p.router)
      assert.deepEqual(p.desired, p.router)
    }
    // A later read matches them by name: nothing is ambiguous any more.
    const merged = rowsAfter(
      rows,
      promoted.map((p) => ({ perchId: p.perchId, after: p }))
    )
    const again = rowsAfter(merged, read(registry, merged, [firewall()]).changes)
    assert.lengthOf(
      again.filter((r) => r.issue === 'ambiguous'),
      0
    )
    assert.lengthOf(
      again.filter((r) => r.type === 'redirect' && r.scope === 'synced'),
      7
    )
  })

  test('rename three, delete one: one job, adopt (renamed) + put / delete per member', ({
    assert,
  }) => {
    const rows = firstRead()
    const games = redirect(rows, 'GAME')
    const wgx = [...redirect(rows, 'WGX'), ...redirect(rows, 'wgx')]
    const four = [...games, ...wgx]
    const { promoted } = promoteForResolution(
      rows,
      four.map((r) => r.perchId),
      registry
    )
    const candidate = rowsAfter(
      rows,
      promoted.map((p) => ({ perchId: p.perchId, after: p }))
    )
    const rename = (r: SectionState, name: string) => ({
      op: 'put' as const,
      perchId: r.perchId,
      config: 'firewall',
      type: 'redirect',
      options: { ...r.router!.options, name },
    })
    const edits = planSectionEdits({
      rows: candidate,
      edits: [
        rename(games[0], 'GAME 25500-25600'),
        rename(games[1], 'GAME 45565'),
        rename(wgx[0], 'WGX 63329'),
        { op: 'delete', perchId: wgx[1].perchId },
      ],
      domain: 'firewall',
      registry,
      authoritative: false,
      newPerchId: () => 'unused',
    })
    const drafted = rowsAfter(
      candidate,
      edits.upserts.map((u) => ({ perchId: u.perchId, after: u }))
    )
    const plan = planApply({
      sections: drafted,
      perchIds: four.map((r) => r.perchId),
      kind: 'apply',
      ledger: [],
      hashes: { firewall: 'fixture' },
      management: { network: 'lan', device: 'br-lan' },
      registry,
    })
    assert.lengthOf(plan.jobs, 1)
    const job = plan.jobs[0]
    assert.equal(job.kind, 'apply')
    assert.isFalse(job.protected)
    assert.sameMembers(
      job.perchIds,
      four.map((r) => r.perchId)
    )
    const ops = job.ops.map((op) =>
      op.op === 'adopt'
        ? `adopt:${op.section}>${op.renameTo}`
        : op.op === 'order'
          ? 'order'
          : `${op.op}:${op.section}`
    )
    const id = (r: SectionState) => `perch_${r.perchId}`
    assert.sameMembers(ops, [
      `adopt:${games[0].name}>${id(games[0])}`,
      `adopt:${games[1].name}>${id(games[1])}`,
      `adopt:${wgx[0].name}>${id(wgx[0])}`,
      `adopt:${wgx[1].name}>${id(wgx[1])}`,
      `delete:${id(wgx[1])}`,
      `put:${id(games[0])}`,
      `put:${id(games[1])}`,
      `put:${id(wgx[0])}`,
    ])
    const deleted = job.changes.find((c) => c.perchId === wgx[1].perchId)!
    assert.equal(deleted.action, 'delete')
    assert.equal(deleted.section, wgx[1].name, 'shown under the router name')
  })

  test('routerConfigSet rebuilds the router side of the rows in file order', ({ assert }) => {
    const rows = firstRead()
    const set = routerConfigSet(rows)
    assert.deepEqual(
      set.firewall.sections.map((s) => s.name),
      firewall().sections.map((s) => s.name)
    )
  })
})

// ── the planner: sections the agent does not own yet ────────────────────

test.group('gateway sync core | deleting an imported section (agent ownership)', () => {
  test('a named unledgered section is adopted, then deleted; an anonymous one renamed', ({
    assert,
  }) => {
    const domain = thingDomain('a')
    const registry = new DomainRegistry([domain])
    const B = content({ value: '1' })
    const named = syncedRow({ perchId: 'n1', name: 'kept', base: B, router: B, desired: null })
    const anon = syncedRow({
      perchId: 'a1',
      name: 'cfg0a3837',
      anonymous: true,
      base: B,
      router: B,
      desired: null,
    })
    const owned = syncedRow({ perchId: 'o1', name: 'perch_o1', base: B, router: B, desired: null })
    const plan = planApply({
      sections: [named, anon, owned],
      kind: 'apply',
      ledger: [{ perchId: 'o1', config: 'lab', section: 'perch_o1', domain: 'a' }],
      hashes: { lab: 'h1' },
      management: null,
      registry,
    })
    const ops = plan.jobs[0].ops.map((op) =>
      op.op === 'adopt'
        ? `adopt:${op.section}>${op.renameTo ?? ''}`
        : `${op.op}:${'section' in op ? op.section : ''}`
    )
    assert.deepEqual(ops, [
      'adopt:cfg0a3837>perch_a1',
      'adopt:kept>',
      'delete:perch_a1',
      'delete:kept',
      'delete:perch_o1',
    ])
    assert.deepEqual(plan.jobs[0].ledger.remove, ['o1'])
  })
})
