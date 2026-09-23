# Perch: collector socket, gateway stats, shared agent kit (design, 2026-09-21)

Status: approved by the owner ("full-send") on 2026-09-21. This is the contract
the implementation follows; later changes go in as dated amendments at the end.

Three things ship together:

1. **Gateway stats from the collector.** The collector on the router reads
   conntrack, established TCP, load, memory and the WAN counters from `/proc`
   and reports them with its traffic data. The server's node_exporter scrape of
   the router (`ROUTER_METRICS_URL`, `scrape_router.task.ts`) is removed.
2. **The collector dials the controller over a WebSocket**, the way the AP
   daemon already does: JSON-RPC 2.0, pushes on a schedule the server sets,
   commands from the server on the same socket. Nothing on the router has to
   listen. Polling stays as a second transport (bare-metal boxes, the bundled
   Docker collector, older collectors).
3. **A shared Go module, `perch-agentkit`**, holds what both daemons need: the
   JSON-RPC codec, the socket session (dial, ping, read loop, calls, push
   schedule, backoff, TLS client) and typed `/proc` readers.

And the project gets its name: **Perch**.

Decisions taken with the owner: the node_exporter scrape goes away entirely
(no fallback); a collector's own API key authenticates its socket and discovery
(announce → pending → adopt) keeps working as it does, with the socket's first
message replacing the HTTP announce; polling stays as a second transport.

## 1. Names

| Was | Now | Repository | Go module / package |
|---|---|---|---|
| metricslite | **Perch** | | |
| `metrics-be` (API + dashboard) | **Perch Network Controller** | `capthndsme/perch-controller` | npm `perch-controller`, image `ghcr.io/capthndsme/perch-controller` |
| `go-collector` | **Perch Network Collector** | `capthndsme/perch-collector` | `github.com/capthndsme/perch-collector`, binary `perch-collector`, OpenWrt package `perch-collector`, image `ghcr.io/capthndsme/perch-collector` |
| `ap-controller` | **Perch AP Daemon** | `capthndsme/perch-apd` | `github.com/capthndsme/perch-apd`, binary `perch-apd`, OpenWrt package `perch-apd` |
| (new) | Perch agent kit | `capthndsme/perch-agentkit` | `github.com/capthndsme/perch-agentkit` |

Local checkouts keep their directory names (`go-collector/`, `metrics-be/`,
`ap-controller/`, plus `perch-agentkit/`) so paths, scripts and sessions do not
break; a root `go.work` makes local builds use the local kit.

Compatibility rules (nothing is released yet, so only what this host runs is
protected):

- Collector environment: `PERCH_COLLECTOR_*`. `GOCOLLECTOR_*` is still read when
  the new name is unset, with one deprecation log line per variable.
- Collector default `instance_id_file`: `/var/lib/perch-collector/instance-id`;
  when it does not exist and `/var/lib/go-collector/instance-id` does, the old
  file is read (identity survives an upgrade on bare metal).
- UCI: `/etc/config/perch-collector` and `/etc/config/perch-apd`. No automatic
  migration from the old config names (the one gateway is migrated by hand).
- WebSocket subprotocols: `perch-ap.v1` (renamed; no AP runs the daemon yet) and
  `perch-collector.v1` (new). `metricslite-ap.v1` is not accepted any more.
- Server environment keeps its names (`COLLECTOR_URL`, `AP_AGENT_RELEASE_URL`,
  …). Compose/entrypoint knobs `METRICSLITE_*` become `PERCH_*`; the entrypoint
  still reads `METRICSLITE_DATA_DIR` / `METRICSLITE_DB_WAIT_ATTEMPTS` when the new
  name is unset. Compose files switch to `PERCH_*` outright (this host's `.env`
  is edited at deploy time).
- Compose project `name: perch`. This host pins `COMPOSE_PROJECT_NAME=metricslite`
  in its `.env` so the existing containers and the database volume keep their
  names. Database name, user and tables do not change.
- `AP_AGENT_RELEASE_URL` default becomes
  `https://github.com/capthndsme/perch-apd/releases/latest/download`.
- User agents: `perch-collector/<version>`, `perch-apd/<version>`.

## 2. perch-agentkit

Module `github.com/capthndsme/perch-agentkit`, `go 1.22` (the OpenWrt SDK floor),
one dependency (`github.com/coder/websocket v1.8.13`), MIT. Owned by the lead;
daemon work treats it as read-only and reports gaps instead of editing it.

### 2.1 `rpc`

`ap-controller/internal/rpc` moved as is: `Message`, `Error`, `Errorf`,
`Handler`, `Dispatcher` (`NewDispatcher`, `Register`, `Methods`, `Serve`),
`Decode`, `Notification`, `Params`, error codes. Adds `Request(id int64, method
string, params any) ([]byte, error)`.

### 2.2 `link`

```go
// TLS + HTTP/1.1 client for joins, announces and the WebSocket handshake.
type TLSOptions struct { Insecure bool; CAFile string }
func NewHTTPClient(o TLSOptions) (*http.Client, error)
func Endpoint(base, path string) string                 // base without trailing slash + path
func WebSocketURL(base, path string) (string, error)    // http→ws, https→wss

// A refused upgrade or a non-2xx answer.
type StatusError struct { Status int; Code, Message string; RetryAfter time.Duration }
func ReadStatusError(resp *http.Response) *StatusError  // parses {error, message, errors[], retryAfterSeconds} + Retry-After
func RetryAfter(resp *http.Response) time.Duration

// Reconnect backoff, doubling from Min to Max with ±10 % jitter.
type Backoff struct { Min, Max time.Duration }
func (b *Backoff) Next() time.Duration
func (b *Backoff) Reset()

// Close codes shared by both protocols.
const (
    CloseRevoked   websocket.StatusCode = 4001 // credentials no longer valid
    CloseReplaced  websocket.StatusCode = 4002 // a newer session took over
    CloseDismissed websocket.StatusCode = 4003 // collector dismissed by an admin
)

type Options struct {
    URL, Subprotocol string
    Header     http.Header
    HTTPClient *http.Client
    Compression bool            // offer permessage-deflate (no context takeover)
    ReadLimit   int64           // default 4 MiB
    Log         *slog.Logger
    Dispatcher  *rpc.Dispatcher // server → agent requests; nil = -32601 for all
    OnNotification func(ctx context.Context, s *Session, m *rpc.Message) // frame order, read goroutine
    OnOpen      func(ctx context.Context, s *Session) // own goroutine once reading started; ctx ends with the session
    DialTimeout, PingInterval, PingTimeout, WriteTimeout time.Duration // 20 s, 30 s, 10 s, 10 s
    MaxInFlight int // concurrent server requests, default 4
}

// Run dials once and serves the session until it ends. nil when ctx is done
// (after a 1001 close), *StatusError when the upgrade was refused, otherwise
// the error that ended the session (websocket.CloseStatus(err) gives the code).
func Run(ctx context.Context, o Options) error

type Session struct{ /* … */ }
func (s *Session) Notify(method string, params any) error
func (s *Session) Call(ctx context.Context, method string, params, result any) error // response routed by the read loop
func (s *Session) Close(code websocket.StatusCode, reason string)

// Push schedule set by the controller (agent.configure). Interval 0 = paused.
type Schedule struct { Interval time.Duration }
func IntervalFromSeconds(secs float64) time.Duration // ≤0 → 0, else clamped to [1 s, 1 h]
func Offer(ch chan Schedule, s Schedule)             // keep only the newest, never blocks
type PushOptions struct {
    Configs      <-chan Schedule
    Fallback     *Schedule     // used if nothing arrives within FallbackWait; nil = wait
    FallbackWait time.Duration
    Push         func(ctx context.Context, seq uint64)
    Log          *slog.Logger
}
// RunPusher: first push right after the first schedule, then one per interval
// measured from the start of the previous push; a new schedule keeps the
// cadence; interval 0 pauses. Returns when ctx is done.
func RunPusher(ctx context.Context, o PushOptions)
```

### 2.3 `hoststat`

Typed readers over a root (`FS{Root}`; "" = `/`), so both daemons and their
tests share one parser per file:

```go
type FS struct{ Root string }
func (f FS) Read(p string) ([]byte, error); func (f FS) ReadTrim(p string) (string, error)
func (f FS) ReadDir(p string) ([]os.DirEntry, error)
type Load struct{ Load1, Load5, Load15 float64 }
func (f FS) Loadavg() (Load, error)
func (f FS) Meminfo() ([]MemEntry, error)            // file order; kB values in bytes; raw keys ("Active(anon)")
type MemEntry struct{ Key string; Value uint64 }
var NetDevFields = [16]string{"receive_bytes", …, "transmit_compressed"} // /proc/net/dev order
type NetDev struct{ Name string; Counters [16]uint64 }  // unparsable field = 0; short lines skipped
func (d NetDev) RxBytes() uint64; func (d NetDev) TxBytes() uint64
func (f FS) NetDev() ([]NetDev, error)
type Conntrack struct{ Entries, Limit uint64; HasEntries, HasLimit bool }
func (f FS) Conntrack() Conntrack                    // /proc/sys/net/netfilter/nf_conntrack_{count,max}
func (f FS) Snmp() (map[string]map[string]int64, error) // /proc/net/snmp: "Tcp" → {"CurrEstab": 2, …}
func (f FS) DefaultRouteInterfaces() ([]string, error)  // see 4.1
```

## 3. Collector socket, protocol `perch-collector.v1`

### 3.1 Upgrade

`GET /api/v1/collector-agent/ws` with

- `Authorization: Bearer <collector api_key>`
- `X-Perch-Instance-Id: <instance id>` (same rules as the announce's `instanceId`)
- `Sec-WebSocket-Protocol: perch-collector.v1`
- `Sec-WebSocket-Extensions: permessage-deflate` (offered by the collector)

The server answers before upgrading (JSON body `{error, message}` like the AP endpoint):

| Status | `error` | When |
|---|---|---|
| 503 | `shutting_down` | server stopping |
| 503 + `Retry-After: 1` | `gateway_starting` | the server just started and the gateway is not attached yet (answered by the router; amendment 2026-09-22) |

Transport security (amendment 2026-09-22): the session records whether it came
in over TLS, as for AP agents (docs/ap-controller.md section 2.2), and
`GET /api/v1/settings/collectors` returns it as `connection.secure`. A polled
collector is always plain HTTP (its API has no TLS); the dashboard marks both.
| 429 + `Retry-After` | `rate_limited` | the address used up its failed-attempt budget (the AP gateway's budget, shared) |
| 400 | `unsupported_protocol` | subprotocol offered but not ours |
| 400 | `invalid_request` | missing/invalid instance id header or bearer |
| 401 | `invalid_collector_key` | a row with this instance id stores a key and the bearer does not match (charges the budget) |
| 403 | `announce_disabled` | discovery is off and the instance id is not an **adopted** row |
| 409 | `announce_pending_limit` | no row yet and 16 rows are pending |

### 3.2 Session

Frames are JSON-RPC 2.0 text messages, one object each, no batches.

1. **Collector → `collector.hello` (request, first frame)**. The server waits up
   to 10 s for it, else closes 1008.

   ```json
   {"instanceId":"<same as header>","hostname":"OpenWrt","version":"0.2.0",
    "captureInterface":"br-lan","apiKey":"<only when announce_api_key>",
    "apiKeyFingerprint":"a1b2c3d4","port":9800,"tls":false,
    "baseUrl":"http://192.168.1.1:9800","capabilities":["gateway_stats","observe.dhcp"],
    "system":{"os":"OpenWrt 24.10.2","arch":"amd64"}}
   ```

   `port`/`tls`/`baseUrl` are present only when the collector's HTTP API listens
   on a non-loopback address (then the row keeps a pollable `base_url` exactly
   as an announce would derive it). The server runs the announce match table
   (`recordAnnounce`, docs/collector-management.md §2.4) with the upgrade's
   source address and bearer, and marks the row `transport = 'agent'`.
   Result: `{"collectorId":1,"lifecycle":"adopted","name":"gateway"}`.
   Errors: `-32602` bad params (then close 1008), `-32000` with
   `data.error = announce_key_mismatch | announce_pending_limit` (then close 4001 / 1008).
   A dismissed row gets the result, then close 4003.
2. **Server → `agent.configure` (notification)**, right after the hello result
   and again whenever the row changes (adopt, enable/disable, interval edit):
   `{"metricsIntervalSeconds":5,"lifecycle":"adopted"}`. Interval =
   `poll_interval_seconds` when adopted and enabled, else 0 (paused). The
   collector never pushes before its first configure.
3. **Collector → `collector.push` (notification)** every interval:

   ```json
   {"seq":42,"collectedAt":"2026-09-21T14:17:10Z",
    "summary":{…GET /api/v1/summary .summary…},
    "meta":{"capture_interface":"br-lan","version":"0.2.0"},
    "devices":[…GET /api/v1/devices .devices…],
    "gateway":{…section 4.1, only with gateway stats on…},
    "observe":{"dhcp":{…section 4.3, only when it changed, first in a session and every refresh…}}}
   ```

   Compact JSON (the HTTP API indents; the push does not). Ingested exactly like a
   poll (section 5.3), stamped with server receive time.
4. **Server → collector requests**:
   - `collector.status` → `{"startedAt":"…","totalDevices":40,"captureInterface":"br-lan","version":"0.2.0","uptimeSeconds":1234}`
     (the socket equivalent of the probe; used by adopt and "Probe").
   - `collector.protocols` → `{"protocols":[{"protocol":"TLS","category":"Web"},…]}`
     (GET /api/v1/protocols), asked once per session when the row is adopted.
5. Close codes: 1001 server restarting; 4001 revoked (row deleted, key changed,
   or the adopted key does not match what the session presented); 4002 replaced
   (another session with the same instance id); 4003 dismissed; 1008 protocol
   violation. Both sides ping every 30 s; a missed pong ends the session.

Limits: the server accepts messages up to 64 MiB after inflation
(permessage-deflate on this endpoint only), drops a push that arrives earlier
than `interval − 1.5 s` after the last accepted one, and ingests pushes of one
collector one at a time, keeping only the newest while one is in flight (the
counters are cumulative, so a dropped push loses nothing).

### 3.3 Collector reconnect policy

| Outcome | Wait | Log (once per change) |
|---|---|---|
| 401 `invalid_collector_key`, close 4001 | 5 min | the controller has a different API key for this collector: re-adopt it or align the keys |
| 403 `announce_disabled` | 5 min | discovery is off on the controller: an admin has to turn it on or add this collector |
| 409 `announce_pending_limit` | 5 min | the controller's pending list is full |
| 404 | 5 min | no collector socket on this controller: update Perch Network Controller |
| 429 | `Retry-After` | |
| close 4002 | 60 s | another collector uses this instance id |
| close 4003 | 6 h | dismissed by an admin |
| close 1001 | 2–5 s | |
| anything else | backoff 1 s → 60 s, reset after a session that lasted > 1 min | |

## 4. Gateway stats

### 4.1 Collector

Enabled by `gateway_stats: auto | on | off` (default `auto` = on when
`/etc/openwrt_release` exists; env `PERCH_COLLECTOR_GATEWAY_STATS`; UCI
`gateway_stats`). WAN interfaces: `wan_interfaces` (yaml list; env comma list
`PERCH_COLLECTOR_WAN_INTERFACES`; UCI list `wan_interface`) when set, else the
interfaces holding a default route, re-read on every collection: IPv4
`/proc/net/route` rows with destination and mask 0 and RTF_UP, IPv6
`/proc/net/ipv6_route` rows with `::/0`, excluding `lo` and RTF_REJECT;
sorted, unique. Shape (every field nullable/omitted when unreadable):

```json
{"collectedAt":"2026-09-21T14:17:10Z",
 "conntrack":{"entries":2495,"limit":262144},
 "tcpEstablished":2,
 "load":{"load1":1.44,"load5":1.1,"load15":1.49},
 "memory":{"totalBytes":15637843968,"availableBytes":15525001216},
 "wan":[{"name":"wan0","rxBytes":693974698743,"txBytes":1697321558462}],
 "wanSource":"default-route"}
```

`wanSource` is `configured` or `default-route`. The pull API adds the same
object as a top-level `gateway` field of `GET /api/v1/summary` (next to
`summary` and `meta`), so a polled collector reports it too.

### 4.2 Server

`recordGatewaySample(collector, gateway, receivedAt)` runs from both ingest
paths after the traffic write:

- At most one `router_samples` row per 30 s per collector (in-memory last write,
  1.5 s slack). `recorded_at` stays the primary key; a clash is ignored.
- WAN rate: per-interface deltas against the previous **written** sample of the
  same collector, summed over interfaces present in both; any interface whose
  counter went backwards makes that sample's rate null (reboot). An interface
  appearing or disappearing therefore never makes a spike.
  `wan_rx_bytes`/`wan_tx_bytes` store the sums of the current interfaces.
- `collectors.last_status.gateway = { reportedAt, wanInterfaces, wanSource }` so
  the Gateway page can name its source after a restart.

Removed: `app/tasks/scrape_router.task.ts`, `scrapeRouterOnce`,
`parseRouterMetrics`, `routerConfig`, env `ROUTER_METRICS_URL` and
`ROUTER_WAN_IFACES` (start/env.ts, .env.example, .env.production.example,
compose comments, README). `ROUTER_SAMPLE_RETENTION_DAYS` and the table stay.

`GET /api/v1/router` response (replaces `configured` and `url`):

```ts
{
  source: {
    collectorId: number; name: string; transport: 'poll' | 'agent'
    online: boolean          // agent: socket open; poll: last_status.ok
    wanInterfaces: string[]; wanSource: 'configured' | 'default-route'
    reportedAt: string       // last gateway report
  } | null                   // most recent reporter among adopted collectors
  wanIfaces: string[]        // = source?.wanInterfaces ?? []
  range, from, to, resolution, resolutionSeconds, latest, series  // unchanged
}
```

### 4.3 DHCP observation (`observe.dhcp`, 2026-09-23)

Device names without a transport to the router: the collector on the router
reports its DHCP leases and static hosts, and the controller names devices from
them. It is the `dhcp` part of the observation channel sketched in
`docs/design/gateway/plan-2-native-sync.md` section 3 (same lease shapes, the
`gateway_hosts` table trimmed to DHCP); later parts (`neighbors`, `upnp`, …)
join `observe` the same way.

**Collector.** Enabled by `dhcp_leases: auto | on | off` (default `auto` = on
when `/etc/openwrt_release` exists; env `PERCH_COLLECTOR_DHCP_LEASES`; UCI
`dhcp_leases`), independent of gateway stats; the hello's `capabilities` then
include `observe.dhcp`. Sources: the dnsmasq lease files named by
`uci show dhcp` (`dhcp.@dnsmasq[*].leasefile`, `/tmp/dhcp.leases` for a section
without one; IPv4 lines and dnsmasq's DHCPv6 lines after `duid`), odhcpd's
leases over `ubus call dhcp ipv6leases` (and `ipv4leases` with `maindhcp 1`)
when an `odhcpd` section exists, and the named `host` sections of
`/etc/config/dhcp`. Nothing depends on dnsmasq's DNS port (dnsmasq on port 54
behind AdGuard Home reports the same). Files are re-read only when their size
or mtime changes, `uci` only when `/etc/config/dhcp` changes, odhcpd at most
once a minute.

```json
"observe":{"dhcp":{
  "leases4":[{"mac":"02:00:00:00:10:21","ip":"192.168.1.21","hostname":"laptop",
              "expires":1790000000,"clientId":"01:02:00:00:00:10:21","source":"dnsmasq"}],
  "leases6":[{"duid":"000100012abcdef0020000001021","iaid":12345,"addresses":["fd00::21"],
              "hostname":"laptop","validUntil":1790003600,"device":"br-lan","source":"odhcpd"}],
  "hosts":[{"name":"nas","macs":["02:00:00:00:10:30"],"ip":"192.168.1.30"},
           {"name":"printer","macs":[],"ip":"192.168.1.40"}]}}
```

- `expires` / `validUntil`: Unix seconds, 0 = infinite. `hostname` is left out
  for dnsmasq's `*`; names are cleaned of control characters and at most 253
  bytes. Non-Ethernet hardware addresses are skipped; duplicate leases for one
  MAC and address collapse to the one expiring last. Caps: 4096 leases per
  family, 1024 hosts.
- **When.** In `collector.push` only when the section's fingerprint (SHA-256 of
  its JSON) differs from the last one sent in this session, in the session's
  first push, and every `dhcp_leases_refresh` seconds (default 600, 60–3600).
  `GET /api/v1/summary` carries it on every call, for polled collectors.
- **Absent vs empty.** No `observe` / no `dhcp` = nothing new, the controller
  keeps what it has. A present `dhcp` is a full snapshot; its lists are `[]`
  when empty, and an empty snapshot clears the collector's rows.

**Server.** `app/services/gateway_dhcp.ts`:

- A push's `observe.dhcp` is recorded beside the traffic ingest, not inside it:
  pushes may be dropped as too early or coalesced while one is in flight, and
  the section rides only in the pushes where it changed. Per collector the
  writes run one at a time; the row must be adopted, enabled and `agent`. A
  poll records it right after the ingest. Failures are logged, never fatal.
- Normalised again (same caps), folded to one row per MAC in `gateway_hosts`
  (the IPv4 lease that expires last gives address and expiry; the name comes
  from the latest named IPv4 lease, else a DHCPv6 lease whose DUID carries the
  MAC, types 1 and 3; `static_name` from the last `host` section naming the
  MAC), replaced as a whole in one transaction. `gateway_observations`
  (collector, kind `dhcp`) keeps the fingerprint, `observed_at`, `changed_at`
  and a payload of counts plus the static hosts without a MAC (matched by
  address). An unchanged report writes nothing but `observed_at`, at most once
  a minute; the fingerprint is remembered per collector in a bounded map (256,
  least recently written evicted) and in the table.
- Both tables CASCADE with their collector and are in `collectors:merge`'s
  `NON_HISTORY_TABLES`: the merged collector keeps `--into`'s rows.
- **Hostname lookup** (`hostname_enrichment.ts`): agent data first. Every
  adopted, enabled collector whose last `observe.dhcp` is at most 2 h old
  (twice the longest refresh, a protocol bound) is a source, with no setting;
  static names win over lease names, as before, and `hostnameSource` keeps its
  values (`openwrt_static`, `dhcp_lease`). While any agent source is active,
  the lxc/ssh command path (Settings → Hostname enrichment, off by default)
  stands by and runs nothing; it takes over for gateways without the agent.
  The agent maps are one cached entry, reloaded after a write or after 60 s.
- `GET /api/v1/settings/hostname-enrichment/sources` (admin):
  `{agentActive, commandPath: 'off'|'standby'|'active', agents: [{collectorId,
  name, active, online, reportedAt, changedAt, leases4, leases6, staticHosts,
  namedDevices}]}`. The settings page shows "provided by the gateway agent
  (collector …)" from it.

## 5. Controller (perch-controller) changes

1. **Migration 042**: `collectors.transport varchar(16) not null default 'poll'`
   (`'poll' | 'agent'`), `collectors.base_url` becomes nullable (agent rows whose
   API is loopback-only have no pollable address). Regenerate `database/schema.ts`
   via the test database (CLAUDE.md).
2. **One upgrade listener, two endpoints.** `agent_hub.ts` holds the generic hub
   (today's `ApAgentHub` with `id` instead of `apId`); `ap_agent_hub.ts` and
   `collector_agent_hub.ts` export one instance each. `agent_gateway.ts` owns the
   single `upgrade` listener, the heartbeat and graceful close, and routes by path
   to endpoint definitions (path, subprotocol, maxPayload, perMessageDeflate,
   authenticate, onConnection). AP behaviour is unchanged apart from the
   subprotocol rename; its tests keep passing.
3. **Ingest split.** `pollOnce` becomes `fetchCollectorSnapshot` (HTTP) +
   `ingestCollectorSnapshot(collector, snapshot, {now})` sharing the snapshot
   state; per-collector serialisation lives in the ingest so a poll in flight and
   a first push can never interleave. Protocol categories: the poll path keeps its
   hourly pull; the socket path uses `collector.protocols`. The poll task selects
   `transport = 'poll'` rows only. The push handler drops (debug log) when the row
   is missing (and closes the session 4001), not adopted, disabled, not
   `transport = 'agent'`, or too early.
4. **Registry on agent rows.** Adopt: key check as today (fingerprint), no HTTP
   probe; the "probe" is `collector.status` over the socket (offline →
   `{ok:false, error:'collector is not connected'}`); send `agent.configure`; if
   the live session presented a bearer that does not match the adopted key, close
   it 4001. Update: resend configure (0 when disabled). Dismiss: close 4003.
   Delete: close 4001. `POST …/probe` on an agent row uses `collector.status`.
   `recordAnnounce` over HTTP sets `transport = 'poll'` (a daemon that went back
   to polling), over the socket `'agent'`.
5. **Freshness**: the poll task's 5 s tick also runs `checkCollectorPushFreshness`
   (the AP version's rules: online, adopted, enabled, no accepted push for
   max(3 × interval, 30 s) → failed `last_status`, once per episode).
6. **Wire shape** (`CollectorTransformer`, admin): adds
   `transport: 'poll' | 'agent'`, `baseUrl: string | null`,
   `connection: { online: boolean; connectedAt: string | null; address: string | null } | null`
   (null for poll rows), and `gateway: { reportedAt: string; wanInterfaces: string[]; wanSource: string } | null`
   (from `last_status.gateway`). `lastStatus` keeps its shape (plus `gateway`).
   Setup candidates use the same transformer.
7. **Rename** inside the repo: `package.json` name `perch-controller`
   (dashboard `perch-dashboard`), compose `name: perch`, images, `PERCH_*`
   compose knobs, entrypoint fallbacks, README/docs/UI strings, AP subprotocol,
   AP release URL default, `uci … perch-collector` hints.
8. **Tests**: collector socket (upgrade refusals, hello → pending, adopt →
   configure, push → buckets identical to a poll of the same fixtures, switch
   from poll to agent without double counting, too-early and disabled drops,
   dismiss/delete close codes, key mismatch), gateway samples (30 s throttle,
   per-interface rate, interface set change, reboot → null rate), router API
   shape, poll task skipping agent rows, AP suite unchanged.

## 6. Collector (perch-collector) changes

1. Rename per section 1 (module, binary, Makefile, Dockerfile, CI, OpenWrt
   package `openwrt/perch-collector` with `perch-collector.{init,config,defaults}`,
   docs, user agent, scripts; `build-static.sh` output `out/perch-collector-ndpi.static`
   and a workspace mount for the local kit).
2. `transport: auto | websocket | poll` (env `PERCH_COLLECTOR_TRANSPORT`, UCI
   `transport`). `auto` = websocket when `server_url` and `api_key` are set,
   poll-announce when only `server_url` is (with a warning to set a key), no
   outbound connection without `server_url`. `websocket` without `api_key` is a
   config error. New `server_ca_file`; `announce_tls_insecure` applies to the
   socket too.
3. Socket client with the kit (`internal/controller`): section 3; status in the
   local API: `meta.transport` (`websocket` | `poll`) and `meta.announce_status`
   (starting, pending, adopted, dismissed, `error: …`) for either transport.
4. Gateway stats (`internal/gateway`): section 4.1, from `hoststat`.
5. OpenWrt defaults: `option transport 'auto'`, `option gateway_stats 'auto'`,
   `option listen_network 'loopback'` (the API answers on 127.0.0.1 for local
   debugging; set it to `lan` to be polled). Everything else as today.
6. Tests: config precedence incl. old env names, transport resolution, gateway
   readers on fixture trees (dual WAN, IPv6 default route, reject route, no
   conntrack), socket client against an in-process server (hello → configure →
   push cadence, pause, status/protocols RPC, retry table, compression offered).

## 7. AP daemon (perch-apd) changes

1. Rename per section 1: module, `cmd/perch-apd`, binary, UCI `perch-apd`
   (`config agent 'main'`), init script, `openwrt/perch-apd`, `install.sh`,
   release workflow asset names (`perch-apd-linux-<arch>`), user agent,
   subprotocol `perch-ap.v1`, PROTOCOL.md, README, CLI help and log hints.
2. Onto the kit: `internal/rpc` → kit `rpc`; the session loop, pusher, backoff,
   status errors and HTTP client → kit `link` (join and credential handling stay
   in the daemon); Loadavg, Meminfo, Netdev and Conntrack parse through
   `hoststat` with byte-identical Prometheus output (existing fixtures and tests
   unchanged).
3. `go test ./...` and `GOTOOLCHAIN=go1.22.12 go test ./...` pass; `make release`
   builds every architecture.

## 8. Dashboard

1. Gateway panel on the new `/api/v1/router` shape: subtitle names the source
   collector; empty state without a source says to run Perch Network Collector on
   the router (OpenWrt package `perch-collector`, `gateway_stats` auto); history
   without a current source shows the data with a "no collector reports gateway
   stats right now" note.
2. Settings → Collectors: transport badge ("Socket" / "Polled"), online dot and
   "connected from <address> since …" for socket rows, "Gateway" badge with WAN
   interfaces when `gateway` is set, `baseUrl` may be null.
3. Setup candidates: a socket candidate shows "connected from <address>" instead of
   a polled address.
4. Branding: "Perch" everywhere the UI said metricslite; `uci … perch-collector`
   and `perch-apd` commands; `/etc/init.d/perch-collector`.

## 9. Rollout on this host (lead)

1. Server first (`docker compose up -d --build`; migration 042 runs on start).
   The old collector keeps being polled (`transport = 'poll'`); gateway samples
   pause until step 2.
2. Gateway: install `perch-collector` (static nDPI build), carry `api_key`,
   `instance_id`, `server_url` and capture options over from
   `/etc/config/metricslite-collector`, `listen_network 'loopback'`, stop and
   disable `metricslite-collector`, start `perch-collector`. Row #1 flips to
   `agent` on the hello; the restart baselines once (new `started_at`).
3. Verify: pushes every 5 s, bucket totals continuous, gateway samples every
   30 s matching `/proc` on the router, Gateway page names the collector.
4. `prometheus-node-exporter-lua` on the router is no longer read by Perch; the
   owner decides whether to remove it.

## 10. Later

Delta pushes (only changed devices), buffering on the collector while the socket
is down, join tokens for collectors, a LuCI page.

## Amendments

**B1. Server implementation notes (2026-09-21).** Additions made while
building section 5; nothing in sections 3–4 changed shape.

- The upgrade also answers `429 announce_rate_limited` (+ `Retry-After`) when
  an instance id that is not an adopted row connects more than 12 times a
  minute from one address: an unadopted socket is an announce and shares
  `POST /api/v1/collectors/announce`'s per-address budget. Adopted collectors
  are never throttled there.
- A socket row is never adopted keyless. When the admin gives no key and the
  row learned none from the hello, adoption binds the key the connected
  collector presented (it must match the announced fingerprint when there is
  one).
- Editing a socket row's key (`PUT …/collectors/:id` with `apiKey`) closes a
  live session that holds another key with 4001, like adoption does.
- A push that waited while an older one was ingested and was replaced by a
  newer one resolves as dropped `superseded`; a push without `summary` and
  `devices` is dropped `invalid`.
- Freshness counts from the latest of the last accepted push, the connect and
  the moment a non-zero schedule was sent, so a collector adopted after hours
  in `pending` is not reported stale before its first push.
- `last_status.gateway` survives failed polls, probes and the stale report
  (the Gateway page keeps naming its source and shows it offline); a
  successful poll or push without a `gateway` object removes it. The router
  API's `source.online` is `enabled` and, for a socket row, connected, for a
  polled row, last poll ok.
- A first frame that is a request other than `collector.hello` gets `-32600`
  before the 1008 close.

### B2 (2026-09-21, owner): the default Docker install is the controller only

`docker compose up -d` starts MariaDB and the server, nothing else: collectors
and access points join afterwards, like devices joining a UniFi controller. The
bundled collector only ever saw useful traffic when the Docker host was the
router, a bridge or a mirror port, and it ran with host networking plus
NET_RAW/NET_ADMIN by default.

- The collector service moved behind the `collector` profile in
  `docker-compose.yml`, `docker-compose.external-db.yml` and
  `docker-compose.host.yml`; `docker-compose.no-collector.yml` is gone (it is
  the default now).
- An opted-in collector is a socket collector like any other:
  `PERCH_COLLECTOR_SERVER_URL` defaults to the server's published port on the
  host's loopback, `PERCH_COLLECTOR_TRANSPORT=websocket`, its API answers on
  127.0.0.1 only, and it appears under Pending adoption.
- The collector image's entrypoint (`docker/entrypoint.sh` in perch-collector)
  generates the API key on first start when a server URL is set and no key is
  given, and keeps it with the instance id in `/var/lib/perch-collector` (the
  `collector-data` volume): an adopted collector presents the same key after
  every restart, as the OpenWrt package does with UCI. The image's API now
  listens on 127.0.0.1 by default.
- The compose files no longer set `COLLECTOR_URL`; the server still honours it
  (a `source=env` polled row) when an operator sets it.
- Upgrading from 0.1.0: the old bundled collector's `env` row keeps its
  history; start the profile, adopt the new pending row and fold the old one in
  with `collectors:merge`, or disable the old row.
