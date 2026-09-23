import Collector from '#models/collector'
import Gateway from '#models/gateway'
import collectorHub from '#services/collector_agent_hub'

/**
 * Shared plumbing of the QoS endpoints (docs/gateway/qos.md section 5):
 * refusals and the gateway a request addresses.
 */

/** A refusal with its HTTP status and body (`{ error, message, ... }`); the controller sends it as is. */
export class QosError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.message === 'string' ? body.message : 'QoS request refused')
  }
}

export function qosRefusal(
  status: 404 | 409 | 422,
  error: string,
  message: string,
  extra: Record<string, unknown> = {}
): QosError {
  return new QosError(status, { error, message, ...extra })
}

export interface GatewayRef {
  gatewayId?: number
  collectorId?: number
}

export interface ResolvedGateway {
  gateway: Gateway
  collector: Collector | null
  /** The collector holds a live agent session (a detached gateway is never online). */
  online: boolean
}

/**
 * The gateway a QoS request is about. The contract names gateways by
 * `collectorId` (plan 3 section 5); since the config plane gave them their
 * own rows, `gatewayId` works too. With neither, the only gateway is meant.
 *
 * - 404 `collector_not_found`: no such collector.
 * - 404 `gateway_not_found`: no such gateway.
 * - 409 `qos_not_gateway`: the collector is not a managed gateway (no
 *   `gateways` row: it never offered the gateway capability).
 * - 422 `qos_gateway_required`: several gateways and none named.
 */
export async function resolveGateway(ref: GatewayRef): Promise<ResolvedGateway> {
  let gateway: Gateway | null
  if (ref.gatewayId !== undefined) {
    gateway = await Gateway.find(ref.gatewayId)
    if (!gateway) {
      throw qosRefusal(404, 'gateway_not_found', `There is no gateway ${ref.gatewayId}.`, {
        gatewayId: ref.gatewayId,
      })
    }
    if (ref.collectorId !== undefined && gateway.collectorId !== ref.collectorId) {
      throw qosRefusal(
        422,
        'qos_gateway_mismatch',
        'gatewayId and collectorId name different gateways.'
      )
    }
  } else if (ref.collectorId !== undefined) {
    const collector = await Collector.find(ref.collectorId)
    if (!collector) {
      throw qosRefusal(404, 'collector_not_found', `There is no collector ${ref.collectorId}.`, {
        collectorId: ref.collectorId,
      })
    }
    gateway = await Gateway.findBy('collectorId', collector.id)
    if (!gateway) {
      throw qosRefusal(
        409,
        'qos_not_gateway',
        `Collector ${collector.name} does not run on a managed gateway.`,
        { collectorId: collector.id }
      )
    }
  } else {
    const all = await Gateway.query().orderBy('id').limit(2)
    if (all.length === 0) {
      throw qosRefusal(409, 'qos_not_gateway', 'No collector runs on a managed gateway yet.')
    }
    if (all.length > 1) {
      throw qosRefusal(422, 'qos_gateway_required', 'Name the gateway (gatewayId or collectorId).')
    }
    gateway = all[0]
  }
  const collector = gateway.collectorId === null ? null : await Collector.find(gateway.collectorId)
  const online =
    collector !== null && Boolean(collector.enabled) && collectorHub.isOnline(collector.id)
  return { gateway, collector, online }
}

/** 409 `qos_not_managed` unless the gateway is in managed mode (router writes need it). */
export function requireManaged(gateway: Gateway): void {
  if (gateway.mode !== 'managed') {
    throw qosRefusal(
      409,
      'qos_not_managed',
      'Turn on management for this gateway before changing its traffic shaping.',
      { gatewayId: gateway.id, mode: gateway.mode }
    )
  }
}
