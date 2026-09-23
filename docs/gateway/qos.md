# Traffic shaping (QoS) on a managed gateway

Status (2026-09-23): data model, settings, WAN SQM mapping, the WAN queue API, read APIs and the
planner (branch `gw/qos`); policy / group / assignment / schedule writes, the device-set sender, the
`perch-qos` package seam, expiry, the portal-facing API and the live ingest (branch `gw/ctl-qos`,
sections 5.2 to 8); router writes of config (`sqm`, `perch-qos`) through the config plane's apply path
([config-plane.md](config-plane.md) 6.8; branch `gw/plane-writer`: sections 2.4 and 6.3). Device entries
go to the agent directly (`qos.devices.set`). The agent side is `perch-collector` `internal/qos` and the
`perch-qos` package.

Scope: WAN SQM (sqm-scripts, two-way synced), per-device and bucket caps (HTB on two Perch ifbs, fed
from the LAN side), nested buckets, weekly schedules, quotas (the primitive the captive portal reuses).

Owner decisions (2026-09-23) this document follows:

| # | Decision |
|---|---|
| 13 | Caps apply to internet traffic only. A policy can also shape LAN↔LAN traffic (`includeLan`, default off). |
| 14 | The live gateway keeps its imported WAN 1 queue and rates; no device caps there. Caps are for guest and lab networks. |
| 15 | A router-side `sqm enabled=0` is a safety pause. Authoritative Mode never reverts it; the dashboard shows it loudly. |
| 16 | v1: operators see every cap (editing stays admin-only), nested buckets and schedules. |
| 17 | Speed test and SQM auto-tune are out of v1. |

The kernel design was proven in the lab (amendment `qos-kernel-2026-09-23`): the HTB tree, CAKE rest
leaves, nesting four deep, hitless rate changes and class moves, `tc-tiny` is enough, sqm on the WAN
coexists.

## 1. Three kinds of state

| State | Where | Sync |
|---|---|---|
| WAN queues | `/etc/config/sqm` `queue` sections (native, luci-app-sqm) | two-way, through the config plane (`sqm` domain) |
| Shaper structure: buckets, network defaults, schedules, globals | `/etc/config/perch-qos` (Perch-owned) | controller → router; router edits are drift, except `globals.enabled '0'` (a local pause) |
| Per-MAC entries | `qos.devices.set` RPC; agent cache `/etc/perch-qos/devices.json` | controller only; runtime state, never config |
| Policies, groups, assignments, schedules, quota usage | controller DB (`qos_*` tables) | none; the planner turns them into the two rows above |

## 2. WAN SQM

### 2.1 Mapping (`app/services/sqm_mapping.ts`, pure)

The source of truth is the section's full option map, stored verbatim in `qos_wan_queues.options`.
The API fields are views; a write touches only the options it maps. Unmodelled options (`tcMTU`,
`ilimit`, `itarget`, anything newer, lists included) and unmodelled cake keywords inside the opts
(`wash`, `ack-filter`, `memlimit 32mb`, `rtt 50ms`) survive every write.

| API field | UCI option(s) | Rule |
|---|---|---|
| `device`, `enabled` | `interface`, `enabled` | Linux device; must be a WAN interface of the gateway's last report, one of its ports, or the device of an existing queue (else `422 qos_unknown_device`) |
| `downloadKbit`, `uploadKbit` | `download`, `upload` | kbit/s; 0 = that direction unshaped; otherwise ≥ `minWanKbit` |
| `qdisc` | `qdisc` | writes `cake` or `fq_codel`; any other router value (e.g. `sfq`) is kept and shown read-only (flag `qdisc_unmodeled`). Switching to cake picks a cake script; to fq_codel, `simple.qos` |
| `diffserv` | `script`, opts | `besteffort` → `piece_of_cake.qos`; `diffserv3` → `layer_cake.qos`; `diffserv4`/`8` → layer_cake + the keyword in both opts |
| `fairness`, `nat` | `eqdisc_opts`, `iqdisc_opts`, `qdisc_advanced`, `qdisc_really_really_advanced` | `per_host` = `dual-srchost` / `dual-dsthost`, `triple_isolate`, `per_flow` = `flows`; `nat` / no `nat`. Keywords are replaced in place, the others kept. fq_codel reads as `per_flow`; cake fields on a non-cake queue: `422 qos_field_needs_cake` |
| `linkLayer`, `overhead`, `mpu` | `linklayer`, `overhead`, `linklayer_advanced` + `tcMPU` | overhead / MPU need a link layer (`422 qos_overhead_needs_linklayer`) |
| `ingressEcn`, `egressEcn`, `squashDscp`, `squashIngress` | `ingress_ecn`, `egress_ecn` (`ECN`/`NOECN`), `squash_dscp`, `squash_ingress` | writing any sets `qdisc_advanced '1'` |
| `advanced` | any other option | keys merge, `null` removes; a key with a typed field: `422 qos_option_has_field` |

Views read what sqm actually runs: opts only count with `qdisc_advanced` and
`qdisc_really_really_advanced` both on (`inert_opts` flag otherwise), ECN/squash only with
`qdisc_advanced`, MPU only with `linklayer_advanced`. A queue Perch creates is cake besteffort with
NAT-aware per-host fairness ("Fair sharing"), exactly the lab's hand-made queue
(`nat dual-srchost` / `nat dual-dsthost ingress`). When Perch switches inert opts on, the old inert
keywords are dropped (warning `sqm_inert_opts_replaced`).

`normalizeSqmOptions()` is the equality form (booleans, numbers without padding, ECN case, opts
spacing, sqm's defaults filled in): formatting and spelled-out defaults never count as drift.

Flags on a queue: `qdisc_unmodeled`, `script_unmodeled`, `fairness_unmodeled`, `fairness_mixed`,
`nat_mixed`, `diffserv_unmodeled`, `invalid_rate`, `invalid_overhead`, `invalid_mpu`,
`unknown_linklayer`, `inert_opts`, `duplicate_device` (two enabled queues on one device: both kept),
`router_paused` (decision 15).

### 2.2 The `sqm` config domain (`app/services/sqm_domain.ts`)

Claims `sqm` `queue` sections, owns the whole section, `normalize` = `normalizeSqmOption`,
`requires` sqm-scripts, `parse`/`render` carry the option map verbatim (round-trip identity is
tested on every fixture). No identity keys (duplicates are flagged, not made ambiguous).

Decision 15 is expressed through ownership: while the router holds the queue at `enabled '0'`, Perch
does not own `enabled`, so the router's value always wins (never drift, never a conflict, never
reverted) and every other option stays Perch's. The domain's `routerPause` rule makes the engine apply
this on every read, not only on import (config-plane.md 6.8): the router switching a queue off holds
`enabled`, switching it back releases it. A queue Perch creates disabled is Perch's (no hold).

### 2.3 Router import (`recordRouterSqm`, `app/services/qos_wan_queues.ts`)

The plane's read listener (`onRouterRead`, installed by `installPlaneWriters()`) calls it with each
read of the router's `sqm` config, with the plane's view of each section:

- a new section becomes a row with `origin: 'router'`, options as they are (the live gateway's
  untagged `eth1` stays untagged: `perch_id` comes from the ledger only);
- changed options are taken over (`router_updated_at`);
- enabled → disabled on the router sets `router_paused_at` (decision 15); back on clears it; a queue
  that was never on is not a pause;
- vanished sections are removed; controller rows not yet on the router (null `uci_section`) stay;
- with the plane: a section whose controller change waits for its apply (status `ahead`, `pending`,
  `conflict`) keeps the row's desired options, a pending delete is not re-created, and a pending create
  (the plane row has no router side yet) is not removed.

### 2.4 The write seam (`app/services/sqm_plane.ts`)

```ts
interface SqmQueueChange {
  action: 'create' | 'update' | 'delete'; gatewayId: number; queueId: number | null
  perchId: string | null; uciSection: string | null
  options: UciOptions | null        // full desired map; null on delete
  changed: string[]; userId: number | null; requestedAt: string
}
interface SqmPlaneAccepted { perchId: string | null; uciSection: string | null; revision: number }
interface SqmPlaneWriter { submit(change: SqmQueueChange): Promise<SqmPlaneAccepted> }  // or throws SqmPlaneError
class SqmPlaneError { status: 409 | 422 | 503; code: string; extra: Record<string, unknown> }
setSqmPlaneWriter(writer): SqmPlaneWriter   // install at boot; returns the previous one
```

`SqmPlaneAccepted` also carries `applyId`, `state: 'queued' | 'applying' | 'applied'`, `apply` (the
config plane's `GatewayApply`) and `applyError: {error, message} | null` (why no apply started: the draft
is kept, e.g. `apply_in_flight`).

**`PlaneSqmWriter`** (`app/services/qos_plane_writers.ts`, installed at boot by
`providers/qos_plane_provider.ts`, web only; `StubSqmPlaneWriter` stays the default elsewhere):

1. refuses early: `409 qos_not_managed`; `409 config_not_allowed` when the router's
   `capabilities.allowedConfigs` lacks `sqm`, with what to do (install sqm-scripts, which joins the
   allowlist by itself; or `list managed_config 'sqm'`; section 6.3 `planeAccess`); `409 sqm_not_read`
   (an update of a queue the plane has not read); `409 sqm_not_synced` (the router's queue is
   excluded or unmodeled);
2. renders the change through `sqmDomain.render()` (a create is a put without a perch id, named
   `perch_<id>`; a delete a delete edit) into `editSections(gatewayId, actor, 'sqm', edits)` (the
   admin's user id; `{system: 'qos'}` without one); the plane's refusals pass through (`422
   invalid_config {issues}`, `409 pending_apply`, …);
3. asks for an apply of exactly that section (`requestApply({perchIds})`, the confirm mode of Settings →
   Gateway: in `admin_and_agent` the dashboard offers "Keep changes" on the returned `apply`);
4. a router refusal of that apply (nothing changed on the router) drops the draft of the section and
   becomes the refusal: `422 sqm_below_floor` (+`minWanKbit`, `applyId`: the router's floor,
   perch-qos `globals.min_wan_kbit`), `422 invalid_config`, `409 config_not_allowed`, `409` with the
   agent's code otherwise.

The endpoints then store the row (`uci_section` = the name the apply gives it, `origin` unchanged,
`controller` for new ones) and answer `{queue, warnings, apply, applyError}`; `queue.sync` follows the
plane's section and its newest apply: `queued` (`offline` while the agent is away) → `applying`
(sent, waiting for the confirm) → `in_sync`, or `rolled_back` / `failed` with `error` = the apply's
reason while the draft waits. `DELETE /qos/wan-queues/:id` answers `200 {queue, apply, applyError}`:
`queue` is null once the router has no such queue, else the queue it still runs (flag
`pending_delete`) until the apply confirms and the next read drops the row.

## 3. Buckets, caps and the planner (`app/services/qos_plan.ts`, pure)

### 3.1 Kernel objects (plan 3 section 3.2, amendment section 1)

Download: WAN → sqm's `ifb4<wan>` (line-rate CAKE) → routing → LAN L3 device egress `clsact`:
pass rules first (ARP, broadcast, one `pass` per exact LAN prefix, never a covering prefix), then a
flower filter per MAC (`skbedit priority 1:<class>` + `mirred` to `ifb-pdn`), then a network default
(`matchall`). Upload: the same on LAN ingress to `ifb-pup`. On each ifb: `htb 1: default 0`, root
`1:1`, classes chosen by `skb->priority`. `quantum 1514` on every class; fq_codel device leaves and
CAKE rest leaves with bounded memory (`leafLimitPackets`, `leafMemoryKb`, `restMemlimitKb`).

Class minors: buckets `0x02–0xff` (one per policy, assigned by the controller, stable while the row
exists; `allocateClassMinor()`), a bucket's rest leaf `0x100|b`, device leaves `0x200–0xfffe`
(allocated by the agent).

### 3.2 Policies and precedence

A policy has `shared` (a bucket everything assigned to it shares) and/or `each` (a cap per member).
Both = caps inside a ceiling (the paid-hotspot case: guest 50 Mbit/s in total, 5 Mbit/s per voucher). Rates are
kbit/s; in the DB a NULL pair = no such part, 0 = unlimited that way; on the wire `null` = unlimited.

Assignments target a device (MAC), a group, or a network (UCI interface, the default the router
applies to MACs without an entry). Precedence per MAC: own device assignment, else its group's, else
the network default. Inactive assignments (expired, policy disabled or gone, nothing to shape) fall
through. An assignment's own `rate` overrides the policy's `each`. Quotas ride on device assignments
only.

### 3.3 Nested buckets (decision 16, amendment section 5)

`qos_policies.parent_policy_id` puts a policy's bucket inside another's. Rules (errors leave the child
standing alone at the top):

- the parent exists, is enabled and has a usable shared bucket; no cycles;
- depth ≤ `maxBucketDepth` (default and maximum 4: HTB's 8 levels minus root and leaves);
- a child's ceiling within its parent's (`qos_child_exceeds_parent`);
- the children's rates add up to at most the parent's (`qos_children_exceed_parent`, error, HTB's
  guarantee; the agent refuses otherwise).

Only referenced buckets and their ancestors are rendered, parents first. Re-parenting on the router is
a subtree delete + add (briefly drops its queues); a rate change is hitless.

### 3.4 Schedules (decision 16, amendment section 6)

A schedule is a weekly window in which a policy or an assignment behaves differently. The **router**
evaluates the windows on its own clock (`system.zonename`) and switches rates (`tc class change`) or
moves MACs (`tc filter replace`) hitlessly, so schedules run while the controller is away and never
need a config-plane apply at their edges. The planner therefore renders them as data; the plan does
not depend on the time of day. The controller shows a preview (`active`) in its `timezone` setting.

| Target | `action` | While the window is active |
|---|---|---|
| policy | `limit` | the bucket's rates (`down_kbit`/`up_kbit`) and the policy-capped members' / network defaults' caps (`each_*`); `''` = keep |
| policy | `unlimited` | the policy's caps are lifted |
| assignment | `limit` | the target's caps (`each_*`) |
| assignment | `unlimited` | the target is unshaped |
| assignment (device, group) | `block` | no internet; the pass rules keep DNS and the portal reachable |
| assignment | `policy` (rendered `move`) | the members sit in the other policy's bucket with its `each` caps |

Window grammar (`list window`): `<days> <HH:MM>-<HH:MM>`, days = comma list of `mon…sun` and ranges
(`mon-fri`, `mon,wed,fri-sun`), the days a window starts on; an end at or before the start runs past
midnight (equal = 24 hours). Entries, buckets and network defaults list the schedules that apply to
them in precedence order (the assignment's own before its policy's); the first active one wins.
Until NTP has synced the agent applies the no-schedule rates (`schedule_clock_unsynced`).

### 3.5 `perch-qos` (the planner's `sections`)

```
config globals 'globals'
	option enabled '1'              # router '0' = local pause, never auto-reverted
	option min_wan_kbit '1000'
	option min_device_kbit '64'
	option leaf_flows '64'
	option leaf_limit '1000'        # fq_codel limit (packets) per device leaf
	option leaf_memory_kb '1024'    # fq_codel memory_limit per device leaf
	option rest_memlimit_kb '4096'  # CAKE memlimit per rest leaf
	option dynamic_idle '1800'
	option dynamic_limit '1024'
	list exempt '198.51.100.0/24'   # extra never-shaped prefixes, each exact
config bucket 'b12'
	option policy '2'               # the policy id (live counters key "b:<policyId>")
	option class '0x12'
	option parent ''                # parent bucket name, '' = under the root
	option down_kbit '50000'        # 0 = unlimited that way
	option up_kbit '10000'
	option fairness 'per_host'      # rest leaf: per_host → CAKE dual-*host; per_flow → fq_codel
	option include_lan '0'          # decision 13
	list schedule 's7'
config network 'guest'
	option policy '2'
	option bucket 'b12'             # '' = none
	option each_down_kbit '5000'    # '' = no dynamic per-MAC leaves
	option each_up_kbit '1000'
	option include_lan '0'
	list schedule 's7'
config schedule 's7'
	list window 'mon-fri 18:00-23:00'
	option policy '2'               # or: option assignment '<id>'
	option action 'limit'           # limit | unlimited | block | move
	option down_kbit '25000'
	option up_kbit ''
	option each_down_kbit '2500'
	option each_up_kbit ''
```

`DeviceEntry` (`qos.devices.set`, at most 4096, sorted by MAC):

```ts
{ mac: string; bucket: string | null; downKbit: number | null; upKbit: number | null
  quota: { limitBytes; usedBytes; onExhausted: 'block' | 'throttle'; throttleDownKbit; throttleUpKbit
           resetAt?: string } | null   // present after an admin reset (section 6.2)
  expiresAt: string | null
  includeLan?: true          // decision 13
  schedules?: string[] }     // decision 16, precedence order
```

`planQos(input)` returns `{ sections, devices, origins, networkOrigins, issues, activeSchedules,
nextChangeAt, fingerprints }`. It never throws; problems are `issues` (`error` / `warning`, with the
policy, assignment, schedule, MAC or network they concern). `origins[mac]` = `{assignmentId, policyId,
via: 'device'|'group'}` of each entry, `networkOrigins[network]` = `{assignmentId, policyId}` of each
network default (the read side's `via`). `fingerprints.config` / `.devices` (sha256) let the sender send
only on change; the devices fingerprint ignores `quota.usedBytes`, so persisting the router's own count
never causes a resend. `loadPlanInput(gatewayId, at, client?)` (`qos_reads.ts`) builds the input from
the tables (inside a transaction when given one), including the controller's pause.

`checkPolicyTree(policies, maxDepth)` checks the bucket tree over every policy, referenced or not
(`planQos` checks only the buckets it renders): `qos_parent_missing`, `qos_parent_cycle`,
`qos_parent_not_bucket`, `qos_child_not_bucket` (only a policy with a shared bucket nests),
`qos_child_exceeds_parent`, `qos_bucket_too_deep`, `qos_children_exceed_parent` (on the parent; enabled
children only), warning `qos_parent_disabled`.

## 4. Data model

All tables hang off `gateways` (ON DELETE CASCADE). Only `gateways` references `collectors`
(config-plane rule), so `collectors:merge` moves QoS data with its gateway and needs no entry.
Migrations `1779000000080`–`086`. Unions are strings checked in the app layer; MACs are lowercase
colon form, joined with other MAC columns in JS.

| Table | Columns (besides id, gateway_id, timestamps) | Keys |
|---|---|---|
| `qos_wan_queues` | `uci_section` null, `perch_id` null, `device`, `enabled`, `options` (JSON, full UCI map), `origin` controller\|router, `router_updated_at`, `router_paused_at` | unique (gateway, uci_section), (gateway, perch_id) |
| `qos_policies` | `name`, `notes`, `shared_down/up_kbit`, `each_down/up_kbit`, `fairness` per_host\|per_flow, `include_lan`, `parent_policy_id` (self, SET NULL), `enabled`, `source` admin\|portal, `source_ref`, `class_minor`, `created_by_user_id` | unique (gateway, name), (gateway, class_minor), (gateway, source, source_ref) |
| `qos_groups` | `name`, `notes` | unique (gateway, name) |
| `qos_group_members` | `group_id` (CASCADE), `mac` | unique (gateway, mac): one group per MAC |
| `qos_assignments` | `policy_id` (CASCADE) null, `target_type` device\|group\|network, `mac`, `group_id` (CASCADE), `network`, `down/up_kbit`, `quota_bytes`, `quota_used_bytes`, `quota_on_exhausted`, `throttle_down/up_kbit`, `exhausted_at`, `quota_reset_at` (086), `expires_at`, `source`, `source_ref`, `created_by_user_id` | unique (gateway, mac), (gateway, group_id), (gateway, network), (source, source_ref) |
| `qos_schedules` | `name`, `enabled`, `target_type` policy\|assignment, `policy_id` / `assignment_id` (CASCADE), `action`, `use_policy_id` (CASCADE), `shared_*`, `each_*`, `rate_*` (NULL = keep), `days` (bit 0 = Monday), `start_minute`, `end_minute` | index gateway |
| `qos_gateway_states` (085) | `paused_at`, `paused_by_user_id` (the controller's pause), `devices_revision` (last `qos.devices.set` revision handed out, monotonic across restarts), `devices_acked_revision`, `devices_acked_at`, `config_fingerprint`, `config_revision`, `config_submitted_at` (what the plane last accepted) | unique (gateway) |

### 4.7 Settings (`system_settings` key `qos`, `app/services/qos_settings.ts`)

| Setting | Default | Range |
|---|---|---|
| `minWanKbit` | 1000 | 64–100000 |
| `minDeviceKbit` | 64 | 8–10000 |
| `dynamicIdleMinutes` | 30 | 5–1440 |
| `dynamicClassLimit` | 1024 | 16–8192 |
| `leafFlows` | 64 | 16–1024 |
| `leafLimitPackets` | 1000 | 100–10240 |
| `leafMemoryKb` | 1024 | 128–32768 |
| `restMemlimitKb` | 4096 | 1024–65536 |
| `applyDebounceSeconds` | 2 | 0–30 |
| `quotaPersistSeconds` | 60 | 10–3600 |
| `maxBucketDepth` | 4 | 1–4 |
| `expiredKeepMinutes` | 60 | 0–10080 (an expired assignment stays listed, inert, this long before `qos_expire.task.ts` deletes it) |

Read per use (presence pattern); stored values outside today's range are clamped.

## 5. REST (`/api/v1`, responses `{ data }`)

"user" = `auth + requirePasswordChange` (any role: decision 16); "admin" adds `requireAdmin`.
A gateway is named by `gatewayId` or `collectorId` (query for reads, body for creates); with one
gateway both may be left out.

| Method, path | Auth | Response `data` |
|---|---|---|
| GET `/qos/wan-queues` | user | `QosWanQueue[]` |
| POST `/qos/wan-queues` | admin | 201 `{queue, warnings}` (today: 409 `plane_unavailable`) |
| PATCH `/qos/wan-queues/:id` | admin | `{queue, warnings}`; a patch that changes nothing the router sees returns 200 without the plane |
| DELETE `/qos/wan-queues/:id` | admin | 204 |
| GET `/qos/policies` | user | `QosPolicy[]` |
| GET `/qos/groups` | user | `QosGroup[]` |
| GET `/qos/assignments?policyId=&mac=&source=` | user | `QosAssignment[]` |
| GET `/qos/schedules` | user | `QosSchedule[]` |
| GET `/qos` | user | `QosOverview` (section 7.4) |
| GET `/qos/devices?mac=` | user | `DeviceShaping[]` (entries first, then dynamic; by MAC) |
| GET `/devices/:mac/shaping?collectorId=` | user | `DeviceShaping \| null` (a MAC never seen is not a 404; 422 `invalid_mac`) |
| POST `/qos/policies`, PATCH, DELETE `/qos/policies/:id` | admin | 201 / 200 `QosPolicy`, 204 |
| POST `/qos/groups`, PATCH, DELETE `/qos/groups/:id` | admin | 201 / 200 `QosGroup`, 204 |
| POST `/qos/assignments`, PATCH, DELETE `/qos/assignments/:id` | admin | 201 / 200 `QosAssignment`, 204 |
| POST `/qos/assignments/:id/quota/reset` | admin | `QosAssignment` |
| POST `/qos/schedules`, PATCH, DELETE `/qos/schedules/:id` | admin | 201 / 200 `QosSchedule`, 204 |
| POST `/qos/pause`, `/qos/resume` | admin | `QosOverview` |
| GET, PATCH `/settings/qos` | admin | `{settings, defaults, limits}` |

`/devices` rows carry `shaping: DeviceShaping | null`, read per request (one query when there is no
gateway; otherwise a plan cached 15 s per gateway, dropped by every write).

```ts
type QosRate = { downloadKbit: number | null; uploadKbit: number | null }   // null = unlimited that way
type ApplyState = { revision: number; state: 'in_sync'|'queued'|'applying'|'rolled_back'|'failed'|'offline'|'drift'|'conflict'; at: string | null; error: string | null }
type QosWanQueue = { id; gatewayId; collectorId: number | null; device; enabled; downloadKbit; uploadKbit
  qdisc: string; script: string; diffserv: 'besteffort'|'diffserv3'|'diffserv4'|'diffserv8'|null
  fairness: 'per_host'|'triple_isolate'|'per_flow'|null; nat: boolean | null
  linkLayer: 'none'|'ethernet'|'atm'; overhead: number | null; mpu: number | null
  ingressEcn; egressEcn; squashDscp; squashIngress: boolean
  options: Record<string, string | string[]>; uciSection: string | null; perchId: string | null
  origin: 'controller'|'router'; flags: string[]; pausedByRouter: { at: string } | null
  sync: ApplyState; routerUpdatedAt: string | null; updatedAt: string
  live: { egress: QdiscStats | null; ingress: QdiscStats | null; reportedAt: string } | null }  // section 7.1
type QdiscStats = { kind: string; bandwidthKbit: number | null; rateKbit: number | null; bytes: number
  packets: number; drops: number; overlimits: number; backlogBytes: number; ecnMarks: number | null
  peakDelayUs: number | null }
type QosPolicy = { id; gatewayId; collectorId; name; notes; shared: QosRate | null; each: QosRate | null
  fairness: 'per_host'|'per_flow'; includeLan: boolean; parentPolicyId: number | null; classMinor: number
  enabled; source: 'admin'|'portal'; sourceRef: string | null
  counts: { devices: number; groups: number; networks: string[]; children: number }
  live: null   // filled only in `GET /qos` (section 7.4)
  createdAt; updatedAt }
type QosGroup = { id; gatewayId; collectorId; name; notes; members: { mac: string; name: string | null }[]; createdAt; updatedAt }
type QosAssignment = { id; gatewayId; collectorId; policyId: number | null
  target: { type: 'device'; mac } | { type: 'group'; groupId } | { type: 'network'; network }
  rate: QosRate | null
  quota: { limitBytes; usedBytes; onExhausted: 'block'|'throttle'; throttle: QosRate | null; exhaustedAt: string | null
           resetAt: string | null } | null
  expiresAt: string | null; source: 'admin'|'portal'; sourceRef: string | null; createdAt; updatedAt }
type QosSchedule = { id; gatewayId; collectorId; name; enabled
  target: { type: 'policy'; policyId } | { type: 'assignment'; assignmentId }
  action: 'limit'|'unlimited'|'block'|'policy'; usePolicyId: number | null
  shared / each / rate: { downloadKbit: number | null; uploadKbit: number | null } | null   // null = keep, 0 = unlimited
  days: ('mon'|…|'sun')[]; startMinute; endMinute; window: string; active: boolean; previewTimezone: string
  createdAt; updatedAt }
```

WAN queue requests: POST `{gatewayId?|collectorId?, device, downloadKbit, uploadKbit, enabled?, qdisc?,
diffserv?, fairness?, nat?, linkLayer?, overhead?, mpu?, ingressEcn?, egressEcn?, squashDscp?,
squashIngress?, advanced?: Record<string, string | null>}`; PATCH takes any subset (not the gateway).

WAN queue refusals (`{error, message, …}`), checked in this order on writes:

| Status | `error` |
|---|---|
| 422 | Vine `{errors}` |
| 404 | `collector_not_found`, `gateway_not_found`, `qos_not_found` (+`resource`, `id`) |
| 409 | `qos_not_gateway`; `qos_not_managed` (gateway mode is not `managed`); `qos_capability_missing` (+`missing`) |
| 422 | `qos_gateway_required`, `qos_gateway_mismatch`, `qos_unknown_device` (+`device`, `known`), `qos_rate_below_floor` (+`field`, `min`), `qos_field_needs_cake`, `qos_overhead_needs_linklayer`, `qos_option_has_field`, `qos_invalid_option`, `qos_field_not_applicable` |
| 409 | `qos_duplicate_device` (+`device`, `queueId`); `plane_unavailable` (+`intended`, `warnings`) or the plane's own refusal |

Warnings: `qos_rate_far_below_observed` (+`field`, `observedKbit`): a rate below half the 7-day p95
of `router_samples` on a single-WAN gateway; `sqm_inert_opts_replaced`.


### 5.2 Policy, group, assignment and schedule writes (`app/services/qos_writes.ts`)

Admin-only. They change the controller's desired state (the `qos_*` tables) and succeed while the
gateway is offline; the sender (section 6) delivers afterwards. Every write:

1. resolves the gateway (the reads' refusals) and needs managed mode (409 `qos_not_managed`);
2. checks its fields and targets (table below);
3. applies the change in a transaction, re-plans the gateway inside it (`planQos` +
   `checkPolicyTree`) and rolls back when the change **adds** a planner error: 422 with the issue's code
   as `error` and the new issues as `issues` (409 for `qos_mac_assigned` / `qos_target_assigned`).
   Errors that existed before do not block unrelated edits;
4. drops the plan cache and asks the sender to deliver (entries after 1 s, the package after
   `applyDebounceSeconds`).

PATCH bodies naming `gatewayId`, `collectorId`, a group's `members` or an assignment's / schedule's
`target` get 422 `qos_field_not_applicable` (+`field`): delete and create instead.

**Requests**

```ts
// POST /qos/policies (PATCH: any subset except the gateway)
{ gatewayId?, collectorId?, name: string /* 1-64 */, notes?: string | null /* ≤ 500 */,
  shared?: QosRate | null, each?: QosRate | null,   // null = no such part; a null / 0 rate = unlimited that way
  fairness?: 'per_host' | 'per_flow', includeLan?: boolean, parentPolicyId?: number | null, enabled?: boolean }
// POST /qos/groups                       PATCH /qos/groups/:id
{ gatewayId?, collectorId?, name, notes?, members?: string[] }   { name?, notes?, addMacs?: string[], removeMacs?: string[] }
// POST /qos/assignments (PATCH: policyId, rate, quota, expiresAt)
{ gatewayId?, collectorId?, target: { type: 'device', mac } | { type: 'group', groupId } | { type: 'network', network },
  policyId?: number | null, rate?: QosRate | null,
  quota?: { limitBytes: number, onExhausted: 'block' | 'throttle', throttle?: QosRate | null } | null,
  expiresAt?: string | null /* ISO 8601 with an offset */ }
// POST /qos/schedules (PATCH: any subset except the gateway and the target)
{ gatewayId?, collectorId?, name, enabled?, target: { type: 'policy', policyId } | { type: 'assignment', assignmentId },
  action: 'limit' | 'unlimited' | 'block' | 'policy', usePolicyId?: number | null,
  shared?: Override | null, each?: Override | null, rate?: Override | null,   // Override: { downloadKbit?, uploadKbit? }, null = keep, 0 = unlimited
  days: ('mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun')[] /* ≥ 1 */, startMinute: 0-1439, endMinute: 0-1439 }
// POST /qos/pause  {gatewayId?, collectorId?}      POST /qos/resume  {gatewayId?, collectorId?, overrideRouter?: boolean}
```

MACs are accepted with `:` or `-` in any case and stored lowercase with `:`. A group PATCH applies
`removeMacs` before `addMacs`. An assignment PATCH with a new `quota` keeps `usedBytes`; a raised limit
clears `exhaustedAt`; `quota: null` removes the quota and its usage. Changing a schedule's `action`
away from `limit` drops its rates.

**Refusals** (besides Vine's 422 `{errors}` and the gateway ones of section 5):

| Status | `error` | When |
|---|---|---|
| 404 | `qos_not_found` (+`resource`: policy\|group\|assignment\|schedule, `id`) | the row, a `parentPolicyId`, `policyId`, `usePolicyId`, `groupId` or `assignmentId` is not on this gateway |
| 409 | `qos_name_taken` (+`field`, `id`) | policy / group name in use on the gateway |
| 409 | `qos_class_exhausted` | 254 policies (every bucket minor taken) |
| 409 | `qos_policy_in_use` (+`assignmentIds`, `childPolicyIds`, `scheduleIds`) | DELETE of a policy with assignments, nested buckets, or schedules moving devices into it |
| 409 | `qos_mac_in_group` (+`mac`, `groupId`) | a MAC is in another group (one group per MAC) |
| 409 | `qos_mac_assigned` (+`assignmentId`, `source`) | the MAC already has a device assignment |
| 409 | `qos_target_assigned` (+`assignmentId`, `source`) | the group / network already has an assignment |
| 409 | `qos_conflict` | a concurrent write took the name / MAC / target first |
| 422 | `qos_policy_empty` | a policy without `shared` and `each`; an assignment without policy, rate and quota |
| 422 | `qos_rate_below_floor` (+`field` e.g. `each.downloadKbit`, `min`) | a non-zero rate below `minDeviceKbit` |
| 422 | `qos_each_exceeds_shared` | a numeric per-device cap above the shared bucket (an unlimited `each` direction is fine) |
| 422 | `qos_parent_cycle`, `qos_parent_not_bucket`, `qos_child_not_bucket`, `qos_child_exceeds_parent`, `qos_children_exceed_parent`, `qos_bucket_too_deep` (+`issues`) | nesting rules (section 3.3, `checkPolicyTree`) |
| 422 | `qos_target_invalid` (+`field`) | a target without its one field, or with another type's field |
| 422 | `qos_quota_needs_device` | a quota on a group or network |
| 422 | `qos_throttle_required`, `qos_field_not_applicable` (`quota.throttle`) | a throttling quota without its rate; a blocking quota with one |
| 422 | `qos_invalid_date`, `qos_expiry_past` (+`field`) | `expiresAt` unparsable / not in the future |
| 422 | `qos_no_quota` | quota reset on an assignment without a quota |
| 422 | `qos_schedule_unsupported` | `block` / `policy` on a policy target; `block` on a network default |
| 422 | `qos_schedule_policy_missing` | a `policy` schedule without `usePolicyId` |
| 422 | `qos_schedule_empty` | a `limit` schedule without any rate |
| 422 | `qos_field_not_applicable` (+`field`) | `rate` on a policy schedule, `shared`/`each` on an assignment schedule, rates on a non-`limit` schedule, `usePolicyId` on a non-`policy` schedule |
| 422 | any other planner error code (+`issues`) | e.g. `qos_unknown_network`, `qos_too_many_devices` |
| 409 | `qos_paused_on_router` (+`pausedAt`) | resume while the router reports its own pause, without `overrideRouter` |

## 6. Delivery (`app/services/qos_sync.ts`, `qos_plane.ts`, `app/tasks/qos_expire.task.ts`)

### 6.1 Device entries: `qos.devices.set`

The sender plans the gateway (`planQos(loadPlanInput(...))`) and calls the collector over the collector
hub:

```ts
// server → agent
qos.devices.set { revision: number, devices: DeviceEntry[] /* ≤ 4096, by MAC */ }
// → { revision, accepted: number, rejected: [{ mac, error }] }
```

- **When:** 1 s after a write (repeated writes coalesce); at once on every (re)connect of the gateway's
  collector (after `qos.probe`); when the router reports a new `epoch`; when its report's
  `devicesRevision` falls behind the accepted one, or a `qos_not_active` agent reports `state: 'active'`
  (each at most once a minute); and from the 30 s sweep while not in sync. Nothing is sent when the
  entries' fingerprint equals the one the agent accepted on the current session.
- **One at a time per gateway** (a promise chain); per-gateway state is bounded (256 gateways).
- **Revision:** `qos_gateway_states.devices_revision + 1`, persisted before the call, so it never goes
  backwards across restarts; the accepted one is `devices_acked_revision` / `devices_acked_at`.
- **Outcomes → `devices` state** (`DevicesDelivery` = `ApplyState` + `entries`, `rejected`):
  success `in_sync` (with the agent's `rejected` list); agent offline `offline` (sent on reconnect);
  `-32010` → `queued`, `error 'qos_not_active'`; `-32601` → `failed`, `'qos_unsupported'` (an agent
  without QoS; retried on reconnect); timeout (15 s) → `failed`, `'timeout'`; gateway not managed →
  `queued`, `'qos_not_managed'`.
- Only managed gateways get calls; the agent also refuses `qos.*` outside managed mode.

### 6.2 Quota counts across the wire

The controller persists the router's counts (section 7.3); an entry's `quota.usedBytes` is the
controller's last persisted count. The agent keeps the **larger** of its own count and `usedBytes`
for the same MAC, so a resend never rolls usage back. After an admin reset
(`POST /qos/assignments/:id/quota/reset`: `usedBytes` 0, `exhaustedAt` null, `quota_reset_at` now) the
entry carries `quota.resetAt`; an agent that sees a `resetAt` newer than the one it holds starts over
from `usedBytes`. Until the agent has accepted a set sent after the reset, the controller ignores the
router's older count for that assignment.

### 6.3 The `perch-qos` package: `QosPlaneWriter`

```ts
interface QosConfigChange { gatewayId: number; sections: PlanSection[] /* the whole package */
  fingerprint: string; overrideRouterPause: boolean; userId: number | null; requestedAt: string }
interface QosPlaneWriter { submit(change: QosConfigChange): Promise<{ revision: number }> }  // or throws QosPlaneError
class QosPlaneError { status: 409 | 422 | 503; code: string; extra: Record<string, unknown> }
setQosPlaneWriter(writer): QosPlaneWriter   // install at boot; returns the previous one
```

Submitted `applyDebounceSeconds` after the last write, when the plan's `fingerprints.config` differs from
`qos_gateway_states.config_fingerprint` (what the plane last accepted); POST `/qos/pause` / `/resume`
always resubmit. `StubQosPlaneWriter` (the default outside the web process) records the change (bounded, 50) and throws
`409 plane_unavailable`: the config state is `queued` with `error 'plane_unavailable'`, offered again on
the next change or at most every 5 minutes by the sweep.

`QosPlaneAccepted` = `{ revision, applyId?, state?: 'queued' | 'applying' | 'in_sync', error? }`;
`QosPlaneWriter.resume?(gatewayId, userId)` starts the apply of a package that waited.

**The `perch_qos` domain** (`app/services/perch_qos_domain.ts`, registered after `sqm`) owns the whole
package: types `globals`, `bucket`, `network`, `schedule` (anonymous sections other than `globals` are
not claimed: perch-collector ignores them). Options verbatim (round trip tested on planner output),
`normalize` = booleans and unpadded numbers, `globals.exempt` and `schedule.window` merge as sets.
**One-way** (`oneWay`): router edits are drift in managed mode, Authoritative Mode or not, and the
enforcement tick reverts them (config-plane.md 6.8); the first import of the file the perch-qos package
installs is not drift. **Decision 15** (`routerPause` on `globals.enabled`): the router's `enabled '0'` is
held as a pause (never drift, never reverted, every later package keeps `'0'`); the router switching it
back releases it; `POST /qos/resume {overrideRouter: true}` (`overrideRouterPause`) sends the put with
`reclaim: ['enabled']`, which writes `'1'`; when that apply rolls back or fails, the pause is the
router's again (the next package keeps `'0'`; config-plane.md 6.8). Validation mirrors what perch-collector refuses: one globals,
section names, whole-number rates, bucket `class` 0x02–0xff, known parent / bucket names, schedule
windows (`<days> HH:MM-HH:MM`) and actions (unknown schedules are warnings).

**`PlaneQosWriter`**:

1. refuses early: `409 qos_not_managed`; `409 config_not_allowed` (the router's allowlist lacks
   `perch-qos`; the perch-qos package brings it by itself); `409 qos_package_missing` (no perch-qos on
   the router and no file read);
2. `revision` = max(`qos_gateway_states.config_revision`, the router's `globals.revision`) + 1, written
   as `globals.revision` (perch-collector reports it back as `qos.configRevision`); options that are
   `''` are left out (UCI keeps no empty values; perch-collector reads absent as `''`);
3. one put per planned section (matched by type and name; `globals` by type), a delete for every synced
   section the plan no longer has, into `editSections(gatewayId, actor, 'perch_qos', edits)`; the actor
   is the admin who made the change, or `{system: 'qos'}` for Perch's own (a portal grant, the expiry
   sweep: `userId` null), shown as "Perch (system)";
4. an apply of every synced section of the package, **confirmed by the agent alone** (Perch writes the
   package by itself too, and it never touches the management path);
5. another apply open (`apply_in_flight`, or `pending_apply` from `editSections`): the state is `queued`
   with `error 'apply_in_flight'`, and the package is (re)submitted when that apply ends (the
   `onApplySaved` listener) or by the next sweep; a router refusal drops the draft and becomes `422` /
   `409` with the router's reason.

**State** (`GET /qos` `config`): the apply carrying the package (`qos_gateway_states.config_apply_key`,
migration `111`, so it survives a restart) decides `queued` → `applying` (sent, pending confirm, or
confirmed while the router's shaper has not reported the revision yet) → `in_sync` (the router reports
`configRevision >= revision`, or the apply confirmed on a router that reports no shaper state), or
`rolled_back` / `failed` with `error` = the apply's reason. The listener also moves the sender's own
state as the apply goes.

`GET /qos` gains `planeAccess: { sqm, perchQos }`, each `{ config, package, allowed: boolean | null,
installed: boolean | null, hint: string | null }` (README 7.7: installed sibling packages join the
router's allowlist by themselves; `hint` says what the router's owner does when `allowed` is false);
a managed gateway that does not allow one also lists `config_not_allowed` in `errors`.

### 6.4 Pause and expiry

- **Pause:** POST `/qos/pause` sets `qos_gateway_states.paused_at`; the plan renders
  `globals.enabled '0'` (the agent removes every Perch tc object; entries stay cached). POST
  `/qos/resume` clears it; while the router reports its own pause (`pausedBy: 'router'`, or `state:
  'paused'` without `pausedBy`) it needs `overrideRouter: true` (409 `qos_paused_on_router`).
- **`qos_expire.task.ts`** (every 30 s): deletes assignments expired more than `expiredKeepMinutes` ago
  (their schedules cascade), then sweeps every managed gateway (expired entries leave the set; failed or
  inactive deliveries are retried; an online agent never probed is probed). Expired assignments drop out
  of the plan the moment they expire; the agent also drops expired entries on its own, even offline.

### 6.5 `qos.probe`

Called on every connect of a managed gateway's collector (and by the sweep while it has no answer);
the answer (`{sqm, kernel, conflicts, flowOffload, lanDevices}`, plan 3 section 6) is kept per session and
shown as `QosOverview.capabilities`. `-32601` marks the agent `agentSupportsQos: false`.

## 7. Live state (`app/services/qos_live.ts`, `qos_views.ts`)

### 7.1 The `qos` push section

A top-level `qos` object in `collector.push` (or in a polled `/api/v1/summary`). Absent = not reported,
never "no shaping". `recordQosReport()` runs in `ingestCollectorSnapshot` after the gateway sample,
non-fatal (only accepted pushes; a push dropped as too early is not recorded).

```ts
{ epoch: string | number, state: 'active' | 'paused' | 'error', pausedBy: 'config' | 'local' | 'router' | 'controller' | null,
  configRevision: number | string /* numeric */ | null, devicesRevision: number | string | null,
  wan: [{ device, section?, egress: QdiscCounters | null, ingress: QdiscCounters | null }],        // ≤ 16
  classes: [{ id: '1:2a0', key: 'd:<mac>' | 'b:<policyId>' | 'r:<policyId>' | 'n:<network>', dir: 'down' | 'up',
              rateKbit, ceilKbit, bytes, packets, drops, overlimits, backlogBytes }],               // ≤ 4096
  devices: [{ mac, classId: string | null, network: string | null, dynamic: boolean, state?: string }], // ≤ 8192
  quotas: [{ mac, usedBytes, limitBytes, exhausted }],
  schedules: [{ name: 's7', active, since: string | null, until: string | null }],                   // ≤ 256
  errors: [{ code, detail?, mac?, device? }] }                                                       // ≤ 64
QdiscCounters = { kind, bandwidthKbit?, bytes, packets, drops, overlimits, backlogBytes, ecnMarks?, peakDelayUs? }
```

Parsing is tolerant: a malformed item is dropped on its own, unknown fields are ignored, counters must
be non-negative numbers, MACs are normalised. Counters are cumulative. `devices[].state` is the agent's
word (`shaped`, `unshaped`, `blocked`, `throttled`), passed through as `DeviceShaping.routerState`.

`pausedBy` (`routerPaused()`): perch-collector sends `config` (`globals.enabled '0'`) or `local`
(`perch-collector qos stop`). `local` and `router` are a router-side pause; `config` is one unless the
controller's own pause (POST `/qos/pause`) put it there; `paused` without a reason counts as the
router's. A router-side pause shows as `paused.by 'router'` and makes `/qos/resume` need
`overrideRouter`.

### 7.2 Rates and bounds

Rates are byte deltas between two consecutive reports of the same `epoch`, 0.5 s to 120 s apart
(`kbit/s = Δbytes × 8 / Δms`), per class id **and** direction (the ids repeat on the two ifbs); a new
epoch, a counter going backwards or an odd gap gives `null`. `dropPct` = Δdrops / (Δpackets + Δdrops).
The latest report per collector is kept in memory, at most 64 collectors (LRU); a restart forgets it
until the next push.

### 7.3 Quotas and events

- **Persistence:** the router's `quotas` are written to `qos_assignments.quota_used_bytes` every
  `quotaPersistSeconds`, and at once when a MAC newly reports `exhausted` (`exhausted_at` set; cleared
  when the router reports it not exhausted under a raised limit). Only device assignments with a quota.
- **Events:** the agent's `qos.event` notification `{type, at, mac?, detail?}` (types
  `quota_exhausted`, `pool_exhausted`, `apply_failed`, `local_pause`, `local_resume`,
  `schedule_clock_unsynced`, `sqm_paused`, `sqm_resumed`, `cap_hit`; others are kept too) goes into a ring of the last 50 per collector
  (`QosOverview.events`, newest first) and the log. `quota_exhausted` marks the assignment at once (with
  `detail.usedBytes` when given).
- **`onQuotaExhausted`** listeners (the portal) hear each exhaustion once, from whichever comes first.

### 7.4 Read shapes

```ts
type DeviceShaping = { gatewayId: number; collectorId: number | null; mac: string
  via: 'device' | 'group' | 'network'; assignmentId: number | null; policy: { id; name } | null
  cap: QosRate                                       // the per-device cap (null = unlimited that way)
  bucket: { policyId; name; rate: QosRate } | null
  quota: { limitBytes; usedBytes; onExhausted; throttle: QosRate | null; exhaustedAt; resetAt } | null
  state: 'enforced' | 'pending' | 'not_seen' | 'paused' | 'exhausted' | 'failed'
  classId: string | null                             // as the router reported it (own leaf or rest leaf)
  dynamic: boolean; network: string | null; routerState: string | null
  schedules: string[]; includeLan: boolean
  usage: { downloadKbit; uploadKbit; dropPct: { download; upload }; source: 'class' | 'capture'; at } | null }
```

- Rows: every entry of the plan, plus MACs the router reported under a network default
  (`via: 'network'`, `dynamic` as reported, cap from the network's `each_*`).
- `state`, in order: `paused` (controller pause, or the router reports paused); `failed` (the agent
  rejected the MAC); `exhausted` (its quota ran out); `pending` (the entries are not in sync, the
  router's `devicesRevision` is behind, or there is no report); else `enforced` when the router lists
  the MAC, `not_seen` when it does not.
- `usage` comes from the MAC's own leaf (minor ≥ 0x200) only: a rest leaf is shared, so MACs there get
  `null` (the capture fallback of plan 3 section 6 is not built).

```ts
type QosOverview = { gatewayId; collectorId; managed: boolean; authoritative: boolean; online: boolean
  agentSupportsQos: boolean | null                   // null until probed
  capabilities: { sqm: { installed; version; luci }; shaper: { available: boolean; missing: string[] }
                  conflicts: string[]; flowOffload: { software; hardware }
                  timezone: string | null; clockSynced: boolean | null; configured: boolean | null  // probe's tz / clockSynced / configured
                  probedAt: string } | null
  paused: { by: 'controller' | 'router'; at: string | null } | null
  config: ApplyState; devices: ApplyState & { entries: number; rejected: { mac; error }[] }
  wan: QosWanQueue[]                                 // with `live`
  policies: (QosPolicy & { live: { downloadKbit; uploadKbit; activeMembers } | null })[]
  counts: { shapedDevices; dynamicDevices; quotasExhausted }
  errors: { code; message; mac?; device? }[]         // router errors, delivery errors, rejected MACs
  issues: PlanIssue[]                                // the planner's (section 3)
  schedules: { activePreview: number[]; nextChangeAt: string | null; reported: ScheduleReport[] }
  events: QosEvent[]                                 // newest first, ≤ 50
  report: { epoch; state; configRevision; devicesRevision; reportedAt } | null }
```

A policy's `live` sums the measured rates of its bucket class (`b:<id>`); `activeMembers` counts its
`enforced` devices. `QosWanQueue.live` (also on `GET /qos/wan-queues`) comes from the report's `wan`
entry with the same device.

## 8. Portal-facing API (`app/services/qos_shaping.ts`, in-process; plan 3 section 7)

```ts
shapeDevice(i: { collectorId?: number; gatewayId?: number; mac: string; policyId?: number; rate?: QosRate
  quota?: { limitBytes: number; onExhausted: 'block' | 'throttle'; throttle?: QosRate }; expiresAt?: DateTime
  source: 'portal'; sourceRef: string /* 1-64 of A-Za-z0-9_.:- */ }): Promise<QosAssignment>
releaseDevice(sourceRef: string): Promise<void>                       // no-op when there is none
portalAssignment(sourceRef: string): Promise<QosAssignment | null>
getDeviceShaping(collectorId: number, mac: string): Promise<DeviceShaping | null>
onQuotaExhausted(cb: (e: { collectorId; mac; sourceRef: string | null; at: string }) => void): () => void
ensureTierPolicy(i: { collectorId?; gatewayId?; key: string; name: string; shared?: QosRate; each?: QosRate }): Promise<QosPolicy>
```

- A tier is a `source: 'portal'` policy with `sourceRef 'tier:<key>'`; calling again updates it.
- A grant is a device assignment with `source: 'portal'` and the portal's `sourceRef`
  (`voucher:<id>`). `shapeDevice` is idempotent per `sourceRef`: again = update to exactly the given
  fields; a new `mac` moves the grant there with its quota usage (owner decision 23).
- Refusals are `QosError` (`status`, `body` as the REST ones). The portal never overrides an admin
  assignment, nor another grant's: 409 `qos_mac_assigned` (+`assignmentId`, `source`, `sourceRef`).
- Writes go through the same validation and delivery as the REST writes (managed mode required).

## 8a. Dashboard (branch `gw/fe-qos`)

- `/shaping` (every signed-in user reads; edits need an admin and a managed gateway, else the page
  is read-only and says why): Overview (status chips, loud banners for a router-side pause and for a
  WAN queue switched off on the router, the `plane_unavailable` explanation, capability problems,
  WAN queues with live rate / delay / drops and line-type presets, a live rate chart kept in the
  browser), Policies & groups (the bucket tree with children's sums against the parent's ceiling and
  the client-side mirror of `checkPolicyTree` / `qos_each_exceeds_shared`), Assignments (device /
  group / network, own rate, quota bars with reset, expiry), Schedules (day chips, time window, a
  week strip, "active now" in `previewTimezone` and the router's own report), Devices
  (`/qos/devices` with usage against the cap), Events. `?gateway=N` names the gateway; `?tab=` the
  section.
- Settings → Traffic shaping (`/settings/traffic-shaping`, section 4.7; rates in Mbit/s).
- Device page: a Speed limit card (`/devices/:mac/shaping`), hidden when nothing shapes the device.
  Devices list: a badge from the rows' `shaping`.
- 409 `qos_not_managed` / `plane_unavailable` and the other refusals of section 5.2 are shown in
  plain words (`dashboard/src/lib/qos.ts`), with the planner's `issues` listed under a refused save.
- WAN queue writes show their apply in words (`apply` / `applyError`: applying, rolled back, refused, or
  kept as a draft), their warnings, and a link to the gateway's Changes tab; Remove answers with the queue
  still listed as "Removing…" (`pending_delete`) until the router confirms. Cards say the sync state in a
  sentence (queued, applying, rolled back, failed). `planeAccess` not allowed: a callout with the hint,
  and the writes it blocks are disabled (sqm: every queue write; perch-qos: pause and resume). A plain
  Resume refused with `qos_paused_on_router` offers "Resume anyway (override router)" (`overrideRouter`).
- Config plane pages: every actor renders through `ActorName` (a user's email, or "Perch (system)" with
  a badge naming `via`); `router_paused` / `router_resumed` events read "Paused / Resumed on the router".

## 9. Not built yet

- The package is written once the gateway is managed (the sender's sweep); a gateway without the
  perch-qos package shows `config.error 'qos_package_missing'` until it is installed.
- `usage.source: 'capture'` for MACs in a rest leaf; `collectors.last_status.qos` (plan 3 section 4:
  the live state is in memory only); the network list for `qos_unknown_network` (M5).
