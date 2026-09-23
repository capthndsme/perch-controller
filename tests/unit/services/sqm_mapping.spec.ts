import type { UciOptions } from '#services/gateway_config/types'
import { sqmDomain, sqmOwnership } from '#services/sqm_domain'
import {
  applySqmPatch,
  newSqmQueueOptions,
  normalizeSqmOptions,
  parseSqmQueue,
  SqmMappingError,
  sqmOptionsEqual,
  sqmQueueSetFlags,
} from '#services/sqm_mapping'
import { sqmFixture } from '#tests/helpers/uci'
import { test } from '@japa/runner'

const fixture = sqmFixture

const FIXTURES = [
  'live-layer-cake.uci',
  'lab-piece-of-cake.uci',
  'pppoe-vdsl.uci',
  'unknown-options.uci',
  'router-sfq.uci',
]

test.group('sqm_mapping | parse', () => {
  test('the live gateway queue: layer_cake, NAT-aware per-host, ~970 Mbit/s', ({ assert }) => {
    const view = parseSqmQueue(fixture('live-layer-cake.uci').options)
    assert.deepEqual(view, {
      device: 'wan0',
      enabled: true,
      downloadKbit: 970000,
      uploadKbit: 970000,
      qdisc: 'cake',
      script: 'layer_cake.qos',
      diffserv: 'diffserv3',
      fairness: 'per_host',
      nat: true,
      linkLayer: 'none',
      overhead: null,
      mpu: null,
      ingressEcn: true,
      egressEcn: false,
      squashDscp: true,
      squashIngress: true,
      flags: [],
    })
  })

  test('PPPoE on VDSL: link layer, overhead and MPU', ({ assert }) => {
    const view = parseSqmQueue(fixture('pppoe-vdsl.uci').options)
    assert.equal(view.device, 'pppoe-wan')
    assert.equal(view.diffserv, 'besteffort')
    assert.equal(view.linkLayer, 'ethernet')
    assert.equal(view.overhead, 34)
    assert.equal(view.mpu, 68)
    assert.isTrue(view.egressEcn)
    assert.isFalse(view.squashDscp)
    assert.isFalse(view.squashIngress)
    assert.deepEqual(view.flags, [])
  })

  test('a router-set sfq queue is shown read-only', ({ assert }) => {
    const view = parseSqmQueue(fixture('router-sfq.uci').options)
    assert.equal(view.qdisc, 'sfq')
    assert.isNull(view.diffserv)
    assert.isNull(view.fairness)
    assert.isNull(view.nat)
    assert.deepEqual(view.flags, ['qdisc_unmodeled'])
    // qdisc_advanced '0': sqm's defaults are what runs.
    assert.isTrue(view.ingressEcn)
    assert.isFalse(view.egressEcn)
    assert.isTrue(view.squashDscp)
  })

  test('unknown keywords do not hide the modelled ones', ({ assert }) => {
    const view = parseSqmQueue(fixture('unknown-options.uci').options)
    assert.equal(view.fairness, 'per_host')
    assert.isTrue(view.nat)
    assert.equal(view.diffserv, 'diffserv3')
    assert.deepEqual(view.flags, [])
  })

  test('cake defaults: no opts = triple-isolate, no NAT', ({ assert }) => {
    const view = parseSqmQueue({ interface: 'wan', qdisc: 'cake', script: 'piece_of_cake.qos' })
    assert.equal(view.fairness, 'triple_isolate')
    assert.isFalse(view.nat)
    assert.equal(view.diffserv, 'besteffort')
    assert.isFalse(view.enabled)
    assert.equal(view.downloadKbit, 0)
  })

  test('opts without qdisc_really_really_advanced are inert', ({ assert }) => {
    const view = parseSqmQueue({
      interface: 'wan',
      qdisc: 'cake',
      script: 'layer_cake.qos',
      qdisc_advanced: '1',
      eqdisc_opts: 'nat dual-srchost diffserv8',
    })
    assert.isFalse(view.nat)
    assert.equal(view.fairness, 'triple_isolate')
    assert.equal(view.diffserv, 'diffserv3')
    assert.deepEqual(view.flags, ['inert_opts'])
  })

  test('tin keywords override the script; mixed sides are flagged', ({ assert }) => {
    const base = {
      interface: 'wan',
      qdisc: 'cake',
      script: 'layer_cake.qos',
      qdisc_advanced: '1',
      qdisc_really_really_advanced: '1',
    }
    assert.equal(
      parseSqmQueue({ ...base, eqdisc_opts: 'diffserv4', iqdisc_opts: 'diffserv4 ingress' })
        .diffserv,
      'diffserv4'
    )
    const mixed = parseSqmQueue({
      ...base,
      eqdisc_opts: 'nat dual-srchost diffserv4',
      iqdisc_opts: 'triple-isolate diffserv8',
    })
    assert.isNull(mixed.diffserv)
    assert.equal(mixed.fairness, 'per_host')
    assert.deepEqual(mixed.flags, ['diffserv_unmodeled', 'fairness_mixed', 'nat_mixed'])
    assert.deepEqual(
      parseSqmQueue({ ...base, eqdisc_opts: 'srchost', iqdisc_opts: 'dsthost' }).flags,
      ['fairness_unmodeled']
    )
    assert.deepEqual(parseSqmQueue({ ...base, script: 'simple.qos' }).flags, ['script_unmodeled'])
  })

  test('bad numbers and link layers degrade to flags', ({ assert }) => {
    const view = parseSqmQueue({
      interface: 'wan',
      download: 'fast',
      upload: '1000',
      linklayer: 'dsl',
    })
    assert.equal(view.downloadKbit, 0)
    assert.equal(view.uploadKbit, 1000)
    assert.equal(view.linkLayer, 'none')
    assert.deepEqual(view.flags, ['invalid_rate', 'unknown_linklayer'])
    const overhead = parseSqmQueue({ interface: 'wan', linklayer: 'atm', overhead: 'x' })
    assert.isNull(overhead.overhead)
    assert.deepEqual(overhead.flags, ['invalid_overhead'])
    assert.equal(parseSqmQueue({ interface: 'wan', linklayer: 'atm' }).overhead, 0)
  })
})

test.group('sqm_mapping | patch', () => {
  test('a rate change touches only download and upload', ({ assert }) => {
    for (const file of FIXTURES) {
      const { options } = fixture(file)
      const result = applySqmPatch(options, { downloadKbit: 12345, uploadKbit: 6789 })
      assert.deepEqual(result.changed, ['download', 'upload'], file)
      assert.deepEqual(
        { ...result.options, download: options.download, upload: options.upload },
        options,
        file
      )
      assert.deepEqual(result.warnings, [])
    }
  })

  test('unknown options and cake keywords survive a fairness change', ({ assert }) => {
    const { options } = fixture('unknown-options.uci')
    const result = applySqmPatch(options, { fairness: 'triple_isolate', nat: false })
    assert.equal(result.options.eqdisc_opts, 'ack-filter triple-isolate memlimit 32mb wash')
    assert.equal(result.options.iqdisc_opts, 'triple-isolate ingress rtt 50ms')
    assert.deepEqual(result.options.future_list, ['a', 'b'])
    assert.equal(result.options.future_option, 'kept verbatim')
    assert.equal(result.options.itarget, 'auto')
    assert.deepEqual(result.changed, ['eqdisc_opts', 'iqdisc_opts'])
    const view = parseSqmQueue(result.options)
    assert.equal(view.fairness, 'triple_isolate')
    assert.isFalse(view.nat)
  })

  test('diffserv picks the script and the tin keyword', ({ assert }) => {
    const { options } = fixture('live-layer-cake.uci')
    const d4 = applySqmPatch(options, { diffserv: 'diffserv4' })
    assert.equal(d4.options.script, 'layer_cake.qos')
    assert.equal(d4.options.eqdisc_opts, 'nat dual-srchost diffserv4')
    assert.equal(d4.options.iqdisc_opts, 'nat dual-dsthost ingress diffserv4')
    assert.equal(parseSqmQueue(d4.options).diffserv, 'diffserv4')

    const be = applySqmPatch(d4.options, { diffserv: 'besteffort' })
    assert.equal(be.options.script, 'piece_of_cake.qos')
    assert.equal(be.options.eqdisc_opts, 'nat dual-srchost')
    assert.equal(be.options.iqdisc_opts, 'nat dual-dsthost ingress')
    assert.equal(parseSqmQueue(be.options).diffserv, 'besteffort')

    const d3 = applySqmPatch(be.options, { diffserv: 'diffserv3' })
    assert.equal(d3.options.script, 'layer_cake.qos')
    assert.isTrue(sqmOptionsEqual(d3.options, options))
  })

  test('cake-only fields on a non-cake queue are refused', ({ assert }) => {
    const { options } = fixture('router-sfq.uci')
    for (const patch of [
      { fairness: 'per_host' as const },
      { nat: true },
      { diffserv: 'diffserv4' as const },
    ]) {
      assert.throws(() => applySqmPatch(options, patch), SqmMappingError)
    }
    try {
      applySqmPatch(options, { nat: true })
    } catch (error) {
      assert.equal((error as SqmMappingError).code, 'qos_field_needs_cake')
      assert.equal((error as SqmMappingError).field, 'nat')
    }
  })

  test('switching the sfq queue to cake sets a cake script and can then take cake fields', ({
    assert,
  }) => {
    const { options } = fixture('router-sfq.uci')
    const result = applySqmPatch(options, { qdisc: 'cake', fairness: 'per_host', nat: true })
    assert.equal(result.options.qdisc, 'cake')
    assert.equal(result.options.script, 'piece_of_cake.qos')
    assert.equal(result.options.eqdisc_opts, 'nat dual-srchost')
    assert.equal(result.options.iqdisc_opts, 'nat dual-dsthost ingress')
    assert.equal(result.options.qdisc_really_really_advanced, '1')
    const back = applySqmPatch(result.options, { qdisc: 'fq_codel' })
    assert.equal(back.options.script, 'simple.qos')
    assert.equal(parseSqmQueue(back.options).fairness, 'per_flow')
  })

  test('inert opts are replaced, with a warning, when Perch turns them on', ({ assert }) => {
    const result = applySqmPatch(
      {
        interface: 'wan',
        qdisc: 'cake',
        script: 'layer_cake.qos',
        qdisc_advanced: '1',
        eqdisc_opts: 'besteffort flows',
      },
      { fairness: 'per_host' }
    )
    assert.deepEqual(result.warnings, ['sqm_inert_opts_replaced'])
    assert.equal(result.options.eqdisc_opts, 'dual-srchost')
    assert.equal(result.options.iqdisc_opts, 'dual-dsthost ingress')
  })

  test('link layer, overhead and MPU', ({ assert }) => {
    const { options } = fixture('live-layer-cake.uci')
    assert.throws(() => applySqmPatch(options, { overhead: 44 }), 'An overhead needs a link layer')
    const fibre = applySqmPatch(options, { linkLayer: 'ethernet', overhead: 44 })
    assert.equal(fibre.options.linklayer, 'ethernet')
    assert.equal(fibre.options.overhead, '44')
    assert.deepEqual(fibre.changed, ['linklayer', 'overhead'])
    const docsis = applySqmPatch(fibre.options, { overhead: 18, mpu: 64 })
    assert.equal(docsis.options.linklayer_advanced, '1')
    assert.equal(docsis.options.tcMPU, '64')
    assert.equal(parseSqmQueue(docsis.options).mpu, 64)
    const cleared = applySqmPatch(docsis.options, { mpu: null, overhead: null })
    assert.notProperty(cleared.options, 'tcMPU')
    assert.notProperty(cleared.options, 'overhead')
  })

  test('ECN and squash switch qdisc_advanced on', ({ assert }) => {
    const { options } = fixture('router-sfq.uci')
    const result = applySqmPatch(options, { egressEcn: true, squashDscp: false })
    assert.equal(result.options.qdisc_advanced, '1')
    assert.equal(result.options.egress_ecn, 'ECN')
    assert.equal(result.options.squash_dscp, '0')
    const view = parseSqmQueue(result.options)
    assert.isTrue(view.egressEcn)
    assert.isFalse(view.squashDscp)
  })

  test('advanced options merge, null removes, typed keys are refused', ({ assert }) => {
    const { options } = fixture('unknown-options.uci')
    const result = applySqmPatch(options, { advanced: { tcMTU: '1500', ilimit: null } })
    assert.equal(result.options.tcMTU, '1500')
    assert.notProperty(result.options, 'ilimit')
    assert.deepEqual(result.changed, ['ilimit', 'tcMTU'])
    assert.throws(() => applySqmPatch(options, { advanced: { download: '1' } }))
    assert.throws(() => applySqmPatch(options, { advanced: { 'bad-key': '1' } }))
  })

  test('device and enabled', ({ assert }) => {
    const { options } = fixture('live-layer-cake.uci')
    const result = applySqmPatch(options, { device: 'wan2', enabled: false })
    assert.deepEqual(result.changed, ['enabled', 'interface'])
    assert.equal(result.options.enabled, '0')
    assert.equal(result.options.interface, 'wan2')
  })

  test('a queue Perch creates is the lab spike hand-made one', ({ assert }) => {
    const created = newSqmQueueOptions({ device: 'wan2', downloadKbit: 50000, uploadKbit: 50000 })
    const lab = fixture('lab-piece-of-cake.uci').options
    assert.isTrue(sqmOptionsEqual(created.options, lab))
    assert.equal(created.options.eqdisc_opts, 'nat dual-srchost')
    assert.equal(created.options.iqdisc_opts, 'nat dual-dsthost ingress')
    assert.include(created.changed, 'interface')
    assert.deepEqual(created.warnings, [])
  })

  test('a created layer_cake queue equals the live one', ({ assert }) => {
    const created = newSqmQueueOptions({
      device: 'wan0',
      downloadKbit: 970000,
      uploadKbit: 970000,
      diffserv: 'diffserv3',
    })
    assert.isTrue(sqmOptionsEqual(created.options, fixture('live-layer-cake.uci').options))
  })

  test('created fq_codel queue takes no cake fields', ({ assert }) => {
    const created = newSqmQueueOptions({
      device: 'wan',
      downloadKbit: 1000,
      uploadKbit: 1000,
      qdisc: 'fq_codel',
    })
    assert.equal(created.options.script, 'simple.qos')
    assert.notProperty(created.options, 'eqdisc_opts')
    assert.throws(() =>
      newSqmQueueOptions({
        device: 'wan',
        downloadKbit: 1000,
        uploadKbit: 1000,
        qdisc: 'fq_codel',
        nat: true,
      })
    )
  })
})

test.group('sqm_mapping | equality', () => {
  test('formatting and spelled-out defaults are not drift', ({ assert }) => {
    const { options } = fixture('live-layer-cake.uci')
    const reformatted: UciOptions = {
      ...options,
      enabled: 'yes',
      download: '0970000',
      ingress_ecn: 'ecn',
      eqdisc_opts: '  nat   dual-srchost ',
      tcMTU: '2047',
      linklayer_adaptation_mechanism: 'default',
    }
    delete reformatted.debug_logging
    delete reformatted.verbosity
    assert.isTrue(sqmOptionsEqual(options, reformatted))
    assert.isFalse(sqmOptionsEqual(options, { ...options, download: '960000' }))
    assert.isFalse(sqmOptionsEqual(options, { ...options, extra: 'x' }))
    assert.deepEqual(
      Object.keys(normalizeSqmOptions(options)),
      Object.keys(normalizeSqmOptions(options)).sort()
    )
  })

  test('two enabled queues on one device are flagged, a disabled one is not', ({ assert }) => {
    const a = { options: { interface: 'wan', enabled: '1' } }
    const b = { options: { interface: 'wan', enabled: '1' } }
    const c = { options: { interface: 'wan', enabled: '0' } }
    const d = { options: { interface: 'wan2', enabled: '1' } }
    assert.deepEqual(sqmQueueSetFlags([a, b, c, d]), [
      ['duplicate_device'],
      ['duplicate_device'],
      [],
      [],
    ])
  })
})

test.group('sqm_domain', () => {
  test('parse then render is the identity on every fixture', ({ assert }) => {
    for (const file of FIXTURES) {
      const { name, options } = fixture(file)
      const section = {
        perchId: 'q1',
        config: 'sqm',
        name,
        type: 'queue',
        anonymous: false,
        options,
      }
      const objects = sqmDomain.parse([section])
      assert.lengthOf(objects, 1, file)
      const edits = objects.flatMap((obj) => sqmDomain.render(obj))
      assert.deepEqual(
        edits,
        [{ op: 'put', perchId: 'q1', config: 'sqm', type: 'queue', options }],
        file
      )
      // No aliasing: the render is a copy.
      assert.notStrictEqual((edits[0] as { options: UciOptions }).options, options)
    }
  })

  test('claims queue sections of sqm only', ({ assert }) => {
    const base = { name: 'x', anonymous: false, index: 0, options: {} }
    assert.isTrue(sqmDomain.claims({ ...base, config: 'sqm', type: 'queue' }))
    assert.isFalse(sqmDomain.claims({ ...base, config: 'sqm', type: 'other' }))
    assert.isFalse(sqmDomain.claims({ ...base, config: 'network', type: 'queue' }))
  })

  test('a router-side pause leaves enabled to the router (decision 15)', ({ assert }) => {
    const { options } = fixture('live-layer-cake.uci')
    assert.deepEqual(sqmOwnership({ options }), { kind: 'section' })
    const paused = sqmOwnership({ options: { ...options, enabled: '0' } })
    assert.equal(paused.kind, 'options')
    const owned = (paused as { options: string[] }).options
    assert.notInclude(owned, 'enabled')
    assert.includeMembers(owned, ['download', 'upload', 'interface', 'eqdisc_opts', 'verbosity'])
  })

  test('requires sqm-scripts', ({ assert }) => {
    assert.equal(sqmDomain.requires({ packages: {} }), 'sqm-scripts is not installed')
    assert.isNull(sqmDomain.requires({ packages: { 'sqm-scripts': '1.6.0' } }))
  })

  test('normalize is the per-option equality form', ({ assert }) => {
    assert.equal(sqmDomain.normalize('queue', 'enabled', 'on'), '1')
    assert.equal(
      sqmDomain.normalize('queue', 'eqdisc_opts', ' nat  dual-srchost'),
      'nat dual-srchost'
    )
    assert.equal(sqmDomain.normalize('other', 'enabled', 'on'), 'on')
  })

  test('validate reports missing and bad devices, duplicates and bad rates', ({ assert }) => {
    const section = (name: string, options: UciOptions) => ({
      perchId: name,
      config: 'sqm',
      name,
      type: 'queue',
      anonymous: false,
      options,
    })
    const issues = sqmDomain.validate([
      section('a', { interface: 'wan', enabled: '1' }),
      section('b', { interface: 'wan', enabled: '1', download: 'lots' }),
      section('c', { enabled: '1' }),
      section('d', { interface: 'bad name', enabled: '0' }),
    ])
    assert.deepEqual(
      issues.map((i) => [i.section, i.code, i.severity]),
      [
        ['a', 'qos_duplicate_device', 'warning'],
        ['b', 'qos_duplicate_device', 'warning'],
        ['b', 'qos_invalid_rate', 'error'],
        ['c', 'qos_device_required', 'error'],
        ['d', 'qos_invalid_device', 'error'],
      ]
    )
  })
})
