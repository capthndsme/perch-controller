import ApConfig from '#models/ap_config'
import ApConfigApply from '#models/ap_config_apply'
import ApConfigEvent from '#models/ap_config_event'
import ApConfigRevision from '#models/ap_config_revision'
import ApConfigSection from '#models/ap_config_section'
import SystemSetting from '#models/system_setting'
import WifiAccessPoint from '#models/wifi_access_point'
import WifiDivergence from '#models/wifi_divergence'
import WifiIfaceLink from '#models/wifi_iface_link'
import WifiNetwork from '#models/wifi_network'
import WifiNetworkAp from '#models/wifi_network_ap'
import WifiRollout from '#models/wifi_rollout'
import WifiRolloutStep from '#models/wifi_rollout_step'
import WifiSecret from '#models/wifi_secret'
import {
  getWifiConfigSettings,
  getWifiFingerprintKey,
  updateWifiConfigSettings,
  WIFI_CONFIG_DEFAULTS,
  WIFI_FINGERPRINT_KEY_SETTING,
} from '#services/wifi_config/settings'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * The Wi-Fi plane's data layer (docs/design/wifi controller.md section 2,
 * migrations 125–137): models round-trip their JSON, secrets are encrypted
 * at rest, SSIDs compare as bytes, and the foreign keys cascade or detach as
 * the design says.
 */

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
}

async function makeAp(name: string) {
  return WifiAccessPoint.create({
    name,
    friendlyName: name,
    metricsUrl: null,
    transport: 'agent',
    pollIntervalSeconds: 5,
    enabled: true,
    enableTwoWayCommands: false,
    sshHost: null,
    sshPort: 22,
    sshUsername: null,
    sshPrivateKey: null,
    model: null,
    openwrtRelease: null,
    nodename: null,
    lastStatus: null,
    lastSeenAt: null,
  })
}

const NOW = DateTime.fromISO('2026-10-02T10:00:00Z', { zone: 'utc' })

function networkRow(name: string, ssid: string) {
  return {
    name,
    ssid,
    enabled: true,
    security: 'wpa2' as const,
    passphraseRef: null,
    hidden: false,
    isolate: false,
    binding: { kind: 'lan' as const },
    bands: ['2g' as const, '5g' as const],
    apScope: 'all' as const,
    roaming: { ft: false, mobilityDomain: null, rrm: false, btm: false },
    advanced: {
      pmf: 'default' as const,
      multicastToUnicast: null,
      maxClients: null,
      dtimPeriod: null,
    },
    groups: false,
    origin: 'import' as const,
    revision: 1,
  }
}

test.group('wifi config | data layer', (group) => {
  group.each.setup(resetDb)

  test('ap_configs: self-assigned key, JSON columns, encrypted pairing key', async ({ assert }) => {
    const ap = await makeAp('garage')
    const row = await ApConfig.create({
      apId: ap.id,
      mode: 'observe',
      capabilities: { protocol: 1, radios: [], regulatory: { global: 'PH', settable: true } },
      observedHashes: { wireless: 'w1' },
      observedLedger: [
        { perchId: 'k1', config: 'wireless', section: 'wifinet3', domain: 'wifi_ifaces' },
      ],
      observedState: { luciPending: false, uncommitted: [], readAt: NOW.toISO() },
      managementPath: { network: 'lan', device: 'br-lan.1', radios: [] },
      pairingKey: 'ab'.repeat(32),
      countryMode: 'fleet',
    })
    const fresh = await ApConfig.findOrFail(ap.id)
    assert.equal(fresh.apId, ap.id)
    assert.equal(fresh.mode, 'observe')
    assert.equal(fresh.syncState, 'unknown')
    assert.equal(fresh.fleetState, 'unknown')
    assert.equal(fresh.enforcement, 'active')
    assert.deepEqual(fresh.managementPath, { network: 'lan', device: 'br-lan.1', radios: [] })
    assert.equal(fresh.observedLedger?.[0].domain, 'wifi_ifaces')
    assert.equal(fresh.capabilities?.regulatory?.global, 'PH')
    assert.equal(fresh.pairingKey, 'ab'.repeat(32))
    const raw = await db.from('ap_configs').where('ap_id', ap.id).firstOrFail()
    assert.notInclude(String(raw.pairing_key), 'abab')
    assert.notProperty(row.serialize(), 'pairingKey')
  })

  test('deleting an AP drops its plane state and fleet rows', async ({ assert }) => {
    const ap = await makeAp('first-floor')
    await ApConfig.create({ apId: ap.id, mode: 'managed' })
    await ApConfigSection.create({
      apId: ap.id,
      perchId: 'k1',
      config: 'wireless',
      sectionName: 'wifinet13',
      sectionType: 'wifi-iface',
      anonymous: false,
      scope: 'synced',
      domain: 'wifi_ifaces',
      ownership: { kind: 'options', options: ['ssid'] },
      issue: null,
      baseContent: { type: 'wifi-iface', options: { ssid: 'Home' } },
      routerContent: { type: 'wifi-iface', options: { ssid: 'Home' } },
      desiredContent: { type: 'wifi-iface', options: { ssid: 'Home' } },
      status: 'in_sync',
    })
    const apply = await ApConfigApply.create({
      apId: ap.id,
      applyKey: `a${ap.id}-000000000001`,
      kind: 'apply',
      state: 'queued',
      ops: [],
      baseHashes: {},
      perchIds: ['k1'],
      protected: false,
      confirmMode: 'agent',
      confirmTimeoutSeconds: 120,
      requestedAt: NOW,
      cacAllowanceSeconds: 60,
      health: null,
    })
    await ApConfigRevision.create({
      apId: ap.id,
      number: 1,
      source: 'import',
      summary: 'import',
      snapshot: [],
      diff: [],
      hashes: { wireless: 'w1' },
      applyId: apply.id,
    })
    await ApConfigEvent.create({ apId: ap.id, event: 'read', detail: { configs: ['wireless'] } })
    const network = await WifiNetwork.create(networkRow('Home', 'Home'))
    await WifiNetworkAp.create({ networkId: network.id, apId: ap.id, included: null })
    await WifiIfaceLink.create({
      apId: ap.id,
      perchId: 'k1',
      networkId: network.id,
      radio: 'radio1',
      origin: 'adopted',
    })
    await WifiDivergence.create({
      apId: ap.id,
      networkId: network.id,
      perchId: 'k1',
      radio: 'radio1',
      kind: 'option',
      option: 'hidden',
      fleetValue: '0',
      apValue: '1',
      routerAuthor: { kind: 'luci', user: 'root' },
      detectedAt: NOW,
    })
    const rollout = await WifiRollout.create({
      kind: 'change',
      state: 'running',
      confirmMode: 'agent',
      offlinePolicy: 'skip',
      networkIds: [network.id],
      apOrder: [ap.id],
    })
    await WifiRolloutStep.create({
      rolloutId: rollout.id,
      apId: ap.id,
      position: 0,
      state: 'applying',
      perchIds: ['k1'],
      applyId: apply.id,
    })

    const reread = await WifiDivergence.findByOrFail('apId', ap.id)
    assert.deepEqual(reread.routerAuthor, { kind: 'luci', user: 'root' })
    assert.equal(reread.fleetValue, '0')

    await ap.delete()
    for (const table of [
      'ap_configs',
      'ap_config_sections',
      'ap_config_applies',
      'ap_config_revisions',
      'ap_config_events',
      'wifi_network_aps',
      'wifi_iface_links',
      'wifi_divergences',
      'wifi_rollout_steps',
    ]) {
      const [{ n }] = await db.from(table).count('* as n')
      assert.equal(Number(n), 0, table)
    }
    // The fleet's own rows stay.
    assert.isNotNull(await WifiNetwork.find(network.id))
    assert.isNotNull(await WifiRollout.find(rollout.id))
  })

  test('rollouts: a job detaches when its rollout goes, steps go with it', async ({ assert }) => {
    const ap = await makeAp('second-floor')
    await ApConfig.create({ apId: ap.id, mode: 'managed' })
    const rollout = await WifiRollout.create({
      kind: 'change',
      state: 'completed',
      confirmMode: 'agent',
      offlinePolicy: 'skip',
      networkIds: [],
      apOrder: [ap.id],
      stop: { apId: ap.id, reason: 'health_failed', applyId: null, message: 'BSS missing' },
    })
    const apply = await ApConfigApply.create({
      apId: ap.id,
      applyKey: `a${ap.id}-000000000002`,
      kind: 'apply',
      state: 'confirmed',
      ops: [],
      baseHashes: {},
      perchIds: [],
      protected: false,
      confirmMode: 'agent',
      confirmTimeoutSeconds: 120,
      requestedAt: NOW,
      rolloutId: rollout.id,
    })
    await WifiRolloutStep.create({
      rolloutId: rollout.id,
      apId: ap.id,
      position: 0,
      state: 'confirmed',
      perchIds: [],
      applyId: apply.id,
      outcome: null,
    })
    const stored = await WifiRollout.findOrFail(rollout.id)
    assert.equal(stored.stop?.reason, 'health_failed')
    await rollout.delete()
    await apply.refresh()
    assert.isNull(apply.rolloutId)
    const [{ n }] = await db.from('wifi_rollout_steps').count('* as n')
    assert.equal(Number(n), 0)
  })

  test('wifi_networks: SSIDs are bytes (case and spaces count), JSON round-trips', async ({
    assert,
  }) => {
    await WifiNetwork.create(networkRow('Home', 'Home'))
    await WifiNetwork.create(networkRow('home lower', 'home'))
    await WifiNetwork.create(networkRow('home space', 'Home '))
    await WifiNetwork.create(networkRow('Café', 'Café ☕'))
    const exact = await WifiNetwork.query().where('ssid', Buffer.from('Home', 'utf8'))
    assert.lengthOf(exact, 1)
    assert.equal(exact[0].name, 'Home')
    const cafe = await WifiNetwork.findByOrFail('name', 'Café')
    assert.equal(cafe.ssid, 'Café ☕')
    assert.deepEqual(cafe.bands, ['2g', '5g'])
    assert.deepEqual(cafe.binding, { kind: 'lan' })
    assert.equal(cafe.roaming.ft, false)
    assert.equal(cafe.advanced.pmf, 'default')
  })

  test('wifi_secrets: value encrypted at rest; a network loses a deleted ref', async ({
    assert,
  }) => {
    const secret = await WifiSecret.create({
      ref: 'sabcdefghijklmnopqrst',
      value: 'correct horse battery',
      fingerprint: 'hmac:ac349a3eb980336c',
      digest: 'a'.repeat(64),
    })
    const raw = await db.from('wifi_secrets').where('id', secret.id).firstOrFail()
    assert.notInclude(String(raw.value), 'correct horse')
    assert.notProperty(secret.serialize(), 'value')
    const reread = await WifiSecret.findOrFail(secret.id)
    assert.equal(reread.value, 'correct horse battery')
    const network = await WifiNetwork.create({
      ...networkRow('Home', 'Home'),
      passphraseRef: secret.ref,
    })
    await secret.delete()
    await network.refresh()
    assert.isNull(network.passphraseRef)
  })

  test('device_groups.wifi_network_id detaches when the network is deleted', async ({ assert }) => {
    const [gatewayId] = await db
      .table('gateways')
      .insert({ mode: 'off', created_at: new Date(), updated_at: new Date() })
    const network = await WifiNetwork.create(networkRow('Kids', 'Kids'))
    const [groupId] = await db.table('device_groups').insert({
      gateway_id: gatewayId,
      name: 'kids',
      wifi_network_id: network.id,
      created_at: new Date(),
    })
    await network.delete()
    const deviceGroup = await db.from('device_groups').where('id', groupId).firstOrFail()
    assert.isNull(deviceGroup.wifi_network_id)
  })

  test('settings: defaults, a saved change, and the fingerprint key', async ({ assert }) => {
    assert.deepEqual(await getWifiConfigSettings(), { ...WIFI_CONFIG_DEFAULTS })
    const saved = await updateWifiConfigSettings({ countryDefault: 'ph', confirmTimeoutSeconds: 5 })
    assert.equal(saved.countryDefault, 'PH')
    assert.equal(saved.confirmTimeoutSeconds, 30, 'clamped to the range')
    const reloaded = await getWifiConfigSettings()
    assert.equal(reloaded.countryDefault, 'PH')

    const key = await getWifiFingerprintKey()
    assert.equal(key.length, 32)
    assert.deepEqual(await getWifiFingerprintKey(), key, 'created once, then reused')
    const stored = await SystemSetting.get<string>(WIFI_FINGERPRINT_KEY_SETTING)
    assert.isString(stored)
    assert.notInclude(stored!, key.toString('hex'), 'APP_KEY-encrypted at rest')
    // A value that no longer decrypts (APP_KEY rotated) is replaced.
    await SystemSetting.set(WIFI_FINGERPRINT_KEY_SETTING, 'garbage')
    const replaced = await getWifiFingerprintKey()
    assert.equal(replaced.length, 32)
    assert.notDeepEqual(replaced, key)
  })
})
