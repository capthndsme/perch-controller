import type { RevisionSnapshotEntry } from '#models/gateway_revision'
import { canonicalText, contentsEqual, diffEntry } from '#services/gateway_config/canonical'
import {
  applySectionEdits,
  checkRoundTrip,
  DomainRegistry,
  EXCLUDED_CONFIGS,
  SectionEditError,
  syncedFromRouter,
  validateDesired,
  type ConfigDomain,
  type SyncedSection,
} from '#services/gateway_config/domain'
import {
  dhcpHostsDomain,
  leaseSeconds,
  macsOf,
  type DhcpReservation,
} from '#services/gateway_config/domains/dhcp_hosts'
import { DOMAINS, domainRegistry } from '#services/gateway_config/domains/index'
import {
  buildSnapshot,
  diffSnapshots,
  planRestore,
  rejoinOffer,
  revisionsToPrune,
  summarizeDiff,
} from '#services/gateway_config/revisions'
import {
  controllerSecretSlot,
  isFingerprint,
  newSecretRef,
  redactOptions,
  secretFingerprint,
  wireOptions,
} from '#services/gateway_config/secrets'
import type { SectionState } from '#services/gateway_config/sync_engine'
import {
  dhcpConfig,
  firewallConfig,
  networkConfig,
  section,
} from '#tests/unit/services/fixtures/gateway_config'
import { test } from '@japa/runner'

const domain = dhcpHostsDomain as ConfigDomain<DhcpReservation>

function dhcpSections(): SyncedSection[] {
  return dhcpConfig().sections.map((s, i) => syncedFromRouter('dhcp', s, `p${i}`))
}

function claimed(): SyncedSection[] {
  const all = { dhcp: dhcpConfig() }
  return dhcpSections().filter((s) =>
    domain.claims({ ...dhcpConfig().sections.find((x) => x.name === s.name)!, config: 'dhcp' }, all)
  )
}

test.group('config domains | registry', () => {
  test('refuses excluded configs, duplicate and malformed keys', ({ assert }) => {
    for (const config of EXCLUDED_CONFIGS) {
      assert.throws(
        () => new DomainRegistry([{ ...domain, key: 'x', configs: [config] } as ConfigDomain])
      )
    }
    assert.throws(
      () => new DomainRegistry([domain as ConfigDomain, domain as ConfigDomain]),
      /duplicate/
    )
    assert.throws(
      () => new DomainRegistry([{ ...domain, key: 'Bad-Key' } as ConfigDomain]),
      /invalid/
    )
    assert.deepEqual(
      ['perch-collector', 'perch-apd', 'rpcd', 'uhttpd', 'dropbear'].filter(
        (c) => !EXCLUDED_CONFIGS.includes(c)
      ),
      [],
      'README 3.4'
    )
  })

  test('claims: first registered domain wins; excluded configs are never claimed', ({ assert }) => {
    const greedy: ConfigDomain = { ...(domain as ConfigDomain), key: 'greedy', claims: () => true }
    const reg = new DomainRegistry([domain as ConfigDomain, greedy])
    const all = { dhcp: dhcpConfig() }
    const nas = { ...dhcpConfig().sections.find((s) => s.name === 'nas')!, config: 'dhcp' }
    assert.equal(reg.claim(nas, all)?.domain.key, 'dhcp_hosts')
    const vendor = { ...dhcpConfig().sections.find((s) => s.name === 'vendor')!, config: 'dhcp' }
    assert.equal(reg.claim(vendor, all)?.domain.key, 'greedy')
    assert.isNull(reg.claim({ ...nas, config: 'rpcd' }, all))
    assert.deepEqual(reg.configs(), ['dhcp'])
  })

  test('the default registry holds the registered domains', ({ assert }) => {
    assert.deepEqual(
      DOMAINS.map((d) => d.key),
      ['dhcp_hosts', 'sqm']
    )
    assert.strictEqual(domainRegistry(), domainRegistry())
    assert.equal(domainRegistry().get('dhcp_hosts'), dhcpHostsDomain)
    assert.isNull(domainRegistry().get('nope'))
  })
})

test.group('config domains | round-trip harness (section 7)', () => {
  test('dhcp_hosts round-trips every reservation of the fixture exactly', ({ assert }) => {
    const sections = claimed()
    assert.deepEqual(
      sections.map((s) => s.name),
      ['cfg07fe63', 'nas', 'laptop', 'phone', 'blocked']
    )
    const report = checkRoundTrip(domain, sections)
    assert.deepEqual(report, { ok: true, failures: [] })
  })

  test('parse → edit → render keeps the router’s spelling and every carried option', ({
    assert,
  }) => {
    const sections = claimed()
    const objects = domain.parse(sections)
    const nas = objects.find((o) => o.section === 'nas')!
    assert.deepEqual(nas.macs, ['02:00:00:00:00:aa'])
    assert.equal(nas.macForm, 'string')
    assert.deepEqual(nas.extra, {
      tag: 'known',
      match_tag: 'known',
      duid: '0001000102000000000000aa',
    })
    const edits = domain.render({ ...nas, ip: '192.168.1.121' }, sections)
    const after = applySectionEdits(sections, edits).find((s) => s.name === 'nas')!
    assert.deepEqual(after.options, {
      tag: 'known',
      match_tag: 'known',
      duid: '0001000102000000000000aa',
      mac: '02:00:00:00:00:AA',
      name: 'nas',
      ip: '192.168.1.121',
      leasetime: 'infinite',
    })

    const laptop = objects.find((o) => o.section === 'laptop')!
    assert.deepEqual(laptop.macs, ['02:00:00:00:00:21', '02:00:00:00:00:22'])
    const moved = domain.render({ ...laptop, macs: ['02:00:00:00:00:22'] }, sections)
    const put = moved[0]
    assert.equal(put.op === 'put' ? put.options.mac : null, '02:00:00:00:00:22')
  })

  test('a lossy domain fails the harness with the section named', ({ assert }) => {
    const lossy: ConfigDomain<DhcpReservation> = {
      ...domain,
      render: (obj) => [
        {
          op: 'put',
          perchId: obj.perchId,
          config: 'dhcp',
          type: 'host',
          options: { mac: obj.macs, ip: obj.ip ?? '' },
        },
      ],
    }
    const report = checkRoundTrip(lossy, claimed())
    assert.isFalse(report.ok)
    assert.includeMembers(
      report.failures.map((f) => f.section),
      ['nas', 'laptop', 'phone']
    )
    assert.isTrue(report.failures.every((f) => f.reason === 'changed'))
  })

  test('a domain whose render throws or creates sections fails', ({ assert }) => {
    const throwing: ConfigDomain = {
      ...(domain as ConfigDomain),
      render: () => {
        throw new Error('boom')
      },
    }
    assert.deepEqual(
      checkRoundTrip(throwing, claimed()).failures.map((f) => f.reason),
      ['error']
    )
    const creating: ConfigDomain = {
      ...(domain as ConfigDomain),
      render: () => [{ op: 'put', perchId: null, config: 'dhcp', type: 'host', options: {} }],
    }
    assert.isFalse(checkRoundTrip(creating, claimed()).ok)
  })

  test('applySectionEdits: put, delete, order, secrets', ({ assert }) => {
    const sections: SyncedSection[] = [
      {
        perchId: 'a',
        config: 'firewall',
        name: 'ra',
        type: 'rule',
        anonymous: false,
        options: { name: 'a' },
      },
      {
        perchId: 'b',
        config: 'firewall',
        name: 'rb',
        type: 'rule',
        anonymous: false,
        options: { name: 'b' },
      },
      {
        perchId: 'w',
        config: 'network',
        name: 'wg0',
        type: 'interface',
        anonymous: false,
        options: { proto: 'wireguard' },
        secrets: { private_key: { fingerprint: 'hmac:0000000000000001' } },
      },
    ]
    const out = applySectionEdits(sections, [
      { op: 'order', config: 'firewall', type: 'rule', perchIds: ['b', 'a'] },
      {
        op: 'put',
        perchId: 'w',
        config: 'network',
        type: 'interface',
        options: { proto: 'wireguard', mtu: '1420' },
        secrets: {
          private_key: { keep: true },
          preshared_key: { ref: 's1', fingerprint: 'hmac:0000000000000009' },
        },
      },
      { op: 'delete', perchId: 'a' },
    ])
    assert.deepEqual(
      out.map((s) => s.perchId),
      ['b', 'w']
    )
    assert.deepEqual(out[1].secrets, {
      private_key: { fingerprint: 'hmac:0000000000000001' },
      preshared_key: { ref: 's1', fingerprint: 'hmac:0000000000000009' },
    })
    const reordered = applySectionEdits(sections, [
      { op: 'order', config: 'firewall', type: 'rule', perchIds: ['b'] },
    ])
    assert.deepEqual(
      reordered.map((s) => s.perchId),
      ['b', 'a', 'w']
    )
    assert.throws(
      () => applySectionEdits(sections, [{ op: 'delete', perchId: 'zz' }]),
      SectionEditError
    )
    assert.throws(
      () =>
        applySectionEdits(sections, [
          {
            op: 'put',
            perchId: 'a',
            config: 'firewall',
            type: 'rule',
            options: {},
            secrets: { key: { keep: true } },
          },
        ]),
      SectionEditError
    )
  })
})

test.group('config domains | dhcp_hosts', () => {
  test('claims reservations only', ({ assert }) => {
    const all = { dhcp: dhcpConfig() }
    const claims = dhcpConfig().sections.map((s) => [
      s.name,
      domain.claims({ ...s, config: 'dhcp' }, all),
    ])
    assert.deepEqual(claims, [
      ['cfg01411c', false],
      ['lan', false],
      ['wan', false],
      ['odhcpd', false],
      ['cfg07fe63', true],
      ['nas', true],
      ['laptop', true],
      ['phone', true],
      ['blocked', true],
      ['vendor', false],
      ['nameonly', false],
    ])
    const listIp = section('x', 'host', { mac: '02:00:00:00:00:01', ip: ['192.168.1.2'] })
    assert.isFalse(
      domain.claims({ ...listIp, config: 'dhcp' }, all),
      'a list ip would not round-trip'
    )
  })

  test('normalised equality', ({ assert }) => {
    const rules = new DomainRegistry([domain as ConfigDomain]).rules('dhcp_hosts')
    const a = {
      type: 'host',
      options: {
        mac: '02:00:00:00:00:AA 02:00:00:00:00:bb',
        leasetime: '1d',
        dns: 'yes',
        name: 'NAS',
      },
    }
    const b = {
      type: 'host',
      options: {
        mac: ['02:00:00:00:00:bb', '02:00:00:00:00:aa'],
        leasetime: '24h',
        dns: '1',
        name: 'nas',
      },
    }
    assert.isTrue(contentsEqual(a, b, rules))
    assert.isFalse(contentsEqual(a, { ...b, options: { ...b.options, leasetime: '12h' } }, rules))
    assert.equal(leaseSeconds('12h'), '43200')
    assert.equal(leaseSeconds('720m'), '43200')
    assert.equal(leaseSeconds('3600'), '3600')
    assert.equal(leaseSeconds('infinite'), 'infinite')
    assert.equal(leaseSeconds('bogus'), 'bogus')
    assert.deepEqual(macsOf(['02:00:00:00:00:AA', '02:00:00:00:00:bb 02:00:00:00:00:cc']), [
      '02:00:00:00:00:aa',
      '02:00:00:00:00:bb',
      '02:00:00:00:00:cc',
    ])
  })

  test('identity keys: MACs and DUID', ({ assert }) => {
    const nas = dhcpConfig().sections.find((s) => s.name === 'nas')!
    assert.deepEqual(domain.identityKeys!(nas), [
      'mac:02:00:00:00:00:aa',
      'duid:0001000102000000000000aa',
    ])
    assert.deepEqual(domain.identityKeys!({ type: 'dhcp', options: {} }), [])
  })

  test('validation: malformed values, duplicates, networks', ({ assert }) => {
    const host = (perchId: string, options: SyncedSection['options']): SyncedSection => ({
      perchId,
      config: 'dhcp',
      name: `perch_${perchId}`,
      type: 'host',
      anonymous: false,
      options,
    })
    const desired = [
      host('a', { mac: '02:00:00:00:00:01', ip: '192.168.1.10', name: 'alpha' }),
      host('b', { mac: '02:00:00:00:00:01', ip: '192.168.1.10', name: 'ALPHA' }),
      host('c', { mac: 'nonsense', ip: '999.1.1.1', name: 'bad_name!', leasetime: 'soon' }),
      host('d', { mac: '02:00:00:00:00:04', ip: '192.168.1.1' }),
      host('e', { mac: '02:00:00:00:00:05', ip: '10.0.0.5' }),
      host('f', { mac: '02:00:00:00:00:06', ip: 'ignore' }),
    ]
    const unmanaged = [host('z', { mac: '02:00:00:00:00:05', name: 'vendor' })]
    const issues = domain.validate(desired, {
      capabilities: null,
      all: desired,
      unmanaged,
      networks: [{ name: 'lan', ipv4: ['192.168.1.1/24'] }],
    })
    const codes = issues.map((i) => `${i.perchId}:${i.code}:${i.severity}`)
    assert.sameMembers(codes, [
      'b:duplicate_mac:error',
      'b:duplicate_ip:error',
      'b:duplicate_name:warning',
      'c:invalid_mac:error',
      'c:invalid_ip:error',
      'c:invalid_name:error',
      'c:invalid_leasetime:error',
      'd:ip_is_router:error',
      'e:duplicate_mac:error',
      'e:ip_outside_networks:warning',
    ])
  })

  test('validateDesired runs each domain on its own sections', ({ assert }) => {
    const reg = new DomainRegistry([domain as ConfigDomain])
    const sections = claimed().map((s) => ({ ...s, domain: 'dhcp_hosts' }))
    assert.deepEqual(validateDesired(reg, sections, { capabilities: null }), [])
    const broken = [
      ...sections,
      { ...sections[0], perchId: 'dup', name: 'dup', domain: 'dhcp_hosts' },
    ]
    assert.isTrue(
      validateDesired(reg, broken, { capabilities: null }).some((i) => i.code === 'duplicate_mac')
    )
  })

  test('other fixture configs are left to future domains', ({ assert }) => {
    const all = { network: networkConfig(), firewall: firewallConfig() }
    const reg = new DomainRegistry([domain as ConfigDomain])
    for (const config of [networkConfig(), firewallConfig()]) {
      for (const s of config.sections) assert.isNull(reg.claim({ ...s, config: config.name }, all))
    }
  })
})

test.group('config plane | secrets', () => {
  test('fingerprints: deterministic, keyed, bound to the option', ({ assert }) => {
    const where = { config: 'network', section: 'wg0', option: 'private_key' }
    const a = secretFingerprint('key-1', where, 'value')
    assert.isTrue(isFingerprint(a))
    assert.match(a, /^hmac:[0-9a-f]{16}$/)
    assert.equal(a, secretFingerprint('key-1', where, 'value'))
    assert.notEqual(a, secretFingerprint('key-2', where, 'value'))
    assert.notEqual(a, secretFingerprint('key-1', { ...where, section: 'wg1' }, 'value'))
    assert.notEqual(a, secretFingerprint('key-1', where, 'other'))
    assert.isFalse(isFingerprint('hmac:xyz'))
    assert.deepEqual(controllerSecretSlot('key-1', where, 's1', 'value'), {
      ref: 's1',
      fingerprint: a,
    })
  })

  test('redaction (the agent side): kit names and domain names leave options', ({ assert }) => {
    const out = redactOptions(
      'key-1',
      { config: 'network', section: 'wg0', type: 'interface' },
      { proto: 'wireguard', private_key: 'pk', addresses: ['192.168.9.1/24'], token: 't' },
      ['interface.token']
    )
    assert.deepEqual(out.options, { proto: 'wireguard', addresses: ['192.168.9.1/24'] })
    assert.deepEqual(Object.keys(out.secrets).sort(), ['private_key', 'token'])
    assert.isTrue(Object.values(out.secrets).every(isFingerprint))
  })

  test('wire form and refs', ({ assert }) => {
    const ref = newSecretRef()
    assert.match(ref, /^s[a-z2-7]{20}$/)
    assert.notEqual(ref, newSecretRef())
    assert.deepEqual(
      wireOptions({
        type: 'interface',
        options: { proto: 'wireguard' },
        secrets: {
          private_key: { fingerprint: 'hmac:1', ref: 's1' },
          preshared_key: { fingerprint: 'hmac:2' },
        },
      }),
      {
        options: {
          proto: 'wireguard',
          private_key: { $secret: 's1' },
          preshared_key: { $keep: true },
        },
        refs: ['s1'],
      }
    )
  })

  test('diffs never show a secret value', ({ assert }) => {
    const entry = diffEntry(
      { perchId: 'w', config: 'network', section: 'wg0', domain: null },
      {
        type: 'interface',
        options: {},
        secrets: { private_key: { fingerprint: 'hmac:0000000000000001' } },
      },
      {
        type: 'interface',
        options: {},
        secrets: { private_key: { fingerprint: 'hmac:0000000000000002', ref: 's1' } },
      }
    )
    assert.deepEqual(entry?.options, [
      {
        name: 'private_key',
        before: 'hmac:0000000000000001',
        after: 'hmac:0000000000000002',
        secret: true,
      },
    ])
    assert.notInclude(
      canonicalText({
        type: 'x',
        options: {},
        secrets: { k: { fingerprint: 'hmac:1', ref: 's9' } },
      }),
      's9'
    )
  })
})

test.group('config plane | revisions (README 3.7)', () => {
  const content = (ip: string) => ({ type: 'host', options: { mac: '02:00:00:00:00:11', ip } })
  const state = (
    perchId: string,
    base: ReturnType<typeof content> | null,
    extra: Partial<SectionState> = {}
  ): SectionState => ({
    perchId,
    config: 'dhcp',
    name: `perch_${perchId}`,
    type: 'host',
    anonymous: false,
    scope: 'synced',
    domain: 'dhcp_hosts',
    ownership: null,
    issue: null,
    base,
    baseRevision: null,
    router: base,
    desired: base,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: null,
    ...extra,
  })

  test('the rejoin offer is the newest confirmed revision, never the newest one', ({ assert }) => {
    const revisions = [
      { number: 1, confirmedAt: '2026-09-01T00:00:00Z' },
      { number: 2, confirmedAt: '2026-09-02T00:00:00Z' },
      { number: 3, confirmedAt: null },
    ]
    assert.equal(rejoinOffer(revisions), 2)
    assert.isNull(rejoinOffer([{ number: 1, confirmedAt: null }]))
  })

  test('pruning keeps the newest N and the newest confirmed revision', ({ assert }) => {
    const revisions = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1,
      confirmedAt: i + 1 === 3 ? '2026-09-01T00:00:00Z' : null,
    }))
    assert.deepEqual(revisionsToPrune(revisions, 5), [1, 2, 4, 5])
    assert.deepEqual(revisionsToPrune(revisions, 10), [])
    assert.deepEqual(
      revisionsToPrune(
        revisions.map((r) => ({ ...r, confirmedAt: null })),
        8
      ),
      [1, 2]
    )
  })

  test('snapshots, diffs and summaries', ({ assert }) => {
    const before = buildSnapshot([
      state('a', content('192.168.1.20')),
      state('b', content('192.168.1.21')),
      state('m', content('x'), { scope: 'unmodeled' }),
    ])
    assert.deepEqual(
      before.map((e) => e.perchId),
      ['a', 'b'],
      'synced only'
    )
    const after = buildSnapshot([
      state('a', content('192.168.1.30')),
      state('c', content('192.168.1.22')),
    ])
    const diff = diffSnapshots(before, after)
    assert.deepEqual(
      diff.map((d) => [d.perchId, d.action]),
      [
        ['a', 'update'],
        ['b', 'delete'],
        ['c', 'create'],
      ]
    )
    assert.equal(summarizeDiff(diff), '1 added, 1 changed, 1 removed (dhcp)')
    assert.equal(summarizeDiff([]), 'No changes')
  })

  test('restore: C := snapshot, sections born later are removed, lost ones re-created', ({
    assert,
  }) => {
    const snapshot: RevisionSnapshotEntry[] = [
      {
        perchId: 'a',
        config: 'dhcp',
        section: 'perch_a',
        domain: 'dhcp_hosts',
        content: content('192.168.1.20'),
      },
      {
        perchId: 'gone',
        config: 'dhcp',
        section: 'perch_gone',
        domain: 'dhcp_hosts',
        content: content('192.168.1.40'),
      },
    ]
    const plan = planRestore(
      [
        state('a', content('192.168.1.99')),
        state('later', content('192.168.1.50')),
        state('other', content('x'), { config: 'network' }),
      ],
      snapshot
    )
    assert.deepEqual(plan.updates, [
      { perchId: 'a', desired: content('192.168.1.20') },
      { perchId: 'later', desired: null },
    ])
    assert.deepEqual(
      plan.creates.map((c) => c.perchId),
      ['gone']
    )
  })
})
