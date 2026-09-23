# Managed gateway: networks (multi-LAN / VLAN)

Status: built with work package S5 (milestone M5, controller side, 2026-09-23). Contract for the
dashboard's Networks pages. The config plane underneath (sync, apply, confirm, rollback) is
`config-plane.md`; the router side (capture of several networks, the `networks` report, the scope
rule) is perch-collector's `CONFIG.md` ("Several networks") and `ARCHITECTURE.md`.

Placeholders only: 192.168.x.x, 203.0.113.x, MACs `02:00:00:…`.

| File | Role |
|---|---|
| `app/services/gateway_config/domains/networks.ts` | the `networks` domain: claims, round trip, validation, address and port helpers |
| `app/services/gateway_config/domains/dhcp_pools.ts` | the `dhcp_pools` domain (plan 2 section 4.1) |
| `app/services/gateway_config/network_model.ts` | sections → networks (`composeNetworks`); network edits → section edits (pure) |
| `app/services/gateway_config/networks_service.ts` | the REST operations: views, metadata rows, writes, the capture toggle |
| `app/services/gateway_config/gateway_config_service.ts` | `editDomainSections`: several domains' edits as one draft change |
| `app/services/gateway_network_accounting.ts` | the ingest of `gateway.networks` and `devices[].network`, capture flags, history reads |
| `app/controllers/gateway_networks_controller.ts` | routes of section 3 |

## 1. Model: native `network` config, 1:1

A **network** is one LAN-side `config interface` plus the L2 sections it rides on. Perch never
invents its own VLAN mechanism: VLANs are OpenWrt's `bridge-vlan` sections on a VLAN-filtering
bridge (DSA, OpenWrt ≥ 21.02), or `8021q` devices.

| `l2Mode` | UCI |
|---|---|
| `bridge` | `config device` (type `bridge`, `name br-<key>`, `list ports`) + `interface` with `device br-<key>` |
| `bridge_vlan` | `config bridge-vlan` (`device`, `vlan`, `list ports 'lan1:t' 'lan3:u*'`) + `interface` with `device <bridge>.<vid>` |
| `8021q` | `config device` (type `8021q`, `ifname`, `vid`, `name`) + `interface` on it; also a bare `eth1.30` netifd creates from the name |
| `device` | `interface` with a plain `device` |

The **key** of a network is its interface section's name (`lan`, `guest`, `vlan110`): the name
netifd, the firewall zones, DHCP pools and the collector's capture use. It never changes (delete and
re-create instead).

### 1.1 The `networks` domain (config `network`)

Claims, one section at a time (the engine checks the round trip per section on import):

- `interface` sections on the **LAN side**: proto `static` or `none`, not `loopback` (or device
  `lo`), no `gateway` option, not in a firewall zone with `masq`. WAN protocols (dhcp, pppoe,
  dhcpv6, …) and static WANs stay unmodeled (the routing sibling's).
- `device` sections of type `bridge`, `8021q` or `8021ad` with a `name`. A plain `device` section
  (a port's MAC or MTU override) stays unmodeled.
- every `bridge-vlan` section with `device` and `vlan`.
- Never: `globals`, swconfig `switch`/`switch_vlan` (pre-DSA targets), routes, rules.

Modeled options (the rest ride along verbatim and are kept on every write): interface `proto
device ifname ipaddr netmask ip6assign`; device `name type ports ifname vid`; bridge-vlan `device
vlan ports`. The whole section is Perch's (two-way merge per option; Authoritative Mode reverts any
router edit of it).

Merge rules: `device.ports` merges as a set; `bridge-vlan.ports` per port (`lan1:t` here and
`lan1:u*` there is a conflict on `lan1`, other ports merge). Equality normalises VLAN ids
(`0110` = `110`) and `ports 'a b'` = `list ports 'a' 'b'`. Identity keys: `device:<name>`,
`bridge-vlan:<device>.<vid>`.

**Validation** (errors block an apply of the touched sections; warnings do not):

| Code | Severity | When |
|---|---|---|
| `invalid_vlan` | error | a bridge VLAN or 802.1q VID outside 1–4094 |
| `vlan_in_use` | error | the VID is already on that bridge |
| `port_pvid_conflict` | error | a port is the untagged PVID (`*`) of two VLANs on one bridge |
| `invalid_port` | error | a bridge VLAN member that is not `port[:t|:u][*]` |
| `vlan_parent_required` | error | an 802.1q device without `ifname` |
| `invalid_ipaddr`, `invalid_netmask` | error | malformed address or mask |
| `subnet_overlap` | error | the interface's IPv4 subnet overlaps another interface's (static WAN addresses included; loopback not) |
| `port_not_in_bridge` | warning | a bridge VLAN member that is not a port of its bridge |
| `vlan_missing` | warning | an interface on `<bridge>.<vid>` of a VLAN-filtering bridge without that `bridge-vlan` |

### 1.2 The `dhcp_pools` domain (config `dhcp`)

`config dhcp '<net>'` sections with an `interface` that is not WAN-side. Perch owns `interface
ignore dhcpv4 start limit leasetime dhcp_option domain force`; the IPv6 side (`ra dhcpv6 ndp
ra_flags ra_slaac dns`), `master` and anything newer stay the router's (never a conflict, never
drift). `dhcp_option` merges per option code. Identity key `pool:<interface>`. Validation:
`duplicate_pool`, `invalid_pool_range`, `invalid_leasetime` (errors); `pool_outside_subnet`,
`pool_includes_router` (warnings).

### 1.3 Firewall zones (not yet)

There is no firewall domain yet (README M7). A network's zone is shown read-only
(`firewallZone`: the zone whose `network` list names it). A write that names a zone is refused with
409 `firewall_not_managed` before anything changes; add the network to a zone on the router (LuCI)
meanwhile. When the firewall domain lands, the same `editDomainSections` call carries the zone's
`network` list edit, so network, pool and zone stay one apply (plan 1 section 8.1 "wizard").

### 1.4 Perch-only metadata (`gateway_networks`)

`label` (≤ 80), `purpose` (`lan | guest | iot | management | custom`), `capture` (default true), when
and by whom `capture` last changed. Never written into UCI. One row per network, matched by the
interface's `perch_id` first (survives a rename on the router), else by name; created lazily when
the networks are listed (like the infrastructure view's agent nodes). A network known only from the
collector's report (a gateway in mode `off`, or a network netifd has but the plane does not model)
gets a row by name, so labels and the capture toggle work without the config plane. Rows of networks
gone from both the config and the report are dropped (only while a report is at hand). Default
purpose from the name: `lan` → lan, `guest*` → guest, `iot*` → iot, `mgmt`/`manage*` → management,
else custom.

## 2. Writes, applies and the management path

Every write goes into the draft through `editDomainSections(gatewayId, userId, [{domain:
'networks', edits}, {domain: 'dhcp_pools', edits}])`: each batch is planned against the rows as the
batches before left them, validation runs once over the result, everything is stored in one
transaction (or nothing: 409/422). Unless `?apply=0`, the touched sections then go into **one apply
request** (`requestApply({perchIds})`), which the planner splits into jobs and chains (up to 5):

1. adoption of named, unledgered sections (no confirm window);
2. the ordinary job;
3. the **protected** job: sections on the management path (README 3.8), confirmed with
   `managementConfirmTimeoutSeconds` (default 300 s) instead of `confirmTimeoutSeconds` (90 s).

The management path is the router's `ip route get <controller>` (`gateways.management_path`
`{network, device}`). Protected: the path's interface, any interface on its device, the `device`
section that is the path's device or its parent bridge, a `bridge-vlan` on that bridge (or the
path's `<bridge>.<vid>`), the firewall zone listing the network, firewall `defaults`. DHCP pools are
never on the path.

**Converting an untagged bridge.** The first `bridge_vlan` network on a bridge without any
`bridge-vlan` makes it VLAN-filtering, in the same draft change:

- a `bridge-vlan` for `untaggedVlan` (default 1) with every current member as `port:u*`, except the
  ports the new VLAN makes its own untagged PVID ports;
- every interface on the bare bridge moves to `<bridge>.<untaggedVlan>` (other options kept);
- all of them must be synced `networks` sections, else 409 `conversion_needs_sync {perchIds}`.

On the management bridge (the usual `br-lan`) the new interface goes out first in the ordinary job,
then the VLAN 1 `bridge-vlan`, the moved `lan` interface and the new VLAN's `bridge-vlan` in the
protected job. If the protected job rolls back, the new interface stays (its device does not exist
yet, netifd keeps it down) and the draft keeps the rest to retry. The response says `converted:
{bridge, untaggedVlan, moved}`.

**Delete** removes the interface, the L2 sections only it used (its bridge VLAN, 802.1q device, or a
bridge nothing else rides on) and its pool, when Perch manages them (else a `section_kept` warning).
The network carrying the management path is refused (409 `management_network`).

## 3. REST

All under `/api/v1`, `{ data }` envelopes, refusals `{ error, message, …data }`. Reads: any
signed-in user; writes: admin (403 `admin_required`); anonymous 401. `:id` = `gateways.id`,
`:networkId` = `gateway_networks.id` (numeric). Common refusals as in `config-plane.md` section 10
(404 `gateway_not_found`, 503 `gateway_busy`, …).

### 3.1 Types

```ts
type NetworkPort = { port: string; tagged: boolean; pvid: boolean }   // 'lan1:t' = {tagged, !pvid}; 'lan3:u*' = {!tagged, pvid}
type DhcpPoolView = { perchId: string; section: string; enabled: boolean; start: number | null
  limit: number | null; leaseTime: string | null; owner: 'perch' | 'router'; status: SectionStatus }
type CaptureCounters = { bytesInWan: number; bytesOutWan: number; bytesInLan: number; bytesOutLan: number
  packetsInWan: number; packetsOutWan: number; packetsInLan: number; packetsOutLan: number
  scope: 'routed' | 'legacy' | null; kernelDrops: number | null }       // the collector's, cumulative
type NetworkLive = {
  reportedAt: string                 // the report (or, without one since a restart, the newest sample)
  up: boolean | null; device: string | null; proto: string | null; ipv4: string[]; ipv6: string[]
  rxBytes: number | null; txBytes: number | null  // router side: rx = received from the network
  rxBps: number | null; txBps: number | null      // bits/s, router side
  downloadBps: number | null; uploadBps: number | null   // client terms: download = txBps, upload = rxBps
  captured: boolean | null; devices: number | null; activeDevices: number | null
  capture: CaptureCounters | null }
type GatewayNetwork = {
  id: number                         // gateway_networks.id = :networkId
  gatewayId: number; key: string; label: string
  purpose: 'lan' | 'guest' | 'iot' | 'management' | 'custom'
  capture: boolean; captureChangedAt: string | null
  perchId: string | null             // the interface section; null = known from the report only
  owner: 'perch' | 'router' | null   // synced | mirrored (excluded/unmodeled) | report only
  l2Mode: 'bridge' | 'bridge_vlan' | '8021q' | 'device' | null
  bridge: string | null; vlanId: number | null; parentDevice: string | null; device: string | null
  proto: string | null; ports: NetworkPort[]; ipv4: string | null; ipv4All: string[]   // '192.168.1.1/24'
  status: SectionStatus | null       // worst of its sections (conflict > drift > reverting > pending > ahead > in_sync)
  deleting: boolean                  // the draft removes it
  management: boolean                // the network the agent reaches the controller through
  sections: string[]                 // perch ids: interface first, then its own L2 sections
  dhcp: DhcpPoolView | null; firewallZone: string | null
  live: NetworkLive | null }
type NetworkWrite = { object: GatewayNetwork | null; issues: Issue[]
  converted: { bridge: string; untaggedVlan: number; moved: string[] } | null
  apply: GatewayApply | null         // the first job of the request (config-plane.md 10.1), with `changes`
  applyError: { error: string; message: string } | null }   // why no apply started; the draft is kept
```

`SectionStatus`, `Issue`, `GatewayApply`: `config-plane.md` section 10.1.

### 3.2 Endpoints

| Method, path | Request | Response `data` | Refusals |
|---|---|---|---|
| `GET /gateways/:id/networks` | – | `GatewayNetwork[]` (config order, report-only networks last) | 404 |
| `GET /gateways/:id/networks/:networkId` | – | `GatewayNetwork` | 404 `network_not_found` |
| `POST /gateways/:id/networks[?apply=0]` | `NetworkCreate` | 201 `NetworkWrite` | see below |
| `PATCH /gateways/:id/networks/:networkId[?apply=0]` | `NetworkPatch` | `NetworkWrite` | see below |
| `DELETE /gateways/:id/networks/:networkId[?apply=0]` | – | `NetworkWrite` (`object.deleting` until applied) | 404; 409 `not_managed`, `network_not_managed`, `management_network`, `pending_apply` |
| `GET /gateways/:id/networks/history?range=24h\|from&to&resolution=auto\|1m\|5m\|15m\|1h&network=` | – | `NetworkHistory` | 400 `invalid_window`/`invalid_range`; 404 |
| `GET /networks` | – | `NetworkSummary[]` (every gateway) | – |
| `GET /networks/scope-changes` | – | `ScopeChange[]` (every gateway, oldest first) | – |
| `GET /devices/:mac/networks` | – | `{ mac, latest: { gatewayId, network, seenAt } \| null, history: DeviceNetworkInterval[] }` | 400 `invalid_mac` |

```ts
type NetworkCreate = {
  key: string                        // ^[a-z][a-z0-9_]{0,14}$, not taken in /etc/config/network
  l2Mode: 'bridge' | 'bridge_vlan' | '8021q' | 'device'
  bridge?: string | null             // bridge_vlan: an existing bridge (required); bridge: the name (default br-<key>)
  vlanId?: number | null             // bridge_vlan, 8021q: 1–4094
  parentDevice?: string | null       // 8021q: parent (eth1 → eth1.<vid>); device: the device itself
  ports?: NetworkPort[]              // bridge: members; bridge_vlan: VLAN members (added to the bridge when missing)
  ipv4?: string | null               // router address with prefix /8–/30; null/absent = proto none
  dhcp?: { enabled?: boolean; start: number; limit: number; leaseTime: string } | null   // needs ipv4
  untaggedVlan?: number              // bridge_vlan conversion only (default 1)
  label?: string; purpose?: GatewayNetwork['purpose']; capture?: boolean
  firewallZone?: string | null       // non-null: 409 firewall_not_managed (section 1.3)
}
type NetworkPatch = {                // every field optional; label/purpose/capture work in any mode
  ipv4?: string | null; ports?: NetworkPort[]; vlanId?: number
  dhcp?: { enabled?: boolean; start: number; limit: number; leaseTime: string } | null   // null = remove the pool
  label?: string; purpose?: GatewayNetwork['purpose']; capture?: boolean; firewallZone?: string | null }
type NetworkHistory = { gatewayId: number; range: string | null; from: string; to: string
  resolution: string; resolutionSeconds: 60 | 300 | 900 | 3600
  scopeAtStart: 'routed' | 'legacy' | null   // the scope rule in force at `from`
  scopeChanges: Array<{ scope: 'routed' | 'legacy'; changedAt: string }>   // inside the window
  networks: Array<{ network: string; points: Array<{ bucketStart: string; ts: number
    rxBps: number | null; txBps: number | null         // bucket averages of the 30 s rates, router side
    rxPeakBps: number | null; txPeakBps: number | null }> }> }
type NetworkSummary = { gatewayId: number; id: number; key: string; label: string; purpose: string
  vlanId: number | null; ipv4: string | null; capture: boolean; captured: boolean | null; up: boolean | null
  rxBps: number | null; txBps: number | null; downloadBps: number | null; uploadBps: number | null
  devices: number | null; activeDevices: number | null; management: boolean }
type ScopeChange = { gatewayId: number; scope: 'routed' | 'legacy'; changedAt: string }
type DeviceNetworkInterval = { gatewayId: number; network: string; startedAt: string; endedAt: string | null }   // newest first, ≤ 200
```

**Refusals of `POST` / `PATCH`** (checked before anything is stored):

| Status, code | When |
|---|---|
| 409 `not_managed` | the gateway is not in mode `managed` (config fields; metadata alone never needs it) |
| 409 `openwrt_too_old` | the router's release predates 21.02 (`config device` syntax) |
| 409 `firewall_not_managed` | `firewallZone` given (section 1.3) |
| 409 `network_key_taken` | a `network` section of that name exists |
| 409 `dhcp_pool_exists` | the router already has a pool for the new key |
| 409 `network_not_managed` | the network (or its bridge VLAN / VLAN device) is not synced, or known from the report only |
| 409 `bridge_not_managed` | ports to add to a bridge Perch does not manage |
| 409 `bridge_exists` | `bridge` mode: a device of that name exists |
| 409 `port_in_use` {port, bridge} | the port belongs to another bridge |
| 409 `conversion_needs_sync` {perchIds} | converting a bridge whose interfaces are not synced |
| 409 `dhcp_pool_not_managed` | editing a pool the router owns |
| 409 `pending_apply` | an apply carrying one of the sections is running |
| 422 `network_key_invalid`, `vlan_invalid`, `ipv4_invalid`, `port_invalid`, `device_name_too_long` (> 15), `parent_device_required`, `l2mode_invalid` | malformed input |
| 422 `bridge_not_found` | `bridge_vlan` on a bridge that does not exist |
| 422 `vlan_in_use` {vlanId} | the VID is on that bridge already (or is its untagged VLAN) |
| 422 `port_pvid_conflict` {port, vlanId} | a port that is already another VLAN's untagged PVID port |
| 422 `subnet_overlap` {network, cidr} | the address overlaps another interface |
| 422 `dhcp_needs_address`, `dhcp_range_invalid`, `dhcp_leasetime_invalid`, `dhcp_range_outside_subnet` | pool input |
| 422 `vlan_not_applicable`, `ports_not_applicable` | the field does not fit the network's mode |
| 422 `invalid_config` {issues} | the draft would carry a validation error on a touched section |

Warnings come back in `issues` and never block: the domains' (section 1), `port_unknown` (a port
that is not among the gateway node's infrastructure ports, `infra_ports.port_key`, when the agent
reports any; plan 1 section 8.2) and, on delete, `section_kept` (an L2 section or pool the router
owns stays). Vine errors: 422 `{ errors: [...] }`. The events log (`GET /gateways/:id/events`) gets
`draft_edited` (with `domains`), `network_labelled` {network, label?, purpose?} and
`network_capture_changed` {network, capture}.

## 4. Accounting (plan 1 section 8.3, README 7.8)

Fed by every ingested reading of the collector on the router (socket push or poll), non-fatal for
the traffic ingest:

### 4.1 `gateway.networks` → samples and the live report

The report (CONFIG.md "Several networks") lists every LAN-side network, up or down, captured or not.
Absent = not reported (nothing is touched), `[]` = none. Untrusted: ≤ 64 networks, names ≤ 15
characters `[A-Za-z0-9_.-]`, one entry per name. The newest report per gateway is kept in memory
(`live`; bounded, 1024 gateways). At most every 30 s per gateway (the `router_samples` grid) each
network with counters becomes a `gateway_network_samples` row: `rx_bytes`/`tx_bytes` (router side:
rx = received from the network) and `rx_bps`/`tx_bps` = bits/s since the previous row (null on the
first row after a controller restart and after a counter went backwards). Retention:
`ROUTER_SAMPLE_RETENTION_DAYS`, pruned with `router_samples`.

### 4.2 The scope-change marker

Each network's `capture.scope` says which rule splits WAN/LAN: `routed` (owner decision 8: routed
LAN↔LAN traffic and traffic to the router's own LAN addresses count as LAN) or `legacy`. The
gateway's scope is `routed` when any network says so, else `legacy`; a change (and the first
observation) is a `gateway_scope_changes` row. Charts of WAN/LAN splits mark the dates
(`GET /networks/scope-changes`, and `scopeAtStart` + `scopeChanges` of a history window): before a
`routed` mark, router-address and routed traffic counted as WAN.

### 4.3 Device networks

A device row's `network` (the capture network where the MAC was last an endpoint) is written only
when it changed since the last write this process saw (bounded fingerprint map, 4096 entries): an
upsert of `device_network_latest` (PK gateway, MAC; `seen_at` = when it moved there) and a new
interval in `device_network_history` (the previous open interval of the MAC gets `ended_at`).
Closed intervals are pruned after the hourly retention (730 d). `/devices` rows and
`/devices/:mac/presence` carry `network: { gatewayId, name, since } | null` (the newest over all
gateways), read per request.

Per-device traffic per network is these intervals laid over the device's buckets (a phone moving
from the guest SSID to the main one keeps its MAC, so the bucket key does not carry the network;
plan 1 Q7).

## 5. Capture per network (README 7.21)

`gateway_networks.capture` (default true) says whether Perch accounts a network's devices at all (a
commercial operator decides for its guest network; privacy law). Turning it off
(`PATCH …/networks/:networkId {capture: false}`, any gateway mode):

- `agent.configure` to the collector gains `capture: { exclude: ["guest"] }` (sent at once when it is
  online, and with every configure while a gateway row exists; `[]` = capture everything the router
  selects), to be added to the collector's own `capture_exclude` (router side: not in
  perch-collector yet; the field is ignored until it is). A collector that ignores it keeps
  capturing, so
- the controller also drops every device row whose `network` is excluded before the traffic ingest:
  no buckets, identities, peers or device networks are stored for it.

The per-network interface counters (`rxBytes`/`txBytes`, section 4.1) are the router's own and stay.

## 6. Storage

Migrations `1779000000050` (tables) and `052`:

| Table | Notes |
|---|---|
| `gateway_networks` | + `network` (name, UNIQUE per gateway), `interface_perch_id` nullable, `capture_changed_at`, `capture_changed_by_user_id` → users SET NULL |
| `gateway_network_samples` | PK (gateway, network, recorded_at) |
| `device_network_latest` | PK (gateway, MAC) |
| `device_network_history` | id, gateway, MAC, network, `started_at`, `ended_at` (NULL = open) |
| `gateway_scope_changes` | id, gateway, `scope`, `changed_at` |

All hang off `gateways` (ON DELETE CASCADE); `collectors:merge` moves them with their gateway.
