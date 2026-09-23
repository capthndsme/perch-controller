# Managed gateway: the config plane (controller side)

Status: data layer and pure core built (work packages S1 and S2, 2026-09-23). Agent wiring,
the apply lifecycle and the REST API (S3, S4) build on this and are not here yet.

The collector on an OpenWrt router becomes a managed gateway: controller edits apply to the
router's native UCI config, and router edits (LuCI, `uci`, ssh) flow back. This document is the
controller-side contract: model, merge rules, storage, settings and the extension point for
feature domains. The router side (UCI access, apply/confirm/rollback on the agent, the protocol on
the `perch-collector.v1` socket) is specified with the collector.

Placeholders only: 192.168.x.x, example.com, MACs `02:00:00:…`.

Code: `app/services/gateway_config/` (pure, no I/O unless noted), models `app/models/gateway*.ts`.

Section numbers follow plan 1 of the design (and the code comments cite them): 2 model, 5 sync,
6 services and applying, 7 domains, 9 storage, 11 settings and security. Sections 3, 4, 8 and 10
(router side, protocol, networks, REST) are added here as they are built.

| File | Role |
|---|---|
| `types.ts` | shared types and string unions (section content, ownership, statuses, apply ops, capabilities) |
| `canonical.ts` | canonical form, equality under domain rules, diffs |
| `secrets.ts` | fingerprints, redaction, secret refs, wire form of secrets |
| `domain.ts` | `ConfigDomain`, `DomainRegistry`, excluded configs, apply order, edits, round-trip harness |
| `sync_engine.ts` | three-way merge, conflicts, drift, reconciling a read, statuses, the "in sync" predicate, state machines |
| `apply_plan.ts` | ops of an apply job, management-path split, ledger, `editSections` core |
| `revisions.ts` | snapshots, diffs, rejoin offer, pruning selection, restore |
| `domains/` | the registry's domains; `dhcp_hosts.ts` is the sample |
| `gateway_config_settings.ts` | Settings → Gateway (DB) |
| `config_retention.ts` | pruning of events and revisions (DB) |

## 2. Model

**Gateway.** A collector whose hello carries the `gateway_config` capability gets one `gateways`
row. Mode `off` (default) | `observe` (read-only mirror, the router always wins) | `managed`
(two-way). `authoritative` is meaningful only in `managed`. Effective access is the lower of the
controller mode and the router's `config_access` (`none` | `read` | `write`).

**Section scope.** Every UCI section in an allowlisted config is one of:

| Scope | What | Written by Perch | Router edits |
|---|---|---|---|
| `synced` | claimed by a domain, in the ledger | yes | two-way: imported. Authoritative: drift, reverted |
| `excluded` | claimed, but the admin marked it router-only | never | mirrored and logged |
| `unmodeled` | no domain claims it, or it is ambiguous, or it does not round-trip | never | mirrored and logged |

**B, R, C.** Per synced section the controller holds B (base: last content both sides agreed on),
R (the router's content at the last read) and C (desired). `null` = absent. Revisions are the
linear history of agreed states (changes of B), whichever side made them.

**Section content** (`SectionContent`, stored as JSON in `base_content`, `router_content`,
`desired_content` and revision snapshots):

```ts
type UciValue = string | string[]
interface SecretSlot { fingerprint: string; ref?: string }   // ref = a controller-set value in gateway_secrets
interface SectionContent { type: string; options: Record<string, UciValue>; secrets?: Record<string, SecretSlot> }
```

**Identity: the ledger** (README 3.1). `/etc/config/perch-managed`, written only by the agent, maps
`perch_id` → `(config, section, domain)`. Adopted anonymous sections are renamed `perch_<id>`
through the normal apply and confirm (README 7.6). No marker options are ever written into
foreign configs. When a synced section disappears from its ledger name, the engine re-links it by
the domain's identity keys (plan 2 P6); two router sections sharing an identity key are
`ambiguous` and stay unmodeled until the operator fixes them.

**Ownership inside a section** (README 3.2, plan 2 P3/P4):

```ts
type SectionOwnership =
  | { kind: 'section' }                                                  // everything (stored as null)
  | { kind: 'options'; options: string[]; items?: Record<string, string[]> }
```

With `options`, only the listed options are Perch's: router-owned options always take the router's
value, never conflict and are never drift. `items` narrows a list option to the items Perch added
(`dnsmasq.server`, `rebind_domain`); foreign items stay the router's. A controller edit that adds
an item must list it in `items` (`planSectionEdits` does this).

**Excluded configs** (README 3.4): `perch-collector`, `perch-apd`, `rpcd`, `uhttpd`, `dropbear`,
plus `luci` and the ledger `perch-managed`. The registry refuses a domain naming one; the planner
never plans one; the agent enforces the same list.

## 5. Two-way sync

### 5.1 One section, three-way (`mergeSection`)

- R = B: `unchanged` (C stands; it may be a pending controller edit).
- C = B: import R (C := B := R).
- Both moved: per owned option, C[o] if R[o] = B[o], R[o] if C[o] = B[o], either if they agree,
  else a conflict on o. Router-owned options take R.
- Deleted on one side, edited on the other: conflict `delete_vs_edit`. Deleted on both: gone.
- Type changed on the router while the controller moved: conflict `type`. Changed by the controller
  only: C's type.
- A clean both-moved merge sets B := R and C := merged (status `ahead` when C ≠ R).

Equality is canonical (type, options by name, list order kept, secrets by fingerprint) under the
domain's rules: a normaliser (`12h` = `720m`; `mac 'a b'` = `list mac 'a' 'b'`) and list
semantics:

| `ListSemantics` | Merge |
|---|---|
| `'atomic'` (default) | the whole list is one value; order matters (`list ports`) |
| `'set'` | item by item, never a conflict; the router's order, then items only C added |
| `{ keyed: (item) => key }` | item by item per key (`dhcp_option` by code); one key changed differently on both sides is a conflict |

Stored content is never normalised: the round trip reproduces the router's spelling.

### 5.2 Conflicts (two-way)

A conflict blocks applying that section only; the router's running value stays live until the
admin resolves (`resolveConflict`: `take: 'router' | 'controller'`, or `custom` per option).
Afterwards B := R, and the status is `ahead` when C ≠ R, else `in_sync`. A conflict whose router
side comes back to B or reaches C settles by itself. Router edits a rollback discarded come back as
a conflict with `origin: 'rollback_discarded'` and the discarded content; taking the router puts it
back into C.

### 5.3 Authoritative Mode

Router edits to owned options of synced sections are drift: B and C stay, R and `driftSince` are
recorded. The grace delay (`authoritativeRevertDelaySeconds`, **90 s**, README 7.3) runs from the
first edit; the admin can accept (C := B := R) or revert now. Afterwards a `kind: 'revert'` apply
writes C (`sectionsDueForRevert`). New router sections of modeled types are drift with B = C =
null (the revert deletes them; their content is kept as the apply's `replaced_router_content`).
Deleted synced sections are re-created. The router going back to B, or reaching C, clears the
drift. `enforcementMaxFailures` failed reverts inside `enforcementWindowMinutes` suspend
enforcement: drift stays visible, nothing is reverted until the admin resumes.

### 5.4 "In sync" and enabling Authoritative Mode

`computeSyncStatus` returns `{ inSync, headRevision, observedAt, luciPending, uncommitted, blockers }`
from a fresh read merged into the rows. Blockers: `offline`, `mode_not_managed`,
`apply_in_flight`, `enforcement_suspended`, and per section `conflict`, `controller_ahead` (C ≠ B),
`router_ahead` (R ≠ C), `unimported_section` (a new router section in drift, or a synced section
missing from the ledger), each with a `ConfigDiffEntry`. A pending LuCI apply makes `inSync` false
without a blocker entry; excluded and unmodeled sections never block. `checkEnableAuthoritative`
answers the PATCH: `sync_changed` when the head revision moved since the admin looked, else
`not_in_sync`, else ok. The whole sequence runs inside the gateway's serial queue (S3), so a
router edit that lands after the fresh read is drift under the new mode, never a silent enable.

### 5.5 A whole read, and applies in flight (`reconcileRead`)

Input: every row of the gateway, a fresh `gateway.config.read` (configs + ledger), the registry,
mode, Authoritative flag, `now`, a perchId factory, the rows carried by an apply in flight, and an
optional initial-scope chooser. Output: per-row `SectionChange`s (`created`, `imported`, `merged`,
`conflict`, `drift`, `drift_cleared`, `mirrored`, `removed`, `relinked`, `deferred`, `rescoped`),
engine events (for `gateway_config_events`), the revision source when any B changed
(`import` on the first read, `merge` when a both-moved merge happened, else `router`), and the synced
rows missing from the ledger.

Matching: ledger entry → row name → identity keys. New router sections are claimed by the first
domain that claims them, checked for the round-trip invariant (a failure leaves them `unmodeled`,
issue `no_round_trip`) and imported as synced (README 7.5: every modeled section syncs, excludable
per section). A router edit that makes a section unclaimable (a wildcard MAC) rescopes it to
`unmodeled`. Rows in an in-flight apply are `deferred`: the observation is kept and merged after
the apply resolves. Configs not in the read are left alone. `observe`
mode always takes the router's content and drops drafts.

### 5.6 Statuses and state machines

Section status: `in_sync | ahead | pending | conflict | drift | reverting` (`deriveStatus`:
conflict > in-flight revert/apply > drift > ahead > in_sync). Gateway `sync_state`
(`rollupSyncState`): `unknown` (mode off, never read) > `applying` > `conflict` > `drift` > `ahead`
> `in_sync`.

Lifecycle helpers, one per edge of the diagrams: `applyControllerEdit`, `markInFlight`,
`markConfirmed(state, written)`, `markRolledBack(state, {discarded?})`, `resolveConflict`,
`acceptDrift`, `enforcementAfterFailure`, `checkModeChange` (off → observe needs router access ≥
read; → managed needs `write`, a secure transport and the step-up password; → off always),
`nextApplyState(state, event)` (queued → sending → pending_confirm → confirmed | rolled_back |
failed; queued → expired | cancelled; adopt-only jobs go sending → confirmed).

## 6. Applying

`planApply` turns rows into jobs (`PlannedJob`: kind, protected, configs, base hashes, ops, ledger
changes, perchIds, secret refs, `changes`, `written`, `replaced`). Send one job at a time and
re-plan after it finishes (the hashes change).

- **Order** (README 3.5): `system` → `network` → `dhcp` → `firewall` → `sqm` / `perch-qos` →
  `opennds` → `mwan3` / `pbr` → other configs alphabetically; within a config adopt, delete, put,
  order. One rollback covers a job.
- **Put** writes owned options from C and router-owned ones from the latest R.
- **Adoption**: a named, unchanged, unledgered section gets an `adopt` job (no confirm window);
  anonymous ones are renamed `perch_<id>` inside a normal apply (README 7.6). New controller
  sections are `put` under `perch_<id>` with a ledger entry. Ledger entries of rows that are no
  longer synced ride with the next job.
- **Management path** (README 3.8): sections carrying the network the agent reaches the controller
  through (`gateways.management_path`: `{ network, device }` from `ip route get <controller>` on the
  router) go into a job of their own, `protected`, confirmed with
  `managementConfirmTimeoutSeconds`. Built-in rules: the path's `interface`, an interface on its
  device, the `device` section that is the path's device or its parent bridge, a `bridge-vlan` on
  it, the firewall zone listing the network, and firewall `defaults`. DHCP pools are not on the
  path. Domains add rules with `touchesManagement`.
- **Secrets**: controller values go as `{"$secret": ref}` (the job lists the refs), router-owned
  values as `{"$keep": true}`.
- Conflicted sections are `blocked`; a `revert` job plans only drifted sections.

`planSectionEdits` is the pure core of `gatewayConfig.editSections(gatewayId, userId, edits)`, the
single write entry point for domain REST handlers: it turns a domain's `SectionEdit`s into new C
values and new controller rows, refusing sections that are not synced, belong to another domain or
live in an excluded config.

## 7. Domains (the extension point)

```ts
interface ConfigDomain<Obj = unknown> {
  key: string                                   // ^[a-z][a-z0-9_]{0,31}$
  configs: string[]                             // never EXCLUDED_CONFIGS
  types: string[]                               // section types it may claim
  claims(section: UciSection & { config: string }, all: UciConfigSet): boolean
  ownership?(section: UciSection & { config: string }): SectionOwnership   // default: whole section
  requires?(caps: GatewayCapabilities): string | null
  orderedTypes?: string[]
  listSemantics?: Record<string, ListSemantics>  // 'type.option'
  secretOptions?: string[]                       // 'type.option' or option
  normalize?(type: string, option: string, value: UciValue): UciValue
  identityKeys?(section: { type: string; options: UciOptions }): string[]
  touchesManagement?(section: { type: string; name: string; options: UciOptions }, path: ManagementPath): boolean
  parse(sections: SyncedSection[]): Obj[]
  render(obj: Obj, current: SyncedSection[]): SectionEdit[]   // unknown options kept verbatim
  validate(desired: SyncedSection[], ctx: ValidationCtx): Issue[]
}

type SectionEdit =
  | { op: 'put'; perchId: string | null; config: string; type: string; name?: string
      options: UciOptions; secrets?: Record<string, { ref: string; fingerprint: string } | { keep: true }> }
  | { op: 'delete'; perchId: string }
  | { op: 'order'; config: string; type: string; perchIds: string[] }
```

**Invariant**, tested for every domain with `checkRoundTrip(domain, sections)`: applying
`render(parse(x))` to x changes nothing, compared strictly (not normalised). The engine checks it
per section on import. Register domains in `domains/index.ts` (claim order = array order).
Perch-only metadata (labels, purposes) lives in each domain's own table keyed by `perch_id`, never
in UCI.

**Sample: `dhcp_hosts`** (`dhcp` config, `host` sections). Claims hosts with at least one
non-wildcard MAC and scalar `ip`/`name`/`dns`/`leasetime`. Owns `mac ip name dns leasetime`;
`duid hostid tag match_tag instance broadcast` and anything newer ride along as the router's.
Normalises MAC sets, lease times and the `dns` flag; identity keys `mac:<mac>` and
`duid:<duid>`. Validation: malformed MAC/IP/name/lease time, duplicate MAC or IP (also against
unmanaged hosts), the router's own address (errors), a duplicate name or an address outside every
LAN network (warnings). No REST yet (M3).

## 9. Storage

Migrations `1779000000048`–`050`. JSON columns are text parsed by the models (`jsonColumn`,
listed in `database/schema_rules.ts`). Only `gateways` references `collectors`; everything else
hangs off `gateways` with ON DELETE CASCADE.

| Table | Notes |
|---|---|
| `gateways` | `collector_id` UNIQUE, SET NULL (detached, like `infra_nodes`); mode, authoritative (+since, +by), enforcement (+changed_at), `pinned_hashes`, `agent_access`, `capabilities` (+at), `observed_hashes` (+at), `management_path`, `local_state_path`, `local_state_flush_seconds`, `head_revision`, `sync_state` |
| `gateway_sections` | UNIQUE (gateway, perch_id) and (gateway, config, section_name); scope, domain, `ownership`, `issue`, B/R/C, `base_revision`, `router_author`, `router_changed_at`, status, `conflict`, `drift_since`, `position` |
| `gateway_secrets` | UNIQUE (gateway, ref); `value` APP_KEY-encrypted, never serialised; `fingerprint` |
| `gateway_applies` | `apply_key` UNIQUE (wire applyId); kind, state, ops, base hashes, perch ids, `protected`, confirm mode and timeout, timestamps of each step, outcome, `replaced_router_content`, revision number |
| `gateway_revisions` | UNIQUE (gateway, number); source, author, router author, summary, note, snapshot, diff, hashes, `apply_id`, **`confirmed_at`** |
| `gateway_config_events` | audit (event names in `GATEWAY_EVENTS`), INDEX (gateway, created_at) and (created_at) |
| `gateway_networks` | Perch-only network metadata keyed by the interface's perch_id |
| `gateway_network_samples` | PK (gateway, network, recorded_at); pruned with `router_samples` |
| `device_network_latest` | PK (gateway, mac); written on change only |

**Revisions and the rejoin offer** (README 3.7). `confirmed_at` is set when the state is known to
work on the router: a confirmed apply, or a router state reported by a live agent. A gateway that
is reset and re-joined is offered the newest confirmed revision (`rejoinOffer`), never simply the
newest one. `planRestore` turns a snapshot into C values; applying stays a separate step.

**Retention.** The daily prune task also runs `pruneGatewayConfigHistory`: events older than
`auditRetentionDays`, and revisions beyond the newest `keepRevisions` per gateway, always keeping
the newest confirmed one. Sections keep their own B, so pruning never breaks a merge.

**`collectors:merge`.** `gateways` is in `NON_HISTORY_TABLES`. Only the removed side has one: it
moves to the survivor. Both have one: the one with more revisions stays bound (a tie keeps
`into`'s), the other is detached with its history. `collectors:purge` detaches it (SET NULL).

## 11. Settings

`GET` / `PATCH /api/v1/settings/gateway` (admin-only), `system_settings` key `gateway_config`,
normalised and clamped like Settings → Presence. Response `{ settings, defaults, limits,
choices: { confirmMode } }`; a PATCH takes any subset, 422 outside the limits.

| Setting | Default | Range |
|---|---|---|
| `confirmTimeoutSeconds` | 90 | 30–600 (capped again by the router's `config_confirm_max`) |
| `managementConfirmTimeoutSeconds` | 300 | 60–1800 (protected jobs, README 3.8) |
| `confirmMode` | `admin_and_agent` | `agent`, `admin_and_agent` |
| `queueExpiryHours` | 24 | 1–168 |
| `watchSeconds` | 30 | 10–600 |
| `importDebounceSeconds` | 5 | 1–60 |
| `authoritativeRevertDelaySeconds` | **90** | 0–3600 (README 7.3) |
| `enforcementMaxFailures` | 2 | 1–10 |
| `enforcementWindowMinutes` | 60 | 10–1440 |
| `keepRevisions` | 500 | 50–10000 |
| `auditRetentionDays` | 730 | 30–3650 |
| `allowInsecureTransport` | false | controller half of the plain-HTTP write opt-in (README 7.1) |
| `localStatePath` | `/etc/perch-collector/state` | absolute path, plain segments (README 7.18) |
| `localStateFlushSecondsFlash` | 300 | 30–86400: snapshot interval on SPI/NAND flash (batched) |
| `localStateFlushSecondsDisk` | 0 | 0–86400: eMMC, USB, SATA; 0 = write-through |

`resolveLocalState(settings, gateway, storageKind)` gives the path and flush interval a gateway
uses: its own override (`gateways.local_state_path` / `local_state_flush_seconds`), else the
setting, the interval by the storage class the agent reports (unknown counts as flash). Grants are
always written immediately; only counters are batched. `confirmTimeoutFor(settings, {protected,
routerMaxSeconds})` gives an apply's confirm window.

### 11.1 Security notes

- Secrets never leave the router in the clear: the agent reports `hmac:<hex16>` =
  `"hmac:" + first 16 hex digits of HMAC-SHA256(api_key, "<config>.<section>.<option>=<value>")`;
  the controller computes the same for a value it sets and compares fingerprints only. Values the
  controller sets are write-only in the API, encrypted at rest, and sent only inside an apply over
  a secure session.
- A compromised controller in `managed` mode can rewrite the router's allowlisted configs. It
  cannot read secrets, touch the excluded configs, run commands or act on a router that left
  `config_access` at `none` or `read`. Rollback is a safety net for mistakes, not a security
  control.
