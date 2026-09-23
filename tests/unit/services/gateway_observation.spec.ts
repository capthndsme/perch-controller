import { decodeBackupAnswer, MAX_BACKUP_BYTES } from '#services/gateway_backups'
import {
  cidr,
  forgetObservations,
  ipv4InCidr,
  isUnicastMac,
  MAX_REMEMBERED_OBSERVATIONS,
  recall,
  remember,
  rememberedCollectorCount,
} from '#services/gateway_observation_common'
import { foldNeighbors, normalizeNeighbors } from '#services/gateway_neighbors'
import {
  networkFor,
  normalizeInterfaces,
  normalizeMwan3,
  normalizePackages,
  normalizeResolver,
  normalizeWireguard,
} from '#services/gateway_observation_parts'
import { normalizeUpnp } from '#services/gateway_upnp'
import { ObserveRequestError } from '#services/gateway_observe'
import { PRESENCE_DEFAULTS, devicePresence } from '#services/wifi_presence'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const MAC = '02:00:00:99:00:01'

test.group('gateway observation | addresses', () => {
  test('CIDR parsing and IPv4 subnet membership', ({ assert }) => {
    assert.equal(cidr('192.168.10.1/24', 4), '192.168.10.1/24')
    assert.equal(cidr('192.168.10.1', 4), '192.168.10.1/32')
    assert.equal(cidr('FD00::1/64', 6), 'fd00::1/64')
    assert.isNull(cidr('192.168.10.1/33', 4))
    assert.isNull(cidr('fd00::1/64', 4))
    assert.isNull(cidr('192.168.10.1/24/1', 4))
    assert.isTrue(ipv4InCidr('192.168.10.200', '192.168.10.1/24'))
    assert.isFalse(ipv4InCidr('192.168.11.2', '192.168.10.1/24'))
    assert.isTrue(ipv4InCidr('203.0.113.200', '203.0.113.130/25'))
    assert.isFalse(ipv4InCidr('203.0.113.100', '203.0.113.130/25'))
    assert.isTrue(ipv4InCidr('198.51.100.7', '0.0.0.0/0'))
    assert.isTrue(ipv4InCidr('255.255.255.254', '255.255.255.0/24'), 'no signed 32-bit trap')
  })

  test('unicast MACs only', ({ assert }) => {
    assert.isTrue(isUnicastMac(MAC))
    assert.isFalse(isUnicastMac('ff:ff:ff:ff:ff:ff'))
    assert.isFalse(isUnicastMac('01:00:5e:00:00:fb'))
    assert.isFalse(isUnicastMac('00:00:00:00:00:00'))
  })
})

test.group('gateway observation | parts', () => {
  test('interfaces: cleaned, deduplicated, sorted; the network of an address or device', ({
    assert,
  }) => {
    const interfaces = normalizeInterfaces([
      { network: 'wan', device: 'eth1', ipv4: ['203.0.113.2/24'], up: true, defaultRoute: true },
      { network: 'lan', device: 'br-lan', ipv4: ['192.168.10.1/24', 'junk'], up: true },
      { network: 'lan', device: 'dup' },
      { network: 'iot', device: 'br-iot', ipv4: ['192.168.30.1/24', '192.168.30.1/32'] },
      'nonsense',
      { device: 'no-network' },
    ])!
    assert.deepEqual(
      interfaces.map((i) => i.network),
      ['iot', 'lan', 'wan']
    )
    assert.deepEqual(interfaces[1].ipv4, ['192.168.10.1/24'])
    assert.isNull(interfaces[1].defaultRoute, 'not said: unknown')
    assert.isFalse(interfaces[0].up, 'up absent reads false')

    assert.equal(networkFor(interfaces, '192.168.10.55'), 'lan')
    assert.equal(networkFor(interfaces, '192.168.30.1'), 'iot', 'longest prefix')
    assert.equal(networkFor(interfaces, '198.51.100.1', 'eth1'), 'wan', 'by device')
    assert.isNull(networkFor(interfaces, '198.51.100.1'))
    assert.isNull(networkFor(null, '192.168.10.55'))
    assert.isNull(normalizeInterfaces({ lan: {} }))
  })

  test('mwan3: service apart from status; policies kept by name', ({ assert }) => {
    const mwan3 = normalizeMwan3({
      service: { installed: true, enabled: false, running: false },
      interfaces: [
        {
          name: 'wan',
          status: 'online',
          uptimeSeconds: 86400,
          tracking: 'active',
          trackIps: [{ ip: '203.0.113.1', up: true }, { ip: 'nope' }],
        },
        { name: 'wan', status: 'dup' },
      ],
      policies: { balanced: [{ interface: 'wan', percent: 50 }, { percent: 50 }] },
    })!
    assert.deepEqual(mwan3.service, { installed: true, enabled: false, running: false })
    assert.lengthOf(mwan3.interfaces, 1)
    assert.deepEqual(mwan3.interfaces[0].trackIps, [{ ip: '203.0.113.1', up: true }])
    assert.deepEqual(mwan3.policies, { balanced: [{ interface: 'wan', percent: 50 }] })
    assert.isNull(normalizeMwan3({})!.service)

    // perch-collector's form: service flags at the top, config beside the live view.
    const collector = normalizeMwan3({
      serviceEnabled: false,
      running: true,
      configInterfaces: [{ name: 'wan', enabled: true, family: 'ipv4', trackIps: ['203.0.113.1'] }],
      interfaces: [{ name: 'wan', status: 'notracking', up: true, tracking: 'none', trackIps: [] }],
      policies: {},
      configPolicies: { balanced: ['wan_m1', 'wanb_m1', 42] },
    })!
    assert.deepEqual(collector.service, { installed: true, enabled: false, running: true })
    assert.deepEqual(collector.configInterfaces[0].trackIps, ['203.0.113.1'])
    assert.deepEqual(collector.configPolicies, { balanced: ['wan_m1', 'wanb_m1'] })
    assert.include(collector.interfaces[0], { status: 'notracking', up: true })
  })

  test('resolver, packages', ({ assert }) => {
    assert.deepEqual(
      normalizeResolver({ dnsmasqPort: 54, port53Process: 'AdGuardHome', controllerHost: 'x' }),
      {
        dnsmasqPort: 54,
        port53Process: 'AdGuardHome',
        port53Processes: ['AdGuardHome'],
        controllerHost: null,
      }
    )
    assert.deepInclude(
      normalizeResolver({
        dnsmasqPort: null,
        port53Process: null,
        port53Processes: [],
        controllerHost: { name: 'perch.example.com', addresses: [], error: 'not_found' },
      }),
      {
        dnsmasqPort: null,
        controllerHost: { name: 'perch.example.com', addresses: [], error: 'not_found' },
      }
    )
    const packages = normalizePackages({
      manager: 'apk',
      installed: [
        { name: 'mwan3', version: '2.11' },
        { name: 'dnsmasq', version: '2.90' },
        { name: 'broken' },
      ],
    })!
    assert.deepEqual(
      packages.installed.map((p) => p.name),
      ['dnsmasq', 'mwan3']
    )
    assert.isNull(packages.upgradable, 'not checked: unknown')
  })

  test('WireGuard keeps public keys only', ({ assert }) => {
    const wg = normalizeWireguard({
      interfaces: [
        {
          name: 'wg0',
          publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          privateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=',
          peers: [
            { publicKey: 'not a key' },
            {
              publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
              presharedKey: 'secret',
              allowedIps: ['10.0.0.2/32', 'fd00::2/128', 'junk'],
            },
          ],
        },
      ],
    })!
    assert.notInclude(JSON.stringify(wg), 'AAB=')
    assert.notInclude(JSON.stringify(wg), 'secret')
    assert.lengthOf(wg.interfaces[0].peers, 1)
    assert.deepEqual(wg.interfaces[0].peers[0].allowedIps, ['10.0.0.2/32', 'fd00::2/128'])
  })

  test('neighbours: MAC-less, broadcast and duplicate entries dropped; state strings read', ({
    assert,
  }) => {
    const entries = normalizeNeighbors([
      { ip: '192.168.10.21', mac: MAC, device: 'br-lan', state: 'STALE' },
      { ip: '192.168.10.21', mac: MAC, device: 'br-lan', state: 'STALE' },
      { ip: '192.168.10.121', mac: MAC, device: 'br-lan', state: 'reachable' },
      { ip: 'fe80::1', mac: MAC, device: 'br-lan', reachable: false },
      { ip: '192.168.10.99', mac: null, state: 'FAILED' },
      { ip: '192.168.10.255', mac: 'ff:ff:ff:ff:ff:ff' },
      { ip: 'not-an-ip', mac: '02:00:00:99:00:02' },
    ])!
    assert.lengthOf(entries, 3)
    const [row] = foldNeighbors(entries)
    assert.deepEqual(row, {
      mac: MAC,
      ipv4: '192.168.10.121',
      ipv6: ['fe80::1'],
      device: 'br-lan',
      network: null,
      reachable: true,
    })
    assert.isNull(normalizeNeighbors({}))
    assert.deepEqual(normalizeNeighbors([]), [])
  })

  test('UPnP: protocols, ports and duplicates', ({ assert }) => {
    const upnp = normalizeUpnp({
      enabled: true,
      mappings: [
        { proto: 'tcp', extPort: 80, intIp: '192.168.10.21', intPort: 8080, expires: 0 },
        { proto: 'TCP', extPort: 80, intIp: '192.168.10.22', intPort: 80 },
        { proto: 'SCTP', extPort: 9, intIp: '192.168.10.21', intPort: 9 },
        { proto: 'UDP', extPort: 70000, intIp: '192.168.10.21', intPort: 9 },
        { proto: 'UDP', extPort: 53, intIp: 'nope', intPort: 53 },
      ],
    })!
    assert.deepEqual(upnp.mappings, [
      {
        proto: 'TCP',
        extPort: 80,
        intIp: '192.168.10.22',
        intPort: 80,
        expires: 0,
        description: null,
      },
    ])
    assert.isTrue(upnp.installed)
    assert.isFalse(normalizeUpnp({ installed: false })!.installed)
  })
})

test.group('gateway observation | presence', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  const minutes = (m: number) => now - m * 60_000

  test('a sighting counts as traffic, only with gatewaySightings on', ({ assert }) => {
    const input = { wifi: null, trafficAt: minutes(45), gatewaySeenAt: minutes(1) }
    assert.deepEqual(devicePresence(input, PRESENCE_DEFAULTS, now), {
      status: 'connected',
      via: 'lan',
      lastSeenAt: new Date(minutes(1)).toISOString(),
    })
    assert.deepInclude(devicePresence(input, { ...PRESENCE_DEFAULTS, gatewaySightings: 0 }, now), {
      status: 'disconnected',
      lastSeenAt: new Date(minutes(45)).toISOString(),
    })
    assert.deepInclude(
      devicePresence(
        { wifi: null, trafficAt: null, gatewaySeenAt: minutes(2) },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'connected', via: 'lan' },
      'no traffic ever (a guest VLAN the collector does not capture)'
    )
  })

  test('a Wi-Fi departure is still a departure; a wired mark keeps its via', ({ assert }) => {
    const heardAt = minutes(20)
    assert.deepInclude(
      devicePresence(
        { wifi: { connected: false, heardAt }, trafficAt: minutes(18), gatewaySeenAt: null },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'disconnected', via: 'wifi' }
    )
    assert.deepInclude(
      devicePresence(
        { wifi: null, trafficAt: minutes(60), gatewaySeenAt: minutes(1), ethernet: true },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'connected', via: 'ethernet' }
    )
  })
})

test.group('gateway observation | memory and backups', () => {
  test('the per-collector memory is bounded, least recently written evicted', ({ assert }) => {
    forgetObservations()
    for (let id = 1; id <= MAX_REMEMBERED_OBSERVATIONS + 50; id++) {
      remember(id, 'dhcp', { fingerprint: String(id), observedWrittenAt: 1 })
      remember(id, 'neighbors', { fingerprint: String(id), observedWrittenAt: 1 })
    }
    assert.equal(rememberedCollectorCount(), MAX_REMEMBERED_OBSERVATIONS)
    assert.isUndefined(recall(1, 'dhcp'))
    assert.equal(recall(MAX_REMEMBERED_OBSERVATIONS + 50, 'neighbors')?.fingerprint, '306')
    forgetObservations()
  })

  test('a backup answer: base64 gzip, checksum, size cap', ({ assert }) => {
    const archive = gzipSync(Buffer.from('config'))
    const ok = decodeBackupAnswer({
      contentBase64: archive.toString('base64'),
      sha256: createHash('sha256').update(archive).digest('hex'),
      release: 'OpenWrt 24.10.2',
    })
    assert.equal(ok.archive.length, archive.length)
    assert.equal(ok.release, 'OpenWrt 24.10.2')

    const code = (answer: unknown) => {
      try {
        decodeBackupAnswer(answer)
        return null
      } catch (error) {
        return error instanceof ObserveRequestError ? `${error.status} ${error.code}` : 'other'
      }
    }
    assert.equal(code(null), '502 backup_failed')
    assert.equal(code({ archive: '%%%' }), '502 backup_failed')
    assert.equal(code({ archive: Buffer.from('plain').toString('base64') }), '502 backup_failed')
    assert.equal(
      code({ archive: archive.toString('base64'), sha256: '0'.repeat(64) }),
      '502 backup_failed'
    )
    assert.equal(
      code({ archive: Buffer.alloc(MAX_BACKUP_BYTES + 1).toString('base64') }),
      '413 backup_too_large'
    )
  })
})
