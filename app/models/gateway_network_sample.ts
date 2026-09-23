import { GatewayNetworkSampleSchema } from '#database/schema'

/**
 * Per-network counters from the gateway report (section 8.3), at most one
 * row per 30 s, pruned with `router_samples`.
 */
export default class GatewayNetworkSample extends GatewayNetworkSampleSchema {}
