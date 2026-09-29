import {
  normalizeCountry,
  normalizeWifiConfigSettings,
  WIFI_CONFIG_DEFAULTS,
  wifiConfigSettingsErrors,
  wifiConfigSettingsView,
  wifiConfirmMode,
  wifiConfirmWindow,
} from '#services/wifi_config/settings'
import { test } from '@japa/runner'

test.group('wifi config settings | pure helpers', () => {
  test('defaults follow the design (D4 agent confirm, D14 no FT, D7 auto catch-up)', ({
    assert,
  }) => {
    const d = normalizeWifiConfigSettings(null)
    assert.deepEqual(d, { ...WIFI_CONFIG_DEFAULTS })
    assert.equal(d.confirmTimeoutSeconds, 120)
    assert.equal(d.confirmMode, 'agent')
    assert.equal(d.protectedConfirmMode, 'admin_and_agent')
    assert.isFalse(d.newNetworkFastRoaming)
    assert.equal(d.catchUpOnReconnect, 'auto')
    assert.equal(d.rolloutOrder, 'canary')
    assert.equal(d.rolloutOfflinePolicy, 'skip')
    assert.isNull(d.countryDefault)
    assert.isTrue(d.sealSecrets)
    assert.isFalse(d.allowInsecureTransport)
  })

  test('normalise: clamps numbers, drops wrong kinds and unknown choices', ({ assert }) => {
    const s = normalizeWifiConfigSettings({
      confirmTimeoutSeconds: 5000,
      managementConfirmTimeoutSeconds: 60,
      healthWaitSeconds: 12.5,
      confirmMode: 'admin_only',
      rolloutOrder: 'name',
      rolloutOfflinePolicy: 'wait',
      catchUpOnReconnect: 'ask',
      dfsAllowance: 'yes',
      countryDefault: 'ph',
      keepRevisions: 10,
    })
    assert.equal(s.confirmTimeoutSeconds, 600)
    assert.equal(s.managementConfirmTimeoutSeconds, 300)
    assert.equal(s.healthWaitSeconds, 45)
    assert.equal(s.confirmMode, 'agent')
    assert.equal(s.rolloutOrder, 'name')
    assert.equal(s.rolloutOfflinePolicy, 'wait')
    assert.equal(s.catchUpOnReconnect, 'ask')
    assert.isTrue(s.dfsAllowance)
    assert.equal(s.countryDefault, 'PH')
    assert.equal(s.keepRevisions, 50)
    assert.isNull(normalizeWifiConfigSettings({ countryDefault: 'Philippines' }).countryDefault)
  })

  test('PATCH errors name every refused field', ({ assert }) => {
    assert.deepEqual(
      wifiConfigSettingsErrors({ confirmTimeoutSeconds: 120, countryDefault: null }),
      []
    )
    const fields = wifiConfigSettingsErrors({
      confirmTimeoutSeconds: 10,
      countryDefault: 'XYZ',
      sealSecrets: 'no',
      confirmMode: 'x',
      bogus: 1,
    }).map((e) => e.field)
    assert.sameMembers(fields, [
      'confirmTimeoutSeconds',
      'countryDefault',
      'sealSecrets',
      'confirmMode',
      'bogus',
    ])
  })

  test('country codes', ({ assert }) => {
    assert.equal(normalizeCountry(' us '), 'US')
    assert.isNull(normalizeCountry('00'))
    assert.isNull(normalizeCountry('USA'))
    assert.isNull(normalizeCountry(12))
  })

  test('confirm window: DFS allowance, the management window, the AP cap', ({ assert }) => {
    const s = { ...WIFI_CONFIG_DEFAULTS }
    assert.equal(wifiConfirmWindow(s, { protected: false }), 120)
    assert.equal(wifiConfirmWindow(s, { protected: false, cacAllowanceSeconds: 60 }), 180)
    assert.equal(
      wifiConfirmWindow(
        { ...s, dfsAllowance: false },
        { protected: false, cacAllowanceSeconds: 60 }
      ),
      120
    )
    assert.equal(wifiConfirmWindow(s, { protected: true }), 300)
    assert.equal(
      wifiConfirmWindow(s, { protected: false, cacAllowanceSeconds: 600, apMaxSeconds: 900 }),
      720
    )
    assert.equal(wifiConfirmWindow(s, { protected: true, apMaxSeconds: 200 }), 200)
  })

  test('confirm mode: reverts, catch-ups and queued jobs never wait for a click', ({ assert }) => {
    const s = { ...WIFI_CONFIG_DEFAULTS }
    assert.equal(wifiConfirmMode(s, { protected: false, kind: 'apply' }), 'agent')
    assert.equal(wifiConfirmMode(s, { protected: true, kind: 'apply' }), 'admin_and_agent')
    assert.equal(wifiConfirmMode(s, { protected: true, kind: 'revert' }), 'agent')
    assert.equal(wifiConfirmMode(s, { protected: true, kind: 'apply', catchUp: true }), 'agent')
    assert.equal(wifiConfirmMode(s, { protected: true, kind: 'apply', queued: true }), 'agent')
    assert.equal(
      wifiConfirmMode(
        { ...s, confirmMode: 'admin_and_agent' },
        { protected: false, kind: 'apply' }
      ),
      'admin_and_agent'
    )
  })

  test('the settings view lists defaults, limits and choices', ({ assert }) => {
    const view = wifiConfigSettingsView({ ...WIFI_CONFIG_DEFAULTS })
    assert.deepEqual(view.choices.rolloutOrder, ['canary', 'name'])
    assert.deepEqual(view.limits.managementConfirmTimeoutSeconds, { min: 300, max: 1800 })
  })
})
