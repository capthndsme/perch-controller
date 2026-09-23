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
 * after the last write. Until the plane's apply path exists,
 * `StubQosPlaneWriter` is installed: it records the change (bounded) and
 * refuses with `plane_unavailable`, which the sender keeps as the config
 * state (`config.state 'queued'`, `error 'plane_unavailable'`) and retries
 * on the next change or expiry sweep.
 *
 * Wiring the real plane (TODO wave 2): register a `perch-qos` domain that
 * owns the whole package (sections `globals`, `bucket`, `network`,
 * `schedule`), with the `globals.enabled` import exception; implement
 * `submit` by turning `sections` into section edits for
 * `gatewayConfig.editSections(gatewayId, userId, edits)` (sections the plan
 * no longer has are deleted); `overrideRouterPause` = the admin resumed over
 * a router-side pause (POST /qos/resume with `overrideRouter`). Return the
 * draft revision. Install it with `setQosPlaneWriter` at boot.
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
  /** The gateway's desired-state revision after the change. */
  revision: number
}

export interface QosPlaneWriter {
  /** Accepts the package into the desired state or throws `QosPlaneError`. */
  submit(change: QosConfigChange): Promise<QosPlaneAccepted>
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
