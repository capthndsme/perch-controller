import type { UciOptions } from '#services/gateway_config/types'

/**
 * The seam between the WAN queue REST endpoints and the config plane
 * (docs/gateway/qos.md section 2.4; plan 3 section 9.2). Every router write
 * goes through the config plane (README section 2, "one write path"); the
 * QoS code never talks to the agent about `sqm` itself.
 *
 * The real writer is `PlaneSqmWriter` (`qos_plane_writers.ts`): the change
 * rendered through `sqmDomain.render()` into `editSections`, then an apply
 * of that section. `providers/qos_plane_provider.ts` installs it at boot
 * (web only). `StubSqmPlaneWriter` stays the default elsewhere (tests, ace
 * commands): it records the intended change (bounded) and refuses with
 * `plane_unavailable`.
 */

/** One intended change to a gateway's `sqm` config. */
export interface SqmQueueChange {
  action: 'create' | 'update' | 'delete'
  gatewayId: number
  /** `qos_wan_queues.id`, null for a create. */
  queueId: number | null
  /** The section's ledger id, when it has one. */
  perchId: string | null
  /** The section's UCI name, when it exists on the router. */
  uciSection: string | null
  /** The full desired option map (null for a delete). */
  options: UciOptions | null
  /** Options that differ from the current map. */
  changed: string[]
  userId: number | null
  requestedAt: string
}

/**
 * Where a change stands once the plane took it: `queued` (in the draft; the
 * apply waits for the agent, or for another apply to finish: `applyError`
 * says why), `applying` (sent, waiting for the confirm), `applied` (the
 * router confirmed, or nothing was left to write).
 */
export type SqmPlaneState = 'queued' | 'applying' | 'applied'

/** What the plane answers when it accepts a change into the desired state. */
export interface SqmPlaneAccepted {
  /** The section's ledger id (a new one for a create). */
  perchId: string | null
  /** The section's UCI name (a create's is the name the apply gives it). */
  uciSection: string | null
  /** The gateway's agreed revision when the change was accepted (the apply makes the next). */
  revision: number
  /** The apply carrying the change (`gateway_applies.apply_key`), when one started. */
  applyId?: string | null
  state?: SqmPlaneState
  /** The apply (the config plane's `GatewayApply` wire shape), when one started. */
  apply?: unknown | null
  /** Why no apply started (the draft is kept): `apply_in_flight`, `agent_offline`, … */
  applyError?: { error: string; message: string } | null
}

export interface SqmPlaneWriter {
  /** Accepts the change into the desired state or throws `SqmPlaneError`. */
  submit(change: SqmQueueChange): Promise<SqmPlaneAccepted>
}

/** A refusal from the plane; the endpoints send `status` + `{ error: code, message, ...extra }`. */
export class SqmPlaneError extends Error {
  constructor(
    readonly status: 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

/** How many intended changes the stub keeps (CLAUDE.md: every in-process cache is bounded). */
export const STUB_RECORD_LIMIT = 50

/**
 * The stand-in until the config plane's apply path exists: records the
 * change and refuses it with 409 `plane_unavailable`.
 */
export class StubSqmPlaneWriter implements SqmPlaneWriter {
  readonly recorded: SqmQueueChange[] = []

  async submit(change: SqmQueueChange): Promise<SqmPlaneAccepted> {
    this.recorded.push(structuredClone(change))
    if (this.recorded.length > STUB_RECORD_LIMIT) {
      this.recorded.splice(0, this.recorded.length - STUB_RECORD_LIMIT)
    }
    throw new SqmPlaneError(
      409,
      'plane_unavailable',
      'Router writes need the config plane, which this controller does not run yet. Nothing was changed.'
    )
  }
}

let writer: SqmPlaneWriter = new StubSqmPlaneWriter()

export function sqmPlaneWriter(): SqmPlaneWriter {
  return writer
}

/** Installs a writer and returns the previous one (tests restore it). */
export function setSqmPlaneWriter(next: SqmPlaneWriter): SqmPlaneWriter {
  const previous = writer
  writer = next
  return previous
}
