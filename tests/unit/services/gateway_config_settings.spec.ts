import {
  confirmTimeoutFor,
  GATEWAY_CONFIG_DEFAULTS,
  isValidLocalStatePath,
  normalizeGatewayConfigSettings,
  resolveLocalState,
} from '#services/gateway_config/gateway_config_settings'
import { test } from '@japa/runner'

test.group('gateway config settings | pure helpers', () => {
  test('normalise: null and garbage read as the defaults', ({ assert }) => {
    assert.deepEqual(normalizeGatewayConfigSettings(null), { ...GATEWAY_CONFIG_DEFAULTS })
    assert.deepEqual(normalizeGatewayConfigSettings('x'), { ...GATEWAY_CONFIG_DEFAULTS })
    assert.equal(normalizeGatewayConfigSettings({}).authoritativeRevertDelaySeconds, 90)
  })

  test('local state path validation', ({ assert }) => {
    for (const ok of ['/etc/perch-collector/state', '/mnt/sda1/perch', '/overlay/x.db']) {
      assert.isTrue(isValidLocalStatePath(ok), ok)
    }
    for (const bad of ['', '/', 'etc/x', '/etc/../x', '/./x', '/a b', '/a;b', '/a//b', '/a/']) {
      assert.isFalse(isValidLocalStatePath(bad), bad)
    }
  })

  test('confirm window: protected jobs get the management window, the router caps both', ({
    assert,
  }) => {
    const s = { ...GATEWAY_CONFIG_DEFAULTS }
    assert.equal(confirmTimeoutFor(s, { protected: false }), 90)
    assert.equal(confirmTimeoutFor(s, { protected: true }), 300)
    assert.equal(confirmTimeoutFor(s, { protected: true, routerMaxSeconds: 200 }), 200)
    assert.equal(confirmTimeoutFor(s, { protected: false, routerMaxSeconds: 0 }), 90)
    // A management window configured below the normal one never shortens it.
    const odd = { ...s, confirmTimeoutSeconds: 400, managementConfirmTimeoutSeconds: 120 }
    assert.equal(confirmTimeoutFor(odd, { protected: true }), 400)
  })

  test('local state: storage class picks the flush interval, overrides win', ({ assert }) => {
    const s = { ...GATEWAY_CONFIG_DEFAULTS }
    const none = { localStatePath: null, localStateFlushSeconds: null }
    assert.deepEqual(resolveLocalState(s, none, 'spi_flash'), {
      path: '/etc/perch-collector/state',
      flushSeconds: 300,
      source: 'setting',
    })
    assert.equal(resolveLocalState(s, none, 'emmc').flushSeconds, 0, 'write-through')
    assert.equal(resolveLocalState(s, none, 'usb').flushSeconds, 0)
    assert.equal(resolveLocalState(s, none, 'sata').flushSeconds, 0)
    assert.equal(resolveLocalState(s, none, null).flushSeconds, 300, 'unknown counts as flash')
    assert.equal(resolveLocalState(s, none, 'ram').flushSeconds, 300)
    assert.deepEqual(
      resolveLocalState(s, { localStatePath: '/mnt/usb/p', localStateFlushSeconds: 60 }, 'usb'),
      { path: '/mnt/usb/p', flushSeconds: 60, source: 'gateway' }
    )
    assert.equal(
      resolveLocalState(s, { localStatePath: '/../bad', localStateFlushSeconds: null }, 'usb').path,
      '/etc/perch-collector/state',
      'an invalid override falls back to the setting'
    )
  })
})
