import agentUpdates from '#services/alerts/catalogue/agent_updates'
import gatewaySync from '#services/alerts/catalogue/gateway_sync'
import { buildCatalogue, getAlertType, listAlertTypes } from '#services/alerts/catalogue/index'
import wifi from '#services/alerts/catalogue/wifi'
import type { AlertTypeDef, RenderContext, RenderInput, Transition } from '#services/alerts/model'
import { defineAlertTypes } from '#services/alerts/registry'
import { duration, renderAlert } from '#services/alerts/render'
import {
  ALERTS_DEFAULTS,
  catalogueRule,
  effectiveRule,
  normalizeAlertsSettings,
  normalizeRuleOverride,
} from '#services/alerts/settings'
import { parseSubjectKey, subjectFromRef, subjectKey, subjectRef } from '#services/alerts/subjects'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/** events.md §2: every v1 type of the alerts area. */
const EXPECTED = [
  'collector.offline',
  'ap.offline',
  'system.agents_unreachable',
  'collector.pending',
  'ap.joined',
  'ap.groups_failed',
  'wan.down',
  'wan.failover',
  'wan.public_ip_changed',
  'gateway.apply_rolled_back',
  'gateway.apply_failed',
  'gateway.apply_expired',
  'gateway.apply_awaiting_confirm',
  'gateway.drift',
  'gateway.conflict',
  'gateway.enforcement_suspended',
  'gateway.sqm_paused',
  'gateway.pairing_lost',
  'gateway.rejoin_offered',
  'gateway.unmodeled_changed',
  'gateway.section_ambiguous',
  'port.down',
  'port.flapping',
  'port.speed_degraded',
  'device.new',
  'device.offline',
  'device.arrived',
  'portal.not_enforcing',
  'portal.quota_exhausted',
  'portal.external_auth',
  'hotspot.terminal_offline',
  'hotspot.terminal_error',
  'hotspot.unclaimed',
  'hotspot.checkout_rejected',
  'hotspot.payment',
  'system.disk_low',
  'system.db_size',
  'system.rollup_stalled',
  'system.retention_stalled',
  'system.delivery_failing',
  'system.db_unreachable',
  'controller.started',
  'system.test',
]

const NOW = DateTime.fromISO('2026-10-01T06:09:00Z', { zone: 'utc' })

function input(def: AlertTypeDef, overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    id: 812,
    type: def.type,
    kind: def.kind,
    state: def.kind === 'notice' ? 'posted' : 'active',
    severity: def.severity,
    flapping: false,
    subject: { kind: def.subjects[0], ref: '4', label: 'Garage AP' },
    label: 'Garage AP',
    payload: {},
    firstRaisedAt: NOW.minus({ minutes: 7 }),
    raisedAt: NOW.minus({ minutes: 7 }),
    openedAt: NOW.minus({ minutes: 6 }),
    resolvedAt: null,
    eventCount: 1,
    transitions: 0,
    ...overrides,
  }
}

function ctx(transition: Transition, extra: Partial<RenderContext> = {}): RenderContext {
  return { transition, wasNotified: true, redact: false, zone: 'Asia/Manila', now: NOW, ...extra }
}

test.group('alerts catalogue', () => {
  test('holds every type of events.md, each once, alerts-owned', ({ assert }) => {
    const names = listAlertTypes().map((d) => d.type)
    assert.includeMembers(names, EXPECTED)
    assert.equal(new Set(names).size, names.length)
    for (const type of EXPECTED) assert.equal(getAlertType(type)!.owner, 'alerts')
  })

  test('each area file holds only its own types, in its namespace', ({ assert }) => {
    const areas: Array<[AlertTypeDef[], AlertTypeDef['owner'], RegExp]> = [
      [wifi, 'wifi', /^wifi\./],
      [gatewaySync, 'gateway-sync', /^(gateway|wan)\./],
      [agentUpdates, 'agent-updates', /^agent_update\./],
    ]
    for (const [defs, owner, namespace] of areas) {
      for (const def of defs) {
        assert.equal(def.owner, owner, def.type)
        assert.match(def.type, namespace)
      }
    }
  })

  test('agent-update types: one per alert event of the updates area, rendered from its payload', ({
    assert,
  }) => {
    assert.sameMembers(
      agentUpdates.map((d) => d.type),
      [
        'agent_update.available',
        'agent_update.started',
        'agent_update.confirmed',
        'agent_update.failed',
        'agent_update.rolled_back',
        'agent_update.unknown',
        'agent_update.rollback_failed',
        'agent_update.rollback_unavailable',
        'agent_update.rollout_paused',
        'agent_update.rollout_completed',
        'agent_update.release_rejected',
        'agent_update.version_changed',
      ]
    )
    const device = { kind: 'ap', id: 4, name: 'Garage AP' }
    const payload = {
      device,
      devices: [device, { kind: 'ap', id: 3, name: 'RAX 1F' }],
      product: 'perch-apd',
      version: '1.2.0',
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      rolloutId: 7,
      seconds: 44,
      reason: 'health_check',
      detail: 'no WebSocket within 60 s',
      confirmed: 3,
      skipped: 0,
      source: 'github',
      runningVersion: '1.2.0',
    }
    for (const def of agentUpdates) {
      const text = renderAlert(def, input(def, { payload }), ctx('opened'))
      assert.isAbove(text.title.length, 5, def.type)
      assert.notInclude(`${text.title} ${text.body}`, 'undefined', def.type)
      assert.notInclude(`${text.title} ${text.body}`, '[object', def.type)
    }
    const started = getAlertType('agent_update.started')!
    assert.isFalse(catalogueRule(started).notify)
    const confirmed = renderAlert(
      getAlertType('agent_update.confirmed')!,
      input(getAlertType('agent_update.confirmed')!, { payload }),
      ctx('opened')
    )
    assert.equal(confirmed.title, 'Garage AP updated to 1.2.0')
    assert.equal(confirmed.path, '/settings/updates/rollouts/7')
  })

  test('a duplicate type name throws when the catalogue is built', ({ assert }) => {
    const def = getAlertType('ap.offline')!
    assert.throws(() => buildCatalogue([[def], [def]]), /defined twice/)
  })

  test('defineAlertTypes rejects malformed definitions', ({ assert }) => {
    const base = getAlertType('system.test')!
    assert.throws(() => defineAlertTypes([{ ...base, type: 'NoNamespace' }]), /snake_case/)
    assert.throws(() => defineAlertTypes([{ ...base, category: 'nope' as never }]), /category/)
    assert.throws(() => defineAlertTypes([{ ...base, subjects: [] }]), /subject/)
    assert.throws(
      () =>
        defineAlertTypes([
          { ...base, params: [{ key: 'x', label: 'x', kind: 'int', default: 9, min: 0, max: 5 }] },
        ]),
      /default outside/
    )
  })

  test('every type renders every transition, even with an empty payload', ({ assert }) => {
    for (const def of listAlertTypes()) {
      for (const transition of ['opened', 'escalated', 'reminder', 'flapping'] as const) {
        const text = renderAlert(def, input(def), ctx(transition))
        assert.isAbove(text.title.length, 0, `${def.type} ${transition}`)
      }
      if (def.kind === 'condition') {
        const resolved = input(def, { state: 'resolved', resolvedAt: NOW })
        for (const wasNotified of [true, false]) {
          const text = renderAlert(def, resolved, ctx('resolved', { wasNotified }))
          assert.isAbove(text.title.length, 0, `${def.type} resolved ${wasNotified}`)
        }
      }
      const minimal = renderAlert(def, input(def), ctx('opened', { redact: true }))
      assert.isAbove(minimal.title.length, 0)
      if (def.renderGroup) {
        const group = def.renderGroup([input(def), input(def)], ctx('opened'))
        assert.isAbove(group.title.length, 0, `${def.type} group`)
      }
    }
  })

  test('texts follow events.md in the instance time zone', ({ assert }) => {
    const ap = getAlertType('ap.offline')!
    const opened = renderAlert(
      ap,
      input(ap, {
        payload: {
          name: 'Garage AP',
          lastSeenAt: '2026-10-01T06:02:00Z',
          silentSeconds: 120,
          clientsAtLastReport: 4,
        },
      }),
      ctx('opened')
    )
    assert.deepEqual(opened, {
      title: 'Garage AP is offline',
      body: 'No report for 2 min (since 14:02). 4 clients were on it.',
    })
    const back = renderAlert(
      ap,
      input(ap, { state: 'resolved', raisedAt: NOW.minus({ minutes: 7 }), resolvedAt: NOW }),
      ctx('resolved')
    )
    assert.deepEqual(back, {
      title: 'Garage AP is back online',
      body: 'Offline for 7 min (14:02–14:09).',
    })
    const was = renderAlert(
      ap,
      input(ap, { state: 'resolved', resolvedAt: NOW }),
      ctx('resolved', { wasNotified: false })
    )
    assert.deepEqual(was, { title: 'Garage AP was offline', body: '14:02–14:09 (7 min).' })

    const wan = getAlertType('wan.down')!
    const internet = renderAlert(
      wan,
      input(wan, {
        severity: 'critical',
        state: 'resolved',
        resolvedAt: NOW,
        payload: { network: 'wan', allDown: true },
      }),
      ctx('resolved', { wasNotified: false })
    )
    assert.deepEqual(internet, { title: 'Internet was down', body: '14:02–14:09 (7 min).' })

    const flapping = renderAlert(ap, input(ap, { transitions: 8 }), {
      ...ctx('flapping'),
      windowMinutes: 15,
    })
    assert.equal(flapping.title, 'Garage AP is flapping')
    assert.equal(
      flapping.body,
      '8 changes in 15 min. Further changes are not notified until it is stable.'
    )
    const reminder = renderAlert(ap, input(ap, { payload: { name: 'Garage AP' } }), ctx('reminder'))
    assert.equal(reminder.title, 'Still: Garage AP is offline')
    assert.equal(reminder.body, 'Since 14:02 (7 min).')
  })

  test('device.new never leaks the MAC or name to a minimal destination', ({ assert }) => {
    const def = getAlertType('device.new')!
    const text = renderAlert(
      def,
      input(def, {
        payload: {
          mac: '02:00:00:5e:10:22',
          name: 'pixel-8',
          network: 'lan',
          firstSeenAt: '2026-10-01T06:02:00Z',
        },
      }),
      ctx('opened', { redact: true })
    )
    assert.notInclude(text.body, '02:00:00')
    assert.notInclude(text.body, 'pixel')
    assert.deepEqual(text, {
      title: 'New device on the network',
      body: 'On lan, first seen 14:02.',
    })
    assert.includeMembers(def.pii ?? [], ['mac', 'name', 'ip'])
  })

  test('duration texts', ({ assert }) => {
    assert.equal(duration(40), '40 s')
    assert.equal(duration(420), '7 min')
    assert.equal(duration(7500), '2 h 5 min')
    assert.equal(duration(3 * 86400 + 4 * 3600), '3 d 4 h')
  })
})

test.group('alerts rules and settings', () => {
  test('catalogue rule = base rule of the kind ⊕ type defaults ⊕ param defaults', ({ assert }) => {
    const rule = catalogueRule(getAlertType('ap.offline')!)
    assert.include(rule, {
      enabled: true,
      notify: true,
      severity: 'auto',
      holdSeconds: 60,
      recoveryHoldSeconds: 30,
      notifyRecovery: true,
      flapThreshold: 3,
      flapWindowMinutes: 30,
      groupSeconds: 30,
    })
    const notice = catalogueRule(getAlertType('device.new')!)
    assert.include(notice, { groupSeconds: 300, dedupeMinutes: 0, holdSeconds: 0 })
    assert.deepEqual(notice.params, {
      minPresenceMinutes: 10,
      ignoreRandomizedMacs: false,
      excludePortalNetworks: true,
      excludeNetworks: [],
    })
    assert.isFalse(catalogueRule(getAlertType('wan.public_ip_changed')!).enabled)
    assert.isFalse(catalogueRule(getAlertType('gateway.apply_awaiting_confirm')!).notify)
  })

  test('overrides apply over the catalogue rule, clamped; bad values read as the default', ({
    assert,
  }) => {
    const def = getAlertType('device.new')!
    const rule = effectiveRule(def, {
      rules: {
        'device.new': {
          severity: 'warning',
          holdSeconds: 99999,
          repeatMinutes: 5,
          push: 'yes' as never,
          params: { minPresenceMinutes: 5000, unknown: 1, excludeNetworks: ['guest', ''] },
        },
      },
    })
    assert.equal(rule.severity, 'warning')
    assert.equal(rule.holdSeconds, 3600)
    assert.equal(rule.repeatMinutes, 15)
    assert.isTrue(rule.push)
    assert.equal(rule.params.minPresenceMinutes, 1440)
    assert.notProperty(rule.params, 'unknown')
    assert.deepEqual(rule.params.excludeNetworks, ['guest'])
    assert.deepEqual(normalizeRuleOverride('nonsense'), {})
  })

  test('stored settings normalise like Presence: invalid → default, out of range → clamped', ({
    assert,
  }) => {
    assert.deepEqual(normalizeAlertsSettings(null), ALERTS_DEFAULTS)
    const s = normalizeAlertsSettings({
      quietHours: { enabled: true, start: '25:00', end: '06:30', breakThrough: 'loud' },
      bootGraceSeconds: 5,
      massOffline: { fractionPercent: 500 },
      destinationRateLimit: { max: 1.5 },
      retention: { alertDays: 1 },
      rules: { 'ap.offline': { holdSeconds: 120 }, 'future.type': { enabled: false } },
    })
    assert.deepEqual(s.quietHours, {
      enabled: true,
      start: '22:00',
      end: '06:30',
      breakThrough: 'critical',
    })
    assert.equal(s.bootGraceSeconds, 30)
    assert.equal(s.massOffline.fractionPercent, 100)
    assert.equal(s.destinationRateLimit.max, 20)
    assert.equal(s.retention.alertDays, 7)
    assert.deepEqual(s.rules['ap.offline'], { holdSeconds: 120 })
    assert.deepEqual(s.rules['future.type'], { enabled: false }, 'kept for a later catalogue')
  })
})

test.group('alerts subjects', () => {
  test('keys and refs round-trip', ({ assert }) => {
    const cases = [
      { kind: 'collector', id: 1 },
      { kind: 'ap', id: 4 },
      { kind: 'gateway', id: 2 },
      { kind: 'network', gatewayId: 2, name: 'wan' },
      { kind: 'ssid', name: 'Home' },
      { kind: 'device', mac: '02:00:00:5e:10:22' },
      { kind: 'port', id: 77 },
      { kind: 'portal', id: 3 },
      { kind: 'terminal', id: 9 },
      { kind: 'controller' },
    ] as const
    for (const subject of cases) {
      assert.deepEqual(subjectFromRef(subject.kind, subjectRef(subject)), subject)
      assert.deepEqual(parseSubjectKey(subjectKey(subject)), subject)
    }
    assert.equal(subjectKey({ kind: 'network', gatewayId: 2, name: 'wan' }), 'network:2:wan')
    assert.isNull(parseSubjectKey('ap:x'))
    assert.isNull(parseSubjectKey('nope:1'))
  })
})
