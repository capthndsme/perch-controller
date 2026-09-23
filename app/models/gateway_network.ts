import { GatewayNetworkSchema } from '#database/schema'

/** Network purposes (docs/gateway/config-plane.md section 8.1). */
export const GATEWAY_NETWORK_PURPOSES = ['lan', 'guest', 'iot', 'management', 'custom'] as const
export type GatewayNetworkPurpose = (typeof GATEWAY_NETWORK_PURPOSES)[number]

/**
 * Perch-only metadata of one network, keyed by its `interface` section's
 * `perch_id` (never written into UCI).
 */
export default class GatewayNetwork extends GatewayNetworkSchema {}
