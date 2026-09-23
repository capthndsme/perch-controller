import { GatewayObservationSchema } from '#database/schema'

/**
 * The latest report of one observation part per collector (docs/gateway/
 * observation.md): its fingerprint, when it was last reported and last
 * changed, and a payload (JSON): counts for the mirrored parts (`dhcp`,
 * `neighbors`, `upnp`), the normalised report itself for the others
 * (`interfaces`, `mwan3`, `resolver`, `system`, `wireguard`). Keyed by
 * (collector_id, kind).
 */
export default class GatewayObservation extends GatewayObservationSchema {}
