import {
  allocateClassMinor,
  bucketClassOption,
  checkPolicyTree,
  bucketSectionName,
  daySpec,
  MAX_DEVICE_ENTRIES,
  overrideFromColumns,
  planQos,
  rateFromColumns,
  restLeafMinor,
  scheduleCovers,
  scheduleEdgesAfter,
  scheduleWindow,
  type PlanAssignment,
  type PlanInput,
  type PlanPolicy,
  type PlanSchedule,
  type QosPlan,
} from '#services/qos_plan'
import { QOS_DEFAULTS } from '#services/qos_settings'
import { test } from '@japa/runner'

const AT = new Date('2026-09-23T04:00:00Z') // Wednesday 12:00 in Asia/Manila (UTC+8)

const MAC1 = '02:00:00:00:00:01'
const MAC2 = '02:00:00:00:00:02'
const MAC3 = '02:00:00:00:00:03'

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

function device(id: number, mac: string, fields: Partial<PlanAssignment> = {}): PlanAssignment {
  return {
    id,
    policyId: null,
    target: { type: 'device', mac },
    rate: null,
    quota: null,
    expiresAt: null,
    ...fields,
  }
}

function group(id: number, groupId: number, fields: Partial<PlanAssignment> = {}): PlanAssignment {
  return { ...device(id, ''), target: { type: 'group', groupId }, ...fields }
}

function network(id: number, name: string, fields: Partial<PlanAssignment> = {}): PlanAssignment {
  return { ...device(id, ''), target: { type: 'network', network: name }, ...fields }
}

function schedule(id: number, fields: Partial<PlanSchedule>): PlanSchedule {
  return {
    id,
    enabled: true,
    target: { type: 'assignment', assignmentId: 1 },
    action: 'block',
    usePolicyId: null,
    shared: null,
    each: null,
    rate: null,
    days: 0b1111111,
    startMinute: 0,
    endMinute: 0,
    ...fields,
  }
}

function plan(input: Partial<PlanInput>): QosPlan {
  return planQos({ policies: [], groups: [], assignments: [], at: AT, ...input })
}

const rate = (downKbit: number, upKbit: number) => ({ downKbit, upKbit })
const codes = (p: QosPlan) => p.issues.map((i) => i.code)
const section = (p: QosPlan, name: string) => p.sections.find((s) => s.name === name)

test.group('qos_plan | class ids', () => {
  test('bucket minors: allocation, names and rest leaves', ({ assert }) => {
    assert.equal(allocateClassMinor([]), 0x02)
    assert.equal(allocateClassMinor([2, 3, 5]), 4)
    const all = Array.from({ length: 0xfe }, (_, i) => i + 2)
    assert.isNull(allocateClassMinor(all))
    assert.equal(bucketSectionName(0x12), 'b12')
    assert.equal(bucketClassOption(0x12), '0x12')
    assert.equal(bucketSectionName(0xff), 'bff')
    assert.equal(restLeafMinor(0x12), 0x112)
  })

  test('columns to rates: NULL pair = none, one NULL = unlimited that way', ({ assert }) => {
    assert.isNull(rateFromColumns(null, null))
    assert.deepEqual(rateFromColumns(5000, null), { downKbit: 5000, upKbit: 0 })
    assert.isNull(overrideFromColumns(undefined, null))
    assert.deepEqual(overrideFromColumns(null, 0), { downKbit: null, upKbit: 0 })
  })

  test('invalid and duplicate minors are refused; members lose the bucket', ({ assert }) => {
    const p = plan({
      policies: [
        policy(1, { classMinor: 0x01, shared: rate(1000, 1000) }),
        policy(2, { classMinor: 0x20, shared: rate(1000, 1000) }),
        policy(3, { classMinor: 0x20, shared: rate(1000, 1000), each: rate(500, 500) }),
      ],
      assignments: [
        device(1, MAC1, { policyId: 1 }),
        device(2, MAC2, { policyId: 2 }),
        device(3, MAC3, { policyId: 3 }),
      ],
    })
    assert.includeMembers(codes(p), ['qos_class_invalid', 'qos_class_duplicate'])
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'bucket').map((s) => s.name),
      ['b20']
    )
    // MAC1: bucket unusable and nothing else: no entry. MAC3: keeps its each cap.
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.bucket, d.downKbit]),
      [
        [MAC2, 'b20', null],
        [MAC3, null, 500],
      ]
    )
  })
})

test.group('qos_plan | globals', () => {
  test('an empty plan is the globals section from the settings', ({ assert }) => {
    const p = plan({})
    assert.deepEqual(p.sections, [
      {
        name: 'globals',
        type: 'globals',
        options: {
          enabled: '1',
          min_wan_kbit: String(QOS_DEFAULTS.minWanKbit),
          min_device_kbit: String(QOS_DEFAULTS.minDeviceKbit),
          leaf_flows: String(QOS_DEFAULTS.leafFlows),
          leaf_limit: String(QOS_DEFAULTS.leafLimitPackets),
          leaf_memory_kb: String(QOS_DEFAULTS.leafMemoryKb),
          rest_memlimit_kb: String(QOS_DEFAULTS.restMemlimitKb),
          dynamic_idle: String(QOS_DEFAULTS.dynamicIdleMinutes * 60),
          dynamic_limit: String(QOS_DEFAULTS.dynamicClassLimit),
        },
      },
    ])
    assert.deepEqual(p.devices, [])
    assert.deepEqual(p.issues, [])
    assert.isNull(p.nextChangeAt)
    assert.match(p.fingerprints.config, /^[0-9a-f]{64}$/)
  })

  test('pause, settings and exemptions', ({ assert }) => {
    const p = plan({
      paused: true,
      settings: { minWanKbit: 2000, leafFlows: 128, dynamicIdleMinutes: 5 },
      exempt: [
        '192.0.2.0/24',
        '198.51.100.0/24',
        '192.0.2.0/24',
        '2001:db8::/48',
        'lan',
        '192.0.2.0/33',
      ],
    })
    const globals = section(p, 'globals')!.options
    assert.equal(globals.enabled, '0')
    assert.equal(globals.min_wan_kbit, '2000')
    assert.equal(globals.leaf_flows, '128')
    assert.equal(globals.dynamic_idle, '300')
    // Each prefix exactly (never summarised); invalid ones are reported and left out.
    assert.deepEqual(globals.exempt, ['192.0.2.0/24', '198.51.100.0/24', '2001:db8::/48'])
    assert.deepEqual(codes(p), ['qos_invalid_prefix', 'qos_invalid_prefix'])
  })
})

test.group('qos_plan | devices, groups and networks', () => {
  test('a per-device cap: a leaf, no bucket', ({ assert }) => {
    const p = plan({
      policies: [policy(1, { each: rate(2000, 1000) })],
      assignments: [device(1, MAC1, { policyId: 1 })],
    })
    assert.deepEqual(p.devices, [
      { mac: MAC1, bucket: null, downKbit: 2000, upKbit: 1000, quota: null, expiresAt: null },
    ])
    assert.lengthOf(p.sections, 1)
  })

  test('a plain rate without a policy; 0 means unlimited that way', ({ assert }) => {
    const p = plan({ assignments: [device(1, MAC1, { rate: rate(0, 1000) })] })
    assert.deepEqual(
      p.devices.map((d) => [d.downKbit, d.upKbit]),
      [[null, 1000]]
    )
  })

  test('a shared bucket for a group: members sit in its rest leaf', ({ assert }) => {
    const p = plan({
      policies: [policy(2, { shared: rate(8000, 2000), fairness: 'per_flow' })],
      groups: [{ id: 7, members: [MAC2, MAC1.toUpperCase()] }],
      assignments: [group(1, 7, { policyId: 2 })],
    })
    assert.deepEqual(section(p, 'b12'), {
      name: 'b12',
      type: 'bucket',
      options: {
        policy: '2',
        class: '0x12',
        parent: '',
        down_kbit: '8000',
        up_kbit: '2000',
        fairness: 'per_flow',
        include_lan: '0',
      },
    })
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.bucket, d.downKbit, d.upKbit]),
      [
        [MAC1, 'b12', null, null],
        [MAC2, 'b12', null, null],
      ]
    )
  })

  test('shared + each on a network: the paid-hotspot guest default', ({ assert }) => {
    const p = plan({
      policies: [policy(2, { shared: rate(50000, 10000), each: rate(5000, 1000) })],
      assignments: [network(1, 'guest', { policyId: 2 })],
      networks: ['lan', 'guest'],
    })
    assert.deepEqual(section(p, 'guest'), {
      name: 'guest',
      type: 'network',
      options: {
        policy: '2',
        bucket: 'b12',
        each_down_kbit: '5000',
        each_up_kbit: '1000',
        include_lan: '0',
      },
    })
    assert.isDefined(section(p, 'b12'))
    assert.deepEqual(p.devices, [])
  })

  test('a network rate without a policy: dynamic per-MAC leaves only', ({ assert }) => {
    const p = plan({ assignments: [network(1, 'iot', { rate: rate(3000, 0) })] })
    assert.deepEqual(section(p, 'iot')!.options, {
      policy: '',
      bucket: '',
      each_down_kbit: '3000',
      each_up_kbit: '0',
      include_lan: '0',
    })
  })

  test('precedence: device over group; an inactive device assignment falls through', ({
    assert,
  }) => {
    const p = plan({
      policies: [
        policy(1, { each: rate(1000, 1000) }),
        policy(2, { each: rate(2000, 2000) }),
        policy(3, { each: rate(3000, 3000), enabled: false }),
      ],
      groups: [{ id: 5, members: [MAC1, MAC2, MAC3] }],
      assignments: [
        group(10, 5, { policyId: 1 }),
        device(11, MAC2, { policyId: 2 }),
        device(12, MAC3, { policyId: 3 }), // disabled policy → the group's
      ],
    })
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.downKbit]),
      [
        [MAC1, 1000],
        [MAC2, 2000],
        [MAC3, 1000],
      ]
    )
  })

  test('the assignment rate overrides the policy each', ({ assert }) => {
    const p = plan({
      policies: [policy(1, { shared: rate(20000, 5000), each: rate(5000, 1000) })],
      assignments: [device(1, MAC1, { policyId: 1, rate: rate(8000, 2000) })],
    })
    assert.deepEqual(
      p.devices.map((d) => [d.bucket, d.downKbit, d.upKbit]),
      [['b11', 8000, 2000]]
    )
  })

  test('expired assignments drop out; the earliest expiry is the next change', ({ assert }) => {
    const soon = new Date(AT.getTime() + 60_000)
    const later = new Date(AT.getTime() + 3_600_000)
    const p = plan({
      policies: [policy(1, { each: rate(1000, 1000) }), policy(2, { each: rate(2000, 2000) })],
      groups: [{ id: 5, members: [MAC1] }],
      assignments: [
        group(1, 5, { policyId: 1, expiresAt: later }),
        device(2, MAC1, { policyId: 2, expiresAt: new Date(AT.getTime() - 1) }),
        device(3, MAC2, { policyId: 2, expiresAt: soon }),
      ],
    })
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.downKbit, d.expiresAt]),
      [
        [MAC1, 1000, later.toISOString()],
        [MAC2, 2000, soon.toISOString()],
      ]
    )
    assert.equal(p.nextChangeAt, soon.toISOString())
  })

  test('quotas ride on device entries; a group quota is ignored', ({ assert }) => {
    const quota = {
      limitBytes: 5_368_709_120,
      usedBytes: 1_048_576,
      onExhausted: 'throttle' as const,
      throttle: rate(256, 128),
    }
    const p = plan({
      groups: [{ id: 5, members: [MAC2] }],
      assignments: [
        device(1, MAC1, { rate: rate(5000, 1000), quota }),
        group(2, 5, { rate: rate(1000, 1000), quota }),
      ],
    })
    assert.deepEqual(p.devices[0].quota, {
      limitBytes: 5_368_709_120,
      usedBytes: 1_048_576,
      onExhausted: 'throttle',
      throttleDownKbit: 256,
      throttleUpKbit: 128,
    })
    assert.isNull(p.devices[1].quota)
    assert.include(codes(p), 'qos_quota_needs_device')
  })

  test('a quota alone (block when used up) is enough for an entry', ({ assert }) => {
    const p = plan({
      assignments: [
        device(1, MAC1, {
          quota: { limitBytes: 1000, usedBytes: 0, onExhausted: 'block', throttle: null },
        }),
      ],
    })
    assert.deepEqual(p.devices[0], {
      mac: MAC1,
      bucket: null,
      downKbit: null,
      upKbit: null,
      quota: {
        limitBytes: 1000,
        usedBytes: 0,
        onExhausted: 'block',
        throttleDownKbit: null,
        throttleUpKbit: null,
      },
      expiresAt: null,
    })
  })

  test('a portal device stays inside its network: bucket kept, cap never above the network', ({
    assert,
  }) => {
    // Guest network: 8/4 Mbit/s shared, 5/1 Mbit/s per device.
    const guest = network(1, 'guest', { policyId: 2 })
    const policies = [policy(2, { shared: rate(8000, 4000), each: rate(5000, 1000) })]
    const within = (id: number, mac: string, fields: Partial<PlanAssignment> = {}) =>
      device(id, mac, { target: { type: 'device', mac, within: 'guest' }, ...fields })
    const p = plan({
      policies,
      assignments: [
        guest,
        // A voucher at 2 Mbit/s down, unlimited up: stays in the bucket, up capped by the network.
        within(2, MAC1, { rate: rate(2000, 0) }),
        // A quota only: the network's bucket and per-device caps.
        within(3, MAC2, {
          quota: { limitBytes: 1000, usedBytes: 0, onExhausted: 'block', throttle: null },
        }),
        // A voucher faster than the network allows per device.
        within(4, MAC3, { rate: rate(20000, 20000) }),
      ],
      networks: ['lan', 'guest'],
    })
    const byMac = new Map(p.devices.map((d) => [d.mac, d]))
    assert.include(byMac.get(MAC1)!, { bucket: 'b12', downKbit: 2000, upKbit: 1000 })
    assert.include(byMac.get(MAC2)!, { bucket: 'b12', downKbit: 5000, upKbit: 1000 })
    assert.include(byMac.get(MAC3)!, { bucket: 'b12', downKbit: 5000, upKbit: 1000 })
    assert.deepEqual(codes(p), [])
  })

  test('within: a network without a default, or a device with its own bucket, is unchanged', ({
    assert,
  }) => {
    const p = plan({
      policies: [policy(2, { shared: rate(8000, 4000) }), policy(3, { shared: rate(1000, 1000) })],
      assignments: [
        network(1, 'guest', { policyId: 2 }),
        device(2, MAC1, { target: { type: 'device', mac: MAC1, within: 'iot' }, rate: rate(2000, 0) }),
        device(3, MAC2, { target: { type: 'device', mac: MAC2, within: 'guest' }, policyId: 3 }),
        device(4, MAC3, { rate: rate(2000, 0) }),
      ],
    })
    const byMac = new Map(p.devices.map((d) => [d.mac, d]))
    assert.include(byMac.get(MAC1)!, { bucket: null, downKbit: 2000, upKbit: null })
    assert.include(byMac.get(MAC2)!, { bucket: 'b13', downKbit: null, upKbit: null })
    assert.include(byMac.get(MAC3)!, { bucket: null, downKbit: 2000, upKbit: null })
  })

  test('decision 13: internet only unless the policy includes LAN traffic', ({ assert }) => {
    const p = plan({
      policies: [
        policy(1, { shared: rate(10000, 10000), includeLan: true }),
        policy(2, { each: rate(1000, 1000) }),
      ],
      assignments: [
        device(1, MAC1, { policyId: 1 }),
        device(2, MAC2, { policyId: 2 }),
        network(3, 'guest', { policyId: 1 }),
      ],
    })
    assert.equal(section(p, 'b11')!.options.include_lan, '1')
    assert.equal(section(p, 'guest')!.options.include_lan, '1')
    assert.isTrue(p.devices.find((d) => d.mac === MAC1)!.includeLan)
    assert.notProperty(p.devices.find((d) => d.mac === MAC2)!, 'includeLan')
  })

  test('an empty policy shapes nothing and leaves the group entry', ({ assert }) => {
    const p = plan({
      policies: [policy(1), policy(2, { each: rate(1000, 1000) })],
      groups: [{ id: 5, members: [MAC1] }],
      assignments: [group(1, 5, { policyId: 2 }), device(2, MAC1, { policyId: 1 })],
    })
    assert.include(codes(p), 'qos_policy_empty')
    assert.deepEqual(
      p.devices.map((d) => d.downKbit),
      [1000]
    )
  })

  test('caps below the floor are raised to it, with a warning', ({ assert }) => {
    const p = plan({
      settings: { minDeviceKbit: 128 },
      policies: [policy(1, { shared: rate(100, 0) })],
      assignments: [device(1, MAC1, { rate: rate(10, 0) }), device(2, MAC2, { policyId: 1 })],
    })
    assert.equal(p.devices[0].downKbit, 128)
    assert.isNull(p.devices[0].upKbit)
    assert.equal(section(p, 'b11')!.options.down_kbit, '128')
    assert.equal(section(p, 'b11')!.options.up_kbit, '0')
    assert.include(codes(p), 'qos_rate_below_floor')
  })

  test('each above shared is a warning only', ({ assert }) => {
    const p = plan({
      policies: [policy(1, { shared: rate(5000, 5000), each: rate(8000, 0) })],
      assignments: [device(1, MAC1, { policyId: 1 })],
    })
    assert.deepEqual(codes(p), ['qos_each_exceeds_shared'])
    assert.equal(p.devices[0].downKbit, 8000)
  })

  test('network targets: unknown, badly named and duplicate defaults are refused', ({ assert }) => {
    const p = plan({
      networks: ['lan', 'guest'],
      assignments: [
        network(1, 'guest', { rate: rate(1000, 1000) }),
        network(2, 'guest', { rate: rate(2000, 2000) }),
        network(3, 'dmz', { rate: rate(1000, 1000) }),
        network(4, 'bad-name', { rate: rate(1000, 1000) }),
      ],
    })
    assert.deepEqual(
      p.issues.map((i) => [i.code, i.assignmentId]),
      [
        ['qos_target_assigned', 2],
        ['qos_unknown_network', 3],
        ['qos_unknown_network', 4],
      ]
    )
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'network').map((s) => s.options.each_down_kbit),
      ['1000']
    )
  })

  test('MACs are normalised; invalid ones and missing groups are reported', ({ assert }) => {
    const p = plan({
      groups: [{ id: 5, members: ['02-00-00-00-00-03', 'nope'] }],
      assignments: [
        device(1, '02-00-00-00-00-0A', { rate: rate(1000, 1000) }),
        device(2, 'zz:zz', { rate: rate(1000, 1000) }),
        device(3, '02:00:00:00:00:0a', { rate: rate(2000, 2000) }),
        group(4, 5, { rate: rate(500, 500) }),
        group(5, 99, { rate: rate(500, 500) }),
      ],
    })
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.downKbit]),
      [
        [MAC3, 500],
        ['02:00:00:00:00:0a', 1000],
      ]
    )
    assert.includeMembers(codes(p), ['qos_invalid_mac', 'qos_mac_assigned', 'qos_group_missing'])
  })

  test('a missing policy is an error and the assignment is skipped', ({ assert }) => {
    const p = plan({ assignments: [device(1, MAC1, { policyId: 42 })] })
    assert.deepEqual(codes(p), ['qos_policy_missing'])
    assert.deepEqual(p.devices, [])
  })

  test('at most MAX_DEVICE_ENTRIES entries', ({ assert }) => {
    const members = Array.from({ length: MAX_DEVICE_ENTRIES + 3 }, (_, i) => {
      const hex = i.toString(16).padStart(4, '0')
      return `02:00:00:00:${hex.slice(0, 2)}:${hex.slice(2)}`
    })
    const p = plan({
      groups: [{ id: 1, members }],
      assignments: [group(1, 1, { rate: rate(1000, 1000) })],
    })
    assert.lengthOf(p.devices, MAX_DEVICE_ENTRIES)
    assert.include(codes(p), 'qos_too_many_devices')
  })

  test('deterministic: input order does not matter; fingerprints track content', ({ assert }) => {
    const policies = [
      policy(1, { shared: rate(10000, 10000) }),
      policy(2, { each: rate(1000, 1000), parentId: null }),
    ]
    const assignments = [
      device(1, MAC1, { policyId: 1 }),
      device(2, MAC2, { policyId: 2 }),
      network(3, 'guest', { policyId: 1 }),
    ]
    const a = plan({ policies, assignments })
    const b = plan({ policies: [...policies].reverse(), assignments: [...assignments].reverse() })
    assert.deepEqual(a, b)
    const c = plan({ policies, assignments: assignments.slice(1) })
    assert.notEqual(c.fingerprints.devices, a.fingerprints.devices)
    assert.equal(c.fingerprints.config, a.fingerprints.config)
  })
})

test.group('qos_plan | nested buckets (decision 16)', () => {
  const guest = policy(1, { shared: rate(50000, 10000) })
  const tier = policy(2, { shared: rate(20000, 5000), each: rate(5000, 1000), parentId: 1 })
  const vip = policy(3, { shared: rate(10000, 2000), parentId: 2 })

  test('a voucher tier inside the guest bucket: parents rendered first', ({ assert }) => {
    const p = plan({
      policies: [vip, tier, guest],
      assignments: [device(1, MAC1, { policyId: 3 }), device(2, MAC2, { policyId: 2 })],
    })
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'bucket').map((s) => [s.name, s.options.parent]),
      [
        ['b11', ''],
        ['b12', 'b11'],
        ['b13', 'b12'],
      ]
    )
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.bucket, d.downKbit]),
      [
        [MAC1, 'b13', null],
        [MAC2, 'b12', 5000],
      ]
    )
    assert.deepEqual(p.issues, [])
  })

  test('only referenced buckets and their ancestors are rendered', ({ assert }) => {
    const p = plan({
      policies: [guest, tier, vip, policy(4, { shared: rate(1000, 1000) })],
      assignments: [device(1, MAC1, { policyId: 2 })],
    })
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'bucket').map((s) => s.name),
      ['b11', 'b12']
    )
  })

  test('depth: four levels at most (amendment), less when the setting says so', ({ assert }) => {
    const chain = [
      policy(1, { shared: rate(50000, 50000) }),
      policy(2, { shared: rate(40000, 40000), parentId: 1 }),
      policy(3, { shared: rate(30000, 30000), parentId: 2 }),
      policy(4, { shared: rate(20000, 20000), parentId: 3 }),
      policy(5, { shared: rate(10000, 10000), parentId: 4 }),
    ]
    const deep = plan({ policies: chain, assignments: [device(1, MAC1, { policyId: 5 })] })
    assert.deepEqual(codes(deep), ['qos_bucket_too_deep'])
    assert.deepEqual(
      deep.sections.filter((s) => s.type === 'bucket').map((s) => [s.name, s.options.parent]),
      [['b15', '']]
    )
    const four = plan({ policies: chain, assignments: [device(1, MAC1, { policyId: 4 })] })
    assert.deepEqual(four.issues, [])
    assert.lengthOf(
      four.sections.filter((s) => s.type === 'bucket'),
      4
    )
    // The setting cannot raise the limit past the kernel's.
    const raised = plan({
      settings: { maxBucketDepth: 8 },
      policies: chain,
      assignments: [device(1, MAC1, { policyId: 5 })],
    })
    assert.deepEqual(codes(raised), ['qos_bucket_too_deep'])

    const two = plan({
      settings: { maxBucketDepth: 2 },
      policies: [guest, tier, vip],
      assignments: [device(1, MAC1, { policyId: 3 })],
    })
    assert.deepEqual(codes(two), ['qos_bucket_too_deep'])
    const flat = plan({
      settings: { maxBucketDepth: 1 },
      policies: [guest, tier],
      assignments: [device(1, MAC1, { policyId: 2 })],
    })
    assert.deepEqual(codes(flat), ['qos_bucket_too_deep'])
  })

  test('cycles, missing and bucketless parents are refused', ({ assert }) => {
    const p = plan({
      policies: [
        policy(1, { shared: rate(1000, 1000), parentId: 2 }),
        policy(2, { shared: rate(1000, 1000), parentId: 1 }),
        policy(3, { shared: rate(1000, 1000), parentId: 99 }),
        policy(4, { each: rate(1000, 1000) }),
        policy(5, { shared: rate(1000, 1000), parentId: 4 }),
      ],
      assignments: [
        device(1, MAC1, { policyId: 1 }),
        device(2, MAC2, { policyId: 3 }),
        device(3, MAC3, { policyId: 5 }),
      ],
    })
    assert.includeMembers(codes(p), [
      'qos_parent_cycle',
      'qos_parent_missing',
      'qos_parent_not_bucket',
    ])
    for (const s of p.sections.filter((x) => x.type === 'bucket')) {
      assert.equal(s.options.parent, '', s.name)
    }
    assert.lengthOf(p.devices, 3)
  })

  test('a disabled parent leaves the child standing alone', ({ assert }) => {
    const p = plan({
      policies: [{ ...guest, enabled: false }, tier],
      assignments: [device(1, MAC1, { policyId: 2 })],
    })
    assert.deepEqual(codes(p), ['qos_parent_disabled'])
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'bucket').map((s) => [s.name, s.options.parent]),
      [['b12', '']]
    )
  })

  test('a child above its parent cannot nest (ceil within the parent)', ({ assert }) => {
    const p = plan({
      policies: [guest, policy(2, { shared: rate(0, 5000), parentId: 1 })],
      assignments: [device(1, MAC1, { policyId: 2 })],
    })
    assert.deepEqual(codes(p), ['qos_child_exceeds_parent'])
    assert.equal(section(p, 'b12')!.options.parent, '')
  })

  test("children adding up to more than their parent's rate is an error", ({ assert }) => {
    const p = plan({
      policies: [
        guest,
        policy(2, { shared: rate(30000, 5000), parentId: 1 }),
        policy(3, { shared: rate(30000, 5000), parentId: 1 }),
      ],
      assignments: [device(1, MAC1, { policyId: 2 }), device(2, MAC2, { policyId: 3 })],
    })
    assert.deepEqual(
      p.issues.map((i) => [i.code, i.policyId]),
      [['qos_children_exceed_parent', 1]]
    )
    const fits = plan({
      policies: [
        guest,
        policy(2, { shared: rate(25000, 5000), parentId: 1 }),
        policy(3, { shared: rate(25000, 5000), parentId: 1 }),
      ],
      assignments: [device(1, MAC1, { policyId: 2 }), device(2, MAC2, { policyId: 3 })],
    })
    assert.deepEqual(fits.issues, [])
  })
})

test.group('qos_plan | schedules (decision 16, run by the router)', () => {
  const ZONE = 'Asia/Manila' // UTC+8, no DST
  const kids = policy(1, { each: rate(10000, 2000) })
  const base = {
    policies: [kids],
    groups: [{ id: 5, members: [MAC1, MAC2] }],
    assignments: [group(1, 5, { policyId: 1 })],
    timezone: ZONE,
  }
  // The kids' group has no internet 22:00-07:00 on school nights.
  const night = schedule(1, {
    action: 'block',
    days: 0b0011111,
    startMinute: 22 * 60,
    endMinute: 7 * 60,
  })

  test('day specs and windows', ({ assert }) => {
    assert.equal(daySpec(0b1111111), 'mon-sun')
    assert.equal(daySpec(0b0011111), 'mon-fri')
    assert.equal(daySpec(0b1100000), 'sat,sun')
    assert.equal(daySpec(0b1010101), 'mon,wed,fri,sun')
    assert.equal(daySpec(0b1110011), 'mon,tue,fri-sun')
    assert.equal(
      scheduleWindow({ days: 0b0011111, startMinute: 22 * 60, endMinute: 6 * 60 + 30 }),
      'mon-fri 22:00-06:30'
    )
    assert.equal(scheduleWindow({ days: 1, startMinute: 0, endMinute: 0 }), 'mon 00:00-00:00')
  })

  test('a schedule is data: the plan is the same at any time of day', ({ assert }) => {
    const day = plan({ ...base, schedules: [night] })
    const bedtime = plan({ ...base, schedules: [night], at: new Date('2026-09-23T15:30:00Z') })
    assert.deepEqual(day.sections, bedtime.sections)
    assert.deepEqual(day.devices, bedtime.devices)
    assert.deepEqual(day.fingerprints, bedtime.fingerprints)
    assert.deepEqual(section(day, 's1'), {
      name: 's1',
      type: 'schedule',
      options: { window: ['mon-fri 22:00-07:00'], assignment: '1', action: 'block' },
    })
    assert.deepEqual(
      day.devices.map((d) => [d.mac, d.downKbit, d.schedules]),
      [
        [MAC1, 10000, ['s1']],
        [MAC2, 10000, ['s1']],
      ]
    )
    // Only the preview moves with the clock.
    assert.deepEqual(day.activeSchedules, [])
    assert.equal(day.nextChangeAt, '2026-09-23T14:00:00.000Z') // 22:00 local
    assert.deepEqual(bedtime.activeSchedules, [1])
    assert.equal(bedtime.nextChangeAt, '2026-09-23T23:00:00.000Z') // 07:00 local
  })

  test('preview: days are the days a window starts on', ({ assert }) => {
    const weekend = schedule(1, {
      startMinute: 22 * 60,
      endMinute: 2 * 60,
      days: (1 << 4) | (1 << 5), // Friday and Saturday nights
    })
    const covers = (iso: string) => scheduleCovers(weekend, new Date(iso), ZONE)
    assert.isFalse(covers('2026-09-24T15:00:00Z')) // Thu 23:00
    assert.isTrue(covers('2026-09-25T15:00:00Z')) // Fri 23:00
    assert.isTrue(covers('2026-09-25T17:30:00Z')) // Sat 01:30 (Friday's window)
    assert.isFalse(covers('2026-09-25T18:30:00Z')) // Sat 02:30
    assert.isTrue(covers('2026-09-26T17:30:00Z')) // Sun 01:30 (Saturday's)
    assert.isFalse(covers('2026-09-27T17:30:00Z')) // Mon 01:30 (Sunday not set)
  })

  test('preview: start = end is a full 24 hours from the start', ({ assert }) => {
    const allDay = schedule(1, { startMinute: 0, endMinute: 0, days: 1 << 2 }) // Wednesday
    assert.isTrue(scheduleCovers(allDay, new Date('2026-09-22T16:00:00Z'), ZONE)) // Wed 00:00
    assert.isTrue(scheduleCovers(allDay, new Date('2026-09-23T15:59:00Z'), ZONE)) // Wed 23:59
    assert.isFalse(scheduleCovers(allDay, new Date('2026-09-23T16:00:00Z'), ZONE)) // Thu 00:00
    const noon = schedule(2, { startMinute: 12 * 60, endMinute: 12 * 60, days: 1 << 2 })
    assert.isTrue(scheduleCovers(noon, new Date('2026-09-24T03:59:00Z'), ZONE)) // Thu 11:59
    assert.isFalse(scheduleCovers(noon, new Date('2026-09-24T04:00:00Z'), ZONE))
  })

  test('preview: window edges follow the zone across DST', ({ assert }) => {
    const evening = { days: 0b1111111, startMinute: 18 * 60, endMinute: 20 * 60 }
    // 2026-11-01 is the US DST end: 18:00 EST = 23:00 UTC, the day before 18:00 EDT = 22:00 UTC.
    const [after] = scheduleEdgesAfter(
      evening,
      new Date('2026-11-01T12:00:00Z'),
      'America/New_York'
    )
    assert.equal(after.toUTC().toISO(), '2026-11-01T23:00:00.000Z')
    const [before] = scheduleEdgesAfter(
      evening,
      new Date('2026-10-31T12:00:00Z'),
      'America/New_York'
    )
    assert.equal(before.toUTC().toISO(), '2026-10-31T22:00:00.000Z')
  })

  test('disabled schedules are not rendered', ({ assert }) => {
    const p = plan({ ...base, schedules: [{ ...night, enabled: false }] })
    assert.isUndefined(section(p, 's1'))
    assert.notProperty(p.devices[0], 'schedules')
    assert.isNull(p.nextChangeAt)
  })

  test('limit on an assignment: a partial override, floored', ({ assert }) => {
    const slow = schedule(1, {
      action: 'limit',
      rate: { downKbit: 10, upKbit: null },
      startMinute: 11 * 60,
      endMinute: 13 * 60,
    })
    const p = plan({ ...base, schedules: [slow] })
    assert.deepEqual(section(p, 's1')!.options, {
      window: ['mon-sun 11:00-13:00'],
      assignment: '1',
      action: 'limit',
      each_down_kbit: String(QOS_DEFAULTS.minDeviceKbit),
      each_up_kbit: '',
    })
  })

  test('policy swap on an assignment renders the other bucket as a move', ({ assert }) => {
    const homework = policy(2, { shared: rate(3000, 1000), each: rate(1000, 500) })
    const swap = schedule(1, {
      action: 'policy',
      usePolicyId: 2,
      startMinute: 19 * 60,
      endMinute: 21 * 60,
    })
    const p = plan({ ...base, policies: [kids, homework], schedules: [swap] })
    assert.deepEqual(section(p, 's1')!.options, {
      window: ['mon-sun 19:00-21:00'],
      assignment: '1',
      action: 'move',
      policy: '2',
      bucket: 'b12',
      each_down_kbit: '1000',
      each_up_kbit: '500',
    })
    // The target bucket exists on the router even while nobody sits in it.
    assert.isDefined(section(p, 'b12'))
    assert.deepEqual(
      p.devices.map((d) => [d.bucket, d.downKbit]),
      [
        [null, 10000],
        [null, 10000],
      ]
    )
    const missing = plan({ ...base, schedules: [{ ...swap, usePolicyId: 77 }] })
    assert.deepEqual(codes(missing), ['qos_schedule_policy_missing'])
    assert.isUndefined(section(missing, 's1'))
  })

  test('limit and unlimited on a policy: its bucket, defaults and policy-capped members', ({
    assert,
  }) => {
    const guest = policy(2, { shared: rate(50000, 10000), each: rate(5000, 1000) })
    const inputs = {
      policies: [guest],
      assignments: [
        network(1, 'guest', { policyId: 2 }),
        device(2, MAC3, { policyId: 2 }),
        device(3, MAC1, { policyId: 2, rate: rate(8000, 2000) }),
      ],
    }
    const peak = schedule(1, {
      target: { type: 'policy', policyId: 2 },
      action: 'limit',
      shared: { downKbit: 25000, upKbit: null },
      each: { downKbit: 2500, upKbit: null },
      startMinute: 18 * 60,
      endMinute: 23 * 60,
    })
    const p = plan({ ...inputs, schedules: [peak] })
    assert.deepEqual(section(p, 's1')!.options, {
      window: ['mon-sun 18:00-23:00'],
      policy: '2',
      action: 'limit',
      down_kbit: '25000',
      up_kbit: '',
      each_down_kbit: '2500',
      each_up_kbit: '',
    })
    assert.deepEqual(section(p, 'b12')!.options.schedule, ['s1'])
    assert.deepEqual(section(p, 'guest')!.options.schedule, ['s1'])
    // MAC1 has its own rate: the policy's schedule does not change it (its bucket still does).
    assert.deepEqual(
      p.devices.map((d) => [d.mac, d.schedules]),
      [
        [MAC1, undefined],
        [MAC3, ['s1']],
      ]
    )

    const open = plan({ ...inputs, schedules: [{ ...peak, action: 'unlimited' }] })
    assert.deepEqual(section(open, 's1')!.options, {
      window: ['mon-sun 18:00-23:00'],
      policy: '2',
      action: 'unlimited',
    })
  })

  test('an assignment schedule comes before its policy schedule', ({ assert }) => {
    const p = plan({
      ...base,
      schedules: [
        schedule(3, {
          target: { type: 'policy', policyId: 1 },
          action: 'unlimited',
          startMinute: 12 * 60,
          endMinute: 14 * 60,
        }),
        { ...night, id: 7 },
      ],
    })
    assert.deepEqual(p.devices[0].schedules, ['s7', 's3'])
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'schedule').map((s) => s.name),
      ['s3', 's7']
    )
  })

  test('refusals: unsupported actions, missing targets, empty days, bad minutes', ({ assert }) => {
    const p = plan({
      ...base,
      assignments: [...base.assignments, network(2, 'guest', { rate: rate(1000, 1000) })],
      schedules: [
        schedule(1, { target: { type: 'policy', policyId: 1 }, action: 'block' }),
        schedule(2, { target: { type: 'assignment', assignmentId: 2 }, action: 'block' }),
        schedule(3, { target: { type: 'policy', policyId: 99 }, action: 'limit' }),
        schedule(4, { target: { type: 'assignment', assignmentId: 99 } }),
        schedule(5, { days: 0 }),
        schedule(6, { startMinute: 1440 }),
      ],
    })
    assert.deepEqual(
      p.issues.map((i) => [i.code, i.scheduleId]),
      [
        ['qos_schedule_unsupported', 2],
        ['qos_schedule_target_missing', 4],
        ['qos_schedule_no_days', 5],
        ['qos_schedule_bad_window', 6],
        ['qos_schedule_unsupported', 1],
        ['qos_schedule_target_missing', 3],
      ]
    )
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'schedule'),
      []
    )
  })

  test('a schedule whose target shapes nothing is not rendered', ({ assert }) => {
    const p = plan({
      ...base,
      assignments: [group(1, 5, { policyId: 1, expiresAt: new Date(AT.getTime() - 1) })],
      schedules: [night],
    })
    assert.deepEqual(
      p.sections.filter((s) => s.type === 'schedule'),
      []
    )
    assert.deepEqual(p.issues, [])
  })

  test('a policy-shared override on a policy without a bucket is a warning', ({ assert }) => {
    const p = plan({
      ...base,
      schedules: [
        schedule(1, {
          target: { type: 'policy', policyId: 1 },
          action: 'limit',
          shared: { downKbit: 1000, upKbit: 1000 },
          each: { downKbit: 2000, upKbit: null },
        }),
      ],
    })
    assert.deepEqual(codes(p), ['qos_schedule_no_bucket'])
    assert.deepEqual(section(p, 's1')!.options, {
      window: ['mon-sun 00:00-00:00'],
      policy: '1',
      action: 'limit',
      down_kbit: '',
      up_kbit: '',
      each_down_kbit: '2000',
      each_up_kbit: '',
    })
  })
})

test.group('qos_plan | origins, fingerprints and quota resets (WP-C)', () => {
  test('origins tell device from group level; network origins are listed', ({ assert }) => {
    const p = plan({
      policies: [policy(1, { each: rate(1000, 1000) }), policy(2, { shared: rate(9000, 9000) })],
      groups: [{ id: 5, members: [MAC1, MAC2] }],
      assignments: [
        group(1, 5, { policyId: 1 }),
        device(2, MAC2, { rate: rate(500, 500) }),
        network(3, 'guest', { policyId: 2 }),
      ],
    })
    assert.deepEqual(p.origins, {
      [MAC1]: { assignmentId: 1, policyId: 1, via: 'group' },
      [MAC2]: { assignmentId: 2, policyId: null, via: 'device' },
    })
    assert.deepEqual(p.networkOrigins, { guest: { assignmentId: 3, policyId: 2 } })
  })

  test('the devices fingerprint ignores quota usage; a reset rides as resetAt', ({ assert }) => {
    const quota = (usedBytes: number, resetAt: Date | null = null) => ({
      limitBytes: 1000,
      usedBytes,
      onExhausted: 'block' as const,
      throttle: null,
      resetAt,
    })
    const a = plan({ assignments: [device(1, MAC1, { quota: quota(10) })] })
    const b = plan({ assignments: [device(1, MAC1, { quota: quota(900) })] })
    assert.equal(a.fingerprints.devices, b.fingerprints.devices)
    assert.equal(b.devices[0].quota!.usedBytes, 900)
    assert.notProperty(a.devices[0].quota!, 'resetAt')
    const reset = new Date('2026-09-23T03:00:00Z')
    const c = plan({ assignments: [device(1, MAC1, { quota: quota(0, reset) })] })
    assert.equal(c.devices[0].quota!.resetAt, reset.toISOString())
    assert.notEqual(c.fingerprints.devices, a.fingerprints.devices)
  })
})

test.group('qos_plan | checkPolicyTree (every policy, referenced or not)', () => {
  const codesOf = (issues: Array<{ code: string; policyId?: number }>) =>
    issues.map((i) => `${i.code}:${i.policyId}`)

  test('a valid tree has no issues', ({ assert }) => {
    const tree = [
      policy(1, { shared: rate(10000, 10000) }),
      policy(2, { shared: rate(6000, 6000), parentId: 1 }),
      policy(3, { shared: rate(4000, 4000), parentId: 1 }),
      policy(4, { shared: rate(2000, 2000), parentId: 2 }),
    ]
    assert.deepEqual(checkPolicyTree(tree, 4), [])
  })

  test('each rule, reported on the policy it concerns', ({ assert }) => {
    assert.deepEqual(
      codesOf(checkPolicyTree([policy(2, { shared: rate(1, 1), parentId: 9 })], 4)),
      ['qos_parent_missing:2']
    )
    assert.deepEqual(
      codesOf(
        checkPolicyTree(
          [
            policy(1, { shared: rate(5, 5), parentId: 2 }),
            policy(2, { shared: rate(5, 5), parentId: 1 }),
          ],
          4
        )
      ),
      ['qos_parent_cycle:1', 'qos_parent_cycle:2']
    )
    assert.deepEqual(
      codesOf(
        checkPolicyTree(
          [policy(1, { each: rate(5, 5) }), policy(2, { shared: rate(5, 5), parentId: 1 })],
          4
        )
      ),
      ['qos_parent_not_bucket:2']
    )
    assert.deepEqual(
      codesOf(
        checkPolicyTree(
          [policy(1, { shared: rate(5, 5) }), policy(2, { each: rate(5, 5), parentId: 1 })],
          4
        )
      ),
      ['qos_child_not_bucket:2']
    )
    assert.deepEqual(
      codesOf(
        checkPolicyTree(
          [policy(1, { shared: rate(5, 5) }), policy(2, { shared: rate(0, 5), parentId: 1 })],
          4
        )
      ),
      ['qos_child_exceeds_parent:2', 'qos_children_exceed_parent:1']
    )
    const chain = [
      policy(1, { shared: rate(100, 100) }),
      policy(2, { shared: rate(50, 50), parentId: 1 }),
      policy(3, { shared: rate(20, 20), parentId: 2 }),
    ]
    assert.deepEqual(codesOf(checkPolicyTree(chain, 2)), ['qos_bucket_too_deep:3'])
    assert.deepEqual(checkPolicyTree(chain, 8), [], 'the limit is capped at 4, 3 levels pass')
    assert.deepEqual(
      codesOf(
        checkPolicyTree(
          [
            policy(1, { shared: rate(10, 10) }),
            policy(2, { shared: rate(6, 6), parentId: 1 }),
            policy(3, { shared: rate(6, 1), parentId: 1 }),
            policy(4, { shared: rate(6, 1), parentId: 1, enabled: false }),
          ],
          4
        )
      ),
      ['qos_children_exceed_parent:1']
    )
    const disabled = checkPolicyTree(
      [
        policy(1, { shared: rate(5, 5), enabled: false }),
        policy(2, { shared: rate(5, 5), parentId: 1 }),
      ],
      4
    )
    assert.deepEqual(
      disabled.map((i) => [i.severity, i.code]),
      [['warning', 'qos_parent_disabled']]
    )
  })
})
