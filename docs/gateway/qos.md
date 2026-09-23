# Traffic shaping (QoS) on a managed gateway

Status: data model, settings, WAN SQM mapping, the WAN queue API, read APIs and the planner are built
(2026-09-23, branch `gw/qos`). Router writes wait for the config plane's apply path
([config-plane.md](config-plane.md)); until then they answer `409 plane_unavailable`. The agent side
(`perch-collector qos`, the `perch-qos` package) and the live ingest come later.

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

Decision 15 is expressed through ownership: while the router's section says `enabled '0'`, Perch
does not own `enabled`, so the router's value always wins (never drift, never a conflict, never
reverted) and every other option stays Perch's.

Until gw/data's `ConfigDomain` interface is merged, the file carries structural mirrors of
`SyncedSection`, `SectionEdit` and `ValidationCtx` (TODO in the file: import the real ones and
register the domain in `gateway_config/domains/index.ts`).

### 2.3 Router import (`recordRouterSqm`, `app/services/qos_wan_queues.ts`)

The plane's observe path calls it with each read of the router's `sqm` config:

- a new section becomes a row with `origin: 'router'`, options as they are (the live gateway's
  untagged `eth1` stays untagged: `perch_id` comes from the ledger only);
- changed options are taken over (`router_updated_at`);
- enabled → disabled on the router sets `router_paused_at` (decision 15); back on clears it; a queue
  that was never on is not a pause;
- vanished sections are removed; controller rows not yet on the router (null `uci_section`) stay.

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

`StubSqmPlaneWriter` is installed until the plane's apply path exists: it records the change
(bounded, 50) and throws `409 plane_unavailable`. The endpoint returns that with
`intended: {action, queueId, uciSection, options, changed}` and `warnings`, and stores nothing. Once a
writer accepts, the row takes the desired options (`origin` unchanged, `controller` for new ones) and
the sync state follows the plane's section (`queued` → `applying` → `in_sync`, or `offline`).

Wiring (wave 2): `submit` renders with `sqmDomain.render()` and calls
`gatewayConfig.editSections(gatewayId, userId, edits)`.

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
Both = caps inside a ceiling (Piso Wi-Fi: guest 50 Mbit/s in total, 5 Mbit/s per voucher). Rates are
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
  quota: { limitBytes; usedBytes; onExhausted: 'block' | 'throttle'; throttleDownKbit; throttleUpKbit } | null
  expiresAt: string | null
  includeLan?: true          // decision 13
  schedules?: string[] }     // decision 16, precedence order
```

`planQos(input)` returns `{ sections, devices, issues, activeSchedules, nextChangeAt, fingerprints }`.
It never throws; problems are `issues` (`error` / `warning`, with the policy, assignment, schedule,
MAC or network they concern). `fingerprints.config` / `.devices` (sha256) let the sender send only on
change. `loadPlanInput(gatewayId, at)` (`qos_reads.ts`) builds the input from the tables.

## 4. Data model

All tables hang off `gateways` (ON DELETE CASCADE). Only `gateways` references `collectors`
(config-plane rule), so `collectors:merge` moves QoS data with its gateway and needs no entry.
Migrations `1779000000080`–`084`. Unions are strings checked in the app layer; MACs are lowercase
colon form, joined with other MAC columns in JS.

| Table | Columns (besides id, gateway_id, timestamps) | Keys |
|---|---|---|
| `qos_wan_queues` | `uci_section` null, `perch_id` null, `device`, `enabled`, `options` (JSON, full UCI map), `origin` controller\|router, `router_updated_at`, `router_paused_at` | unique (gateway, uci_section), (gateway, perch_id) |
| `qos_policies` | `name`, `notes`, `shared_down/up_kbit`, `each_down/up_kbit`, `fairness` per_host\|per_flow, `include_lan`, `parent_policy_id` (self, SET NULL), `enabled`, `source` admin\|portal, `source_ref`, `class_minor`, `created_by_user_id` | unique (gateway, name), (gateway, class_minor), (gateway, source, source_ref) |
| `qos_groups` | `name`, `notes` | unique (gateway, name) |
| `qos_group_members` | `group_id` (CASCADE), `mac` | unique (gateway, mac): one group per MAC |
| `qos_assignments` | `policy_id` (CASCADE) null, `target_type` device\|group\|network, `mac`, `group_id` (CASCADE), `network`, `down/up_kbit`, `quota_bytes`, `quota_used_bytes`, `quota_on_exhausted`, `throttle_down/up_kbit`, `exhausted_at`, `expires_at`, `source`, `source_ref`, `created_by_user_id` | unique (gateway, mac), (gateway, group_id), (gateway, network), (source, source_ref) |
| `qos_schedules` | `name`, `enabled`, `target_type` policy\|assignment, `policy_id` / `assignment_id` (CASCADE), `action`, `use_policy_id` (CASCADE), `shared_*`, `each_*`, `rate_*` (NULL = keep), `days` (bit 0 = Monday), `start_minute`, `end_minute` | index gateway |

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
| GET, PATCH `/settings/qos` | admin | `{settings, defaults, limits}` |

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
  sync: ApplyState; live: null; routerUpdatedAt: string | null; updatedAt: string }
type QosPolicy = { id; gatewayId; collectorId; name; notes; shared: QosRate | null; each: QosRate | null
  fairness: 'per_host'|'per_flow'; includeLan: boolean; parentPolicyId: number | null; classMinor: number
  enabled; source: 'admin'|'portal'; sourceRef: string | null
  counts: { devices: number; groups: number; networks: string[]; children: number }; live: null; createdAt; updatedAt }
type QosGroup = { id; gatewayId; collectorId; name; notes; members: { mac: string; name: string | null }[]; createdAt; updatedAt }
type QosAssignment = { id; gatewayId; collectorId; policyId: number | null
  target: { type: 'device'; mac } | { type: 'group'; groupId } | { type: 'network'; network }
  rate: QosRate | null
  quota: { limitBytes; usedBytes; onExhausted: 'block'|'throttle'; throttle: QosRate | null; exhaustedAt: string | null } | null
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

Refusals (`{error, message, …}`), checked in this order on writes:

| Status | `error` |
|---|---|
| 422 | Vine `{errors}` |
| 404 | `collector_not_found`, `gateway_not_found`, `qos_not_found` (+`resource`, `id`) |
| 409 | `qos_not_gateway`; `qos_not_managed` (gateway mode is not `managed`); `qos_capability_missing` (+`missing`) |
| 422 | `qos_gateway_required`, `qos_gateway_mismatch`, `qos_unknown_device` (+`device`, `known`), `qos_rate_below_floor` (+`field`, `min`), `qos_field_needs_cake`, `qos_overhead_needs_linklayer`, `qos_option_has_field`, `qos_invalid_option`, `qos_field_not_applicable` |
| 409 | `qos_duplicate_device` (+`device`, `queueId`); `plane_unavailable` (+`intended`, `warnings`) or the plane's own refusal |

Warnings: `qos_rate_far_below_observed` (+`field`, `observedKbit`): a rate below half the 7-day p95
of `router_samples` on a single-WAN gateway; `sqm_inert_opts_replaced`.

## 6. Not built yet

- Policy / group / assignment / schedule writes (WP-C REST), the device-set sender, `qos_expire.task.ts`,
  `qos_shaping.ts` (the portal API): the planner and tables are ready for them. Write validators
  should refuse what the planner reports as errors (depth, children sums, `block` on a network, …).
- The live ingest (`qos` push section, `qos_live.ts`, `/qos`, `/qos/devices`, `/devices/:mac/shaping`).
- The agent: `perch-collector` `internal/qos`, the `perch-qos` package, the schedule evaluator on the
  router clock.
- `sqmDomain` registration and the real `SqmPlaneWriter` (after gw/data merges).
