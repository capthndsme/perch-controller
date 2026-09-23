import {
  foldGatewayHosts,
  ipOnlyHosts,
  macFromDuid,
  normalizeDhcpObservation,
  normalizeMac,
  observationFingerprint,
} from '#services/gateway_dhcp'
import { test } from '@japa/runner'

test.group('gateway_dhcp | normalisation', () => {
  test('MACs: colon, dash and bare hex forms; anything else is null', ({ assert }) => {
    assert.equal(normalizeMac('02:00:00:00:10:21'), '02:00:00:00:10:21')
    assert.equal(normalizeMac('02-00-00-00-10-2A'), '02:00:00:00:10:2a')
    assert.equal(normalizeMac('02000000102a'), '02:00:00:00:10:2a')
    assert.isNull(normalizeMac('20-02:00:00:00:10:25'))
    assert.isNull(normalizeMac(42))
  })

  test('the MAC inside a DUID: types 1 and 3 with Ethernet hardware only', ({ assert }) => {
    assert.equal(macFromDuid('000100012abcdef0020000001021'), '02:00:00:00:10:21')
    assert.equal(macFromDuid('00:03:00:01:02:00:00:00:10:27'), '02:00:00:00:10:27')
    assert.isNull(macFromDuid('0004deadbeef'), 'DUID-UUID carries none')
    assert.isNull(macFromDuid('00030006020000001027'), 'not Ethernet')
    assert.isNull(macFromDuid('0003000102'), 'truncated')
  })

  test('not an object is null; missing lists read as empty', ({ assert }) => {
    assert.isNull(normalizeDhcpObservation(null))
    assert.isNull(normalizeDhcpObservation([]))
    assert.deepEqual(normalizeDhcpObservation({}), { leases4: [], leases6: [], hosts: [] })
  })

  test('"*" and control characters in names, bad entries dropped one by one', ({ assert }) => {
    const obs = normalizeDhcpObservation({
      leases4: [
        { mac: '02:00:00:00:10:21', ip: '192.168.1.21', hostname: '*', expires: 0 },
        { mac: '02:00:00:00:10:22', ip: '192.168.1.22', hostname: 'tab\tlet', expires: 5 },
        { mac: '02:00:00:00:10:23', ip: '192.168.1.23', hostname: 'x', expires: -1 },
        { mac: '02:00:00:00:10:24', ip: '192.168.1.24', hostname: 'x', expires: 1.5 },
      ],
      hosts: [{ name: 'ip-only', ip: '192.168.1.40' }, { name: 'nothing' }],
    })!
    assert.deepEqual(
      obs.leases4.map((l) => [l.mac, l.hostname]),
      [
        ['02:00:00:00:10:21', null],
        ['02:00:00:00:10:22', 'tablet'],
      ]
    )
    assert.deepEqual(obs.hosts, [{ name: 'ip-only', macs: [], ip: '192.168.1.40' }])
    assert.deepEqual(ipOnlyHosts(obs), [{ name: 'ip-only', ip: '192.168.1.40' }])
  })
})

test.group('gateway_dhcp | one row per MAC', () => {
  test('duplicates: the later lease gives the address, the latest named one the name', ({
    assert,
  }) => {
    const obs = normalizeDhcpObservation({
      leases4: [
        { mac: '02:00:00:00:10:24', ip: '192.168.1.24', hostname: 'phone-old', expires: 100 },
        { mac: '02:00:00:00:10:24', ip: '192.168.1.44', expires: 200 },
        { mac: '02:00:00:00:10:25', ip: '192.168.1.25', hostname: 'forever', expires: 0 },
        { mac: '02:00:00:00:10:25', ip: '192.168.1.45', hostname: 'later', expires: 900 },
      ],
      hosts: [
        { name: 'first', macs: ['02:00:00:00:10:25'] },
        { name: 'second', macs: ['02:00:00:00:10:25'] },
      ],
    })!
    const rows = foldGatewayHosts(obs)
    assert.lengthOf(rows, 2)
    assert.include(rows[0], {
      mac: '02:00:00:00:10:24',
      hostname: 'phone-old',
      ipv4: '192.168.1.44',
      leaseInfinite: false,
    })
    assert.equal(rows[0].leaseExpiresAt?.toSeconds(), 200)
    assert.include(rows[1], {
      mac: '02:00:00:00:10:25',
      hostname: 'forever',
      ipv4: '192.168.1.25',
      leaseInfinite: true,
      staticName: 'second',
    })
    assert.isNull(rows[1].leaseExpiresAt)
  })

  test('a static host without a lease gets a row with its address', ({ assert }) => {
    const rows = foldGatewayHosts(
      normalizeDhcpObservation({
        hosts: [{ name: 'nas', macs: ['02:00:00:00:10:30'], ip: '192.168.1.30' }],
      })!
    )
    assert.deepEqual(
      rows.map((r) => [r.mac, r.hostname, r.staticName, r.ipv4]),
      [['02:00:00:00:10:30', null, 'nas', '192.168.1.30']]
    )
  })

  test('the fingerprint follows the content', ({ assert }) => {
    const a = normalizeDhcpObservation({ leases4: [] })!
    const b = normalizeDhcpObservation({
      leases4: [{ mac: '02:00:00:00:10:21', ip: '192.168.1.21', expires: 0 }],
    })!
    assert.equal(observationFingerprint(a), observationFingerprint({ ...a }))
    assert.notEqual(observationFingerprint(a), observationFingerprint(b))
  })
})
