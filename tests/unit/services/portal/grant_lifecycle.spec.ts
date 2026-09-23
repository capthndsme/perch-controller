import {
  type GrantEvent,
  type GrantLifecycle,
  newGrantLifecycle,
  transitionGrant,
} from '#services/portal/grant_lifecycle'
import type { GrantState } from '#services/portal/types'
import { test } from '@japa/runner'

const T = 1_790_000_000_000

function grant(state: GrantState, patch: Partial<GrantLifecycle> = {}): GrantLifecycle {
  return {
    state,
    delivery: 'applied',
    revision: 3,
    startedAt: state === 'active' || state === 'paused' ? T - 1000 : null,
    endedAt: state === 'ended' ? T - 1 : null,
    endReason: state === 'ended' ? 'expired' : null,
    ...patch,
  }
}

function ok(g: GrantLifecycle, e: GrantEvent) {
  const t = transitionGrant(g, e)
  if (!t.ok) throw new Error(`unexpected ${t.error}`)
  return t
}

test.group('grant lifecycle: creation', () => {
  test('a new grant waits for delivery; a queued one needs none', ({ assert }) => {
    assert.deepEqual(newGrantLifecycle(false), {
      state: 'pending_device',
      delivery: 'pending',
      revision: 1,
      startedAt: null,
      endedAt: null,
      endReason: null,
    })
    assert.include(newGrantLifecycle(true), { state: 'queued', delivery: 'applied', revision: 1 })
  })
})

test.group('grant lifecycle: server commands', () => {
  test('queue takes a live grant off the router', ({ assert }) => {
    for (const s of ['pending_device', 'active', 'paused'] as const) {
      const t = ok(grant(s), { type: 'queue' })
      assert.include(t.grant, { state: 'queued', delivery: 'pending', revision: 4 })
      assert.equal(t.push, 'deauthorize')
      assert.equal(t.session, s === 'active' ? 'close' : null)
    }
    assert.isFalse(ok(grant('queued'), { type: 'queue' }).changed)
    assert.deepEqual(transitionGrant(grant('ended'), { type: 'queue' }), {
      ok: false,
      error: 'grant_ended',
    })
  })

  test('promote sends a queued grant', ({ assert }) => {
    const t = ok(grant('queued'), { type: 'promote' })
    assert.include(t.grant, { state: 'pending_device', delivery: 'pending', revision: 4 })
    assert.equal(t.push, 'authorize')
    assert.deepEqual(transitionGrant(grant('active'), { type: 'promote' }), {
      ok: false,
      error: 'invalid_transition',
    })
    assert.deepEqual(transitionGrant(grant('ended'), { type: 'promote' }), {
      ok: false,
      error: 'grant_ended',
    })
  })

  test('extend resends a live grant, only bumps a queued one', ({ assert }) => {
    const live = ok(grant('active'), { type: 'extend' })
    assert.include(live.grant, { state: 'active', delivery: 'pending', revision: 4 })
    assert.equal(live.push, 'authorize')
    assert.isNull(live.session)
    const queued = ok(grant('queued'), { type: 'extend' })
    assert.include(queued.grant, { state: 'queued', delivery: 'applied', revision: 4 })
    assert.isNull(queued.push)
    assert.deepEqual(transitionGrant(grant('ended'), { type: 'extend' }), {
      ok: false,
      error: 'grant_ended',
    })
  })

  test('end from live deauthorizes; from queued it is local', ({ assert }) => {
    const t = ok(grant('active'), { type: 'end', reason: 'revoked', at: T })
    assert.include(t.grant, {
      state: 'ended',
      endReason: 'revoked',
      endedAt: T,
      delivery: 'pending',
      revision: 4,
    })
    assert.equal(t.push, 'deauthorize')
    assert.equal(t.session, 'close')
    const q = ok(grant('queued'), { type: 'end', reason: 'revoked', at: T })
    assert.include(q.grant, { state: 'ended', delivery: 'applied', revision: 3 })
    assert.isNull(q.push)
  })

  test('the first end reason sticks', ({ assert }) => {
    const t = ok(grant('ended'), { type: 'end', reason: 'revoked', at: T })
    assert.isFalse(t.changed)
    assert.equal(t.grant.endReason, 'expired')
  })
})

test.group('grant lifecycle: router answers', () => {
  test('delivered active at the current revision', ({ assert }) => {
    const t = ok(grant('pending_device', { delivery: 'pending', startedAt: null }), {
      type: 'delivered',
      revision: 3,
      result: 'active',
      at: T,
    })
    assert.include(t.grant, { state: 'active', delivery: 'applied', startedAt: T })
    assert.equal(t.session, 'open')
  })

  test('an answer for an older revision changes nothing', ({ assert }) => {
    const g = grant('pending_device', { delivery: 'pending' })
    assert.isFalse(ok(g, { type: 'delivered', revision: 2, result: 'active', at: T }).changed)
  })

  test('delivered pending_device keeps a paused grant paused', ({ assert }) => {
    const paused = ok(grant('paused', { delivery: 'pending' }), {
      type: 'delivered',
      revision: 3,
      result: 'pending_device',
      at: T,
    })
    assert.include(paused.grant, { state: 'paused', delivery: 'applied' })
    const active = ok(grant('active', { delivery: 'pending' }), {
      type: 'delivered',
      revision: 3,
      result: 'pending_device',
      at: T,
    })
    assert.include(active.grant, { state: 'pending_device' })
    assert.equal(active.session, 'close')
  })

  test('rejected ends the grant', ({ assert }) => {
    const t = ok(grant('pending_device', { delivery: 'pending' }), {
      type: 'delivered',
      revision: 3,
      result: 'rejected',
      at: T,
    })
    assert.include(t.grant, { state: 'ended', endReason: 'rejected', delivery: 'applied' })
    assert.isNull(t.push)
  })

  test('a delivery answer for an ended or queued grant is ignored', ({ assert }) => {
    for (const s of ['ended', 'queued'] as const) {
      const g = grant(s, { delivery: 'pending' })
      assert.isFalse(ok(g, { type: 'delivered', revision: 3, result: 'active', at: T }).changed)
    }
  })

  test('removed acknowledges an ended or queued grant at its revision', ({ assert }) => {
    const t = ok(grant('ended', { delivery: 'pending' }), { type: 'removed', revision: 3 })
    assert.equal(t.grant.delivery, 'applied')
    assert.isFalse(
      ok(grant('ended', { delivery: 'pending' }), { type: 'removed', revision: 2 }).changed
    )
    assert.isFalse(
      ok(grant('active', { delivery: 'pending' }), { type: 'removed', revision: 3 }).changed
    )
  })
})

test.group('grant lifecycle: router facts', () => {
  test('active / resumed from pending or paused', ({ assert }) => {
    const a = ok(grant('pending_device', { startedAt: null }), { type: 'router_active', at: T })
    assert.include(a.grant, { state: 'active', startedAt: T })
    assert.equal(a.session, 'open')
    const r = ok(grant('paused'), { type: 'router_resumed', at: T })
    assert.include(r.grant, { state: 'active', startedAt: T - 1000 })
    assert.equal(r.session, 'open')
    assert.isFalse(ok(grant('active'), { type: 'router_active', at: T }).changed)
  })

  test('paused from active or pending', ({ assert }) => {
    const t = ok(grant('active'), { type: 'router_paused', at: T })
    assert.equal(t.grant.state, 'paused')
    assert.equal(t.session, 'close')
    assert.isFalse(ok(grant('queued'), { type: 'router_paused', at: T }).changed)
  })

  test('ended by the router is a fact: no push', ({ assert }) => {
    const t = ok(grant('active', { delivery: 'pending' }), {
      type: 'router_ended',
      reason: 'quota',
      at: T,
    })
    assert.include(t.grant, { state: 'ended', endReason: 'quota', delivery: 'applied', endedAt: T })
    assert.isNull(t.push)
    assert.equal(t.session, 'close')
  })

  test('facts about queued or ended grants are ignored, never errors', ({ assert }) => {
    const events: GrantEvent[] = [
      { type: 'router_active', at: T },
      { type: 'router_paused', at: T },
      { type: 'router_resumed', at: T },
      { type: 'router_ended', reason: 'router_deauth', at: T },
    ]
    for (const s of ['queued', 'ended'] as const) {
      for (const e of events) {
        const t = transitionGrant(grant(s), e)
        assert.isTrue(t.ok)
        if (t.ok) assert.isFalse(t.changed, `${s} ${e.type}`)
      }
    }
  })
})
