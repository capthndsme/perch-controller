# Looking-glass rebuild — status

Working notes for the "make metricslite a looking glass of the network"
effort. Local file on purpose: this is a side project, status does not go to
Notion or Slack.

Last updated: 2026-09-20.

## Where we started (audit, 2026-09-18)

- Stack was **down**: last row in every table 2026-07-06 11:50:35, nothing
  under pm2 or systemd. It had been run by hand.
- MariaDB `hypermetrics` = 13.6 GB on the **default 128 MB buffer pool**.
- Largest tables: `device_protocol_buckets` 18 M rows / 5.5 GB (3.5 GB of
  that was four secondary indexes), `wifi_station_snapshots` 9.7 M / 2.9 GB
  (never pruned), `device_traffic_buckets` 7.6 M / 2.1 GB,
  `wifi_network_snapshots` 4.8 M / 0.9 GB (never pruned).
- Measured on the real data: WiFi "peak clients" 7 d = 36 s, all-time = 65 s
  (the WiFi overview ran three of them per load, refetched every 10 s);
  protocol mix 7 d at 15 m = 17 s; 1 h views 0.1–0.5 s.
- Write path per 5 s tick: every native write fanned into two rollup tiers,
  and the top-peers mirror was rewritten with a DELETE + INSERT transaction
  per device per scope for all ~147 known devices (~300 fsynced transactions
  rewriting ~6.5 k rows per tick — also the gap-lock deadlock source).

## What changed (items 1–7)

| # | Item | Done |
|---|------|------|
| 1 | Ops: pm2 + boot, production build, buffer pool | `ecosystem.config.cjs`, `deploy.sh`, `.env.production`; `innodb_flush_log_at_trx_commit=2` applied live. **Buffer pool still 128 MB**: MariaDB 11.8 caps runtime resizes at `innodb_buffer_pool_size_max` (= startup size), so it needs the cnf in `docs/ops/mariadb-metricslite.cnf` + a restart (sudo). `db_tuning_provider` / `tune_database.task` re-apply `DB_TUNE_*` at boot for after that |
| 2 | Peer churn | Poller diffs peer heaps in memory: idle devices skipped, one batched UPSERT per tick, DELETE only when an IP set changed (`writeTopPeersBatch`). New `device_peer_buckets_hourly` = peer *history*; new endpoints `GET /api/v1/peers/top` and `GET /api/v1/devices/:mac/peers/history` |
| 3 | WiFi snapshots | Retention for `wifi_station_snapshots` / `wifi_network_snapshots` / `ap_system_snapshots` (14 d) and roaming events (90 d). New `*_latest` tables (one row per key, upserted per tick) replace every "latest per group" scan. New 5-minute rollups `wifi_station_buckets_5m`, `wifi_network_buckets_5m`, `ap_system_buckets_5m` serve wide signal / RF / AP-health windows |
| 4 | Peak clients | Read from `wifi_client_distribution` (per AP) and the new exact global `wifi_client_totals`; all-time peak stored in `system_settings` and bumped by the 5-minute recompute task |
| 5 | Protocol cardinality | Native protocol rows written at **1 m** grain (12× fewer rows), every protocol kept; protocol reads clamp to ≥ 1 m and jump to the hourly tier from 2 days |
| 6 | Rollups | `rollup_maintainer` rebuilds 5 m → hourly → daily from the tier below once a minute (replace semantics, idempotent) instead of per-write fan-out; new daily tier for all three streams; `1d` resolution end-to-end |
| 7 | Reads | ETag + `Cache-Control: private, no-cache` on API GETs (304 on unchanged polls); mini-map refresh capped at 1/min; DB session pinned to UTC |

Also: `node ace buckets:prune [--dry-run]`, `node ace rollups:backfill`,
tests for the rollup ladder and peer batching.

## Result after the deploy (2026-09-18, still on the 128 MB buffer pool)

Database 13.6 GB → **768 MB** (six all-stale tables swapped for fresh copies,
rollups and the new 5-minute WiFi tiers keep the history; retention sweep
handles the rest nightly). Disk 76 % → 69 %.

Endpoint timings on the real data, cold pool / warm cache:

| Endpoint | Before | Now |
|---|---|---|
| WiFi overview 24 h (3 × peak clients) | ~100 s | 2.0 s / 10 ms |
| Protocol mix 7 d | 17 s | 2.2 s / 67 ms |
| Devices 7 d (hourly tier) | — | 0.46 s / 9 ms |
| Traffic 28 d @1h | ~0.1 s | 76 ms / 23 ms |
| Traffic 60 d @1d (daily tier, new) | — | 28 ms / 5 ms |
| WiFi clients (latest table) | 0.5 s | 75 ms |
| WiFi RF history 7 d (5 m rollup) | — | 0.29 s |

ETag revalidation returns 304 with an empty body on unchanged polls.
Peer history (`/peers/top`) is empty until the collector runs with its
capability (see below).

## Hosting: two hostnames, two servers

- `metrics-api.example.com` → Apache `ProxyPass / http://localhost:12553/`.
  The API port therefore comes from `metrics-be/.env` (`PORT=12553`);
  `.env.production` must never override it (it briefly did, which produced
  "Could not reach the backend").
- `metrics.example.com` → Apache `DocumentRoot /var/www/metrics`, a
  static copy owned by root. `deploy.sh` rsyncs `metricsfe/dist` into it when
  the directory is writable (`sudo chown -R $USER:www-data /var/www/metrics`
  once), or prints the `sudo rsync` command otherwise. The pm2 `metricslite-fe`
  app on :5173 serves the same build for plain-HTTP LAN access; pointing the
  vhost at it instead (`docs/ops/apache-metricsfe.conf`) also fixes deep-link
  refreshes, which a bare DocumentRoot without a rewrite rule 404s.

## Operating it

```bash
./deploy.sh                 # build api/fe/collector, migrate, pm2 startOrReload + save
./deploy.sh --api           # rebuild + migrate + reload only the API
pm2 ls; pm2 logs metricslite-api
cd metrics-be/build && node ace buckets:prune --dry-run
```

One-time root step (pcap capability; repeat after every collector rebuild):

```bash
sudo setcap cap_net_raw,cap_net_admin=eip go-collector/out/go-collector
sudo cp metrics-be/docs/ops/mariadb-metricslite.cnf /etc/mysql/mariadb.conf.d/60-metricslite.cnf && sudo systemctl restart mariadb
```

## Servers: "how many GB did my servers push" (2026-09-18)

- **Collector**: with nDPI, each flow's TLS SNI / HTTP Host / QUIC SNI is
  read from the ClientHello and credited to the local device that is the
  *server* side of the flow (`services[]` per device: `bytes_served` =
  server → client, `bytes_received` = client → server). A device acting as a
  client of a remote server never gets a row. Cap `top_services_count`
  (default 500). Direction comes from the flow's first packet, corrected by
  well-known ports when we join mid-flow.
- **Backend**: `device_service_buckets_hourly` (retention
  `SERVICE_HOURLY_RETENTION_DAYS`, 365 d), poller deltas, and
  `GET /api/v1/services`, `GET /api/v1/devices/:mac/services`,
  `GET /api/v1/services/:serverName/traffic` (`1h` / `1d`).
- Apache on this host terminates TLS per ServerName and proxies to localhost
  ports or LAN backends, so the proxy MAC will show one row per vhost; the
  LAN hop to a backend (e.g. 192.168.2.101) shows up on the backend's MAC as
  plain `http`/`https` with the backend's own SNI when it is TLS.
- Rebuilding the collector drops its file capability: after every collector
  deploy run `sudo setcap cap_net_raw,cap_net_admin=eip go-collector/out/go-collector`
  then `pm2 restart metricslite-collector`.

## UniFi-style dashboard (2026-09-18, shipped)

`metricsfe` is now an app shell: collapsible sidebar (icon rail on desktop,
drawer on mobile), sticky top bar with global search (`/` to focus; devices
by hostname / IP / MAC, WiFi clients, SSIDs), theme toggle, user menu.
Routes: `/` Dashboard (KPI tiles, bandwidth + mini-map, top talkers, top
destinations by ASN, protocol mix, WiFi summary), `/traffic` (destinations
by ASN with share bars, protocol stack, per-protocol devices, LAN peers),
`/devices` (dense sortable table with WiFi placement, filters, search),
`/devices/:mac` (identity + WiFi cards, bandwidth, "who it talks to" from
peer history, protocol mix, "served by this device"), `/servers` (GB served
per SNI with expandable hourly/daily series and a by-server table), `/wifi/*`
and `/settings/*` restyled. Chart colours are entity-stable series tokens
validated in light and dark mode.

Known gaps: the sidebar site name is static (no authenticated endpoint
exposes `site_name`); the layout has only been reviewed statically.

## Dashboard polish (2026-09-18, shipped)

- **Wi-Fi tile sparkline.** The dashboard Wi-Fi panel now opens with
  "Connected clients" over the selected window (now / peak in window, hover
  for the exact count) above the SSID table. It reads
  `GET /api/v1/wifi/clients/history` at the coarsest rollup grain that keeps
  the window under ~300 points (`wifiHistoryResolutionForWindow` in
  `metricsfe/src/lib/wifi.ts`: 1m ≤ 3h, 5m ≤ 24h, 15m ≤ 3d, else 1h), so it
  never touches the raw snapshot table. Component:
  `metricsfe/src/components/charts/wifi-clients-sparkline.tsx`.
- **Colours: red = download, green = upload.** Changed at the token level
  (`--chart-download`, `--chart-upload`, their overlays, and `--chart-served`
  = upload hue / `--chart-received` = download hue) in
  `metricsfe/src/index.css`, so every bandwidth, service and KPI element
  flipped together. The two hues also differ in luminance so they still
  separate for red/green colour-vision deficiency. The mini-map and the
  signal chart moved to the neutral brand blue because they are not
  directional. Download/upload arrows on the KPI tiles and top talkers are
  tinted the same way.
- **SPA deep links.** `docs/ops/apache-metricsfe-spa.conf` adds
  `FallbackResource /index.html` for `/var/www/metrics` (assets exempt so a
  stale bundle still 404s), immutable caching for `/assets`, `no-cache` for
  `index.html`, and turns directory listings off. Install instructions are in
  the file header (one `cp`, one `sed`, `apachectl configtest`, reload).
  `AllowOverride None` on `/var/www` is why this cannot be a `.htaccess`.

## Destinations by name + application categories (2026-09-18, shipped)

B.1 and B.2 from the brainstorm below. "142.250.x.x 4.2 GB" becomes
"googlevideo.com 4.2 GB · Media", and every protocol view can be grouped by
nDPI application category for the whole existing history.

**Collector** (`go-collector`, needs `sudo setcap` after the rebuild):
- `classifier.Result.Category` — nDPI's flow category
  (`ndpi_get_proto_category`, hostname-aware, so an ad domain over TLS is
  `advertisement` while the protocol stays `https`). Slugs are
  lowercase-dash (`social-network`, `remote-access`); `Unspecified` → "".
- Per-device `destinations[]`: the mirror image of `services[]`. Rows land
  on the local device that is the *client* of a WAN flow, keyed by the
  TLS SNI / HTTP Host / QUIC SNI it asked for + protocol label, with
  `category`, `bytes_in` (downloaded) / `bytes_out` (uploaded). Unnamed
  flows pool under `server_name: ""` per protocol so "netflix" recognised
  from IP ranges alone still adds up. LAN flows never create one. Cap
  `top_destinations_count` (default 500, negative disables).
- `GET /api/v1/protocols`: every protocol label with its default category
  (275 labels from nDPI 4.2 on this box: youtube=media, netflix=video,
  https=web, dns=network, ssh=remote-access, bittorrent=download).
- Tests: `internal/aggregator/destinations_test.go`, category slug test,
  and a `-tags ndpi` test that reads the real table.

**Backend** (`metrics-be`):
- `device_destination_buckets_hourly` (migration 033): PK (collector, mac,
  server_name, protocol, hour_start), `category` overwritten by the latest
  non-empty delta. Retention `DESTINATION_HOURLY_RETENTION_DAYS` (365).
- `protocol_categories` (migration 034): label → category lookup. The
  poller pulls each collector's `/api/v1/protocols` once an hour (404 on
  older collectors is silently retried next hour). A tiny static fallback
  covers port-mode labels. **Because it is a lookup and not a column, the
  existing protocol history is category-groupable back to day one.**
- Poller: `destinations` diffed like services → `writeDestinationBuckets`.
- Read API: `GET /api/v1/destinations` (top names, registered-domain
  groups with their member names, category split),
  `GET /api/v1/devices/:mac/destinations`, `GET
  /api/v1/destinations/:serverName/traffic` (1h/1d). Every protocol
  breakdown entry (`/api/v1/protocols`, `/devices/:mac/protocols`,
  `/devices/:mac/overview`) now carries `category`.
- `registeredDomain()` folds `rr4---sn-….googlevideo.com` onto
  `googlevideo.com` (two labels, three under `co.uk`-style ccTLDs; no
  public-suffix list shipped on purpose).
- Suite: 149 passed (8 new).

**Dashboard** (`metricsfe`):
- "Top destinations" panel: **Sites | Networks** toggle (Sites default:
  domain groups with a category chip; Networks = the ASN view).
- Traffic page: Destinations panel (domains → names → per-name history
  chart), Applications panel (category share bars), **Group by:
  Protocol | Category** on the protocol mix + stacked chart, two new KPI
  tiles (Top site, Top application).
- Device page: Destinations panel (category chip, down/up, share, click
  for history) and the same group-by toggle.
- `lib/categories.ts`: stable colour per category (status colours for
  malware / mining / gambling / adult-content / advertisement / crypto).

**Rollout state:** API + dashboard live. The collector binary with
destinations is staged at `go-collector/out/go-collector`; the *old*
process is still running (destinations empty, categories on the static
fallback) until `sudo setcap` + `pm2 restart metricslite-collector`.

## Usage overview, vnstat style (2026-09-18)

`GET /api/v1/usage?period=day|week|month&range=30d|from&to&scope=all|wan|lan&protocols=6`
(`app/services/usage_history.ts`, `usage_controller.ts`). One row per
**local** day / ISO week / month in the window, empty periods included:
down / up / total, average rate over the covered seconds, distinct active
devices, Wi-Fi clients average + peak (+ the peak slot) from
`wifi_client_totals`, and the top N protocols with their category plus an
"other" remainder. `totals` covers the whole window (devices are distinct,
not summed). The running bucket is `partial` and rated on elapsed time.

Alignment: buckets follow `system_settings.timezone` (UTC+8 here).
The fold happens in SQL with the zone offset at the window midpoint, so
every query is one indexed range scan on the hourly rollups (daily rollups
beyond 120 days). On a DST change the boundary hour can land one bucket
over; this zone has no DST. Live timings: 7 days daily 60 ms, 12 months
monthly 150 ms, cold.

First live numbers, today so far: 8.95 GB down, 36.54 GB up, 42 active
devices, Wi-Fi 21.8 avg / 25 peak, BitTorrent 68.8% of bytes — the box is a
seeder.

Suite: 153 passed (4 new).

**Dashboard**: new **Usage** page (`/usage`, sidebar after Traffic) with
Daily | Weekly | Monthly, range presets per period + custom dates, All |
WAN | LAN, six KPI tiles for the window, a stacked down/up column chart
(running bucket faded, "so far" in the tooltip), the vnstat table newest
first (label, down, up, total, avg rate, devices, Wi-Fi avg / peak, a
per-protocol segment bar with "+N other" and a popover), a totals footer,
and an "Applications in this window" panel. Period / range / scope live in
the URL. The dashboard KPI row gained a **Month to date** tile (total,
↓/↑ split, "N % of last month") that links to the page. Bucket labels are
formatted from the API label, never from the UTC `bucketStart`, so a
browser in another zone never shifts a day.

## Follow-ups: server spikes, hourly breakdown, applications mode (2026-09-19)

- **5-minute services tier.** An hourly average rate is just the byte bar
  rescaled, so it cannot show a spike. `device_service_buckets_5m`
  (migration 035) is written from the same poller deltas as the hourly
  table, kept 14 days (`SERVICE_5M_RETENTION_DAYS`). `GET
  /api/v1/services/:name/traffic` takes `resolution=5m|1h|1d`; auto picks
  5 m up to two days, `5m` is honoured up to three days and only inside
  retention, otherwise the answer says `1h`. The chart overlays a Mbps
  line per series on a right axis.
- **Usage intervals.** `GET /api/v1/usage/intervals?range=7d&interval=auto|1h|4h|8h|12h`:
  sub-day slots aligned to local midnight (auto 1 h ≤ 7 d, 4 h ≤ 14 d,
  8 h ≤ 30 d, else 12 h), from the hourly rollups, same fixed-offset fold
  in SQL and JS. Shown under the Daily view of the Usage page.
- **Categories per bucket.** `/api/v1/usage` buckets and totals carry
  `categories[]` folded from *all* protocol rows (the `protocols[]` list is
  still top-N). Drives the chart's Applications mode: two bars per bucket
  (download, upload), each stacked by category.

Suite: 155 passed.

**Dashboard**: Servers detail chart has a Rate toggle (dashed Mbps line per
series on a right axis, on by default) and reads the returned resolution
for its caption, with a note when 5-minute detail has aged out. The
destinations history chart has the same toggle, off by default. The Usage
page's Daily view gained an "Hourly breakdown" panel (Auto · 1h / 4h / 8h /
12h) and the main chart a **Down / Up | Applications** toggle
(`?mode=apps`): two columns per bucket, download then upload, each stacked
by category, with a legend and a per-category tooltip table.

## Birthday-day fixes + gateway conntrack (2026-09-19)

Reviewing the day with ~30 guest devices exposed two things, both fixed:

1. **Wi-Fi history overcounted at busy times.** `GET
   /api/v1/wifi/clients/history` summed per-(AP, band) distinct counts, so
   a phone roaming or switching band inside a slot counted twice (48 shown
   vs 29 real at 15:00). `total` is now the distinct count: network-wide
   from `wifi_client_totals`, per AP and on the raw 5 s / 15 s path from
   one extra `COUNT(DISTINCT mac)` per bucket. The per-part breakdown is
   unchanged (it is still the truth for the stacked chart).
   Test: `tests/functional/wifi/clients_history_distinct.spec.ts`.
2. **Unnamed HTTPS/QUIC (24% of destination bytes) is now attributed by
   network.** The collector keys unnamed flows of a name-carrying family
   (TLS / HTTP / QUIC — `Result.NameExpected`) by peer address under a
   separate cap (`top_unnamed_destinations_count`, default 100 per device;
   past it they pool), with `peer_ip` in the JSON. Families that never
   carry a name (BitTorrent, plain UDP) still pool. Backend: `peer_ip`
   joined the PK of `device_destination_buckets_hourly` (migration 036);
   the summary enriches the top 400 addresses per query through the
   existing Team-Cymru ASN cache and groups them as `a:<asn>` network
   groups ("Google LLC · AS15169") beside the `d:<domain>` and
   `p:<protocol>` groups. **Needs the collector restarted with setcap.**

**Gateway conntrack.** The edge router (192.168.0.1, Linux, not this box)
runs node_exporter on :9100 with the conntrack collector.
`app/tasks/scrape_router.task.ts` scrapes `ROUTER_METRICS_URL` every 30 s
into `router_samples` (migration 037): `node_nf_conntrack_entries` /
`_limit`, `node_netstat_Tcp_CurrEstab`, `node_load1`, memory, and the
`wan*` interface counters (auto-detected: wan0 + wan2 here; override with
`ROUTER_WAN_IFACES`) with the rate derived between samples. Retention
`ROUTER_SAMPLE_RETENTION_DAYS` (90). `GET /api/v1/router?range=24h`
returns `latest` (+ `conntrackPct`, `ageSeconds`, WAN Mbps) and a series
at 1 m / 5 m / 15 m / 1 h. First scrape: 4,708 of 262,144 entries (1.8%).

Suite: 162 passed (7 new).

**Dashboard**: destinations label network groups by organisation
("Google LLC", sub-line "network · AS15169 · N addresses") with the
addresses as members; the pool keeps "<Protocol> (unnamed)". The Traffic
page has a **Gateway** panel (Connections area + max line with "now / limit
/ %", WAN as the router sees it in red/green, and a stat strip: load,
established TCP, memory, conntrack, WAN interfaces, sample age). The
dashboard Health tile's sub-line shows "conntrack 4.7k / 262k · 1.8%" and
escalates to warning at 80% and critical at 95% fill.

## Per-AP throughput + top talkers over time (2026-09-19)

Two rate charts that answer "which radio is carrying the load" and "who is
eating the bandwidth right now", plus a direction fix they surfaced.

**`GET /api/v1/wifi/aps/throughput?range=24h&resolution=1m`**
(`app/services/wifi_ap_throughput.ts`). Per-AP client throughput from the
AP interface counters (`wifi_interface_buckets` and its 5 m / hourly /
daily tiers, same native-vs-rollup routing as the SSID history). Response:
`aps[]` (`id`, `name`, `friendlyName`, window `downloadBytes` /
`uploadBytes`; busiest first; every enabled AP is listed even when idle,
a disabled AP only while it still has history) and `buckets[]` with an
`aps` map keyed by AP id holding `downloadBytes`, `uploadBytes`,
`downloadMbps`, `uploadMbps`. The grain is coarsened to the ~2000-point
budget the device endpoints use (`30d` at `5s` reads the hourly tier) and
echoed back.

**Direction is in client terms, and it is the opposite of the counters.**
An AP's wlan interface *transmits* what stations download and *receives*
what they upload, so `download = bytes_out` and `upload = bytes_in`. Live
data confirms it: the 5 GHz SSIDs carry ~10× more `bytes_out` than
`bytes_in` (HomeNet on the Dynalink: 10.4 GB out / 0.8 GB in over a
day) and the 2.4 GHz camera SSID the reverse (28 GB in / 2.2 GB out, the
RTSP streams heading to the NVR). The SSID page had been labelling
`bytesIn` as "down"; fixed on the dashboard with this release (the SSID
API itself still returns the raw interface counters).

**`GET /api/v1/traffic/top?range=1h&resolution=15s&scope=all&limit=5&by=total`**
(`app/services/top_devices_history.ts`). The busiest N devices in the
window (1–10, ranked by `total` / `download` / `upload`) as separate rate
series, with every other device folded into one `rest` series. Two
statements: a per-MAC window SUM on the aggregate tier for the ranking and
legend totals, then a per-bucket SUM on the series tier where a `CASE`
folds every non-top MAC into `''`, so the row count is `buckets × (N + 1)`
however many devices exist. Names come from `device_identities` + the
hostname sources (`hostname`, `primaryIp` per device). Same grain clamping
and `scope` columns as `/traffic`; `bytesIn` is download to the device.

Tests: `tests/functional/wifi/ap_throughput.spec.ts` (both radios summed
per slot, idle/disabled AP listing, clamp, 422),
`tests/functional/devices/top_traffic.spec.ts` (ranking, rest fold, `by`,
`scope=wan`, empty window, limit cap).

Suite: 171 passed (9 new).

**Dashboard.** One shared `SeriesRateChart` (`components/charts/series-rate-chart.tsx`,
data shaping in `lib/rate-series.ts`) with two controls: Mode `Lines | Stacked`
and Direction `Down | Up | Both`. Lines draws download solid and upload dashed
per series; Stacked stacks the chosen direction and, for Both, mirrors upload
below the axis (`stackOffset="sign"`), with absolute Y ticks and per-direction
totals in the tooltip. Legends carry window totals (`41 GB ↓ · 12 GB ↑`).
- WiFi page: **Throughput per access point** under Client distribution
  (defaults Lines / Both; AP colours match the client-distribution chart;
  caption echoes the effective grain). The SSIDs table and the SSID page now
  read Down = `bytesOut`, Up = `bytesIn` (the fix above).
- Devices page: **Top talkers over time** above the table (defaults Stacked /
  Both, Top 5 | Top 10; ranking follows the direction control; scope follows
  the page toggle; "Others (N devices)" in the neutral series colour).
- All wifi history hooks now clamp a `1d` page grain to `1h` (the wifi
  ladder's top) instead of sending a value the API rejects.

## After the collector restart: attribution by network is live (2026-09-19)

The setcap'd collector came up at 19:22 local. Twenty minutes later 1,845 of
its 2,817 destination entries were keyed by peer address, 1,179 hourly rows
over 37 devices had landed, and the last-hour view attributed 17.6% of bytes
to network groups that used to be "https (unnamed)": ISP-A AS64496 1.8 GB,
Google, Microsoft, Apple, Amazon, ByteDance, Meta, Akamai, Roblox, Fastly.
Every one of the 25 network groups resolved to an organisation. Reviewing
that view exposed three defects, all fixed here:

1. **Failed ASN lookups collapsed into one "Unknown" group.** Cymru times
   out or has no entry for some prefixes (two ISP ranges, a Meta
   range). `enrichIp` cached those as `org = 'Unknown'` and the group key
   `a:${asn ?? org}` then merged every such address into a single
   "Unknown" row. An address with no resolved network now stands alone
   under `a:<ip>` (the dashboard titles it by the address). Cached failures
   are also retried after 24 h instead of being permanent (two of those
   rows dated from May).
2. **IP-literal server names posed as domains.** HTTP Hosts / SNIs such as
   `203.0.113.202` (0.37 GB) were `d:` groups. `registeredDomain` still
   returns them unchanged, but the summary now treats a literal as an
   addressed destination: enriched by ASN and merged into its network group.
3. **Mid-stream flows pooled by the collector.** The biggest unnamed chunk
   after the restart was 3.9 GB of "apple" from one phone (192.168.18.15,
   First Floor 5 GHz) to 17.248.163.121 — an iCloud upload that started
   before the restart, so nDPI never saw a ClientHello and guessed "Apple"
   by IP. `NameExpected` was false and the bytes pooled. The classifier now
   also treats TCP 80/443/8080/8443 and UDP 443 as name-carrying
   (`NameExpectedForPorts`), so a guessed-by-IP flow on those ports is keyed
   by its peer and lands in "Apple Inc. · AS714". **Rebuilt and staged;
   needs setcap + restart again.** Families without names (BitTorrent 3.2 GB
   this hour) keep pooling by design.

Tests: `destinations_api.spec.ts` (+2: lone failed addresses, literal
names) and `classifier_test.go` (`TestNameExpectedForPorts`).
Suite: 173 passed. After the deploy the last-hour view had no "Unknown"
group, three lone addresses, no literal domains, and network groups at
23.9% of bytes (17.6% before the fixes).

## Release prep: documentation pass (2026-09-19)

Getting the tree ready for a first git release, kept to what a reader needs:

- Root `README.md` rewritten for the shipped state (it still described the
  dashboard as the Vite starter): what it shows, how the parts fit, quick
  start, production (deploy.sh, pm2, the root-only steps), a one-paragraph
  data model, a docs index. Feature-roadmap prose moved out.
- New `metrics-be/README.md`: run and test, every env var with its default,
  the seven scheduler tasks and their cadence, ace commands, tables and the
  rollup/retention rules, the full REST API grouped by area, byte-direction
  conventions. `metricsfe/README.md` replaced the Vite boilerplate with pages,
  conventions and publishing. `go-collector/README.md` features and build
  sections brought up to date (nDPI, services, destinations, both build modes).
- The May-era proposals (`FEATURES.md`, `PROTOCOL_CLASSIFICATION.md`,
  `OPENWRT_WIFI_METRICS_PROPOSAL.md`, the node_exporter sample) moved to
  `docs/design/` as history; relative links fixed.
- Hygiene: root `.gitignore` for a monorepo; `metrics-be/.env.production` is
  now ignored with a sanitised `.env.production.example` beside it;
  `metricsfe/.env` (which carried the site's API URL) untracked and ignored.
  Site hostnames scrubbed from `deploy.sh`, the Apache proxy conf and
  `.env.example`. `go-collector/collector.yaml` stays tracked (gateway MACs,
  no key). This log and `docs/design/*` still contain local addresses and
  device names.
- Open: repository shape (one repo at the root vs the three existing
  component repos, each with one early commit) and a license.

## Device naming: custom names, types, tags, notes (2026-09-20)

A MAC with no DHCP lease read as `02:00:00:00:00:10` everywhere. Devices can
now carry an operator-supplied identity, and the dashboard prefers it over the
hostname wherever a device is named.

- New table `device_labels`: `name`, `device_type`, `tags` (JSON array),
  `notes`, `updated_by_user_id`. Keyed by **MAC alone**, unlike
  `device_identities` (collector, mac) — a name belongs to the thing on the
  network, and identity rows CASCADE when a collector is deleted, which would
  otherwise take the names with them.
- `app/services/device_labels.ts` owns the taxonomy (17 types, fixed so the UI
  can map each to an icon and so "filter by type" stays meaningful) and
  normalization: MACs lowercased, tags lowercased / whitespace-collapsed /
  deduplicated (max 12, 24 chars each). The whole table is cached in memory —
  one row per *named* device, and every device read path joins it — with a
  30 s TTL plus invalidate-on-write.
- API, open to any signed-in user (naming is an annotation, not configuration;
  gating it behind admin would leave operators with a dead Edit button):
  `GET devices/labels` (labels + tags in use + type catalog),
  `GET/PATCH/DELETE devices/:mac/label`. PATCH merges — an omitted field keeps
  its value, an explicit `null` clears it — and a label left with nothing in it
  is deleted rather than stored blank, so "clear every field" and "delete"
  converge.
- Labels are merged into `/devices`, `/devices/:mac/overview`,
  `/protocols/:protocol/devices`, `/traffic/top` (chart legend), `/services`,
  `/wifi/clients` and `/wifi/clients/:mac`. Each of those already resolved
  hostnames in one batched lookup; the label map rides along in the same
  `Promise.all`, so no read gained a round trip. Two per-row `await`s that
  predated the batched helper (`enrichIdentityRows`, the Wi-Fi client list)
  were folded into it while there.
- Dashboard: name / type / tags / notes editor on the device card,
  `deviceDisplayName()` in `src/lib/device-labels.ts` as the *single* place
  that chooses between custom name, hostname, IP and MAC (previously eight
  copies of the same `??` chain), type icons in the device tables, and device
  list filters by type and tag. Search — the page filter and the global
  search — now matches names, tags and notes, so "kids" or "garage" finds what
  you labelled that way.
- Tests: `tests/functional/devices/device_labels.spec.ts` (8) covers auth,
  operator writes, normalization, merge/clear semantics, the listing and the
  fields showing up on `/devices` and the overview. Suite 181 green.

Open: no bulk edit (one device at a time), and no "bytes by device type"
rollup yet — the type is stored and filterable, but nothing aggregates on it.
Vendor (OUI) lookup would still be the cheaper win for the long tail of
unnamed MACs.

## Brainstorm: what else to surface (2026-09-18)

Grouped by what it costs. "Free" means the data is already in MariaDB and
only the API/UI is missing; "collector" means a small change in
`go-collector` (the classifier already extracts most of it via nDPI).

### A. Free — presentation on data we already keep

1. **Servers page noise filter.** Toggle to hide bare-IP `http` names (the
   AP metrics scrapes) and group vhosts by registered domain
   (`*.example.com`). Optional "clients served" column once B.1 lands.
2. **Time-of-day heatmap.** Hour × weekday bytes for the whole network or
   one device, from the hourly rollup. Instantly shows backup windows,
   streaming evenings, an IoT device that phones home at 03:00.
3. **Monthly WAN usage vs. cap.** Daily rollup summed month-to-date, a
   projection to month end, optional ISP cap in `system_settings`. One tile.
4. **Top movers.** Devices whose traffic grew or shrank most vs. the
   previous period (daily/hourly rollups, `withComparison` already exists
   client-side). "Who is new in the top 10 this week?"
5. **New destination first seen.** From `device_peer_buckets_hourly`: a
   peer network this device has never talked to before. The cheapest
   anomaly signal there is for IoT.
6. **Band mix over time.** 2.4 / 5 / 6 GHz client share from the client
   distribution rollup (already grouped by band); shows whether band
   steering works.
7. **Roaming timeline.** Client moved AP events from `wifi_station_latest`
   take-overs / wifi events; "sticky client" list (weak signal but never
   roams).
8. **Instance health panel.** DB size by table, rows written/min, poll
   latency per collector, rollup lag, retention sweep results. The tune
   task and the poller already know most of it.
9. **CSV export** on every table, and a `?share=` read-only snapshot link.

### B. Collector change — small, high value

1. **Destinations by domain, not IP.** The classifier already has
   `host_server_name` for TLS/HTTP/QUIC; we only keep it for *local* servers
   (the Servers page). Keeping it on outbound WAN flows per (device, peer)
   turns "142.250.x.x 4.2 GB" into "youtube.com 4.2 GB". This is the single
   biggest "where is traffic going" upgrade and reuses the services
   pipeline almost verbatim. **Recommended first.**
2. **nDPI category.** `ndpi_get_proto_category` gives Streaming / Social /
   Cloud / VPN / Gaming / Advertisement / Malware etc. per flow. One extra
   field per protocol bucket → UniFi's "Traffic Identification" pie.
3. **nDPI risk flags.** Self-signed cert, obsolete TLS, DNS-over-HTTPS,
   Tor, suspicious DGA domain, known-malware ports. Count per (device,
   risk) → a "Risky flows" list. Cheap approximation of UniFi threat
   management without an IDS.
4. **TLS version / QUIC share.** Encryption posture tile ("2 devices still
   on TLS 1.0").
5. **Clients per served name.** Distinct client IPs (or MACs when local)
   per SNI, and for WAN-facing vhosts the source IPs, optionally
   GeoIP-bucketed by country with an offline MaxMind DB.
6. **Passive names.** mDNS, SSDP, DHCP hostname/vendor-class and NetBIOS
   are broadcast on the LAN the collector already sniffs; parse them and
   the "unknown MAC" problem mostly goes away (pairs with the OUI lookup).
7. **TCP handshake RTT per peer.** SYN→SYN/ACK timing from the flow table:
   "how far is that destination", a WAN latency chart per ISP path.

### C. Bigger

1. **Alerts** in the scheduler (new device, device offline, collector down,
   weak signal, counter-reset dropped, risky flow) with a dashboard inbox.
2. **SSE for the "now" tiles** so the 5 s polling loop goes away.
3. **Sankey / flow map:** devices → categories → destinations for a window.
4. **Per-VLAN breakdown** if the capture interface sees 802.1Q tags.
5. **Multi-site**: collector = site, site switcher in the sidebar.

Suggested order: B.1 → A.1 → B.2 → A.2 → A.3 → C.1.

## Next

1. Domain-named WAN destinations (B.1 above).
2. Servers page noise filter + domain grouping (A.1).
3. nDPI categories (B.2), then alerts (C.1).
4. Expose `site_name` on `/api/v1/account/profile` (or a `/api/v1/instance`
   read) for the sidebar.
5. Vendor (OUI) lookup + passive mDNS/DHCP names for MACs without a hostname
   (device naming, 2026-09-20, covers the ones you name by hand; this is the
   automatic half).
6. Aggregate traffic by device type now that the type is stored ("what share
   of the WAN is IoT?"), and bulk labelling from the device list.

## Release prep: scrub pass + CLAUDE.md (2026-09-21)

Everything site-specific that would have shipped with a public push is now a
placeholder. What was found, and where:

- **Docs**: this log (domain, gateway address, a device address, one client MAC,
  ISP names, one public peer), `docs/design/*` (AP addresses, AP hostnames, SSIDs,
  AP BSSIDs and client MACs in the raw node_exporter sample, the PC hostname and
  an SSH key path), `go-collector/CONFIG.md` (real gateway MACs as examples).
- **Config**: `go-collector/collector.yaml` was tracked with the live gateway
  MACs. It is git-ignored now; `collector.example.yaml` is the tracked template
  with `gateway_macs: []` and the two-upstream layout as a comment. The running
  collector still reads `collector.yaml` in place, nothing to restart.
- **Code**: Go and Japa fixtures used the real gateway MAC and the real subnet;
  two dashboard settings pages had the gateway and an AP as form defaults.
  `metrics-be/import-vnstat.ts` (one-off backfill) had the database password,
  the database name and the WAN MAC hard-coded. It is `import_vnstat.ts` now,
  reads `DB_*` from the environment and takes `VNSTAT_WAN_MAC` / `VNSTAT_WAN_IP`.

Placeholders: `example.com`, `192.168.x.x` for the LAN (same last two octets, so
the narrative still reads), `203.0.113.x` for public peers, `02:00:00:…` MACs
(`aa:aa` block for BSSIDs, `bb:bb` for clients), `HomeNet*` SSIDs, `ap-first-floor`
/ `ap-second-floor` / `ap-garage` hostnames, `ISP-A AS64496`.

Verified after the rewrite: `go test` in port and nDPI modes, the 13 Japa specs
whose fixtures changed (89 tests), `npm run typecheck` and lint on the touched
files, and the dashboard build (published, bundle `index-Ck7ch1qk.js`).

History reset the same day: each repo is now a single "Initial commit" on
`main` (was `master`), authored as `capthndsme <nieoy@msn.com>`, identity pinned
in local git config. The old commits (which held the old `metricsfe/.env`, the
collector config with real MACs, the import script with the password and a
stale 6.9 MB collector binary at the repo root) are bundled outside the tree in
`~/metricslite-history-backup-2026-09-21/` and can be deleted. No remote was
ever configured, so nothing left this machine. The `Asia/Manila` fixture in `usage_api.spec.ts` stays; the tests depend on a
fixed UTC+8 zone.

`CLAUDE.md` at the root is the quick reference for the agent: layout, ground
rules, commands, the gotchas that keep recurring (byte direction, rollup tiers,
response wrapping), and the release plan.

## The API serves the dashboard; Docker for everything (2026-09-21)

The netpulse comparison made the point: features were never the problem,
the first ten minutes were. Five moving parts (collector, API, MariaDB, a
static file server, a reverse proxy) became three, and the three come up
with one command.

**Fold.** `metricsfe/` moved into `metrics-be/dashboard/` (its own
package.json, built by `npm run build:dashboard` straight into
`metrics-be/public/`, which `node ace build` copies into `build/public`).
`@adonisjs/static` serves that directory ahead of the router with immutable
caching for the hashed `assets/` and `no-cache` for everything else; a
catch-all route registered *after* every API group returns `index.html` for
non-API paths and keeps the JSON 404 for unknown `/api/*` (registration
order matters: the wildcard placed first swallowed `/api/v1/setup/status`,
which the wizard spec caught). The dashboard's API base is now empty
(same origin); `VITE_API_URL` remains as an override for a split hosting,
and `npm run dev:dashboard` proxies `/api` to :3333 so development is
same-origin too. Lint and TypeScript boundaries keep the two projects apart
inside one repo (`dashboard/**` and `public/**` ignored by the API's ESLint,
Prettier and tsconfig).

**Docker.** `metrics-be/Dockerfile` is a two-stage build (dashboard, API,
prod deps) on `node:22-bookworm-slim`, 358 MB, with `openssh-client` for AP
control and `tini`. The entrypoint generates `APP_KEY` once into the `/data`
volume, retries `migration:run --force` until MariaDB answers, then starts
the server. `docker-compose.yml` runs `mariadb:11` (random root password,
buffer pool as a flag), the server on :8080, and the collector image on the
host network with `NET_RAW`/`NET_ADMIN`; `docker-compose.build.yml` builds
both from source with the collector checkout next door. Two things remove
the last questions a newcomer would be asked: the collector auto-detects the
default-route interface when none is configured (new
`netutil.DetectDefaultInterface`, tests), and the server registers the
collector at boot from `COLLECTOR_URL` / `COLLECTOR_API_KEY`
(`providers/default_collector_provider.ts`, `#services/default_collector`,
tests), so the wizard only asks for the admin account and the site name.
The server reaches the host-network collector through
`host.docker.internal` (`extra_hosts: host-gateway`). GHCR workflows in both
repos build amd64 and arm64 images on push to `main` and `v*` tags; the
collector image (94 MB, Debian bookworm's `libndpi4.2`) is the fork's work.

Smoke test on this host, `up db server` only because the live collector owns
:9800: the API answered 8 s after the container started, `/`,
`/devices/…` and `/wifi` returned `index.html` with `no-cache`, the hashed
bundle came back `immutable`, `/api/v1/nope` stayed a JSON 404, the wizard
went admin → instance → `complete` with `hasCollector: true` from the
auto-registration (probe failed as expected, the row is kept so the poller
retries), and `/api/v1/devices` answered 200 with the new token. Torn down
with `down -v`.

**This host.** `deploy.sh --api` now builds dashboard + API, still rsyncs
`public/` to the legacy docroot while it exists (the copy needs
`VITE_API_URL` set to the API origin in `dashboard/.env`, which it is), and
prints a reminder to delete the pm2 static server once Apache proxies the
dashboard hostname to the API port; `docs/ops/apache-metricslite.conf` is
that one-vhost config, the docroot variant is kept as
`apache-dashboard-docroot.conf`. The `metricslite-fe` app is gone from
`ecosystem.config.cjs`.

Assumed, not yet true: the GHCR image names use the `capthndsme` owner and a
server repo called `metricslite`; nothing is published, so today the compose
file only works with the build override. The arm64 images are unverified
(no CI run yet). `import_vnstat.ts` and `tests/` ride along in `build/`
because the API's tsconfig compiles everything; harmless, untidy.

## Host-network compose and the live migration script (2026-09-21)

`docker-compose.host.yml` is the second deployment shape: server and
collector as containers on the host network, MariaDB and the reverse proxy
left as they are. It reads the same `.env` / `.env.production` the pm2
install used, so `PORT=12553` and `DB_HOST=127.0.0.1` carry over unchanged
and Apache needs no edit; `~/.ssh` is mounted read-only for AP control;
the collector mounts `../go-collector/collector.yaml` verbatim. Both compose
files rotate container logs (3 × 10 MB) and the image healthcheck follows
`PORT`. Images are pre-built locally under the GHCR names.

One thing does not survive the move: hostname enrichment here uses the `lxc`
transport (`lxc exec <container> -- cat /tmp/dhcp.leases`), which no
container can do. The gateway did not accept this machine's SSH key yet
(`Permission denied (publickey,password)`), so `migrate-to-docker.sh` at the
root adds the key to the container's `/etc/dropbear/authorized_keys` through
`lxc exec`, verifies `ssh root@<gateway>` in batch mode, flips the setting to
the SSH transport with a `JSON_SET` on `system_settings`, retires the three
pm2 apps, starts the host compose stack and prints the checks and the
rollback line. Handed to the user to run; the switch itself is a few seconds
of downtime between `pm2 delete` and the container answering.

**Executed 2026-09-21 (2026-09-20 21:24 UTC).** The script ran clean: key
added to the gateway's dropbear `authorized_keys`, setting flipped to SSH,
pm2 apps deleted, both containers up. Verified afterwards: server healthy,
boot log shows migrations, DB tuning, collector and Wi-Fi pollers baselined
and the scheduler running; the collector initialised nDPI, is capturing on
`br-lan` with the two gateway MACs from the mounted YAML and exports 275
categories; `device_traffic_buckets` and `wifi_station_snapshots` had rows 2 s
old and `router_samples` 7 s old; from inside the server container
`ssh root@<gateway>` reads 80 leases and `ssh root@<AP>` answers, so AP control
and hostname enrichment work through the mounted `~/.ssh`. pm2 no longer
lists any metricslite app; `deploy.sh` is now the pm2 path for other people.

**Check at +4.5 h (2026-09-21 01:55 UTC).** Both containers up since
21:24:52 UTC with zero restarts, server healthy, no OOM; server 146 MB RSS
and idle CPU, collector 35 MB at ~10 % of a core. Not a single warning or
error in either log (2 KB and 1 KB of log in total). Native traffic rows per
15 min stayed at ~3,000 rows / 32–38 MACs / 4–8 GB straight through the
switch; the 6 h traffic series at 5 min grain has 72 buckets and none empty,
the two buckets spanning the cutover carry 1.4 GB and 1.9 GB. Every table is
fresh: native and Wi-Fi tables 3 s, gateway 18 s, 5-minute tiers 88 s,
client totals 148 s, hourly tiers one completed hour behind. All three APs
report 0 s old snapshots (12 / 9 / 1 clients). Collector: 54 devices,
99.5 GB, 126.7 M packets on `br-lan`. MariaDB (still native; the switch never
touched it): 11 app connections, 4 GB buffer pool and flush mode 2 applied at
boot, 1.78 GB on disk. API timings with a fresh token: devices 90 ms,
traffic 13 ms, Wi-Fi overview 39 ms, destinations 450 ms, router 7 ms, usage
139 ms. Hostname enrichment over SSH is proven by 20 of 44 devices carrying a
DHCP hostname in a process that started fresh in the container. Nothing to
fix.

## Bundled database by default, bring-your-own as an option (2026-09-21)

Three compose shapes now, one file each, all sharing the same server and
collector definitions:

- `docker-compose.yml`: MariaDB bundled (the default). The server's database
  target is variable-driven (`METRICSLITE_DB_HOST` / `_PORT` / `_USER` /
  `_PASSWORD` / `_NAME`) and the bundled MariaDB is created from the same
  variables, with `MARIADB_AUTO_UPGRADE`, flush mode 2, a 256 MB redo log,
  UTC and a `METRICSLITE_DB_BUFFER_POOL` (512 MB default).
- `docker-compose.external-db.yml`: the same stack minus the `db` service,
  via `extends` plus `depends_on: !reset []` (Compose 5 inherits `depends_on`
  through `extends`, verified); `METRICSLITE_DB_HOST` is required.
- `docker-compose.host.yml`: host networking as before, plus an opt-in
  bundled MariaDB under profile `db` that serves exactly what `.env` points
  at (root with `DB_PASSWORD`, `DB_DATABASE`, published on
  `127.0.0.1:DB_PORT`), tuned like `docs/ops/mariadb-metricslite.cnf`.

Rehearsal of this host's own move (native MariaDB 11.8.6 → `mariadb:11`
11.8.9; the native instance holds only `hypermetrics` and `_test`): a
`--single-transaction` dump of the 1.8 GB database took 32 s and 121 MB
gzipped; the restore into the container (2 GB pool, port 3307 while native
keeps 3306) took 216 s with no errors, 42/42 tables, every stable table
matching row for row, collations preserved, `migration:status` all
completed. `migrate-db-to-docker.sh` at the root does the real thing: stop
the server (the collector keeps running), fresh dump, drop-and-restore, flip
`DB_PORT` in `.env` (backup kept), `up -d`, verify writes land, print the
rollback and the two follow-ups (retire native MariaDB with sudo, then give
the container a 4 GB pool). Expected data gap about 4.5 minutes. Handed to
the user.

**Database cutover, executed 2026-09-21 02:18–02:25 UTC.** Dump 18 s, restore
226 s, then my script failed at `up -d`: it had exported `.env` into the
shell (`set -a`) before calling compose, and exported `DB_PORT=3306` beat
the freshly edited file during interpolation, so the db container was
recreated bound to 3306 and collided with native MariaDB. The restored data
was safe in the volume; a plain `docker compose … --profile db up -d` from a
clean shell brought the db up on 3307 and the retrying server connected.
Total gap 6.5 min instead of 4.5. Script fixed (source without export). Rows
then landed in the container while native froze at the cutover count.

## The stack gets a private network (2026-09-21)

Asked whether MariaDB could stay internal to Docker: yes, and the same move
makes the collector private. `docker-compose.yml` now declares its own
network (`METRICSLITE_NET_SUBNET` 172.28.0.0/24, gateway 172.28.0.1), the
database publishes nothing and the server reaches it as `db`, and the
collector, still on the host network because it must see the LAN, listens on
the stack's gateway address only, which the LAN cannot route to. One `.env`
configures everything: it is the server's own `.env`, read by compose for
interpolation and passed in as `env_file`, with `HOST`, `PORT`, `DB_HOST` and
`DB_PORT` pinned for the container so the host-tooling values in the file
do not leak in. The bundled MariaDB runs as root with `DB_PASSWORD`.
`docker-compose.db-port.yml` is an add-on that publishes the database on
127.0.0.1 for tests and ace commands (`COMPOSE_FILE` in `.env`);
`docker-compose.external-db.yml` extends the same services minus the db.

This host switched at 02:30 UTC: `down` of the host-network stack, `up` of
the default one with six `.env` lines (bind 127.0.0.1:12553, br-lan, the two
gateway MACs, the ssh dir, the compose file list), 11 s until the API
answered. Verified: only 127.0.0.1:12553, 127.0.0.1:3307 and 172.28.0.1:9800
listen; the collector logs both gateway MACs and the private listen address;
the server reaches `/healthz` through the gateway; rows land; SSH to the
gateway works from the new container. Native MariaDB on :3306 is now unused
and can be disabled with sudo, after which the container pool goes to 4 GB.

**Follow-up, 02:36 UTC.** After the network switch the Wi-Fi poller was fine
but device traffic stopped: the `collectors` row still carried
`http://127.0.0.1:9800` from the original wizard run, reachable on the host
network but not from the private one, so the poller logged 23 "poll failed".
An `UPDATE` to `http://172.28.0.1:9800` restored polling within one cycle.
The address is now a moving part (it follows `METRICSLITE_NET_GATEWAY`), so
`ensureDefaultCollector` reconciles it: when `COLLECTOR_URL` is set and
exactly one collector exists at a different address, that row is moved to
the configured address (and given the key, if any) and the change is logged;
with several collectors nothing is touched. Tests cover create, skip, move
and the ambiguous case.

## OpenWrt package for the collector (2026-09-21)

`go-collector/openwrt/metricslite-collector/` is a feed package: a
`golang-package.mk` Makefile with an nDPI menuconfig option (default on,
`+libndpi` from the packages feed; off is the right call for MT7621), a UCI
config `/etc/config/metricslite-collector`, a uci-defaults script and a
procd init script. The init script renders UCI into the daemon's
`GOCOLLECTOR_*` environment (no YAML on the router): the capture device is
resolved from a UCI network (`lan` → `br-lan` or, on the gateway here,
`lan0`), the API listens on that network's address only, the gateway MAC
defaults to the capture device's own MAC because on the gateway every
LAN ↔ WAN frame carries it, the API key is generated on first start and
stored back into UCI, and an interface trigger restarts the daemon when the
LAN comes up. Two daemon changes came out of it: `GOCOLLECTOR_PROMISCUOUS`
and `GOCOLLECTOR_LOCAL_SUBNETS` env overrides, and a build-time `version`
reported by `/healthz` and every `meta` block (`-X main.version`).

Tested on the real gateway (the OpenWrt 23.05 x86_64 LXC): a static musl
build from an Alpine container, files pushed by hand, uci-defaults run,
service started through procd. First run found that busybox has no
`base64`, so no key was generated and the API answered without auth; key
generation now uses `/proc/sys/kernel/random/uuid` and the init script
refuses to start without a key. Second run: 32-char key, `401` without it,
`200` with it, `/healthz` open, bound to the LAN address only, capture on
`lan0` saw 17 devices and 80 k packets in 15 s, `stop` took 10 ms. Every
file was removed afterwards. Not done: a real SDK build (the feed's
libndpi is 5.0, the code targets 4.x), and the `PKG_HASH`/source URL wait
for the first tagged release under the final repo name.

## Collector management: design and review (2026-09-21)

An Opus agent read the code and wrote `docs/collector-management.md` (1,600
lines): discovery by collector → server announce with the pollable address
derived from the announce's TCP source, explicit adoption, one additive
migration (`instance_id`, `hostname`, `version`, `capture_interface`,
`source` manual/env/announced, `lifecycle` pending/adopted/dismissed,
`last_announce_at`, `announced_base_url`, `api_key_fingerprint`), a
management API under `/api/v1/settings/collectors`, and a Settings page
mirroring Wi-Fi sources. Reading the code turned up two real bugs on the
way: `setup_state` counts any collector row, so a pending announce would
mark a fresh install complete, and the poller re-dispatches a dead collector
every 5 s regardless of its interval. Review added the binding amendments:
`TRUST_PROXY` so the source-address rule survives a reverse proxy in the
Docker shape, a stable instance id for containers without a volume,
sequencing (all backend packages by one implementer because the test
database is shared; collector packages after the nDPI 5.0 port), and the
open-question calls (lifecycle values, `source='env'`, key in the announce,
switch on by default; selector and wizard candidates postponed; double
counting across two collectors is the owner's product call). Implementation
runs as backend and dashboard agents in parallel, each followed by an
independent review; the collector side follows the nDPI port.

## nDPI 5.0 only (2026-09-21)

The cgo binding targets nDPI 5.0 and nothing else; the owner chose one code
path over a jungle of version conditionals, so the Docker image now builds
libndpi 5.0 from source in its builder stage (Debian bookworm ships 4.2)
and ships `libndpi.so.5` next to the binary (103 MB, link-checked at build
time), and the OpenWrt package takes the feed's 5.0. The port, done by a
Fable agent in a fresh context: `ndpi_init_detection_module(NULL)`,
`ndpi_finalize_initialization` checked, the protocol bitmask call dropped
(everything is enabled by default in 5), a zeroed `ndpi_flow_input_info`
passed to `ndpi_detection_process_packet`, two-argument
`ndpi_detection_giveup` with `dpi.guess_on_giveup` defaults, the nested
`proto.proto.*` ids plus the new `state` machine (a flow is final on
CLASSIFIED or MONITORING, otherwise it gives up at the 20-packet cap, and a
PARTIAL match already yields the label and SNI), `ndpi_get_num_protocols`,
and pkg-config-only cgo flags so a non-system prefix works. `make build-ndpi`
refuses anything below 5.0 with a message that points at
`scripts/build-ndpi.sh [prefix]` and `NDPI_PREFIX=`, which is how a machine
with a distro 4.2 (this one) builds and tests. The startup line now names
the library: `nDPI 5.0.0-1-375f99e (api 15)`.

Reading the headers exposed a pre-existing bug: seven ids in
`ndpi_labels.go` matched neither 4.2 nor 5.0 (30 is DTLS, not FTP data, so
DTLS flows were labelled `ftp-data`; POP3S, SMTPS, IMAPS, NATS, iCloud and
iTunes were off too, and the "legacy MQTT" id was actually ICMP). The ids
now come from the header at compile time (`ndpi_ids.go`) and a test compares
every constant. Behaviour changes to expect on the dashboard: finer 5.0
categories (netflix → video, youtube → media, bittorrent → download, new
music/shopping/finance/news/AI), and TLS flows cost up to 20 cgo calls
instead of about 2 because nDPI 5 keeps refining after the ClientHello.
Tests pin SNI extraction, DNS, port guessing at giveup and the version.
An independent review of the cgo layer (race detector included) is running
before the live collector moves to the new image.

## Collector management: implementation and review rounds (2026-09-21)

Four implementers and four reviewers, each a fresh Opus context (the port
itself was Fable), all working from `docs/collector-management.md` and its
amendments:

- **Dashboard** (FE-1/2): types, hooks, `collectors-settings-page.tsx`
  (pending adoption, add/probe/edit/disable/remove, 409 → Disable, no key
  ever rendered), settings card and route. Review: one medium (a failed
  background poll replaced the whole page; now a banner over the last good
  list), lost success feedback after adopt/dismiss (lifted to page level),
  small state and ARIA items, and the discovery switch which the design had
  left without an endpoint; fixed by defining
  `GET/PATCH /api/v1/settings/collectors/discovery`.
- **Backend** (BE-1..4 + discovery + `TRUST_PROXY`): migration 0039, announce
  service with rate limits and pending cap, management API, chunked purge
  command, poller backoff, 45 tests (suite 232). The `proxy-addr` instruction
  in amendment A2 would not have booted as written (no types, no
  comma-separated form); the implementer compiled per token. Review confirmed
  the security properties and found: a recreated daemon could create a
  duplicate row at an address that already has one (now re-identification,
  amendment A6), the switch read ran before the rate limiter, and the compose
  default trusted the whole stack subnet instead of the gateway (A2
  narrowed). Fix round in progress with tests for each. Found on the way and
  fixed: `POST /settings/users` returned `{}` because `serialize` is async.
- **Collector** (GO-1..3): six config keys, `internal/announce` (server-driven
  pacing, backoff, `Retry-After`, one log line per state change), stable
  instance id, `meta.announce_status`, UCI options and README, 30 tests.
  Review found the A3 fallback never fired in the container case it was
  written for (the id file write succeeds into the ephemeral layer); the
  precedence is now explicit → file → derived from machine-id + MAC → random
  (A3 revised), plus a 120-char cap on server error text, 403/409 on the slow
  beat, no bogus error on shutdown, atomic 0600 id writes, IPv6 bracketing.
- **nDPI port**, two review passes: the first found finalized flows evicted
  mid-stream (timestamp never refreshed on the fast path), PARTIAL flows
  holding up to 3.3 KB of native state each, a cross-mutex race on flow
  entries, no giveup on eviction, and prefix builds without a RUNPATH; the
  fix round made the table the sole writer of `LastSeen`, bounded partial
  flows (`ndpi_partial_extra_packets`, default 4, wired as a config key
  afterwards), added an evicted flag with a clean lock order, giveup on every
  eviction, RUNPATH, a 24-packet cap and build-time id pins. The second pass
  verified all nine and caught the owner's own mistake: the new env override
  was nested inside the previous one and only worked when both were set;
  fixed with a test, plus an atomic for the tunable and an error instead of
  a silent clamp. TLS flows without a server name keep native state until
  nDPI settles them (13 packets); documented as the carve-out.

## Collector management: shipped and proven end to end (2026-09-21)

Server image rebuilt and rolled out (migration 0039 already applied,
`TRUST_PROXY=loopback,172.28.0.1` in the container, announce and discovery
endpoints answering); collector image on nDPI 5.0 with the announce loop
rolled out, poller re-baselined within a cycle. Then the real test: the
OpenWrt gateway (the x86 LXC) with the package files and a static build,
`server_url` pointed at the API hostname.

The first run found a real-world gap the design had deferred as open
question 4. The router's announces reached Apache from the **public** WAN
address. Not a general masquerade: fw4's NAT-reflection SNAT for the 80/443
port-forwards to this box is set to `reflection_src external`, and that rule
matches every connection routed through the gateway to this box's 443, the
gateway's own included (checked in `nft list chain inet fw4 srcnat_lan`).
So the source-address rule derived `http://<public-ip>:9800` while the daemon's own
claim (`announced_base_url`) was the right LAN address. Decision (amendment
A7): the rule stays, and editing the address of an announced collector flips
its `source` to `manual`, which announces never move; the response carries
`announced_address_taken_over` and the page says so. Also found on the way:
the API hostname resolves to the public IP inside the LAN and the hairpin
lands on the public-facing proxy (an HTML 404, and a different
certificate); a split-horizon entry on the router's dnsmasq is the fix, used
temporarily for the test and removed afterwards.

Second run, everything green: announce → pending (fingerprint on the card
equal to `sha256` of the router's UCI key), adopt (probe failed on the wrong
address as expected), address corrected (source manual, probe ok, 11
devices), polled by the container across the LAN (27 traffic buckets and 19
identities in 25 s, newest row 2 s old), re-announce after a restart
authenticated with the key and left the manual address alone, dismiss
cleared the key, `collectors:purge` removed 314 rows and the collector. A
rebuilt daemon re-identified the pending row and relearned its key on the
run before. The router was left exactly as found.

Suite: 259 server tests; collector: all packages including the nDPI build
with the race detector. Not done in this round, by decision: the collector
selector on the traffic pages (double counting across two collectors is the
owner's call), wizard candidates, mDNS, server → collector control.

## 2026-09-21 — Gateway becomes the vantage point; the box's collector is off

The two network findings from the end-to-end run were traced properly today
(read-only `nft` dump on the gateway). The "masquerade" was fw4's
NAT-reflection SNAT for the 80/443 port-forwards to this box: with
`reflection_src external` the generated rule matches every connection routed
through the gateway to this box's 443, the gateway's own included, and
rewrites the source to the WAN address. The DNS finding was separate, and
the router's dnsmasq had in fact kept serving my temporary `/etc/hosts` entry
from memory since 04:09 (it restarted then and never re-read the file after
the cleanup). Both are now real configuration on the gateway: the two
redirects use `reflection_src internal`, and `dhcp.@dnsmasq[0].address` has a
split-horizon entry for the API hostname. Verified: a request from the router
by name reaches Apache with source `192.168.1.1` (the router's LAN address), and LAN clients asking the
router resolve the API hostname to this box. Stock OpenWrt defaults
`reflection_src` to internal, so a stock router's announces derive the right
address without any edit.

The package then went on the gateway for good, with a static musl build that
links nDPI 5.0 (`scripts/build-static.sh`; the OpenWrt LXC has no SDK and no
`libndpi` package installed). It announced, showed up pending with
`base_url = announced_base_url = http://192.168.1.1:9800` (no take-over edit
needed any more), was adopted as `gateway` (#5), and within 25 s had 53
buckets and 20 identities; its protocol rows are nDPI names (bittorrent,
quic, google, youtube, discord, ...). The re-announce after adoption
authenticated with the UCI key. Service enabled at boot.

The box's own collector is switched off but not removed: new
`docker-compose.no-collector.yml` (added to `COMPOSE_FILE` here) puts the
bundled collector behind the `collector` profile and clears `COLLECTOR_URL`,
the `localhost` row (#1) is disabled under Settings → Collectors and keeps its
history, the container was stopped and removed, and the server was recreated
with the override (healthy after 8 s, no `default_collector` registration in
the boot log). Bringing it back: `docker compose --profile collector up -d
collector`, then re-enable the row.

Also seen in the Apache log while checking sources: a scanner's
`GET /.git/config` gets a 200 from the SPA catch-all (it is `index.html`, not
a repository). Harmless, noted for a possible 404-on-dotfiles rule later.

### Same day, 10:32 UTC — the old collector's history folded into the gateway

One collector row now carries everything since May: instead of rewriting the
old row's ~4 M child rows onto the gateway's id, the gateway's ~4,600 rows
(40 minutes) moved onto the old row and the old row took the gateway's
identity (name, address, key, instance id, source `announced`, lifecycle,
`last_status`); the gateway's own row was deleted. Server stopped for 23 s
around it (the poller's counter snapshots are per collector id and would
have diffed the gateway's counters against the box's). Collision rules, per
table kind: native 5 s buckets, the gateway's row wins inside the 55 s
overlap (133 traffic + 106 protocol rows of the box dropped); maintainer-
derived tiers (5m/hourly/daily for traffic and protocol) deleted for the
gateway and rebuilt with `node ace rollups:backfill --since=2026-09-21T10:00:00Z`
from the merged native rows; writer-filled additive tables
(`device_peer_buckets_hourly`, `device_destination_buckets_hourly`,
`device_service_buckets_5m/_hourly`) summed on collision, which double
counts the 55 s overlap inside those hours and nothing else; identities
kept the old row (same `id`, earlier `first_seen_at`) and took the gateway's
current `primary_ip`/`ips`; `device_top_peers` took the gateway's snapshot on
collision. Whole fold: 34 statements, 0.3 s. Undo: a mysqldump of every
touched row (both collectors, today's window, all identities and top peers,
the `collectors` table) sits in the session scratchpad
(`fold-backup-<timestamp>.sql`). Verified after restart: one row, `gateway`,
polled OK with 32 devices; 5-minute slots continuous from 10:00 through the
switch; the daemon needed nothing (it looks itself up by instance id).

Productised version, not built: `node ace collectors:merge --from=<id>
--into=<id>` implementing exactly these rules and choosing the cheaper
direction itself. Worth doing before anyone else replaces collector hardware.

### Same day, evening — `collectors:merge`, and a repair of the morning's hand fold

The hand fold became a command: `node ace collectors:merge --from=OLD
--into=NEW [--dry-run] [--overlap=replace|into|sum] [--grace=S]`
(`commands/merge_collectors.ts`, rules in `app/services/collector_merge.ts`,
13 tests in `tests/functional/collectors/merge.spec.ts`). One row remains
with NEW's identity; the side with more history keeps its row id. Collisions
follow the overlap: `replace` (automatic up to 15 min) keeps NEW's per-poll
traffic buckets and top-peer snapshot and adds every accumulated row; `into`
and `sum` must be chosen explicitly for longer overlaps. Rollups are rebuilt
from the tier below over the shared slots while that tier is within retention.
Safety: a registry of the 14 tables that reference `collectors`, checked
against `information_schema` (a new table or column makes it refuse), both
collectors disabled plus a grace period, one transaction retried whole on
deadlock, flags restored on failure, a first Ctrl-C held until the merge has
finished or been undone, and a refusal while this server's `COLLECTOR_URL`
would re-register the retired collector or take over the merged one.
Supporting refactors: `runRollupSpec` takes an optional transaction and
collector id; the tier-retention maths the prune uses is now
`bucketTierRetentionDays`; `isLockContentionError` moved to `db_errors.ts`.

An independent Opus review found no SQL that loses data but two real bugs,
both fixed: protocol rows are per minute (`PROTOCOL_NATIVE_GRAIN_SECONDS`),
so under `replace` they must add up like the other accumulators instead of
going to the target; and `BUCKET_RETENTION_DAYS` < 1 (pruning off) skipped
every native rebuild. Also fixed from the review: the COLLECTOR_URL takeover
above (it was only a warning), a 15 s minimum grace, the signal handling, and
an empty category never blanking the other side's.

Validation: 272 server tests pass. The morning's pre-fold backup was replayed
into the test database and merged by the command: all 6,390 native traffic
rows and every 5-minute slot matched the hand-folded live data exactly. The
only differences were the 106 per-minute protocol rows of 10:18 and 10:19,
where the hand fold had used target-wins and so dropped the old box's share
(about 168 MB down and 89 MB up of protocol attribution; traffic totals were
never affected). That was repaired on live: the 106 rows set to the merged
values in one checked transaction, then protocol 5m, hourly and daily rebuilt
for the affected slot, hour and day with `rollups:backfill`; all three agree
with the merged buckets. Pre-image dump in the session scratchpad
(`protocol-repair-preimage-<timestamp>.sql`).

Traps met on the way: `node ace migration:*` from the CLI regenerates the
tracked `database/schema.ts` from the target database, so resetting the empty
test database wiped it (restored by migrating again; now in CLAUDE.md); the
test database's tables are `utf8mb4_unicode_ci` while live's are
`utf8mb4_general_ci`, so cross-database comparisons need `COLLATE`; and this
MariaDB's mysqldump writes one row per line, so the morning's backup, which
held the 5-minute tables three times, had to be deduplicated by statement (it
now loads cleanly). Server image rebuilt and redeployed at 11:34 UTC; the
command runs as `docker compose exec server node ace collectors:merge ...`.

## 2026-09-21 — ap-controller: an agent on every access point, metrics pushed over WebSocket

A third repository, `../ap-controller`: a static Go binary per OpenWrt AP that
replaces `prometheus-node-exporter-lua-*` and bridges the AP to this server.
The agent opens no port. It joins once with a token from Settings → Wi-Fi
sources (`POST /api/v1/ap-agent/join`, credentials stored in the AP's
`/etc/config/ap-controller`), then holds `GET /api/v1/ap-agent/ws`
(JSON-RPC 2.0, subprotocol `metricslite-ap.v1`). The server sends
`agent.configure` first (interval = the row's `poll_interval_seconds`, 0 when
disabled, re-sent on edits) and the agent pushes `metrics.push` with the same
Prometheus text node_exporter-lua served, so `ingestWifiMetrics` (split out of
`pollWifiOnce`) treats a push exactly like a scrape, stamped with server time.
Kick, steer, locate and reboot go over RPC when `transport = 'agent'` and over
SSH otherwise; the endpoints did not change. Design and contract:
`docs/ap-controller.md`; wire format: `../ap-controller/PROTOCOL.md`.

Why WebSocket + JSON-RPC and not socket.io: the peer is a Go daemon, and a Go
Socket.IO v5 client would be the weak link; `ws` and `coder/websocket` are
dependency-free. Why push: the agent works behind NAT and nothing on the AP
listens.

Parity with the lua exporter was checked on the three real APs (binary run
read-only from /tmp, then deleted): WRX36 (ath11k, 24.10), RAX3000M (mt7981,
24.10) and Archer AX23 (MT7621, 25.12). `wifi_network_quality`, `_noise_dbm`,
`_bitrate` and `_signal_dbm` matched to the unit on every interface; the only
difference was one live bitrate sampled a moment apart. The agent replicates
iwinfo's incremental integer averaging of station signal and bitrate for that.
It also fills `wifi_station_{receive,transmit}_bytes_total`, which the lua
binding declares but never emitted, so `wifi_station_snapshots.tx_bytes` /
`rx_bytes` stop being NULL for agent APs.

End to end against a test-mode server on `hypermetrics_test` (port 13335,
never the live DB): the AX23 joined (`created`), got `agent.configure`, answered
`system.info` in 62 ms, pushed every 15 s (network, station and system
snapshots written, station bytes filled), took a live interval change to 5 s,
answered a ping in 3 ms, blinked all 9 LEDs for a 5 s locate and restored every
trigger (netdev LEDs kept their device binding), turned a kick and a steer of a
planted non-associated MAC into 404 `wifi_client_not_associated` (audited,
`via: agent`, nobody disconnected), and backed off with the right message after
"Forget agent" closed it with 4001.

Numbers: the MIPS binary is 7.8 MB (8.5 MB before dropping the optional HTTP
listener and `regexp`; net/http's server part alone was 0.46 MB), ~3 MB
compressed, ~8 MB RSS, 0.2 s CPU per full collection on MT7621. The OpenWrt
24.10 SDK builds the feed package (`ap-controller_0.1.0-r1_mipsel_24kc.ipk`,
2.4 MB) in 9 min including Go from source. Server suite: 339 tests (272 before).

The Go release matters more than our code: the same source is 6.9 MB on MIPS
with Go 1.23 (what OpenWrt 24.10's SDK used for the `.ipk`, which is also
cgo-linked against musl), 7.9 MB with 1.26 and 8.5 MB with 1.27 (json v1 on top
of json/v2, ML-DSA). `release.yml` pins Go 1.26.x, the older supported line,
until 1.26 leaves security support (Feb 2027). The 7.8 MB above was measured
with a local 1.26.0.

Also: `.env.test` now pins the functional test server to `127.0.0.1:13334`.
With `PORT=12553` inherited from `.env`, "localhost" could resolve to the live
container's published port.

Not deployed. Before APs can use it: the Apache vhost needs `upgrade=websocket`
on its `ProxyPass` (sudo), the server image needs a rebuild (migrations 040/041
are additive), and the agent repo needs a GitHub release, which the dashboard's
install commands download from.

### Same day, 13:20 UTC — controller first: collectors in the wizard; the stale docroot

The owner did not see Settings → Collectors: `metrics.home` is Apache's static
copy in `/var/www/metrics`, last refreshed by the retired `deploy.sh` at 05:09;
Docker deploys never touch it (the API hostname always had the page). The copy
was rebuilt and republished (`npm run build:dashboard`, which bakes in the API
origin from `dashboard/.env`, then `rsync -a --delete public/ /var/www/metrics/`).
The permanent fix, handed to the owner as a sudo `sed` (dry-run checked on
copies of the four vhost files), points `metrics.home` at 127.0.0.1:12553 like
the API hostname and adds `upgrade=websocket` to both, which the ap-controller
entry above needs for the agents' WebSocket.

Deployment order is controller first, then collectors and access points in any
order, so the wizard's collector step became optional (amendment A9 in
`docs/collector-management.md`). Backend: `setup_state` treats the step as done
when a collector is adopted or the new `setup_collectors_deferred` setting is
set; `POST /api/v1/setup/collector/skip` sets it; `GET
/api/v1/setup/collector/candidates` lists pending announcers and whether
discovery is on; `POST /api/v1/setup/collector/:id/adopt` runs the same
`adoptCollector` as Settings. Four wizard tests: skip opens the gated API; a
router that announced before setup is a candidate and adopting it completes
setup; the admin token is required; the three adopt refusals. Frontend (fork
agent, reviewed): the step polls discovered collectors every 5 s and shows
each one's polled and claimed address, interface, version, key fingerprint with
its check command, and an Adopt button; while none have announced it shows the
three `uci` commands with this controller's API origin, and warns when the page
is open on localhost, which a router cannot reach; add-by-address is collapsed
below; "Skip for now" finishes setup. The result card stays up after the first
adoption completes setup, with "Adopt another" while more are waiting. The
dashboard says "No collector yet" when nothing is adopted, and Settings shows a
pending badge on the Collectors row. States checked in headless Firefox against
a mocked API: waiting, candidates in light and dark, discovery off, adopted.

This redeploy (13:20 UTC) also shipped the ap-controller server side above:
migrations 040 and 041 are additive and ran on the live database; server
healthy, poller and rollups current, no errors. Server suite: 343 tests pass.

## 2026-09-21 — Perch: the collector dials in, the gateway reports itself, one agent kit

The project has a name: **Perch**. The API + dashboard is **Perch Network
Controller** (repository `perch-controller`), the capture daemon **Perch Network
Collector** (`perch-collector`, binary and OpenWrt package `perch-collector`), the
access point agent **Perch AP Daemon** (`perch-apd`), and the Go code both daemons
share is **perch-agentkit**. Design and wire contract: `docs/collector-agent.md`
(owner-approved, amendment B1 lists what the implementation settled beyond it).

**Why.** Two things were left over once the collector ran on the gateway. The
Gateway page still scraped the router's node_exporter, although the collector
now sits on the router and can read the same `/proc` files itself. And the
controller still polled the collector over HTTP, which needs a listening port on
the router, an address the controller can reach, and a NAT story (the morning's
fw4 reflection episode). The AP daemon had already shown the other way round:
the device dials out, the controller sets a push schedule, commands travel back
on the same socket.

**What shipped.**

- *Collector socket* (`GET /api/v1/collector-agent/ws`, subprotocol
  `perch-collector.v1`, JSON-RPC 2.0): the collector authenticates with its own
  API key plus `X-Perch-Instance-Id`, sends `collector.hello` (which runs the
  announce match table, so discovery, pending and adoption work exactly as
  before), gets `agent.configure` with the row's interval (0 while pending or
  disabled; re-sent on adopt, enable, edit), and pushes `collector.push`: the same
  summary + devices a poll fetched, compact JSON, permessage-deflate. The server
  ingests a push through the same code as a poll (`pollOnce` split into
  `fetchCollectorSnapshot` + `ingestCollectorSnapshot`, serialised per
  collector), stamped with receive time; too-early pushes are dropped and only
  the newest waits while one is ingested. `collector.status` stands in for the
  HTTP probe, `collector.protocols` for the hourly category pull. Rows carry
  `transport = 'poll' | 'agent'` (migration 042, `base_url` nullable); the poll
  task only takes `poll` rows, and whichever way the daemon last introduced
  itself sets it, so going back to polling needs no admin step. Polling stays
  for bare-metal boxes, the bundled Docker collector and older builds.
- *Gateway stats from the collector*: conntrack fill, established TCP (the
  router's own sockets, as node_exporter's `CurrEstab` was), load, memory and
  per-interface WAN counters, with the WAN interfaces taken from the default
  routes (or configured). They ride in every push (and in the pull API's
  summary); the server writes one `router_samples` row per 30 s per collector
  and computes the WAN rate per interface, so a link that appears or disappears
  cannot make a spike. The node_exporter scrape (`scrape_router.task.ts`,
  `ROUTER_METRICS_URL`, `ROUTER_WAN_IFACES`) is gone. `/api/v1/router` names its
  source collector instead of a URL, and the Gateway panel says who reports it.
- *One upgrade listener* (`agent_gateway.ts`) serves both device endpoints with
  one generic hub class (`agent_hub.ts`); the AP endpoint is unchanged apart from
  its subprotocol, now `perch-ap.v1`.
- *perch-agentkit* (`rpc`, `link`, `hoststat`): the JSON-RPC codec, one socket
  session (dial, ping, serve requests, route notifications, calls, raw pushes),
  the configure-driven push scheduler, backoff, the controller's error bodies,
  and typed `/proc` readers. The AP daemon now runs on it (its session loop,
  pusher and backoff moved out; load, memory, netdev and conntrack parse through
  `hoststat` with byte-identical exporter output), and so does the collector's
  new socket client. Tested on Go 1.26 and the 1.22 floor, with `-race`.
- *Rename*: modules, binaries, OpenWrt packages (`/etc/config/perch-collector`,
  `/etc/config/perch-apd`), images, `PERCH_*` compose knobs and
  `PERCH_COLLECTOR_*` collector variables (the old `GOCOLLECTOR_*` and
  `METRICSLITE_*` names are still read), and the dashboard's branding. The
  database, its tables and the server's own variables keep their names.

**Numbers.** One push of 40 devices is 794 KB of compact JSON (the HTTP API's
indented reply was 1.38 MB); Go's deflate at its fast setting put it on the wire
as about 164 KB against Node's `ws` in an interop run, 10–13 ms per push. Server
suite: 364 tests (343 before). New socket tests cover the upgrade refusals, the
hello, a compressed 150-device push, poll/push row parity and a switch from poll
to socket that counts nothing twice.

**Deployed (15:05 and 15:06 UTC).** Server first: migration 042 ran in under a
second; the old collector kept being polled (`transport = 'poll'`); the node_exporter
samples stopped at 15:05:10. This host's `.env` got `COMPOSE_PROJECT_NAME=metricslite`
(the compose files now default to `perch`; containers, volumes and the network keep
their names) and the six `METRICSLITE_*` knobs renamed to `PERCH_*`; `docker compose
config` rendered the same ports, volumes and network as before. Then the gateway:
`perch-collector` 0.2.0 (static musl + nDPI 5.0, 10.9 MB) installed next to the old
package, which is stopped and disabled but left in place for a rollback; its UCI
config carries the old key, instance id and server URL, with the API on loopback.
It connected through Apache, was recognised as collector #1 `gateway` (all history
kept), started pushing every 5 s, and row #1 flipped to `agent` on the hello.
Traffic buckets continued every 5 s across the switch at the same volumes (the
restart re-baselined each device once), the first gateway sample landed at
15:06:43 and the second 30 s later with a rate (1.3 Mbit/s down, 18.2 up; the last
node_exporter sample said 0.8 / 16.6), and 465 protocol categories synced over
the socket. No warnings or errors. The router still runs
`prometheus-node-exporter-lua`; Perch no longer reads it.

### Same day, evening — public repositories, first releases, a controller-only Docker default

The four repositories went public (MIT) once the deploy above was verified:
`perch-controller`, `perch-collector`, `perch-apd`, `perch-agentkit` (tag v0.1.0,
pinned in both daemons' `go.sum`; they build with `GOWORK=off` against it). Each
started as one initial commit after a scrub of tree and history (the unpublished
pre-Perch commits were folded in; one still named the gateway's container). First
push: all CI green; both Docker images built for amd64 and arm64 and are pullable
anonymously from GHCR. Releases: `perch-apd` v0.1.0 (six static binaries,
`install.sh`, checksums; the dashboard's AP install commands resolve now) and
`perch-controller` v0.1.0 (pinned images, release notes). The collector's first
release waits for the OpenWrt package workflow (.ipk for 24.10, .apk for 25.12,
MIPS included), which a packaging agent is building.

The owner then made the Docker default the controller only (amendment B2 in
`docs/collector-agent.md`): `docker compose up -d` starts MariaDB and the server;
a collector on the Docker host is the `collector` profile and dials the server
over the host's loopback like any other collector, with an API key its image
entrypoint generates once and keeps (with the instance id) in the
`collector-data` volume. Checked: every compose variant renders as intended
(default, profile, external database, host network); the entrypoint generates
once (mode 600, 32 hex), reuses on restart, and stays out of the way for poll
transport, without a server URL or with a given key; this host's server was
recreated from the new default (only two empty `COLLECTOR_*` variables went
away) and the gateway collector reconnected within the same second.

### Same day, late evening (UTC) — a heap leak in the query cache; OpenWrt packages; v0.2.0

The server died once at 17:02 UTC with a JavaScript heap out of memory (2 GB, 70
minutes after the 15:52 recreate); Docker restarted it. The new push path was the
first suspect and was cleared: a three-minute sampling heap profile of the live
process (inspector opened with SIGUSR1 on the container's loopback) showed no
growth during pushes. A census of the process's Maps found `query_cache.ts` holding
599 entries; clearing them took the heap from 598 MB to 39 MB. The cache only
dropped an expired entry when that same key came back, and live dashboard keys move
with the clock, so an open dashboard added one result (up to ~1 MB) per chart
refresh until the heap ran out. The code predates Perch; today's new pages simply
kept a dashboard open long enough. Now: expired entries are swept at most every
30 s, and at most 150 results are kept, least recently used first out (two unit
tests; suite 366). Deployed 19:09 UTC; the gateway collector reconnected within a
second.

OpenWrt packages (a packaging agent, then reviewed): both daemons build with the
official SDK images, `.ipk` for 24.10.8 and `.apk` for 25.12.5, for mipsel_24kc
(MT7621), mips_24kc (ath79), aarch64_cortex-a53 (Filogic, IPQ807x),
arm_cortex-a7_neon-vfpv4 (IPQ40xx) and x86_64, versions pinned in each repo's
`openwrt/sdk.env`. The collector package builds nDPI 5.0 from the pinned tarball
and links it statically (depends on `libc` and `libpcap1` only). Verified before
release: x86_64 packages installed and started from UCI in 24.10 and 25.12 rootfs
containers; mipsel_24kc binaries ran under qemu-user (perch-apd `info`/`metrics`;
the collector up to opening the capture, which qemu cannot emulate). Sizes: the
collector is 3.5–4.2 MB as a package, 10.6–12.0 MB installed; perch-apd 2.3–2.9 MB,
7.0–7.8 MB installed. Findings for small routers, documented, defaults unchanged: a
full nDPI table at `ndpi_max_flows` 50000 is ~50 MB, so 128 MB routers want 10000 or
`classification 'port'`, which MT7621 / ath79 should start with anyway.

Releases: perch-apd v0.1.0 got its 10 packages via a manual run of the new workflow;
perch-collector v0.2.0 (10 packages, the static x86_64 binary, SHA256SUMS, images
0.2.0); perch-controller v0.2.0 (controller-only compose default, the cache bound).
Every workflow passed on its first run. A downloaded mipsel `.ipk` checked out
(MIPS32 binary, init, UCI config, uci-defaults; checksums match).

One cleanup mistake on this host: the packaging agent removed an exited container
that was not ours (`wonderful_meninsky`, untagged image, no compose project, exited
with an error ~19 h earlier) and a following image prune deleted its image. Running
containers were untouched.

## 2026-09-22 — The access points move to perch-apd; a performance snapshot

All three APs now push over the socket; nothing on this network is scraped any more.
WRX36 and RAX3000M (24.10, aarch64_cortex-a53) got the release `.ipk`, the Archer
AX23 (25.12, MT7621) the `.apk`, both checked against `openwrt-packages.sha256`. One
join token (three uses, three hours) served all three; every join came back `linked`
to its existing row (#2, #3, #4), so history is kept, and each row flipped to
`transport=agent` with 5 s pushes. The per-AP throughput series runs through the
three switch times without a gap or a spike, and an RPC `ping` over each socket
answers in 1–3 ms.

**What blocked the first attempt: DNS rebind protection on the APs.** OpenWrt's
dnsmasq drops upstream answers that point at private addresses. The gateway answers
the controller's name with its LAN address, so on the APs the name did not resolve
at all ("possible DNS-rebind attack" in the log). Fix on each AP: add the controller's
host name to `dhcp.@dnsmasq[0].rebind_domain` and reload dnsmasq. It lives in
`/etc/config/dhcp`, so it survives upgrades. This belongs in perch-apd's
troubleshooting notes; any setup with split-horizon DNS will hit it.

**Metric coverage.** The server reads 32 families from an AP; perch-apd emits all of
them. Expected throughput appears only where the driver reports it (mt76 on the AX23
does, ath11k on the WRX36 does not, and node_exporter behaved the same). A push
carries 82 families against the old scrape's 337: netstat and thermal are gone, and
the server reads neither.

**node_exporter removed.** First checked that nothing else read it: once Perch
stopped scraping, its process used 0.00 s of CPU in two minutes on every AP. The
one-liners in perch-apd's README and in the `join` hint do not work as written:
`opkg remove prometheus-node-exporter-lua --autoremove` and `apk del
prometheus-node-exporter-lua` both refuse while the collector sub-packages are
installed. What worked: `opkg remove` the `prometheus-node-exporter-lua-*` packages,
then `opkg remove --autoremove prometheus-node-exporter-lua` (luasocket and lua went as
orphans), or one `apk del` naming all of them (11 packages including lua and
uhttpd-mod-lua). Port 9100 is closed and LuCI still answers.

| | WRX36 | RAX3000M | AX23 |
|---|---|---|---|
| uhttpd's own CPU per scrape, NOT the exporter's (see below) | 5 ms | 19 ms | 23 ms |
| node_exporter bytes per scrape (plain HTTP) | 66 KB | 56 KB | 54 KB |
| perch-apd CPU per push (2 min window) | 12 ms | 17 ms | 100 ms |
| perch-apd bytes per push (TLS, uncompressed) | 35–37 KB | ~26 KB | 23 KB |
| perch-apd RSS | 13.0 MB | 12.9 MB | 14.0 MB |
| flash left | 47.8 MB | 77.7 MB | 4.2 MB (JFFS2; the binary took 3.1 MB) |

The node_exporter row undercounts: uhttpd runs a `-L` Lua handler in a child it forks
per request, and only the parent's CPU was counted (on the gateway, 10 scrapes: parent
6 ms, forked children 11 ms per scrape). The fair comparison is the exporters' own
`node_scrape_collector_duration_seconds` (perch-apd reports 28 / 8 / 10 ms of
collection on AX23 / WRX36 / RAX3000M), but no Lua scrape from the APs was saved
before the removal.

Why perch-apd costs ~100 ms per push on the AX23 (profiled with a throwaway harness
in the scratchpad that runs the push work from /tmp: the nine collectors,
`rpc.Notification`, a TLS 1.3 write, 60 pushes): about half is Go's runtime on a
32-bit MIPS rather than work. 64-bit atomics are emulated with locks (17% of samples
land in `_LostSIGPROFDuringAtomic64`), the scheduler spins across the four hardware
threads (15%), and GC and allocation take 17% (646 KB allocated per push, a GC every
1.7 pushes). The real work: collection 34% (nl80211 station dump 8%, per-channel
survey dump for the noise floor 7%), TLS with ChaCha20-Poly1305 in pure Go, and JSON
encoded twice (`rpc.Notification` marshals the params, then compacts them again as
a RawMessage). The Lua exporter does its netlink work in C (libiwinfo, libubus) and
writes plain text to plain HTTP. `GOMAXPROCS=1` took the harness from 92 to 62 ms of
CPU per push, and with `GOGC=200` 59 ms (GCs per 60 pushes 16 → 5, heap 2.4 → 4.9
MB). The atomic and scheduler shares dropped to 4% and 5%. Left after that: survey
14%, JSON 12%, stations 11%, TLS 10%. Candidates, not done: GOMAXPROCS=1 (and
GOGC=200) on 32-bit targets, caching the survey like the ubus status (30 s), and one
JSON pass (NotifyRaw with the text escaped once).

**AP pushes are uncompressed.** The server enables permessage-deflate only on the
collector endpoint, and perch-apd does not offer it. Deflate level 1 turns a push
into 3.4 KB (AX23) to 5.1 KB (WRX36), about 7× less, at some CPU cost on MIPS.

**How an AP keeps its configuration.** The join writes `agent_id` and `agent_secret`
to `/etc/config/perch-apd`, on the flash overlay, so reboots are a non-event. The
packages declare that file a conffile, so a package upgrade keeps it (the new default
lands beside it as `-opkg` / `.apk-new`). A firmware upgrade that keeps settings
keeps all of `/etc/config/` (base-files' keep.d; `sysupgrade -l` lists
`perch-apd` on all three), but not the package: reinstall it afterwards, and it
reconnects with the same credentials, no new join. owut/ASU cannot bake it in, since
it is not in the official feeds. The `/opt` install from `install.sh` writes
`/lib/upgrade/keep.d/perch-apd` so its binary, init script and rc.d links survive a
firmware upgrade, but that list does not name itself: it is gone after the first
upgrade and the daemon after the second. One missing line.

**Collector push at steady state.** The warm-up figure (14.6 KB per push, 23 kbit/s)
was nine times low. With 39 devices known, a push is 650 KB of compact JSON, 125 KB
after the socket's deflate (level 1), so about 216 kbit/s (~2.3 GB a day) from the
gateway to the server. 83% of it is `destinations`: every device's cumulative table
(3,466 entries), re-sent in full every 5 s. Two snapshots 5 s apart: 10 of 39 devices
changed at all, and a changed-entries-only push would be 28 KB deflated (~45
kbit/s). On the gateway the collector takes 5.8% of a core (capture and nDPI
included) with 44 MB RSS (54 MB peak). The server sat at 144 MiB 40 minutes after
the query-cache fix (136 MiB at deploy), using 4.8% of a core over a minute of
ingesting the collector and three APs.

**Footprint and TLS (question only, no code).** perch-apd for MIPS is 7.86 MB
stripped. A local build matches the release asset to the byte. `-tags
nethttpomithttp2` (a stock Go tag that leaves out net/http's bundled HTTP/2, which a
WebSocket client never uses) makes it 7.41 MB. Attributed by ELF section, the TLS
stack (crypto primitives with math/big, `crypto/tls`, certificates) is 1.4 MB of the
5.0 MB of code and data, roughly 2 MB of the file with its metadata. A build without
TLS would also have to drop net/http, which imports `crypto/tls` unconditionally,
and so replace the WebSocket client's handshake. Go 1.26's FIPS module also reserves
a 32 MiB zero-filled region (`crypto/internal/fips140/drbg.memory`), which costs
address space, not RAM.

## 2026-09-22 — perch-apd 0.1.1: one thread on 32-bit, one-pass pushes, compression

The owner approved, after the MIPS profile: the four open perch-apd fixes, one Go
thread on 32-bit CPUs, and encoding the push in one pass. Also proposed, not named,
so not done: caching the channel survey, and `GOGC=200`.

perch-apd 0.1.1 (tag `v0.1.1`; CI green on Go 1.22 and stable; ten OpenWrt packages;
release notes by hand):
- `GOMAXPROCS=1` when `strconv.IntSize == 32` and `GOMAXPROCS` is unset. The
  "starting" log line reports it.
- `metrics.push` params come from `pushParams`: one pass into a reused buffer, sent
  with `NotifyRaw`. The escaper matches encoding/json (invalid UTF-8 becomes U+FFFD,
  U+2028/2029 are escaped), checked by a table test, 2000 random inputs, a fuzz
  target (1.5 M inputs, clean) and a zero-allocation test. One of four fuzz runs
  failed without saving an input; a mismatch always saves one, so that was the
  fuzzing engine, and the reruns were clean.
- permessage-deflate is offered (the kit's option, no context takeover). A test
  counts the bytes the fake controller reads.
- The `/opt` install's keep.d list names itself and `/etc/config/perch-apd`.
- The node_exporter removal hint is per package manager. A name that doesn't
  resolve gets a DNS rebind hint, both in `describe()` (the daemon's log) and in
  the join output. README troubleshooting covers it.
- PROTOCOL.md documents the compression offer. Its examples had this setup's real
  AP hostname; they now use `ap-garage` (the v0.1.0 commit still has it).
- README (follow-up commit): apk upgrades need a restart, see below; the package
  architecture comes from `DISTRIB_ARCH`, because `apk --print-arch` prints only
  `mipsel` on 25.12.

Controller: the AP endpoint enables permessage-deflate with the collector's settings.
A functional test covers a compressed push; the suite has 367 tests. Deployed
20:45 UTC and pushed (image rebuilt), no tag.

Measured. Before tagging, a 0.1.1 build ran on the AX23 in place of the packaged
daemon for two minutes. After the upgrade, all three APs were measured together:

| | WRX36 | RAX3000M | AX23 |
|---|---|---|---|
| CPU per push, 0.1.0 → 0.1.1 | 12 → 14 ms | 17 → 19 ms | ~100 → 52 ms |
| bytes per push | ~35 → 5.8 KB | ~26 → 4.5 KB | 23 → 3.9 KB |
| RSS | 13.0 → 15.5 MB | 12.9 → 13.8 MB | 14.0 → 13.2 MB |

On the 64-bit APs, compression costs ~2 ms and the pooled 1.2 MB flate writer.
perch-apd's own collection time on the AX23 went 28 → 21 ms (29 in the latest
push).

Upgrades 21:01–21:03 UTC; credentials were kept everywhere. opkg restarted the
daemon itself, since the old package's prerm stops it. apk on 25.12 did not: its
post-upgrade only runs `start`, which is a no-op for a running procd service. The AX23
kept running the deleted 0.1.0 binary, and its flash fell to 1.2 MB with both copies
held. `/etc/init.d/perch-apd restart` fixed both (4.2 MB again). The proper fix is a
package postinst that restarts on upgrade; not done yet. RPC ping 1–3 ms on all three.
The throughput series shows no spikes at the upgrades.

Found during the controller deploy: `AgentGatewayProvider.ready()` attaches the
upgrade listener after the server listens. For about a second, WebSocket upgrades
reach the router and get `404 Cannot GET`, which perch-apd and the collector read as
"no support here" and back off for 5 minutes. The RAX3000M hit it: AP #3 went ~2 min
without data until I restarted its daemon. Not fixed. Proposal: answer 503 on the two
WebSocket paths until the gateway is attached (the devices then retry in seconds), or
attach before listen.

## 2026-09-22 — perch-apd 0.1.2, 503 on the agent paths, a forget race

**perch-apd 0.1.2** restarts the daemon after an apk upgrade. On 25.x, apk runs no
pre-upgrade stop, unlike opkg's prerm, and `default_postinst`'s `start` leaves a
running procd service alone. So 0.1.1 had kept running the deleted 0.1.0 binary.
The package's postinst now restarts a running daemon when `PKG_UPGRADE=1`. apk
inlines that after `default_postinst`. opkg sources it as `postinst-pkg` before its
start loop, when the daemon is already stopped, so it still starts only once. Tested
0.1.1 → 0.1.2 in throwaway `openwrt/rootfs` x86-64-25.12.4 (apk) and -24.10.8 (opkg)
containers, with packages from the SDKs: one restart onto the new binary each, and
fresh installs unaffected. The real upgrades (22:34–22:35 UTC) needed no manual step:
the AX23 came up on 0.1.2 by itself with 4.2 MB of flash left. The tag's OpenWrt
workflow failed once, on a 403 from GitHub's artifact storage after the x86_64 25.12
package had built; a rerun of that job published all ten packages.

**Agent WebSocket paths without the gateway.** The router now has routes for both
paths. They answer an upgrade that arrives before the gateway is attached with
`503 gateway_starting` + `Retry-After: 1`, and a plain GET with 426. Tests send
`Upgrade` without `Connection: upgrade`, which Node hands to the router even while
the gateway is attached. Deployed 22:18 UTC; the APs reconnected 2.4–3.6 s after the
new server listened. Their 503s that time came from the old server shutting down;
none landed in the new window.

**forgetAgent** closed the session before saving the row. The close handler marks
the row offline while `agent_id` matches, so under load it stamped "agent offline"
on the row the forget had just turned back into a scrape source. It showed up as
one failure in a suite run while two SDK builds kept the load near 27. It now saves
first. The collector's dismiss and delete already did it in that order. Suite: 371.

**Question from the owner: can agents connect to an IP address?** Both daemons
accept any http(s) URL, IPs included. The default Docker install serves plain HTTP
on :8080, and the dashboard builds its install commands from the address the admin
browses to, so default installs already run agents over `http://<ip>:8080`. The
risk is on the LAN: whoever can intercept traffic (ARP spoofing from a compromised
device, for example) reads the collector's per-device destinations and the AP
metrics, takes the agents' bearer secrets, and can pose as the controller to send
kick, locate and reboot to the APs. The collector only answers two read-only
requests. `tls_insecure` stops passive reading but not interception. The safe way
to connect by IP: the controller serves TLS itself with a self-signed certificate,
and the join token or install command carries its SHA-256 pin, as Docker Swarm join
tokens and kubeadm's `--discovery-token-ca-cert-hash` do. Not built; it touches the
controller, the kit and both daemons.

## 2026-09-22 — Plain HTTP documented, a management VLAN, dashboard warnings

The owner decided that plain HTTP is a documented way to run Perch: the default
install is `http://<host>:8080` for the dashboard and the agents alike. The docs
strongly recommend a management VLAN, and the dashboard warns.

- **Controller:** `transport_security.ts` decides, per agent session, whether it
  came in over TLS: a TLS socket, or a trusted proxy's `X-Forwarded-Proto`. A
  direct plain connection is false, and the header cannot fake it; a trusted proxy
  that sends no header is null, never a guess. The flag travels in the upgrade
  context and the hub's session info. The settings APIs return it as
  `agent.secure` (wifi-sources) and `connection.secure` (collectors), null while
  offline. A unit test covers the rules, forged header included; functional tests
  cover both endpoints. Suite: 377.
- **Dashboard** (fork, reviewed):
  - An "Unencrypted connection" notice above `http://` install commands (the AP
    join-token dialog, the setup wizard's router instructions).
  - An "Unencrypted" badge on APs and collectors whose live session is plain, and
    on active polled collectors with an `http://` base URL; nothing for null.
  - While the dashboard itself is on plain HTTP: a dismissible notice on the
    Settings pages (localStorage) and a line under the sign-in and setup forms.
  - The fork checked it in headless Firefox: light, dark and narrow.
- **Docs:** the controller README gains a "Plain HTTP and a management VLAN"
  section: what plain HTTP exposes; a VLAN whatever the transport; for the
  dashboard, browse from the VLAN or use HTTPS, because the VLAN protects the
  agents, not the admin's browser; HTTPS through a proxy that sends
  `X-Forwarded-Proto`; `tls_insecure` is no substitute. Also a note at the top of
  the compose file. The perch-apd and perch-collector docs now use
  `http://192.168.1.10:8080` as the example controller URL, with the same advice.
- **This box:** its Apache HTTPS vhosts send no `X-Forwarded-Proto`, so the
  controller builds `http://` install commands and every flag reads null (no false
  badges). The fix (sudo, the owner's): `RequestHeader set X-Forwarded-Proto
  "https"` after `ProxyPreserveHost On` in both `-le-ssl` vhosts, then a reload.
  Deployed 11:14 UTC; all four devices online, `secure` null for now.
