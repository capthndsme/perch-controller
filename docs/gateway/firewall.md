# Managed gateway: the firewall (controller side)

Status: built 2026-09-23 (milestone M7, plan 2 section 4.3 and phase 3). The dashboard builds its
Firewall page and the device page's WAN block from this document. Router side: perch-collector's
`ARCHITECTURE.md` "Writes" (the `order` op, `position`) and `CONFIG.md` "Conntrack flush".

The firewall is one config-plane domain (`firewall`) over `/etc/config/firewall` (fw4, nftables).
It rides the plane like every domain (docs/gateway/config-plane.md): two-way sync with a per-section
base, conflicts, Authoritative Mode, apply with confirm and rollback, the management-path job. This
document adds what is specific: what is claimed, the order of rules and redirects, the pre-flight,
the per-device WAN block and the REST API.

Placeholders only: 192.168.x.x, 203.0.113.x, MACs `02:00:00:…`.

| File | Role |
|---|---|
| `app/services/gateway_config/domains/firewall.ts` | the domain (pure): claims, normalisation, identity, validation, shadowing, the path guard, zone helpers |
| `app/services/gateway_config/section_order.ts` | order model (pure): reconcile, resolve, planning helpers, positions after a job |
| `app/services/gateway_config/order_store.ts` | `gateway_section_orders` (DB) |
| `app/services/gateway_config/apply_plan.ts` | `planOrders`: positions for created members, `order` ops, adoption of what they move |
| `app/services/gateway_config/firewall_service.ts` | REST layer: overview, port forwards, rules, order, WAN block |
| `app/services/gateway_config/post_actions.ts` | work once a job is live: the conntrack flush |
| `app/controllers/gateway_firewall_controller.ts`, `app/validators/gateway_firewall.ts` | HTTP |

## 1. What the domain claims

| UCI | Claimed | Two-way | Written by Perch |
|---|---|---|---|
| `zone` with a `name` | yes | yes | membership edits of the networks plan (section 7); never created/renamed here |
| `forwarding` with `src` and `dest` | yes | yes | with the networks plan |
| `rule` | yes | yes, **ordered** | Perch rules (REST), the WAN block rules, edits of imported rules |
| `redirect` without `target` or `target 'DNAT'` | yes | yes, **ordered** | port forwards |
| `ipset` named `perch_block_wan` | yes | yes | the WAN block set |
| `defaults`, `include`, `nat`, SNAT `redirect`, other `ipset`s | **no** | mirrored | never |

Unclaimed sections are `unmodeled`: mirrored, logged, never written, never drift, never reverted.
That covers package includes (miniupnpd's `config include 'miniupnpd'`), an operator's nftables
include, and `defaults` (incl. `flow_offloading_hw`, shown as a warning). Perch's own nftables (the
portal's `inet perch_portal` table and its fw4 drop-in, README decision 27) live outside UCI: the
plane never reads them, so they can never be drift.

Every section of a claimed type syncs (README 7.5), so the router's own rules and port forwards are
**imported** as synced sections (owner `perch` in the API), editable from Perch; they are adopted
into the ledger (anonymous ones renamed `perch_<id>`) only when a job writes or moves them. An
operator can exclude any of them (`PATCH /gateways/:id/sections/:perchId {scope:'excluded'}`).

**Objects are the sections, verbatim.** `render(parse(x))` writes every option back as it was, so
`checkRoundTrip` is exact whatever spelling LuCI or `uci` used. The realistic fixture
(`tests/unit/services/fixtures/gateway_firewall.ts`: stock rules, guest and IoT zones, 39 port
forwards in every spelling, a DNS intercept, SNAT, `nat`, a package include, an operator ipset)
passes it, whole and per section.

**Equality** (never applied to stored content) knows fw4's aliases:

| Option | Normalised |
|---|---|
| `proto` | words, lowercase, `tcpudp` = `tcp udp`, `any`/`*` = `all`, as a sorted set (`'tcp udp'` = `list proto 'udp' 'tcp'`) |
| `enabled`, `masq`, `mtu_fix`, `reflection`, `log`, … | `1/yes/on/true` = `1`, `0/no/off/false` = `0` |
| `target`, `input`, `output`, `forward` | uppercase |
| `family` | `4`/`ipv4` = `ipv4`, `6`/`ipv6` = `ipv6`, anything else `any` |
| `src_port`, `dest_port`, `src_dport` | words, `a:b` = `a-b` |
| `src_mac`, `entry` | lowercase set |
| `network`, `device`, `src_ip`, `dest_ip`, `src_dip`, `icmp_type`, `match` | word set (`'lan guest'` = `list network 'guest' 'lan'`) |

List semantics: `zone.network`, `ipset.entry`, `rule.src_mac`, `rule.icmp_type` merge item by item
(`set`): LuCI adding a MAC to the block set while Perch adds another keeps both.

**Identity keys** (re-linking a section the router renamed; two router sections sharing a key are
`ambiguous` and stay unmodeled until the operator fixes them): zone `zone:<name>`; forwarding
`fwd:<src>><dest>:<family>`; the block set `ipset:<name>`; rule and redirect `<type>:<name>`
(case-insensitive) when named, else `<type>#<content fingerprint>` (plan 2 section 4.3 (a)).
Two redirects with the same name are therefore ambiguous: shown with `sync.issue: 'ambiguous'`,
observed only until one is renamed.

## 2. Pre-flight (validation)

`validate` runs on every draft edit and before an apply (errors block only the sections they are
on; config-plane.md 6.1). Issues carry the section's `perchId`.

| Code | Severity | When |
|---|---|---|
| `firewall_zone_unknown` | error | a rule/redirect/forwarding names a zone that does not exist (`*` allowed for rules) |
| `firewall_port_invalid` | error | a port or range outside 1–65535, backwards, or not a number |
| `firewall_ip_invalid` | error | an address/network that does not parse (`!` negation allowed) |
| `invalid_mac` | error | `src_mac`, a block set `entry` |
| `firewall_target_invalid` | error | a rule target fw4 does not know |
| `firewall_ipset_unknown` | error | a rule's `ipset` names no set |
| `firewall_policy_invalid`, `firewall_zone_duplicate` | error | zone policies, duplicate zone names |
| `firewall_controller_path`, `firewall_admin_path` | error | the path guard (section 2.1) |
| `firewall_redirect_shadowed` | warning | an enabled DNAT redirect overlaps an earlier one (same zone, protocol, external ports, source): it never matches those packets |
| `managed_rule_shadowed` | warning | an earlier enabled rule with the opposite verdict covers this one (section 2.2) |
| `firewall_all_ports`, `firewall_port_ignored`, `firewall_dest_outside_networks`, `firewall_forwarding_duplicate` | warning | forwards every port; ports on a non-TCP/UDP rule; a DNAT target outside every LAN; duplicate forwarding |

### 2.1 The management path (README 3.8, plan 2 section 4.3 "Lockout")

The management zone is the zone listing the network the agent reaches the controller through
(`gateways.management_path.network`, from `ip route get <controller>` on the router); the
controller's address is `management_path.controllerAddress`. Only enabled `REJECT`/`DROP` rules are
checked (`checkRulePath`):

| Rule | Refused with |
|---|---|
| output (no `src`) towards the management zone, `*` or no zone, covering the controller's address | `firewall_controller_path` (T-F3's `zone … output REJECT`) |
| input (no `dest`) from the management zone or `*`, not narrowed to a MAC, set or port | `firewall_controller_path` |
| input from the admin's zone, the management zone or `*` covering TCP 22, 80 or 443 | `firewall_admin_path` (ssh, LuCI) |
| forward from the admin's zone (or `*`) to the management zone (or `*`) covering the controller, not narrowed to a MAC or set | `firewall_admin_path` |

The admin's zone is the zone of the network holding the request's client address (REST only).
Output rules, and input rules from `*` or from the zone named like the management network, are
planned in the protected job (longer confirm window, `touchesManagement`). The router-side rollback timer and the
fresh-session confirm remain the safety net for anything the guard cannot see.

### 2.2 Shadowing

- Redirects: two enabled DNAT redirects **overlap** when their source zones meet, protocols
  intersect (fw4's redirect default is `tcp udp`), families meet, external port ranges intersect and
  source addresses meet. The later one is `shadowedBy` the earlier (first match wins in DNAT).
- Rules: rule L is `shadowedBy` the first earlier enabled rule E with the opposite verdict
  (ACCEPT vs REJECT/DROP) whose zones meet L's and whose match **covers** L's (protocols, ports,
  addresses, MACs, family, set). A narrow earlier exception (`udp 123` ACCEPT before an IoT REJECT)
  does not shadow; an earlier `lan → wan` ACCEPT of everything shadows a later block rule
  `* → wan` (T-F4).

## 3. Order of rules and redirects

fw4 evaluates rules and redirects top to bottom, so their order is synced state. Per gateway and
ordered (config, type) the controller keeps a row in `gateway_section_orders`:

- **B** `base_order`: the perch ids in the order both sides last agreed on;
- **C** `desired_order`: the controller's order;
- **R**: the router's order, from the rows' `position` (the section's index in the file).

Only **synced** sections take part. Unmodeled and excluded ones keep their slots: the agent's
`order` op puts the listed sections into the slots they occupy together, in the listed order;
nothing else moves (perch-collector `simulate.go`). "Moved" compares the relative order of the
members a side shares with B, so a section that appears or disappears is never a reorder.

| Situation | Two-way | Authoritative |
|---|---|---|
| R = C | `in_sync`, B := R | same |
| only the controller reordered (C ≠ R, R = B) | `ahead`: the next apply of those sections carries an `order` op | same |
| only the router reordered | imported: C := R, `order_imported` | `drift` (`driftSince`), reverted after `authoritativeRevertDelaySeconds` by a `revert` job with the `order` op |
| both reordered differently | `conflict` {router, detectedAt} until the admin resolves | drift |

- **Membership.** A new router rule enters C right after its predecessor in R; a section the
  controller creates goes where the REST call put it (end by default, `placement: 'top'`, the block
  rule first toward WAN) and reaches the router with `position {after|before: <neighbour>}` on its
  `put`, so no reorder is needed for it.
- **Planning** (`planOrders`): an order is planned when the request covers one of its members or
  has no section filter (a revert of order drift is forced). When the router's order after the job
  would still differ from C, the job gets one `order` op listing the members present after it, and
  members not yet in the ledger are **adopted in the same job** (anonymous ones renamed
  `perch_<id>`): the agent orders owned sections only. The job's `changes` carry an `action: 'order'`
  entry `{options: [{name: '.order', before, after}]}` (section names). An order in `conflict` only
  places created members.
- **Confirm.** A confirmed job updates the rows' positions by simulating its ops (`positionsAfterOps`)
  and reconciles the orders, so the state is right before the next read. Reads during an apply that
  touches the config leave its orders alone (the router's order is in motion).
- **"In sync"** (Authoritative precondition, sync-status): an order not `in_sync` is a blocker
  `{kind: 'order', config, type, status, router: string[], desired: string[]}`, and counts in the
  gateway's `syncState` like a section.
- **Events**: `order_imported`, `order_conflict`, `order_drift`, `order_drift_cleared`,
  `order_changed` (admin reorder), `order_resolved`.

## 4. Port forwards

A port forward is a `redirect` with `target 'DNAT'`. Created ones are written as
`{name, src (default wan), src_dport, proto, dest, dest_ip, dest_port?, target: 'DNAT', family:
'ipv4'}`; `reflection '0'` / `enabled '0'` only when false. Edits of an imported forward keep every
option they do not name.

- **Reserved destinations** (plan 2 section 4.3): with `deviceMac`, the device's host entry's
  address; a device without one gets a reservation from its current lease **in the same job**
  (`dhcp` before `firewall`, one confirm, one rollback). With `destIp`, some DHCP host must hold
  the address (`firewall_dest_not_reserved`), unless `allowUnreserved: true` (a static address).
- `destZone` defaults to the zone of the LAN network holding the address, else `lan`.
- An enabled forward that overlaps another enabled DNAT redirect is refused, 409
  `firewall_port_taken {id}` (the one holding the port). Overlaps already on the router are
  warnings (section 2.2).
- A forward deleted on the router (LuCI) is gone in Perch (two-way; `delete_vs_edit` conflict when
  Perch holds an unapplied edit); under Authoritative Mode it is re-created (T-F2).

## 5. The per-device WAN block

UCI (plan 2 section 4.3; the section names deviate: a config cannot hold two sections of one name):

```
config ipset 'perch_block_wan'           # nft set inet fw4 perch_block_wan
	option name 'perch_block_wan'
	option match 'src_mac'
	list entry '02:00:00:00:00:60'
config rule 'perch_block_wan_wan'        # one per WAN zone (masq '1', else the zone "wan")
	option name 'Perch: block internet (wan)'
	option src '*'
	option dest 'wan'
	option ipset 'perch_block_wan'
	option proto 'all'
	option target 'REJECT'
```

- Blocking adds the MAC to `entry` (the only change once the set and rules exist); the first block
  creates the set and one rule per WAN zone, placed **first among the rules toward WAN zones** in
  C. Unblocking removes the MAC; the set (possibly empty) and rules stay.
- **Conntrack flush** (README decision 9): fw4 accepts established flows before zone chains, so the
  block's apply carries a post action. Once the job is live (the agent committed, reloaded fw4,
  dialled a fresh session and pushed), the controller calls `net.conntrack_flush {ips}` with the
  device's addresses (lease, host entry, traffic identities; never the controller's). Earlier would
  be useless: a flow flushed before the rule exists is tracked again. Without the collector's
  `net.conntrack_flush` capability, offline, or without a known address, `lastFlush.flushed` is
  `null` with `reason` (`capability_missing`, `offline`, `no_address`) and the UI says running
  connections continue; an agent failure is `false` with its reason.
- **Guard** `wan_block_self` (422): the device holds the controller's address, an access point's
  address (`agent_last_address`, `ssh_host`), or the admin's client address.
- **Two-way.** A MAC added to the set in LuCI is a blocked device (no metadata row: `since` null);
  a block rule disabled in LuCI shows `ruleEnabled: false` ("blocked (rule disabled on router)");
  a set the router excluded is `routerOwned` and writes are refused (409 `wan_block_router_owned`).
- A household control, not a security boundary: a random or spoofed MAC evades it.
- Metadata (who, when, note, last flush): `gateway_wan_blocks`; events `wan_blocked`,
  `wan_unblocked`, `conntrack_flushed`.
- For the device page's network card (`GET /devices/:mac/network`, `wanBlocked`), the service
  exports `deviceWanBlock(gateway, mac): Promise<WanAccessView>`.

## 6. REST API

All under `/api/v1`, `{ data }` envelopes, refusals `{ error, message, …data }`, Vine 422
`{ errors }`. `:id` is `gateways.id`. **Every firewall route is admin-only, reads included**
(plan 2 section 5; 403 `admin_required`, anonymous 401); `GET /devices/:mac/wan-access` is for any
signed-in user. Writes put the change into the draft through `editSections` and, unless `?apply=0`,
start an apply of exactly the touched sections; responses carry `apply: GatewayApply | null` (with
`changes`) and `applyError: {error, message} | null` (why the apply did not start; the draft is
kept), as in config-plane.md 10.3. Common refusals: 404 `gateway_not_found`, 409 `not_managed`,
`not_synced` (a router-owned section: include it first), 422 `invalid_config` {issues}.

```ts
type FirewallSync = { perchId: string; section: string; owner: 'perch' | 'router'
  scope: 'synced' | 'excluded' | 'unmodeled'; issue: 'ambiguous' | 'no_round_trip' | 'duplicate' | null
  status: 'in_sync' | 'ahead' | 'pending' | 'conflict' | 'drift' | 'reverting'
  applied: boolean; conflict: boolean; driftSince: string | null }
type Zone = { name: string; networks: string[]; input: string | null; output: string | null
  forward: string | null; masq: boolean; mtuFix: boolean; wan: boolean; management: boolean; sync: FirewallSync }
type Forwarding = { src: string; dest: string; family: string; enabled: boolean; sync: FirewallSync }
type FirewallRule = { id: string /* perchId */; name: string | null; enabled: boolean
  position: number | null  /* index among the rules in file order */
  src: string | null; dest: string | null; proto: string[]; srcIp: string[]; srcMac: string[]
  destIp: string[]; srcPort: string | null; destPort: string | null; family: string | null
  target: string; ipset: string | null; perchBlock: boolean
  shadowedBy: string | null; pathIssue: 'firewall_controller_path' | 'firewall_admin_path' | null
  sync: FirewallSync }
type PortForward = { id: string; name: string | null; enabled: boolean; position: number | null
  proto: string[]; srcZone: string | null; externalPort: string | null; destZone: string | null
  destIp: string | null; destPort: string | null; reflection: boolean; family: string | null
  srcIp: string[]; device: { mac: string; name: string | null } | null
  shadowedBy: string | null; sync: FirewallSync }
type FirewallOrder = { status: 'in_sync' | 'ahead' | 'conflict' | 'drift'; desired: string[]
  router: string[]; conflict: { router: string[]; detectedAt: string } | null; driftSince: string | null }
type WanAccess = { mac: string; blocked: boolean; applied: boolean; since: string | null
  by: number | null; note: string | null; ruleEnabled: boolean | null; routerOwned: boolean
  lastFlush: { at: string; flushed: boolean | null; ips: string[]; matched?: number
    deleted?: number; skipped?: number; reason?: string; applyId?: string } | null }
```

| Method, path | Request | Response `data` | Refusals |
|---|---|---|---|
| `GET /gateways/:id/firewall` | – | `{ gatewayId, mode, authoritative, zones: Zone[], forwardings: Forwarding[], rules: FirewallRule[], portForwards: PortForward[], ipsets: {perchId, section, name, match, entries, family, managed}[], includes: {perchId, section, type, path, position, owner: 'package'\|'perch'\|'operator', sha256: null}[], observed: {perchId, section, type}[], defaults: object \| null, flowOffloading, flowOffloadingHw, wanZones: string[], managementZone: string \| null, orders: { rule: FirewallOrder \| null, redirect: FirewallOrder \| null }, issues: Issue[] }` | 404 |
| `POST /gateways/:id/firewall/port-forwards[?apply=0]` | `{ name, proto: ('tcp'\|'udp')[], externalPort, destIp? \| deviceMac?, destPort?: string \| null, reflection?, enabled?, srcZone? = 'wan', destZone?, allowUnreserved? }` | 201 `{ gatewayId, object: PortForward, issues, apply, applyError }` | 409 `firewall_port_taken` {id}, `device_no_lease`, `dhcp_host_exists`; 422 `firewall_dest_not_reserved`, `firewall_port_invalid`, `firewall_zone_unknown`, `firewall_ip_invalid`, `firewall_dest_required` |
| `PATCH /gateways/:id/firewall/port-forwards/:perchId[?apply=0]` | same fields, all optional | `{ …, object }` | 404 `port_forward_not_found`; 409 `not_synced`; as above |
| `DELETE /gateways/:id/firewall/port-forwards/:perchId[?apply=0]` | – | `{ …, object: null }` | 404; 409 `not_synced` |
| `PUT /gateways/:id/firewall/port-forwards/order[?apply=0]` | `{ ids: string[] }` (every synced redirect once) | `{ gatewayId, order: FirewallOrder, portForwards, apply, applyError }` | 422 `firewall_order_incomplete` {missing, unknown}; 409 `pending_apply` |
| `POST /gateways/:id/firewall/rules[?apply=0]` | `{ name, src?, dest?, proto?, srcMac?, srcIp?, destIp?, destPort?, target: 'ACCEPT'\|'REJECT'\|'DROP', family?, enabled?, placement?: 'top'\|'bottom' }` | 201 `{ …, object: FirewallRule }` | 422 `firewall_controller_path`, `firewall_admin_path`, `firewall_rule_unsupported` (output rule, ports without TCP/UDP), `firewall_zone_unknown`, `firewall_port_invalid`, `invalid_mac` |
| `PATCH /gateways/:id/firewall/rules/:perchId[?apply=0]` | same fields optional (no `placement`) | `{ …, object }` | 404 `firewall_rule_not_found`; 409 `not_synced`, `firewall_rule_perch_block` (the block rules follow the device page); as above |
| `DELETE /gateways/:id/firewall/rules/:perchId[?apply=0]` | – | `{ …, object: null }` | 404; 409 as above |
| `PUT /gateways/:id/firewall/rules/order[?apply=0]` | `{ ids: string[] }` (every synced rule once; router-owned rules keep their slots) | `{ gatewayId, order, rules, apply, applyError }` | 422 `firewall_order_incomplete`; 409 `pending_apply` |
| `POST /gateways/:id/firewall/order/resolve[?apply=0]` | `{ type: 'rule'\|'redirect', take: 'router'\|'controller' }` | `{ gatewayId, order, apply, applyError }` (`controller`: the apply writes C) | 409 `nothing_to_resolve`, `not_managed` |
| `GET /devices/:mac/wan-access?gatewayId=` | – | `{ gatewayId, …WanAccess }` | 400 `invalid_mac`; 404 `gateway_not_found`; 409 `gateway_ambiguous`, `not_managed` |
| `PUT /devices/:mac/wan-access[?apply=0]` (admin) | `{ gatewayId?, blocked: boolean, note?: string \| null }` | `{ gatewayId, object: WanAccess, flushed: boolean \| null, perchIds, issues, apply, applyError }` (`flushed` is usually null here: the flush runs when the job is live; read `lastFlush`) | 422 `wan_block_self`; 409 `wan_block_router_owned`, `firewall_no_wan_zone`, `gateway_ambiguous` |

Order conflicts and order drift are also visible in `GET /gateways/:id/sync-status` (blocker
`kind: 'order'`); section-level drift of firewall sections uses the plane's `drift/accept` and
`drift/revert-now`; order drift is accepted with `order/resolve {take:'router'}`.

## 7. Zones for the networks domain

Zones are created and renamed by the networks plan only. The domain exports pure helpers for it
(`domains/firewall.ts`), used through the same draft (`editSections` with domain `firewall`):

```ts
type NetworkPurpose = 'lan' | 'guest' | 'iot' | 'management' | 'custom'
addNetworkToZone(zone: FirewallObject, network: string): FirewallObject      // keeps list vs string spelling
removeNetworkFromZone(zone: FirewallObject, network: string): FirewallObject // drops `network` when empty
zoneObjectsForNetwork(input: { network: string; purpose: NetworkPurpose; zoneName?: string
  wanZones: string[]; existingZones: string[] }): FirewallObject[]            // throws on a bad/taken name
wanZones(zones: ZoneInfo[]): string[]; zoneOfNetwork(zones, network): string | null
firewallDomain.render(obj, current): SectionEdit[]
```

`zoneObjectsForNetwork` defaults: `lan` input/output/forward ACCEPT; `management` ACCEPT/ACCEPT/
REJECT; `guest`, `iot` and `custom` REJECT/ACCEPT/REJECT; a forwarding to each WAN zone; `guest` and
`iot` also get `<Zone>-DHCP` (udp 67, ipv4) and `<Zone>-DNS` (tcp/udp 53) input rules. Zone names:
`^[A-Za-z][A-Za-z0-9_]{0,10}$` (fw3's 11-character limit, kept). A zone listing the management
network is planned in the protected job (config-plane.md 6).

## 8. Storage

| Table | Migration | Notes |
|---|---|---|
| `gateway_section_orders` | `1779000000090` | UNIQUE (gateway, config, section_type); `base_order`, `desired_order` (JSON perch ids), `status`, `conflict` (JSON), `drift_since`, `updated_by_user_id`; CASCADE with the gateway |
| `gateway_applies.post_actions` | `1779000000091` | JSON `{conntrackFlush: {mac, ips, perchIds, done?, result?}}`; carried to the next job of a chain until it ran |
| `gateway_wan_blocks` | `1779000000092` | UNIQUE (gateway, mac); `blocked_at`, `blocked_by_user_id`, `note`, `last_flush` (JSON); CASCADE with the gateway |

None references `collectors`: `collectors:merge` needs no rule.

## 9. Not here (yet)

- **Runtime checks of "in sync"** (plan 2 section 4.3 (d)): `fw4 check` clean and `nft list set
  inet fw4 perch_block_wan` equal to `entry` need a collector report (a `firewall` observe part or
  capability); the controller checks the UCI side only.
- **Include content hashes** (`sha256`): the plane reads UCI, not the included files; null.
- **Probes after apply** (plan 2 P8, a fresh TCP connection to the controller): the agent's
  fresh-session confirm covers the socket; the resolver/probe step is router-side work.
- Rules with `output` are never created by Perch (plan 2); operators' imported output rules sync.
- Order history is not in revision snapshots: a restored revision restores sections, not order.
