import { GatewayUpnpMappingSchema } from '#database/schema'

/**
 * One UPnP IGD port mapping the router's miniupnpd holds, as the Gateway
 * agent last reported it (observation part `upnp`, docs/gateway/observation.md).
 * A runtime mirror keyed by (collector, proto, external port); `mac` is the
 * device behind the internal address, resolved at ingest. Written by
 * `app/services/gateway_upnp.ts`.
 */
export default class GatewayUpnpMapping extends GatewayUpnpMappingSchema {}
