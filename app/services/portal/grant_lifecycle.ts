import type { GrantDelivery, GrantEndReason, GrantState } from '#services/portal/types'

/**
 * Grant lifecycle (docs/gateway/portal.md §4.2). One pure transition function
 * shared by the REST handlers, the socket handlers and `reconcile`.
 *
 *                 promote                      router: active
 *   queued ─────────────────▶ pending_device ────────────────▶ active
 *     ▲  ▲                          ▲    ▲   router: pending    │  ▲
 *     │  └──────── queue ───────────┘    └──────────────────────┤  │ router: resumed
 *     │                                                         ▼  │
 *     └──────────────────── queue ───────────────────────────── paused
 *                                                   (router: paused = idle deauth)
 *   any non-ended ── end(reason) ──▶ ended   (final; a second end keeps the first reason)
 *
 * Two axes: `state` (what the grant is) and `delivery` (whether the router has
 * acknowledged the grant's current `revision`). The server bumps `revision`
 * whenever the router's copy must change (created, extended, queued,
 * promoted, ended by the server) and sets `delivery = 'pending'`; the router's
 * answer for that revision sets it back to `applied`. Router **facts**
 * (active, paused, resumed, ended) never fail: an out-of-date fact is ignored,
 * because the next full sync settles the router anyway. Server **commands** on
 * a grant that cannot take them fail with an error code the REST layer maps.
 */

export type GrantLifecycle = {
  state: GrantState
  delivery: GrantDelivery
  revision: number
  /** When the grant first became active on the router (null = never yet). */
  startedAt: number | null
  endedAt: number | null
  endReason: GrantEndReason | null
}

export type GrantEvent =
  // Server commands
  /** Stack it behind another entitlement of the same device (new, or demoted by a swap). */
  | { type: 'queue' }
  /** Its turn came: send it to the router. */
  | { type: 'promote' }
  /** Limits or deadline changed (admin/API extend): resend it. */
  | { type: 'extend' }
  /** Ended by the server (revoke, expiry or quota seen by the server, logout, eviction). */
  | { type: 'end'; reason: GrantEndReason; at: number }
  // Router answers and facts
  /** `portal.authorize` result for one grant at one revision. */
  | {
      type: 'delivered'
      revision: number
      result: 'active' | 'pending_device' | 'rejected'
      at: number
    }
  /** The router confirmed it removed the grant (`portal.deauthorize` result / full-sync absence). */
  | { type: 'removed'; revision: number }
  /** Journal `grant_active`: the device was authorized on openNDS. */
  | { type: 'router_active'; at: number }
  /** Journal `session_paused`: openNDS idle-deauthed the device. */
  | { type: 'router_paused'; at: number }
  /** Journal `session_resumed`: the device came back and was re-authed. */
  | { type: 'router_resumed'; at: number }
  /** Journal `grant_ended`: the router ended it (limits reached, `ndsctl deauth`, logout, moved). */
  | { type: 'router_ended'; reason: GrantEndReason; at: number }

export type GrantPush = 'authorize' | 'deauthorize' | null
export type SessionEffect = 'open' | 'close' | null

export type GrantTransition =
  | {
      ok: true
      grant: GrantLifecycle
      changed: boolean
      /** What the router must be told, if anything. */
      push: GrantPush
      /** A `portal_sessions` row starts or ends with this transition. */
      session: SessionEffect
    }
  | { ok: false; error: 'grant_ended' | 'invalid_transition' }

export function newGrantLifecycle(queued: boolean): GrantLifecycle {
  return {
    state: queued ? 'queued' : 'pending_device',
    // A queued grant needs nothing on the router, which already agrees.
    delivery: queued ? 'applied' : 'pending',
    revision: 1,
    startedAt: null,
    endedAt: null,
    endReason: null,
  }
}

function unchanged(grant: GrantLifecycle): GrantTransition {
  return { ok: true, grant, changed: false, push: null, session: null }
}

function result(before: GrantLifecycle, after: GrantLifecycle, push: GrantPush): GrantTransition {
  const wasActive = before.state === 'active'
  const isActive = after.state === 'active'
  const session: SessionEffect =
    !wasActive && isActive ? 'open' : wasActive && !isActive ? 'close' : null
  const changed =
    before.state !== after.state ||
    before.delivery !== after.delivery ||
    before.revision !== after.revision ||
    before.startedAt !== after.startedAt ||
    before.endedAt !== after.endedAt ||
    before.endReason !== after.endReason
  return { ok: true, grant: after, changed, push, session }
}

function bump(grant: GrantLifecycle, patch: Partial<GrantLifecycle>): GrantLifecycle {
  return { ...grant, ...patch, revision: grant.revision + 1, delivery: 'pending' }
}

export function transitionGrant(grant: GrantLifecycle, event: GrantEvent): GrantTransition {
  const { state } = grant
  switch (event.type) {
    case 'queue': {
      if (state === 'ended') return { ok: false, error: 'grant_ended' }
      if (state === 'queued') return unchanged(grant)
      // Live on the router: it has to be taken off there.
      return result(grant, bump(grant, { state: 'queued' }), 'deauthorize')
    }
    case 'promote': {
      if (state === 'ended') return { ok: false, error: 'grant_ended' }
      if (state !== 'queued') return { ok: false, error: 'invalid_transition' }
      return result(grant, bump(grant, { state: 'pending_device' }), 'authorize')
    }
    case 'extend': {
      if (state === 'ended') return { ok: false, error: 'grant_ended' }
      if (state === 'queued') {
        // Nothing on the router to update; the new limits go out at promotion.
        return result(grant, { ...grant, revision: grant.revision + 1 }, null)
      }
      return result(grant, bump(grant, {}), 'authorize')
    }
    case 'end': {
      if (state === 'ended') return unchanged(grant)
      const wasOnRouter = state !== 'queued'
      const ended: GrantLifecycle = wasOnRouter
        ? bump(grant, { state: 'ended', endedAt: event.at, endReason: event.reason })
        : { ...grant, state: 'ended', endedAt: event.at, endReason: event.reason }
      return result(grant, ended, wasOnRouter ? 'deauthorize' : null)
    }
    case 'delivered': {
      if (event.revision !== grant.revision) return unchanged(grant)
      if (state === 'ended' || state === 'queued') {
        // The router answered a revision we have since superseded locally
        // without bumping (cannot happen: end/queue from live bump). Ignore.
        return unchanged(grant)
      }
      if (event.result === 'rejected') {
        return result(
          grant,
          {
            ...grant,
            state: 'ended',
            delivery: 'applied',
            endedAt: event.at,
            endReason: 'rejected',
          },
          null
        )
      }
      if (event.result === 'active') {
        return result(
          grant,
          {
            ...grant,
            state: 'active',
            delivery: 'applied',
            startedAt: grant.startedAt ?? event.at,
          },
          null
        )
      }
      // pending_device: the router holds it, the device is not there (yet, or
      // any more after a router reboot). A paused grant stays paused.
      const next: GrantState = state === 'paused' ? 'paused' : 'pending_device'
      return result(grant, { ...grant, state: next, delivery: 'applied' }, null)
    }
    case 'removed': {
      if (event.revision !== grant.revision) return unchanged(grant)
      if (state !== 'ended' && state !== 'queued') return unchanged(grant)
      return result(grant, { ...grant, delivery: 'applied' }, null)
    }
    case 'router_active':
    case 'router_resumed': {
      if (state !== 'pending_device' && state !== 'paused') return unchanged(grant)
      return result(
        grant,
        { ...grant, state: 'active', startedAt: grant.startedAt ?? event.at },
        null
      )
    }
    case 'router_paused': {
      if (state !== 'active' && state !== 'pending_device') return unchanged(grant)
      return result(grant, { ...grant, state: 'paused' }, null)
    }
    case 'router_ended': {
      if (state === 'ended' || state === 'queued') return unchanged(grant)
      // A fact: the router already removed it, so nothing to deliver.
      return result(
        grant,
        {
          ...grant,
          state: 'ended',
          delivery: 'applied',
          endedAt: event.at,
          endReason: event.reason,
        },
        null
      )
    }
  }
}
