import { QosGatewayStateSchema } from '#database/schema'

/**
 * Per-gateway QoS delivery state (docs/gateway/qos.md section 6): the
 * controller's pause and the sender's bookkeeping (`qos_sync.ts`).
 */
export default class QosGatewayState extends QosGatewayStateSchema {}
