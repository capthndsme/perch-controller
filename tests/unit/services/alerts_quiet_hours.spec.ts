import { backoffSeconds } from '#services/alerts/delivery_worker'
import {
  mergeFilters,
  normalizeFilters,
  PUSH_FILTER_DEFAULTS,
  webhookFilterDefaults,
  filterMatches,
} from '#services/alerts/filters'
import { quietHoldUntil, quietWindowEnd } from '#services/alerts/quiet_hours'
import { expiryFor, newMessageId } from '#services/alerts/routing'
import {
  ALERTS_DEFAULTS,
  applyAlertsSettingsPatch,
  vapidSubjectFor,
} from '#services/alerts/settings'
import { getAlertType } from '#services/alerts/catalogue/index'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const utc = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })
const iso = (d: DateTime | null) => (d ? d.toUTC().toISO({ suppressMilliseconds: true }) : null)

test.group('alerts quiet hours', () => {
  test('a window across midnight in Asia/Manila', ({ assert }) => {
    const qh = { start: '22:00', end: '07:00' }
    // 23:30 Manila = 15:30Z: inside, ends 07:00 Manila next day = 23:00Z.
    assert.equal(
      iso(quietWindowEnd(utc('2026-10-01T15:30:00Z'), qh, 'Asia/Manila')),
      '2026-10-01T23:00:00Z'
    )
    // 03:00 Manila = 19:00Z the day before: inside the window that started yesterday.
    assert.equal(
      iso(quietWindowEnd(utc('2026-10-01T19:00:00Z'), qh, 'Asia/Manila')),
      '2026-10-01T23:00:00Z'
    )
    // 07:00 Manila exactly: outside (end is exclusive); 21:59: outside.
    assert.isNull(quietWindowEnd(utc('2026-10-01T23:00:00Z'), qh, 'Asia/Manila'))
    assert.isNull(quietWindowEnd(utc('2026-10-01T13:59:00Z'), qh, 'Asia/Manila'))
    // 22:00 exactly: inside.
    assert.equal(
      iso(quietWindowEnd(utc('2026-10-01T14:00:00Z'), qh, 'Asia/Manila')),
      '2026-10-01T23:00:00Z'
    )
  })

  test('a same-day window, and an empty one', ({ assert }) => {
    const qh = { start: '13:00', end: '15:00' }
    assert.equal(
      iso(quietWindowEnd(utc('2026-10-01T05:30:00Z'), qh, 'Asia/Manila')),
      '2026-10-01T07:00:00Z'
    )
    assert.isNull(quietWindowEnd(utc('2026-10-01T08:00:00Z'), qh, 'Asia/Manila'))
    assert.isNull(
      quietWindowEnd(utc('2026-10-01T05:30:00Z'), { start: '13:00', end: '13:00' }, 'UTC')
    )
  })

  test('daylight saving in Europe/Berlin: the night the clocks go back is an hour longer', ({
    assert,
  }) => {
    const qh = { start: '22:00', end: '07:00' }
    // 2026-10-25 03:00 CEST → 02:00 CET. 22:00 CEST = 20:00Z, 07:00 CET = 06:00Z (10 h).
    assert.equal(
      iso(quietWindowEnd(utc('2026-10-24T20:00:00Z'), qh, 'Europe/Berlin')),
      '2026-10-25T06:00:00Z'
    )
    assert.equal(
      iso(quietWindowEnd(utc('2026-10-25T01:30:00Z'), qh, 'Europe/Berlin')),
      '2026-10-25T06:00:00Z'
    )
    assert.isNull(quietWindowEnd(utc('2026-10-24T19:59:00Z'), qh, 'Europe/Berlin'))
    // 2026-03-29 02:00 CET → 03:00 CEST. 22:00 CET = 21:00Z, 07:00 CEST = 05:00Z (8 h).
    assert.equal(
      iso(quietWindowEnd(utc('2026-03-28T21:00:00Z'), qh, 'Europe/Berlin')),
      '2026-03-29T05:00:00Z'
    )
    assert.isNull(quietWindowEnd(utc('2026-03-29T05:00:00Z'), qh, 'Europe/Berlin'))
  })

  test('break-through, the destination opt-out, and the switch', ({ assert }) => {
    const now = utc('2026-10-01T15:30:00Z')
    const on = {
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '07:00',
        breakThrough: 'critical' as const,
      },
    }
    assert.isNotNull(quietHoldUntil(on, 'inherit', 'warning', now, 'Asia/Manila'))
    assert.isNull(quietHoldUntil(on, 'inherit', 'critical', now, 'Asia/Manila'))
    assert.isNull(quietHoldUntil(on, 'ignore', 'warning', now, 'Asia/Manila'))
    const none = { quietHours: { ...on.quietHours, breakThrough: 'none' as const } }
    assert.isNotNull(quietHoldUntil(none, 'inherit', 'critical', now, 'Asia/Manila'))
    const off = { quietHours: { ...on.quietHours, enabled: false } }
    assert.isNull(quietHoldUntil(off, 'inherit', 'warning', now, 'Asia/Manila'))
  })
})

test.group('alerts delivery helpers', () => {
  test('backoff: 10 s, 30 s, 2 min, 10 min, 30 min, then hourly', ({ assert }) => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 9].map(backoffSeconds),
      [10, 30, 120, 600, 1800, 3600, 3600]
    )
  })

  test('expiry: push by severity TTL (recoveries and tests ≤ 60 min), webhooks by retry hours', ({
    assert,
  }) => {
    const now = utc('2026-10-01T00:00:00Z')
    const s = ALERTS_DEFAULTS
    assert.equal(iso(expiryFor('push', 'critical', 'opened', s, now)), '2026-10-02T00:00:00Z')
    assert.equal(iso(expiryFor('push', 'info', 'opened', s, now)), '2026-10-01T04:00:00Z')
    assert.equal(iso(expiryFor('push', 'critical', 'resolved', s, now)), '2026-10-01T01:00:00Z')
    assert.equal(iso(expiryFor('webhook', 'info', 'opened', s, now)), '2026-10-02T00:00:00Z')
  })

  test('message ids are msg_ + 26 base32 characters, unique', ({ assert }) => {
    const now = utc('2026-10-01T06:03:05Z')
    const a = newMessageId(now)
    assert.match(a, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.notEqual(a, newMessageId(now))
  })

  test('filters: defaults, normalisation, matching', ({ assert }) => {
    assert.deepEqual(normalizeFilters(null, PUSH_FILTER_DEFAULTS), PUSH_FILTER_DEFAULTS)
    assert.equal(webhookFilterDefaults('standard').quietHours, 'ignore')
    assert.equal(webhookFilterDefaults('ntfy').quietHours, 'inherit')
    assert.equal(webhookFilterDefaults('standard', 'homeassistant').minSeverity, 'info')
    const f = mergeFilters(null, { categories: ['wan', 'bogus' as never] }, PUSH_FILTER_DEFAULTS)
    assert.deepEqual(f.categories, ['wan'])
    assert.isFalse(
      filterMatches(f, { severity: 'critical', category: 'agents', type: 'ap.offline' })
    )
    assert.isTrue(filterMatches(f, { severity: 'critical', category: 'wan', type: 'wan.down' }))
    assert.isFalse(filterMatches(f, { severity: 'info', category: 'wan', type: 'wan.down' }))
  })

  test('settings PATCH merges nested objects and rule overrides; null resets', ({ assert }) => {
    const lookup = getAlertType
    let s = applyAlertsSettingsPatch(
      ALERTS_DEFAULTS,
      {
        quietHours: { enabled: true },
        rules: { 'device.new': { severity: 'warning', params: { minPresenceMinutes: 5 } } },
      },
      { origin: 'https://perch.example.com', lookup }
    )
    assert.deepEqual(s.quietHours, { ...ALERTS_DEFAULTS.quietHours, enabled: true })
    assert.equal(s.capturedOrigin, 'https://perch.example.com')
    assert.deepEqual(s.rules['device.new'], {
      severity: 'warning',
      params: { minPresenceMinutes: 5 },
    })
    s = applyAlertsSettingsPatch(
      s,
      { rules: { 'device.new': { holdSeconds: 10, params: { minPresenceMinutes: null } } } },
      { lookup }
    )
    assert.deepEqual(s.rules['device.new'], { severity: 'warning', holdSeconds: 10 })
    s = applyAlertsSettingsPatch(s, { rules: { 'device.new': null } }, { lookup })
    assert.notProperty(s.rules, 'device.new')
  })

  test('VAPID subject: explicit, else the HTTPS dashboard origin, else the project page', ({
    assert,
  }) => {
    const base = { vapidSubject: null, dashboardUrl: null, capturedOrigin: null }
    assert.equal(
      vapidSubjectFor({ ...base, vapidSubject: 'mailto:me@example.com' }),
      'mailto:me@example.com'
    )
    assert.equal(
      vapidSubjectFor({ ...base, capturedOrigin: 'https://perch.example.com' }),
      'https://perch.example.com'
    )
    assert.equal(
      vapidSubjectFor({ ...base, capturedOrigin: 'http://192.168.1.2:8080' }),
      'https://github.com/capthndsme/perch-controller'
    )
    assert.equal(
      vapidSubjectFor({ ...base, dashboardUrl: 'https://localhost:3333' }),
      'https://github.com/capthndsme/perch-controller'
    )
  })
})
