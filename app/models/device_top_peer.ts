import { DeviceTopPeerSchema } from '#database/schema'

/**
 * Latest-only mirror of one entry in a collector's top-peer heap. `scope`
 * is the string discriminant ('wan' | 'lan') because we want the existing
 * unique index `(collector_id, mac, peer_ip, scope)` to do the
 * deduplication at the storage layer — no enum gymnastics needed in code.
 *
 * Same bigint caveat as `DeviceTrafficBucket`: counters come back as
 * either `number` (typical) or `bigint` (>2^53). Transformer coerces.
 */
export default class DeviceTopPeer extends DeviceTopPeerSchema {}
