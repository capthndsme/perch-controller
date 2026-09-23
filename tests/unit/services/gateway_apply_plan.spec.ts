import {
  EditRefusedError,
  mergeOrder,
  planApply,
  planSectionEdits,
  touchesManagementPath,
  type PlanApplyInput,
} from '#services/gateway_config/apply_plan'
import {
  CONFIG_APPLY_ORDER,
  DomainRegistry,
  type ConfigDomain,
} from '#services/gateway_config/domain'
import { dhcpHostsDomain } from '#services/gateway_config/domains/dhcp_hosts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { LedgerEntry, ManagementPath, SectionContent } from '#services/gateway_config/types'
import { test } from '@japa/runner'

const registry = new DomainRegistry([dhcpHostsDomain as ConfigDomain])
const LAN: ManagementPath = { network: 'lan', device: 'br-lan' }

function content(options: SectionContent['options'], type: string): SectionContent {
  return { type, options }
}

function row(partial: Partial<SectionState> & { perchId: string; config: string }): SectionState {
  const c = partial.base ?? null
  return {
    name: `perch_${partial.perchId}`,
    type: c?.type ?? 'host',
    anonymous: false,
    scope: 'synced',
    domain: null,
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

function ledgerOf(rows: SectionState[]): LedgerEntry[] {
  return rows
    .filter((r) => r.scope === 'synced' && r.router)
    .map((r) => ({ perchId: r.perchId, config: r.config, section: r.name, domain: r.domain ?? '' }))
}

function plan(rows: SectionState[], extra: Partial<PlanApplyInput> = {}) {
  return planApply({
    sections: rows,
    kind: 'apply',
    ledger: ledgerOf(rows),
    hashes: { network: 'n1', dhcp: 'd1', firewall: 'f1', system: 's1', sqm: 'q1', opennds: 'o1' },
    management: LAN,
    registry,
    ...extra,
  })
}

const HOST = content({ mac: '02:00:00:00:00:11', ip: '192.168.1.20' }, 'host')

test.group('apply planning | ops and order (README 3.5)', () => {
  test('nothing to do: no jobs', ({ assert }) => {
    assert.deepEqual(plan([row({ perchId: 'h1', config: 'dhcp', base: HOST })]), {
      jobs: [],
      blocked: [],
    })
  })

  test('configs in apply order; adopt, delete, put, order within a config', ({ assert }) => {
    const guest = content(
      { device: 'br-guest', proto: 'static', ipaddr: ['192.168.3.1/24'] },
      'interface'
    )
    const rows = [
      row({
        perchId: 'q',
        config: 'sqm',
        base: content({ enabled: '1' }, 'queue'),
        desired: content({ enabled: '0' }, 'queue'),
      }),
      row({
        perchId: 'f',
        config: 'firewall',
        base: content({ name: 'x', src: 'lan' }, 'rule'),
        desired: null,
      }),
      row({
        perchId: 'h',
        config: 'dhcp',
        base: HOST,
        desired: content({ ...HOST.options, ip: '192.168.1.30' }, 'host'),
      }),
      row({
        perchId: 'g',
        config: 'network',
        base: guest,
        desired: content({ ...guest.options, proto: 'none' }, 'interface'),
      }),
      row({
        perchId: 's',
        config: 'system',
        base: content({ hostname: 'gw' }, 'system'),
        desired: content({ hostname: 'gw2' }, 'system'),
      }),
      row({
        perchId: 'o',
        config: 'opennds',
        base: content({ enabled: '0' }, 'opennds'),
        desired: content({ enabled: '1' }, 'opennds'),
      }),
    ]
    const { jobs } = plan(rows)
    assert.lengthOf(jobs, 1)
    const job = jobs[0]
    assert.equal(job.kind, 'apply')
    assert.isFalse(job.protected)
    assert.deepEqual(job.configs, ['system', 'network', 'dhcp', 'firewall', 'sqm', 'opennds'])
    assert.deepEqual(
      job.ops.map((op) => `${op.config}:${op.op}`),
      ['system:put', 'network:put', 'dhcp:put', 'firewall:delete', 'sqm:put', 'opennds:put']
    )
    assert.deepEqual(job.base, {
      system: 's1',
      network: 'n1',
      dhcp: 'd1',
      firewall: 'f1',
      sqm: 'q1',
      opennds: 'o1',
    })
    assert.deepEqual(job.ledger, { set: [], remove: ['f'] })
    assert.deepEqual(CONFIG_APPLY_ORDER.slice(0, 4), ['system', 'network', 'dhcp', 'firewall'])
  })

  test('a new controller section: put under perch_<id> and a ledger entry', ({ assert }) => {
    const rows = [
      row({
        perchId: 'n1',
        config: 'dhcp',
        domain: 'dhcp_hosts',
        base: null,
        router: null,
        desired: HOST,
      }),
    ]
    const job = plan(rows).jobs[0]
    assert.deepEqual(job.ops, [
      {
        op: 'put',
        config: 'dhcp',
        section: 'perch_n1',
        type: 'host',
        options: { ...HOST.options },
      },
    ])
    assert.deepEqual(job.ledger.set, [
      { perchId: 'n1', config: 'dhcp', section: 'perch_n1', domain: 'dhcp_hosts' },
    ])
    assert.deepEqual(job.changes[0].action, 'create')
    assert.deepEqual(job.written, { n1: HOST })
  })

  test('put writes owned options from C and router-owned ones from the latest R', ({ assert }) => {
    const ownership = { kind: 'options' as const, options: ['mac', 'ip'] }
    const R = content({ ...HOST.options, tag: 'luci-set-this' }, 'host')
    const C = content({ ...HOST.options, ip: '192.168.1.30', tag: 'stale' }, 'host')
    const rows = [
      row({ perchId: 'h', config: 'dhcp', base: HOST, router: R, desired: C, ownership }),
    ]
    const job = plan(rows).jobs[0]
    assert.deepEqual(job.ops[0], {
      op: 'put',
      config: 'dhcp',
      section: 'perch_h',
      type: 'host',
      options: { mac: '02:00:00:00:00:11', ip: '192.168.1.30', tag: 'luci-set-this' },
    })
  })

  test('adoption: named sections get an adopt-only job; anonymous ones are renamed in a normal apply', ({
    assert,
  }) => {
    const named = row({
      perchId: 'a1',
      config: 'dhcp',
      name: 'nas',
      base: HOST,
      domain: 'dhcp_hosts',
    })
    const anon = row({
      perchId: 'a2',
      config: 'dhcp',
      name: 'cfg07fe63',
      anonymous: true,
      base: HOST,
      domain: 'dhcp_hosts',
    })
    const { jobs } = plan([named, anon], { ledger: [] })
    assert.deepEqual(
      jobs.map((j) => j.kind),
      ['adopt', 'apply']
    )
    assert.deepEqual(jobs[0].ops, [{ op: 'adopt', config: 'dhcp', section: 'nas', perchId: 'a1' }])
    assert.deepEqual(
      jobs[0].changes.map((c) => c.action),
      ['adopt']
    )
    assert.deepEqual(jobs[1].ops, [
      { op: 'adopt', config: 'dhcp', section: 'cfg07fe63', perchId: 'a2', renameTo: 'perch_a2' },
    ])
  })

  test('an unledgered anonymous section with an edit: adopt+rename, then put on the new name', ({
    assert,
  }) => {
    const anon = row({
      perchId: 'a2',
      config: 'dhcp',
      name: 'cfg07fe63',
      anonymous: true,
      base: HOST,
      desired: content({ ...HOST.options, ip: '192.168.1.31' }, 'host'),
    })
    const job = plan([anon], { ledger: [] }).jobs[0]
    assert.deepEqual(
      job.ops.map((op) => [op.op, 'section' in op ? op.section : null]),
      [
        ['adopt', 'cfg07fe63'],
        ['put', 'perch_a2'],
      ]
    )
    assert.equal(job.changes[0].action, 'adopt')
  })

  test('conflicts are blocked; excluded and unmodeled rows are skipped unless asked for', ({
    assert,
  }) => {
    const rows = [
      row({
        perchId: 'c',
        config: 'dhcp',
        base: HOST,
        desired: null,
        conflict: { kind: 'options', options: [], detectedAt: 'x' },
      }),
      row({ perchId: 'u', config: 'dhcp', base: HOST, scope: 'unmodeled' }),
    ]
    assert.deepEqual(plan(rows).blocked, [
      { perchId: 'c', config: 'dhcp', section: 'perch_c', reason: 'conflict' },
    ])
    assert.deepEqual(plan(rows, { perchIds: ['u'] }).blocked, [
      { perchId: 'u', config: 'dhcp', section: 'perch_u', reason: 'not_synced' },
    ])
  })

  test('secrets: controller values by ref, router-owned values kept', ({ assert }) => {
    const base: SectionContent = {
      type: 'interface',
      options: { proto: 'wireguard' },
      secrets: { private_key: { fingerprint: 'hmac:0000000000000001' } },
    }
    const desired: SectionContent = {
      type: 'interface',
      options: { proto: 'wireguard', listen_port: '51820' },
      secrets: {
        private_key: { fingerprint: 'hmac:0000000000000002', ref: 's7' },
        preshared_key: { fingerprint: 'hmac:0000000000000003' },
      },
    }
    const rows = [row({ perchId: 'w', config: 'network', name: 'wg0', base, desired })]
    const job = plan(rows, { management: null }).jobs[0]
    assert.deepEqual(job.ops[0], {
      op: 'put',
      config: 'network',
      section: 'wg0',
      type: 'interface',
      options: {
        proto: 'wireguard',
        listen_port: '51820',
        private_key: { $secret: 's7' },
        preshared_key: { $keep: true },
      },
    })
    assert.deepEqual(job.secretRefs, ['s7'])
    assert.isTrue(job.changes[0].options.some((o) => o.name === 'private_key' && o.secret))
  })

  test('stale ledger entries (rescoped or vanished rows) ride with the next job', ({ assert }) => {
    const rows = [
      row({
        perchId: 'h',
        config: 'dhcp',
        base: HOST,
        desired: content({ ...HOST.options, ip: '192.168.1.30' }, 'host'),
      }),
      row({ perchId: 'x', config: 'dhcp', name: 'vendor', base: HOST, scope: 'unmodeled' }),
    ]
    const ledger = [
      ...ledgerOf(rows.slice(0, 1)),
      { perchId: 'x', config: 'dhcp', section: 'vendor', domain: 'dhcp_hosts' },
      { perchId: 'gone', config: 'dhcp', section: 'perch_gone', domain: 'dhcp_hosts' },
    ]
    const { jobs } = plan(rows, { ledger })
    assert.deepEqual(jobs[0].ledger.remove, ['x', 'gone'])
    const only = plan([rows[1]], { ledger: ledger.slice(1) })
    assert.deepEqual(
      only.jobs.map((j) => [j.kind, j.ops.length, j.ledger.remove]),
      [['adopt', 0, ['x', 'gone']]]
    )
  })

  test('order ops use the names after adoption', ({ assert }) => {
    const rule = (id: string, name: string, anonymous = false) =>
      row({
        perchId: id,
        config: 'firewall',
        name,
        anonymous,
        base: content({ name: id, src: 'wan' }, 'rule'),
        desired: content({ name: id, src: 'wan', target: 'DROP' }, 'rule'),
      })
    const rows = [rule('r1', 'cfg0a', true), rule('r2', 'perch_r2')]
    const job = plan(rows, {
      ledger: [{ perchId: 'r2', config: 'firewall', section: 'perch_r2', domain: 'firewall' }],
      orders: [{ config: 'firewall', type: 'rule', perchIds: ['r2', 'r1'] }],
    }).jobs[0]
    assert.deepEqual(job.ops.at(-1), {
      op: 'order',
      config: 'firewall',
      type: 'rule',
      sections: ['perch_r2', 'perch_r1'],
    })
  })
})

test.group('apply planning | management path (README 3.8)', () => {
  const lanIface = content(
    { device: 'br-lan', proto: 'static', ipaddr: ['192.168.1.1/24'] },
    'interface'
  )

  test('changes on the management network get their own protected job, after the rest', ({
    assert,
  }) => {
    const rows = [
      row({
        perchId: 'lan',
        config: 'network',
        name: 'lan',
        base: lanIface,
        desired: content({ ...lanIface.options, ipaddr: ['192.168.1.1/23'] }, 'interface'),
      }),
      row({
        perchId: 'h',
        config: 'dhcp',
        base: HOST,
        desired: content({ ...HOST.options, ip: '192.168.1.30' }, 'host'),
      }),
    ]
    const { jobs } = plan(rows)
    assert.deepEqual(
      jobs.map((j) => [j.kind, j.protected, j.perchIds]),
      [
        ['apply', false, ['h']],
        ['apply', true, ['lan']],
      ]
    )
    assert.deepEqual(jobs[1].base, { network: 'n1' })
  })

  test('built-in rules', ({ assert }) => {
    const t = (config: string, name: string, c: SectionContent, path: ManagementPath = LAN) =>
      touchesManagementPath(config, name, c, path)
    assert.isTrue(t('network', 'lan', lanIface))
    assert.isTrue(t('network', 'other', content({ device: 'br-lan', proto: 'none' }, 'interface')))
    assert.isFalse(
      t('network', 'guest', content({ device: 'br-guest', proto: 'static' }, 'interface'))
    )
    assert.isTrue(
      t('network', 'cfg1', content({ name: 'br-lan', type: 'bridge', ports: ['lan1'] }, 'device'))
    )
    assert.isTrue(
      t('network', 'cfg1', content({ name: 'br-lan', type: 'bridge' }, 'device'), {
        network: 'lan',
        device: 'br-lan.1',
      }),
      'the parent bridge of a VLAN device'
    )
    assert.isTrue(
      t(
        'network',
        'v1',
        content({ device: 'br-lan', vlan: '1', ports: ['lan1:u*'] }, 'bridge-vlan'),
        { network: 'lan', device: 'br-lan.1' }
      )
    )
    assert.isFalse(
      t(
        'network',
        'v20',
        content({ device: 'br-lan', vlan: '20', ports: ['lan1:t'] }, 'bridge-vlan'),
        { network: 'lan', device: 'br-lan.1' }
      )
    )
    assert.isTrue(t('firewall', 'cfg02', content({ name: 'lan', network: ['lan'] }, 'zone')))
    assert.isTrue(t('firewall', 'cfg02', content({ name: 'lan', network: 'lan guest' }, 'zone')))
    assert.isFalse(t('firewall', 'cfg03', content({ name: 'guest', network: ['guest'] }, 'zone')))
    assert.isTrue(t('firewall', 'cfg01', content({ input: 'REJECT' }, 'defaults')))
    assert.isFalse(
      t('dhcp', 'lan', content({ interface: 'lan' }, 'dhcp')),
      'pools bite later, not here'
    )
    assert.isFalse(touchesManagementPath('network', 'lan', lanIface, null))
  })

  test('a domain can add its own rule', ({ assert }) => {
    const domain: ConfigDomain = {
      ...(dhcpHostsDomain as ConfigDomain),
      key: 'controller_host',
      touchesManagement: (section) => section.options.ip === '192.168.1.10',
    }
    const reg = new DomainRegistry([domain])
    assert.isTrue(
      touchesManagementPath(
        'dhcp',
        'h',
        content({ mac: '02:00:00:00:00:10', ip: '192.168.1.10' }, 'host'),
        LAN,
        reg,
        'controller_host'
      )
    )
  })

  test('a section moved onto the management path is protected too (old or new content)', ({
    assert,
  }) => {
    const guest = content({ device: 'br-guest', proto: 'static' }, 'interface')
    const rows = [
      row({
        perchId: 'x',
        config: 'network',
        name: 'x',
        base: guest,
        desired: content({ device: 'br-lan', proto: 'static' }, 'interface'),
      }),
    ]
    assert.isTrue(plan(rows).jobs[0].protected)
  })
})

test.group('apply planning | Authoritative revert', () => {
  test('a revert plans only drifted sections: re-create, restore, delete the unimported', ({
    assert,
  }) => {
    const R = content({ ...HOST.options, ip: '192.168.1.99' }, 'host')
    const extra = content({ mac: '02:00:00:00:00:71', ip: '192.168.1.71' }, 'host')
    const rows = [
      row({
        perchId: 'edited',
        config: 'dhcp',
        base: HOST,
        router: R,
        desired: HOST,
        status: 'drift',
        driftSince: 'x',
      }),
      row({
        perchId: 'deleted',
        config: 'dhcp',
        base: HOST,
        router: null,
        desired: HOST,
        status: 'drift',
        driftSince: 'x',
      }),
      row({
        perchId: 'new',
        config: 'dhcp',
        name: 'extra',
        base: null,
        router: extra,
        desired: null,
        status: 'drift',
        driftSince: 'x',
      }),
      row({ perchId: 'draft', config: 'dhcp', base: HOST, desired: R, status: 'ahead' }),
    ]
    const job = plan(rows, { kind: 'revert', ledger: ledgerOf(rows.slice(0, 1)) }).jobs[0]
    assert.equal(job.kind, 'revert')
    assert.sameMembers(job.perchIds, ['edited', 'deleted', 'new'])
    assert.deepEqual(
      job.ops.map((op) => `${op.op}:${'section' in op ? op.section : ''}`),
      ['delete:extra', 'put:perch_deleted', 'put:perch_edited']
    )
    assert.deepEqual(job.replaced.new, extra, 'kept for "Restore router version"')
    assert.deepEqual(
      job.ledger.set.map((e) => e.perchId),
      ['deleted']
    )
  })
})

test.group('apply planning | order merge', () => {
  test('three-way order merge', ({ assert }) => {
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a', 'b']), {
      kind: 'ok',
      order: ['c', 'a', 'b'],
    })
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['b', 'a', 'c'], ['a', 'b', 'c']), {
      kind: 'ok',
      order: ['b', 'a', 'c'],
    })
    assert.deepEqual(mergeOrder(['a', 'b'], ['b', 'a'], ['b', 'a']), {
      kind: 'ok',
      order: ['b', 'a'],
    })
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['b', 'a', 'c'], ['a', 'c', 'b']), {
      kind: 'conflict',
    })
    // Members added or removed on one side ride along.
    assert.deepEqual(mergeOrder(['a', 'b'], ['a', 'b', 'r'], ['b', 'a', 'n']), {
      kind: 'ok',
      order: ['b', 'a', 'n', 'r'],
    })
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a']), {
      kind: 'ok',
      order: ['c', 'a'],
    })
  })
})

test.group('apply planning | editSections core', () => {
  const base = [
    row({
      perchId: 'h1',
      config: 'dhcp',
      name: 'nas',
      domain: 'dhcp_hosts',
      base: HOST,
      ownership: { kind: 'options', options: ['mac', 'ip'] },
    }),
    row({
      perchId: 'n1',
      config: 'dhcp',
      domain: 'dhcp_hosts',
      base: null,
      router: null,
      desired: HOST,
    }),
    row({
      perchId: 'u1',
      config: 'dhcp',
      name: 'vendor',
      domain: 'dhcp_hosts',
      base: HOST,
      scope: 'unmodeled',
    }),
    row({ perchId: 'o1', config: 'dhcp', domain: 'other', base: HOST }),
  ]
  const run = (edits: Parameters<typeof planSectionEdits>[0]['edits']) =>
    planSectionEdits({
      rows: base,
      edits,
      domain: 'dhcp_hosts',
      registry,
      authoritative: false,
      newPerchId: () => 'fresh1',
    })

  test('put, create, delete', ({ assert }) => {
    const result = run([
      {
        op: 'put',
        perchId: 'h1',
        config: 'dhcp',
        type: 'host',
        options: { ...HOST.options, ip: '192.168.1.30' },
      },
      {
        op: 'put',
        perchId: null,
        config: 'dhcp',
        type: 'host',
        options: { mac: '02:00:00:00:00:99', ip: '192.168.1.99' },
      },
      { op: 'delete', perchId: 'n1' },
    ])
    assert.deepEqual(result.deleted, ['n1'], 'never reached the router: dropped')
    const h1 = result.upserts.find((u) => u.perchId === 'h1')!
    assert.equal(h1.desired?.options.ip, '192.168.1.30')
    assert.equal(h1.status, 'ahead')
    const created = result.upserts.find((u) => u.perchId === 'fresh1')!
    assert.equal(created.name, 'perch_fresh1')
    assert.isNull(created.base)
    assert.equal(created.status, 'ahead')
    assert.deepEqual(created.ownership, {
      kind: 'options',
      options: ['mac', 'ip', 'name', 'dns', 'leasetime'],
    })
  })

  test('deleting a section on the router sets C := null (the apply removes it)', ({ assert }) => {
    const result = run([{ op: 'delete', perchId: 'h1' }])
    assert.deepEqual(result.deleted, [])
    assert.isNull(result.upserts[0].desired)
    assert.equal(result.upserts[0].status, 'ahead')
  })

  test('refusals: unknown, not synced, another domain, excluded config', ({ assert }) => {
    const code = (fn: () => unknown) => {
      try {
        fn()
        return null
      } catch (err) {
        return err instanceof EditRefusedError ? err.code : String(err)
      }
    }
    assert.equal(
      code(() => run([{ op: 'delete', perchId: 'nope' }])),
      'unknown_section'
    )
    assert.equal(
      code(() => run([{ op: 'delete', perchId: 'u1' }])),
      'not_synced'
    )
    assert.equal(
      code(() => run([{ op: 'delete', perchId: 'o1' }])),
      'wrong_domain'
    )
    assert.equal(
      code(() =>
        run([{ op: 'put', perchId: null, config: 'dropbear', type: 'dropbear', options: {} }])
      ),
      'excluded_config'
    )
  })

  test('item-owned options: items the controller adds become owned', ({ assert }) => {
    const dnsmasq = row({
      perchId: 'd1',
      config: 'dhcp',
      domain: 'dhcp_hosts',
      base: content({ server: ['192.168.1.1'] }, 'dnsmasq'),
      ownership: { kind: 'options', options: [], items: { server: [] } },
    })
    const result = planSectionEdits({
      rows: [dnsmasq],
      edits: [
        {
          op: 'put',
          perchId: 'd1',
          config: 'dhcp',
          type: 'dnsmasq',
          options: { server: ['192.168.1.1', '192.168.1.53'] },
        },
      ],
      domain: 'dhcp_hosts',
      registry,
      authoritative: false,
      newPerchId: () => 'x',
    })
    assert.deepEqual(result.upserts[0].ownership, {
      kind: 'options',
      options: [],
      items: { server: ['192.168.1.53'] },
    })
  })

  test('order edits are returned for the planner', ({ assert }) => {
    const result = run([{ op: 'order', config: 'dhcp', type: 'host', perchIds: ['h1'] }])
    assert.deepEqual(result.orders, [{ config: 'dhcp', type: 'host', perchIds: ['h1'] }])
    assert.deepEqual(result.upserts, [])
  })
})
