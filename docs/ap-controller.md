# Perch AP Daemon (perch-apd): AP agents over WebSocket

Status: implemented September 2026 (design below is the contract the server,
the dashboard and the agent were built against).

Renamed 2026-09-21: the agent, first built as `ap-controller`, is the **Perch
AP Daemon** (`perch-apd`: binary, OpenWrt package, UCI config
`/etc/config/perch-apd`, repository `capthndsme/perch-apd`, checked out in
`../ap-controller`), and the WebSocket subprotocol is `perch-ap.v1`
(`metricslite-ap.v1` is no longer accepted; no AP ran it). Its session code
moved into the shared `perch-agentkit` module, which the collector's socket
(docs/collector-agent.md) uses too; on the server both endpoints share one
upgrade listener (`agent_gateway.ts`) and one hub class (`agent_hub.ts`).

The OpenWrt package `perch-apd` runs on each access point. It replaces
`prometheus-node-exporter-lua-*` as the source of the AP's metrics and gives
the server a command channel (kick, steer, locate, reboot) without SSH. The
wire protocol is `PROTOCOL.md` in the perch-apd repository.

```
 AP (OpenWrt)                        Perch Network Controller (this repo)
 perch-apd ───── POST /api/v1/ap-agent/join ──▶ join token → agent credentials
               ◀═ WS /api/v1/ap-agent/ws ═════▶ AgentHub (in-process, ap_agent_hub)
                    ▲ agent.configure first on every session (push schedule)
                    ▲ system.info on connect
                    ▼ metrics.push every interval → ingestWifiMetrics (ap_agent_metrics)
                    ▲ client.kick / locate.* / system.reboot (wifi_controller)
```

Every connection is opened by the agent; it listens on no port. Metrics are
pushed by the agent on the schedule the server sets; commands travel the
other way on the same socket.

Why plain WebSocket + JSON-RPC 2.0 and not socket.io: the peer is a Go daemon
on a router, not a browser. socket.io's value (long-polling fallback, rooms,
browser reconnection) does not apply, and the Go side would need an Engine.IO
v4 + Socket.IO v5 client, none of which is small or well maintained. `ws` on
the server and `coder/websocket` in the agent are both dependency-free, and
JSON-RPC gives request/response correlation and error codes for free.

## 1. Data model

### 1.1 `ap_join_tokens` (new)

| Column | Type | |
|---|---|---|
| `id` | increments | |
| `label` | string(80) null | admin's note |
| `token_hash` | string(64) not null, unique | SHA-256 hex of the full token |
| `token_prefix` | string(16) not null | first 9 chars (`mlap_` + 4), for display |
| `token_encrypted` | text not null | `encryption.encrypt(token)`, so an admin can show it again |
| `created_by_user_id` | int unsigned null → `users.id` ON DELETE SET NULL | |
| `expires_at` | timestamp null | null = never |
| `max_uses` | int unsigned null | null = unlimited |
| `use_count` | int unsigned not null default 0 | successful joins |
| `last_used_at` | timestamp null | |
| `revoked_at` | timestamp null | soft revoke; rows are never deleted |
| `created_at`, `updated_at` | timestamps | |

Token format: `mlap_` + 32 base64url chars (24 random bytes).

### 1.2 `wifi_access_points` (new columns)

| Column | Type | |
|---|---|---|
| `transport` | string(16) not null default `'scrape'` | `'scrape'` (HTTP `/metrics`) or `'agent'` (perch-apd) |
| `agent_id` | string(64) null, unique | 32 hex chars |
| `agent_secret_hash` | string(64) null | SHA-256 hex of the agent secret |
| `agent_version` | string(32) null | |
| `agent_info` | text null | JSON: `{hostname, model, boardName, system, release, revision, target, arch, kernel, macs[], capabilities[], radios[], interfaces[]}` from join + `system.info` |
| `agent_joined_at` | timestamp null | |
| `agent_connected_at` | timestamp null | last connect |
| `agent_disconnected_at` | timestamp null | last disconnect |
| `agent_last_address` | string(64) null | client address of the last session (trust-proxy aware) |
| `join_token_id` | int unsigned null → `ap_join_tokens.id` ON DELETE SET NULL | token used for the last join |
| `metrics_url` | **now nullable** | agent rows created by a join have none |

Agent credentials: `agentId` = 16 random bytes hex, `agentSecret` = 32 random
bytes base64url (43 chars). The WebSocket bearer is `<agentId>.<agentSecret>`.
Compare with `crypto.timingSafeEqual` on the SHA-256 digests.

`wifi_command_audits` is reused for agent commands (`params.via = 'agent'`,
`stdout` = JSON result, `stderr` = error message).

## 2. Agent-facing endpoints (no user auth, outside the setup gate)

Registered next to `POST /api/v1/collectors/announce`, before the `/api/v1`
group and the SPA catch-all.

### 2.1 `POST /api/v1/ap-agent/join`

Request/response exactly as PROTOCOL.md §1. Server side:

1. Rate limit per `request.ip()`: 20 *failed* attempts (401/422) per 15 min
   → 429 `{error:'rate_limited', message, retryAfterSeconds}` + `Retry-After`.
   In-memory, shared with WebSocket auth failures.
2. Validate (vine). Lowercase the MACs.
3. Token: SHA-256 → row; must be not revoked, not expired, under `max_uses`.
   Else 401 `{error:'invalid_join_token', message}` (message may say which).
4. Match, in one transaction:
   1. rows with `agent_id` set whose `agent_info.macs` intersect `macs`
      → `rejoined` (most recently connected wins);
   2. else rows whose `wifi_network_latest.bssid` is in `macs`
      → `linked` (most recently seen wins);
   3. else create (`name` = hostname, `metrics_url` null, `poll_interval_seconds` 15,
      `enabled` true) → `created`.
5. Set on the row: `transport='agent'`, new `agent_id` + `agent_secret_hash`,
   `agent_version`, `agent_info` (from the body, `capabilities: []` until the
   first `system.info`), `agent_joined_at`, `join_token_id`, `nodename` =
   hostname, `model` / `openwrt_release` when given. Keep `metrics_url`,
   `name`, `friendly_name`, `poll_interval_seconds`, `enabled` on matched rows.
6. Token: `use_count + 1`, `last_used_at = now`.
7. If the hub has a live session for that AP, close it with 4001.
8. 201 `{ data: { agentId, agentSecret, apId, apName, outcome } }`.
   `apName` = `friendly_name ?? name`.

### 2.2 `GET /api/v1/ap-agent/ws` (WebSocket upgrade)

Handled on the Node HTTP server's `upgrade` event (the Adonis router never
sees it), by `ws`'s `WebSocketServer({ noServer: true, maxPayload: 4 MiB })`.

- Path must be exactly `/api/v1/ap-agent/ws` (query ignored); other upgrade
  paths get `404` and the socket is destroyed.
- `Authorization: Bearer <agentId>.<secret>` → row by `agent_id`, digest
  compare. Failure → raw `HTTP/1.1 401 Unauthorized` with JSON body
  `{"error":"invalid_agent_credentials"}`, destroy, count toward the rate
  limit (429 + `Retry-After` when over).
- Subprotocol: select `perch-ap.v1` when offered; accept a client that
  offers none. A client that offers only other protocols (a future
  `perch-ap.v2`-only agent) gets `400 {"error":"unsupported_protocol"}`
  before the upgrade.
- Compression (amendment 2026-09-22): permessage-deflate is enabled like on
  the collector endpoint (no context takeover either way, server threshold
  1 KB). perch-apd offers it since 0.1.1; a push of 20–40 KB of text goes out
  about 7× smaller. Agents that do not offer it stay uncompressed.
- Client address: the socket's remote address, or the right-most untrusted
  hop of `X-Forwarded-For` when the remote address is trusted by the same
  `TRUST_PROXY` predicate `config/app.ts` compiles (`#services/trust_proxy`).
  Stored in `agent_last_address`.
- On open: register in the hub (an existing session for the same AP is
  closed with 4002); send the `agent.configure` notification as the FIRST
  frame (`{metricsIntervalSeconds: enabled ? poll_interval_seconds : 0,
  collectors: [...]}`, §3.1); set `agent_connected_at`; then call
  `system.info` and store `agent_version`, `agent_info` (merged), `nodename`
  (hostname), `model`, `openwrt_release` (release).
- Keepalive: ping every 30 s; terminate when the previous ping got no pong.
- Incoming frames: responses resolve pending requests; notifications go to
  their handler (`metrics.push` → ingestion, others logged at debug);
  requests get `-32601`; garbage is logged and ignored.
- On close: unregister, and when that leaves the AP offline (it was the
  registered session, or `disconnect` removed it and no newer one replaced
  it) set `agent_disconnected_at` and `last_status = {ok: false, checkedAt,
  error: 'agent offline'}`; reject pending requests with `AgentOfflineError`.
  Every row write a session causes (connect, disconnect, `system.info`) is
  scoped to the `agent_id` it authenticated with, so a session whose
  credentials were rotated or forgotten meanwhile cannot touch the row.

Wiring: `providers/ap_agent_provider.ts`, web environment only: `ready()`
attaches the gateway to `server.getNodeServer()`, `shutdown()` closes every
session with 1001. Functional tests attach it to the server
`testUtils.httpServer().start()` creates (in `tests/bootstrap.ts`), so tests can
connect a real `ws` client to `ws://HOST:PORT/api/v1/ap-agent/ws`.

### 2.3 `ApAgentHub` (`app/services/ap_agent_hub.ts`, singleton)

```ts
isOnline(apId: number): boolean
session(apId: number): { connectedAt: DateTime; address: string | null; protocol: string } | null
request<T>(apId: number, method: string, params?: object, opts?: { timeoutMs?: number }): Promise<T>
  // rejects AgentOfflineError | AgentTimeoutError | AgentRpcError(code, message, data)
notify(apId: number, method: string, params?: object): boolean
onNotification(method: string, handler: (apId: number, params: unknown) => void | Promise<void>): void
disconnect(apId: number, code: number, reason: string): boolean
```

Default request timeout 10 s. Single process by design (like the scheduler).

## 3. Server behaviour changes

### 3.1 Pushed metrics (`ap_agent_metrics.ts`)

Agent rows are never polled. The server sets the schedule, the agent pushes:

```jsonc
// server → agent, first frame of every session, and again whenever the
// row's poll_interval_seconds or enabled changes (wifi-sources update)
{"jsonrpc":"2.0","method":"agent.configure","params":{
  "metricsIntervalSeconds": 15,        // enabled ? poll_interval_seconds : 0 (0 = pause)
  "collectors": ["openwrt","uname","stat","loadavg","meminfo","conntrack","netdev","wifi","wifi_stations"]}}
// agent → server, every interval (the first right after agent.configure)
{"jsonrpc":"2.0","method":"metrics.push","params":{
  "format":"prometheus-text","text":"…","collectedAt":"<agent clock>","durationMs":12,"seq":1}}
```

A push goes through `ingestWifiMetrics(ap, text, {now, latencyMs})`, the part
of `pollWifiOnce` after the HTTP fetch, so parsing, deltas, snapshots, latest
tables, roaming, `last_status`, model and nodename are identical to the scrape
path. Rows are bucketed by server receive time; `collectedAt` is ignored;
`latencyMs` = `durationMs`.

- Per AP, pushes are ingested one after the other (a promise chain).
- A push that arrives sooner than `poll_interval_seconds × 1000 − 1500` ms
  after the last accepted one is dropped (debug log): the poll task's slack.
  So is a push for a disabled row or a row that is not an agent row.
- `format` other than `prometheus-text`, a missing text, or a text over 4 MiB:
  warn and ignore.

The 5 s poll task (`poll_wifi_access_points.task.ts`) skips `transport = 'agent'`
rows and instead runs the liveness check: an agent that is online and enabled
but has had no push accepted for max(3 × `poll_interval_seconds`, 30) s,
counted from its last accepted push or from the connect, gets
`last_status = {ok: false, error: 'no metrics from the agent for Ns'}`, once
per episode (a new push or a new session starts the next one).

`metrics.collect` does not exist: push is the only metrics path. The agent
fills `wifi_station_{receive,transmit}_bytes_total`, so
`wifi_station_snapshots.tx_bytes` / `rx_bytes` stop being NULL for agent APs.

### 3.2 Commands (`wifi_controller.ts`)

`kick`, `steer`, `reboot`, `locate` keep their routes and pick a channel:

| AP | Channel |
|---|---|
| `transport = 'agent'`, online | JSON-RPC over the hub |
| `transport = 'agent'`, offline | **409** `{error:'agent_offline', message}` |
| scrape + SSH configured (`isCommandEnabled`) | SSH as today |
| otherwise | 400 `wifi_commands_not_enabled` as today |

Agent mapping:

| Endpoint | RPC |
|---|---|
| `POST /wifi/clients/:mac/kick` | `client.kick {mac, ifname, reason: 1, deauth: true, banTimeMs: 0}` |
| `POST /wifi/clients/:mac/steer` | `client.kick {mac, ifname, reason: 1, deauth: true, banTimeMs: body.banTimeMs ?? 5000}` |
| `POST /wifi/aps/:id/reboot` | `system.reboot {delaySeconds: 2}` |
| `POST /wifi/aps/:id/locate` | `locate.stop` when `body.stop`, else `locate.start {durationSeconds: body.durationSeconds ?? 30}` |

`ifname` comes from `wifi_station_latest` as today (a hint; the agent finds the
client itself). Errors: `AgentRpcError` -32002 → 404 `wifi_client_not_associated`;
-32001 → 400 `wifi_command_unsupported`; other RPC errors → 400
`wifi_command_failed` (message = RPC message); timeout → 504 `agent_timeout`.
Every attempt writes a `wifi_command_audits` row.

The locate validator gains `durationSeconds` (1–600) and `stop` (boolean);
`blinkTimes` / `blinkDurationMs` stay for SSH APs.

Success bodies stay what they are and gain `via: 'agent' | 'ssh'`; locate via
the agent returns `{ok, apId, via, active, durationSeconds, latencyMs}`.

### 3.3 Other

- Deleting a wifi source closes its session with 4001 first.
- `POST /settings/wifi-sources/:id/probe` and the probe-after-update of an
  agent row ask the agent (`system.info`, which also refreshes identity)
  instead of fetching `metrics_url`; the result has the usual probe shape
  (`ok`, `checkedAt`, `latencyMs`, `model`, `nodename`, `openwrtRelease`, `error`).

## 4. Admin endpoints (settings group: auth + password change + admin)

### 4.1 Join tokens

Shape of a token row everywhere (`ApJoinToken`):

```ts
{
  id: number
  label: string | null
  prefix: string                 // 'mlap_AbCd'
  status: 'active' | 'expired' | 'revoked' | 'exhausted'
  createdAt: string              // ISO
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  useCount: number
  maxUses: number | null
  createdBy: { id: number; email: string } | null
}
```

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/settings/ap-join-tokens` | | `{data: ApJoinToken[]}` newest first |
| POST | `/api/v1/settings/ap-join-tokens` | `{label?: string ≤80 \| null, expiresInHours?: 1..8760 \| null, maxUses?: 1..1000 \| null}` | 201 `{data: {token: string, joinToken: ApJoinToken}}` |
| POST | `/api/v1/settings/ap-join-tokens/:id/reveal` | | `{data: {token: string}}`; 404 unknown; 410 `{error:'join_token_inactive'}` unless active |
| DELETE | `/api/v1/settings/ap-join-tokens/:id` | | 204 (sets `revoked_at`, idempotent); 404 unknown |

Responses carrying a plaintext token set `Cache-Control: no-store`.

### 4.2 Install info

`GET /api/v1/settings/ap-agent/install`:

```ts
{
  controllerUrl: string      // AP_AGENT_CONTROLLER_URL, else `${request.protocol()}://${request.host()}`
  releaseBaseUrl: string     // AP_AGENT_RELEASE_URL, default
                             // 'https://github.com/capthndsme/perch-apd/releases/latest/download'
  installScriptUrl: string   // `${releaseBaseUrl}/install.sh`
  assets: Array<{ arch: 'mipsle' | 'mips' | 'armv7' | 'armv5' | 'arm64' | 'amd64'; file: string; label: string; hint: string }>
}
```

Assets (fixed list, in this order):

| arch | file | label | hint |
|---|---|---|---|
| `mipsle` | `perch-apd-linux-mipsle` | MIPS little-endian | MT7621, MT7628 (mipsel_24kc) |
| `mips` | `perch-apd-linux-mips` | MIPS big-endian | Atheros/QCA ath79 (mips_24kc) |
| `armv7` | `perch-apd-linux-armv7` | ARMv7 | IPQ40xx, IPQ806x, mvebu (arm_cortex-a7/a9/a15 with VFP) |
| `armv5` | `perch-apd-linux-armv5` | ARM without VFP | kirkwood, bcm53xx, ARMv5/v6 (software floats) |
| `arm64` | `perch-apd-linux-arm64` | ARM64 | Filogic MT798x, IPQ807x, BCM2711 (aarch64) |
| `amd64` | `perch-apd-linux-amd64` | x86-64 | x86_64 PCs and VMs |

The dashboard builds three commands from it:

```sh
# 1. one-liner (detects the architecture, verifies the checksum)
wget -qO- {installScriptUrl} | sh -s -- --controller {controllerUrl} --token {token}
# 2. manual, per architecture
wget -O /tmp/perch-apd {releaseBaseUrl}/{file} && chmod +x /tmp/perch-apd && /tmp/perch-apd --install --controller {controllerUrl} --token {token}
# 3. already installed (opkg/apk package or an earlier install)
perch-apd join --controller {controllerUrl} --token {token}
```

### 4.3 Agent on a wifi source

| Method | Path | Response |
|---|---|---|
| POST | `/api/v1/settings/wifi-sources/:id/agent/ping` | `{data: {online: true, latencyMs: number}}`; 409 `agent_offline`; 404 no source / no agent |
| DELETE | `/api/v1/settings/wifi-sources/:id/agent` | "Forget agent": close session 4001, clear `agent_id`, `agent_secret_hash`; `transport` → `'scrape'`; if `metrics_url` is null also `enabled = false`. `{data: WifiSource}` |

### 4.4 Serialization additions

`WifiAccessPointTransformer` (Settings → Wi-Fi sources, `GET /settings/wifi-sources`):

```ts
metricsUrl: string | null           // now nullable
transport: 'scrape' | 'agent'
agent: null | {                     // null when agent_id is null
  online: boolean
  idPrefix: string                  // first 8 chars of agent_id
  version: string | null
  arch: string | null
  hostname: string | null
  boardName: string | null
  target: string | null
  kernel: string | null
  capabilities: string[]
  joinedAt: string | null
  connectedAt: string | null
  disconnectedAt: string | null
  lastAddress: string | null
}
```

`GET /wifi/aps` and `accessPoints[]` of `GET /wifi/overview` gain:

```ts
transport: 'scrape' | 'agent'
agentOnline: boolean | null         // null for scrape rows
controls: {
  via: 'agent' | 'ssh' | null       // null = no command channel
  online: boolean                   // agent connected; true for ssh
  kick: boolean                     // agent: online && capabilities has 'kick'; ssh: true
  steer: boolean                    // same as kick
  locate: boolean                   // agent: online && 'locate'; ssh: true
  reboot: boolean                   // agent: online && 'reboot'; ssh: true
}
```

## 5. Configuration

| Env | Default | |
|---|---|---|
| `AP_AGENT_RELEASE_URL` | GitHub `…/releases/latest/download` | where install commands download from (self-hosted mirror) |
| `AP_AGENT_CONTROLLER_URL` | derived from the request | controller URL shown in install commands |

Reverse proxy: the WebSocket must be passed through. Apache 2.4.47+:
`ProxyPass / http://127.0.0.1:12553/ upgrade=websocket` (see
`docs/ops/apache-perch.conf`). nginx: `proxy_http_version 1.1` plus the
`Upgrade` / `Connection` headers on `/api/v1/ap-agent/ws` and
`/api/v1/collector-agent/ws`.

## 6. Migration path for an AP scraped today

1. Settings → Wi-Fi sources → New join token.
2. On the AP: the one-liner. The agent joins with its MACs; the server finds
   the existing row by BSSID (`outcome: linked`) and switches it to the agent.
   Same `apId`, history continues, the SSH settings are no longer used.
3. `opkg remove prometheus-node-exporter-lua*` (or `apk del …`), unless
   something else still scrapes it: the agent serves no `/metrics` of its own.
