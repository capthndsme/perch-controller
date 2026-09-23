# Managed gateway: the config plane (controller side)

Status: built through work packages S1–S4 (2026-09-23): data layer and pure core, the agent
wiring on the collector socket, the per-gateway serial queue, the apply lifecycle, Authoritative
Mode's enforcement, pairing for plain HTTP, and the REST API with the first domains (DHCP
reservations, DNS names). M7 added the firewall domain and the persisted order of ordered types
(docs/gateway/firewall.md). Networks (section 8, S5: the `networks` and `dhcp_pools` domains, the
networks REST, per-network accounting) are `networks.md`. M11 (plan 2 phase 4: `system`, `routes`,
`dns_settings`, `dhcp_tags`, DHCP options, per-feature "in sync" checks) is `native-sync.md`.

The collector on an OpenWrt router becomes a managed gateway: controller edits apply to the
router's native UCI config, and router edits (LuCI, `uci`, ssh) flow back. This document is the
controller-side contract: model, merge rules, storage, settings and the extension point for
feature domains. The router side (UCI access, apply/confirm/rollback on the agent, the protocol on
the `perch-collector.v1` socket) is specified with the collector.

Placeholders only: 192.168.x.x, example.com, MACs `02:00:00:…`.

Code: `app/services/gateway_config/` (pure, no I/O unless noted), models `app/models/gateway*.ts`.

Section numbers follow plan 1 of the design (and the code comments cite them): 2 model, 5 sync,
4 the agent protocol as the controller uses it, 6 services and applying, 7 domains, 9 storage,
10 REST, 11 settings and security. The router side (plan 1 section 3) is perch-collector's
`ARCHITECTURE.md`; section 8 (networks) is `networks.md`.

| File | Role |
|---|---|
| `types.ts` | shared types and string unions (section content, ownership, statuses, apply ops, capabilities) |
| `canonical.ts` | canonical form, equality under domain rules, diffs |
| `secrets.ts` | fingerprints, redaction, secret refs, wire form of secrets |
| `domain.ts` | `ConfigDomain`, `DomainRegistry`, excluded configs, apply order, edits, round-trip harness |
| `sync_engine.ts` | three-way merge, conflicts, drift, reconciling a read, statuses, the "in sync" predicate, state machines |
| `apply_plan.ts` | ops of an apply job, management-path split, ledger, `editSections` core |
| `revisions.ts` | snapshots, diffs, rejoin offer, pruning selection, restore |
| `domains/` | the registry's domains: `dhcp_hosts.ts` (the sample), `dns_records.ts`, `dhcp_pools.ts`, `networks.ts`, `firewall.ts`, and M11's `system.ts`, `routes.ts`, `dns_settings.ts`, `dhcp_tags.ts` (native-sync.md) |
| `observed_facts.ts` | the observation parts the per-feature checks read (DB) |
| `network_model.ts`, `networks_service.ts` | networks from sections, network edits, the networks REST (`networks.md`) |
| `gateway_config_settings.ts` | Settings → Gateway (DB) |
| `config_retention.ts` | pruning of events and revisions (DB) |
| `serial_queue.ts` | the per-gateway serial queue (6.6) |
| `gateway_registry.ts` | gateway rows, hello parsing, session context, `agent.configure` block, write access (4.1, 4.3) |
| `gateway_agent.ts` | requests (signed when needed), capabilities, reads and their merge (DB) |
| `gateway_plane.ts` | the socket hooks: hello, notifications, pushes (4.1) |
| `apply_lifecycle.ts` | jobs, confirm, results, the tick, enforcement, package jobs (6.1–6.5) |
| `gateway_config_service.ts` | admin operations: modes, Authoritative Mode, sync status, conflicts, drift, scope, drafts, restore, bind, and `editSections` |
| `gateway_store.ts` | loading and saving rows, revisions, the `sync_state` rollup (DB) |
| `rpc_signing.ts`, `pairing_crypto.ts`, `pairing.ts` | the signed envelope, pairing crypto and state machine (4.3, 4.4) |
| `device_names.ts` | reservations, DNS records, label names (10.3) |
| `section_order.ts`, `order_store.ts` | the order of ordered types (5.7; firewall.md section 3) |
| `firewall_service.ts`, `post_actions.ts` | the firewall REST layer and work once a job is live (firewall.md) |
| `events.ts`, `errors.ts` | the audit log, REST refusals |

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

## 4. The agent protocol, as the controller uses it

The router side is specified with the collector (perch-collector
`ARCHITECTURE.md`, "The config plane" and "Writes"); this is how the
controller drives it. Code: `gateway_plane.ts` (socket hooks),
`gateway_registry.ts` (rows, session context, write access),
`gateway_agent.ts` (requests, reads), `apply_lifecycle.ts` (jobs),
`pairing.ts` + `pairing_crypto.ts` (4.4), `rpc_signing.ts` (4.3).

### 4.1 Gateway rows and the session

- **Rows.** Every adopted collector that is a gateway gets a `gateways` row in
  mode `off`: its hello lists `gateway_config`, `gateway_stats`, `observe.*`,
  `gateway.*` or `net.conntrack_flush`, or it reports gateway stats
  (`last_status.gateway`). Created at the hello, at adoption, and lazily by
  `GET /gateways`. `gateways.id` is the canonical `:id` of every
  `/api/v1/gateways/:id/…` route (orchestrator decision 2026-09-23; the
  observation routes move to it). Helpers for other services:
  `gatewayForCollector(collectorId)`, `resolveGateway(id)`.
  `capabilities.capable` says whether the collector has the config plane.
- **Hello.** `collector_agent_gateway.ts` hands the raw `gatewayConfig` block
  to `prepareGatewayHello` right after registering the session and **before**
  `agent.configure`, so the configure carries the gateway's block. The block
  (`access`, `accessConfigured`, `transportOk`, `hashes`, `apply`, `results`,
  `signing {required, challenge, key, keyId?, windowSeconds}`, `management
  {network, device, controllerAddress, reportedAt}`) is kept in memory per live
  session (dropped when it closes) and copied onto the row (`agent_access`,
  `capabilities`, `management_path`). In the background (`afterGatewayHello`,
  in the gateway's queue): the pairing is checked against `signing` (4.4); the
  `results` are settled and acked; a pending apply's fresh session is noted
  (6.2); `gateway.capabilities` is fetched when the collector has the plane;
  and, unless the mode is `off`, the configs are read when the hello's hashes
  differ from the last observed ones.
- **`agent.configure`** gains `gatewayConfig: {mode, authoritative,
  watchSeconds, debounceSeconds}` for collectors with a gateway row and the config plane (mode `off`
  while the collector is not adopted and enabled). Sent again on a mode or
  Authoritative change, and to online gateways when Settings → Gateway changes.
  The agent needs mode `managed` on the session before an apply or install.
- **Notifications.** `gateway.config.changed`: a router edit is read and merged
  with its author (`{kind, user?, via}`); `origin: "perch"` only moves the
  observed hashes. `gateway.config.result`: an apply's outcome (6.3), acked,
  then a read. `gateway.pair.state`: 4.4. Every accepted `collector.push` is
  the agent half of a confirm (6.2).

### 4.2 Requests the controller sends

| Method | When | Timeout |
|---|---|---|
| `gateway.capabilities` | after each hello (plane collectors), refresh, before entering managed, after a package job | 10 s |
| `gateway.config.read` `{}` | mode ≠ off: hello with moved hashes, change notification, mode change, `sync-status?fresh=1`, refresh, after a confirm or a result, `stale_base` | 10 s |
| `gateway.config.apply` | a job (6.1); `dryRun: true` for `POST …/applies {dryRun}` | 30 s |
| `gateway.config.confirm` `{applyId}` | on the fresh session, once the confirm mode is satisfied (6.2) | 10 s |
| `gateway.config.rollback` `{applyId}` | `POST …/applies/:applyId/revert` of a pending job | 10 s |
| `gateway.config.ack` `{applyIds}` | after settling a result | 10 s |
| `gateway.package.install` `{applyId, packages, confirmTimeoutSeconds?, dryRun?}` | `POST …/packages` (6.5) | 6 min |
| `gateway.pair.begin` / `.reveal` / `.status` / `.cancel` / `.forget` | pairing (4.4) | 10 s |

Apply params as sent: `{applyId, kind, dryRun, base, ops, ledger, protected?,
confirmTimeoutSeconds, secrets?}`. `applyId` is `g<gatewayId>-<12 hex>`.
`base` names the hash of **every config an op touches** (`""` when the router
has no file). `adopt` ops carry the section's `domain`. `secrets` (the values
of `{"$secret": ref}`) only over verified TLS; a job that needs them on a
signed session fails with `insecure_transport`.

**A read is validated whole** (section 11: ≤ 2 MiB, ≤ 2000 sections, values ≤
4 KiB, names `^[A-Za-z0-9_]{1,64}$`, types `^[A-Za-z0-9_-]{1,32}$`); anything
over is refused with a `read_refused` event and nothing is stored.

### 4.3 Writes: verified TLS, or both opt-ins and a pairing (README 7.1, decision 29)

`writeAccess(gateway, settings)` decides per request:

| Case | Result |
|---|---|
| agent offline | `offline` |
| collector without the plane | `no_capability` |
| router `config_access` ≠ `write` | `router_access` |
| session over TLS (`connection.secure === true`, `transport_security.ts`) **and** the agent's `transportOk` | writable, unsigned |
| otherwise, without the controller's `allowInsecureTransport` or the router's `config_allow_insecure` (`capabilities.allowInsecure`) | `insecure_transport` |
| otherwise, router signs with `config_sign_key` and the admin entered it | writable, signed with that key |
| otherwise, a live pairing whose `keyId` the router's `signing` block names | writable, **signed with the paired key** |
| otherwise | `not_paired` (a `config_sign_key` router without the key: `sign_key_unknown`) |

`null` security (a trusted proxy without `X-Forwarded-Proto`) is not secure.
The api_key is never a signing key: it is the socket's bearer token, which a
plain-HTTP listener sees. Signed methods: `gateway.config.apply`, `.confirm`,
`.rollback`, `.ack`, `gateway.package.install`, `gateway.pair.forget`. The
envelope (perch-collector `sign.go`):

```json
{"payload":"<the method's params as a JSON string>",
 "sig":{"v":1,"ts":<unix seconds>,"nonce":"<32 hex>","challenge":"<the session's hello challenge>","mac":"<64 hex>"}}
```

`mac` = hex HMAC-SHA256(key, `"perch-config-sig-v1\n" + method + "\n" +
challenge + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(payload))`). A
`stale_signature` refusal (`data.agentTime`) is retried once with the agent's
clock. Test vector (shared with the agent): key `k`, method
`gateway.config.confirm`, challenge `c0ffee`, ts 1790000000, nonce
`nonce-0000000001`, payload `{"applyId":"a1"}` → mac
`2ae21083603b5bf27157bf935395c42b2d4c607e8d6b93cf3abe9ba59d7b7e9e`.

### 4.4 Pairing (owner decision 29): signing keys for plain HTTP

A plain-HTTP gateway (with both opt-ins) is paired once: controller and
router agree on a 32-byte key over the socket, both show a 6-digit code, the
admin types the router's code on the controller **and** confirms on the
router. TLS gateways need no pairing (`pairing_not_needed`).

**Crypto** (`pairing_crypto.ts`; hex = lowercase, keys and nonces 32 bytes):

- X25519 key pairs; a shared secret of all zeros (low-order key) is refused.
- `commitment = HMAC-SHA256(key = routerNonce, "perch-pair-commit-v1" ‖ routerPub ‖ controllerPub)`
- `key = HKDF-SHA256(ikm = X25519 shared, salt = controllerNonce ‖ routerNonce, info = "perch-config-sign-v1:" + gatewayId (decimal), L = 32)`
- `SAS = uint32_be(SHA-256("perch-pair-sas-v1" ‖ controllerPub ‖ routerPub ‖ controllerNonce ‖ routerNonce ‖ gatewayId (decimal))[0:4]) mod 1 000 000`, as 6 digits with leading zeros
- `keyId = hex(SHA-256("perch-pair-keyid-v1" ‖ key))[0:16]`

The router commits to its nonce before it learns the controller's (the
owner's sketch without it lets a man in the middle grind its own nonce until
both codes agree; with it, one guess in 10^6, as in Bluetooth numeric
comparison).

**Pinned vector** (RFC 7748 section 6.1 keys; cross-checked in Go):

| | |
|---|---|
| controller private | `77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a` |
| controllerPub | `8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a` |
| router private | `5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb` |
| routerPub | `de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f` |
| shared | `4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742` |
| gatewayId, controllerNonce, routerNonce | `7`, `11`×32, `22`×32 |
| commitment | `ff24b3e804967019f7662f53a2499f330b0c5fc227540479bcecea5dc678e9c4` |
| key | `6ab9f1d40416ea38eb9b448cecef75bc2ab631a5940225c5fd80df386f1edacb` |
| SAS | `331510` |
| keyId | `38545dab8f16e8a2` |

**RPCs** (server → agent requests, unsigned unless noted; errors -32000 with
`data.error`):

| Method | Params | Result | Router side |
|---|---|---|---|
| `gateway.pair.begin` | `{pairingId: "<16 hex>", gatewayId: number, controllerPub}` | `{pairingId, routerPub, commitment, expiresAt}` | needs access `write` (`not_managed`), `config_allow_insecure '1'` (`insecure_transport`), not verified TLS (`pairing_not_needed`); one pairing at a time (a new begin replaces an unfinished one) |
| `gateway.pair.reveal` | `{pairingId, controllerNonce}` | `{pairingId, routerNonce}` | derives key and SAS; shows the SAS (`perch-collector pair status`, logread) and waits up to 10 min for the local confirm; `unknown_pairing` |
| `gateway.pair.status` | `{pairingId}` | `{pairingId, state: "waiting_local"\|"paired"\|"expired"\|"cancelled"\|"unknown", keyId?}` | |
| `gateway.pair.cancel` | `{pairingId}` | `{pairingId, state: "cancelled"}` | drops an unfinished pairing |
| `gateway.pair.forget` | `{keyId}`, **signed with that key** | `{state: "forgotten"}` | drops the paired key (only the paired controller can unpair) |

**Router-side confirm:** `perch-collector pair confirm <code>` (the code must
equal the router's SAS; the simplest safe local step: it needs a shell on the
router, like the `config_allow_insecure` opt-in). On success the router keeps
the key (flash, like the UCI credentials), verifies signed requests with it
from then on, sends the notification `gateway.pair.state {pairingId, state:
"paired", keyId}` (also `rejected`/`expired`/`cancelled`), and every hello's
`signing` says `{"key": "paired", "keyId": "<keyId>"}`. A factory reset loses
the key; the hello then says otherwise and the controller marks the pairing
`lost`.

**Controller states** (`gateways.pairing`, key in `gateways.pairing_key`,
APP_KEY-encrypted, never serialised):

```
none ─POST /pairing─► awaiting_confirmation ─admin types the code─► awaiting_router ─router confirms─► paired
                        │ router confirms first ─────────────────────► (admin types the code) ───► paired
                        ├ 10 min ─► expired      3 wrong codes ─► failed (router told: cancel)
paired ─hello without the key─► lost        any ─DELETE /pairing─► none (paired: forget, signed)
```

A pairing is refused while one is `paired` (`already_paired`: unpair first).
A re-bound gateway starts unpaired.

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

### 5.7 Order of ordered types

A domain's `orderedTypes` (firewall `rule`, `redirect`) have their order synced too: per (config,
type) `gateway_section_orders` keeps B and C as perch ids of the synced sections; R is the rows'
`position`. Imported two-way, `conflict` when both sides reordered differently, `drift` under
Authoritative Mode (reverted by a `revert` job with an `order` op after the grace delay), `ahead`
when only C moved. The planner places created members with a `position` on their `put` and adds an
`order` op (adopting the members it moves) when R would still differ from C. An order not in sync
is a sync-status blocker `{kind: 'order', …}` and counts in `sync_state`. Full rules:
docs/gateway/firewall.md section 3.

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
missing from the ledger), each with a `ConfigDiffEntry`; and per feature `feature` {feature,
objectId, code, message}: an ambiguous or duplicate section of a domain, or the domain's own
`inSync` check on observed facts (plan 2 section 4.6; native-sync.md section 6). A pending LuCI apply makes `inSync` false
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
- Conflicted sections are `blocked`; a `revert` job plans only drifted sections (and drifted
  orders, section 5.7).
- **Post actions** (`gateway_applies.post_actions`): work that runs once a job is live (the agent's
  fresh session and first push, or a confirm without a window), carried along a chain until it ran:
  the WAN block's `net.conntrack_flush` (firewall.md section 5).

`planSectionEdits` is the pure core of `gatewayConfig.editSections(gatewayId, userId, edits)`, the
single write entry point for domain REST handlers (`editDomainSections(gatewayId, userId, [{domain,
edits}, …])` does several domains as one draft change: planned in order against the evolving rows,
validated once, stored in one transaction; `editSections` is its one-domain form): it turns a domain's `SectionEdit`s into new C
values and new controller rows, refusing sections that are not synced, belong to another domain or
live in an excluded config.

### 6.1 The apply lifecycle (`apply_lifecycle.ts`)

```
queued ─agent online & writable─► sending ─pending_confirm─► pending_confirm ─confirm─► confirmed
  │ queueExpiryHours ► expired        │ applied / noop (ledger only) ───────────────────► confirmed
  │ admin revert ► cancelled          │ refused ► failed         deadline / admin revert / reboot ► rolled_back
                                      └ stale_base: read, merge, re-plan, send again (once)
```

- **One job at a time per gateway.** `POST …/applies` plans the draft
  (`planApply`), refuses when a job is open (`apply_in_flight`), when a
  requested section is in conflict (`conflicts_open`) or when a section the
  plan touches has a validation error (`invalid_config`; errors on sections
  the request does not change never block it), and queues the **first** job.
  It is sent at once when the agent is writable, else it waits `queued` (only
  when the agent is offline; any other write block is refused) and the 5 s
  tick sends it when the agent is back. A job is re-planned from the rows at
  send time (it may be stale): nothing left finishes it `cancelled`, a new
  conflict `failed`.
- **Chains.** After a job confirms, the next job of the same request (same
  section filter; the adopt job first, then the ordinary one, then the
  protected management-path one) is planned and sent, up to 5 jobs.
- **In flight.** The job's sections are `pending` (`reverting` for a revert);
  reads meanwhile keep the router's content on the row (`deferred`) and it is
  merged after the job resolves (a read follows every confirm and result).
- **Refusals** by the agent fail the job with `outcome.error` = the agent's
  code (`busy`, `not_owned`, `name_taken`, `foreign_staged`, `apply_failed`, …).
  An `apply_failed` with `data.rolledBack` settles like a rollback result.
  No reply (timeout, socket gone): the job stays `sending` and the agent's
  next hello decides (its `apply` block is the job: `pending_confirm`; its
  `results` hold it: settled; neither: `failed`, `no_answer`); after 120 s
  without either it fails.

### 6.2 Confirm: a fresh session, the first push on it, and the admin

1. The agent replies `pending_confirm` with its deadline and closes the
   session; the controller stores the deadline.
2. A hello on a session that started after the job was sent, whose `apply`
   block names the job, sets `agent_reconnected_at` (and the deadline again).
3. The first accepted `collector.push` on that session sets
   `agent_confirmed_at`.
4. Confirm mode (setting, per job): `agent` sends `gateway.config.confirm` now;
   `admin_and_agent` waits for "Keep changes" (`POST …/applies/:id/confirm`,
   which may come first). Queued jobs and reverts always use `agent`.
5. `{"state":"confirmed", hashes}`: B := R := what the job wrote, renamed
   adoptions take their new name, a revision with source `controller`
   (`revert` for enforcement) and `confirmed_at`, the ledger as the agent now
   has it. A confirm that failed on the wire is retried by the tick while the
   window is open. The agent refuses a confirm on the session the job came in
   on (`not_reconnected`).

### 6.3 Rollbacks and results

`gateway.config.result` (or the hello's `results`) with `outcome
rolled_back|failed`: the job is `rolled_back`/`failed` with `outcome.reason`
(`confirm_timeout`, `admin`, `reboot`, `commit_failed`, `reload_failed`,
`install_failed`), the rows get the router's pre-job content back and keep
their draft (C), and every section in `discarded` (router edits of the window
that the rollback undid) comes back as a conflict with `origin:
"rollback_discarded"` (section 5.2). Then `gateway.config.ack` and a read.
Without any result by the deadline plus 30 s, the controller assumes the
rollback (`outcome.assumed: true`); a result that arrives later still brings
its discarded edits.

### 6.4 The tick (`gatewayConfigTick`, every 5 s in the poll task)

Per managed gateway, in its queue: expire queued jobs past
`queueExpiryHours`; send queued jobs when the agent is writable; retry a
confirm; assume rollbacks past the deadline; fail unanswered sends; then
**Authoritative enforcement**: when enforcement is `active`, the agent
writable and no job open, the drifted sections whose grace delay
(`authoritativeRevertDelaySeconds`, default 90 s) elapsed go out in one
`revert` job (confirm mode `agent`); after a failed or rolled-back revert the
next one waits one more grace delay; `enforcementMaxFailures` failed or
rolled-back reverts inside `enforcementWindowMinutes` suspend enforcement
(`enforcement_suspended` event) until `POST …/enforcement/resume`.

### 6.5 Package jobs (README 7.7)

`POST …/packages {packages, dryRun?}` makes a job of kind `package`
(`gateway.package.install`, 6 min timeout), confirmed exactly like an apply;
a rollback removes what it installed. Names are checked against the router's
`installAllowlist` from capabilities (`package_not_allowed`); the agent checks
free flash (`insufficient_flash` with `freeBytes`, `needBytes`). After the
confirm the capabilities are fetched again (the new package versions).

### 6.6 The serial queue

`serial_queue.ts`: everything that changes one gateway's rows (reads,
merges, job steps, admin writes, the tick) runs one task at a time per
gateway, in-process; other gateways run in parallel. Re-entrant within a
task. Bounded: 64 waiting tasks per gateway (else 503 `gateway_busy`) and
1024 gateways; an entry is dropped when its last task ends.

### 6.7 Rejoin (README 3.7)

When the router's ledger comes back empty under a gateway whose ledger had
entries (a factory reset), or a detached gateway is bound to a collector
(`POST …/bind`), the gateway gets `rejoin_offer = {revision, reason:
"ledger_reset"|"rebound", detectedAt}` with the newest **confirmed** revision
from before the reset (the reset state itself is recorded as an import; it is
never the one offered). Restoring that revision (`POST
…/revisions/:number/restore`) puts it into the draft and clears the offer;
`POST …/rejoin/dismiss` drops it.

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
per section on import. Register domains in `domains/index.ts` (claim order = array order, which follows the apply
order: `system`, `networks`, `routes`, `dhcp_pools`, `dhcp_hosts`, `dns_records`, `dns_settings`,
`dhcp_tags`, `firewall`, `sqm`). A domain may add `inSync(sections, observed)`: its "in sync" check
on the agent's observed facts (native-sync.md section 6). A mirror a newly registered domain claims
is promoted to synced on the next read (native-sync.md section 1).
Perch-only metadata (labels, purposes) lives in each domain's own table keyed by `perch_id`, never
in UCI.

**Sample: `dhcp_hosts`** (`dhcp` config, `host` sections). Claims hosts with at least one
non-wildcard MAC and scalar `ip`/`name`/`dns`/`leasetime`. Owns `mac ip name dns leasetime`;
`duid hostid tag match_tag instance broadcast` and anything newer ride along as the router's.
Normalises MAC sets, lease times and the `dns` flag; identity keys `mac:<mac>` and
`duid:<duid>`. Validation: malformed MAC/IP/name/lease time, duplicate MAC or IP (also against
unmanaged hosts), the router's own address (errors), a duplicate name or an address outside every
LAN network (warnings). REST: the device page's reservation (10.3).

**`firewall`** (`firewall` config: `zone`, `forwarding`, `rule`, DNAT `redirect`, the
`perch_block_wan` ipset; ordered `rule`, `redirect`). Sections as verbatim objects, fw4's aliases
normalised, identity by zone name / forwarding pair / rule or redirect name (else a content
fingerprint), pre-flight with the management-path guard. Defaults, includes, `nat`, SNAT and other
ipsets are never claimed (observed only). Registered after the DHCP/DNS domains (networks and pools
go before it: apply order system → network → dhcp → firewall). docs/gateway/firewall.md.

**`dns_records`** (`dhcp` config, `domain` and `cname` sections; plan 2 section 4.2). Claims
records with scalar `name`/`ip` (`domain`) or `cname`/`target` (`cname`); owns those two options,
everything else rides along. Names and values normalised to lowercase; identity key
`cname:<name>` (a name may carry several address records). Validation: invalid names or values,
an alias whose name is taken by another alias or an address record, an alias pointing at itself.
Reserved names are refused by the REST layer (10.3), never by validation, so an odd record
imported from the router never blocks other applies.

## 9. Storage

Migrations `1779000000048`–`051`; the firewall's `090`–`092` (firewall.md section 8:
`gateway_section_orders`, `gateway_applies.post_actions`, `gateway_wan_blocks`). JSON columns are text parsed by the models (`jsonColumn`,
listed in `database/schema_rules.ts`). Only `gateways` references `collectors`; everything else
hangs off `gateways` with ON DELETE CASCADE.

| Table | Notes |
|---|---|
| `gateways` | `collector_id` UNIQUE, SET NULL (detached, like `infra_nodes`); mode, authoritative (+since, +by), enforcement (+changed_at), `pinned_hashes`, `agent_access`, `capabilities` (+at), `observed_hashes` (+at), `management_path`, `local_state_path`, `local_state_flush_seconds`, `head_revision`, `sync_state`; since 051 `observed_ledger` and `observed_state` (the last read's ledger and `{luciPending, uncommitted, readAt}`), `rejoin_offer`, `dns_label_names` (`off`/`review`), `config_sign_key` and `pairing_key` (APP_KEY-encrypted), `pairing` (JSON state) |
| `gateway_sections` | UNIQUE (gateway, perch_id) and (gateway, config, section_name); scope, domain, `ownership`, `issue`, B/R/C, `base_revision`, `router_author`, `router_changed_at`, status, `conflict`, `drift_since`, `position` |
| `gateway_secrets` | UNIQUE (gateway, ref); `value` APP_KEY-encrypted, never serialised; `fingerprint` |
| `gateway_applies` | `apply_key` UNIQUE (wire applyId); kind, state, ops, base hashes, perch ids, `protected`, confirm mode and timeout, timestamps of each step, outcome, `replaced_router_content` (the router's content before the job, every kind), revision number; since 051 `agent_confirmed_at`, `written`, `ledger`, `secret_refs`, `configs`, `changes`, `chain_perch_ids`, `chain_step`, `retried`, `signed`, `packages`; `kind` also `package` |
| `gateway_revisions` | UNIQUE (gateway, number); source, author, router author, summary, note, snapshot, diff, hashes, `apply_id`, **`confirmed_at`** |
| `gateway_config_events` | audit (event names in `GATEWAY_EVENTS`), INDEX (gateway, created_at) and (created_at) |
| `gateway_networks` | Perch-only network metadata keyed by the interface's perch_id, else (052) by network name |
| `gateway_network_samples` | PK (gateway, network, recorded_at); pruned with `router_samples` |
| `device_network_latest` | PK (gateway, mac); written on change only |
| `device_network_history`, `gateway_scope_changes` | (052) a MAC's network intervals; the accounting scope rule's changes (`networks.md` 4) |

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

## 10. REST API

All under `/api/v1`, `{ data }` envelopes, refusals `{ error, message, …data }`
with the status below, Vine errors 422 `{ errors: [...] }`. `:id` is
`gateways.id`. **Reads: any signed-in user. Writes: admin** (403
`admin_required`); anonymous 401. Step-up (the admin's `currentPassword`):
entering `managed`, Authoritative Mode ON, starting a pairing, setting a sign
key. The observation routes (`docs/gateway/observation.md`: `observation`,
`dhcp/leases`, `neighbors`, `interfaces`, `upnp`, `wan-status`, `system`,
`wireguard`, `observe`, `backups`) share the prefix. Paged lists take
`?limit=` (1–200, default 50) and `?before=` and answer `{ items, nextBefore }`
(`nextBefore` null on the last page).

Refusals common to many routes: 404 `gateway_not_found`; 409 `agent_offline`;
504 `agent_timeout`; 503 `gateway_busy` (serial queue full); 502 with the
agent's code for odd agent answers.

### 10.1 Types

```ts
type Gateway = {
  id: number; collectorId: number | null; name: string; detached: boolean
  online: boolean; secure: boolean | null          // the live session's TLS flag
  mode: 'off' | 'observe' | 'managed'; authoritative: boolean; authoritativeSince: string | null
  enforcement: 'active' | 'suspended'
  agentAccess: 'none' | 'read' | 'write' | null; agentAccessConfigured: 'none' | 'read' | 'write' | null
  transportOk: boolean | null; allowInsecure: boolean | null   // router: verified TLS; config_allow_insecure
  writable: boolean; signedWrites: boolean
  writeBlockedReason: 'offline' | 'no_capability' | 'router_access' | 'insecure_transport'
                    | 'not_paired' | 'sign_key_unknown' | null
  signingKey: 'paired' | 'config_sign_key' | 'api_key' | null   // what the router verifies with
  hasSignKey: boolean                                           // a config_sign_key is stored
  pairing: GatewayPairing | null
  syncState: 'unknown' | 'in_sync' | 'ahead' | 'conflict' | 'drift' | 'applying'
  counts: { synced: number; excluded: number; unmodeled: number; ahead: number; conflicts: number; drift: number }
  headRevision: number; observedAt: string | null; luciPending: boolean; uncommitted: string[]
  pendingApply: GatewayApply | null
  rejoinOffer: { revision: number; reason: 'ledger_reset' | 'rebound'; detectedAt: string } | null
  dnsLabelNames: 'off' | 'review'
  domains: Array<{ key: string; configs: string[] }>
  // GET /gateways/:id only:
  capabilities?: object | null; capabilitiesAt?: string | null
  managementPath?: { network: string | null; device: string; controllerAddress?: string; reportedAt?: string } | null
  observedHashes?: Record<string, string>
}
type GatewayPairing = {
  state: 'awaiting_confirmation' | 'awaiting_router' | 'paired' | 'lost' | 'expired' | 'failed'
  pairingId: string; keyId: string
  sas: string | null            // the 6-digit code, while awaiting a confirmation
  startedAt: string; expiresAt: string
  adminConfirmedAt: string | null; routerConfirmedAt: string | null; pairedAt: string | null
  attemptsLeft: number; reason: string | null
}
type SectionContent = { type: string; options: Record<string, string | string[]>
  secrets: Record<string, { fingerprint: string; setByController: boolean }> }
type GatewaySection = {
  perchId: string; config: string; section: string; type: string; anonymous: boolean
  scope: 'synced' | 'excluded' | 'unmodeled'; domain: string | null
  issue: 'ambiguous' | 'no_round_trip' | 'duplicate' | null
  ownership: { kind: 'options'; options: string[]; items?: Record<string, string[]> } | null  // null = whole section
  status: 'in_sync' | 'ahead' | 'pending' | 'conflict' | 'drift' | 'reverting'
  router: SectionContent | null; desired: SectionContent | null; base: SectionContent | null
  baseRevision: number | null
  routerAuthor: { kind: 'luci' | 'cli' | 'perch' | 'unknown'; user?: string; via?: 'trigger' | 'poll'; applyId?: string } | null
  routerChangedAt: string | null
  conflict: { kind: 'options' | 'delete_vs_edit' | 'type' | 'order'
              options: Array<{ name: string; base: unknown; router: unknown; controller: unknown }>
              detectedAt: string; origin?: 'merge' | 'rollback_discarded'; discarded?: object | null } | null
  driftSince: string | null; revertAt: string | null   // authoritative: when the revert is due
  position: number | null; updatedByUserId: number | null; updatedAt: string | null
}
type GatewayApply = {
  id: string                       // the wire applyId
  kind: 'apply' | 'revert' | 'adopt' | 'package'
  state: 'queued' | 'sending' | 'pending_confirm' | 'confirmed' | 'rolled_back' | 'failed' | 'expired' | 'cancelled'
  confirmMode: 'agent' | 'admin_and_agent'; confirmTimeoutSeconds: number
  protected: boolean; signed: boolean
  deadlineAt: string | null
  confirmations: { agent: string | null; admin: string | null }
  agentReconnectedAt: string | null
  requestedBy: { id: number; email: string } | null
  requestedAt: string; sentAt: string | null; finishedAt: string | null; queueExpiresAt: string | null
  note: string | null
  outcome: { reason?: string; error?: string; message?: string; discardedConfigs?: string[]; assumed?: true } | null
  revision: number | null; perchIds: string[]; configs: string[]
  changes?: ConfigDiffEntry[]      // detail, create, and apply-starting writes
}
type GatewayRevision = {
  number: number; source: 'import' | 'router' | 'controller' | 'merge' | 'revert' | 'rollback'
  author: { id: number; email: string } | null; routerAuthor: GatewaySection['routerAuthor']
  summary: string; note: string | null; createdAt: string; confirmedAt: string | null; applyId: string | null
  diff?: ConfigDiffEntry[]                                    // detail
  snapshot?: Array<{ perchId: string; config: string; section: string; domain: string | null
                     content: SectionContent }>             // detail with ?snapshot=1
}
type GatewayEvent = { id: number; event: string; user: { id: number; email: string } | null
  applyId: string | null; revision: number | null; detail: object | null; createdAt: string }
```

`ConfigDiffEntry` and `SyncStatus`/`SyncBlocker` are sections 5.4 and the
types of `types.ts` (`{perchId, config, section, type, domain, action:
create|update|delete|adopt|order, options: [{name, before, after, secret?}]}`).
Event names: `GATEWAY_EVENTS` in `types.ts`.

### 10.2 Gateways and the config plane

| Method, path | Request | Response `data` | Refusals |
|---|---|---|---|
| `GET /gateways` | – | `Gateway[]` | – |
| `GET /gateways/:id` | – | `Gateway` (with the detail fields) | 404 |
| `PATCH /gateways/:id` | `{ mode?, authoritative?, expectRevision?, currentPassword? }` | `Gateway` | 403 `invalid_password`; 409 `agent_offline`, `router_access_insufficient`, `insecure_transport`, `not_paired`, `no_capability`, `apply_in_flight` (leaving managed with a job open), `not_managed`, `not_in_sync` {blockers}, `sync_changed` {blockers, headRevision}; 422 `expect_revision_required` |
| `POST /gateways/:id/bind` | `{ collectorId }` | `Gateway` (mode off, rejoin offered) | 404 `collector_not_found`; 409 `not_detached`, `collector_has_gateway` {gatewayId} |
| `POST /gateways/:id/refresh` | – | `{ capabilities, observedAt, changedConfigs }` | 409 `agent_offline`, `mode_off` |
| `GET /gateways/:id/sync-status?fresh=0\|1` | – | `SyncStatus` | 409 `agent_offline` (fresh) |
| `GET /gateways/:id/sections?config=&scope=&status=&domain=` | – | `GatewaySection[]` | – |
| `GET /gateways/:id/sections/:perchId?limit=&before=` | – | `{ section: GatewaySection, history: { items: Array<GatewayRevision & { change: ConfigDiffEntry }>, nextBefore } }` | 404 `section_not_found` |
| `PATCH /gateways/:id/sections/:perchId` | `{ scope: 'synced' \| 'excluded' }` | `GatewaySection` | 404; 409 `unmodeled`, `pending_apply`, `not_on_router` |
| `POST /gateways/:id/sections/resolve` | `{ items: [{ perchId, take: 'router'\|'controller'\|'custom', options?: { [name]: string \| string[] \| null } }] }` | `{ sections: GatewaySection[] }` | 409 `not_managed`, `nothing_to_resolve`; 422 `resolution_incomplete` {perchId, options} |
| `GET /gateways/:id/draft` | – | `{ changes: ConfigDiffEntry[], jobs: [{kind, protected, configs, perchIds}], issues: Issue[], blockedByConflicts: string[] }` | – |
| `DELETE /gateways/:id/draft` | `{ perchIds? }` | `{ discarded: number }` | – |
| `POST /gateways/:id/applies` | `{ perchIds?, dryRun?, confirmMode?, note? }` | 202 `GatewayApply` (with `changes`; `queued` when offline); dry run 200 `{ changes, agentChanges, issues }` | 409 `not_managed`, `apply_in_flight` {applyId}, `conflicts_open` {perchIds}, `nothing_to_apply`, `router_access_insufficient`, `insecure_transport`, `not_paired`, `agent_offline` (dry run); 422 `invalid_config` {issues} |
| `GET /gateways/:id/applies?state=&limit=&before=` | – | `{ items: GatewayApply[], nextBefore }` | – |
| `GET /gateways/:id/applies/:applyId` | – | `GatewayApply` with `changes` | 404 `apply_not_found` |
| `POST /gateways/:id/applies/:applyId/confirm` | – | `GatewayApply` ("Keep changes") | 404; 409 `not_pending`; 410 `deadline_passed` |
| `POST /gateways/:id/applies/:applyId/revert` | – | `GatewayApply` (pending: the router rolls back now, the result follows; queued: `cancelled`) | 404; 409 `not_revertible`, `agent_offline` |
| `GET /gateways/:id/revisions?limit=&before=` | – | `{ items: GatewayRevision[], nextBefore }` | – |
| `GET /gateways/:id/revisions/:number?snapshot=1` | – | `GatewayRevision` with `diff` (and `snapshot`) | 404 `revision_not_found` |
| `POST /gateways/:id/revisions/:number/restore` | – | `{ perchIds, changes }` (C := the snapshot; apply separately) | 404; 409 `not_managed`, `conflicts_open`, `apply_in_flight` |
| `POST /gateways/:id/rejoin/dismiss` | – | `Gateway` | – |
| `POST /gateways/:id/drift/accept` | `{ perchIds? }` | `{ accepted: string[] }` (C := B := R, revision `router`) | 409 `no_drift` |
| `POST /gateways/:id/drift/revert-now` | `{ perchIds? }` | 202 `GatewayApply` (a `revert` job) | 409 `not_managed`, `no_drift`, `enforcement_suspended`, `apply_in_flight`, `agent_offline`, `insecure_transport` |
| `POST /gateways/:id/enforcement/resume` | – | `Gateway` | – |
| `GET /gateways/:id/events?limit=&before=` | – | `{ items: GatewayEvent[], nextBefore }` | – |
| `POST /gateways/:id/packages` | `{ packages: string[1..16], dryRun?, note? }` | 202 `GatewayApply` (kind `package`); dry run 200: the agent's reply (`install`, `alreadyInstalled`, `needBytes`, `freeBytes`, `manager`) | 409 `not_managed`, `package_not_allowed` {packages}, `apply_in_flight`, write blocks; 422 `invalid_packages` |
| `GET /gateways/:id/pairing` | – | `{ pairing: GatewayPairing \| null }` | – |
| `POST /gateways/:id/pairing` | `{ currentPassword }` | `{ pairing }` (`awaiting_confirmation` with `sas`) | 403 `invalid_password`; 409 `agent_offline`, `router_access_insufficient`, `pairing_not_needed`, `insecure_transport` (controller opt-in off), `already_paired`, the router's code (`insecure_transport`, `not_managed`, …); 502 `pairing_malformed`, `pairing_commitment_mismatch` |
| `POST /gateways/:id/pairing/confirm` | `{ code: '######' }` (the router's code) | `{ pairing }` (`awaiting_router` or `paired`) | 409 `no_pairing` {state}; 422 `pairing_code_mismatch` {attemptsLeft} (the third ends it: `failed`) |
| `DELETE /gateways/:id/pairing` | – | `{ pairing: null }` | – |
| `PUT /gateways/:id/sign-key` | `{ key (16–512), currentPassword }` | `Gateway` (`hasSignKey`) | 403 `invalid_password` |
| `DELETE /gateways/:id/sign-key` | – | `Gateway` | – |

`PATCH /gateways/:id` with `authoritative: true` runs section 5.4 in the
queue: a fresh read, the blockers, `expectRevision` = the `headRevision` the
admin reviewed, then the flag in one transaction with the row locked, then
`agent.configure`. Turning it off is always allowed and re-reads (drifted
sections import as two-way edits). Leaving `managed` turns it off too.

### 10.3 Device page and DNS (README M3: the first domains)

Writes put the change into the draft through `editSections` (an edit that
leaves a validation error on a section it touches is refused, 422
`invalid_config` {issues}) and, unless `?apply=0`, start an apply of exactly
those sections. The response then carries `apply: GatewayApply | null` and
`applyError: { error, message } | null` (why the apply did not start, e.g.
`apply_in_flight`; the draft is kept).

```ts
type DhcpReservation = { perchId: string; section: string; macs: string[]; ip: string | null
  hostname: string | null; publishDns: boolean; leaseTime: string | null; deny: boolean
  owner: 'perch' | 'router'; status: GatewaySection['status']; scope: GatewaySection['scope']
  applied: boolean; conflict: boolean; driftSince: string | null }
type DnsRecord = { perchId: string; section: string; type: 'a' | 'cname'; name: string; value: string
  owner: 'perch' | 'router'; status: string; applied: boolean }
type PendingLabelName = { mac: string; label: string; slug: string; current: string | null
  perchId: string | null; blocked: 'reserved' | 'router_owned' | null }
```

| Method, path | Request | Response `data` | Refusals |
|---|---|---|---|
| `GET /devices/:mac/reservation?gatewayId=` | – | `{ gatewayId, reservation: DhcpReservation \| null, dnsName: string \| null, lease: { ipv4, hostname } \| null }` | 400 `invalid_mac`; 404 `gateway_not_found` (none managed); 409 `gateway_ambiguous` {gatewayIds}, `not_managed` |
| `PUT /devices/:mac/reservation[?apply=0]` | `{ gatewayId?, ip: 'current' \| string \| null, hostname?: string \| null, publishDns?, leaseTime?: string \| null }` | `{ gatewayId, object: DhcpReservation, issues, apply, applyError }` | as above, plus 409 `dhcp_host_exists` {perchId, owner: 'router'}, `device_no_lease` (`ip: 'current'`); 422 `dhcp_ip_invalid`, `dhcp_host_empty` (no ip and no name), `dns_name_invalid`, `dns_name_reserved`, `invalid_config` |
| `DELETE /devices/:mac/reservation[?apply=0]` | `{ gatewayId? }` | `{ gatewayId, object: null, issues, apply, applyError }` | 404 `dhcp_reservation_not_found` |
| `GET /gateways/:id/dns` | – | `{ labelNames: 'off' \| 'review', records: DnsRecord[], names: [{perchId, hostname, ip, macs, owner}], reserved: string[], pendingLabelNames: PendingLabelName[] }` | – |
| `PATCH /gateways/:id/dns` | `{ labelNames: 'off' \| 'review' }` | as GET | – |
| `POST /gateways/:id/dns/records[?apply=0]` | `{ type: 'a' \| 'cname', name, value }` | 201 `{ object: DnsRecord, issues, apply, applyError }` | 409 `not_managed`, `dns_name_taken`; 422 `dns_name_invalid`, `dns_name_reserved`, `dns_value_invalid`, `invalid_config` |
| `PATCH /gateways/:id/dns/records/:perchId[?apply=0]` | `{ name?, value? }` | `{ object, issues, apply, applyError }` | 404 `dns_record_not_found`; 409 `not_synced`; 422 as above |
| `DELETE /gateways/:id/dns/records/:perchId[?apply=0]` | – | `{ object: null, issues, apply, applyError }` | 404 |
| `GET /gateways/:id/dns/label-names` | – | `{ policy, pending: PendingLabelName[] }` | – |
| `POST /gateways/:id/dns/label-names/apply[?apply=0]` | `{ macs? }` | `{ applied: PendingLabelName[], issues, apply, applyError }` | 409 `dns_label_names_off`, `nothing_to_apply` |

- **The gateway** of a device write: `gatewayId`, else the only managed one.
- **Reservations** are `dhcp` `host` sections of the `dhcp_hosts` domain. A MAC
  the router already has in a host it owns (excluded or unmodeled) is refused
  rather than duplicated. `ip: null` keeps a name-only host (the name follows
  the dynamic lease); `publishDns` sets `dns '1'` when there is an address.
- **DNS records** are `dhcp` `domain` (`name`, `ip`: type `a`) and `cname`
  (`cname`, `target`) sections of the `dns_records` domain; other options on
  them stay the router's.
- **Reserved names** (README 7.10, plan 2 4.2) are refused for every name Perch
  writes (reservations, records, label names): `wpad`, `isatap`, `localhost`,
  `perch`, `router`, `gateway`, `openwrt`, `broadcasthost`, the controller's
  own host label (from `APP_URL`) and the router's host name when the agent
  reports it; the check is on the first label and the full name,
  case-insensitive.
- **Label names** (`gateways.dns_label_names`, default `review`; README 7.10):
  a device label becomes a DNS name only when an admin approves it. Pending =
  labelled devices the gateway knows (a lease, or a host entry) whose host
  name differs from the label's slug (lowercase `[a-z0-9-]`, ≤ 63; a slug in
  use gets `-2`, `-3`, …). Approving writes the slug as the host's `name` (a
  name-only host when the device has none). Reserved slugs and devices whose
  host the router owns are listed as `blocked`, never applied. `auto` (plan 2)
  is not offered.

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
  a secure session (verified TLS: never on a signed plain-HTTP session).
- Writes need verified TLS on both ends, or both opt-ins and a pairing (4.3, 4.4). The api_key
  never signs: on plain HTTP it is visible as the socket's bearer token. The pairing's key and a
  router's `config_sign_key` are APP_KEY-encrypted per gateway and never returned; the pairing
  code must be typed on the controller and confirmed on the router, so a man in the middle has one
  guess in 10^6. Signing gives integrity and replay protection, not confidentiality.
- Entering `managed`, Authoritative Mode ON, a pairing and a sign key need the admin's current
  password; every write is in `gateway_config_events` with its user.
- A compromised controller in `managed` mode can rewrite the router's allowlisted configs. It
  cannot read secrets, touch the excluded configs, run commands or act on a router that left
  `config_access` at `none` or `read`. Rollback is a safety net for mistakes, not a security
  control.
