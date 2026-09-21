import {
  getHostnameMatches,
  resetHostnameEnrichmentCacheForTesting,
  setHostnameCommandRunnerForTesting,
} from '#services/hostname_enrichment'
import {
  defaultHostnameEnrichmentSettings,
  setHostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
}

test.group('hostname_enrichment | getHostnameMatches (batched)', (group) => {
  group.each.setup(async () => {
    await resetDb()
    resetHostnameEnrichmentCacheForTesting()
  })
  group.each.teardown(() => {
    setHostnameCommandRunnerForTesting(null)
    resetHostnameEnrichmentCacheForTesting()
  })

  test('resolves the whole list with a single state load (no per-identity N+1)', async ({
    assert,
  }) => {
    await setHostnameEnrichmentSettings({
      ...defaultHostnameEnrichmentSettings(),
      enabled: true,
    })

    let commandCalls = 0
    setHostnameCommandRunnerForTesting(async (_settings, command) => {
      commandCalls += 1
      // dnsmasq lease line: <expiry> <mac> <ip> <hostname> <clientid>
      if (command[0] === 'cat') {
        return '1739000000 aa:bb:cc:dd:ee:ff 192.168.1.50 my-laptop *\n'
      }
      return '' // uci show dhcp
    })

    const matches = await getHostnameMatches([
      { mac: 'aa:bb:cc:dd:ee:ff', primaryIp: null, ips: [] },
      { mac: 'ff:ff:ff:ff:ff:ff', primaryIp: null, ips: [] },
      { mac: 'aa:bb:cc:dd:ee:ff', primaryIp: null, ips: [] },
    ])

    // Results are in input order; unknown MAC is null.
    assert.equal(matches.length, 3)
    assert.equal(matches[0]?.hostname, 'my-laptop')
    assert.equal(matches[0]?.source, 'dhcp_lease')
    assert.equal(matches[1], null)
    assert.equal(matches[2]?.hostname, 'my-laptop')

    // The state was loaded exactly once for the whole batch — two commands
    // (cat leases + uci show dhcp), NOT two-per-identity.
    assert.equal(commandCalls, 2)
  })

  test('a second batch within the TTL reuses the cached state', async ({ assert }) => {
    await setHostnameEnrichmentSettings({
      ...defaultHostnameEnrichmentSettings(),
      enabled: true,
    })

    let loads = 0
    setHostnameCommandRunnerForTesting(async (_settings, command) => {
      if (command[0] === 'cat') loads += 1
      return command[0] === 'cat' ? '1739000000 aa:bb:cc:dd:ee:ff 10.0.0.1 host-a *\n' : ''
    })

    await getHostnameMatches([{ mac: 'aa:bb:cc:dd:ee:ff', primaryIp: null, ips: [] }])
    await getHostnameMatches([{ mac: 'aa:bb:cc:dd:ee:ff', primaryIp: null, ips: [] }])

    assert.equal(loads, 1, 'state fetched once, not per call')
  })
})
