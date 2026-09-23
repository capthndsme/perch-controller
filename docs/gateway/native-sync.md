# Managed gateway: the rest of native OpenWrt sync (controller side)

Status: built 2026-09-24 (milestone M11, plan 2 phase 4: sections 4.1, 4.2, 4.4, 4.5, 4.6). The
dashboard's Gateway → DHCP, DNS, Routing and System pages are built from this document. No router
change was needed: every write is an ordinary `gateway.config.apply` of the config plane.

Four domains join the registry, each riding the plane like every other one
(docs/gateway/config-plane.md): two-way sync with a per-section base, conflicts, Authoritative
Mode, apply with confirm and rollback, the management-path job. This document adds what they
claim and own, their guards, their "in sync" checks and the REST API.

Placeholders only: 192.168.x.x, 203.0.113.x, 198.51.100.x, example.com.

| File | Role |
|---|---|
| `app/services/gateway_config/domains/verbatim.ts` | shared helpers: verbatim section objects (the round trip is exact), flags, prefixes, private ranges |
| `domains/system.ts`, `domains/zoneinfo.ts` | `system`: host name, time zone, NTP; zone name → POSIX TZ table (from tzdata, like LuCI) |
| `domains/routes.ts` | `routes`: `route`/`route6`, identity, the management-path test |
| `domains/dns_settings.ts` | `dns_settings`: dnsmasq sections, item syntax, the controller-name guard |
| `domains/dhcp_tags.ts` | `dhcp_tags`: `config tag`; `dhcp_hosts` now also owns `tag` |
| `app/services/gateway_config/observed_facts.ts` | the observation parts the checks read (resolver, system, interfaces, mwan3; stale parts read null) |
| `native_common.ts`, `dhcp_service.ts`, `dns_service.ts`, `routing_service.ts`, `system_service.ts` | REST layer |
| `app/controllers/gateway_native_controller.ts`, `app/validators/gateway_native.ts` | HTTP (DNS stays in `gateway_names_controller.ts`) |

## 1. What is claimed, and who owns what

| Config | Section | Domain | Perch owns | Router-owned (carried verbatim, never conflict, never drift) |
|---|---|---|---|---|
| `system` | `system` (`@system[0]`) | `system` | `hostname`, `timezone`, `zonename` | `log_size`, `ttylogin`, `urandom_seed`, `cronloglevel`, … |
| `system` | `timeserver 'ntp'` | `system` | `enabled`, `enable_server`, `server[]` (set) | `interface`, `use_dhcp`, … |
| `network` | `route`, `route6` | `routes` | `interface target netmask gateway metric table type disabled` | `mtu`, `onlink`, `source`, … |
| `dhcp` | `dnsmasq` | `dns_settings` | `domain`, `local`, `rebind_protection`, `noresolv`; **per item** `server[]`, `rebind_domain[]`, `address[]` | `port`, `interface[]`, `notinterface[]`, `resolvfile`, `cachesize`, … |
| `dhcp` | `tag '<name>'` | `dhcp_tags` | `dhcp_option[]` (keyed by code), `force` | anything else |
| `dhcp` | `host` | `dhcp_hosts` | adds `tag` (compared as a set) | `duid`, `match_tag`, `instance`, `broadcast`, … |
| `dhcp` | `dhcp` (pools) | `dhcp_pools` (M5) | unchanged: `dhcp_option` items keyed by code | IPv6: `ra`, `dhcpv6`, `ndp`, `ra_flags`, `dns` |

Not claimed, so `unmodeled` (mirrored, shown, never written, never drift): `network` `rule`/`rule6`
(policy routing: observe only, plan 2 section 4.4), all of `mwan3` and `pbr` (README decision 12:
read only), `system` `led`/`button`/others (LED and locate are "later"; container gateways have
none), `dhcp` `odhcpd` and every IPv6 option (router-owned, plan 2 section 4.1). AdGuard Home and any
other front resolver are never configured (decision 12); dnsmasq's `port` is router-owned on
purpose: on the live gateway dnsmasq answers on :54 behind AdGuard, and moving it from the
controller would take DNS away from the front resolver.

**Item ownership** (plan 2 P4, config-plane.md section 2): a `dnsmasq` section is shared. Perch
owns the `server`, `rebind_domain` and `address` items it added; the router's items stay the
router's in the router's order, the API shows them with `owner: 'router'` and a PATCH never
touches them. Router edits to them are imported silently and are never drift. The rendered list
is the router's items, then Perch's. Removing a Perch item keeps it owned until the apply removed
it from the router (`ownershipFor` in `apply_plan.ts`), then the next import prunes it.

**Upgrades.** A section that was mirrored as `unmodeled` before its domain existed (every
`dnsmasq`, `system` and route section on a gateway managed before M11), or one that was
`ambiguous` / `no_round_trip` and the operator fixed, is promoted to `synced` on the next read with
B = R = C = the router's content (`promoteMirror` in `sync_engine.ts`), in any mode: nothing to
revert, never drift. Anonymous sections (`@dnsmasq[0]`, `@system[0]`, LuCI routes) are renamed
`perch_<id>` by the next apply like any adopted anonymous section (README 7.6), which keeps
`@dnsmasq[0]`-style references working.

**Apply order** stays by config (README 3.5): `system` → `network` → `dhcp` → `firewall`. The
registry lists the domains in that order too (`system`, `networks`, `routes`, `dhcp_pools`,
`dhcp_hosts`, `dns_records`, `dns_settings`, `dhcp_tags`, `firewall`, `sqm`).

## 2. DHCP (plan 2 section 4.1)

Pools keep the M5 model; this adds their options. A pool's `dhcp_option` items are read by code:
`3` gateway (router), `6` DNS servers, `42` NTP servers, `15` domain, and every other untagged item
as `other {code, name, value, raw}` (`option:<name>` spellings map to codes; `tag:x,…` items and
unparseable ones are shown raw and never rewritten). An edit replaces the items of a code at the
first one's place; `other` replaces the untagged other codes.

Guards (REST):
- **Gateway option**: 422 `dhcp_gateway_not_router` when option 3 is not the router's address on
  that network, unless `confirm` = the network's name.
- **Disabling a pool** that carries the management path or the admin's own client (the request's
  address is in its subnet): 409 `dhcp_confirm_required`, unless `confirm` = the network's name.
  (A wrong option 3/6 or a disabled pool bites at renewal, long after any rollback window.)
- Addresses in 3/6/42 must be IPv4 (422 `dhcp_gateway_invalid`, `dhcp_dns_invalid`,
  `dhcp_ntp_invalid`); `15` must be a domain; `other` codes 1–254 except the named ones.
- The range must fit the subnet (422 `dhcp_range_outside_subnet`); lease times as UCI takes them
  (`12h`, `1200d`, `infinite`: the live gateway's 1200-day leases stay).
- Not built: plan 2's `dhcp_dns_unreachable` (asking the router to query a DNS server needs an
  agent RPC that does not exist yet) and the post-apply renewal watch.

**Tags.** `config tag '<name>'` carries its own `dhcp_option` items; a reservation with that tag
(`host` `tag`) gets them, so one device can get its own DNS server without a pool. A tag another
reservation still carries cannot be deleted (409 `dhcp_tag_in_use`). Tag names: `[A-Za-z0-9_]{1,32}`.
Reservations claimed before `dhcp_hosts` owned `tag` get it added to their ownership on their first
tag edit (`widenOwnership`), so the edit is not lost to the router's value.

## 3. DNS (plan 2 section 4.2)

The resolver settings of one `dnsmasq` instance (default: the first): `domain`, `local` (written
`/<domain>/`), rebind protection and its allowed domains, `noresolv`, upstream servers
(`ip[#port][@iface]`), domain forwards (`/example.com/192.168.1.53`, `/example.com/` = answer
locally only, `#` = the standard servers) and address overrides (`/example.com/192.168.1.5`,
`/example.com/` = NXDOMAIN). Records and label names are M3's (config-plane.md section 10.3).

**The controller's name is pinned** (plan 2 section 4.2). Its name and addresses come from the
resolver observation (`controllerHost`, the name the agent dials, as the router resolves it), else
the host of `APP_URL` with the management path's address. Refused:
- 422 `dns_no_upstream`: `noresolv` on with no plain upstream left, when the router resolved before;
- 409 `dns_controller_name_pinned`:
  - a new `address`/`server` item for the name's domain, unless an address item keeps the address
    the router resolves today, and dropping one that answers it;
  - `local` newly covering the name while no local record answers it;
  - rebind protection dropping the name's `rebind_domain` cover while it resolves to a private
    address from upstream (on, or its item removed);
  - removing a private upstream server while the name resolves privately and nothing local
    answers it (the name may come from that server);
  - a DNS record for the name with another answer, or deleting the record that answers it.

When rebind protection would refuse the controller's private answer today, the instance says
`suggestRebindDomain: true` and the page offers to add the name.

## 4. Routing (plan 2 section 4.4)

Static routes are managed two-way; policy rules, mwan3 and pbr are shown read-only. Identity: the
ledger, else `route<4|6>:<interface>|<prefix>|<table|main>|<type>` (a `target` + `netmask` and a
`target` with `/len` are the same route).

**Management path** (README 3.8). A route whose target contains the address the agent reaches the
controller at (`gateways.management_path.controllerAddress`) goes into a protected job with the
longer confirm window (`touchesManagement`). The REST layer refuses (422 `routing_controller_path`)
a route that would take the path away (`routeStealsPath`): in the main table, enabled, covering the
controller, and either dropping (`unreachable`, `prohibit`, `blackhole`, `throw`) or leaving by
another network with a prefix at least as long as the path's today (the management network's
subnet when the controller is on it, else the longest route on the path's network covering it,
else 0: the default route). Deleting the route the path runs on is refused the same way unless the
controller is on-link. Validation flags the same case as a warning on imported routes (they work
today, since the agent is connected). Also 422 `routing_interface_unknown`,
`routing_target_invalid`, `routing_gateway_invalid`.

## 5. System (plan 2 section 4.5)

Host name (one label, letters, digits, dashes, ≤ 63), time zone and NTP. The API takes an IANA zone
name and writes both `zonename` and the POSIX `timezone` from `zoneinfo.ts` (445 zones: `zone.tab`,
`UTC`, `Etc/GMT±N`), like LuCI; an imported pair that disagrees is a validation warning. NTP: the
client (`enabled`), the server (`enable_server`) and the server list (host names or addresses). A
host name change renames the agent's hello on its next connect. Other inventory decisions of plan
2 section 4.5 are unchanged: reboot, backups, UPnP, WireGuard, DDNS, packages are the observation
channel's (observation.md); LED/locate and natmap are later.

## 6. "In sync" per feature (plan 2 section 4.6)

`ConfigDomain.inSync(sections, observed)` runs in `computeSyncStatus` (via `featureSyncIssues`) on
the latest observation parts; a part the agent does not report, or a stale one (older than
1800 s), skips its check rather than guessing. Each finding is a sync-status blocker
`{ kind: 'feature', feature, objectId, code, message }`, so it blocks enabling Authoritative Mode
(409 `not_in_sync`) like the section-level blockers.

| Feature | Code | When |
|---|---|---|
| any domain | `section_ambiguous`, `section_duplicate` | a section the domain would manage is ambiguous (two hosts on one MAC, T-A1) or a duplicate; clears when the operator fixes it on the router |
| `system` | `system_hostname_not_live` | the router reports another host name than the configured one |
| `dns_settings` | `dns_dnsmasq_not_running` | dnsmasq should answer (port ≠ 0) but the resolver report has no dnsmasq port |
| `dns_settings` | `dns_controller_name_unresolved` | the router cannot resolve the controller's name |
| `routes` | `route_interface_missing` | an enabled managed route names an interface netifd does not report |

Not checked yet (no agent report): each managed route present in the kernel table
(`installed` is `null`), each managed name resolving via `127.0.0.1:<dnsmasqPort>`, the rendered
`/var/etc/dnsmasq.conf.*`.

## 7. REST API

All under `/api/v1`, `{ data }`, refusals `{ error, message, …data }`, Vine errors 422
`{ errors }`. `:id` is `gateways.id`. **All routes are admin-only** (403 `admin_required`,
anonymous 401), reads included (plan 2 section 5), except `GET /gateways/:id/dns` which stays
readable by any signed-in user as in M3. Every write takes `?apply=0` to stage only; by default it
starts an apply of exactly the touched sections. Write answers are
`{ gatewayId, object, issues, apply: GatewayApply | null, applyError: {error, message} | null }`.
Common refusals: 404 `gateway_not_found`, 409 `not_managed`, 409 `not_synced` (a router-owned
section: include it first), 409 `pending_apply`, 422 `invalid_config` {issues}.

```ts
type SyncInfo = { perchId: string; section: string; owner: 'perch' | 'router'
  scope: 'synced' | 'excluded' | 'unmodeled'; issue: string | null
  status: 'in_sync' | 'ahead' | 'pending' | 'conflict' | 'drift' | 'reverting'
  applied: boolean; conflict: boolean; driftSince: string | null }
type DhcpOptionsView = { gateway: string | null; dnsServers: string[]; ntpServers: string[]
  domain: string | null; other: { code: number | null; name: string | null; value: string; raw: string }[] }
type DhcpPoolView = { network: string; perchId: string; section: string; subnet: string | null
  routerAddress: string | null; enabled: boolean; start: number | null; limit: number | null
  leaseTime: string | null; force: boolean; options: DhcpOptionsView
  ipv6: { ra: string | null; dhcpv6: string | null; ndp: string | null; raFlags: string[] }
  management: boolean; sync: SyncInfo }
type DhcpTagView = { perchId: string; name: string; options: DhcpOptionsView; force: boolean
  reservations: string[]; sync: SyncInfo }
type DhcpReservationRow = DhcpReservation /* config-plane.md 10.3 */ & { tags: string[]; network: string | null }
type DnsInstanceSettings = { domain: string | null; local: string | null; rebindProtection: boolean
  noresolv: boolean; port: number | null; interfaces: string[]; notInterfaces: string[]
  upstreams: { value: string; owner: 'perch' | 'router' }[]
  forwards: { value: string; domains: string[]; server: string | null; owner }[]
  addresses: { value: string; domains: string[]; address: string; owner }[]
  rebindDomains: { value: string; owner }[]; other: { option: string; value: string; owner }[] }
type DnsSettingsView = { gatewayId: number; dnsmasqPort: number | null; frontResolver: string | null
  adguard: boolean
  instances: { perchId: string; section: string; settings: DnsInstanceSettings
               suggestRebindDomain: boolean; sync: SyncInfo }[]
  controllerHost: { name: string | null; addresses: string[]; error: string | null
                    source: 'resolver' | 'app_url' | 'none'; pinned: boolean; local: boolean }
  observedAt: string | null }
type RouteView = { id: string; family: 4 | 6; interface: string | null; target: string | null
  gateway: string | null; metric: number | null; table: string | null; type: string; enabled: boolean
  managementPath: boolean; installed: null; extra: Record<string, string | string[]>; sync: SyncInfo }
type RoutingView = { gatewayId: number; routes: RouteView[]
  policyRules: { id: string; family: 4 | 6; section: string; options: object; priority: number | null; lookup: string | null }[]
  interfaces: { name: string; up: boolean | null; lan: boolean }[]
  management: { network: string | null; controllerAddress: string | null }
  mwan3: { config: { id; section; type; options }[] | null; observed: Mwan3Observation | null }
  pbr: { config: { id; section; type; options }[] | null } }
type SystemConfigView = { hostname: string | null; zonename: string | null; timezone: string | null
  ntp: { enabled: boolean; server: boolean; servers: string[]; sync: SyncInfo } | null
  sync: SyncInfo | null; zoneNames: string[] }
```

| Method, path | Request | Response `data` | Refusals |
|---|---|---|---|
| GET `/gateways/:id/dhcp` | – | `{ gatewayId, pools: DhcpPoolView[], reservations: DhcpReservationRow[], tags: DhcpTagView[], odhcpd: { maindhcp } \| null }` | 404 |
| PATCH `/gateways/:id/dhcp/pools/:network` | `{ enabled?, start?, limit?, leaseTime?, force?, options?: { gateway?, dnsServers?, ntpServers?, domain?, other?: {code, value}[] }, confirm? }` | write answer, `object: DhcpPoolView` | 404 `dhcp_pool_not_found`; 409 `dhcp_confirm_required`; 422 `dhcp_gateway_not_router`, `dhcp_gateway_invalid`, `dhcp_dns_invalid`, `dhcp_ntp_invalid`, `dhcp_domain_invalid`, `dhcp_option_invalid`, `dhcp_leasetime_invalid`, `dhcp_range_outside_subnet` |
| POST `/gateways/:id/dhcp/tags` | `{ name, options?, force? }` | 201 write answer, `object: DhcpTagView` | 409 `dhcp_tag_exists`; 422 `dhcp_tag_invalid` |
| PATCH / DELETE `/gateways/:id/dhcp/tags/:perchId` | `{ options?, force? }` / – | write answer | 404 `dhcp_tag_not_found`; 409 `dhcp_tag_in_use` {reservations} |
| PATCH `/gateways/:id/dhcp/reservations/:perchId` | `{ ip?, hostname?, leaseTime?, publishDns?, tags? }` | write answer, `object: DhcpReservationRow` | 404 `dhcp_reservation_not_found`; 422 `dhcp_ip_invalid`, `dns_name_invalid`, `dns_name_reserved`, `dhcp_tag_invalid`, `dhcp_host_empty` |
| GET `/gateways/:id/dns` | – | M3's overview + `settings: DnsSettingsView` | 404 |
| PATCH `/gateways/:id/dns` | `{ labelNames?, instance?, domain?, local?, rebindProtection?, noresolv?, upstreams?: string[], forwards?: {domain, server \| null}[], addresses?: {domain, address \| null}[], rebindDomains?: string[] }` (the lists are Perch's items; router items stay) | the GET shape + `issues, apply, applyError` | 404 `dns_instance_not_found`; 409 `dns_controller_name_pinned`; 422 `nothing_to_change`, `dns_no_upstream`, `dns_server_invalid`, `dns_address_invalid`, `dns_rebind_domain_invalid`, `dns_domain_invalid`, `dns_local_invalid` |
| GET `/gateways/:id/routing` | – | `RoutingView` | 404 |
| POST `/gateways/:id/routing/routes` | `{ family?: 4 \| 6, interface, target (CIDR), gateway?, metric?, table?, type?, enabled? }` | 201 write answer, `object: RouteView` | 422 `routing_controller_path`, `routing_interface_unknown`, `routing_interface_required`, `routing_target_invalid`, `routing_gateway_invalid`, `routing_type_invalid` |
| PATCH / DELETE `/gateways/:id/routing/routes/:perchId` | same fields, optional / – | write answer | 404 `routing_route_not_found`; as above |
| PATCH `/gateways/:id/system` | `{ hostname?, timezone? (zone name), ntpEnabled?, ntpServe?, ntpServers? }` | write answer, `object: SystemConfigView` | 404 `system_not_found`; 422 `system_hostname_invalid`, `system_timezone_invalid`, `system_ntp_server_invalid` |
| GET `/gateways/:gatewayId/system` | – | observation.md's shape, now with `timezone`, `zonename`, `ntp {enabled, server, servers}` and `config: SystemConfigView \| null` | 404 |

## 8. Tests

- `tests/unit/services/gateway_native_domains.spec.ts`: registry order and claims over the fixtures
  in `tests/unit/services/fixtures/native/` (`dhcp`, `network`, `system`, shaped like OpenWrt 24.10
  configs), the round-trip invariant for every new domain, ownership, validation, the path test,
  the DNS item syntax and guard, DHCP option editing, feature blockers and the mirror promotion.
- `tests/functional/gateway/native.spec.ts` (the scripted gateway, `tests/helpers/fake_gateway.ts`):
  authz, import scopes, pool options and guards, tags, DNS item ownership with router edits
  imported two-way, the controller-name pin (T-N2), routes with the path guard and a LuCI route
  imported (T-R1, T-R2), system writes and a LuCI zone change flowing back (T-S1), feature
  blockers gating Authoritative Mode with a router edit then drift (4.6), and T-A1.
- Lab tests of plan 2 section 7 for these features (T-N3, T-R1–R3, T-S1 on `plab-gw`) are not run
  yet (the lab was taken by another task).
