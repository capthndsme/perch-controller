import { GatewayObservationSchema } from '#database/schema'

/**
 * When a collector last reported one kind of observation (`dhcp` today), the
 * fingerprint of what was written and a few counts (`payload`, JSON). Keyed
 * by (collector_id, kind); written by `app/services/gateway_dhcp.ts`.
 */
export default class GatewayObservation extends GatewayObservationSchema {}
