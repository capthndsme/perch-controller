import type { AgentHub, AgentSession } from '#services/agent_hub'
import apHub from '#services/ap_agent_hub'
import type { UpdateReport } from '#services/agent_updates/report'
import type { DeviceKind } from '#services/agent_updates/state'
import collectorHub from '#services/collector_agent_hub'

/**
 * What the update code needs to know about one live agent session: the
 * version the process said it is (AP: `system.info` `agentVersion`;
 * collector: the hello's `version`), its latest `update` block and how many
 * pushes were accepted on it (the confirm rule, controller.md section 4.2).
 *
 * Kept in a WeakMap keyed by the hub's session object, so it lives exactly as
 * long as the session and needs no bound or cleanup: a new session starts at
 * zero pushes, which is the "a session drop resets the count" rule.
 */
export type SessionState = {
  version: string | null
  pushes: number
  report: UpdateReport | null
}

const states = new WeakMap<AgentSession, SessionState>()

export function hubFor(kind: DeviceKind): AgentHub {
  return kind === 'ap' ? apHub : collectorHub
}

export function sessionState(session: AgentSession): SessionState {
  let state = states.get(session)
  if (!state) {
    state = { version: null, pushes: 0, report: null }
    states.set(session, state)
  }
  return state
}

/** The live session of a device and its state, or null when offline. */
export function liveSession(
  kind: DeviceKind,
  id: number
): { session: AgentSession; state: SessionState } | null {
  const session = hubFor(kind).liveSession(id)
  return session ? { session, state: sessionState(session) } : null
}
