# Perch Network Controller

The controller of Perch, the home-network looking glass: an AdonisJS v7
application on MariaDB that also serves the dashboard
([`dashboard/`](dashboard/), Vite + React 19). One process does five jobs:
takes in traffic from the collectors (pushed over a WebSocket, or polled) and
Wi-Fi data from the access points, records the gateway stats the collector on
the router reports, maintains the rollup tiers and retention, serves the REST
API, and serves the built dashboard from `public/`. The scheduler and the
agent sessions run inside the HTTP process and the counter snapshots live in
memory, so run exactly one instance.

The other two parts of Perch are separate repositories: the **Perch Network
Collector** (`capthndsme/perch-collector`, packet capture + nDPI, OpenWrt
package) and the **Perch AP Daemon** (`capthndsme/perch-apd`, the agent on each
OpenWrt access point).

## Run with Docker

Three compose files, one per situation. All of them run the collector on the
host network with capture capabilities and pull the images from GHCR (or
build them with `docker-compose.build.yml` and the collector checkout next to
this one).

**Everything bundled** (default): MariaDB, server, collector.

```bash
curl -fsSLO https://raw.githubusercontent.com/capthndsme/perch-controller/main/docker-compose.yml
docker compose up -d          # http://<host>:8080 → create the admin account, done
```

One `.env` next to the compose file configures the whole stack; it is the
same file the server reads (`.env.example` lists everything). The knobs the
compose file adds are listed at its top: `PERCH_HTTP_PORT` (8080) and
`PERCH_HTTP_BIND`, `PERCH_CAPTURE_INTERFACE` (empty = default route),
`PERCH_GATEWAY_MACS`, `PERCH_DB_BUFFER_POOL` (512M), `PERCH_SSH_DIR` (a
`~/.ssh` for AP control and SSH hostname enrichment), `PERCH_NET_SUBNET` /
`_GATEWAY` (172.28.0.0/24, change on a clash), `DB_PASSWORD` / `DB_DATABASE`
(the bundled MariaDB is used as root). The compose project is named `perch`;
an install that started under another name pins it with
`COMPOSE_PROJECT_NAME` in `.env`, or its database volume would look empty.

Networking: the database has no published port and is reachable only inside
the stack's private network; the collector runs on the host network (it has
to see the LAN) but listens on that network's gateway address only, so
neither is exposed to the LAN. To reach the database from the host for
`npm test` or ace commands, add the loopback add-on:
`COMPOSE_FILE=docker-compose.yml:docker-compose.db-port.yml` in `.env`
publishes it on `127.0.0.1:DB_PORT`. The server generates and keeps `APP_KEY`
in the `server-data` volume unless `.env` provides one, runs migrations at
every start, and registers the collector so the wizard skips that step. Data
lives in the `db-data` volume.

**No bundled collector** (`docker-compose.no-collector.yml`): for a server whose
collectors run elsewhere, such as an OpenWrt router running the
`perch-collector` package (which dials in over a WebSocket, see below). Added to
`COMPOSE_FILE`, it puts the collector behind the `collector` profile and
registers no `COLLECTOR_URL` row at boot; `docker compose --profile collector
up -d collector` brings it back. A row the bundled collector created earlier
keeps its history: disable it under Settings → Collectors, do not delete it.

**Your own database**: same, minus the bundled MariaDB.

```bash
docker compose -f docker-compose.external-db.yml up -d
```

`PERCH_DB_HOST` is required (`PERCH_DB_PORT` defaults to 3306);
`DB_USER` / `DB_PASSWORD` / `DB_DATABASE` in `.env` name the account and
database, which must exist with full rights; the server creates the tables. A
MariaDB on the same host must listen beyond 127.0.0.1 for a container to reach
it (`PERCH_DB_HOST=host.docker.internal`), otherwise use the next option.

**Host network** (`docker-compose.host.yml`): server and collector share the
host's network stack, so an existing reverse proxy to `PORT` and a MariaDB on
127.0.0.1 keep working unchanged. It reads the same `.env` /
`.env.production` as the non-Docker install, mounts `~/.ssh` read-only for
AP control and SSH hostname enrichment (no `lxc` inside a container), and runs
the collector from `../go-collector/collector.yaml` (the perch-collector
checkout next to this one). Add `--profile db` to
also run a bundled MariaDB that serves exactly what `.env` points at
(`DB_DATABASE`, root with `DB_PASSWORD`, published on
`127.0.0.1:DB_PORT`); `PERCH_DB_BUFFER_POOL` sizes it.

```bash
docker compose -f docker-compose.host.yml up -d --build              # your MariaDB
docker compose -f docker-compose.host.yml --profile db up -d --build # bundled MariaDB
```

Moving an existing database into the bundled container is a
`mariadb-dump | mysql` into it, then `DB_PORT` in `.env`; a 1.8 GB database
took about half a minute to dump and a few minutes to restore.

## Run from source

```bash
cp .env.example .env          # DB_* credentials; APP_KEY: node ace generate:key
npm install && npm run install:dashboard
node ace migration:run
npm run build:dashboard       # dashboard → public/ (the API serves it)
npm run dev                   # http://localhost:3333, scheduler on
```

Dashboard development: `npm run dev:dashboard` starts Vite on :5173 with hot
reload and proxies `/api` to the API on :3333, so `VITE_API_URL` stays empty
(same origin). Set it only when the dashboard is hosted on another origin.

Tests run against a separate `<DB_DATABASE>_test` schema (`.env.test`) and
abort if the name does not end in `_test`. Create it once, then:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS hypermetrics_test"
npm test                      # Japa; migrations up per run, rolled back after
npm run lint && npm run typecheck && npm run lint:dashboard
node ace test --files=tests/functional/wifi/ap_throughput.spec.ts   # one file
```

Production without Docker: `../deploy.sh --api` builds the dashboard and the
API into `build/` (dashboard under `build/public`), writes `build/.env` (`.env`
+ `.env.production` overrides), runs migrations and reloads pm2. One Apache
vhost proxying to the API port is enough
([`docs/ops/apache-perch.conf`](docs/ops/apache-perch.conf)). Ace
commands run from `build/` in production.

## Collectors

The controller comes first; collectors and access points join afterwards, in
any order. The setup wizard's collector step is optional. It lists collectors that
have already announced themselves, for adoption with one click, next to the
add-by-address form. **Skip for now** finishes setup with none, and the
dashboard says so until one is adopted.

A controller takes traffic from one or more collectors, managed under Settings
→ Collectors (admin): add one by address, probe it, edit its name, interval
and API key, disable it, or remove it. A collector reaches the controller one
of two ways (`collectors.transport`):

- **Socket** (`agent`, the default for a collector with `server_url` and an
  API key, e.g. the OpenWrt package): the collector dials
  `/api/v1/collector-agent/ws` (JSON-RPC 2.0, subprotocol `perch-collector.v1`,
  its own API key as the bearer, permessage-deflate) and says
  `collector.hello`, which does what an announce does. The controller answers
  with the schedule (`agent.configure`: the row's interval, 0 while pending or
  disabled) and the collector pushes the same summary and device table a poll
  would fetch (`collector.push`), ingested exactly like a poll. Adoption takes
  effect at once, nothing on the collector's box has to listen, and the
  controller probes it (`collector.status`) and reads its protocol table
  (`collector.protocols`) over the same socket. Design and wire format:
  [`docs/collector-agent.md`](docs/collector-agent.md).
- **Polled** (`poll`): the controller fetches `/api/v1/summary` and
  `/api/v1/devices` from the collector's HTTP API every interval. Collectors
  added by address, the bundled Docker collector and collectors without a key
  work this way.

Rows get there two ways:

- **Manually**, with its base URL and API key (polled).
- **By announcing itself.** A polled collector configured with `server_url` posts to
  `POST /api/v1/collectors/announce` every minute; the server records it as
  *pending* with the address it actually came from, its hostname, version,
  capture interface and, unless the daemon was told not to send it, its API
  key (shown only as a fingerprint). Nothing is polled until an admin clicks
  **Adopt**; **Dismiss** hides it and clears the key. Announcing can be
  switched off on the same page. The endpoint is bounded (16 pending rows,
  12 announces per minute per address) and never returns a secret; after
  adoption, a collector must present its own key to update its record. A
  socket collector's hello goes through the same rules, and after adoption
  its key is what lets it connect at all.

The address the server polls is the one the announce arrived from. A
collector behind NAT (a router whose port-forward reflection rewrites its
own traffic, a reverse proxy) therefore shows up with the wrong address; the card
says "reached at X, says Y". Edit the address once: the row becomes
`manual` and announces keep updating its details without moving it again.

`COLLECTOR_URL` / `COLLECTOR_API_KEY` register the bundled collector at boot
and own that one row (`source=env`); the compose stack relies on it. Behind a
reverse proxy set `TRUST_PROXY` so the announce source address is the real one
(the compose file sets it to the stack subnet). Removing a collector that has
history is refused because every per-device table cascades on it; disable it
instead, or run `node ace collectors:purge --id=<id>` (with `--dry-run`
first), which deletes the history in chunks.

Replacing a collector (a router takes over from a capture box) is a merge, not
a purge: `node ace collectors:merge --from=<old> --into=<new> --dry-run`
prints the plan, the same without `--dry-run` does it. Afterwards one
collector remains with the new one's name, address and key, and the history
of both. The side with more rows keeps its row id, so the merged collector
may carry the old id. Where both recorded the same slot, the overlap rule
decides:

- `replace` is automatic when the two overlapped for 15 minutes or less. The
  new collector's 5-second traffic buckets win. Per-minute protocol rows and
  the 5-minute and hourly totals add up, because each collector recorded its
  own part of the slot.
- `into` means they ran side by side and saw the same traffic: the new
  collector's numbers win everywhere.
- `sum` means they saw different traffic, such as two segments: the numbers
  are added.

A longer overlap is refused until you pick one. The rollups are then rebuilt
from the tier below wherever that tier still has the rows. The command
disables both collectors while it works, runs in one transaction and restores
both on failure, and a first Ctrl-C waits for that. It refuses if the schema
has a table or column its registry does not know. It also refuses while this
server's `COLLECTOR_URL` would re-register the retired collector, or take over
the merged one, at the next start.

Gateway stats (conntrack, established TCP, load, memory, WAN rate) come from
the collector that runs on the router: it reads them from `/proc` and reports
them with its traffic (`gateway_stats`, on by default under OpenWrt), over the
socket or in the polled summary. The controller writes one `router_samples` row
per 30 s and names that collector on the Gateway page. Nothing else on the
router needs to run (no node_exporter).

## AP agents

Access points either get scraped over HTTP (a node_exporter `/metrics` URL,
Settings → Wi-Fi sources) or run the **Perch AP Daemon** (`perch-apd`, the
OpenWrt agent in `../ap-controller`). The daemon replaces
`prometheus-node-exporter-lua-*` and keeps a WebSocket session to this server,
so it needs no inbound port and gives the server a command channel without
SSH. Design and API contract: `docs/ap-controller.md`; wire protocol:
`PROTOCOL.md` in the perch-apd repository.

- An admin creates a **join token** under Settings → Wi-Fi sources (label,
  optional expiry and use limit). The dashboard shows the install command.
- The AP trades the token for its own credentials at
  `POST /api/v1/ap-agent/join` (unauthenticated, rate-limited like the
  collector announce). An AP already scraped today is recognised by its
  BSSIDs and switches over in place, same id, history intact; a reinstall
  gets fresh credentials on its old row.
- The agent then holds `/api/v1/ap-agent/ws` (JSON-RPC 2.0, subprotocol
  `perch-ap.v1`). The server sends it its schedule (`agent.configure`,
  the row's poll interval, 0 when disabled) and the agent pushes the same
  Prometheus text node_exporter serves (`metrics.push`), ingested exactly
  like a scrape (`transport = 'agent'` rows are never polled). Kick, steer,
  locate and reboot go to it instead of SSH. **Forget agent** revokes the
  credentials and puts the row back on HTTP scraping.

The sessions (AP daemons and socket collectors) are in-process state, like
the scheduler: one server instance. A reverse proxy must pass WebSocket
upgrades (`upgrade=websocket` on Apache's `ProxyPass`, see
`docs/ops/apache-perch.conf`).

## Environment

Validated in `start/env.ts`; templates in `.env.example` and
`.env.production.example`.

| Variable | Purpose | Default |
|---|---|---|
| `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`, `TZ` | HTTP server basics. Keep `TZ=UTC`; the instance timezone is a setting, not an env var. | `3333`, `localhost`, `development`, `info` |
| `APP_KEY` | Encryption key (collector API keys at rest, sessions). | required |
| `SESSION_DRIVER` | `cookie` / `memory` / `database`. | `cookie` |
| `CORS_ORIGIN` | Comma-separated allowlist. Dev allows every origin; production fails closed when unset. | unset |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE` | MariaDB connection. Session time zone is forced to UTC. | |
| `SCHEDULER_HTTP_SERVER` | Run the scheduler inside the HTTP process. | `true` |
| `LOCK_STORE` | `memory` (single process). | `memory` |
| `BUCKET_RETENTION_DAYS` | Native (~5 s) buckets. `0` disables the whole sweep. | `30` |
| `BUCKET_5M_RETENTION_DAYS`, `BUCKET_HOURLY_RETENTION_DAYS`, `BUCKET_DAILY_RETENTION_DAYS` | Rollup tiers. Each coarser tier lives at least as long as the finer one. | `730`, `730`, `1825` |
| `WIFI_SNAPSHOT_RETENTION_DAYS`, `WIFI_EVENT_RETENTION_DAYS` | Raw Wi-Fi snapshots, roaming events. | `14`, `90` |
| `PEER_HOURLY_RETENTION_DAYS` | Hourly peer (IP) history. | `90` |
| `SERVICE_HOURLY_RETENTION_DAYS`, `SERVICE_5M_RETENTION_DAYS` | Bytes served per server name. | `365`, `14` |
| `DESTINATION_HOURLY_RETENTION_DAYS` | Where bytes went, per name / address. | `365` |
| `ROUTER_SAMPLE_RETENTION_DAYS` | Gateway samples (reported by the collector on the router). | `90` |
| `BUCKET_MAX_DELTA_BYTES` | Drop a single poll delta above this instead of writing a spike (counter-reset guard). `0` disables. | `5000000000` |
| `DB_TUNE_BUFFER_POOL_BYTES`, `DB_TUNE_FLUSH_LOG_AT_TRX_COMMIT` | Applied with `SET GLOBAL` at boot and every 15 min. `0` / empty = leave alone. | off |
| `COLLECTOR_URL`, `COLLECTOR_API_KEY` | Register this collector at boot when none exists yet; the setup wizard then skips that step. The compose file sets it. | unset |

Collector endpoints, their API keys and poll intervals live in the
`collectors` table (setup wizard), Wi-Fi access points in `wifi_access_points`
(Settings → Wi-Fi sources), site name and timezone in `system_settings`.

## Scheduler tasks (`app/tasks/`)

| Task | Cadence | What it does |
|---|---|---|
| `poll_collectors` | every 5 s | Poll each enabled polled collector, diff counters against the in-memory snapshot, write native buckets, top peers, services, destinations, gateway samples; sync protocol categories hourly. Socket collectors push instead; the tick flags one that stopped pushing. |
| `poll_wifi_access_points` | every 5 s | Scrape each AP's node_exporter: station, network and system snapshots, `*_latest` tables, interface byte buckets, roaming events. |
| `rollup_buckets` | every minute | Maintain the 5-minute, hourly and daily rollups, Wi-Fi 5-minute rollups and distinct-client totals over a short lookback. |
| `recompute_client_distribution` | every 5 min | Concurrent clients per AP × band, plus the stored all-time peak. |
| `tune_database` | every 15 min | Re-apply `DB_TUNE_*`. |
| `prune_buckets` | daily 03:30 | Retention ladder above. |

Ace commands (`commands/`): `dev:token` (bearer token for curl),
`inspect:collector` (probe collectors, print top devices),
`buckets:prune [--dry-run]`, `rollups:backfill [--since=ISO] [--wifi-latest]`.

## Data model

- **Device traffic**: `device_traffic_buckets` (native, one row per device per
  poll, with WAN/LAN split columns) → `_5m` → `_hourly` → `_daily`. Same ladder
  for `device_protocol_buckets` (per nDPI label).
- **Peers**: `device_top_peers` (latest top-N WAN and LAN peers) and
  `device_peer_buckets_hourly` (history, enriched by ASN on read through
  `asn_cache`, Team Cymru DNS).
- **Services** (bytes this device *served*, per TLS SNI / HTTP Host):
  `device_service_buckets_hourly` and `_5m`.
- **Destinations** (bytes this device *sent to* a site): 
  `device_destination_buckets_hourly` keyed by (name, peer address, protocol)
  with the nDPI category; unnamed TLS/HTTP/QUIC flows carry the peer address
  so the read side can group them by network. `protocol_categories` is the
  label → category lookup synced from the collector.
- **Wi-Fi**: raw `wifi_station_snapshots`, `wifi_network_snapshots`,
  `ap_system_snapshots` (14 d), their `_5m` rollups, `wifi_station_latest` /
  `wifi_network_latest` / `ap_system_latest` (one row per key),
  `wifi_interface_buckets` (+ `_5m`, `_hourly`, `_daily`) for per-radio bytes,
  `wifi_client_totals` (distinct clients per slot) and
  `wifi_client_distribution` (per AP × band), `wifi_roaming_events`,
  `wifi_command_audits`.
- **Gateway**: `router_samples`, one row per 30 s from the collector on the
  router (conntrack, established TCP, load, memory, WAN counters and the rate
  derived per interface).
- **Identity**: `device_identities` (IPs seen per MAC), hostnames resolved at
  read time from the configured sources (Settings → Hostname enrichment), and
  `device_labels` — the operator's own name, device type, tags and notes for a
  MAC. Labels are keyed by MAC alone (not per collector) so they survive a
  collector being re-registered, are cached in memory and merged into every
  device read path; the UI prefers the operator's name over the hostname.

Read paths pick the coarsest rollup tier whose grain is no finer than the
requested resolution and whose span gate the window passes (5 m from 6 h,
hourly from 2 d, daily from 30 d), and coarsen the requested grain until the
window fits about 2000 points. Results are cached for a few seconds per
window segment (`app/services/query_cache.ts`) and served with ETags.

Byte direction: everything device-side (`bytesIn`) means *downloaded by the
device*. The Wi-Fi SSID endpoints return the AP interface counters unchanged,
where `bytesIn` is what the AP *received*, i.e. client upload;
`/wifi/aps/throughput` translates to client terms (`downloadBytes` /
`uploadBytes`).

## REST API

All routes are under `/api/v1`, return `{ data: ... }`, and (except setup and
login) need `Authorization: Bearer <token>` from `/auth/login`. Time windows
are `range=24h` (`s|m|h|d`) or `from=&to=` (ISO 8601); series take
`resolution=5s|15s|1m|5m|15m|1h|1d` and echo the grain actually used.
`scope=all|wan|lan` selects the byte columns. Rows marked *admin* need the
admin role. Full list: `node ace list:routes`.

| Area | Routes |
|---|---|
| Setup & auth | `GET setup/status`, `POST setup/admin`, `POST setup/instance` *admin*, `POST setup/collector` *admin*, `POST auth/login`, `POST auth/signup` (locked once an admin exists) |
| Account | `GET account/profile`, `PATCH account/password`, `POST account/logout` |
| Settings *admin* | `GET/PATCH settings/hostname-enrichment`; `GET/POST settings/wifi-sources`, `POST settings/wifi-sources/probe`, `PUT/DELETE settings/wifi-sources/:id`, `POST settings/wifi-sources/:id/probe`, `POST settings/wifi-sources/:id/agent/ping`, `DELETE settings/wifi-sources/:id/agent`; `GET/POST settings/ap-join-tokens`, `POST settings/ap-join-tokens/:id/reveal`, `DELETE settings/ap-join-tokens/:id`, `GET settings/ap-agent/install`; `GET/POST settings/users`, `PATCH settings/users/:id/role`, `DELETE settings/users/:id` |
| Device agents | `POST ap-agent/join` (join token in the body, no user auth), WebSocket `ap-agent/ws` (agent credentials); `POST collectors/announce` (polled collectors), WebSocket `collector-agent/ws` (the collector's API key + instance id) |
| Network-wide traffic | `GET traffic` (series + summary), `GET traffic/top?limit&by` (top-N devices + rest), `GET protocols`, `GET protocols/:protocol/devices`, `GET peers/top?scope` |
| Sites & applications | `GET destinations?limit` (names → domains, addresses → networks, categories), `GET destinations/:serverName/traffic`; `GET services?limit`, `GET services/:serverName/traffic` (5m/1h/1d) |
| Usage | `GET usage?period=day\|week\|month&scope&protocols`, `GET usage/intervals?interval=auto\|1h\|4h\|8h\|12h` |
| Gateway | `GET router?resolution=auto\|1m\|5m\|15m\|1h` |
| Devices | `GET devices`, `GET devices/:mac/overview`, `/traffic`, `/protocols`, `/peers`, `/peers/history`, `/services`, `/destinations` |
| Device labels | `GET devices/labels` (stored labels + tags in use + type catalog), `GET devices/:mac/label`, `PATCH devices/:mac/label` (merge; `null` clears a field), `DELETE devices/:mac/label` |
| Wi-Fi | `GET wifi/overview`, `wifi/ssids`, `wifi/ssids/:ssid/clients`, `wifi/ssids/:ssid/throughput`, `wifi/clients`, `wifi/clients/history`, `wifi/clients/:mac`, `wifi/clients/:mac/signal`, `wifi/rf`, `wifi/rf/history`, `wifi/aps`, `wifi/aps/throughput`, `wifi/aps/:id/health` |
| Wi-Fi actions *admin* | `POST wifi/clients/:mac/kick`, `POST wifi/clients/:mac/steer`, `POST wifi/aps/:id/reboot`, `POST wifi/aps/:id/locate` (through the AP's Perch AP Daemon, or SSH when two-way commands are enabled on a scraped source; `wifi/aps` reports which as `controls`) |

## Layout

```
app/controllers   HTTP handlers (thin; window/resolution parsing + serialisation)
app/services      query and ingestion logic: collector_poller, collector_agent (socket pushes),
                  agent_gateway + agent_hub (the two WebSocket endpoints), bucket_writer,
                  rollup_maintainer, bucket_retention, wifi_metrics_poller, wifi_bucket_writer,
                  destination_history, service_history, usage_history, router_metrics,
                  asn_enrichment, query_cache
app/tasks         scheduler tasks (auto-discovered, *.task.ts)
app/validators    Vine schemas for every query string
database/migrations
tests/functional  Japa suites per area
dashboard/        the React dashboard (own package.json; `npm run build:dashboard` → public/)
public/           built dashboard, git-ignored; copied into build/public by `node ace build`
docker/           container entrypoint (APP_KEY persistence, wait for DB, migrate)
docs/             looking-glass-status.md (development log), design docs (collector-agent.md,
                  collector-management.md, ap-controller.md), ops/ (Apache vhost, MariaDB cnf)
```

## License

MIT; see [LICENSE](LICENSE).
