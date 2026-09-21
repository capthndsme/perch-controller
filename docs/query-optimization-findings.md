# Query Optimization Findings — May 28 2026

## Executive Summary

Multiple API endpoints were unacceptably slow — WiFi pages took 30-60+ seconds,
protocol mix with top devices took over 2 minutes for a 7-day window. After
investigation, **three root causes** were identified and fixed, bringing response
times down to milliseconds for WiFi and single-digit seconds for protocol
aggregations across 1.4M rows. A resolution-aware in-memory query cache was
added on top to deduplicate redundant dashboard refreshes.

| Endpoint | Before | After | Speedup |
|----------|--------|-------|---------|
| WiFi Clients | 30-60s | **40ms** | ~1000x |
| WiFi SSIDs (24h) | 10-30s | **1.7s** | ~10x |
| WiFi Overview (24h) | 30-60s | **3.2s** | ~15x |
| Devices (24h) | 10-20s | **4.6s** | ~3x |
| Protocol Top Devices (7d) | 120s+ | **3.7s** | ~35x |
| Protocols + TimeSeries (7d) | 128s | **6.8s** | ~19x |

---

## Data Volume Context

| Table | Rows | Data (MB) | Index (MB) |
|-------|------|-----------|------------|
| `device_protocol_buckets` | 1,427,035 | 151.7 | 207.3 |
| `device_traffic_buckets` | 608,677 | 92.6 | 69.8 |
| `wifi_station_snapshots` | 374,375 | 49.6 | 58.2 |
| `wifi_interface_buckets` | 152,809 | 22.6 | 14.6 |
| `wifi_network_snapshots` | 155,550 | 16.6 | 14.6 |
| `ap_system_snapshots` | 47,028 | 4.5 | 1.5 |

---

## Root Cause 1: Unnecessary `LOWER()` Defeating Indexes

### Finding

Every query touching `mac` columns wrapped them in `LOWER()`:

```sql
-- This was everywhere
WHERE LOWER(s2.mac) = LOWER(s.mac)
WHERE LOWER(s.mac) = ?
.whereRaw('LOWER(mac) = ?', [mac])
```

However, **all tables use case-insensitive collation** (`utf8mb4_unicode_ci` or
`utf8mb4_general_ci`). The `LOWER()` calls were completely redundant — MariaDB
already compares `'AA:BB:CC'` and `'aa:bb:cc'` as equal.

### Why It Killed Performance

Wrapping a column in a function (`LOWER(col)`) prevents MariaDB from using any
B-tree index on that column. Instead of an O(log N) index lookup, the engine
falls back to a **full table scan** — O(N) for every comparison.

For `wifi_station_snapshots` (374K rows) with a `(mac, recorded_at)` index, the
difference is:
- **With LOWER()**: full scan of 374,375 rows per subquery invocation
- **Without LOWER()**: index seek, ~5K rows per MAC

### Fix

Removed all `LOWER()` calls and switched `whereRaw('LOWER(col) = ?')` to
`where('col', val)`. The CI collation handles case-insensitivity automatically.

**Affected functions:** `queryLatestStations`, `queryLatestStationByMac`,
`queryLatestWifiContext`, `wifiMacExists`, `queryClientSignalHistory`,
`queryRoamingEventsForClient`

### Lesson

> Always check your collation before adding `LOWER()`/`UPPER()` to queries.
> CI collations (`_ci` suffix) are case-insensitive by default. Wrapping columns
> in functions is the most common way to accidentally defeat an index.

---

## Root Cause 2: Correlated Subqueries for "Latest Row Per Group"

### Finding

The "get the latest snapshot for each MAC" pattern was implemented as:

```sql
SELECT *
FROM wifi_station_snapshots s
WHERE s.recorded_at = (
    SELECT MAX(s2.recorded_at)
    FROM wifi_station_snapshots s2
    WHERE s2.mac = s.mac          -- correlated!
)
```

This is a **correlated subquery** — the inner `SELECT MAX(...)` runs once for
**every row** in the outer table. With 374K rows, that's 374K inner queries.

### Performance Impact

Each inner query does an index seek on `(mac, recorded_at)` — fast individually
(~0.1ms), but 374K × 0.1ms = **~37 seconds** just for the subquery work.

Combined with Root Cause 1 (`LOWER()` preventing the index), each inner query
became a full table scan: 374K × 374K = **140 billion row comparisons**.

### Fix

Rewrote to a **derived table JOIN** pattern:

```sql
SELECT s.*
FROM wifi_station_snapshots s
INNER JOIN (
    SELECT mac, MAX(recorded_at) AS max_recorded_at
    FROM wifi_station_snapshots
    GROUP BY mac
) latest ON s.mac = latest.mac
       AND s.recorded_at = latest.max_recorded_at
```

This does **one** `GROUP BY` pass over the table (sequential scan, ~32ms), then
joins back to fetch the full rows. Total: ~32ms vs ~37-60+ seconds.

**Affected functions:** `queryLatestStations`, `queryLatestNetworks`,
`queryLatestSystems`, `queryLatestWifiContext`

### Lesson

> The "latest row per group" problem is one of the most common SQL performance
> pitfalls. Correlated subqueries are correct but O(N²). The derived-table JOIN
> approach is O(N log N). For very large tables, consider maintaining a
> `_latest` materialized view or summary table.

---

## Root Cause 3: Redundant Full-Table Scans in Protocol Aggregation

### Finding

The `/api/v1/protocols` endpoint ran **two** parallel queries against
`device_protocol_buckets` (1.4M rows):

1. `queryProtocolSummary` — `GROUP BY protocol` → total bytes per protocol
2. `queryProtocolTimeSeries` — `GROUP BY bucketStart, protocol` → time series

Both scan the exact same rows with the same `WHERE` clause. The summary is
strictly a further aggregation of the time series data.

### Fix

Eliminated `queryProtocolSummary` from the `aggregateProtocols` endpoint.
The summary (total bytes per protocol with percentages) is now **derived
in-memory** from the time series results by summing across all time buckets.

This halved the I/O: one scan of 1.4M rows instead of two. Response time
dropped from **128s to 6.8s**.

The per-device `protocols()` endpoint still uses `queryProtocolSummary`
directly since it doesn't fetch time series.

### Lesson

> When two queries scan the same table with the same filter, check if one
> result can be derived from the other. Aggregating in application code is
> nearly free compared to an extra full-table scan.

---

## Additional Fix: Unbounded `peakClientsAllTime` Scan

### Finding

The WiFi overview page calls `queryPeakClients(null, now)` for the "all-time
peak" stat. With `since = null`, this scanned **all** 374K rows with:

```sql
SELECT MAX(client_count) FROM (
    SELECT COUNT(DISTINCT mac) AS client_count
    FROM wifi_station_snapshots
    WHERE inactive_ms < 200000
    GROUP BY FLOOR(UNIX_TIMESTAMP(recorded_at) / 300)
) AS sub
```

This is an expensive aggregation with no time bound, running on every page load.

### Fix

Capped the "all-time" query to **90 days**. Beyond 90 days, the peak count is
unlikely to change, and if truly needed, it could be cached or computed
asynchronously.

---

## Query-Level Caching

### Problem

Even after the SQL fixes, the dashboard still fires many identical queries on
every refresh — multiple widgets hit the same endpoint, React strict-mode double
mounts, and auto-refresh timers overlap. Each hit re-ran the full MariaDB scan
even though the underlying buckets only advance every 5–15 seconds.

### Fix

Added a lightweight in-memory cache in `app/services/query_cache.ts`:

- **`cachedQuery(key, ttlMs, fn)`** — returns a cached result within TTL;
  concurrent callers for the same key share one in-flight promise (request
  deduplication).
- **`cacheTtlForResolution(resolution)`** — TTL scales with chart resolution so
  live views stay fresh while coarser views tolerate longer staleness:

  | Resolution | Cache TTL |
  |------------|-----------|
  | `15s` | 10 s |
  | `1m` | 15 s |
  | `5m` | 20 s |
  | anything else (`5s`, `15m`, `1h`, no resolution) | 30 s |

- **`windowSegment(since, until, ttlMs)`** — buckets relative time windows
  (`range=1h`) by flooring `until` to the TTL, so dashboard polls within the
  same bucket coalesce even though `until` drifts by a few seconds.

Caching is applied at the **DB query helper** layer (not full HTTP responses),
so 404/validation paths are unaffected and errors are never cached.

**Devices** — device list, traffic buckets, protocol summary/time-series/top
devices.

**WiFi** — latest stations/networks, SSID throughput (summary + history),
client signal history, AP health history, client count history, peak clients.

### Design notes

- **Process-local only** — state is lost on restart. Acceptable for a single-Node
  home-network deployment; would need Redis if we ever fan out to multiple workers.
- **Not a substitute for SQL fixes** — the cache eliminates redundant work;
  the first request in each TTL window still pays the full query cost.
- **Completed windows** — absolute `from`/`to` ranges (Grafana drag-to-zoom) cache
  identically to relative ranges; historical data is immutable so repeated views
  of the same window are free until TTL expiry.

### Lesson

> Match cache TTL to data freshness, not an arbitrary round number. Finer chart
> resolutions need shorter TTLs; coarser ones can safely reuse results for
> longer. In-flight deduplication matters as much as TTL — two widgets mounting
> simultaneously should not double the database load.

---

## New Indexes Added

### `wifi_station_snapshots_recorded_at_idx`

```sql
CREATE INDEX wifi_station_snapshots_recorded_at_idx
    ON wifi_station_snapshots (recorded_at DESC);
```

Supports the `ORDER BY s.recorded_at DESC` in latest-station queries and
provides a fast path for time-range filters.

### `device_protocol_buckets_proto_time_mac_idx`

```sql
CREATE INDEX device_protocol_buckets_proto_time_mac_idx
    ON device_protocol_buckets (protocol, bucket_start, collector_id, mac);
```

A **covering index** for `queryProtocolTopDevices`: the query filters by
`protocol` + `bucket_start` range, then groups by `(collector_id, mac)`. All
four columns are in the index, so MariaDB can satisfy the entire query from
the index without touching the table data pages.

---

## Files Changed

| File | Changes |
|------|---------|
| `app/services/query_cache.ts` | In-memory query cache with resolution-aware TTL and in-flight deduplication |
| `app/controllers/wifi_controller.ts` | Rewrote 3 correlated subqueries to JOINs, removed `LOWER()` from 6 functions, capped `peakClients` to 90 days, wrapped heavy query helpers with `cachedQuery` |
| `app/controllers/devices_controller.ts` | Rewrote `queryLatestWifiContext` to JOIN pattern, removed `LOWER()`, eliminated redundant `queryProtocolSummary` in `aggregateProtocols`, updated `buildProtocolsResponse` to derive summary from time series, wrapped heavy query helpers with `cachedQuery` |
| `tests/unit/services/query_cache.spec.ts` | Unit tests for TTL mapping, cache hits, concurrent dedupe, and window bucketing |

---

## Future Considerations

1. **Summary tables / materialized views** — For protocol data growing beyond
   2-3M rows, consider a nightly job that pre-aggregates into hourly or daily
   summary tables. This would make 7d/30d queries instant.

2. **`wifi_station_snapshots` pruning** — At 374K rows and growing, consider a
   retention policy (e.g., keep raw snapshots for 30-90 days, then downsample).

3. **`peakClients` persistent cache** — The query-level cache (30 s TTL) covers
   repeated page loads, but the "all-time peak" value changes rarely. A
   longer-lived entry in `system_settings` updated by the scheduler would
   eliminate even the first-hit cost.

4. **Cross-process cache** — If metrics-be ever runs multiple Node workers,
   the in-memory cache needs to migrate to Redis (or each worker needs a
   disjoint partition) to preserve deduplication guarantees.

---
---

# Follow-up: Multi-Week Traffic Queries — June 14 2026

## Why revisit

The May 28 pass fixed query *shape* (redundant `LOWER()`, O(N²) correlated
subqueries, double protocol scans) and added the short-TTL query cache. It
explicitly deferred **Future Considerations #1 (summary tables) and #2
(retention)**. Those are now the binding constraint: **multi-week traffic and
overview views take 15–60+ seconds, and the protocol aggregate over a 28-day
window ran for 11 minutes before being killed.**

The reason is pure data growth. In ~2.5 weeks the bucket tables grew ~8.4×:

| Table | May 28 | June 14 | Growth |
|-------|--------|---------|--------|
| `device_protocol_buckets` | 1,427,035 rows / 152 MB | ~12,008,285 / 1,155 MB | ~8.4× |
| `device_traffic_buckets` | 608,677 rows / 93 MB | 5,102,919 / 657 MB | ~8.4× |

The May 28 "after" numbers were measured at the smaller sizes; at today's
volume the traffic/overview/protocol endpoints have regressed back into the
tens-of-seconds-to-minutes range for wide windows.

## Measured — 28-day window, live `hypermetrics` DB

Resolution `1h` (what the FE auto-picks for windows > 7 d), warm cache, 3 runs.

| Endpoint (helper) | EXPLAIN verdict | Rows examined | Time |
|---|---|---|---|
| `aggregateTraffic` — home bandwidth chart (`queryTrafficBucketsUncached`, `devices_controller.ts:760`) | `type=ALL`, `key=NULL`, `Using temporary; Using filesort` | 4.2–5.0M (**whole table**) | **~31 s** |
| `devices` index — top-talker list (`devices_controller.ts:191`) | derived-table `ALL` + `temp; filesort` | 4.2M | **~28.7 s** |
| per-MAC `traffic` / `overview` (`devices_controller.ts:760`) | `range` on `(mac,bucket_start)`, **but** `temp; filesort` | 447k (one MAC) | **~14.5 s** |
| `aggregateProtocols` (`devices_controller.ts:1013`) | `index` scan + `temp; filesort` | 10.8M | **killed at 679 s** |

### Two structural causes

1. **No `bucket_start`-leading index on `device_traffic_buckets`.** Indexes are
   `(mac,bucket_start)`, `(collector_id,bucket_start)`, `unique(collector_id,mac,bucket_start)`
   (migration `…0004`). Any **all-device** query filters on `bucket_start`
   alone, so nothing can range-scan — it reads the entire table for every
   request. (`device_protocol_buckets` *does* have `(bucket_start,protocol)` +
   the May 28 `proto_time_mac` covering index, so it index-scans rather than
   table-scans — but still reads all 10.8M rows for a wide window.)

2. **`GROUP BY` on a derived expression** —
   `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(bucket_start)/N)*N)` (`devices_controller.ts:763`,
   `:1158`). The optimizer can't use an index for that grouping, so **every**
   read gets `Using temporary; Using filesort`, even the per-MAC query that
   range-scans its rows.

### Data-shape note (important for the fix)

The 28-day window contains **5,102,830 of 5,102,919 rows — 99.998%.** Only 89
rows are older than 28 days (the `2024-09-01` "oldest" is a handful of stray
import/seed rows). So the live working set *is* ~28 days of dense ~5 s data.
This is why a wide window already touches the whole table — and why an index
alone can't help (next section).

## What does NOT fix it: a `bucket_start` index

Tested directly. `ALTER TABLE device_traffic_buckets ADD INDEX dtb_time_idx (bucket_start)`
(build: 22 s) then re-ran `aggregateTraffic`:

```
EXPLAIN: type=ALL  possible_keys=dtb_time_idx  key=NULL   <-- optimizer DECLINED it
Q1 with (bucket_start) idx:  30.122 s   (vs ~31 s before — no change)
```

Reasons it's useless here:
- The window ≈ the whole table, so an index *range* scan = a *full* scan; the
  optimizer correctly ignores the index.
- A plain `(bucket_start)` index isn't covering, so using it would mean ~5M
  random PK look-ups for the `SUM` columns — slower than the sequential scan.
- It does nothing about the `temp; filesort` from the derived `GROUP BY`.

It would only ever help once history >> window *and* raw rows are kept
long-term — but with rollups (below) you won't scan raw for wide windows, and
with retention you won't keep raw long-term. **Skip it.**

## What fixes it: hourly rollup tables

Prototyped a `dtb_hourly` table (PK `(collector_id, mac, hour_start)`, same
counter columns, index on `hour_start`), backfilled with one
`INSERT … SELECT … GROUP BY collector_id, mac, hour_start` (one-time, 47.6 s).
The 28-day window shrank from **5.1M raw rows to 8,405 rollup rows**, and the
plan became a clean index range scan with **no temp/filesort** (the `GROUP BY`
is now on the bare indexed `hour_start`, not an expression):

```
EXPLAIN R1: type=range  key=dtb_hourly_time_idx  rows=8405  Extra="Using where"
```

| Query | Before (raw) | After (hourly rollup) | Speedup |
|---|---|---|---|
| all-device traffic chart | ~31 s | **0.059 s** | ~525× |
| top-talker device list | ~28.7 s | **0.023 s** | ~1250× |
| per-MAC traffic | ~14.5 s | **0.052 s** | ~280× |

Rollup table footprint for the full dataset: ~0.1 MB. (Prototype artifacts
`dtb_time_idx` and `dtb_hourly` were dropped after measuring — the DB is back to
its original schema.)

## Recommended implementation

### P0 — Hourly rollup tables (traffic + protocol)

This is Future-Consideration #1, now load-bearing. Build it for **both**
`device_traffic_buckets` and `device_protocol_buckets` (the protocol table is
the bigger fire — 12M rows, 11-minute query).

**a. Schema** (new migration), e.g. `device_traffic_buckets_hourly`:

```ts
table.integer('collector_id').unsigned().notNullable()
table.string('mac', 17).notNullable()
table.datetime('hour_start').notNullable()        // bucket_start floored to 3600s
// ...the same 12 byte/packet counter columns...
table.primary(['collector_id', 'mac', 'hour_start'])
table.index(['hour_start'], 'dtbh_time_idx')             // all-device range scans
table.index(['mac', 'hour_start'], 'dtbh_mac_time_idx')  // per-MAC
```

(Protocol variant adds `protocol` to the PK, matching the raw table.)

**b. Incremental maintenance** — piggyback on the existing writer. `writeBuckets`
(`bucket_writer.ts:89`) already does a batched
`onConflict(...).merge({ col: db.raw('?? + VALUES(??)', ...) })`. Add a second,
identical upsert into the hourly table in the same call, keyed on
`alignToBucket(pollAt, 3600)`:

```ts
const hourStartSql = alignToBucket(pollAt, 3600).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
await db.insertQuery().table('device_traffic_buckets_hourly')
  .multiInsert(rows.map(r => ({ ...r, hour_start: hourStartSql })))
  .onConflict(['collector_id', 'mac', 'hour_start'])
  .merge({ /* same `?? + VALUES(??)` SUM merge */ })
```

Cost: one extra batched upsert per poll (~once per 5–15 s). Negligible, and it
keeps the rollup exact and always-current — no cron, no drift. Do the same in
`writeProtocolBuckets` (`bucket_writer.ts:155`).

**c. Backfill** — one-time `INSERT … SELECT … GROUP BY` in the migration (~48 s
for traffic; protocol is larger, run it off-peak or in `hour_start` batches).

**d. Read-path routing** — in `queryTrafficBucketsUncached` /
`queryProtocolTimeSeriesUncached` and the `devices` index + `overview` queries,
choose the source by resolution:

```ts
const useRollup = resolutionSeconds >= 3600          // 1h+ → rollup
const table = useRollup ? 'device_traffic_buckets_hourly' : 'device_traffic_buckets'
const timeCol = useRollup ? 'hour_start' : 'bucket_start'
// when useRollup, GROUP BY the bare timeCol (no FROM_UNIXTIME) → no temp/filesort
```

The FE already auto-selects `1h` for windows > 7 d and `15m` for ≤ 7 d
(`metricsfe/src/lib/time-window.ts`), so `resolutionSeconds >= 3600` routes
exactly the multi-week views to the rollup while short/fine views stay on raw.
*(Optional second tier: a 5-minute rollup for the 1–7 day / `15m`–`5m` band.)*

### P1 — Retention / downsampling of raw buckets

Future-Consideration #2. Once rollups preserve long-term history, prune raw
rows older than ~14–30 days on a schedule (the `(collector_id, bucket_start)`
index supports the delete; there's already a scheduler in `config/scheduler.ts`
and an `app/tasks/` dir). This bounds raw-table growth so even raw-served recent
queries stay fast *permanently* — without it, every query (even 24 h) keeps
scanning more rows as the deployment ages. The protocol table (12M rows / 19
days, +1 GB per 3 weeks) needs this most.

### P2 — Bare-column `GROUP BY` on the raw path too

Even for short/fine windows, `GROUP BY FROM_UNIXTIME(FLOOR(...))` forces
`temp; filesort`. When the requested resolution equals the native bucket size
(the common live case), `GROUP BY bucket_start` directly — no expression, no
sort. Smaller win than P0, but cheap.

### P3 — Guardrails + cache for immutable windows

- Cap buckets per request: reject/coarsen when `(until-since)/resolutionSeconds`
  exceeds ~5,000, so a hand-crafted `from`/`to` can't request 160k buckets
  (the validator currently allows `range` up to `999999d` with no coupling to
  resolution — `validators/devices.ts`).
- For windows whose `until` is safely in the past (immutable history), cache
  with a long/indefinite TTL keyed on the absolute window, instead of the
  current 10–30 s TTL that makes relative-window polls recompute every 30 s
  forever.

## Bottom line

The May 28 work optimized query *shape*; the table then grew 8.4×, and the
deferred *summary-table + retention* items are now what stands between the
dashboard and a usable multi-week view. The hourly rollup is the decisive fix
(measured 280–1250×), incremental maintenance fits the existing writer in a few
lines, and retention keeps it fast as the data keeps growing.

---

## Implemented — June 14 2026 (P0–P3)

All four were built, applied to the live DB, and verified end-to-end.

### What shipped

| Part | Change |
|---|---|
| **P0 schema** | `device_traffic_buckets_hourly` + `device_protocol_buckets_hourly` (migrations `…0019`, `…0020`), each with a one-time idempotent backfill (`INSERT … SELECT … GROUP BY … ON DUPLICATE KEY UPDATE = VALUES`, safe to run with the poller live). |
| **P0 maintenance** | `bucket_writer.ts` — `writeBuckets`/`writeProtocolBuckets` now upsert the hour-aligned rollup in the **same transaction** as the native write, reusing the `?? + VALUES(??)` SUM merge, so the rollup can never desync from its source. `HOURLY_ROLLUP_SECONDS` is the single source of truth. |
| **P0 read routing** | `devices_controller.ts` — time-series reads route to the rollup when `resolutionSeconds ≥ 3600 && span ≥ 2 d`; window-aggregate reads (device list, protocol breakdown/top-devices) route when `span ≥ 2 d`. Rollup reads `GROUP BY` the bare indexed `hour_start` → **no temp/filesort**. |
| **P2** | Native path now groups on the bare column where the requested grain equals the native bucket size; the derived `FROM_UNIXTIME(FLOOR(...))` only runs when actually rolling up sub-hour grains. |
| **P1 retention** | `bucket_retention.ts` + `prune_buckets.task.ts` (daily 03:30) prune native rows older than `BUCKET_RETENTION_DAYS` (default 30) in batches; rollups are kept as the long-term history. |
| **P3** | `resolveResolution` coarsens too-fine grains to fit a 2000-bucket target and 400s windows that overflow even at `1h`; `windowCache` gives immutable (past) windows a 6 h TTL with a 1 s-grained key, while live windows keep the short resolution-scaled TTL. |

### Measured on the live DB (28-day window)

Correctness first: full-history rollup sums equal native sums **to the byte**
(traffic & protocol, in & out). Rollups are tiny — traffic 16.8 k rows / 6.5 MB,
protocol 111 k rows / 25.7 MB.

| Query | Before | After (direct SQL) | After (HTTP API) |
|---|---|---|---|
| all-device traffic chart | ~31 s | **0.19 s** | `GET /traffic` **0.22 s** |
| top-talker device list | ~28.7 s | **0.024 s** | `GET /devices` 2.57 s¹ |
| protocol aggregate | ~679 s | **0.34 s** | `GET /protocols` **0.92 s** |
| per-MAC traffic | ~14.5 s | **0.05 s** | — |

¹ `/devices` SQL is 0.024 s; the remaining ~2.5 s is the **pre-existing**
per-device hostname/ASN/wifi enrichment N+1 (out of scope here, noted as the
next bottleneck).

EXPLAIN of the 28-day all-device query now: `range` scan on
`device_traffic_buckets_hourly_time_idx`, ~8.4 k rows, `Using where` only.

### Tests

17 new tests (rollup maintenance incl. WAN/LAN + hour-splitting, retention incl.
dry-run/batching/rollup-preservation, `windowCache` TTL/keying, and API rollup
routing + guardrails) — all green. Also fixed cross-test query-cache leakage by
resetting the cache in the read-API `resetDb`. Suite: 100 passed / 9 failed; the
9 are **pre-existing** (verified against a pristine-HEAD baseline): one broken
`windowSegment` unit test, two enrichment tests needing config, and ~6
window-boundary tests that flake on a 1-second `bucket_start < until` edge.

### Operational notes

- `BUCKET_RETENTION_DAYS=30` is the default; set `0` to disable pruning. The
  daily task only deletes **native** rows — rollups retain full history.
- The backfill is idempotent; re-running migrations is safe.

---

## Follow-up — sub-hour windows (1h–7d) — June 14 2026

The hourly rollup only covered `1h`-resolution (>7d) views. Profiling the
running dashboard showed everything *else* was still slow, because the
all-device chart **full-scans the whole table for any sub-hour resolution**
(there was no `bucket_start`-leading index) — even the **default 1-hour home
view cost ~14 s**, and a 7-day chart at the frontend's `15m` grain was ~40 s.

Two additions close the gap:

| Part | Change |
|---|---|
| **`bucket_start` index** (migration `…0021`) | The all-device native queries now range-scan the window slice instead of full-scanning 5.2M rows. Fixes every short/medium window at `1m`/`15s`/`5s` (≤ ~1 day). |
| **5-minute rollup tier** (migrations `…0022`/`…0023`) | `device_traffic_buckets_5m` + `device_protocol_buckets_5m` (`slot_start`). Serves the `5m`/`15m` band (6 h–7 d). `bucket_writer` now fans every native write into **all** rollup tiers via `ROLLUP_TIERS` (one transaction); reads pick the coarsest tier whose grain ≤ the request (`pickSeriesTier`), grouping the bare slot column when the grain matches and regrouping (e.g. 15m from 5-minute slots) otherwise. |

Routing summary (time-series): `≥1h & ≥2d → hourly`; `≥5m & ≥6h → 5-minute`;
finer → native (index-assisted). Window-aggregates (device list, breakdowns)
stay `≥2d → hourly`, else native+index.

### Measured (live DB, end-to-end HTTP)

| View | Before | After |
|---|---|---|
| `traffic` 7d @15m | 39.8 s | **0.76 s** |
| `protocols` 7d @15m | 39.8 s | **2.29 s** |
| `traffic` 1h @15s (home default) | ~14 s | **0.16 s** |
| `traffic` 24h @5m | ~13 s | **0.08 s** |

Correctness: 5-minute rollup sums equal native sums to the byte. Footprint:
5m traffic 167 k rows / 42 MB, 5m protocol 788 k rows / 168 MB. Retention now
tiered: native 30 d (default), 5-minute rollups 365 d, hourly kept forever
(`bucket_retention.ts`).

---

## Follow-up — `/devices` enrichment latency — June 14 2026

With the SQL fast, `GET /devices?range=7d` still showed ~2 s in DevTools.
Profiling (4 calls in a row: 1.78 s, then 0.07 / 0.04 / 0.05 s) showed it was
**not** a per-device N+1 but the **hostname-enrichment state refresh** blocking
the *first request after each 60 s TTL window*: `getHostnameState()` awaited
`loadHostnameState()`, which runs `lxc exec … cat /tmp/dhcp.leases` + `uci show
dhcp` — ~1.7 s when the router's LXC container is slow/absent — then cached for
60 s.

Fixes in `hostname_enrichment.ts`:
- **Stale-while-revalidate** `getHostnameState()`: once a state exists, an
  expired cache serves the stale state immediately and refreshes in the
  background. Only the cold first load after boot blocks. Proven live: with the
  TTL dropped to 5 s and `/devices` hit every 1.6 s across several expiry
  boundaries, every request after the first was 37–97 ms (no recurring 1.7 s
  spikes).
- **Batched `getHostnameMatches(identities[])`**: resolves the state **once**
  and matches the whole list in memory (in input order), used by the device
  index. Removes the per-device `SystemSetting.get` re-reads; the per-row map
  is now pure CPU (no awaits).

Result: `GET /devices?range=7d` ~2.0 s → **~40 ms** steady-state.

---

## Phase 2 — tiered retention / compression (database size) — June 15 2026

Different goal from the query-speed work above: **bound database growth.** Measured
the live DB at **8.06 GB**, lopsided toward `device_protocol_buckets` (4.0 GB, of
which 2.6 GB is *index*) and `device_traffic_buckets` (1.4 GB); `wifi_interface_buckets`
was 512 MB with **no rollup and no retention at all**. At full-rate collection the two
native tables alone grow **~11.5 GB/month**.

**Measured compression (not the naïve 3×/6×/12×/24×).** Devices emit sparsely (~every
10 s on a 5 s grain), so a clean full-rate day (Jun 6) gave real reductions:

| target grain | traffic kept (×) | protocol kept (×) |
|---|---|---|
| 15 s | 39.9 % (2.5×) | 49.1 % (2.0×) |
| 30 s | 21.9 % (4.6×) | 31.8 % (3.1×) |
| 60 s | 12.0 % (8.4×) | 19.9 % (5.0×) |
| 120 s | 6.2 % (16×) | 11.7 % (8.5×) |
| 300 s (5 m) | 2.6 % (39×) | 5.7 % (17×) |

Key finding: the originally-proposed progressive native downsampling (15/30/60/120 s)
was **dropped** — for data >30 days, 1–5-minute detail is sufficient, and the
**existing 5-minute rollup already is that tier**. So "tiered compression after X days"
was mostly already built; the remaining work was retention tuning + bringing wifi into
the scheme.

### Retention ladder (the change)

| age | tier (already existed) | resolution | before | now |
|---|---|---|---|---|
| 0–30 d | native | ~5 s | drop @30 d | unchanged |
| 30 d → 2 yr | 5-minute rollup | 5 min | drop @365 d | **730 d** |
| 30 d → 2 yr | hourly rollup | 1 h | **never pruned** | **730 d** |
| > 2 yr | — | — | hourly forever | **hard-deleted** |

`bucket_retention.ts` generalised to three tiers (native `bucket_start` / 5 m
`slot_start` / hourly `hour_start`), each coarser horizon clamped ≥ the finer one.
Configurable via `BUCKET_5M_RETENTION_DAYS` / `BUCKET_HOURLY_RETENTION_DAYS` (default
730). Projected steady state ≈ **25 GB** at 2 years, then flat — versus ~146 GB if 5 s
were kept that long. (Downsampling-and-keeping is *not* smaller than the prior 30-day
hard-drop; it is how you afford keeping 2 years of detail.)

### wifi brought into the scheme

`wifi_interface_buckets` had a native table only. Added lean rollups
`wifi_interface_buckets_5m` (`slot_start`) + `_hourly` (`hour_start`) — natural-key PK
`(ap_id, ifname, time)`, two secondaries `(time)` + `(ssid, time)`, no surrogate id
(migrations `…0024`/`…0025`, idempotent backfill). `wifi_bucket_writer` now fans native
+ both rollups in one transaction (SUM the counters, overwrite the `ssid`/`radio`/`band`
attributes). `wifi_controller` SSID-throughput reads route via the shared
`pickSeriesTier`/`useHourlyForAggregate`. wifi compresses hugely (few interfaces on a
5 s grain): 2.31 M native → 45.7 k (5 m) → 3.8 k (hourly), sums exact.

The read-side tier helpers (`pickSeriesTier`, `useHourlyForAggregate`,
`windowSpanSeconds`) were extracted from `devices_controller` into
`#services/rollup_tiers` so devices + wifi share one native-vs-rollup decision;
`bucket_writer.ROLLUP_TIERS` gained a `wifiTable` per tier.

### Index audit — measured, decided to KEEP

The tables that grow to 2 years (the 5 m/hourly rollups) are *already* lean. The heavy
index is only on the **native** protocol table — but that's bounded at 30 days, so it
is a one-time cost, not a growth problem. The one drop candidate,
`device_protocol_buckets_proto_time_mac_idx` (the 4-col `(protocol, bucket_start,
collector_id, mac)`), was measured live on the worst case (47 h `https`
top-devices-for-protocol): **5.8 s with the index vs 7.8 s without (+34 %)**. Wide
protocol-filtered reads route to the hourly rollup, but sub-2-day ones still use this
index and it earns its keep. **Decision: keep all four protocol indexes as-is.** A
zero-regression `(protocol, bucket_start)` 2-col shrink (~0.5 GB) is noted as an
optional future tweak. (Re-clustering native on the natural key — dropping the surrogate
`id` — nets only ~0.9 GB over the cheap options on a bounded table and was rejected as
not worth a full live rebuild.)

### Verified live (poller paused for the migration, then resumed)

- wifi rollup sums == native exactly (all counters).
- Hour-aligned 7 d SSID throughput: native == hourly rollup exactly (3 SSIDs, identical
  byte totals) — read routing correct.
- Poller resumed maintaining native + 5 m + hourly wifi tiers in real time (writes 3 s
  fresh). All clock checks via `UTC_TIMESTAMP()` (the box runs a UTC+8 session tz while
  `bucket_start` is stored UTC — a raw `NOW()` looks 8 h stale).
- 15 new/updated tests green (retention 3-tier + 2 yr wall + configurable; wifi rollup
  fan-out + boundary splits + sums + retention); 0 regressions.

---

## Phase 3 — counter-reset glitch cleanup + write-path guard — June 15 2026

A "broken spike" on the 7d bandwidth chart (10,321 Mbps / 1.1 TB in one 15-min bucket)
turned out to be a **counter-reset glitch**: when a device's cumulative counter resets,
the collector diffs against a stale baseline and records the whole accumulated counter
(or a monotonic ramp) as one bucket. Distinguished from real heavy traffic by **shape** —
a strictly monotonic ramp (constant increments, no gaps) vs variable-with-gaps. Two
offenders: a Xen/LXC virtual MAC `00:16:3e:…` (daily/month-boundary dumps, 0.5–33 TB,
some with corrupt 2024–2026 timestamps) and an active server `5a:d2:…` (one 8-min ramp
to 18 GB/5s). Real peak on this network is ~1.8 GB/bucket (~2.86 Gbps).

**Cleanup (live, reversible):** deleted the corrupt native rows and *recomputed* the
affected 5m/hourly rollup rows from cleaned native (the chart reads the 5m rollup for
7d@15m, so deleting native alone wouldn't fix it; and the offending hours held real
traffic too, so recompute, not blanket-delete). The all-glitch LXC MAC was purged
entirely. Result: max 15m fell 10,321 → ~610 Mbps (7d) / ~1168 Mbps (30d), both real;
real data intact. Deleted rows backed up to `/tmp/spike_backup_*.tsv` + `/tmp/purge_*.tsv`.

**Guard (prevents recurrence):** `bucket_writer.deltaBytesArePlausible()` +
`MAX_BUCKET_DELTA_BYTES` (env `BUCKET_MAX_DELTA_BYTES`, default 5 GB, 0 disables). All
three writers (`writeBuckets` / `writeProtocolBuckets` / `writeWifiInterfaceBuckets`)
drop + `logger.warn` any single delta whose in/out bytes exceed the cap, so a glitch
becomes a gap across every tier. **Byte-cap only, deliberately no timestamp guard:** every
glitch (incl. the misdated orphans) had huge byte values, so the cap catches them all;
a timestamp guard would reject legitimately old/backfilled data and break the retention
tests. 3 new tests green; verified live (poller writing real ~50 MB/bucket data straight
through, nothing legit dropped).

---

## Phase 4 — WiFi "Client distribution" graph rollup — June 15 2026

`wifi_controller.clientsHistory` re-ran `COUNT(DISTINCT mac)` over the raw
`wifi_station_snapshots` (5.45M rows) grouped on a derived `FROM_UNIXTIME(FLOOR())`
(temp+filesort) on every cache miss — and the optimizer full-scanned each AP's rows
instead of range-scanning `recorded_at`. Measured **15 s @24h / 38 s @7d**.

**Why a rollup, not just an index fix:** forcing the `recorded_at` range scan only got
24h to ~3.8 s — the `COUNT(DISTINCT)` temp/filesort over raw rows is inherent. And
`COUNT(DISTINCT)` is **not additive across buckets** (a client in three 5-min slots is
one distinct client in the hour, not three), so unlike the byte-sum rollups it can't be
fanned in incrementally.

**Fix:** `wifi_client_distribution` (migration `…0026`) stores the **exact** distinct
count per `(grain_seconds, ap_id, band, slot_start)` for grains **60/300/900/3600**
(1m/5m/15m/1h) — each grain computed independently from raw, so every resolution is
exact. `band` is stored '' (nullable on source) to sit in the PK; index
`(grain_seconds, slot_start)`. Maintained by `recompute_client_distribution.task`
(every 5 min, recomputes the last ~3 h via `#services/client_distribution_rollup`, a
batch recompute since distinct counts aren't incremental — `since` floored to the
coarsest grain so no slot is partially counted). `clientsHistory` routes 1m/5m/15m/1h to
the rollup (bare indexed range scan); finer 5s/15s (short windows only) keep the raw
query. Rollup row counts: 1m 115k / 5m 23k / 15m 7.9k / 1h 2.1k (vs 5.45M raw).

**Verified live:** rollup counts == raw `COUNT(DISTINCT mac)` exactly (sampled slots);
end-to-end HTTP **24h 15 s → 0.13 s, 7d 38 s → 0.07 s** (~300–550×), correct buckets +
band/AP breakdowns. 5 new tests green. The scheduled task auto-discovers at boot, so it
activates on the next server restart (the rollup was hand-refreshed in the meantime).
Follow-up opportunity: `wifi_station_snapshots` (1.5 GB) is now only needed at the live
edge / fine grains, so it's a candidate for retention pruning.
