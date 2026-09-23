# Gateway observation channel (controller side)

Status: built 2026-09-23 (branch `gw/ctl-obs`, milestone M2 "observe everything").
Contract origin: the managed-gateway plan, plan 2 ("native sync") section 3 and the read
parts of section 5; work package WP-B. The collector side is perch-collector's
`internal/observe` (WP-A). This file is the contract both sides build against.

The observation channel carries the router's **runtime state**, never its config: DHCP
leases, the neighbour (ARP/NDP) table, interfaces, UPnP port mappings, multi-WAN status,
the resolver, system facts, WireGuard peers and packages. Config (pools, reservations,
firewall rules, …) belongs to the config plane (plan 1) and is not read here.

Placeholders only: `192.168.x.x` LANs, `203.0.113.x` WAN, MACs `02:00:00…`,
`example.com`.

## 1. Transport

One **observation object** (section 2), three ways in, one ingest
(`app/services/gateway_observe.ts`):

| Way | Direction | When |
|---|---|---|
| `observe` inside `collector.push` params | agent → server | **perch-collector's way** (its CONFIG.md, "The observation channel"): a part rides in the first push of a session, when its fingerprint changed (neighbours at most once a minute) and every `observe_refresh` seconds (`dhcp`: `dhcp_leases_refresh`). `observe.full: true` marks a push carrying every part the collector reports. Recorded beside the traffic ingest, not inside it (pushes may be dropped as too early or coalesced; the observation never is) |
| `observe` inside a polled `GET /api/v1/summary` | agent → server | Polled collectors, every poll |
| `gateway.observe` | server → agent, JSON-RPC **request**, params `{ parts?: string[] }` | On demand (`POST /gateways/:gatewayId/observe`, the dashboard's refresh). Result = the object read fresh, plus `collectedAt`; only the asked parts when `parts` is given (unknown names ignored). Timeout 20 s. Needs the hello capability `gateway.observe` |
| `gateway.observed` | agent → server, JSON-RPC **notification**, params = the object | Also accepted (plan 2 section 3 named it); perch-collector does not send it today |

Capabilities in `collector.hello` (`capabilities: string[]`, ≤ 32 entries of ≤ 64
characters): `observe.<part>` for every part the collector reports (`observe.dhcp`,
`observe.neighbors`, `observe.interfaces`, `observe.upnp`, `observe.mwan3`,
`observe.resolver`, `observe.system`; the server also knows `observe.wireguard` and
`observe.packages`), `gateway.observe`, `gateway.backup` (section 8) and
`net.conntrack_flush` (used by later work: WAN block, M7). The server keeps each live
session's list in memory (`sessionCapabilities(collectorId)` in `collector_agent.ts`;
null while offline) and checks it before `gateway.observe` / `gateway.backup`.

Only rows that are adopted, enabled and `transport = 'agent'` keep what arrives over the
socket; a polled collector's `observe` is recorded after its (adopted) poll.

## 2. The observation object

Every key is optional. **Absent (or null) = not reported: the controller keeps what it
has.** A present part is a full snapshot of that part (`[]` = none). Unknown keys are
ignored; unknown fields inside a part are dropped by the server's normaliser (so nothing
the agent should not send, a private key, can be stored). Strings are cleaned of control
characters and capped (253 for names). Times are Unix seconds, `0` = none/infinite.
perch-collector's shapes (its `internal/observe`, CONFIG.md):

```json
"observe":{"full":true,
 "interfaces":[{"network":"wan","device":"wan0","proto":"dhcp","up":true,"ipv4":["203.0.113.10/24"],"ipv6":[],
                "uptimeSeconds":86400,"defaultRoute":true,"metric":1,"gateway4":"203.0.113.1",
                "gateway6":"","dnsServers":["203.0.113.53"],"error":"NO_DEVICE"}],
 "dhcp":{"leases4":[{"mac":"02:00:00:00:10:21","ip":"192.168.1.21","hostname":"laptop","expires":1790000000,
                     "clientId":"01:02:00:00:00:10:21","source":"dnsmasq","network":"lan"}],
         "leases6":[{"duid":"00030001020000001021","iaid":1,"addresses":["fd00::21"],"hostname":"laptop",
                     "validUntil":1790003600,"device":"br-lan","source":"odhcpd"}],
         "hosts":[{"name":"nas","macs":["02:00:00:00:10:30"],"ip":"192.168.1.30"}],
         "pools":[{"network":"lan","ignore":false,"leaseTime":43200,"start":100,"limit":150,"section":"lan"}]},
 "neighbors":[{"ip":"192.168.1.21","mac":"02:00:00:00:10:21","device":"br-lan","network":"lan",
               "reachable":true,"state":"reachable"}],
 "upnp":{"installed":true,"enabled":true,"running":true,
         "mappings":[{"proto":"TCP","extPort":51413,"intIp":"192.168.1.21","intPort":51413,"expires":0,"description":"app"}]},
 "mwan3":{"serviceEnabled":false,"running":false,
          "configInterfaces":[{"name":"wan","enabled":true,"family":"ipv4","trackIps":["203.0.113.1"]}],
          "interfaces":[{"name":"wan","status":"notracking","enabled":true,"running":false,"up":true,
                         "uptimeSeconds":86400,"tracking":"none","trackIps":[{"ip":"203.0.113.1","up":true}]}],
          "policies":{"balanced":[{"interface":"wan","percent":50}]},
          "configPolicies":{"balanced":["wan_m1","wanb_m1"]}},
 "resolver":{"dnsmasqPort":54,"port53Process":"AdGuardHome","port53Processes":["AdGuardHome"],
             "controllerHost":{"name":"perch.example.com","addresses":["192.168.1.10"],"error":"not_found"}},
 "system":{"hostname":"gateway","release":"OpenWrt 24.10.2 r28739-…","version":"24.10.2","revision":"r28739-…",
           "board":"x86/64","boardName":"qemu-standard-pc","model":"…","kernel":"6.6.100",
           "uptimeSeconds":123456,"flowOffloading":false,"flowOffloadingHw":false}}
```

Also accepted (server side, no sender yet): `wireguard` `{interfaces:[{name, publicKey,
listenPort, peers:[{publicKey, description, endpoint, allowedIps, latestHandshake, rxBytes,
txBytes}]}]}` and `packages` `{manager, installed:[{name, version}], upgradable: […] | null}`.
`seq`, `collectedAt` and `full` are informational; the server stamps everything with its
own receive time (the router's clock is ignored).

### 2.1 Field rules per part

| Part | Rules (server normaliser; caps are enforced again server side) |
|---|---|
| `interfaces` | Array, ≤ 256, one per `network`. `device` = L3 device, `ipv4`/`ipv6` = `addr/prefix` (≤ 32 each), `up`, `proto`, `defaultRoute`, `metric` (null = no routes), `uptimeSeconds`, `gateway4`/`gateway6` (default-route next hops), `dnsServers`, `error` (netifd's first error) |
| `dhcp` | Object. `leases4`/`leases6` missing = `[]` (the leases are a full snapshot). `hosts` missing = **not reported: the previous report's static hosts stay** (absent = never erase). `leases4[]`: `mac`, `ip`, `expires` required; `hostname`, `network` (the subnet's network, when the agent knows it), `leaseTime` (optional, seconds). `pools[]`: `network`, `ignore`, `leaseTime` (0 = infinite), `start`, `limit`; a lease's lease time is its own `leaseTime`, else its `network`'s pool's (renewal sightings, section 5). `leases6[]`: `duid`, `validUntil` required; `addresses`, `hostname`, `mac` (optional; else from DUID types 1/3, else the neighbour table). ≤ 4096 leases per family, ≤ 1024 hosts, ≤ 256 pools |
| `neighbors` | Array, ≤ 4096. `ip` (v4 or v6), `mac` (entries without one and broadcast/multicast MACs are dropped), `device`, `network` (optional), `reachable` (bool; when absent the server reads `state`, any case: `reachable`, `delay`, `probe`, `permanent` count) |
| `upnp` | Object. `installed` (absent = true; `false` = no miniupnpd), `enabled` (UCI), `running` (the process), `mappings[]` ≤ 512: `proto` `TCP`/`UDP` (any case), `extPort`/`intPort` 1–65535, `intIp`, `expires` (0 = permanent), `description` ≤ 128. One mapping per (proto, extPort), the later wins |
| `mwan3` | Absent when mwan3 is not installed (so present = installed). `serviceEnabled` (starts at boot), `running` (mwan3track), `configInterfaces[]` (UCI: `name`, `enabled`, `family`, `trackIps[]`), `configPolicies` (UCI: name → member names), `interfaces[]` (`ubus call mwan3 status`: `status`, `enabled`, `running`, `up`, `uptimeSeconds`, `tracking`, `trackIps[]` of `{ip, up}` or plain addresses), `policies` (live: name → `{interface, percent}[]`). Stored and served as `{service: {installed, enabled, running}, configInterfaces, configPolicies, interfaces, policies}`; the earlier draft `service: {installed, enabled, running}` input is also read. The live gateway: configured, service disabled, failover by two default routes with metrics (`interfaces[].defaultRoute/metric` show it) |
| `resolver` | `dnsmasqPort` (null without dnsmasq, 0 = its DNS off), `port53Process` (the listener on :53), `port53Processes[]`, `controllerHost` `{name, addresses[], error}` |
| `system` | `hostname`, `release`, `version`, `revision`, `board`, `boardName`, `model`, `kernel`, `uptimeSeconds`, `localtime`, `flowOffloading`, `flowOffloadingHw` |
| `wireguard` | Interfaces ≤ 16, peers ≤ 256. **Public keys and peer state only**; a private or preshared key sent by mistake is dropped |
| `packages` | `manager`, `installed[]` ≤ 4096, `upgradable[]` or null |

## 3. Tables

Collation `utf8mb4_unicode_ci`; all CASCADE with their collector. Migrations
`1779000000046` (base), `…060`–`…062`.

| Table | What | Written by |
|---|---|---|
| `gateway_hosts` | Runtime mirror, one row per (collector, MAC): DHCP facts (`hostname`, `static_name`, `ipv4`, `ipv6` JSON, `has_lease`, `lease_expires_at`, `lease_infinite`, `dhcp_present`, `dhcp_seen_at`) and neighbour facts (`neighbor_ipv4`, `neighbor_ipv6` JSON, `neighbor_device`, `neighbor_present`, `neighbor_reachable`, `neighbor_seen_at`), `network`, `first_seen_at`, `last_reported_at`. UNIQUE(collector_id, mac), INDEX(mac), INDEX(last_reported_at) | `gateway_dhcp.ts`, `gateway_neighbors.ts`, `refreshHostNetworks` |
| `gateway_observations` | Latest report per (collector, kind): `payload` (MEDIUMTEXT JSON: counts for `dhcp`/`neighbors`/`upnp`, the normalised part for the blob kinds), `fingerprint`, `observed_at`, `changed_at`. PK(collector_id, kind) | every part |
| `gateway_upnp_mappings` | Runtime mirror, UNIQUE(collector_id, proto, ext_port); `mac` resolved at ingest from `gateway_hosts` (lease address first, then neighbour) | `gateway_upnp.ts` |
| `gateway_upnp_events` | History: `opened` / `closed` per mapping (a changed target = close + open), with `mac` and `at` | `gateway_upnp.ts` |
| `gateway_backups` | `sysupgrade -b` archives, encrypted (section 8) | `gateway_backups.ts` |

Row rules for `gateway_hosts`:

- A `dhcp` report upserts the MACs it lists (`dhcp_present = 1`); rows it no longer lists
  lose their DHCP facts (`dhcp_present = 0`, names/addresses/lease cleared).
- A `neighbors` report does the same for the neighbour columns.
- A row neither report lists is **deleted at once when it never had a sighting**, else
  kept (its sightings feed presence and "last seen") until the retention task drops it
  `hostRetentionDays` after `last_reported_at`.
- `network` is derived from the latest `interfaces`: the subnet holding the lease address
  (else the neighbour address), longest prefix, else the neighbour's device; when the
  interfaces cannot place it, the `network` the agent sent with the lease or neighbour. Recomputed
  for every row of the collector after an interfaces, dhcp or neighbours write.
- The hostname lookup (`hostname_enrichment.ts`) reads only `dhcp_present = 1` rows.

`collectors:merge`: `gateway_hosts`, `gateway_observations`, `gateway_upnp_mappings` are
runtime mirrors in `NON_HISTORY_TABLES` and follow `--into` (the survivor ends with
`into`'s rows only); `gateway_upnp_events` and `gateway_backups` (also exempt from the
counter registry) keep every row of both sides, moved to the survivor
(`repointGatewayObservations`).

## 4. Ingest (`gateway_observe.ts`)

- Parts are ingested in a fixed order: `interfaces`, `neighbors`, `dhcp`, `upnp`, then
  the blob kinds (`mwan3`, `resolver`, `system`, `wireguard`, `packages`). DHCPv6 leases
  map to MACs through the neighbour table and UPnP targets through both, so those come
  first.
- One collector's observations run one at a time (a promise chain per collector with
  work in flight); a push's observation runs beside the traffic ingest, which may drop or
  coalesce pushes, and is never dropped itself.
- Non-fatal: a part that throws is logged (`gateway_observe: part write failed`) and
  costs that part only; the traffic ingest never waits for or fails on it.
- Fingerprints: per (collector, part) the SHA-256 of the normalised part, remembered in a
  bounded map (256 collectors, least recently written evicted; `gateway_observation_common.ts`)
  and in `gateway_observations.fingerprint` (survives restarts). An unchanged part writes
  nothing but `observed_at`, at most once a minute. Unchanged neighbours still refresh the
  reachable MACs' `neighbor_seen_at` (at most once a minute).
- Per-part outcome: `written` | `unchanged` | `invalid` | `failed` (returned by
  `recordGatewayObservation`, and by `POST /observe`).

## 5. Presence (`gatewaySightings`)

The gateway's own sightings of a device are a presence source, behind the integer
presence setting `gatewaySightings` (Settings → Presence, `system_settings.presence`;
`0`/`1`, default `1`):

- **Neighbour sighting**: `neighbor_seen_at` = the last report that listed the MAC as
  reachable.
- **DHCP sighting**: `dhcp_seen_at` = the last DHCP exchange the controller can date: a
  lease whose expiry moved forward since the previous report (a renewal happened, dated
  at receipt), or `expires − leaseTime` when the lease's lease time (its own, or its
  pool's from `dhcp.pools`) is ≤ 24 h. A
  first report dates nothing; the live gateway's 1200-day leases only give a sighting when
  a client actually renews.
- `devicePresence()` (`wifi_presence.ts`) takes `gatewaySeenAt = max(dhcp_seen_at,
  neighbor_seen_at)` (any gateway, per MAC) and, with the setting on, merges it into the
  traffic time: every rule that reads traffic reads it (`lanQuietMinutes`, the Wi-Fi
  trailing rule, the wired rule); `via` does not change (`lan` stays "Wired / unknown").
  Read per request by `queryGatewaySeenAt` (`device_presence_query.ts`) for `/devices`,
  `/devices/:mac/presence` and the infrastructure view; no query when the setting is off.

Deviation from plan 2 section 3, stated: plan 2 dates DHCP sightings only from a known lease
time ≤ 24 h. The controller also counts a forward-moving expiry, which is a real DHCP
exchange whatever the lease time.

## 6. Settings and retention

`system_settings` key `gateway_observations`, Settings → Gateway observation:

| Key | Default | Range | Meaning |
|---|---|---|---|
| `hostRetentionDays` | 14 | 1–365 | Unlisted host rows (and UPnP mappings of a gateway that stopped reporting UPnP) are kept this long |
| `upnpEventRetentionDays` | 90 | 1–730 | UPnP events |
| `backupsKept` | 10 | 1–50 | Newest backups kept per gateway |

`app/tasks/gateway_observation_retention.task.ts` runs daily at 03:50
(`pruneGatewayObservations`, batched deletes, ages against `UTC_TIMESTAMP()`).

## 7. REST API

All under `/api/v1`, `{ data }` envelope, errors `{ error, message }`. *user* = `auth +
requirePasswordChange` (any signed-in user); *admin* adds `requireAdmin` (403
`admin_required`). Anonymous = 401.

`:gatewayId` = `gateways.id`, the config plane's row of the gateway (config-plane.md; one per
adopted gateway collector, created on its hello or by `GET /gateways`), bound to an **adopted**
collector. Otherwise (unknown, detached, collector not adopted) 404 `gateway_not_found`. The
mirrors stay keyed by the collector; the mapping lives in one function,
`resolveObservedGateway` (`gateway_observation_read.ts`, over `resolveGateway`). Until the
integration (2026-09-23) `:gatewayId` was the collector id. `stale` = the part's last report is older than 1800 s (three full-resend
intervals).

```ts
type DeviceRef = { mac: string; name: string | null }   // a device Perch knows (traffic or label); name = label, else the router's name
type DhcpLease = { family: 4 | 6; mac: string | null; ip: string; hostname: string | null
  staticName: string | null; network: string | null; expiresAt: string | null; infinite: boolean
  seenAt: string | null /* latest gateway sighting */; reservationId: number | null /* config plane; null for now */
  device: DeviceRef | null /* null = no traffic data, e.g. a guest VLAN not captured */ }
type GatewayNeighbor = { mac: string; ipv4: string | null; ipv6: string[]; ifname: string | null
  network: string | null; reachable: boolean; seenAt: string | null; hostname: string | null; device: DeviceRef | null }
type UpnpMapping = { proto: 'TCP' | 'UDP'; externalPort: number; internalIp: string; internalPort: number
  description: string | null; expiresAt: string | null; firstSeenAt: string; device: DeviceRef | null }
type UpnpEvent = { id: number; event: 'opened' | 'closed'; proto: string; externalPort: number
  internalIp: string; internalPort: number; description: string | null; at: string; device: DeviceRef | null }
type ObservedInterface = { network: string; device: string | null; up: boolean; proto: string | null
  ipv4: string[]; ipv6: string[]; defaultRoute: boolean | null; metric: number | null; uptimeSeconds: number | null
  gateway4: string | null; gateway6: string | null; dnsServers: string[]; error: string | null }
type WanInterface = { network: string; ifname: string | null; up: boolean; proto: string | null
  ipv4: string[]; ipv6: string[]; metric: number | null; uptimeSeconds: number | null
  defaultRoute: boolean | null; gateway4: string | null; gateway6: string | null
  dnsServers: string[]; error: string | null; mwan3Status: string | null }
type BackupSummary = { id: number; createdAt: string; size: number; sha256: string
  release: string | null; filename: string | null; redacted: boolean
  redactions: { file: string; option: string | null; removed: boolean }[]
  note: string | null; requestedByUserId: number | null }
```

| Method + path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/gateways/:gatewayId/observation` | user | – | `{ gatewayId, collectorId, name, online, secure: boolean \| null, transport, capabilities: string[] \| null, hostname, release, flowOffloadingHw, parts: { [kind]: { observedAt, changedAt, secondsSinceReport, stale, counts: object \| null } } }` |
| GET `/gateways/:gatewayId/dhcp/leases` | user | `?network=` | `{ observedAt: string \| null, stale: boolean, leases: DhcpLease[] }` (IPv4 by address, then one IPv6 entry per address; static hosts without a lease are not leases) |
| GET `/gateways/:gatewayId/neighbors` | user | `?network=` | `{ observedAt, stale, neighbors: GatewayNeighbor[] }` |
| GET `/gateways/:gatewayId/interfaces` | user | – | `{ observedAt, stale, interfaces: ObservedInterface[] }` |
| GET `/gateways/:gatewayId/upnp` | user | – | `{ observedAt, stale, installed: boolean \| null, enabled: boolean \| null, running: boolean \| null, mappings: UpnpMapping[], events: UpnpEvent[] /* newest 200 */ }` |
| GET `/gateways/:gatewayId/wan-status` | user | – | `{ observedAt, mwan3: (Mwan3 & { observedAt }) \| null, defaultRoutes: string[] /* L3 devices carrying a default route, lowest metric first; the gateway report's WAN list when interfaces do not say */, wans: WanInterface[] }` |
| GET `/gateways/:gatewayId/system` | admin | – | `{ observedAt, hostname, timezone: null, zonename: null, ntp: null /* config plane */, board, boardName, model, release, version, revision, kernel, uptimeSeconds, flowOffloading, flowOffloadingHw, resolver: Resolver \| null, packageManager, packages: {name, version}[] \| null, upgradable: {name, version}[] \| null, features: { name, installed: boolean \| null, decision: 'observe' \| 'manage' \| 'never' \| 'later' }[] }` |
| GET `/gateways/:gatewayId/wireguard` | admin | – | `{ observedAt, stale, interfaces: Wireguard['interfaces'] }` |
| POST `/gateways/:gatewayId/observe` | admin | `{ parts?: ('interfaces'\|'neighbors'\|'dhcp'\|'upnp'\|'mwan3'\|'resolver'\|'system'\|'wireguard'\|'packages')[] }` | `{ observedAt, parts: { [part]: 'written' \| 'unchanged' \| 'invalid' \| 'failed' } }`. Errors: 409 `gateway_offline`; 409 `gateway_capability_missing {capability}` (no `gateway.observe`, or a named part the session did not announce); 504 `agent_timeout`; 502 `observe_failed`; 422 bad part name |
| GET `/gateways/:gatewayId/backups` | admin | – | `BackupSummary[]`, newest first (never the content) |
| POST `/gateways/:gatewayId/backups` | admin | `{ note?: string (≤ 200), redact?: boolean (default true) }` | 201 `BackupSummary`. Errors: 409 `gateway_offline`, 409 `gateway_capability_missing {capability: 'gateway.backup'}`, 409 `backup_redaction_required`, 504 `agent_timeout`, 502 `backup_failed`, 413 `backup_too_large` |
| GET `/gateways/:gatewayId/backups/:backupId/download` | admin | – | `application/gzip` attachment (`X-Content-SHA256`), the one non-`{data}` route. 404 `backup_not_found` |
| GET `/devices/:mac/network` | user | – | `{ gatewayId: number \| null /* gateways.id */, collectorId: number \| null, lease: DhcpLease \| null, reservation: null, dnsName: null, wanBlocked: WanAccessView \| null /* firewall.md section 5; null in mode off */, neighbor: { ipv4, ipv6, ifname, reachable, seenAt } \| null, network: string \| null, seenAt: string \| null, upnp: UpnpMapping[] }`. 400 `invalid_mac` |
| GET / PATCH `/settings/gateway-observations` | admin | PATCH any subset of section 6's keys | `{ settings, defaults, limits }`; 422 out of range |
| GET / PATCH `/settings/presence` | admin | adds `gatewaySightings: 0 \| 1` | unchanged shape, one more key |

Not built here (they need the config plane): `GET /gateways/:id/dhcp` (pools,
reservations), `/dns`, `/firewall`, `/routing`, `PATCH /system`, `POST /reboot`, and the
write routes of plan 2 section 5. `/api/v1/router` is unchanged.

## 8. Backups (`gateway.backup`)

Server → agent **request** `gateway.backup {redact: boolean}` (default `true`, timeout
60 s), gated by the hello capability `gateway.backup`. perch-collector answers

```json
{"filename":"backup-gateway-2026-09-23.tar.gz","createdAt":"2026-09-23T10:00:00Z",
 "release":"OpenWrt 24.10.2","size":20480,"sha256":"…","redacted":true,
 "redactions":[{"file":"/etc/config/wireless","option":"key"},{"file":"/etc/uhttpd.key","removed":true}],
 "contentBase64":"H4sI…"}
```

and refuses with -32000 `data.error` ∈ `backup_failed`, `backup_too_large` (> 8 MiB),
`backup_redaction_required` (`redact:false` while the router allows only redacted ones).
The server maps those to 502 `backup_failed`, 413 `backup_too_large`, 409
`backup_redaction_required`, checks base64, gzip magic, the size (≤ 8 MiB) and the
SHA-256, stores the archive encrypted with the app key (Adonis `encryption`) with its
`filename`, `redacted` and `redactions`, keeps the newest `backupsKept`, and logs only
id, size and user. Restore is never offered (a redacted archive would reset every secret).

## 9. Tests

- `tests/functional/collectors/gateway_observation.spec.ts`: the three ways in (socket
  notification via `tests/helpers/collector_agent.ts`, push, poll), absent/empty/unchanged
  semantics, row lifetimes, renewal and neighbour sightings, networks, UPnP events,
  gating, T-O1/T-O2 server side (leases per network; a silent device connected via lan
  from sightings, gone after `lanQuietMinutes`, the setting off), every REST route with
  authz (operator 403 on admin routes, anonymous 401, 404), `gateway.observe` and
  `gateway.backup` round trips, settings, retention, merge.
- `tests/unit/services/gateway_observation.spec.ts`: normalisers, CIDR, presence merge,
  bounded memory, backup decoding.
- `tests/functional/collectors/gateway_dhcp.spec.ts`: the `observe.dhcp` push path.
