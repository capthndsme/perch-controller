import { GatewayWireguardPeerSchema } from '#database/schema'

/**
 * Perch-only metadata of one WireGuard peer (migration 143,
 * docs/design/gateway-sync/rest.md 4): its device, its creator and when its
 * one-time client config was handed out. The key pair of a generated client
 * config is never stored anywhere; this row records only that it happened.
 */
export default class GatewayWireguardPeer extends GatewayWireguardPeerSchema {}
