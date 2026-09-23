import type { PlanSection } from '#services/qos_plan'

/**
 * The seam between the QoS sender (`qos_sync.ts`) and the config plane for
 * the Perch-owned `/etc/config/perch-qos` (docs/gateway/qos.md section 6.3;
 * plan 3 section 9.2, README section 2: Perch-owned config, one-way,
 * controller → router, router edits are drift except `globals.enabled '0'`,
 * a local pause that is never reverted).
 *
 * The planner renders the whole file (`planQos().sections`); the sender
 * submits it here whenever its fingerprint changes, `applyDebounceSeconds`
 * after the last write. The real writer is `PlaneQosWriter`
 * (`qos_plane_writers.ts`: the `perch_qos` domain, an apply confirmed by the
 * agent, `globals.revision`), installed at boot by
 * `providers/qos_plane_provider.ts` (web only). `StubQosPlaneWriter` stays
 * the default elsewhere: it records the change (bounded) and refuses with
 * `plane_unavailable`, which the sender keeps as the config state.
 */

export interface QosConfigChange {
  gatewayId: number
  /** The complete desired `perch-qos` package, in render order. */
  sections: PlanSection[]
  /** `planQos().fingerprints.config`. */
  fingerprint: string
  /** Write `globals.enabled '1'` even though the router set it to '0'. */
  overrideRouterPause: boolean
  userId: number | null
  requestedAt: string
}

export interface QosPlaneAccepted {
  /**
   * The package's revision: the real writer writes it as `globals.revision`,
   * and the router reports it back (`qos.configRevision`) once its shaper
   * runs that package.
   */
  revision: number
  /** The config plane apply carrying the package, when one started. */
  applyId?: string | null
  /** Where the package stands (`queued` / `applying` / `in_sync`). */
  state?: 'queued' | 'applying' | 'in_sync'
  /** Why it waits (`apply_in_flight`, …); the draft is kept and retried. */
  error?: string | null
}

export interface QosPlaneWriter {
  /** Accepts the package into the desired state or throws `QosPlaneError`. */
  submit(change: QosConfigChange): Promise<QosPlaneAccepted>
  /**
   * Starts the apply of a package accepted earlier that had to wait (another
   * apply was open). Null = nothing waits. Optional.
   */
  resume?(gatewayId: number, userId: number | null): Promise<QosPlaneAccepted | null>
}

export class QosPlaneError extends Error {
  constructor(
    readonly status: 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

/** How many intended packages the stub keeps (CLAUDE.md: every in-process cache is bounded). */
export const QOS_STUB_RECORD_LIMIT = 50

/** The stand-in until the config plane's apply path exists. */
export class StubQosPlaneWriter implements QosPlaneWriter {
  readonly recorded: QosConfigChange[] = []

  async submit(change: QosConfigChange): Promise<QosPlaneAccepted> {
    this.recorded.push(structuredClone(change))
    if (this.recorded.length > QOS_STUB_RECORD_LIMIT) {
      this.recorded.splice(0, this.recorded.length - QOS_STUB_RECORD_LIMIT)
    }
    throw new QosPlaneError(
      409,
      'plane_unavailable',
      'Router writes need the config plane, which this controller does not run yet.'
    )
  }
}

let writer: QosPlaneWriter = new StubQosPlaneWriter()

export function qosPlaneWriter(): QosPlaneWriter {
  return writer
}

/** Installs a writer and returns the previous one (tests restore it). */
export function setQosPlaneWriter(next: QosPlaneWriter): QosPlaneWriter {
  const previous = writer
  writer = next
  return previous
}
