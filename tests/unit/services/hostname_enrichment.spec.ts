import { test } from '@japa/runner'
import { parseDhcpLeases, parseOpenWrtStaticHosts } from '#services/hostname_enrichment'

test.group('hostname_enrichment | parseDhcpLeases', () => {
  test('extracts MAC/IP/hostname from dnsmasq lease rows', ({ assert }) => {
    const rows = parseDhcpLeases(`
1716649000 aa:bb:cc:dd:ee:ff 192.168.2.100 living-room-tv 01:aa
1716649001 11:22:33:44:55:66 192.168.2.101 * 01:bb
`)

    assert.lengthOf(rows, 1)
    assert.deepEqual(rows[0], {
      mac: 'aa:bb:cc:dd:ee:ff',
      ip: '192.168.2.100',
      hostname: 'living-room-tv',
      source: 'dhcp_lease',
    })
  })
})

test.group('hostname_enrichment | parseOpenWrtStaticHosts', () => {
  test('parses host sections from uci output', ({ assert }) => {
    const rows = parseOpenWrtStaticHosts(`
dhcp.nas=host
dhcp.nas.name='NAS-Box'
dhcp.nas.mac='AA:AA:AA:AA:AA:AA'
dhcp.nas.ip='192.168.2.10'
`)

    assert.lengthOf(rows, 1)
    assert.deepEqual(rows[0], {
      mac: 'aa:aa:aa:aa:aa:aa',
      ip: '192.168.2.10',
      hostname: 'NAS-Box',
      source: 'openwrt_static',
    })
  })

  test('supports anonymous @host sections and multi-mac values', ({ assert }) => {
    const rows = parseOpenWrtStaticHosts(`
dhcp.@host[0]=host
dhcp.@host[0].name='printer'
dhcp.@host[0].mac='AA:BB:CC:DD:EE:01 AA:BB:CC:DD:EE:02'
`)

    assert.lengthOf(rows, 2)
    assert.deepEqual(
      rows.map((row) => row.mac),
      ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']
    )
    assert.isTrue(rows.every((row) => row.hostname === 'printer'))
  })
})
