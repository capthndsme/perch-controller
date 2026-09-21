import { DeviceTrafficBucketSchema } from '#database/schema'

/**
 * One bucket = one fixed-width time slice (typically 15 s) of summed
 * deltas for a single (collector, mac) pair. Written by `bucket_writer`,
 * read by `/api/v1/devices/:mac/traffic`.
 *
 * Counter columns (`bytes_*`, `packets_*`) live in MySQL as `BIGINT
 * UNSIGNED`. The schema generator types them as `bigint | number`; mysql2
 * returns plain `number` whenever the value fits in `Number.MAX_SAFE_INTEGER`
 * and only escalates to `bigint` past that ceiling — fine for our use
 * because 15 s of traffic on a single MAC tops out well below 2^53.
 *
 * The transformer at the API edge coerces to `number` for JSON wire
 * compatibility (JSON.stringify doesn't handle bigint), so callers should
 * not depend on the bigint branch here. Kept as a pass-through model;
 * any future logic that needs bigint-safe math should add explicit
 * `Number()` casts at the read boundary.
 */
export default class DeviceTrafficBucket extends DeviceTrafficBucketSchema {}
