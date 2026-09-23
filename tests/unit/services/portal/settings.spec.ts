import {
  PORTAL_SETTINGS_DEFAULTS,
  PORTAL_SETTINGS_LIMITS,
  mergePortalSettings,
  normalizePortalSettings,
  portalSettingsView,
} from '#services/portal/settings'
import { getPortalSettings, updatePortalSettings } from '#services/portal_settings'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

test.group('portal settings: normalize', () => {
  test('nothing stored reads as the defaults', ({ assert }) => {
    for (const v of [null, undefined, 'x', 42, [], [1]]) {
      assert.deepEqual(normalizePortalSettings(v), PORTAL_SETTINGS_DEFAULTS)
    }
  })

  test('the defaults are inside their own ranges', ({ assert }) => {
    for (const [key, { min, max }] of Object.entries(PORTAL_SETTINGS_LIMITS)) {
      const value = PORTAL_SETTINGS_DEFAULTS[key as keyof typeof PORTAL_SETTINGS_LIMITS]
      assert.isAtLeast(value, min, key)
      assert.isAtMost(value, max, key)
    }
  })

  test('out-of-range numbers are clamped; wrong types fall back', ({ assert }) => {
    const s = normalizePortalSettings({
      sessionRetentionDays: 10_000,
      enforceIntervalSeconds: 0,
      usageIntervalSeconds: 12.5,
      guestFailuresPerPortalPerMinute: '100',
      offlineRedemption: 'no',
      offlineVoucherLimit: -3,
      unknownKey: 1,
    })
    assert.equal(s.sessionRetentionDays, 730)
    assert.equal(s.enforceIntervalSeconds, 2)
    assert.equal(s.usageIntervalSeconds, PORTAL_SETTINGS_DEFAULTS.usageIntervalSeconds)
    assert.equal(s.guestFailuresPerPortalPerMinute, 60)
    assert.isTrue(s.offlineRedemption)
    assert.equal(s.offlineVoucherLimit, 0)
    assert.notProperty(s, 'unknownKey')
  })

  test('booleans are kept', ({ assert }) => {
    assert.isFalse(normalizePortalSettings({ offlineRedemption: false }).offlineRedemption)
  })

  test('merge applies defined fields only', ({ assert }) => {
    const merged = mergePortalSettings(
      { ...PORTAL_SETTINGS_DEFAULTS, sessionRetentionDays: 60 },
      { enforceIntervalSeconds: 10, sessionRetentionDays: undefined }
    )
    assert.equal(merged.enforceIntervalSeconds, 10)
    assert.equal(merged.sessionRetentionDays, 60)
  })

  test('view carries defaults and limits', ({ assert }) => {
    const view = portalSettingsView(PORTAL_SETTINGS_DEFAULTS)
    assert.deepEqual(view.defaults, PORTAL_SETTINGS_DEFAULTS)
    assert.deepEqual(view.limits, PORTAL_SETTINGS_LIMITS)
  })
})

test.group('portal settings: stored', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('get returns defaults, update persists and clamps', async ({ assert }) => {
    assert.deepEqual(await getPortalSettings(), PORTAL_SETTINGS_DEFAULTS)
    const saved = await updatePortalSettings({
      sessionRetentionDays: 7,
      enforceIntervalSeconds: 999,
    })
    assert.equal(saved.sessionRetentionDays, 7)
    assert.equal(saved.enforceIntervalSeconds, 60)
    const again = await getPortalSettings()
    assert.equal(again.sessionRetentionDays, 7)
    assert.equal(again.enforceIntervalSeconds, 60)
    const partial = await updatePortalSettings({ offlineRedemption: false })
    assert.equal(partial.sessionRetentionDays, 7)
    assert.isFalse(partial.offlineRedemption)
  })
})
