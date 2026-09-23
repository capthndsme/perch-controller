# Perch infrastructure view: ports, topology and the network map (design, 2026-09-23)

Status: design. This is the contract four streams build from in parallel
(perch-apd, perch-collector, controller, dashboard). Later changes go in as
dated amendments at the end, like `docs/collector-agent.md`.

Scope: a **network layout configurator** — one page that shows what Perch's
agents are (gateway, access points), what the operator tells it about
(switches, routers, modems, hosts, the ISP), which **Ethernet ports** each
device has, which of them have a link right now, and how they are **cabled to
each other**. Agent-backed devices and their ports appear on their own; cables
and everything unmanaged are the operator's to draw.

What this is not: it does not change anything on the network. Perch never
enables, disables or renames a port. The view is read-only towards the
hardware; only the controller's own layout rows are written.

```
   ISP ───────── Modem/ONT ─────── Gateway agent (perch-collector, gateway stats)
                                        │ lan0
                                     Switch (manual, 8 ports)
                                   ┌────┴────┬──────────┐
                              AP (perch-apd)  AP        NAS (device)
```

Contents

1. [What v1 is](#1-what-v1-is)
2. [Ground truth: what a "port" is on the devices Perch runs on](#2-ground-truth-what-a-port-is-on-the-devices-perch-runs-on)
3. [The port model](#3-the-port-model)
4. [Agent transports](#4-agent-transports)
5. [Server storage](#5-server-storage)
6. [Topology model](#6-topology-model)
7. [REST API](#7-rest-api)
8. [Dashboard](#8-dashboard)
9. ["Gateway agent" wording](#9-gateway-agent-wording)
10. [Threat model](#10-threat-model)
11. [Phasing](#11-phasing)
12. [Tests](#12-tests)
13. [Work packages](#13-work-packages)
14. [Open questions](#14-open-questions)
15. [Appendix A: worked example](#appendix-a-worked-example)
16. [Appendix B: error codes](#appendix-b-error-codes)

---

## 1. What v1 is

**In v1**

- Every agent reports its Ethernet ports with live link state (carrier, admin
  state, operstate, speed, duplex, carrier changes): the **Gateway agent**
  (the `perch-collector` instance that runs on the router with gateway stats
  on) and every **Perch AP Daemon** (`perch-apd`).
- The controller stores a **latest-state** port row per agent port, plus a
  topology of nodes, ports and links the operator edits.
- Nodes for agent-backed devices are created automatically and bound to their
  `collectors` / `wifi_access_points` row.
- Manual nodes: unmanaged switch (N ports, optionally with SFP cages), router,
  modem/ONT, ISP uplink, host (a frame that can contain other nodes, for a
  gateway that runs in a VM or container), generic device, generic access
  point, and a generic device **bound to a MAC from Perch's device list**
  (shows its label name, type and presence).
- Links: port to port, one link per port, media `ethernet`, `fiber`,
  `virtual` (a bridge or veth inside a host) and `wireless`.
- Manual ports can be **pinned by hand** on an agent node whose agent is too
  old to report ports (perch-apd 0.1.2, perch-collector 0.2.0, node_exporter
  scrape rows). When a newer agent later reports a port with the same key, the
  pinned port is adopted and keeps its cable.
- One new page, `/infrastructure`, lazy-loaded as its own route chunk, with an
  edit mode for admins and a read-only view (including phones) for everyone
  else.

**Not in v1** (see [§11](#11-phasing)): FDB/LLDP-based link suggestions,
per-port traffic charts, link diagnostics (negotiated vs. supported vs.
partner-advertised), automatic "Ethernet device" labelling, port history,
drag-to-reparent, VLAN overlays, floor plans.

**Today's agents must not regress.** perch-apd 0.1.2 and perch-collector 0.2.0
report no ports; the server, the API and the page work with them (nodes exist,
ports are empty, the operator can pin ports by hand) and light up by themselves
when upgraded agents connect. Releasing the new daemons and installing them is
the owner's call; nothing here waits on it.

---

## 2. Ground truth: what a "port" is on the devices Perch runs on

Read-only survey of the four devices Perch runs on today (three OpenWrt access
points on three different SoC families, and a gateway that is an OpenWrt
container on an x86 host). Everything below is what `/sys/class/net`,
`/etc/board.json` and `ubus call network.device status` actually contain;
addresses, host names and models are left out on purpose.

**Three different ways a router-class Linux box exposes its ports**

| Kind | What the netdevs look like | How to recognise a port |
|---|---|---|
| **DSA switch** (MediaTek MT7621/MT7981 class) | `eth0` is the CPU conduit and has a `dsa/` directory (`dsa/tagging=mtk`) with `upper_lanN` links; the user ports `lan1…lanN` are netdevs with `uevent` `DEVTYPE=dsa`, `phys_port_name=p0…pN`, `phys_switch_id`, `iflink` pointing at the conduit, `of_node/label=lanN`, and the conduit's MAC | `DEVTYPE=dsa` ⇒ port; `dsa/` directory ⇒ conduit, **not** a port |
| **Per-port netdevs** (Qualcomm IPQ807x class, driver `nss-dp`) | `lan1…lan4` and `wan` are independent netdevs, each with its own `device` link (`…/dpN`), no `DEVTYPE`, `iflink == ifindex`, label in `device/of_node/label` | has a `device` symlink, no `dsa/`, not wireless ⇒ port |
| **Separate MAC ports** (a second GMAC used as WAN on both MediaTek boards) | `wan` / `eth1` with a `device` link, `of_node/label=wan`, no `DEVTYPE` | same rule as above |

**A gateway may have no hardware port at all.** The gateway surveyed is an
OpenWrt container: every interface is a `veth` (no `device` symlink, `iflink`
pointing into another namespace, MAC from the container runtime's OUI,
`speed=10000`), plus one `ifb` for SQM. Its `board.json` is the host's and
names an interface that is not a port. The physical cabling lives one level
down, on the host: three PCIe NICs, one in a bridge with the container's WAN
veth, one in a bridge with the container's LAN veth, one unplugged with VLAN
sub-interfaces. **So the model must allow a router whose ports are virtual, and
a "host" node whose bridges are switches.** This is exactly what
[§6.2](#62-node-kinds) and [Appendix A](#appendix-a-worked-example) do.

**Other findings that shaped the rules**

- `/sys/class/net` contains entries that are not devices (`bonding_masters` is
  a regular file); tunnels (`gre0`, `gretap0`, `erspan0`) are `type=1` with
  `iflink=0`; `miireg` has `type=0`.
- `speed` reads `-1` and `duplex` reads `unknown` on a port without carrier;
  `operstate` is `lowerlayerdown` for a DSA user port whose conduit is up but
  whose socket is empty, and `down` for a MAC-backed port.
- `/etc/board.json` gives the roles and the physical order:
  `network.lan.ports` (array) or `network.lan.device`, `network.wan.device` or
  `network.wan.ports`. Two of the three APs use the case's WAN socket as a LAN
  uplink (it is a bridge member) — the **role stays `wan`**, because that is
  what is printed on the case; which port is the uplink is a different
  question and is answered by the cables the operator draws.
- `ubus call network.device status` has richer data (`devtype`, `speed`
  `"1000F"`, `link-supported`, `link-partner-advertising`) but is a large JSON
  document (1 200+ lines on a four-port AP) and only lists devices netifd
  manages. Too expensive to parse every 5 s on a MIPS AP; `/sys` is cheaper and
  works off OpenWrt. Kept in reserve for [§11](#11-phasing) link diagnostics.
- `ip -d link` is BusyBox on the APs (no `-d`), `bridge` is not installed.
  Nothing may depend on either.

### 2.1 The detection rules (normative)

An entry of `/sys/class/net` is a **port** when, in this order:

1. it is a directory (skips `bonding_masters`), and its name is not `lo`;
2. `type` is `1` (ARPHRD_ETHER);
3. it is not wireless: no `phy80211/` and no `wireless/` directory, and
   `uevent` does not say `DEVTYPE=wlan`;
4. `uevent` says `DEVTYPE=dsa` ⇒ **hardware port**, done;
5. `uevent` says `DEVTYPE=` one of `bridge`, `vlan`, `bond`, `team`, or a
   `bridge/`, `bonding/` or `brif/` directory exists ⇒ skip;
6. a `dsa/` directory exists ⇒ DSA CPU conduit ⇒ skip;
7. a `device` symlink exists ⇒ **hardware port**;
8. otherwise, `iflink` is neither `0` nor equal to `ifindex` **and** there is
   no `lower_*` symlink ⇒ **virtual NIC** (a veth or macvlan whose other end is
   in another network namespace: what a router in a container has instead of
   ports). Subject to the virtual policy in [§4.1](#41-shared-perch-agentkit);
9. otherwise skip (ifb, dummy, tun/tap, tunnels, stacked devices).

Note on step 8: a veth's `iflink` is an index in the **peer's** namespace and
may collide with a local index (observed on the surveyed gateway: the
container's `eth0` has `iflink=22` and a local `ifb` interface has
`ifindex=22`). Never resolve `iflink` against the local index table; the
`lower_*` symlink is the reliable "is stacked on a local device" test.

Per-port facts:

| Field | Source |
|---|---|
| `name` | directory name |
| `label` | `of_node/label`, else `device/of_node/label`, else the name |
| `role` | `wan` if named by `board.json` `network.wan.device` / `.ports`, or (collector only) if the interface holds a default route; `lan` if named by `network.lan.device` / `.ports`; else absent |
| `medium` | `sfp` when `of_node/sfp` or `device/of_node/sfp` exists; `virtual` for step-8 devices and for drivers `virtio_net`, `vmxnet3`, `hv_netvsc`, `xen-netfront` (`device/driver` basename); else `copper` |
| `mac` | `address` (DSA user ports share the conduit's MAC — informational only, never a key) |
| `adminUp` | `flags` (hex) & `0x1` |
| `carrier` | `carrier` (`1`/`0`; omitted when the read fails, which happens on an admin-down port) |
| `operstate` | `operstate` verbatim |
| `speedMbps` | `speed` when > 0 (omit on `-1` / EINVAL) |
| `duplex` | `duplex` when `full` or `half` |
| `carrierChanges` | `carrier_changes` |

Order of the reported array = display order: `role=wan` ports first, then the
`board.json` LAN order, then the rest naturally sorted (`lan2` before `lan10`).

---

## 3. The port model

A **port** is one Ethernet socket (or the virtual NIC that stands in for one),
as one device sees it. It belongs to exactly one node, carries at most one
link, and is identified inside its node by a **key**:

- agent ports: the netdev name (`lan1`, `wan`, `eth1`, `lan0`). Stable across
  reboots on every platform surveyed, and the one identifier the operator also
  sees in LuCI and in `logread`;
- manual ports: whatever the operator types, validated the same way
  (`^[A-Za-z0-9][A-Za-z0-9._@:-]{0,31}$`). The "add ports" form suggests
  `wan`, `lan1`, … precisely so that a port pinned by hand on an old agent is
  **adopted** by key when a port-reporting agent arrives.

Port fields, and who owns each:

| Field | Owner | Notes |
|---|---|---|
| `key` | agent (netdev name) or operator | unique per node |
| `reportedLabel`, `reportedRole` | agent | last report wins |
| `label`, `role` | operator | override; `null` = use the agent's |
| `medium` | agent, operator may override | `copper` / `sfp` / `virtual` / `wireless` |
| `mac` | agent | display only |
| `position` | agent (report order) or operator | display order |
| `hidden` | operator | keeps the strip readable (a container gateway reports one veth per VLAN zone) |
| `present`, `missingSince` | server | the agent stopped reporting this port |
| `adminUp`, `carrier`, `operstate`, `speedMbps`, `duplex`, `carrierChanges`, `stateChangedAt`, `reportedAt` | agent | live state; `null` on manual ports |

There is deliberately **no port-level history** in v1: the state table is a
latest-state mirror like `wifi_network_latest` / `ap_system_latest`.
Per-port traffic charts already have their data (`node_network_*_total` in the
AP push, `/proc/net/dev` on the gateway) and are [§11](#11-phasing) work.

---

## 4. Agent transports

Both daemons report the **same JSON array**, produced by one function in
`perch-agentkit`, so the controller has a single schema to validate.

### 4.1 Shared: perch-agentkit

New in the kit's `hoststat` package (kit tag **v0.2.0**; then bump both
daemons' `go.mod` and the root `go.work` `replace`):

```go
// Port is one Ethernet port of the host as the kernel describes it
// (docs/infrastructure-view.md §2.1 in perch-controller). Fields the kernel
// does not answer for are left out rather than guessed.
type Port struct {
    Name           string  `json:"name"`
    Label          string  `json:"label,omitempty"`
    Role           string  `json:"role,omitempty"`   // "wan" | "lan"
    Medium         string  `json:"medium,omitempty"` // "copper" | "sfp" | "virtual"
    MAC            string  `json:"mac,omitempty"`
    AdminUp        *bool   `json:"adminUp,omitempty"`
    Carrier        *bool   `json:"carrier,omitempty"`
    Operstate      string  `json:"operstate,omitempty"`
    SpeedMbps      *int    `json:"speedMbps,omitempty"`
    Duplex         string  `json:"duplex,omitempty"`  // "full" | "half"
    CarrierChanges *uint64 `json:"carrierChanges,omitempty"`
}

// VirtualPolicy decides whether NICs whose peer is in another network
// namespace count as ports.
type VirtualPolicy string

const (
    // VirtualAuto reports them only when the host has no hardware port at
    // all: a router in a container has nothing else (§2).
    VirtualAuto   VirtualPolicy = ""
    VirtualNever  VirtualPolicy = "never"
    VirtualAlways VirtualPolicy = "always"
)

// BoardPorts is /etc/board.json's port roles, in board order.
type BoardPorts struct{ LAN, WAN []string }

func (f FS) BoardPorts() BoardPorts

type PortOptions struct {
    Virtual VirtualPolicy
    // WAN marks extra interfaces as role "wan" (the collector passes the
    // interfaces its gateway stats count).
    WAN []string
    // Max caps the result (default 64).
    Max int
}

// PortReader reads ports repeatedly, caching the facts that do not change
// (label, role, medium, MAC, device type) for TTL (default 5 min) per
// name+ifindex, so a 5 s push costs one ReadDir and ~7 small reads per port.
type PortReader struct {
    FS      FS
    Options PortOptions
    TTL     time.Duration
    // unexported cache
}

func (r *PortReader) Read() []Port

// Ports is the one-shot form (CLI, tests).
func (f FS) Ports(o PortOptions) []Port
```

Rules are [§2.1](#21-the-detection-rules-normative) verbatim. `Read()` never
fails: a file it cannot read means an omitted field, a directory it cannot read
means an empty slice. The kit is the lead's; both daemon streams treat it as
read-only and report gaps.

### 4.2 perch-apd (access points)

**Wire change**: `metrics.push` gains one optional param, `ports`:

```json
{"jsonrpc":"2.0","method":"metrics.push","params":{
  "format":"prometheus-text",
  "text":"# TYPE node_load1 gauge\nnode_load1 0.04\n…",
  "collectedAt":"2026-09-23T11:20:36Z","durationMs":14,"seq":42,
  "ports":[
    {"name":"wan","label":"wan","role":"wan","medium":"copper","mac":"02:00:00:00:00:11",
     "adminUp":true,"carrier":false,"operstate":"down"},
    {"name":"lan1","label":"lan1","role":"lan","medium":"copper","mac":"02:00:00:00:00:10",
     "adminUp":true,"carrier":true,"operstate":"up","speedMbps":1000,"duplex":"full","carrierChanges":3}
  ]}}
```

- Sent on **every** push, with every port the device has, present state
  included; inventory and state travel together, so there is no second path to
  keep in sync and no "inventory changed" event to miss. Cost measured against
  the current push: ~40 sysfs reads and ~120 bytes per port before
  permessage-deflate.
- Omitted entirely when the daemon cannot enumerate ports or `ports` is off in
  its config (`option ports '0'`); `"ports": []` means "I looked and found
  none". The controller treats **absent** as "this agent does not report
  ports" and **empty** as "no ports".
- `system.info` gains `"ports"` in `capabilities` when the build supports it
  and enumeration returned at least one port. The controller already stores
  and serialises `capabilities` unchanged
  (`app/services/ap_agent_registry.ts:264`,
  `app/transformers/wifi_access_point_transformer.ts:42`), so Settings →
  Wi-Fi sources shows it with no server change.
- No `agent.configure` negotiation. The push params are additive and an old
  controller ignores them: `PushParams` in
  `app/services/ap_agent_metrics.ts:89` reads only `format`, `text` and
  `durationMs`.
- Config: `option ports '1'` in `/etc/config/perch-apd` (default on), env-free
  like the rest of that file. Virtual policy is `VirtualAuto`, not
  configurable.
- CLI: `perch-apd ports` prints the array as indented JSON, for the read-only
  check from `/tmp` on a real AP (CLAUDE.md's recipe:
  `sh -c "/tmp/apd ports; /tmp/apd info; rm /tmp/apd"`).

**Why not a Prometheus family.** The push text is node_exporter-lua's
vocabulary so the controller's existing parser reads it; port inventory is
label-shaped data that would need `perch_port_info{…}` gymnastics and a second
normalizer on the server. One JSON array, identical to the collector's, keeps
one validator on the controller. (`netclass`, the collector that already emits
`node_network_carrier` / `node_network_speed_bytes` / `node_network_info` for
*every* netdev, stays unused: ~17 file reads × ~15 netdevs per push is heavier
than the whole rest of the push on a MIPS AP, and it cannot tell a port from a
bridge.)

**Compatibility**

| | old controller | new controller |
|---|---|---|
| **old agent** (≤ 0.1.2) | unchanged | no `ports` key ⇒ node without ports, "agent too old" hint, operator may pin ports |
| **new agent** (perch-apd ≥ 1.0.0, perch-collector ≥ 1.0.0) | `ports` param ignored, `ports` capability stored but unused | full view |

### 4.3 perch-collector (the Gateway agent)

Ports belong to the **gateway report**: they are the router's own hardware, the
same "this collector runs on the router" fact that gateway stats already mean.

`gateway.Stats` gains one field, so it appears both in `collector.push`
(`internal/controller/controller.go:439`) and in `GET /api/v1/summary`
(`internal/api/api.go:60`), i.e. on both transports, with no protocol change:

```json
"gateway": {
  "collectedAt":"2026-09-23T11:17:10Z",
  "conntrack":{"entries":2495,"limit":262144},
  "tcpEstablished":2,
  "load":{"load1":1.44,"load5":1.1,"load15":1.49},
  "memory":{"totalBytes":15637843968,"availableBytes":15525001216},
  "wan":[{"name":"wan0","rxBytes":693974698743,"txBytes":1697321558462}],
  "wanSource":"default-route",
  "ports":[
    {"name":"wan0","label":"wan0","role":"wan","medium":"virtual","mac":"02:00:00:00:00:31",
     "adminUp":true,"carrier":true,"operstate":"up","speedMbps":10000,"duplex":"full"},
    {"name":"lan0","label":"lan0","role":"lan","medium":"virtual","mac":"02:00:00:00:00:32",
     "adminUp":true,"carrier":true,"operstate":"up","speedMbps":10000,"duplex":"full"}
  ]
}
```

- `gateway.Reader` holds a `hoststat.PortReader` and passes
  `PortOptions{WAN: <the interfaces this report counts>}`, so the router's
  actual WAN interfaces get `role: "wan"` even when `board.json` is wrong or
  absent — which is the normal case for a router in a container (§2).
- Config knob `ports: auto | on | off` (YAML `ports`, env
  `PERCH_COLLECTOR_PORTS`, UCI `option ports`), default `auto` = on whenever
  gateway stats are on. With `gateway_stats off` there is no gateway report and
  therefore no ports; that is documented, not a bug.
- `ports` is present (possibly `[]`) whenever the feature is on, absent when
  off or when the build is older. Old controllers ignore the key
  (`recordGatewaySample` reads named fields only,
  `app/services/router_metrics.ts:159`); new controllers treat absent as
  "unknown" and say so with the collector's version.
- CLI: `perch-collector ports` prints the array and exits before any config or
  capture work, for a read-only check on the router.

### 4.4 Normalised report (server side)

Both paths produce the same thing:

```ts
// app/services/infra_ports.ts
export type PortReport = {
  name: string                  // 1..32, [A-Za-z0-9][A-Za-z0-9._@:-]*
  label?: string                // ≤ 48
  role?: 'wan' | 'lan'
  medium?: 'copper' | 'sfp' | 'virtual' | 'wireless'
  mac?: string                  // xx:xx:xx:xx:xx:xx, lowercased
  adminUp?: boolean
  carrier?: boolean
  operstate?: string            // ≤ 16
  speedMbps?: number            // 1..1_000_000, integer
  duplex?: 'full' | 'half'
  carrierChanges?: number       // 0..2^31-1
}
```

Anything else is dropped field by field; an entry without a usable `name` is
dropped; the array is capped at 64 entries (`MAX_AGENT_PORTS`); a `ports` value
that is not an array is treated as absent and **does not** clear anything.

---

## 5. Server storage

### 5.1 Migration `1779000000044_create_infra_tables.ts`

Three tables, one migration (like `1779000000028_create_wifi_latest_tables.ts`).
All three `table.collate('utf8mb4_unicode_ci')`, matching the Wi-Fi tables.
After writing it, regenerate the tracked `database/schema.ts` with
`NODE_ENV=test node ace migration:run` (CLAUDE.md: never against the live
database).

**`infra_nodes`**

| Column | Type | |
|---|---|---|
| `id` | `increments` | |
| `kind` | `string(24)` not null | `gateway` \| `access_point` \| `switch` \| `router` \| `modem` \| `isp` \| `host` \| `device`; union in the app layer, house style (`users.role`, `device_labels.device_type`) |
| `name` | `string(80)` null | operator's name; `null` on a bound node = use the agent's name |
| `collector_id` | `int unsigned` null → `collectors.id` **ON DELETE SET NULL**, unique | |
| `ap_id` | `int unsigned` null → `wifi_access_points.id` **ON DELETE SET NULL**, unique | |
| `device_mac` | `string(17)` null, indexed | a MAC from Perch's device list; no FK (MAC collation differs from `device_identities.mac`, and the device may not have been seen yet) |
| `parent_id` | `int unsigned` null → `infra_nodes.id` **ON DELETE SET NULL** | only a `host` node may be a parent; depth 1 |
| `virtual` | `boolean` not null default false | a Linux bridge / vSwitch / VM |
| `model` | `string(80)` null | operator's note |
| `notes` | `string(500)` null | |
| `pos_x`, `pos_y` | `integer` null | `null` = unplaced; relative to `parent_id` when set (React Flow convention) |
| `width`, `height` | `smallint unsigned` null | host frames only |
| `hidden` | `boolean` not null default false | keeps a node off the map without deleting it |
| `created_at`, `updated_at` | timestamps | |

Indexes: `kind`, `parent_id`, `device_mac`, uniques on `collector_id` and
`ap_id` (MariaDB allows many NULLs in a unique index, which is what detached
nodes need).

**`infra_ports`**

| Column | Type | |
|---|---|---|
| `id` | `increments` | |
| `node_id` | `int unsigned` not null → `infra_nodes.id` **ON DELETE CASCADE** | |
| `port_key` | `string(32)` not null | |
| `origin` | `string(8)` not null | `agent` \| `manual` |
| `label`, `reported_label` | `string(48)` null | operator override / agent's |
| `role`, `reported_role` | `string(8)` null | `wan` \| `lan` |
| `medium` | `string(8)` null | `copper` \| `sfp` \| `virtual` \| `wireless` |
| `mac` | `string(17)` null | |
| `position` | `smallint unsigned` not null default 0 | |
| `hidden` | `boolean` not null default false | |
| `present` | `boolean` not null default true | agent still reports it |
| `missing_since` | `datetime` null | |
| `admin_up`, `carrier` | `boolean` null | |
| `operstate` | `string(16)` null | |
| `speed_mbps` | `int unsigned` null | |
| `duplex` | `string(4)` null | |
| `carrier_changes` | `int unsigned` null | |
| `state_changed_at` | `datetime` null | last time `carrier`/`speed`/`duplex`/`operstate` changed |
| `reported_at` | `datetime` null | last accepted report that carried this port |
| `created_at`, `updated_at` | timestamps | |

Unique `(node_id, port_key)`; index `(node_id, position)`.

**`infra_links`**

| Column | Type | |
|---|---|---|
| `id` | `increments` | |
| `a_port_id` | `int unsigned` not null → `infra_ports.id` **ON DELETE CASCADE**, unique | |
| `b_port_id` | `int unsigned` not null → `infra_ports.id` **ON DELETE CASCADE**, unique | |
| `medium` | `string(8)` not null default `'ethernet'` | `ethernet` \| `fiber` \| `virtual` \| `wireless` |
| `label` | `string(48)` null | e.g. "cable run to the garage" |
| `notes` | `string(500)` null | |
| `created_at`, `updated_at` | timestamps | |

`a_port_id` is always the smaller id. The two unique indexes catch half the
races; **one link per port** is enforced in the service inside a transaction:

```sql
SELECT id FROM infra_links WHERE a_port_id IN (?, ?) OR b_port_id IN (?, ?) FOR UPDATE
```

before the insert/update (the API is single-instance and single-admin; this is
belt and braces, not a distributed lock).

### 5.2 Ingest (`app/services/infra_ports.ts`)

```ts
export type PortBinding = { type: 'ap'; id: number } | { type: 'collector'; id: number }

export async function recordAgentPorts(
  binding: PortBinding,
  ports: unknown,
  at: DateTime
): Promise<{ nodeId: number; changed: number } | null>

/** Test-only: forget the per-agent last-report cache. */
export function _resetInfraPortsState(): void
```

1. `ports` is not an array ⇒ return `null`, write nothing (an old agent must
   never erase what a newer one reported).
2. Normalise per [§4.4](#44-normalised-report-server-side).
3. Compare with the process's last accepted report for this binding
   (`Map<string, string>` of `${type}:${id}` → a compact fingerprint). Equal ⇒
   return without touching the database. **Bounded** at 256 entries, oldest
   evicted (CLAUDE.md: every in-process cache needs a bound).
4. Otherwise `ensureNodeFor(binding)` (§6.3), then in one transaction:
   - upsert each reported port by `(node_id, port_key)`: inventory columns
     (`reported_label`, `reported_role`, `medium` when the operator has not
     overridden it, `mac`, `position`), state columns, `reported_at`,
     `present = true`, `missing_since = null`, and `state_changed_at` only when
     a state column actually changed;
   - ports of that node with `origin = 'agent'` that the report does not name:
     `present = false`, `missing_since = now` (first time only);
   - delete missing agent ports that carry **no link, no operator label, no
     operator role, and are not hidden** — they hold nothing worth keeping;
   - a port with `origin = 'manual'` whose key matches a reported port is
     **adopted**: `origin = 'agent'`, operator's `label`/`role` kept, link kept.
5. Update the cache and return.

Call sites:

- **AP push**: `app/services/ap_agent_metrics.ts`, inside `ingestPush`, after
  `ingestWifiMetrics`, wrapped in `try/catch` and logged at warn — a failing
  port write must never cost the Wi-Fi ingest (same rule as the peer mirror and
  the gateway sample in `collector_poller.ts:766`). Only accepted pushes (not
  `too_early`, not disabled rows).
- **Collector push and poll**: `app/services/collector_poller.ts`, in the
  existing non-fatal gateway block next to `recordGatewaySample`, using
  `snapshot.gateway.ports`.

**Write rate.** Three APs at 5 s plus the gateway at 5 s = 48 reports/min. In
steady state every one of them is fingerprint-identical to the last, so the
cost is a map lookup and **zero** database writes. A flapping port costs one
`UPDATE` per push (0.2 writes/s). A controller restart costs one full upsert
per agent (≤ 64 rows). No rollups, no retention job, no scheduler task.

**Retention.** None: these are latest-state and operator rows. Ports die with
their node (`CASCADE`), links die with their ports (`CASCADE`), missing agent
ports are pruned as above.

### 5.3 `collectors:merge` and `collectors:purge`

`app/services/collector_merge.ts` refuses when a table references `collectors`
and is not in its registry (CLAUDE.md). `infra_nodes` is not traffic history
and must not be merged by the counter rules, so:

```ts
/**
 * Tables that reference `collectors` but hold no history: the merge moves
 * them with a rule of their own instead of the counter/snapshot machinery.
 */
const NON_HISTORY_TABLES = new Set(['infra_nodes'])
```

- `verifyRegistry` skips these names in the `information_schema` check.
- One extra step inside the merge transaction, `repointInfraNode(trx, fromId,
  intoId)`:
  - survivor has no node, removed side has one ⇒ `UPDATE infra_nodes SET
    collector_id = <survivor> WHERE collector_id = <removed>`;
  - both have nodes ⇒ the one with more links stays bound; the other gets
    `collector_id = NULL` (detached, §6.3 — its cables survive and the operator
    decides);
  - neither ⇒ nothing.
  - The plan output (`--dry-run`) names what it will do.
- `collectors:purge --id=N` deletes the row; the FK sets `collector_id` to
  `NULL` and the node becomes **detached**. Same for deleting a Wi-Fi source in
  Settings (`deleteWifiAccessPoint`, `app/services/wifi_source_registry.ts:133`)
  — no code change there, the FK does it.

---

## 6. Topology model

### 6.1 Nodes, ports, links

- A **node** is a device on the map. It is either **bound** to an agent row
  (`collector_id` or `ap_id`) or **manual**.
- A node has **ports**; a port has at most one **link**; a link joins exactly
  two ports on (normally) two different nodes.
- A node has a **position** (`null` = unplaced), optional **size** (host
  frames), an optional **parent** (a host frame), and free-text **notes**.

### 6.2 Node kinds

| kind | Created by | Ports | Meaning |
|---|---|---|---|
| `gateway` | server, from a collector that reports gateway stats | agent | **the Gateway agent**: the router. The root of the view |
| `access_point` | server, from every `wifi_access_points` row; also manual | agent (perch-apd) or manual | an AP; scrape rows and old agents get manual ports |
| `switch` | manual | manual, `portCount` 1–64 (+ `sfpPorts` 0–8) | unmanaged switch; `virtual: true` = a Linux bridge / vSwitch |
| `router` | manual | manual, template `wan` + `lan1…` | a second router (double NAT, a WAN-side box) |
| `modem` | manual | manual, template `wan` + `lan1` | modem / ONT |
| `isp` | manual | manual, one `uplink` port | the line leaving the house; draws as a cloud |
| `host` | manual | manual (its NICs), may be empty | a server/hypervisor. **Container/frame**: other nodes may sit inside it |
| `device` | manual | manual, template `eth0` | anything else; may carry `deviceMac` to bind it to a device Perch knows |

Manual creation is allowed for every kind except `gateway` (the root is the
agent's; a second router is a `router`).

**Virtual switches are how a host's bridges are modelled.** A `switch` with
`virtual: true` stands for `br-lan` / `br-wan` / a vSwitch: its ports are the
veths that plug into it *and* the physical NIC enslaved in it, which is where
the real cable starts. This keeps "one link per port" honest and is the only
way the surveyed gateway's cabling can be drawn truthfully
([Appendix A](#appendix-a-worked-example)).

### 6.3 Binding lifecycle

`ensureAgentNodes()` (idempotent; two SELECTs plus inserts for what is missing):

- one `access_point` node per `wifi_access_points` row (enabled or not,
  `scrape` or `agent`);
- one `gateway` node per **adopted** `collectors` row whose
  `last_status.gateway` is set (the same fact `gatewaySource()` reads,
  `app/services/router_metrics.ts:214`).

New nodes are created **unplaced** (`pos_x/pos_y` null) with `name = NULL`
(display name falls back to the agent's). It runs:

- at the top of `GET /api/v1/infra/layout` (cheap, idempotent, races settle on
  the unique indexes),
- from `recordAgentPorts` when the binding has no node yet.

Display name = `node.name ?? binding name ?? kind label`, so renaming an AP in
Settings follows through until the operator names the node themselves.

**Deletes**

| Event | Result |
|---|---|
| AP deleted in Settings, collector purged, collector deleted | `ap_id`/`collector_id` → `NULL`: the node becomes **detached** — it keeps its kind, ports (as last reported), cables, position and notes; live state stops; the UI marks it "Agent removed" and offers *Delete* or *Bind to…* |
| Agent forgotten (`DELETE /settings/wifi-sources/:id/agent`) | row survives as `transport='scrape'`: the node stays bound, `portsSupported` becomes `false`, ports keep their last state (greyed) |
| `DELETE /api/v1/infra/nodes/:id` on a **bound** node | **409 `infra_node_bound`** — it would come straight back. Hide it instead |
| `DELETE` on a manual or detached node | node, its ports and their links are deleted (`CASCADE`); children are re-parented to `null` |
| Port disappears from an agent report | `present = false` (§5.2); cable kept and drawn as a warning |

**Rebinding.** `POST /api/v1/infra/nodes/:id/bind` with `{ apId }` or
`{ collectorId }` moves a detached node back onto an agent row (AP re-added
after a delete, collector replaced). If that agent already has a node, the
other node must have no links (then it is deleted and its position dropped);
otherwise **409 `infra_agent_node_has_links`**. After binding, the next report
matches ports by key.

### 6.4 Links

- Exactly two ends; both ends must exist, must not be the same port, must not
  already carry a link, must not be hidden, and must not be on the same node
  (**422 `infra_link_same_node`** — a cable from a switch to itself is a loop,
  not a topology).
- `medium` defaults, when omitted: both ends `virtual` ⇒ `virtual`; either end
  `sfp` ⇒ `fiber`; either end `wireless` ⇒ `wireless`; else `ethernet`.
- Moving one end (`PATCH`) is how a renamed or missing port is repaired.
- Link **state** is derived per request, never stored (§7.3): the agent ends
  decide; when both ends are agent ports, live, and disagree on carrier or
  report different speeds, the link is `mismatch` — "this cable is not between
  these two ports", which is the single most useful thing the view can tell an
  operator who mis-drew the map.
- A manual port's LED comes from the other end of its cable, which is what
  makes an unmanaged switch worth drawing at all.

### 6.5 Guard rails

Max 200 nodes, 64 ports per node, 400 links, 8 SFP ports per manual switch,
`|pos| ≤ 100000`, `width`/`height` 120–4000. Positions are integers.

---

## 7. REST API

All under `/api/v1/infra`, inside the existing `/api/v1` group (so behind
`requireSetupComplete`), registered **before** the SPA catch-all like every
other group in `start/routes.ts`.

- **Reads**: `middleware.auth()` + `middleware.requirePasswordChange()` — any
  signed-in user, like `/devices` and `/wifi`.
- **Writes**: those two plus `middleware.requireAdmin()`. Unlike device labels
  (an annotation any user may make, `app/controllers/device_labels_controller.ts:13`),
  the layout is shared structure: deleting a node destroys another person's
  work, and binding touches agent rows. The dashboard hides edit mode for
  non-admins; the server is the one that enforces it.
- All responses are `{ data: … }` (`serialize(...)`).
- No `query_cache` anywhere in this feature. `GET /infra/state` reads the
  database per request; freshness comes from the hubs in-process. The standard
  `private, no-cache` + ETag from `api_cache_headers_middleware.ts` applies, so
  an unchanged poll is a 304 and no long-lived cache is involved.

Routes:

```
GET    /api/v1/infra/layout
GET    /api/v1/infra/state
POST   /api/v1/infra/nodes                 (admin)
PATCH  /api/v1/infra/nodes/:id             (admin)
DELETE /api/v1/infra/nodes/:id             (admin)
POST   /api/v1/infra/nodes/:id/bind        (admin)
POST   /api/v1/infra/nodes/:id/ports       (admin)
PATCH  /api/v1/infra/ports/:id             (admin)
DELETE /api/v1/infra/ports/:id             (admin)
POST   /api/v1/infra/links                 (admin)
PATCH  /api/v1/infra/links/:id             (admin)
DELETE /api/v1/infra/links/:id             (admin)
PUT    /api/v1/infra/positions             (admin)
```

Controller `app/controllers/infra_controller.ts`, validators
`app/validators/infra.ts` (Vine), services `app/services/infra_topology.ts`
(CRUD + state) and `app/services/infra_ports.ts` (ingest), models
`app/models/infra_node.ts`, `infra_port.ts`, `infra_link.ts` extending the
generated `InfraNodeSchema` / `InfraPortSchema` / `InfraLinkSchema`
(house style, like `Collector`).

### 7.1 Shared types

```ts
type InfraNodeKind =
  | 'gateway' | 'access_point' | 'switch' | 'router' | 'modem' | 'isp' | 'host' | 'device'
type InfraPortRole = 'wan' | 'lan'
type InfraPortMedium = 'copper' | 'sfp' | 'virtual' | 'wireless'
type InfraLinkMedium = 'ethernet' | 'fiber' | 'virtual' | 'wireless'

type InfraBinding = {
  type: 'collector' | 'ap'
  id: number
  name: string                    // the agent row's name (friendlyName ?? name)
  transport: 'agent' | 'poll' | 'scrape'
  version: string | null          // agent/collector build, when known
  /** true = it reports ports, false = it cannot, null = unknown (old collector) */
  portsSupported: boolean | null
}

type InfraPort = {
  id: number
  nodeId: number
  key: string
  origin: 'agent' | 'manual'
  label: string                   // label ?? reportedLabel ?? key
  labelOverride: string | null
  role: InfraPortRole | null      // role ?? reportedRole
  roleOverride: InfraPortRole | null
  medium: InfraPortMedium | null
  mac: string | null
  position: number
  hidden: boolean
  present: boolean
  missingSince: string | null     // ISO
  linkId: number | null
}

type InfraNode = {
  id: number
  kind: InfraNodeKind
  name: string                    // resolved display name
  nameOverride: string | null
  source: 'agent' | 'manual'      // 'agent' once it has ever been bound
  binding: InfraBinding | null    // null on manual and detached nodes
  detached: boolean               // source === 'agent' && binding === null
  virtual: boolean
  model: string | null
  notes: string | null
  device: {                       // only when deviceMac is set
    mac: string
    name: string | null           // device label name
    deviceType: string | null
    connection: 'ethernet' | null
  } | null
  parentId: number | null
  position: { x: number; y: number } | null
  size: { width: number; height: number } | null
  hidden: boolean
  isRoot: boolean                 // the Gateway agent the Gateway page reads
  ports: InfraPort[]              // in display order
  createdAt: string
  updatedAt: string | null
}

type InfraLink = {
  id: number
  medium: InfraLinkMedium
  label: string | null
  notes: string | null
  a: { nodeId: number; portId: number }
  b: { nodeId: number; portId: number }
}
```

### 7.2 `GET /api/v1/infra/layout`

Query: none. Runs `ensureAgentNodes()` first.

```jsonc
{ "data": {
  "generatedAt": "2026-09-23T11:20:36.123Z",
  "rootNodeId": 1,               // node of gatewaySource(), or null
  "nodes": [ /* InfraNode[] */ ],
  "links": [ /* InfraLink[] */ ],
  "kinds": [
    { "kind": "switch", "label": "Switch", "manual": true, "container": false,
      "ports": { "default": 8, "min": 1, "max": 64 }, "supportsSfp": true },
    { "kind": "host", "label": "Host / hypervisor", "manual": true, "container": true,
      "ports": { "default": 0, "min": 0, "max": 64 }, "supportsSfp": true }
    // …one entry per kind; the UI builds its "Add device" menu from this
  ],
  "limits": { "nodes": 200, "portsPerNode": 64, "links": 400 }
}}
```

Errors: 401, 503 (setup incomplete) — nothing else. An instance with no
collectors and no APs returns empty arrays, not an error.

### 7.3 `GET /api/v1/infra/state`

The only endpoint the page polls at 5 s. Live, uncached.

```jsonc
{ "data": {
  "generatedAt": "2026-09-23T11:20:36.123Z",
  "nodes": [
    { "id": 1,
      "status": "online",            // online | stale | offline | unmanaged | detached
      "live": true,                  // state below may be believed
      "lastSeenAt": "2026-09-23T11:20:35.000Z",
      "version": "1.0.0",
      "presence": null }             // device nodes: { status, via, lastSeenAt }
  ],
  "ports": [
    { "id": 11, "nodeId": 1, "present": true, "live": true,
      "up": true, "adminUp": true, "operstate": "up",
      "speedMbps": 1000, "duplex": "full", "carrierChanges": 3,
      "changedAt": "2026-09-22T19:03:11.000Z",
      "derivedFrom": null }          // manual ports: the link id the state came from
  ],
  "links": [
    { "id": 31, "state": "up", "speedMbps": 1000, "detail": null }
    // state: up | down | unknown | mismatch; detail: 'carrier' | 'speed' on mismatch
  ]
}}
```

Rules:

- **Node status**: bound to an agent row and `transport='agent'` ⇒ `online`
  when the hub says the session is open *and* the last accepted report is
  within its silence bound (APs: `apStaleSeconds(thresholds,
  pollIntervalSeconds)` from `app/services/wifi_presence.ts:63`; collectors:
  `max(3 × pollIntervalSeconds, 30 s)` as in
  `app/services/collector_agent.ts:29`); connected but past the bound ⇒
  `stale`; otherwise `offline`. `transport` `poll`/`scrape` ⇒ `online` when
  `last_status.ok` and `last_seen_at` is within the same bound. Manual ⇒
  `unmanaged`. Bound row gone ⇒ `detached`.
- **Port `up`** = `carrier ?? (operstate === 'up')`. `live` = the node is
  `online` and the port is `present` and `origin='agent'`.
- **Manual port state** is derived from the far end of its link when that end
  is a live agent port (`derivedFrom: <linkId>`); otherwise everything is
  `null` and `live` is false.
- **Link state**: any live agent end up ⇒ `up`; all live agent ends down ⇒
  `down`; no live agent end ⇒ `unknown`; two live agent ends that disagree on
  carrier ⇒ `mismatch` + `detail:'carrier'`; both up with different
  `speedMbps` ⇒ `mismatch` + `detail:'speed'`. `speedMbps` = the lower of the
  reported speeds, or the only one known.
- **`presence`** for nodes with `deviceMac`: `devicePresence()` over the same
  inputs `/devices/:mac/presence` uses. Stream (c) extracts
  `queryLatestWifiContext`, `queryTrafficSeenAt` and `queryDevicePresence`
  from `app/controllers/devices_controller.ts:970-1065` into
  `app/services/device_presence_query.ts` (a plain move plus a batch
  `queryDevicePresences(macs: string[])`), and the controller imports them
  from there.

Errors: 401 / 503 only.

### 7.4 `POST /api/v1/infra/nodes` (admin)

```jsonc
{
  "kind": "switch",                       // required, InfraNodeKind except 'gateway'
  "name": "Garage switch",                // required, 1..80 after trim
  "virtual": false,                       // optional, default false ('switch' and 'host' only)
  "model": "8-port desktop switch",       // optional, ≤ 80
  "notes": "under the stairs",            // optional, ≤ 500
  "deviceMac": "02:00:00:00:00:21",       // optional, kind 'device' only, MAC format
  "parentId": 7,                          // optional, must be an existing 'host' node
  "position": { "x": 120, "y": 200 },     // optional; omitted = unplaced
  "size": { "width": 420, "height": 260 },// optional, kind 'host' only, 120..4000
  "portCount": 8,                         // optional, 0..64 — fills from the kind template
  "sfpPorts": 2,                          // optional, 0..8, 'switch' only
  "ports": [                              // optional; wins over portCount
    { "key": "1", "label": "1", "role": null, "medium": "copper" }
  ]
}
```

Port templates when `ports` is absent: `switch` → `"1"…"N"` (+ `sfp1…`),
`router` → `wan`(role wan) + `lan1…lan{N-1}`(role lan), `modem` → `wan`(wan) +
`lan1`(lan), `isp` → `uplink`(wan), `device` → `eth0`, `access_point` →
`wan`(wan) + `lan1`(lan), `host` → none. `portCount` defaults per kind
(switch 8, router 5, modem 2, isp 1, device 1, access point 2, host 0).

**201** `{ "data": { "node": InfraNode } }`.

Errors: 422 Vine (`{ errors: [{ field, message, rule }] }`), 422
`infra_kind_not_manual`, 422 `infra_parent_invalid`, 422
`infra_port_key_duplicate`, 422 `infra_limit_reached` (nodes/ports), 403
`admin_required`, 401.

### 7.5 `PATCH /api/v1/infra/nodes/:id` (admin)

Merge semantics like the device-label PATCH: an omitted key keeps the stored
value, an explicit `null` clears it.

```jsonc
{
  "name": "Garage switch",       // ≤ 80 | null (bound nodes: null = follow the agent's name)
  "model": null,                 // ≤ 80 | null
  "notes": "…",                  // ≤ 500 | null
  "virtual": true,               // 'switch' | 'host'
  "deviceMac": null,             // 'device' only
  "parentId": null,              // host id | null
  "position": { "x": 10, "y": 20 } | null,
  "size": { "width": 420, "height": 260 } | null,
  "hidden": false,
  "portCount": 16                // 'switch' only: grows or shrinks the numbered ports
}
```

`kind`, `collectorId` and `apId` are **not** patchable (kind is fixed at
creation; binding has its own endpoint).

**200** `{ "data": { "node": InfraNode } }`.

Errors: 404 `infra_node_not_found`; 422 `infra_parent_invalid` (not a host,
itself, a node that already has a parent, or would nest a host);
422 `infra_field_not_applicable` (e.g. `portCount` on an agent node, `size` on
a non-host); 409 `infra_port_has_link` when shrinking `portCount` would drop a
cabled port (body names the ports); 422 Vine.

### 7.6 `DELETE /api/v1/infra/nodes/:id` (admin)

**204.** Deletes its ports and their links; children lose their `parentId`.

Errors: 404 `infra_node_not_found`; **409 `infra_node_bound`**
`{ error, message, binding: { type, id } }` — "This node is the AP *name*.
Remove it in Settings → Wi-Fi sources, or hide it here."

### 7.7 `POST /api/v1/infra/nodes/:id/bind` (admin)

```jsonc
{ "apId": 4 }            // or { "collectorId": 1 }
```

Kind must match (`ap` → `access_point`, `collector` → `gateway`). **200**
`{ "data": { "node": InfraNode, "replacedNodeId": 9 | null } }`.

Errors: 404 `infra_node_not_found`, 404 `infra_binding_not_found`, 422
`infra_binding_kind_mismatch`, 409 `infra_node_already_bound` (this node is
bound), 409 `infra_agent_node_has_links` (the target agent's existing node
carries cables — delete or rewire it first).

### 7.8 Ports (admin)

`POST /api/v1/infra/nodes/:id/ports`

```jsonc
{ "ports": [ { "key": "lan1", "label": "LAN 1", "role": "lan", "medium": "copper", "position": 1 } ] }
```

1–64 entries. Allowed on any node — that is the "pin ports by hand on an old
agent" path; on a node whose agent reports ports the UI hides the action but
the API allows it (a switch chip port the agent cannot see).

**201** `{ "data": { "ports": InfraPort[] } }`. Errors: 404
`infra_node_not_found`, 409 `infra_port_key_taken`, 422 `infra_limit_reached`,
422 Vine.

`PATCH /api/v1/infra/ports/:id`

```jsonc
{ "key": "lan2", "label": "Uplink", "role": "wan", "medium": "sfp", "hidden": false, "position": 3 }
```

`key` may only be changed on `origin='manual'` ports (422
`infra_port_key_immutable` otherwise); `label`, `role`, `medium`, `hidden` and
`position` are operator fields on any port. Hiding a port that carries a link
is 409 `infra_port_has_link`.

**200** `{ "data": { "port": InfraPort } }`.

`DELETE /api/v1/infra/ports/:id` → **204**. Manual ports always; agent ports
only when `present = false` (**409 `infra_port_present`** otherwise: "the agent
still reports this port"). Its link goes with it (the response is still 204;
the client refetches the layout).

### 7.9 Links (admin)

`POST /api/v1/infra/links`

```jsonc
{ "aPortId": 11, "bPortId": 24, "medium": "ethernet", "label": null, "notes": null }
```

**201** `{ "data": { "link": InfraLink } }`.

Errors: 404 `infra_port_not_found` (names the missing id); 422
`infra_link_same_port`; 422 `infra_link_same_node`; 409 `infra_port_busy`
`{ error, message, portId, linkId }`; 409 `infra_port_hidden`; 422
`infra_limit_reached`.

`PATCH /api/v1/infra/links/:id` — `{ "aPortId": 12 }` moves one end; same
validations. **200** `{ "data": { "link": InfraLink } }`.

`DELETE /api/v1/infra/links/:id` → **204** (404 `infra_link_not_found`).

### 7.10 `PUT /api/v1/infra/positions` (admin)

```jsonc
{ "positions": [ { "nodeId": 1, "x": 240, "y": 40, "parentId": null } ] }
```

1–200 entries, one transaction; unknown ids ⇒ 404 `infra_node_not_found`
(names the first). Used by auto-arrange and multi-select drags. **200**
`{ "data": { "updated": 7 } }`.

---

## 8. Dashboard

### 8.1 Route, nav, bundle

- Route `/infrastructure`, nav item **Infrastructure** (Phosphor
  `TreeStructure`) in `src/lib/nav.ts`, between *WiFi* and *Settings*.
- **Lazy-loaded**: the main bundle is already 1.36 MB, so the canvas must not
  land in it.

```tsx
const InfrastructurePage = lazy(() =>
  import('@/pages/infrastructure-page').then((m) => ({ default: m.InfrastructurePage })),
)
// in the children array of the AppLayout route:
{ path: 'infrastructure', element: <Suspense fallback={<PageSpinner />}><InfrastructurePage /></Suspense> }
```

- Canvas library: **`@xyflow/react` 12.11.6** (MIT, React 19 peer range) with
  `ConnectionMode.Loose` (port handles must connect to each other, not
  source→target), plus **`@dagrejs/dagre` 3.1.1** (MIT) for auto-arrange and
  for placing unplaced nodes. Both are imported only from the page module, so
  they and `@xyflow/react/dist/style.css` end up in that route's chunk
  (~35 KB + ~25 KB gzipped, measured after the first build; report the numbers
  in the PR).

### 8.2 Data hooks (`src/hooks/use-infra.ts`)

```ts
export const infraQueryKey = ['infra'] as const

useInfraLayout()  // queryKey [...infraQueryKey, 'layout'], refetchInterval 30_000,
                  // refetchOnWindowFocus: true
useInfraState()   // queryKey [...infraQueryKey, 'state'],  refetchInterval 5_000
useCreateInfraNode() / useUpdateInfraNode() / useDeleteInfraNode() / useBindInfraNode()
useAddInfraPorts() / useUpdateInfraPort() / useDeleteInfraPort()
useCreateInfraLink() / useUpdateInfraLink() / useDeleteInfraLink()
useSaveInfraPositions()
```

Every mutation invalidates `[...infraQueryKey, 'layout']` (and `'state'` where
relevant). If a state response names a port id the loaded layout does not have,
the page invalidates the layout once — self-healing when an agent grows a port
between layout polls. Polling is paused while a drag or a connection gesture is
in flight so the server's answer cannot fight the pointer. Types go in
`src/types/api.ts` (one file, house style), helpers in `src/lib/infra.ts`
(kind labels + icons, speed formatting `10M/100M/1G/2.5G/10G`, LED colour,
medium labels, auto-layout with dagre).

### 8.3 The node shape

One generic box, driven by data, for every kind:

```
┌───────────────────────────────┐
│ ⬤ [icon] Gateway              │   status dot, kind icon, display name
│ Gateway agent · 1.0.0         │   subtitle: role / model / version / "Unmanaged"
├───────────────────────────────┤
│ WAN │ ▮ ▮ │  1 2 3 4 5 6 7 8  │   WAN group, separator, the rest
└───────────────────────────────┘
```

- Header: kind icon (Phosphor: gateway `Router`, access point `WifiHigh`,
  switch `Rows`, router `Router`, modem `Plugs`, isp `Globe`, host
  `HardDrives`, device `Devices`), display name, status dot
  (`bg-status-good` online, `bg-status-warning` stale, `bg-status-critical`
  offline, muted for unmanaged/detached), plus a small "Gateway agent" chip on
  the root node.
- Port strip: one ~18×14 px rounded rect per visible port with a 2 px LED bar:
  `status-good` ≥ 1 Gb/s link, `status-warning` link at 10/100 Mb/s, muted-grey
  no carrier, hollow/dashed unknown (manual port with no live end, or an
  offline agent), red dashed outline for a `present: false` port. Ports with
  `role: 'wan'` are drawn first, separated by a gap and a 9 px `WAN` caption;
  `medium: 'sfp'` ports are drawn as a narrower slot, `virtual` ports with a
  dotted border. ≤ 12 ports: one row with labels under each port; more: two
  rows (odd on top, even below) with labels on hover only.
- Each port is a React Flow `Handle` (`type="source"`, `position={Position.Bottom}`
  for the lower row / `Top` for the upper), `id = String(port.id)`.
- Hover shows a tooltip: key, label, role, up/down + speed/duplex, the peer
  ("→ Switch · port 3"), carrier changes, "since …".
- Host nodes render as a labelled, resizable frame (React Flow parent node with
  `extent: 'parent'` on the children) behind their children.

### 8.4 Cables

Custom edge (`cable-edge.tsx`, smoothstep): `ethernet` solid 2 px,
`fiber` solid 2 px with a warmer stroke, `virtual` dotted, `wireless` dashed
and animated; colour by state — up = normal foreground, down = muted, unknown =
muted + dotted, `mismatch` = `status-critical` with a warning badge on the
edge. The label shows the speed (`1G`, `2.5G`) when known, or the link's
`label`.

### 8.5 View and edit

- **View mode** (default, everyone): pan/zoom, `nodesDraggable=false`,
  `nodesConnectable=false`, click a node or port to open the inspector panel
  (read-only facts: agent, version, last seen, ports table, cables, notes,
  links to the AP page / Gateway panel / device page).
- **Edit mode** (admins only, toggle in the page header, hidden below `md`):
  drag to move (drag end → `PATCH position`, or `PUT /positions` for a
  multi-select), drag from port to port to cable (`onConnect` →
  `POST /links`; a busy port refuses with 409 and the UI says which cable
  already uses it), select an edge and press Delete to remove a cable, node
  context actions (Rename, Add port, Hide, Bind, Delete with a confirm),
  **Add device** menu built from `kinds` (switch asks for a port count and SFP
  count; device offers a picker over `GET /api/v1/devices`), **Auto-arrange**
  (dagre, then `PUT /positions`), **Hidden (n)** menu to bring things back.
- Unplaced nodes (`position: null`) are laid out client-side with dagre so the
  map is never empty for a viewer; nothing is written until an admin drags or
  auto-arranges.
- **Empty state** (no nodes at all): the standard `EmptyState` — "Nothing to
  map yet. Adopt a collector on your router (it becomes the Gateway agent) and
  join your access points; they show up here by themselves." with links to
  Settings → Collectors and Settings → Wi-Fi sources, plus, for admins, "or
  add a switch".
- **Old agents**: a node whose `binding.portsSupported` is `false`/`null` shows
  "This agent does not report ports yet — perch-apd 0.1.2 · upgrade, or add
  ports by hand", with an *Add ports* action that suggests `wan`, `lan1`…
  (so the pins are adopted on upgrade).
- **Phone** (< `md`): view only, `fitView`, the inspector opens as a bottom
  sheet, no edit toggle.
- Accessibility: the canvas is decorative-plus; the inspector lists the same
  data as text, and the page keeps a "Devices and cables" table fallback under
  the canvas (collapsed by default) so the content is reachable without drag.

---

## 9. "Gateway agent" wording

Product, binary, package and repository names stay `perch-collector`. "Gateway
agent" is a **role word** for the collector instance that runs on the router
with gateway stats on. Copy changes only (no API field renames):

| Where | Now | New |
|---|---|---|
| `dashboard/src/lib/collectors.ts:165` `collectorGatewayLabel` | `Gateway · wan0, wan2` | `Gateway agent · wan0, wan2` |
| `dashboard/src/pages/collectors-settings-page.tsx:151` badge title | "This collector runs on the router and reports its gateway stats." | "This collector runs on the router: it is the **Gateway agent**. It reports the router's connection tracking, WAN rate, load and its Ethernet ports." |
| `dashboard/src/components/gateway/gateway-panel.tsx:58` | "Reported by *name*, the collector on your router" | "Reported by *name*, the **Gateway agent** on your router" |
| same file, empty states (`:97`, `:114`, `:124`) | "No collector on the router yet" | "No Gateway agent yet" / "Waiting for the first report from the Gateway agent" / "No Gateway agent is reporting right now, so this is recorded history." Keep the `perch-collector` package name in the instructions |
| Collectors settings page intro | — | one sentence: "A collector that runs on the router is the **Gateway agent**: it also reports the router's health and its ports, and it is the root of the infrastructure view." |
| Infrastructure page | — | root node chip "Gateway agent"; inspector subtitle `perch-collector <version>` |

The controller's README and `docs/collector-agent.md` keep their wording; a
one-line definition of the role is added to the README's collector section by
stream (c).

---

## 10. Threat model

A home LAN with one admin and a handful of household accounts.

- **Reads expose the layout** (device names, models, port names, cabling) to
  every signed-in user. That is the same audience that already sees every
  device, its traffic and its Wi-Fi client list. Writes are admin-only because
  they destroy shared work, not because the data is secret.
- **An agent may only describe itself.** The binding is server-side: a port
  report is applied to the node bound to the authenticated `agent_id` /
  instance id. A compromised or lying agent can make its own LEDs wrong and
  nothing else; the report is capped (64 ports, fixed field types, bounded
  lengths) so it cannot grow the database.
- **Nothing is written to the network.** There is no "disable port", no config
  push, no SSH. The worst outcome of a wrong map is a wrong picture.
- **Operator text** (`name`, `model`, `notes`, port labels) is length-capped,
  stored as text and rendered as text by React — no HTML, no Markdown, no
  `dangerouslySetInnerHTML`.
- **Plain HTTP** deployments (the documented path, with a management VLAN)
  carry port data in the same session as everything else; it adds nothing new
  to the exposure and the existing `agent.secure` / `connection.secure`
  warnings stay the authority on it.
- **Topology is not authorization data**: nothing in Perch decides anything
  from it, so a mistaken or malicious edit has no effect beyond the page.

---

## 11. Phasing

**v1** — §1.

**v1.x, small and independent**

1. *Link diagnostics*: the AP daemon already can ask ubus for
   `link-supported` / `link-partner-advertising`; report `maxSpeedMbps` and the
   partner's best mode in the inventory (cached, not per push) and flag "1 Gb/s
   port running at 100 Mb/s because the cable only carries two pairs" — the one
   diagnosis the survey showed this data can actually make. On non-OpenWrt
   hosts the same data needs ethtool netlink (`mdlayher/ethtool`) — check the
   binary-size budget on the 4 MB-flash AP first.
2. *Per-port traffic*: the data is already on the wire (`node_network_*_total`
   per device in the AP push; `/proc/net/dev` on the gateway). Add a
   `infra_port_buckets_5m` rollup and a sparkline per port.
3. *"Ethernet device" suggestion*: when a MAC-bound device node gets an
   `ethernet` link and its `device_labels.connection` is null, offer a one-click
   "Mark as Ethernet device" (existing `PATCH /devices/:mac/label`). Never
   automatic — presence rules depend on that mark.
4. *Port flap alerting*: `carrier_changes` is already reported; a threshold
   would be a controller setting (Settings → Presence style), not a constant.

**v2, bigger**

5. *Link suggestions from the forwarding database*: read the bridge FDB over
   rtnetlink (`AF_BRIDGE` / `RTM_GETNEIGH`) on the gateway and the APs and
   propose "port 3 of this switch probably goes to that AP" from which MACs are
   seen behind which port. Works only where a managed device sits on both ends;
   the operator confirms each suggestion.
6. *LLDP*: accurate where it exists, absent on most consumer gear; a separate
   opt-in collector in both daemons.
7. *Drag-to-reparent hosts, VLAN overlay, floor-plan background, port history.*

---

## 12. Tests

**perch-agentkit** (`hoststat`): table tests over fixture trees, one per
platform shape found in the survey — DSA with a conduit, per-port netdevs
without one, a second MAC used as WAN, a container with only veths, plus a tree
that mixes bridge/VLAN/tunnel/ifb/wireless noise. Assert the port set, order,
roles from `board.json`, conduit excluded, `speed=-1` omitted, `carrier`
unreadable omitted, the `lower_*` rule, virtual policies (`auto` with and
without hardware ports), the 64 cap, and that the cache in `PortReader` does not
mask state changes. `go test ./...` and `GOTOOLCHAIN=go1.22.12 go test ./...`.

**perch-apd**: `internal/collect` (or wherever the reader is wired) fixture
tests; `internal/agent` push encoding test that `params.ports` is valid JSON
with the array in report order and that `ports` is omitted when disabled;
handlers test that `capabilities` contains `ports`; CLI test for
`perch-apd ports`. Then the read-only check on one real AP from `/tmp`
(CLAUDE.md's recipe) and a diff against what `/sys` says.

**perch-collector**: `internal/gateway` fixture tests (ports in `Stats`,
role `wan` from the WAN list, ports absent with `ports off`, gateway stats off ⇒
no gateway object at all); `internal/api` test that `GET /api/v1/summary`
carries them; `internal/controller` test that a push carries them; config
precedence test for `PERCH_COLLECTOR_PORTS` / UCI / YAML. Read-only check with
`perch-collector ports` on the router.

**Controller** (`node ace test --files=tests/functional/infra/<name>.spec.ts`):

- `tests/functional/infra/ports_ingest.spec.ts` — AP push with ports (reuse
  `tests/helpers/ap_agent.ts`) creates the node and rows; a second identical
  push writes nothing (assert `updated_at` unchanged); a changed carrier
  updates `state_changed_at`; a push without `ports` changes nothing; a port
  that disappears goes `present=false` and keeps its link; an unlinked,
  unedited missing port is pruned; a manual port with a matching key is
  adopted; 65 ports are capped; junk entries are dropped.
- `tests/functional/infra/collector_ports.spec.ts` — the same over
  `collector.push` (`tests/helpers/collector_agent.ts`) **and** over the HTTP
  poll path, including "old collector: no `ports` key ⇒ `portsSupported: null`".
- `tests/functional/infra/layout_api.spec.ts` — auto-created nodes, kinds
  catalog, node/port/link CRUD, templates, `portCount` grow/shrink, position
  bulk write, hidden, bind, detach on AP delete, delete refusals.
- `tests/functional/infra/links.spec.ts` — one link per port (409 with the
  offending link id), same-node refusal, move an end, cascade on port delete,
  medium defaulting.
- `tests/functional/infra/state_api.spec.ts` — online/stale/offline from the
  hub + freshness bounds, derived manual-port state, `mismatch` on
  disagreeing agent ends, device presence, and `Cache-Control` on both reads.
- `tests/functional/infra/authz.spec.ts` — viewer reads, viewer writes 403,
  anonymous 401.
- `tests/functional/collectors/merge.spec.ts` — extended: merge repoints the
  node, refuses nothing, and the registry check still catches a genuinely
  unknown table.
- `tests/unit/services/infra_ports.spec.ts` — normalisation and the bounded
  fingerprint cache.

Full suite must stay green: `npm test`, `npm run lint`, `npm run typecheck`.

**Dashboard**: no test runner in `dashboard/` — the gates are
`npm run lint:dashboard`, `npm run typecheck`, `npm run build:dashboard` (watch
the chunk sizes: the main bundle must not grow beyond noise, the infra chunk is
separate), plus a manual pass against the fixtures in [§7](#7-rest-api):
gateway + 2 APs + a switch + a modem + an ISP; an old agent with pinned ports; a
detached node; a `mismatch` cable; empty state; phone width. Screenshots via the
scratch Vite harness + headless browser recipe already used for the Wi-Fi pages.

---

## 13. Work packages

Four streams. Everything they exchange is in this document: the port JSON
([§4.4](#44-normalised-report-server-side)) and the REST shapes
([§7](#7-rest-api)). None of them needs another stream's code to start.

### (a) perch-apd + the kit — `perch-agentkit/`, `ap-controller/`

1. `perch-agentkit/hoststat/ports.go` + `ports_test.go` + fixture trees
   (`hoststat/testdata/ports/*`): [§2.1](#21-the-detection-rules-normative) and
   the API in [§4.1](#41-shared-perch-agentkit). **Deliver first** and tag
   `v0.2.0`; stream (b) builds against the local module through `go.work` in the
   meantime. Update `perch-agentkit/README.md`.
2. Root `go.work`: `replace github.com/capthndsme/perch-agentkit v0.2.0 => ./perch-agentkit`
   (keep the v0.1.0 line until both daemons are bumped).
3. `ap-controller/`: `go.mod` bump; a `ports.Reader` on the device struct in
   `cmd/perch-apd/main.go`; `internal/agent/push.go` `pushParams` gains the
   `"ports":` member (one-pass encoding stays: marshal the small array once per
   push into the same buffer); `internal/agent/agent.go` wires the reader into
   `PushOptions.Push`; `internal/handlers/handlers.go` adds `ports` to
   `Capabilities()`; `internal/config/config.go` + `internal/config/default.conf`
   + `openwrt/perch-apd/files/perch-apd.config` add `option ports '1'`;
   `cmd/perch-apd/main.go` adds the `ports` subcommand and its usage line.
4. Docs: `ap-controller/PROTOCOL.md` §2.2/§2.3 (the `ports` param, the `ports`
   capability), `ap-controller/README.md` (what it reports, the config option).
5. Tests per [§12](#12-tests) including the Go 1.22 floor; then the read-only
   `/tmp` check on one real AP. **Do not release or install.**

### (b) perch-collector — `go-collector/`

1. `go.mod` bump to the kit's new tag (locally: `go.work`).
2. `internal/gateway/gateway.go`: a `Ports` field on `Stats`
   (`[]hoststat.Port`, JSON `ports`, omitted when empty), a `PortReader` on
   `Reader`, `PortOptions{WAN: <the names this report counted>}`, and the
   `ports` on/off switch.
3. `internal/config/config.go`: `Ports string` (`auto|on|off`, default `auto`),
   env `PERCH_COLLECTOR_PORTS` (+ `GOCOLLECTOR_PORTS` fallback like its
   siblings), UCI `option ports`, `Validate()` + `PortsEnabled(gatewayStats
   bool)`; `collector.example.yaml`, `openwrt/perch-collector/files/*` and
   `CONFIG.md`.
4. `main.go`: build the reader next to the gateway reader (line ~131), log the
   port names once at start like `describeWAN` does; `ports` subcommand.
5. `internal/api/api.go`: nothing to change (`Stats` is serialised whole) —
   assert it in a test.
6. Docs: `go-collector/README.md` + `ARCHITECTURE.md` ("the Gateway agent's
   ports"), and a line in `CONFIG.md`.
7. Tests per [§12](#12-tests). **Do not release or install.**

### (c) Controller — `metrics-be/`

1. `database/migrations/1779000000044_create_infra_tables.ts`
   ([§5.1](#51-migration-1779000000044_create_infra_tablests)); regenerate
   `database/schema.ts` against the **test** database.
2. Models `app/models/infra_node.ts`, `infra_port.ts`, `infra_link.ts`.
3. `app/services/infra_ports.ts` (ingest, bounded cache, `ensureNodeFor`),
   `app/services/infra_topology.ts` (`ensureAgentNodes`, layout, state, CRUD,
   the link transaction), `app/services/device_presence_query.ts` (extracted
   from `devices_controller.ts:970-1065`, plus the batch variant).
4. Ingest call sites: `app/services/ap_agent_metrics.ts` (`ingestPush`) and
   `app/services/collector_poller.ts` (the gateway block).
5. `app/controllers/infra_controller.ts`, `app/validators/infra.ts`,
   routes in `start/routes.ts` (a new `infra` group inside `/api/v1`, reads with
   `auth + requirePasswordChange`, writes with `requireAdmin`, before the SPA
   catch-all).
6. `app/services/collector_merge.ts`: `NON_HISTORY_TABLES` + `repointInfraNode`
   + dry-run output ([§5.3](#53-collectorsmerge-and-collectorspurge)).
7. Docs: this file stays the contract; add the role sentence to
   `README.md`. **Do not touch `docs/looking-glass-status.md`** (the owner
   writes the dev log).
8. Tests per [§12](#12-tests).

### (d) Dashboard — `metrics-be/dashboard/`

1. `package.json`: add `@xyflow/react` and `@dagrejs/dagre` (exact versions
   pinned at install).
2. `src/types/api.ts`: the types in [§7.1](#71-shared-types).
3. `src/hooks/use-infra.ts`, `src/lib/infra.ts` (labels, icons, LED and speed
   formatting, dagre auto-layout).
4. `src/pages/infrastructure-page.tsx` and
   `src/components/infra/{infra-canvas,device-node,host-node,port-strip,cable-edge,node-inspector,add-device-menu,infra-legend}.tsx`.
5. `src/app/router.tsx` (lazy route) and `src/lib/nav.ts` (nav item).
6. "Gateway agent" copy in `src/lib/collectors.ts`,
   `src/pages/collectors-settings-page.tsx`,
   `src/components/gateway/gateway-panel.tsx`
   ([§9](#9-gateway-agent-wording)).
7. Until (c) is merged: build against a throwaway fixture module in the session
   scratchpad (the Vite harness recipe), never committed.
8. Gates per [§12](#12-tests), plus the chunk-size numbers in the PR.

**Meeting points**: (a)+(b) agree only on the kit API; (a)/(b) and (c) agree on
[§4.4](#44-normalised-report-server-side); (c) and (d) agree on
[§7](#7-rest-api). Integration order: (c) can merge before (a)/(b) exist (nodes
appear, ports stay empty); (d) can merge before either, with the empty state
doing the talking.

---

## 14. Open questions

1. **Public rename.** The owner's decision, listed here as agreed: the product
   stays `perch-collector`; "Gateway agent" is UI wording only. If it should
   ever become a real name (package, repository, UCI file), that is a separate
   migration with a compatibility story.
2. **Should a collector without gateway stats get a node?** v1 says no. A
   collector on a mirror-port box is not in the path, and drawing it would
   imply it is.
3. **Auto-suggested cables.** v1 draws nothing on its own. FDB suggestions
   ([§11](#11-phasing)) would make the first map almost free for anyone with a
   managed device on both ends — worth doing early if the owner wants the map
   to fill itself.
4. **Virtual NICs of a container gateway**: reported only when the host has no
   hardware port (`VirtualAuto`). On a VM gateway with virtio NICs, those are
   hardware-backed and get `medium: virtual` from the driver name — fine, but
   it means a VM gateway shows its virtio NICs and a container gateway shows
   its veths, which are different-looking answers to the same question.
5. **Hiding noisy ports.** A container gateway reports one veth per network
   zone (nine on the surveyed box). v1 ships `hidden` and leaves the judgement
   to the operator; a "hide by default when the interface carries no default
   route and no board role" rule is possible later.
6. **SFP detection is unverified**: no SFP hardware was available. The
   `of_node/sfp` check is best-effort and the operator can override the medium.

---

## Appendix A: worked example

The awkward case the model has to survive: the router is a container on a
server, so it has no physical ports, and the cables leave from the server's
NICs. Everything below is placeholder naming.

Nodes:

| Node | Kind | Ports |
|---|---|---|
| `isp-a`, `isp-b` | `isp` | `uplink` each |
| `modem` | `modem` | `wan`, `lan1` |
| `server` | `host` (frame, contains the next three) | `nic0` (copper), `nic1` (copper) |
| `br-wan`, `br-lan` | `switch`, `virtual: true`, inside `server` | `nic-side`, `gw`, `spare` |
| `gateway` | `gateway` (bound to the collector), inside `server` | `wan0`, `wan1`, `lan0` — all `medium: virtual`, `wan0/wan1` role `wan` from the default routes |
| `ap-1`, `ap-2` | `access_point` (bound) | `wan`, `lan1…lan3` from the agent |
| `switch-1` | `switch`, 8 ports | `1…8` |

Cables: `isp-a.uplink → modem.wan` (fiber); `modem.lan1 → server.nic0`
(ethernet); `server.nic0` is the physical member of `br-wan`, so the *virtual*
switch's `nic-side` port is where the cable lands — draw the cable to
`br-wan.nic-side` and leave `server.nic0` as documentation, or (simpler, and
what the UI suggests) give the virtual switch the NIC as its own port and skip
the host's port list entirely. `br-wan.gw → gateway.wan0` (virtual);
`gateway.lan0 → br-lan.gw` (virtual); `br-lan.nic-side` is the server's 2.5 G
NIC and the cable from it runs to `switch-1.1` (ethernet); `switch-1.2 →
ap-1.wan`, `switch-1.3 → ap-2.wan`.

Result: every physical cable in the house is one `ethernet`/`fiber` link
between two ports that exist, and every hop inside the server is a `virtual`
link that is visibly different. The gateway's LEDs come from its veths (always
up), the AP uplinks' LEDs come from the APs themselves (real carrier and
speed), and the switch's LEDs are derived from the far ends.

## Appendix B: error codes

| Status | `error` | When |
|---|---|---|
| 401 | (auth middleware) | no or invalid token |
| 403 | `admin_required` | a write by a non-admin |
| 404 | `infra_node_not_found` / `infra_port_not_found` / `infra_link_not_found` | unknown id |
| 404 | `infra_binding_not_found` | `bind` names an AP/collector that does not exist |
| 409 | `infra_node_bound` | delete of a node that is bound to an agent row |
| 409 | `infra_node_already_bound` | `bind` on a node that already has a binding |
| 409 | `infra_agent_node_has_links` | `bind` when the agent's existing node carries cables |
| 409 | `infra_port_busy` | the port already carries a link (`linkId` in the body) |
| 409 | `infra_port_has_link` | hiding or dropping a cabled port |
| 409 | `infra_port_hidden` | linking a hidden port |
| 409 | `infra_port_present` | deleting an agent port the agent still reports |
| 422 | `infra_kind_not_manual` | `POST /nodes` with `kind: 'gateway'` |
| 422 | `infra_parent_invalid` | parent is not a host / is itself / would nest |
| 422 | `infra_field_not_applicable` | a field the kind does not have |
| 422 | `infra_port_key_duplicate` / `infra_port_key_taken` | key clash within a node |
| 422 | `infra_port_key_immutable` | renaming an agent port's key |
| 422 | `infra_link_same_port` / `infra_link_same_node` | degenerate link |
| 422 | `infra_binding_kind_mismatch` | binding an AP to a `gateway` node or vice versa |
| 422 | `infra_limit_reached` | node/port/link caps ([§6.5](#65-guard-rails)) |
| 422 | (Vine) `{ errors: [{ field, message, rule }] }` | shape/length/range |

## Amendments

### A1 — 2026-09-23: build rules for the four streams

1. **No release steps while v1 is built.** Nothing is committed, tagged,
   pushed, released or installed; that is the owner's call afterwards. The root
   `go.work` already maps the kit's `v0.1.0` to `./perch-agentkit`, so both
   daemons compile and test against the new port reader with no `go.mod`
   change. Release order, later: tag `perch-agentkit` `v0.2.0`, bump both
   daemons' `go.mod`, point the `go.work` `replace` at `v0.2.0`, then tag the
   daemons. Until then a `GOWORK=off` build (CI) does not see the new API, which
   is expected. Streams do not edit `go.mod` / `go.sum` and do not run
   `go mod tidy`. This replaces "tag `v0.2.0`" in §4.1 and §13(a) items 1–2,
   and the `go.mod` bumps in §13(a) item 3 and §13(b) item 1.
2. **Read-only checks on real devices.** Stream (a) may copy its `perch-apd`
   build to `/tmp` on each access point, run `perch-apd ports` and
   `perch-apd info`, and delete it (the recipe in the workspace notes). Stream
   (b) may do the same on the gateway with a no-cgo `perch-collector` build,
   running only `perch-collector ports`, under a timeout, and only after a test
   shows that subcommand exits before any config, capture or network work.
   Nothing else runs on a device: no install, no config or service change, and
   the running daemons are left alone. What a device prints goes into the
   stream's report, never into the repositories. Fixture trees are named after
   their shape (`dsa-conduit`, `gmac-wan`, `independent-netdevs`,
   `container-veths`, …), not after a product or a host, and use MACs from
   `02:00:00:…`.
3. **Presence extraction (stream c).** Since this design was written,
   `queryDevicePresence` also reads the device's label for the operator's
   Ethernet mark (`device_labels.connection`, passed as
   `devicePresence({ …, ethernet })`). Move the three functions as they are now
   (the line numbers in §7.3 are stale); the batch `queryDevicePresences`
   passes the mark too.
4. **Host frames in v1** are assigned from the node inspector (an "Inside
   host" select, `PATCH parentId`). Drag-to-reparent stays v2 (§11).
5. **Naming.** The owner has retitled `go-collector/README.md` "Perch Network
   Collector / Perch Network Gateway" and calls the role the "Perch Network
   Gateway agent" (an uncommitted edit in that repository; stream (b) keeps it
   verbatim and builds on it). §9's "Gateway agent" wording matches. Package,
   binary and repository names stay `perch-collector` (§14.1).
6. **Shared working trees.** The streams share the working trees (no
   worktrees: `metrics-be` carries uncommitted work they build on). Each stream
   edits only its own files (§13). Only stream (c) runs the controller's
   migrations and test suite, against the test database only. Stream (d)'s
   `npm run build:dashboard` rewrites `metrics-be/public/`.
7. **Kit API freeze.** Once stream (a) reports the kit's port reader ready, its
   exported API is frozen for stream (b); a later change must be additive, or
   agreed through the lead.
8. The dev log (`docs/looking-glass-status.md`) is the lead's.

### A2 — 2026-09-23: kit as built, and three rule refinements

The kit's exported API is §4.1 exactly. As built:

- `Read()` returns `nil` only when `/sys/class/net` cannot be listed, and
  otherwise a non-nil slice (`[]` when there are no ports). That is how an
  agent tells "absent" from "none". A `json:",omitempty"` tag drops `[]` as
  well, so the collector needs its own way to send `"ports": []` (§4.3).
- Roles are not cached: `Options.WAN` applies on the next `Read()`. `Read()`
  is safe for concurrent use; change `Options` only between reads.
- The virtual-driver list also has `vif` and `xen_netfront` (Xen's netfront
  registers under those names, never `xen-netfront`).
- Fixtures are one text file per shape, built into a temporary tree by the
  test: Go module zips drop symlinks and git drops empty directories, and
  sysfs is full of both.

Changes to §2.1:

1. `DEVTYPE=wwan` (a cellular modem in 802.3 mode) is a port with medium
   `wireless`. It is part of the path; calling it a copper socket is wrong,
   and hiding it would lose a router's WAN. It does not count as the wired
   hardware port that makes `VirtualAuto` hide virtual NICs, so a container
   gateway with a passed-through modem keeps reporting its veths.
2. `DEVTYPE=vlan` with no `lower_*` symlink (a VLAN the host hands into a
   container) is treated like step 8: a virtual NIC under the virtual policy,
   like macvlan. Bridges, bonds and teams stay skipped, and so does a VLAN
   stacked on a local device.
3. `board.json` roles apply only to hardware ports (steps 4 and 7), never to
   step-8 virtual NICs. A container's `/etc/board.json` is its host's: on the
   surveyed gateway it names the container's `eth0` veth as LAN.
   `Options.WAN` still applies to every port.

### A3 — 2026-09-23: the controller as built (stream c)

No response shape of §7 changed. Where the body was silent or disagreed with
itself, the controller does this:

1. **Two columns beyond §5.1.** `infra_nodes.origin` (`agent` | `manual`,
   default `manual`) is set when the server creates a node for an agent row
   and when `bind` puts a node on one. `source` and `detached` (§7.1) are read
   from it: a detached node and a manual one both have no binding.
   `infra_ports.reported_medium` holds the agent's medium next to
   `reported_label` / `reported_role`, and `medium` is the operator's override
   (null = the agent's). That is what "medium when the operator has not
   overridden it" (§5.2) needs; `PATCH /ports/:id { "medium": null }` goes
   back to the agent's. API `medium` = `medium ?? reported_medium`.
2. **Position.** The report order sets `position` when an agent port first
   appears or is adopted; after that it is the operator's. §5.2 had every
   write set it, which would undo a `PATCH position` at the next carrier
   change.
3. **Adoption** keeps the pin's label, role, hidden flag and cable, and drops
   its medium (the agent reads that from the hardware). The key takes the
   agent's spelling.
4. **Keys are case-insensitive**, like the `utf8mb4_unicode_ci` unique index:
   `LAN1` and `lan1` are one port, a report naming both keeps the first, and a
   pin `WAN` is adopted by a reported `wan`.
5. **Pruning** also keeps a missing agent port with a medium override (§5.2
   lists cable, label, role and hidden).
6. `reported_at` moves when a report changes the row; identical reports are
   not written at all (§5.2 step 3).
7. **`portsSupported`.** AP: `true` when `system.info` lists the `ports`
   capability, `false` for a scraped row or an agent whose capabilities lack
   it, `null` while an agent has not answered `system.info` yet (empty list).
   Collector: `true` when its last gateway report carried a `ports` array,
   kept as `last_status.gateway.portsReported: true` (absent otherwise, so the
   stored block of an older collector does not change); else `null`, never
   `false`.
8. **Node status** takes "the last accepted report" from the agent row's
   `last_seen_at`, aged by the database, so it survives a controller restart.
9. **Derived manual ports** (§7.3) are `live: true` and take `up`,
   `speedMbps`, `duplex` and `changedAt` from the far end; `adminUp`,
   `operstate` and `carrierChanges` stay null (they are the far device's). An
   agent port that is not live keeps its last reported state with
   `live: false` (§6.3, "greyed").
10. **Kinds** (§7.4). `sfpPorts` is accepted where the catalog says
    `supportsSfp`: `switch` and `host` (§7.2 gives the host SFP cages, §7.4
    said switch only). Templates: host `nic0…`, device `eth0…`, modem and
    access point like the router (`wan` + `lan1…`), ISP exactly one port.
    `sfp…` template ports have medium `sfp`; the ISP uplink has none.
    `ports: []` on create means no ports.
11. **Display name** of a device node falls back to its device label's name
    before the kind label.
12. **Errors.** `infra_port_key_taken` is 409 as §7.8 says (Appendix B said
    422); `infra_port_key_duplicate` (twice in one request) is 422.
    `PATCH /nodes/:id` with `kind`, `collectorId` or `apId` is 422
    `infra_field_not_applicable`. A bind body with both or neither of `apId` /
    `collectorId` is a 422 in Vine's shape. Refusal bodies carry the ids they
    name (`nodeId`, `portId`, `linkId`, `key`, `field`, `parentId`,
    `binding`); `infra_limit_reached` adds `limit` (`nodes` | `ports` |
    `links`) and `max`; `infra_port_has_link` lists `ports: [{ id, key,
    linkId }]`.
13. **Merge** (§5.3). `repointInfraNode(trx, { survivorId, removedId, intoId })`
    runs in the merge transaction before the removed row is deleted. With a
    node on both sides and as many cables on each, the node of `--into` stays
    bound (its ports are the running collector's). The plan and the result
    print one line about the node; `collectors:purge` says which node it
    detaches.
14. **Presence** (§7.3). `queryDevicePresences(macs, thresholds?)` takes the
    request's presence settings as an optional second argument, so
    `/infra/state` reads Settings → Presence once per request.

### A4 — 2026-09-23: v1.1, devices on the map and the Wi-Fi overlay

The owner, after drawing the first layout: bind boxes to devices Perch knows ("Anton's
PC" as a desktop on an unmanaged switch port; the wired camera that is the Garage AP's
100 Mb/s client), and a toggle that shows which Wi-Fi devices are on which AP. The
agents need no change: `/api/v1/wifi/clients?activeOnly=true` already returns every
connected client with its AP, SSID, band, signal quality, names and device type.

**Controller (stream c2)**

1. **`deviceMac` on every manual node except `isp`**: `device`, `switch`, `router`,
   `modem`, `host` and manual `access_point`. On an agent-bound node it stays 422
   `infra_field_not_applicable`.
2. **One node per device.** Binding a MAC that another node carries is 409
   `infra_device_already_placed` `{ error, message, nodeId }`. Migration
   `1779000000045_…` replaces `infra_nodes_device_mac_idx` with a unique index (many
   NULLs allowed) as the backstop; the service checks first so the error is clear.
3. **Names follow the device.** On `POST /infra/nodes`, `name` is optional when
   `deviceMac` is set (still required otherwise). The resolved `InfraNode.name` is the
   first of: `nameOverride`, the binding's name, the device label's name, the device's
   hostname, its MAC, the kind label. `InfraNode.device` gains `hostname: string | null`
   (the hostname enrichment by MAC, as `/wifi/clients` does it) and
   `primaryIp: string | null` (the most recent `device_identities` row across
   collectors).
4. **`linkTo` on `POST /infra/nodes`**:
   `linkTo?: { portId: number; ownPortKey?: string; medium?: InfraLinkMedium }`.
   - After the node and its ports exist, in the same transaction, it cables `ownPortKey`
     (default: the new node's first port by position) to `portId`, by the §6.4 rules and
     their error codes.
   - A node without ports is 422 `infra_field_not_applicable` (`field: 'linkTo'`).
   - Any failure rolls the whole create back.
   - **201** `{ "data": { "node": InfraNode, "link": InfraLink | null } }`.
5. **Device attachments**: where a device is on the map.

   ```ts
   type DeviceAttachment = {
     nodeId: number
     nodeName: string                 // resolved as in item 3
     uplink: {                        // its cabled port with the lowest position; null when not cabled
       linkId: number
       medium: InfraLinkMedium
       nodeId: number                 // the far end
       nodeName: string
       nodeKind: InfraNodeKind
       portId: number
       portKey: string
       portLabel: string
       live: boolean                  // the far port is a live agent port (§7.3 rules)
       up: boolean | null             // its link, when live
       speedMbps: number | null
       duplex: 'full' | 'half' | null
     } | null
   }
   ```

   Served on every `/api/v1/devices` row as `attachment: DeviceAttachment | null`, and on
   `GET /api/v1/devices/:mac/presence` as `attachment` next to `status` / `via` /
   `lastSeenAt`. Both are read per request, never from the device list's cache.
6. **Presence** (`devicePresence`). The input gains
   `onMap?: { wired: boolean; link: { up: boolean; at: number } | null }`:
   - `wired`: the device has an uplink whose medium is `ethernet` or `fiber`.
   - `link`: the uplink's far end is a live agent port. `up` is its link state; `at` is its
     last report while up, and when the link went down (`state_changed_at`) while down.

   Rules:
   - An AP listing the device still comes first.
   - Otherwise, `ethernet` (the label's mark) **or** `onMap.wired` gives `via: 'ethernet'`:
     connected while traffic is within the wired timeout **or** `link.up`, with
     `lastSeenAt` = the later of the last traffic and `link.at`. The Wi-Fi memory rule is
     skipped for these devices, as for the mark.
   - Everything else is unchanged.

   The one-device and batch queries pass it; so does the `presence` field of
   `/infra/state`.
7. Tests for each item. Old clients keep working: every change is additive.

**Dashboard (stream d2)**

1. **Connect a device to a port** (edit mode): a "Connect a device…" action on a port,
   in the inspector's port list and on the port itself.
   - It opens a searchable device picker showing name, type icon, IP and MAC. Devices
     already on the map are shown as placed and cannot be picked.
   - It sends `POST /infra/nodes { kind: 'device', deviceMac, linkTo: { portId },
     position }` with a free position next to the port's node, and no name, so the box
     follows the device.
   - If the device's label has no type, the dialog offers the label taxonomy and saves it
     with `PATCH /api/v1/devices/:mac/label { deviceType }`.
   - "Add device → Device" starts with the same picker, and its name becomes optional.
   - "Bind to a device…" in the inspector covers every kind item 1 allows.
2. **Device-bound nodes** show the device's type icon (`deviceTypeMeta`), the resolved
   name, a presence dot from `/infra/state`, and a subtitle "type · presence". The
   inspector adds "Open device" (→ `/devices/:mac`).
3. **Device views**:
   - The devices page's connection line, for an attached device, reads
     "{connectionLabel(via)} · {uplink.nodeName} · {uplink.portLabel}", plus the speed
     when live and up (e.g. "Ethernet · Garage AP · lan1 · 100 Mb/s").
   - The device page's Location tile says "Ethernet" with that line as its sub, and a
     "Show on the map" link to `/infrastructure?node=<nodeId>`.
   - The Infrastructure page selects and centres the node named in `?node=`.
4. **Wi-Fi overlay**: a "WiFi clients" toggle in the page header, in both modes and on
   phones, remembered per browser (localStorage, guarded). While it is on:
   - `GET /api/v1/wifi/clients?activeOnly=true` is polled every 10 s, and only while on.
   - Each AP node (binding `ap:<id>`) gets its connected clients as small client nodes
     placed deterministically around it, without overlapping other nodes. They are not
     persisted and not draggable; auto-arrange and position writes ignore them.
   - Wireless edges are dashed and coloured by signal quality (the existing signal
     palette). A client node shows its type icon, its name (`customName ?? hostname ??
     MAC`) and its band.
   - More than 12 clients on an AP: the 11 strongest, plus a "+N more" chip whose
     inspector lists the rest.
   - A client already on the map as a node gets no chip; its wireless edge runs from that
     node to its AP.
   - Clicking a client opens the inspector: SSID, band, signal, PHY rates, AP, and links
     to the Wi-Fi client page and the device page. In edit mode it also offers "Put on the
     map" (a device node bound to it next to its AP, no cable).
   - The legend gains a WiFi section.
5. **Types** for everything above: `DeviceAttachment`, `DeviceSummary.attachment`, the
   presence response's `attachment`, `InfraNode.device.hostname` / `primaryIp`, and the
   create response's `link`.

### A5 — 2026-09-23: v1.1 controller as built (stream c2)

No response shape beyond A4's changed. Where A4 was silent, the controller does
this:

1. **`onMap.link`.** `at` while up is the far agent's last accepted report (its row's
   `last_seen_at`, as in A3 item 8): a port row's `reported_at` only moves when a report
   changes the row (A3 item 6). While down it is `state_changed_at`, or the last report
   when that is unknown. A live far port that reports neither carrier nor operstate gives
   `link: null`, as §7.3's cable state ignores such an end. The uplink's `speedMbps` and
   `duplex` are null unless `live`.
2. **What counts as on the map.** Every node that carries the MAC, hidden or not. A node
   with no cabled port gives `uplink: null` and `onMap: { wired: false, link: null }`, which
   changes nothing. `wired` comes only from `ethernet` or `fiber`. `link` is computed
   whatever the medium and counts wherever A4's rule reads it (the Ethernet mark or
   `wired`).
3. **`deviceMac` refusals.** Kinds `isp` and `gateway`, and any node bound to an agent
   row, get 422 `infra_field_not_applicable` with `field: 'deviceMac'`. A detached node is
   not bound, so it may carry a device. `deviceMac: null` on a bound node is accepted (it
   clears). `bind` keeps a node's device MAC; its name then resolves to the agent's first
   (A4 item 3 order).
4. **`name` on create.** A blank name counts as none (the body parser turns it into
   null): with `deviceMac` the node follows the device, and without it the reply is Vine's
   422 on `name` (`rule: 'required'`).
5. **`linkTo`.** An `ownPortKey` the new node does not have is a Vine-shaped 422 on
   `linkTo.ownPortKey` (`rule: 'exists'`). Keys match case-insensitively (A3 item 4). "First
   port by position" is the lowest stored position, ties in the order given. Every §6.4
   refusal (404 `infra_port_not_found`, 409 `infra_port_busy` / `infra_port_hidden`, 422
   `infra_limit_reached` with `limit: 'links'`) rolls the whole create back: no node, no
   ports, no cable, and the MAC stays free. A write that loses a race on a unique index
   gets the refusal the locking reads would have given (`infra_device_already_placed` or
   `infra_port_busy`).
6. **`infra_device_already_placed`** is exactly `{ error, message, nodeId }`, from POST
   and PATCH. Any spelling of a MAC (case, dashes) is the same device.
7. **`primaryIp`** comes from the most recently seen identity *that has one*: a newer row
   with no primary IP is skipped.
8. **Migration `1779000000045_make_infra_nodes_device_mac_unique.ts`.** It clears
   duplicates first. Per MAC the lowest node id keeps it; the other nodes keep everything
   else (ports, cables) and their `updated_at` moves. Grouping uses the column's collation,
   so case variants count as one MAC, exactly as the unique index will. It then runs one
   `ALTER TABLE` built from the indexes that exist, so a rerun finishes any partial state.
   `down()` restores the plain index, not the cleared MACs. `database/schema.ts` does not
   change (the migration only touches an index).
9. **Presence queries.** `queryDevicePresence(mac, thresholds, onMap)` and
   `queryDevicePresences(macs, thresholds, onMap)` take every argument (A3 item 14's
   optional thresholds are now required), so no caller can leave the map out.
   `/infra/state` builds `onMap` from the rows it has already read, with no extra query.
   `/devices` and `/devices/:mac/presence` call `loadDeviceAttachments(macs, thresholds)`
   in `infra_topology.ts`. It costs one query when no node carries any of the MACs, and
   otherwise at most five, whatever the number of rows: the nodes; their cables with the
   far ends; `wifi_access_points` and `collectors`, only when a bound node is involved;
   the hostname settings, only when a node has no name of its own. Device labels come
   from their cached map. The far end goes through `nodeStatus` and `agentPortLive`, the
   rules `/infra/state` uses.
10. **`/infra/state` `presence`** stays `{ status, via, lastSeenAt }`. The map is on the
    page already, so it has no `attachment`.
11. **`/devices`** gives a MAC the same attachment on every collector's row.
