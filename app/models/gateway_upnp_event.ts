import { GatewayUpnpEventSchema } from '#database/schema'

/**
 * A UPnP mapping that appeared (`opened`) or went away (`closed`) between two
 * reports of the Gateway agent (docs/gateway/observation.md). History, kept
 * for `upnpEventRetentionDays`. Written by `app/services/gateway_upnp.ts`.
 */
export default class GatewayUpnpEvent extends GatewayUpnpEventSchema {}
