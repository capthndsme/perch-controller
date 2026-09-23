import GatewaySection from '#models/gateway_section'
import { applyStateToRow, toSectionState } from '#services/gateway_config/section_rows'
import type { SectionState } from '#services/gateway_config/sync_engine'
import { test } from '@japa/runner'

test.group('gateway sections | row mapping', () => {
  test('a state survives a row round trip', ({ assert }) => {
    const state: SectionState = {
      perchId: 'k2v9',
      config: 'dhcp',
      name: 'perch_k2v9',
      type: 'host',
      anonymous: false,
      scope: 'synced',
      domain: 'dhcp_hosts',
      ownership: { kind: 'options', options: ['mac', 'ip'] },
      issue: null,
      base: { type: 'host', options: { mac: '02:00:00:00:00:01', ip: '192.168.1.5' } },
      baseRevision: null,
      router: { type: 'host', options: { mac: '02:00:00:00:00:01', ip: '192.168.1.6' } },
      desired: { type: 'host', options: { mac: '02:00:00:00:00:01', ip: '192.168.1.5' } },
      status: 'drift',
      conflict: null,
      driftSince: '2026-09-23T10:00:00.000Z',
      position: 4,
    }
    const row = applyStateToRow(new GatewaySection(), state)
    assert.equal(row.sectionName, 'perch_k2v9')
    assert.deepEqual(toSectionState(row), state)
  })

  test('unknown union values read safe', ({ assert }) => {
    const row = new GatewaySection()
    Object.assign(row, {
      perchId: 'x',
      config: 'dhcp',
      sectionName: 'x',
      sectionType: 'host',
      anonymous: 1,
      scope: 'future-scope',
      status: 'future-status',
      issue: 'future-issue',
      domain: null,
      ownership: { kind: 'section' },
      baseContent: null,
      routerContent: null,
      desiredContent: null,
      conflict: null,
      driftSince: null,
      position: null,
      baseRevision: null,
    })
    const state = toSectionState(row)
    assert.equal(state.scope, 'unmodeled')
    assert.equal(state.status, 'in_sync')
    assert.isNull(state.issue)
    assert.isNull(state.ownership, 'whole-section ownership is stored as null')
    assert.isTrue(state.anonymous)
  })
})
