# Guest portal: controller domain

Status: WP1 (controller domain) built on branch `gw/portal`, WP2 (REST API,
§11–12) on `gw/portal-rest`, WP3 (collector socket, §13) on `gw/portal-sock`,
the Paid Hotspot follow-up and click-through (§14) on `gw/hotspot`,
September 2026.
This file is the contract for the REST layer (WP2), the collector socket
(WP3) and the router side in perch-collector (WP4). It promotes sections 3–5
of the portal design and applies the owner's decisions 19–25, which override
the design where they differ:

| #   | Decision                                         | Effect here                                                                    |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| 19  | Several portals per gateway in v1                | `portals` is keyed per network, not per gateway (§5)                           |
| 20  | Offline voucher redemption                       | The router holds the vouchers it may redeem, with HMAC verifiers (§4.7, §6)    |
| 21  | Guest capture is a per-network toggle            | `gateway_networks.capture` (config plane); the portal does not touch it (§4.9) |
| 23  | Time before data buckets; a reused voucher moves | Stacking and device slots (§4.6)                                               |
| 24  | Pre-auth DNS rate-limited                        | A setting the router enforces (§8)                                             |
| 25  | Outside authorizations: Perch always decides     | Always undone and logged, whatever the Authoritative Mode (§4.8)               |
| 27  | Perch nftables enforcement, not openNDS          | Router config is Perch runtime data in `portal.configure` (§13)                |

The code lives in `app/services/portal/*` (pure, no app imports),
`app/services/portal_{keys,settings,store,retention}.ts` (bound to the app and
the database), `app/models/portal*.ts`, `voucher*.ts`, migrations
`1779000000070`–`075` and `app/tasks/prune_portal_history.task.ts`.

## 1. Decisions at a glance

| Question                      | Decision                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enforcement                   | Perch's own nftables table `inet perch_portal` rendered by perch-collector, every portal (decision 27); no openNDS                                                      |
| Page hosting                  | Guest pages served by perch-collector on the router (`:2080`), port 80 redirected there                                                                                 |
| Controller exposure to guests | None                                                                                                                                                                    |
| Login identities              | `portal_users`, never controller `users`                                                                                                                                |
| Byte counting                 | The router's kernel counters (nftables: upload per MAC, download per address the device uses, on the IP hooks so shaped traffic counts), never pcap                     |
| Authority                     | Controller: vouchers, grants (create, extend, revoke), the offline voucher list. Router: usage, session facts, offline redemptions                                      |
| Outage                        | The router keeps grants and enforces expiry and quotas. It also redeems the vouchers it holds (decision 20). Password logins and API authorizations need the controller |
| Scope v1                      | Several portals per gateway, one per network                                                                                                                            |

## 2. Three kinds of state

| Layer                | What                                                                              | Where                               | Sync                                                            | Who wins                                   |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Native config        | `perch-collector.main.portal_*` (enable, port, storage)                           | router UCI                          | not synced (excluded config)                                    | the router's operator                      |
| Perch app data       | portals, templates, vouchers, portal users, API clients, `system_settings.portal` | controller DB                       | down (`portal.configure`, `portal.template`, `portal.vouchers`) | controller, always                         |
| Runtime: entitlement | grants and their limits                                                           | controller DB, cached on the router | down (`portal.authorize` / `deauthorize` / full sync)           | controller for create, extend, revoke      |
| Runtime: facts       | usage, sessions, router deauths, offline redemptions, outside auths               | router                              | up (`portal.sync`, `portal.event`, `portal.sessions`)           | router: the controller never invents usage |

The `portals` row stores no native setting. `network_perch_id` is the ledger
id of the `interface` section the portal sits on; it stays stable across
renames. Everything the router needs to enforce a portal (network, methods,
template, settings, key) is Perch runtime data in `portal.configure` (§13.2);
nothing goes through the config plane (decision 27).

## 3. Codes (`portal/codes.ts`)

- Crockford base32, upper case: `0-9 A-Z` without I, L, O, U. Each symbol is
  the low five bits of one random byte, so there is no bias.
- Length 8–16, default 10 (50 bits). Shown in groups of 5 when the length is a
  multiple of 5 (`XXXXX-XXXXX`), else groups of 4.
- **Normalization**, which router and controller must do identically before
  hashing:
  1. Drop whitespace, `-`, `.` and `_`.
  2. Upper-case the rest.
  3. Map I and L to 1, and O to 0.
  4. Reject U or any other character, and any length outside 8–16.
  5. Reject raw input longer than 64 characters.
- `hint` = the last four characters (admin lists only; never sent to a router).
- Brute force: with 1000 live vouchers and 60 failures per portal per minute,
  P(hit) ≈ 3e-5 per year of non-stop guessing at 10 characters.

## 4. Authorization model

### 4.1 Grants and groups

A **grant** authorizes one MAC on one portal. Every grant belongs to a
**group**, whose limits all its grants share:

| Group key          | Limits come from                                                                                                        | `maxDevices`        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `v:<voucherId>`    | the voucher's batch; the voucher row holds the started clock and the totals                                             | batch `max_devices` |
| `u:<portalUserId>` | the user (rates); each login's deadline is the grant's own `expires_at`                                                 | user `max_devices`  |
| `g:<grantId>`      | the grant row itself (`duration_mode`, `expires_at`, `time_budget_seconds`, `quota_bytes`, rates): API and admin grants | 1                   |

`GroupLimits = {durationMode, expiresAt, durationSeconds, quotaBytes, downKbps, upKbps, maxDevices}`:

- **`wall_clock`**: `durationSeconds` turns into `expiresAt` when the clock starts.
  - `first_use`: the clock starts when the voucher first runs on a device, not
    when it is queued (§4.6).
  - `creation`: the clock starts at creation.
- **`active_time`**: `durationSeconds` is a budget of charged active time; there
  is no deadline.
- `redeemBy`: an unused voucher expires then. A started one ignores it.

A voucher binds to the first portal it is redeemed on. A batch with a portal
binds its vouchers there too.

### 4.2 Grant lifecycle (`portal/grant_lifecycle.ts`)

```
                promote                       router: active
  queued ─────────────────▶ pending_device ─────────────────▶ active
    ▲  ▲                          ▲    ▲   router: pending    │  ▲
    │  └──────── queue ───────────┘    └──────────────────────┤  │ router: resumed
    │                                                         ▼  │
    └──────────────────── queue ───────────────────────────── paused (idle deauth)
  any non-ended ── end(reason) ──▶ ended   (final; the first end reason sticks)
```

```ts
type GrantState = 'queued' | 'pending_device' | 'active' | 'paused' | 'ended'
type GrantDelivery = 'applied' | 'pending'
type GrantEndReason =
  | 'expired'
  | 'quota'
  | 'revoked'
  | 'logout'
  | 'router_deauth'
  | 'replaced'
  | 'moved'
  | 'rejected'

type GrantLifecycle = {
  state: GrantState
  delivery: GrantDelivery
  revision: number
  startedAt: number | null
  endedAt: number | null
  endReason: GrantEndReason | null
}

type GrantEvent =
  // server commands
  | { type: 'queue' }
  | { type: 'promote' }
  | { type: 'extend' }
  | { type: 'end'; reason: GrantEndReason; at: number }
  // router answers and facts
  | {
      type: 'delivered'
      revision: number
      result: 'active' | 'pending_device' | 'rejected'
      at: number
    }
  | { type: 'removed'; revision: number }
  | { type: 'router_active' | 'router_paused' | 'router_resumed'; at: number }
  | { type: 'router_ended'; reason: GrantEndReason; at: number }

type GrantTransition =
  | {
      ok: true
      grant: GrantLifecycle
      changed: boolean
      push: 'authorize' | 'deauthorize' | null
      session: 'open' | 'close' | null
    }
  | { ok: false; error: 'grant_ended' | 'invalid_transition' }

function newGrantLifecycle(queued: boolean): GrantLifecycle
function transitionGrant(grant: GrantLifecycle, event: GrantEvent): GrantTransition
```

- **Two axes.** `state` says what the grant is; `delivery` says whether the
  router has acknowledged the current `revision`.
- **Revisions.** The server bumps `revision` and sets `delivery = pending`
  whenever the router's copy must change: created, extended, queued, promoted,
  or ended by the server. The router's answer for that revision (an authorize
  result, or the revision in its usage snapshot) sets `applied`. A removal is
  acknowledged when the grant no longer appears in a snapshot.
- **Router facts never fail.** A stale one is ignored; the next full sync
  settles the router anyway.
- **Server commands can fail.** Extending, queueing or promoting an ended grant
  fails with `grant_ended`; WP2 maps it to 409.
- **Deauth is always respected.** A router deauth (`router_deauth`) ends the
  grant, not the voucher, and is never undone.
- **Idle.** `paused` is kept for a router that reports idle devices; Perch's
  nftables enforcement (decision 27) does not, so `session_paused` /
  `session_resumed` never arrive today and reconciliation tolerates that.

### 4.3 Counting

Counters are cumulative per grant (`bytes_up`, `bytes_down`, and
`time_used_seconds` = active time charged to that grant):

- They merge with `max`, because a router may resend an older snapshot.
- **Charging rule** (router): each enforcement tick in which any device of an
  `active_time` group moved traffic is charged **once**. The charge goes to the
  lowest-id live grant of the group that moved traffic. This keeps group time
  additive over grants.
- A voucher's totals (`vouchers.time_used_seconds`, `bytes_used`) grow by the
  deltas of its grants' counters. They outlive pruned grant rows.
- The wire group's `base*` fields are the group's usage outside the router's
  live grants: `base = total − Σ(live grants on this router)`. The router adds
  its live counters to them, so nothing is counted twice.

### 4.4 Exhaustion (`portal/groups.ts`)

- **`exhaustion(limits, usage, now)`** checks three conditions, in order:
  1. `expiresAt ≤ now` → `expired`
  2. `active_time` and `timeUsed ≥ durationSeconds` → `expired`
  3. `bytesUsed ≥ quotaBytes` → `quota`

  Time comes first, so a group past its deadline is `expired` even when its
  data ran out in the same tick.

- **Per-grant deadline.** A grant's own deadline tightens its group's
  (`grantLimits`).
- **Backstops** (`ndsBackstops`, from the openNDS design; unused since
  decision 27, the QoS seam §13.7 is the in-kernel backstop):
  - Session timeout: the remaining minutes, rounded up.
  - Download quota: the remaining kB, rounded up.

  Both are at least 1.

- **Who ends a group.** The router enforces every
  `enforceIntervalSeconds` and ends all devices of an exhausted group. The
  controller ends such grants too when it notices during reconciliation, so a
  grant the router lost is never sent back just to expire.

### 4.5 Voucher status (`portal/redemption.ts`)

| Status      | When (first match wins)                               |
| ----------- | ----------------------------------------------------- |
| `revoked`   | The voucher or its batch was revoked                  |
| `expired`   | The time ran out, or it is unused and past `redeemBy` |
| `exhausted` | The data ran out, or `exhausted_at` is set            |
| `active`    | Used                                                  |
| `unused`    | Otherwise                                             |

`exhausted_at` is written for used vouchers whose time or data ran out.

### 4.6 Stacking and device slots (decision 23)

A device may hold several entitlements on one portal: at most one **live**
(pending_device, active or paused) and any number **queued**. Consumption order
(`compareEntitlements`):

1. **Classes.** `time` (a duration or a deadline, possibly also a quota) and
   `open` (no limit, e.g. an admin grant) come first. `data` (quota only) comes
   last.
2. **Within time.** A running clock (a fixed deadline) goes before one that has
   not started, and the earlier deadline first.
3. **Ties.** The older grant, then the lower id.

On redemption (`planVoucherRedemption`):

- **Placement.** The device may already hold a live entitlement on this portal.
  - A time or open voucher over a running **data bucket** swaps: the new grant
    runs, and the bucket goes back to the queue with its usage intact.
  - Anything else **queues** behind.

  A queued wall clock starts only when the grant is promoted.

- **Slots.** A voucher follows the newest device. When its group is at
  `maxDevices`, the device that joined **first** leaves (`moved`), however
  recently it was seen. A shared code kicks the first device off, and MAC
  randomisation never locks a guest out.
- **Portal users** (`planUserLogin`) keep the design's rule: evict only devices
  unseen for `deviceUnseenEvictMinutes`, else `device_limit`.

Reconciliation keeps the invariant. When a device's live grant ends, its next
queued grant is promoted and a first-use wall clock starts then. When a race
leaves two live grants, the one later in order goes back to the queue.

### 4.7 Offline redemption (decision 20)

The controller hands each gateway the vouchers **only that gateway** can
redeem, in `portal.vouchers` (§6.4). A voucher qualifies when:

- its portal (bound, else its batch's) is one of the gateway's portals;
- its status is `unused` or `active`;
- its code can be decrypted (APP_KEY not rotated since).

Vouchers valid on any portal are offered only after a first online
redemption has bound them. So two gateways can never both redeem the same
voucher, and there is no double spend.

The list is ordered active first, then newest batch, and capped at
`offlineVoucherLimit`. It is re-sent in full with every reconciliation. A
revoked voucher simply drops off.

**Router side.** When the controller is unreachable:

1. Normalize the typed code and compute its verifier (§6.2).
2. Look it up among the held vouchers, then apply the same rules as
   `planVoucherRedemption`: status, portal, placement and slot eviction.
3. Start a wall clock at redemption when the grant runs at once.
4. Authorize the device under a fresh `localRef` (`[A-Za-z0-9._:-]{1,64}`,
   unique per portal), with custom string `perch:o:<localRef>`.
5. Journal `offline_redeemed`:
   `{voucherId, localRef, placement, demotedGrantId?, demotedLocalRef?, startsAt?, expiresAt?}`.
   Journal `grant_ended {reason:'moved'}` for evicted devices.

**Controller side.** Reconciliation turns the event into a `portal_grants` row
(`local_ref` set) and binds and starts the voucher as the router decided (first
writer wins). It sends the grant back with its id. When the voucher had been
revoked before the router redeemed it, the grant is recorded and then ended
(`revoked`).

### 4.8 Authorizations made outside Perch (decision 25)

A MAC added to a portal's nft set by hand, another tool, and so on:

- The router undoes it within one tick, on its own, in both Authoritative Mode
  settings.
- It journals `external_auth` and keeps listing still-present externals in
  `portal.sync`.
- The controller logs `external_auth_reverted` (with the gateway's
  Authoritative Mode, for the audit). It also repeats the revert list in
  `desired.revertExternals`.

Such authorizations never become grants: there is no `external` grant source.
A router deauth of a Perch grant is a fact (`router_deauth`), respected and
never undone.

### 4.9 Guest capture (decision 21)

Whether a guest network is captured for Perch's device and destination views
is `gateway_networks.capture`, one toggle per network, owned by the config
plane. The portal neither reads nor changes it. The dashboard should show the
toggle on the portal page with a privacy note (RA 10173). Keeping it **off** on
guest networks is the privacy-preserving default an operator can override.

## 5. Data model (migrations 070–076)

All tables are `utf8mb4_unicode_ci`. Unions are strings enforced in the app;
JSON is stored as text and parsed by the models (`schema_rules.ts`).

| Table                   | Notes                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal_templates`      | `sha256` of the file set; `builtin` read-only; one seeded builtin row with no files (= the collector's compiled-in pages)                                                                                                                                                                                                                                |
| `portal_template_files` | `content` MEDIUMBLOB; unique (template_id, name)                                                                                                                                                                                                                                                                                                         |
| `portals`               | `gateway_id` → gateways CASCADE; `network_perch_id`, `methods` JSON, `template_id` → templates SET NULL, `csp_connect_src` JSON, `privacy_notice`, `revision`, `applied_revision`, `status` JSON, `deleted_at`. Generated `active_network` = network while not deleted; **unique (gateway_id, active_network)**                                          |
| `voucher_batches`       | `portal_id` → portals CASCADE (null = any portal); limits; `redeem_by`; `revoked_at`                                                                                                                                                                                                                                                                     |
| `vouchers`              | `code_hash` CHAR(64) unique (HMAC, §6.1), `code_encrypted` (APP_KEY), `hint`, `bound_portal_id` → portals SET NULL, clock (`first_used_at`, `starts_at`, `expires_at`), totals, `revision`, `revoked_at`, `exhausted_at`                                                                                                                                 |
| `portal_users`          | `username` unique, scrypt `password` (hashed by the model), `max_devices`, `session_minutes`, rates, `portal_ids` JSON, `revision`                                                                                                                                                                                                                       |
| `portal_api_clients`    | `token_hash` unique (SHA-256), `token_prefix`, `scopes`/`portal_ids` JSON, per-call caps                                                                                                                                                                                                                                                                 |
| `portal_grants`         | BIGINT id; `portal_id` → portals CASCADE; `mac` CHAR(17); `source` voucher\|user\|api\|admin; `group_key`; FKs to voucher/user/api client/user SET NULL; `external_ref` (unique with api_client_id), `local_ref` (unique with portal_id); `g:` limits; counters; `state`, `delivery`, `revision`, `started_at`, `last_seen_at`, `ended_at`, `end_reason` |
| `portal_sessions`       | per active stretch: `start_bytes_*` at open, `bytes_*` = end − start at close                                                                                                                                                                                                                                                                            |
| `portal_gateway_states` | PK `gateway_id` → gateways CASCADE; `acked_event_seq` (one journal per router, shared by its portals), `key_epoch`, `router_key_epoch`, `last_sync_at`                                                                                                                                                                                                   |
| `portal_authorizations` | (076) authorize API ledger: idempotency per principal + `external_ref`, audit (§11.6)                                                                                                                                                                                                                                                                    |
| `portal_outbox`         | (076) pushes waiting for the router, one per (gateway, `dedupe_key`) (§11.2)                                                                                                                                                                                                                                                                             |
| `portal_events`         | audit: `gateway_id` CASCADE, `portal_id` CASCADE null, `grant_id` SET NULL, `mac`, `type`, `detail` JSON                                                                                                                                                                                                                                                 |
| `hotspot_price_tables`, `hotspot_price_revisions` | (100) rates, `entries` JSON, `revision`; every revision kept (§14.2)                                                                                                                                                                                                                                                            |
| `hotspot_terminals`     | (100) `portal_id` → portals CASCADE; `token_hash` unique, `token_encrypted` (APP_KEY), `token_prefix`, `mac` pin, `enabled`, `price_table_id` SET NULL, `last_seen_at`, `status` JSON (§14.3)                                                                                                                                             |
| `hotspot_checkouts`     | (100) the payment ledger: `gateway_id` CASCADE, `portal_id`/`terminal_id`/`voucher_id` SET NULL, `kind` payment\|unclaimed, `state`, `event_key` unique per gateway, amounts, locked price snapshot, coins JSON, `router_sig`, void/credit fields (§14.5)                                                                                    |
| `portals.payment`, `portals.click_through`, `voucher_batches.kind` | (101) method settings JSON; `batch` or `payment` (§14)                                                                                                                                                                                                                                                            |

- **Merge.** Nothing here references `collectors`: the portal follows its
  gateway through `collectors:merge`, and no registry entry is needed.
- **Joins.** MAC joins with the Wi-Fi tables (other collation) happen in JS or
  with an explicit `COLLATE`.
- **Time.** Times are written and read as UTC. The pure layer uses epoch
  milliseconds and never parses DATETIME strings.

## 6. HMAC scheme v1 (`portal/crypto.ts`)

### 6.1 Keys

```
salt             = "perch-portal-v1"
lookupKey        = HKDF-SHA256(ikm=APP_KEY, salt, info="voucher-lookup", 32)       controller only
gatewayKey(g,e)  = HKDF-SHA256(ikm=APP_KEY, salt, info="gateway:<g>:<e>", 32)      sent to gateway g
voucherKey       = HMAC-SHA256(gatewayKey, "perch-portal-voucher-v1")              both sides
signKey          = HMAC-SHA256(gatewayKey, "perch-portal-sign-v1")                 both sides
```

- **APP_KEY is never a key.** It is only HKDF input.
- **Rotation.** Bumping `portal_gateway_states.key_epoch` rotates a gateway's
  keys.
- **Delivery.** The router receives `{epoch, gatewayKey}` (32 bytes,
  base64url) in `portal.configure` when its reported epoch differs. It keeps
  the key in its local store and never sends it back.
- **Scope.** A router that leaks its key exposes only its own verifiers and
  signatures: it holds neither APP_KEY nor `lookupKey` nor any other gateway's
  key.

### 6.2 Hashes

```
code_hash = hex(HMAC-SHA256(lookupKey,  normalizedCode))                    vouchers.code_hash
verifier  = hex(HMAC-SHA256(voucherKey, "v1\n" + gatewayId + "\n" + normalizedCode))
```

The verifier is bound to the gateway id, so a copied list matches nothing
elsewhere. The two hashes are unrelated.

### 6.3 Signed records

```
signature = base64url_nopad(HMAC-SHA256(signKey, canonical))     43 characters
canonical = lines joined by "\n", no trailing newline:
            tag, gatewayId, epoch, fields in order
```

Field encoding:

- **Integers:** decimal, no sign, no leading zeros.
- **null:** the empty string.
- **Booleans:** `1` / `0`.
- **Strings:** verbatim, from `[A-Za-z0-9._:-]{0,64}` (plus lower-case MACs and
  64-hex verifiers).
- **Integer lists:** sorted ascending and comma-joined.
- **Times:** epoch milliseconds.

| Record          | Tag                                                  | Fields in order                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| group           | `perch-portal-group-v1`                              | groupKey, durationMode, expiresAt, durationSeconds, quotaBytes, baseTimeUsedSeconds, baseBytesUsed, downKbps, upKbps, maxDevices, revision                                                                 |
| grant           | `perch-portal-grant-v1`                              | grantId, localRef, portalId, groupKey, mac, expiresAt, revision                                                                                                                                            |
| offline voucher | `perch-portal-voucher-v1`                            | voucherId, verifier, portalIds, groupKey, durationMode, startMode, durationSeconds, quotaBytes, downKbps, upKbps, maxDevices, redeemBy, expiresAt, timeUsedSeconds, bytesUsed, revision, firstUsedAt (WP3) |
| envelope        | `perch-portal-<authorize\|deauthorize\|vouchers>-v1` | full, serverNow, nonce, ackedEventSeq, grantIds, reason, itemCount, externalCount; then one line per item signature (wire order), then `ext:<portalId>:<mac>` per external                                 |

The router verifies every item and the envelope with `signKey`. It rejects:

- a nonce it has seen (it remembers the last 256);
- an envelope whose `serverNow` is more than 10 minutes older than the newest
  it accepted;
- an envelope with an unknown `keyEpoch`.

This covers integrity and replay over a plain-HTTP install (README 7.1) and
the router's persisted copy. Confidentiality is TLS's job.

**Test vectors** (`tests/unit/services/portal/crypto.spec.ts`, cross-checked
with an independent HKDF/HMAC implementation). The inputs are
APP_KEY `perch-test-app-key-0123456789abcdef`, gateway 7, epoch 1 and code
`K7Q2M9XH4D`:

```
lookupKey  df9107c705d83bbc11aa97dc6b6443d3cfa0d71d346d58043034fbf06893e4a9
code_hash  8e73b0adbbaad5211dcd1b816eb9b9d927eb2394944d625b54a533c567057867
gatewayKey 5xWg3o-mXyuxbPvlpxL3dGgcnUXrgB-JeSJjxfHfySU
voucherKey 77c9f47a3aa4c958b236c4805831b6090a0e9a44db4dfe8fe7ada0618c009703
signKey    82c4ea733b93eed127a9a15ea6f09751eae22970c0d9a631357cf79b906989de
verifier   0026473bc23eeae443961e14eb2db086f0870607cedb8ea0225eca9106112af6
grant {42, null, 3, v:17, 02:00:00:aa:bb:cc, null, 2}      → fcGv3MNx9X1ku6Egf23WIq_MHxQkC6PcgobSjfLs7VY
```

The spec also pins the group, offline-voucher and envelope vectors.

### 6.4 Wire messages (`portal/messages.ts`)

These add to the design's RPC table and are what WP3 sends and WP4 verifies:

```ts
// portal.authorize params (full or delta)
{ full, serverNow, ackedEventSeq, nonce, keyEpoch,
  groups: (WireGroup & {sig})[], grants: (WireGrant & {sig})[],
  revertExternals: {portalId: number|null, mac}[], sig }
WireGroup = { groupKey, durationMode, expiresAt, durationSeconds, quotaBytes,
  baseTimeUsedSeconds, baseBytesUsed, downKbps, upKbps, maxDevices, revision }
WireGrant = { grantId: number|null, localRef: string|null, portalId, groupKey, mac,
  expiresAt, revision }                      // expiresAt: grant-level deadline (new)

// portal.vouchers params (new): the full offline list every time, in parts of ≤ 4000 (WP3)
{ enabled, serverNow, nonce, keyEpoch, vouchers: (WireOfflineVoucher & {sig})[],
  append, part, parts, sig }            // envelope reason = 'append' when append, else null
WireOfflineVoucher = { …, revision, firstUsedAt }   // firstUsedAt: epoch ms or null (WP3)

// portal.deauthorize params
{ grantIds, reason, serverNow, nonce, keyEpoch, sig }
```

On a `full` authorize the router:

- adds the missing grants;
- ends the grants no longer listed, reason `removed`;
- **keeps** offline grants it created after `ackedEventSeq` (they are not in
  the set yet);
- maps `localRef` → `grantId` when both arrive.

## 7. Reconciliation (`portal/reconcile.ts`)

```ts
function reconcile(
  server: ServerPortalState,
  report: RouterPortalReport,
  authoritative: boolean
): { dbChanges: PortalDbChanges; desired: DesiredPortalState }
```

`authoritative` changes no outcome under decision 25; it is recorded on the
logged events.

**Caller sequence (WP3)**, run in the gateway's portal queue, once per gateway
after `hello` + `agent.configure` + `portal.configure`, and on demand:

```ts
const report = await session.call('portal.sync', { ackedEventSeq }) // RouterPortalReport
const server = await loadServerPortalState(gatewayId, { now, report, enabled })
const { dbChanges, desired } = reconcile(server, report, gateway.authoritative)
const ids = await applyPortalDbChanges(gatewayId, dbChanges, { now })
const keys = portalGatewayKeys(gatewayId, state.keyEpoch)
await session.call(
  'portal.authorize',
  buildAuthorizeParams(bindInsertedGrantIds(desired, ids), keys)
)
await session.call('portal.vouchers', buildVouchersParams(desired, keys))
```

**Router report** (`portal.sync` result; the design's §6 shape with additions):

```ts
RouterPortalReport = { lastEventSeq, truncated, events: RouterEvent[],
  grants: RouterGrantUsage[], externals: RouterExternal[] }
RouterEvent: {seq, at, portalId, mac} & one of
  grant_active {grantId|null, localRef?, ip?} | session_paused | session_resumed {grantId|null, localRef?}
  | grant_ended {grantId|null, localRef?, reason: expired|quota|router_deauth|logout|moved|removed,
                 bytesUp?, bytesDown?, activeSeconds?}
  | external_auth {ip?} | external_deauth
  | offline_redeemed {voucherId, localRef, placement, demotedGrantId?, demotedLocalRef?,
                      startsAt?, expiresAt?, ip?, hostname?}                        // new
RouterGrantUsage = { grantId|null, localRef|null, portalId, mac, ip, bytesUp, bytesDown,
  activeSeconds, state: active|paused|pending_device, lastSeenAt, revision }        // revision, localRef: new
```

`grants` must list **every** grant the router holds, pending ones included.
Absence means "not held".

**Steps.** Each step works on the result of the previous one.

1. **Journal.** Replay the events after `ackedEventSeq`, in `seq` order. A
   `lastEventSeq` below the acked seq means the router journal restarted: all
   events are replayed and `journal_reset` is logged.
   - Ends are facts.
   - Offline redemptions become grant inserts; they are rejected, and logged,
     for an unknown voucher, a foreign portal, a bad MAC or a bad ref.
   - Outside auths are logged.
2. **Usage snapshot.** Counters merge with `max`. A matching revision
   acknowledges delivery. A reported `paused` pauses the grant.
   - Grants ended or queued here and absent there are acknowledged as removed.
   - Live grants absent there are re-sent: their session closes (`lost`) and
     `grant_lost` is logged. A truncated journal is logged too.
3. **Voucher totals** grow by the counter deltas.
4. **Accounting.** Revoked or exhausted groups end: `revoked`, `expired` or
   `quota`. A used voucher that ran out gets `exhausted_at`.
5. **Stacking** (§4.6): demote extra live grants, promote the next queued one,
   and start its clock: a first-use voucher's, or the waiting wall clock of a
   queued API/admin grant (`grantClocks`; its `expires_at` is null until then).
6. **Desired set:**
   - every live grant of an enabled portal, with its group and `base*`;
   - `revertExternals`, deduplicated;
   - the offline voucher list (§4.7), or `null` when disabled.

   Voucher revisions bump whenever a fact the router holds changes.

**Output:**

```ts
PortalDbChanges = {
  ackedEventSeq: number
  grantInserts: GrantInsert[]          // offline redemptions, keyed by localRef
  grantUpdates: { id; set: Partial<GrantFields> }[]
  grantClocks: { id; expiresAt }[]     // queued g: grant promoted: its wall clock starts (WP2)
  sessions: ({op:'open', grant: GrantRef, portalId, mac, ip, startedAt, startBytesUp, startBytesDown}
           | {op:'close', grant: GrantRef, endedAt, endReason, bytesUp, bytesDown})[]   // in order
  voucherUpdates: { id; set: {boundPortalId?, firstUsedAt?, startsAt?, expiresAt?, exhaustedAt?, revision?};
                    add: {timeUsedSeconds, bytesUsed} }[]
  events: { at, type, portalId, grant: GrantRef|null, mac, detail }[]
}
DesiredPortalState = { gatewayId, full: true, serverNow, ackedEventSeq, groups: WireGroup[],
  grants: WireGrant[], revertExternals, offlineVouchers: WireOfflineVoucher[] | null }
```

`applyPortalDbChanges` writes it in one transaction:

- Grant counters are written with `GREATEST`.
- Voucher usage is added as deltas.
- Voucher clock and binding use `COALESCE`, so the first writer wins.
- Sessions close with `bytes = end − start`.
- An event naming a foreign portal is kept without the key.

Reconciliation is idempotent: the same report applied twice changes nothing
(unit and DB tests).

## 8. Settings (`system_settings` key `portal`)

`GET / PATCH /api/v1/settings/portal` (WP2) serves
`portalSettingsView(settings)`: `{settings, defaults, limits}`. The PATCH goes
through `updatePortalSettings`.

| Key                                         | Default | Range   |
| ------------------------------------------- | ------- | ------- |
| `sessionRetentionDays`                      | 30      | 1–730   |
| `enforceIntervalSeconds`                    | 5       | 2–60    |
| `usageIntervalSeconds`                      | 30      | 10–300  |
| `guestFailuresPerDevicePerMinute`           | 5       | 1–60    |
| `guestFailuresPerDevicePerHour`             | 20      | 1–600   |
| `guestFailuresPerPortalPerMinute`           | 60      | 10–600  |
| `controllerFailuresPerDevicePer15Minutes`   | 10      | 1–100   |
| `controllerFailuresPerUsernamePer15Minutes` | 20      | 1–200   |
| `apiRequestsPerClientPerMinute`             | 120     | 10–6000 |
| `deviceUnseenEvictMinutes`                  | 10      | 1–1440  |
| `preauthDnsPerDevicePerMinute`              | 120     | 10–6000 |
| `offlineRedemption`                         | true    | bool    |
| `offlineVoucherLimit`                       | 5000    | 0–50000 |

- **Validation.** A wrong type reads as the default, and an out-of-range
  number is clamped.
- **`persistUsageSeconds` is gone.** The router's store and its flush interval
  are gateway settings (README 7.18: grants are written immediately, counters
  per flush interval).

## 9. Retention

`prune_portal_history` runs daily at 03:45. It deletes, in batches of 5000,
rows older than `sessionRetentionDays`:

- closed sessions;
- ended grants, whose remaining sessions cascade;
- portal events.

Vouchers keep their totals. Guest MACs, hostnames and usage are personal data
under RA 10173.

## 10. Deviations from the design, and why

- **`portals` is keyed per network.** It has `network_perch_id` (decision 19;
  `instance` and `enforcement` were dropped by migration 078, decision 27). `acked_event_seq` moved to
  `portal_gateway_states`, because a router has one journal for all its
  portals.
- **No `external` grant source** and no `authoritative_revert` end reason
  (decision 25). Outside auths go to `portal_events`, a table the design did
  not have.
- **New grant state `queued`, end reasons `moved` and `rejected`**
  (decision 23; permanent router refusal).
- **Wire additions:**
  - `WireGrant.expiresAt` (grant-level deadline), `localRef`;
  - `RouterGrantUsage.revision`, `localRef`;
  - the `offline_redeemed` event;
  - the `portal.vouchers` RPC;
  - `keyEpoch`, `nonce` and `sig` on every server message.
- **Voucher columns:** `vouchers.revision`, `portal_users.revision`,
  `portal_sessions.start_bytes_*`.
- **`persistUsageSeconds` dropped** (README 7.18).
- **`starts_at` on grants is `started_at`:** when the grant first became
  active.

## 11. REST API (WP2, branch `gw/portal-rest`)

Everything under `/api/v1`, inside the `requireSetupComplete` gate (503 with
the wizard step before setup). Code: `start/routes.ts`,
`app/controllers/portal_*_controller.ts`, `app/validators/portal.ts`,
`app/transformers/portal.ts`, services `app/services/portal_{portals,
grants,grant_admin,vouchers,users_admin,api_clients,authorize,
templates_admin,agent_sender,queue,api_rate_limit,errors,params}.ts`,
middleware `app/middleware/portal_api_auth_middleware.ts`, migration `076`.

### 11.1 Conventions

- **Envelope.** Success bodies are `{ data: … }`. Refusals are
  `{ error: <code>, message, ...detail }` with the status in the tables below.
  A Vine validation failure is 422 `{ errors: [{ field, rule, message }] }`
  (no `error` key). An id route parameter that is not a positive integer reads
  as the resource's 404.
- **Auth levels.**
  - **R**: `auth()` + `requirePasswordChange()`: any signed-in user (admin,
    operator, viewer). Anonymous 401; a pending password change 403
    `password_change_required`.
  - **A**: R + `requireAdmin()`: non-admins get 403 `admin_required`.
  - **K**: `portalApiAuth` (§11.6), outside `auth()`.
- **Lists** take `limit` (1–1000, default 200) and `offset` and answer
  `{ items, total }`, except the small admin catalogs (portals, templates,
  batches, portal users, API clients), which are plain arrays.
- **Times** are ISO 8601 strings in UTC (`…Z`); query and body times accept
  `YYYY-MM-DD[THH:mm[:ss[.sss]]][Z|±hh:mm]`, else 422 `invalid_date`.
- **MACs** are accepted as `aa:bb:…`, `aa-bb-…`, `aabb.ccdd.eeff` or 12 hex
  digits, answered lower case with colons. Broadcast, multicast and all-zero
  MACs are 422 `invalid_mac`.
- **Delivery.** Every write that the router must learn about answers
  `delivery: 'applied' | 'pending'` (§11.2). `pending` = queued, delivered
  when the gateway is (back) online. Nothing is ever refused because a
  gateway is offline (the design's 503 `gateway_offline` is gone).
- **Secrets** (voucher codes, API tokens) appear only in create/rotate/codes
  answers, all `Cache-Control: no-store`.

### 11.2 Router delivery: `PortalAgentSender` (for WP3)

`app/services/portal_agent_sender.ts`:

```ts
type PortalPush =
  | { kind: 'authorize'; grantIds: number[] }   // new/extended/promoted grants: portal.authorize (delta) with their groups
  | { kind: 'deauthorize'; grantIds: number[] } // grants to take off: reason = each grant's end_reason, or 'queued' if not ended
  | { kind: 'configure'; portalId: number }     // portal changed/created/deleted (deleted = configure as disabled)
  | { kind: 'template'; portalId: number }      // portal.template when the router's sha differs
  | { kind: 'vouchers' }                        // resend the gateway's offline list (portal.vouchers)
  | { kind: 'sync' }                            // run a full reconciliation (settings changed)
type PortalDelivery = 'applied' | 'pending'
interface PortalAgentSender {
  send(gatewayId: number, push: PortalPush): Promise<PortalDelivery>
}
portalAgentSender(): PortalAgentSender
setPortalAgentSender(sender): PortalAgentSender   // returns the previous one
sendPortalPushes(gatewayId, pushes[]): Promise<PortalDelivery>  // 'applied' only if all were
enqueuePortalPush(gatewayId, push, trx?): Promise<void>
outboxDedupeKey(push): string                    // 'authorize' | 'deauthorize' | 'configure:<id>' | 'template:<id>' | 'vouchers' | 'sync'
```

- The REST layer calls `send` **after** its transaction committed, **inside**
  `runInPortalQueue(gatewayId, …)` (`portal_queue.ts`: a per-gateway promise
  chain, in-process, bounded by gateways with work in flight). WP3's
  reconcile, redeem and login handlers must run in the same queue.
- A push names what changed, never a wire message: signed params carry
  `nonce`/`serverNow` and are built at send time from the rows
  (`messages.ts`). Losing a push is safe: grants keep `delivery = 'pending'`
  until acknowledged and every reconciliation sends the full desired set.
- **Default sender** `OutboxPortalAgentSender`: writes `portal_outbox` and
  answers `pending` (`applied` for a push without grant ids). One undelivered
  row per `(gateway_id, dedupe_key)`; a new push merges into it (grant ids
  united, sorted). Columns: `id, gateway_id, kind, dedupe_key, portal_id,
grant_ids` (JSON text), `attempts, last_error, created_at, updated_at`.
- **WP3 contract** (built, §13.4). Install a sender that enqueues (same function) and, when
  the gateway's collector is online, drains at once: inside the gateway's
  queue, read its rows in id order, **delete** them, send; on failure
  re-enqueue (or rely on the next full sync) and answer `pending`; answer
  `applied` only when the router acknowledged. On every (re)connect: drain the
  outbox after the reconciliation. `portal_outbox` rows cascade with the
  gateway and portal.

### 11.3 Shapes

```ts
type Portal = {
  id: number
  gatewayId: number
  name: string
  gateway: {
    id: number
    collectorId: number | null
    name: string | null // collector name
    online: boolean
    mode: string
    authoritative: boolean
    portalCapable: boolean | null
  } | null // gateway.capabilities.portal; null = not reported
  network: {
    perchId: string
    name: string | null // interface section name (config plane mirror)
    label: string | null
    purpose: string | null
  } // gateway_networks
  methods: { voucher: boolean; password: boolean }
  templateId: number | null
  cspConnectSrc: string[]
  privacyNotice: string | null
  status: {
    state: 'active' | 'disabled' | 'waiting_device' | 'error' | 'unknown' // Perch enforcement (§13.3)
    device: string | null
    counting: boolean
    issues: string[]
    listen: string | null // from the last portal.configure result (WP3 writes portals.status)
    revision: number
    appliedRevision: number | null
    delivery: 'applied' | 'pending'
    clients: { authenticated: number; pending: number; paused: number; queued: number }
    lastReportAt: string | null
    lastConfiguredAt: string | null
  }
  createdAt: string | null
  updatedAt: string | null
}

type Group = {
  key: string // v:<voucherId> | u:<portalUserId> | g:<grantId>
  devices: number
  maxDevices: number
  timeUsedSeconds: number
  bytesUsed: number
  remaining: { seconds: number | null; bytes: number | null } // null = no such limit
  durationMinutes: number | null
  durationMode: 'wall_clock' | 'active_time'
  expiresAt: string | null
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
}

type PortalGrant = {
  id: number
  portalId: number
  mac: string
  ip: string | null
  hostname: string | null
  source: 'voucher' | 'user' | 'api' | 'admin'
  state: 'queued' | 'pending_device' | 'active' | 'paused' | 'ended'
  delivery: 'applied' | 'pending'
  revision: number
  voucher: { id: number; batchId: number; hint: string } | null
  portalUser: { id: number; username: string } | null
  apiClient: { id: number; name: string } | null
  createdBy: { id: number; email: string } | null // admin grants
  externalRef: string | null
  note: string | null
  startedAt: string | null
  expiresAt: string | null // effective deadline
  lastSeenAt: string | null
  bytesUp: number
  bytesDown: number
  timeUsedSeconds: number // this device
  group: Group | null
  endedAt: string | null
  endReason:
    | 'expired'
    | 'quota'
    | 'revoked'
    | 'logout'
    | 'router_deauth'
    | 'replaced'
    | 'moved'
    | 'rejected'
    | null
  createdAt: string | null
}

type VoucherBatch = {
  id: number
  portalId: number | null
  name: string
  note: string | null
  count: number
  codeLength: number
  durationMinutes: number | null
  durationMode: 'wall_clock' | 'active_time'
  startMode: 'first_use' | 'creation'
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  maxDevices: number
  redeemBy: string | null
  createdAt: string | null
  createdBy: { id: number; email: string } | null
  revokedAt: string | null
  counts: { unused: number; active: number; exhausted: number; expired: number; revoked: number }
}

type Voucher = {
  id: number
  batchId: number
  hint: string // last 4 characters
  status: 'unused' | 'active' | 'exhausted' | 'expired' | 'revoked'
  boundPortalId: number | null
  firstUsedAt: string | null
  startsAt: string | null
  expiresAt: string | null
  timeUsedSeconds: number
  bytesUsed: number
  devices: number
  revokedAt: string | null
  code?: string | null
} // only in /codes: formatted `XXXXX-XXXXX`

type PortalUser = {
  id: number
  username: string
  displayName: string | null
  enabled: boolean
  maxDevices: number
  sessionMinutes: number | null
  downKbps: number | null
  upKbps: number | null
  portalIds: number[] | null // null = every portal
  lastLoginAt: string | null
  activeDevices: number
  createdAt: string | null
}

type PortalApiClient = {
  id: number
  name: string
  prefix: string // `perch_pa_` + 4 characters
  scopes: ('authorize' | 'read')[]
  portalIds: number[]
  maxMinutesPerCall: number
  maxBytesPerCall: number
  maxActiveGrants: number
  activeGrants: number
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string | null
  createdByUserId: number | null
}

type PortalTemplate = {
  id: number
  name: string
  builtin: boolean
  sha256: string // set digest (§12.2); builtin: sha256("")
  totalBytes: number
  inUse: number[] // live portals using it
  files: { name: string; contentType: string; bytes: number; sha256: string }[]
  variables: string[]
  createdAt: string | null
  updatedAt: string | null
}

type PortalSession = {
  id: number
  grantId: number
  portalId: number
  mac: string
  ip: string | null
  startedAt: string | null
  endedAt: string | null
  bytesUp: number
  bytesDown: number // open session: live (grant counters − start)
  endReason: string | null
}
```

### 11.4 Dashboard routes

| Method, path                                                         | Auth | Request                                                                                                                                                                                                                                    | Response                                                                                                                                                                                                                                          | Errors                                                                                                                                                                        |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/portal/portals`                                                | R    | `?gatewayId`                                                                                                                                                                                                                               | `Portal[]` (not deleted)                                                                                                                                                                                                                          | –                                                                                                                                                                             |
| GET `/portal/portals/:id`                                            | R    | –                                                                                                                                                                                                                                          | `Portal`                                                                                                                                                                                                                                          | 404 `portal_not_found`                                                                                                                                                        |
| POST `/portal/portals`                                               | A    | `{gatewayId, name 1–80, networkPerchId, methods? {voucher =true, password =false}, templateId? (default builtin; null = none), cspConnectSrc? ≤16, privacyNotice? ≤2000, force?}`                                                          | 201 `{portal, delivery}`; pushes `configure`, `template`                                                                                                                                                                                          | 404 `gateway_not_found`, `template_not_found`; 409 `portal_exists`; 422 `network_not_found`, `network_hosts_controller` (the gateway's management network; `force` overrides) |
| PATCH `/portal/portals/:id`                                          | A    | same fields, all optional (`networkPerchId` moves the portal)                                                                                                                                                                              | `{portal, delivery}`; a change bumps `revision`, pushes `configure` (+ `template`)                                                                                                                                                                | 404; 409 `portal_exists`; 422 as above                                                                                                                                        |
| DELETE `/portal/portals/:id?force=1`                                 | A    | –                                                                                                                                                                                                                                          | 204; grants ended `revoked` (with force), row soft-deleted, `configure` pushed                                                                                                                                                                    | 404; 409 `portal_active_grants` `{activeGrants}` (live grants, no force)                                                                                                      |
| GET `/portal/grants`                                                 | R    | `?portalId&gatewayId&voucherId&state=active\|live\|queued\|ended\|all (=active: not ended)&mac&source&limit&offset`                                                                                                                        | `{items: PortalGrant[], total}` newest first                                                                                                                                                                                                      | 422 `invalid_mac`                                                                                                                                                             |
| POST `/portal/grants/:id/extend`                                     | A    | `{minutes? 1–525600, bytes? 1–1e13}` (≥ one)                                                                                                                                                                                               | `{grant, delivery}`                                                                                                                                                                                                                               | 404 `grant_not_found`; 409 `grant_ended`, `grant_not_extendable` (voucher grant); 422 `nothing_to_extend` `{field}`                                                           |
| POST `/portal/grants/:id/revoke`                                     | A    | –                                                                                                                                                                                                                                          | `{grant, delivery}` (ended `revoked`; the device's next queued entitlement is promoted)                                                                                                                                                           | 404                                                                                                                                                                           |
| GET `/portal/sessions`                                               | R    | `?portalId&gatewayId&grantId&mac&from&to&limit&offset` (sessions overlapping `[from, to]`)                                                                                                                                                 | `{items: PortalSession[], total}` newest first                                                                                                                                                                                                    | 422 `invalid_range`, `invalid_date`, `invalid_mac`                                                                                                                            |
| POST `/portal/voucher-batches`                                       | A    | `{portalId? null, name 1–80, note? ≤500, count 1–1000, codeLength 8–16 =10, durationMinutes? 1–525600, durationMode ='wall_clock', startMode ='first_use', quotaBytes? 1e6–1e13, downKbps?/upKbps? 64–1e7, maxDevices 1–10 =1, redeemBy?}` | 201 `{batch, codes: string[], delivery}` (formatted codes, once); pushes `vouchers` for a bound batch                                                                                                                                             | 404 `portal_not_found`; 422 `no_limit`, `start_mode_requires_wall_clock`, `redeem_by_past`, `invalid_date`                                                                    |
| GET `/portal/voucher-batches`                                        | A    | `?portalId`                                                                                                                                                                                                                                | `VoucherBatch[]` newest first                                                                                                                                                                                                                     | –                                                                                                                                                                             |
| GET `/portal/voucher-batches/:id`                                    | A    | –                                                                                                                                                                                                                                          | `{batch, vouchers: Voucher[]}`                                                                                                                                                                                                                    | 404 `batch_not_found`                                                                                                                                                         |
| GET `/portal/voucher-batches/:id/codes`                              | A    | –                                                                                                                                                                                                                                          | `{batch, vouchers}` with `code` (print sheet)                                                                                                                                                                                                     | 404; 410 `codes_unrecoverable` (APP_KEY rotated)                                                                                                                              |
| GET `/portal/voucher-batches/:id/codes.csv`                          | A    | –                                                                                                                                                                                                                                          | `text/csv` attachment `perch-vouchers-batch-<id>.csv`, CRLF, every cell quoted, cells starting `= + - @` prefixed `'`; columns `code,hint,status,batch_id,batch_name,duration_minutes,duration_mode,quota_bytes,max_devices,redeem_by,expires_at` | 404; 410                                                                                                                                                                      |
| POST `/portal/voucher-batches/:id/revoke`                            | A    | –                                                                                                                                                                                                                                          | `{batch, delivery}` (idempotent; grants of its vouchers ended `revoked`)                                                                                                                                                                          | 404                                                                                                                                                                           |
| DELETE `/portal/voucher-batches/:id`                                 | A    | –                                                                                                                                                                                                                                          | 204                                                                                                                                                                                                                                               | 404; 409 `batch_used` (a voucher was redeemed: revoke instead)                                                                                                                |
| GET `/portal/vouchers`                                               | A    | `?batchId&portalId&status&limit&offset`                                                                                                                                                                                                    | `{items: Voucher[], total}`                                                                                                                                                                                                                       | –                                                                                                                                                                             |
| POST `/portal/vouchers/lookup`                                       | A    | `{code}` (any spelling)                                                                                                                                                                                                                    | `{voucher, batch, grants: PortalGrant[] (≤100)}`                                                                                                                                                                                                  | 404 `voucher_not_found`                                                                                                                                                       |
| POST `/portal/vouchers/:id/revoke`                                   | A    | –                                                                                                                                                                                                                                          | `{voucher, delivery}`                                                                                                                                                                                                                             | 404 `voucher_not_found`                                                                                                                                                       |
| GET / POST `/portal/users`                                           | A    | POST `{username ^[a-z0-9._-]{3,32}$, password 8–64, displayName?, enabled =true, maxDevices 1–10 =2, sessionMinutes?, downKbps?, upKbps?, portalIds? (null = all)}`                                                                        | `PortalUser[]` / 201 `PortalUser`                                                                                                                                                                                                                 | 404 `portal_not_found`; 422 `username_taken`                                                                                                                                  |
| PATCH `/portal/users/:id`                                            | A    | fields as POST, optional, no password                                                                                                                                                                                                      | `PortalUser` (limits changed: live grants resent; disabled: grants ended `revoked`)                                                                                                                                                               | 404 `portal_user_not_found`; 422 `username_taken`                                                                                                                             |
| PUT `/portal/users/:id/password` · DELETE `/portal/users/:id`        | A    | `{password}` / –                                                                                                                                                                                                                           | 204 / 204 (grants ended)                                                                                                                                                                                                                          | 404                                                                                                                                                                           |
| GET / POST `/portal/api-clients`                                     | A    | POST `{name, portalIds ≥1, scopes ≥1 of authorize\|read, maxMinutesPerCall 1–10080 =1440, maxBytesPerCall 1e6–1e13 =1e10, maxActiveGrants 1–5000 =500}`                                                                                    | `PortalApiClient[]` / 201 `{client, token}`                                                                                                                                                                                                       | 404 `portal_not_found`                                                                                                                                                        |
| PATCH `/portal/api-clients/:id` · POST `/:id/rotate` · DELETE `/:id` | A    | fields / – / –                                                                                                                                                                                                                             | `PortalApiClient` / `{client, token}` / 204 (revoked; row and grants stay)                                                                                                                                                                        | 404 `api_client_not_found`; 409 `api_client_revoked`                                                                                                                          |
| GET / PATCH `/settings/portal`                                       | A    | partial §8 settings                                                                                                                                                                                                                        | `{settings, defaults, limits}`; PATCH pushes `sync` to every gateway with a portal                                                                                                                                                                | 422                                                                                                                                                                           |
| Templates                                                            | A    | §12.3                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                   |                                                                                                                                                                               |

### 11.5 Grant rules the routes apply

- **Extend** (`/grants/:id/extend`): `g:` grants grow their own limits: a
  running wall clock moves on from `max(deadline, now)`, a waiting one
  (queued) and an active-time budget grow the budget; bytes add to an existing
  quota. `u:` grants move the login deadline. A limit the grant does not have
  is `nothing_to_extend`: extending never turns "unlimited" into a limit.
- **Revoke / end** (every path): the grant's session closes with
  `bytes = counters − start`; a grant that was on the router is pushed as
  `deauthorize`; then the device's next queued entitlement on that portal is
  promoted (`authorize` push) and its waiting wall clock starts: a first-use
  voucher's (voucher revision + 1, `vouchers` push) or an API/admin grant's.
  Reconciliation does the same (`grantClocks`, §7).
- A deleted portal's grants end without promotion.

### 11.6 Authorize API (decision 22; the Paid Hotspot API)

Routes, all **K**, `Cache-Control: no-store`:

| Method, path                                   | Scope       | Request                                                                                                                                                                                          | Response                                                                                                                     | Errors                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/portal/authorizations`                  | `authorize` | `{portalId, mac, minutes? 1–525600, bytes? 1–1e13, durationMode? ='wall_clock', downKbps?, upKbps? 64–1e7, mode? 'extend'\|'replace' ='extend', externalRef? [A-Za-z0-9._:-]{1,64}, note? ≤200}` | 201 created / 200 extended or replayed: `{grant: PortalGrant \| null, delivery, outcome: 'created'\|'extended'\|'replayed'}` | 401 `invalid_api_token`; 403 `scope_required` `{scope}`, `portal_not_allowed`, `admin_required`, `password_change_required`; 404 `portal_not_found`; 409 `idempotency_conflict`; 422 `no_limit`, `limit_exceeded` `{field, max}`, `too_many_active_grants` `{max}`, `invalid_mac`; 429 `rate_limited` + `Retry-After` |
| GET `/portal/authorizations/:mac?portalId=`    | `read`      | –                                                                                                                                                                                                | `{grant: PortalGrant \| null}`: the device's live grant, else its first queued one                                           | as above; 422 without `portalId`                                                                                                                                                                                                                                                                                      |
| DELETE `/portal/authorizations/:mac?portalId=` | `authorize` | –                                                                                                                                                                                                | `{grant, delivery}` (the live one, ended `revoked`)                                                                          | as above; 404 `no_active_grant`                                                                                                                                                                                                                                                                                       |

**`portalApiAuth`.** `Authorization: Bearer <token>`:

- `perch_pa_` + 32 base64url characters: an API client. Only the token's
  SHA-256 is stored (unique index, then a constant-time compare). A revoked
  client is 401.
- Any other bearer: a controller access token, accepted for an **admin**
  without a pending password change (operators and viewers: 403
  `admin_required`). Admins act on every portal with every scope and no
  per-call caps; their grants are `source: 'admin'`.
- Missing or invalid: 401 `invalid_api_token`, and one failure charged to
  the caller's address (`request.ip()`, `TRUST_PROXY` rules): 20 failures in
  15 minutes and the address gets 429 for the rest of the window, before any
  token lookup.
- Every authenticated request counts against its principal (`c:<id>` /
  `u:<id>`): `apiRequestsPerClientPerMinute` (setting, default 120) per fixed
  minute, else 429 `rate_limited` + `Retry-After`. Both limiters are
  in-process bounded maps (4096 principals, 1024 addresses).

**Semantics.**

- **Scope and portal first.** A client's `portalIds` are checked before the
  portal is looked up: 403 `portal_not_allowed` for any id outside them, so a
  token cannot probe which portals exist. A listed but deleted portal is 404.
- **Ownership.** A client acts only on grants it made (`api_client_id`): it
  extends, replaces, reads and ends its own, never a voucher, user or other
  client's grant. An admin owns every `api`/`admin` grant (and `DELETE` with
  an admin token ends every grant of the device on the portal).
- **`mode: 'extend'`** (default) grows the principal's own non-ended grant for
  the device when that grant has the limits the call adds (minutes: a timed
  grant of the same `durationMode`; bytes: a grant with a quota); the live one
  first, then the newest. Otherwise a **new** grant is made.
- **`mode: 'replace'`** ends the principal's own grants for the device
  (`replaced`) and makes a new one.
- **A new grant** (`source: 'api'|'admin'`, group `g:<id>`): runs at once
  when the device has nothing live on the portal (wall clock starts now).
  Otherwise decision 23 places it: a time grant over a running data bucket
  swaps (the bucket is queued, `deauthorize` pushed); anything else is
  `queued` (`delivery: 'applied'`, nothing pushed) and its wall clock waits
  (`expires_at` null, `time_budget_seconds` set) until it is promoted, so paid
  time never runs down behind a voucher.
- **Caps** (clients only): `minutes ≤ maxMinutesPerCall`,
  `bytes ≤ maxBytesPerCall` (422 `limit_exceeded`); a new grant needs fewer
  than `maxActiveGrants` non-ended grants of the client (422
  `too_many_active_grants`; extending an existing one is still allowed).
- **Idempotency.** `externalRef` is unique per principal in
  `portal_authorizations` (the coin box's payment id). The same ref with the
  same request (SHA-256 of `[portalId, mac, minutes, bytes, durationMode,
downKbps, upKbps, mode]`; `note` excluded) answers 200 `replayed` with the
  grant as it is now and credits nothing; a different request is 409
  `idempotency_conflict`. A paid call is never lost: with the gateway offline
  it is stored and answered `delivery: 'pending'`. Ledger rows are pruned with
  the portal history (`sessionRetentionDays`), after which a ref could be
  reused.
- **Ledger** `portal_authorizations`: `principal, api_client_id,
created_by_user_id, external_ref, portal_id, grant_id, mac, outcome
(created|extended), minutes, bytes, request_sha, via (http|relay), address,
created_at`. `api_clients.last_used_at` is updated per accepted call.

**The Paid Hotspot API.** For paid-hotspot integrations such as
coin-operated vending boxes. No coin component: a custom template (§12) reads
`{{client_mac}}` / `{{status_json}}`, talks to the operator's coin box on the
guest subnet (its origin listed in the portal's `cspConnectSrc`, which only
takes `http(s)://` / `ws(s)://` origins without path, lower-cased, at most
16), and the coin box calls `POST /portal/authorizations` with its own token,
`mac`, the paid `minutes`/`bytes` and the payment id as `externalRef`. With
the router relay (WP3/WP4, `portal.relay`), the box can stay on the guest
network and never reach the controller.

**Relay (for WP3).** The socket side calls the same service functions
(`app/services/portal_authorize.ts`):

```ts
authenticatePortalApiToken(token: string): Promise<PortalApiClient | null>   // portal_api_clients.ts
clientPrincipal(client): PortalPrincipal
authorizeDevice(principal, input: AuthorizeInput, ctx: AuthorizeCallContext): Promise<AuthorizeResult>
deviceAuthorization(principal, portalId, mac, ctx): Promise<{ grant }>
deauthorizeDevice(principal, portalId, mac, ctx): Promise<{ grant, delivery }>
type AuthorizeCallContext = { via: 'http' | 'relay'; address: string | null; gatewayId?: number }
// errors: PortalError { httpStatus, code, message, extra } → relay answers {status, body: {error, message, ...extra}}
```

With `via: 'relay'` the caller must pass `gatewayId` = the relaying gateway
(its portals only, else 403 `portal_not_allowed`), only `perch_pa_` tokens are
accepted (never a controller access token: those must never be typed on a
guest network), the rate limits apply per client exactly as over HTTP
(`consumePortalApiRequest`) and failed tokens are charged per relaying
gateway (`recordPortalApiAuthFailure('relay:<gatewayId>')`). The relay body is
validated with `authorizeValidator` like HTTP.

**Threat model (decision 22: extra scrutiny).**

| Threat                                                               | Mitigation                                                                                                                                                                                                      | Residual                                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaked or stolen API token (coin box compromised, token in a script) | Scoped: its portals only, its scopes, per-call caps, `maxActiveGrants`, own grants only; rate-limited; hash-only storage; rotate (old dies at once) and revoke; every call in the ledger with address and `via` | Until revoked it can put any MAC online on its portals within the caps. It cannot read or end others' grants, see vouchers, codes, users or other clients, or change any setting |
| Token brute force                                                    | 192-bit tokens; 20 failures / 15 min per address → 429 before any lookup                                                                                                                                        | None practical                                                                                                                                                                   |
| Replayed or duplicated payment                                       | `externalRef` idempotency with request hash; replay answers without credit                                                                                                                                      | A box that omits `externalRef` gets no protection (documented for integrators)                                                                                                   |
| Portal enumeration by a token                                        | 403 for every portal outside its list, existing or not                                                                                                                                                          | –                                                                                                                                                                                |
| Admin token exposure through the relay                               | Relay accepts only `perch_pa_` tokens                                                                                                                                                                           | –                                                                                                                                                                                |
| Integration flooding the router with grants                          | `maxActiveGrants` per client, per-minute limit, deltas coalesced in the outbox                                                                                                                                  | A client may still churn within its limits                                                                                                                                       |
| CSP injection through `cspConnectSrc`                                | Origin-only regex (scheme, host, port), lower-cased, ≤ 16                                                                                                                                                       | –                                                                                                                                                                                |
| Custom page script (Paid Hotspot API page)                           | Runs only on the router's portal origin (§12.1); never served by the controller                                                                                                                                 | A malicious admin-uploaded page can phish guests on the portal: admins are trusted                                                                                               |
| Guest spoofing a paying device (MAC cloning)                         | Out of scope for the API (L2 portal, §10 of the design)                                                                                                                                                         | Accepted                                                                                                                                                                         |

### 11.7 Deviations from the design's §7

- Portals are created on `{gatewayId, networkPerchId}` (decision 19), not
  `{collectorId, network}`; errors `gateway_not_found`, `network_not_found`.
- No `native` settings and no `configChange` in answers: the router's
  enforcement is Perch's own (decision 27). `collector_not_capable` is not
  refused: the portal is
  created and `gateway.portalCapable` shows the capability.
- No 503 `gateway_offline`: every change is queued (`delivery`).
- Authorize answers `delivery: 'applied' | 'pending'` (design: `'queued'`),
  plus `outcome`.
- `PortalGrant` gains `revision`, `createdBy`, `note`, `lastSeenAt`,
  `timeUsedSeconds`, `state: 'queued'`, end reasons `moved`, `rejected`; no
  `external` source (decision 25); `group` carries the limits.
- `grant_not_extendable`, `nothing_to_extend`, `api_client_revoked`,
  `template_file_not_found`, `duplicate_file`, `file_required`,
  `invalid_date`, `invalid_range`, `redeem_by_past`, `no_active_grant` are new
  codes; `DELETE /portal/api-clients/:id` revokes (row kept for the audit).
- `GET /voucher-batches/:id/codes.csv` added (server-side CSV).
- Grants and sessions lists also filter by `gatewayId`, `voucherId`,
  `grantId`; grant states `live` and `queued` added.

## 12. Templates (WP2)

### 12.1 Isolation, not sanitising

HTML is not sanitised (admins are trusted; a coin page needs scripts). It is
isolated: on the router it runs on the portal's own origin under the design's
CSP (`connect-src 'self' <cspConnectSrc>`), and the controller never serves
template content as a document: there is no file download route, and the
preview is JSON for `<iframe sandbox="allow-scripts allow-forms" srcdoc>`
(never `allow-same-origin`, `allow-top-navigation`, `allow-popups`). Only
admins upload; API clients cannot.

### 12.2 Upload rules (`portal/templates.ts`)

- ≤ 24 files, each ≤ 512 KiB (HTML ≤ 256 KiB), ≤ 2 MiB in total (413
  `template_too_large`); `login.html` required (422 `missing_login_page`);
  names `^[a-z0-9][a-z0-9._-]{0,63}$`, no directories (422 `bad_file_name`);
  no duplicate names (422 `duplicate_file`).
- Types by extension **and** content (422 `unsupported_type`): `html css js
txt svg` must be UTF-8 without NUL (SVG must contain `<svg`); `png jpg jpeg
gif webp ico woff2` must start with their magic bytes.
- Variables `{{ name }}` are only substituted (and checked) in `.html`
  files; an unknown name is 422 `unknown_variable` `{file, line, name,
variables}`. Known: `portal_name gateway_name client_mac client_ip
origin_url message message_code assets remaining_time remaining_data
expires_at privacy_notice methods status_json voucher_form login_form
logout_form checkout_form clickthrough_form receipt reference_code` (the last
four: §14.8). All are HTML-escaped except `status_json` (JSON with `< > &`
  as `< > &`) and the snippets (`voucher_form login_form logout_form
  checkout_form clickthrough_form receipt`: raw; a method the portal
  does not offer renders empty). `origin_url` is http(s) only.
- **Set digest** (what `portal.configure`/`portal.template` compare):
  `sha256( for each file sorted by name: name "\n" sha256hex(content) "\n" )`;
  the empty set is `sha256("")` = the builtin marker.

### 12.3 Routes (all A)

| Method, path                               | Request                                                         | Response                                                                                                                                                                                                                                                       | Errors                                                        |
| ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| GET `/portal/templates` · `/:id`           | –                                                               | `PortalTemplate[]` (builtin first) · `PortalTemplate`                                                                                                                                                                                                          | 404 `template_not_found`                                      |
| POST `/portal/templates`                   | multipart `name`, `files` (repeat the field)                    | 201 `PortalTemplate`                                                                                                                                                                                                                                           | 413, 422 as §12.2; 422 `too_many_files`                       |
| POST `/portal/templates/:id/duplicate`     | `{name}`                                                        | 201 `PortalTemplate` (the builtin's files are copied from the compiled-in set)                                                                                                                                                                                 | 404                                                           |
| PUT `/portal/templates/:id/files/:name`    | multipart `file` (stored under `:name`)                         | `PortalTemplate`; pushes `template` to portals using it                                                                                                                                                                                                        | 403 `builtin_template`; 413; 422 as §12.2, `file_required`    |
| DELETE `/portal/templates/:id/files/:name` | –                                                               | `PortalTemplate`                                                                                                                                                                                                                                               | 403; 404 `template_file_not_found`; 422 `login_page_required` |
| PATCH / DELETE `/portal/templates/:id`     | `{name}` / –                                                    | `PortalTemplate` / 204                                                                                                                                                                                                                                         | 403 `builtin_template`; 409 `template_in_use` `{portalIds}`   |
| GET `/portal/templates/:id/preview`        | `?page=login\|status (=login)&message=<message_code>&portalId=` | `{html, page, messageCode}` (`no-store`); every `{{assets}}/<file>` becomes a data URI of that file (missing: `data:,`); sample values, or the portal's name, methods and privacy notice with `portalId`; a set without `status.html` previews the builtin one | 404 `template_not_found`, `portal_not_found`; 422             |

CSS `url()` references inside a stylesheet are not rewritten in previews
(relative URLs do not resolve inside a data URI); use `{{assets}}` in HTML.

### 12.4 The builtin template (for WP4)

`app/services/portal/builtin_template.ts` holds the builtin pages
(`login.html`, `status.html`, `style.css`, `checkout.js` since §14; no
inline script), the snippets (`portalSnippets(methods, hotspot)`: forms
posting to `/portal/voucher`, `/portal/login`, `/portal/logout`, and the
§14.8 checkout, receipt and click-through snippets) and the guest message texts
(`PORTAL_MESSAGES`, keyed by `message_code`). The collector must embed the
same files, snippets and texts; the seeded row keeps the empty-set digest.

## 13. Collector socket (WP3, branch `gw/portal-sock`)

Code: `app/services/portal_agent.ts` (sessions, sender, connect sequence,
deliveries, retries, key rotation), `portal_guest.ts` (`portal.redeem`,
`portal.login`), `portal_relay.ts` (`portal.relay`), `portal_shaping.ts`
(QoS seam), `portal/delta.ts` (pure deltas), the hub's `onRequest`
(`agent_hub.ts`), migration `077`. Decision 27 applies throughout: the router
enforces with Perch's own nftables table, so nothing here reads or writes
openNDS or the config plane. The portal's router configuration is Perch
runtime data sent in `portal.configure`.

### 13.1 Agent requests on the hub

`AgentHub.onRequest(method, handler)` answers agent → server requests
(`handler(rowId, params)`, one per method). A resolved value is the `result`
(`undefined` → `null`); an `AgentRpcError` answers its code, message and
`data`; any other error answers -32603 and is logged; no handler answers
-32601. At most `MAX_AGENT_REQUESTS_IN_FLIGHT` (32) requests per session are
answered at a time; more get -32000 `{error: 'busy'}`. A session that closed
while its handler ran gets no answer.

### 13.2 RPC table (as built, aligned with perch-collector `internal/portal`)

Server → router (requests, 15 s timeout; `portal.sync` 30 s):

| Method               | Params                                                                                                                                                                                                                                                                                                              | Result                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal.configure`   | `{revision, gatewayId, keys?: {epoch, gatewayKey}, settings, storage?: {path?, flushIntervalSeconds?}, portals: [{portalId, name, network, enabled, methods, templateSha256, cspConnectSrc, privacyNotice, gatewayName, walledGarden, relay}]}` (the gateway's complete portal set; a portal not listed is removed) | `{revision, keyEpoch, missingTemplates: [sha], portals: [{portalId, device, state, listen, counting, issues}], enforcement, storage, issues}` |
| `portal.template`    | `{sha256, files: [{name, contentType, dataBase64}]}`                                                                                                                                                                                                                                                                | `{stored: true}`                                                                                                                              |
| `portal.authorize`   | §6.4 (full or delta)                                                                                                                                                                                                                                                                                                | `{results: [{grantId, localRef?, revision, state: active\|pending_device\|rejected, error?}], ended: [{grantId, localRef?}]}`                 |
| `portal.deauthorize` | §6.4                                                                                                                                                                                                                                                                                                                | `{ended: [grantId]}`                                                                                                                          |
| `portal.vouchers`    | §6.4                                                                                                                                                                                                                                                                                                                | `{stored, rejected}`                                                                                                                          |
| `portal.sync`        | `{ackedEventSeq}`                                                                                                                                                                                                                                                                                                   | `RouterPortalReport` (§7)                                                                                                                     |

- `settings` = the §8 values the router enforces: `enforceIntervalSeconds,
usageIntervalSeconds, guestFailuresPerDevicePerMinute,
guestFailuresPerDevicePerHour, guestFailuresPerPortalPerMinute,
preauthDnsPerDevicePerMinute, offlineRedemption` (false also when
  `offlineVoucherLimit` is 0).
- `network` is the portal network's `interface` section name from the config
  plane's ledger (`gateway_sections`). A portal whose section is unknown is
  left out and its status reads `state: 'error'`, issue `network_unknown`.
- `templateSha256` is the template's set digest, `sha256("")` for the
  builtin (or no template). `walledGarden` is `[]` (no controller field yet).
- `relay` is true when a non-revoked API client lists the portal: the router
  then serves `/portal/v1/authorizations` (§13.6).
- `storage` carries the gateway's `local_state_path` /
  `local_state_flush_seconds` overrides (decision 18) when set.

Router → server:

| Method            | Kind         | Params → result                                                                                                                     |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `portal.redeem`   | request      | `{portalId, mac, ip, hostname?, code, replace?}` → `{grant: WireGrant & {sig}, group: WireGroup & {sig}, queued}`                   |
| `portal.login`    | request      | `{portalId, mac, ip, hostname?, username, password, replace?}` → same                                                               |
| `portal.relay`    | request      | `{portalId, op: authorize\|status\|deauthorize, mac?, token, body?, clientIp}` → `{status, body}`                                   |
| `portal.event`    | notification | one `RouterEvent` (§7): schedules a full sync within `eventSyncDelay` (1 s), coalesced per gateway                                  |
| `portal.sessions` | notification | `{collectedAt, clients, preauthCount, portals}`: stamps `last_report_at`; a sync when the last is older than `usageIntervalSeconds` |

Refusals of `portal.redeem` / `portal.login` are -32000 with `data.error` ∈
`invalid_code | invalid_credentials | expired | exhausted | revoked |
disabled | device_limit | wrong_portal | rate_limited | bad_request`. A queued
entitlement answers `{grant: null, group: null, queued: true}`.

### 13.3 Capability and status

- The hello's `capabilities` list containing `portal` makes the gateway
  portal-capable. Its `portal` object `{version, keyEpoch, configRevision,
enforcement, storage, port, maxPortals}` is stored in
  `portal_gateway_states.capabilities` (null = not capable) with
  `capabilities_at`; `keyEpoch` becomes `router_key_epoch`.
  `Portal.gateway.portalCapable` reads it (fallback: the config plane's
  `gateways.capabilities.portal`).
- A gateway needs a `gateways` row (the config plane creates it) for any of
  this; a collector without one gets no portal calls.
- Each `portal.configure` bumps `config_revision`; the answer sets
  `router_config_revision`, `configured_at`, `router_status`
  (`{enforcement, storage, issues, at}`) and each listed portal's
  `status` (`{revision, templateSha256, state, device, counting, issues,
listen, at}`) and `applied_revision`. `Portal.status` in the REST view is now
  `{state: active|disabled|waiting_device|error|unknown, device, counting,
issues, listen, revision, appliedRevision, delivery, clients, lastReportAt,
lastConfiguredAt}` (the WP2 `openNds` / `fas` fields are gone, decision 27).

### 13.4 Connect sequence and deliveries

On every hello of a portal-capable gateway, inside its portal queue:

1. `portal.configure` (with `keys` when `router_key_epoch ≠ key_epoch`), then
   `portal.template` for each sha in `missingTemplates`.
2. `portal.sync` → `loadServerPortalState` → `reconcile` →
   `applyPortalDbChanges`.
3. `portal.authorize {full: true}` with the inserted grant ids bound; its
   results acknowledge delivery (`delivered`), its `ended` list acknowledges
   removals.
4. `portal.vouchers` (the list after reconciliation, so it reflects the
   offline redemptions just recorded).
5. Shaping sync (§13.7).
6. Outbox rows older than the sequence are dropped (it covered them), the
   gateway is marked ready, newer rows are drained.

A gateway with no portal rows whose router reports no `configRevision` is
marked ready without any call.

**Sender** (`SocketPortalAgentSender`, installed by `attachPortalAgent`): every
push is enqueued; when the gateway is ready the outbox is drained at once and
the answer is `applied` only if every row was acknowledged. **Drain**: rows in
id order are deleted, then delivered in the order configure, template, sync,
deauthorize, authorize, vouchers (a `sync` row makes the deltas redundant):

| Push          | Delivery                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `configure`   | `portal.configure` for the gateway                                                                                                             |
| `template`    | `portal.template` for the portal's template (not builtin), then `portal.configure`                                                             |
| `authorize`   | `portal.authorize {full: false}` with the ids' **live** grants and their groups (`portalDelta`: same `base*` as the full set); results applied |
| `deauthorize` | `portal.deauthorize` per reason (the grant's `end_reason`, `queued` for a queued grant) for the ids that are not live any more; removals acked |
| `vouchers`    | `portal.vouchers` with `offlineVoucherList`                                                                                                    |
| `sync`        | `portal.configure` (settings live there) + a full sync                                                                                         |

**Failures.** The undelivered pushes go back to the outbox (`attempts + 1`,
`last_error`), `portal_gateway_states.delivery_failures/_error/_failed_at`
record it, and a retry runs after `2 s · 2^(n−1)` (±20 %, at most 5 min) in
the gateway's queue. An offline gateway just waits for its reconnect. A
refusal `no_keys`, `key_epoch_mismatch` or `bad_signature` clears
`router_key_epoch`, so the retry sends the key first. A successful drain
resets the failure count.

### 13.5 Online sign-in (`portal_guest.ts`)

Both run in the gateway's queue; the portal must be the gateway's, live and
offer the method (else `wrong_portal` / `disabled`).

- **Redeem**: normalized code → `code_hash` → voucher (row locked) →
  `planVoucherRedemption` with the voucher group's holders and the device's
  current entitlement. Evicted devices end `moved` (their queues promoted),
  the voucher is bound, first-used and clocked (first writer), a swap queues
  the data bucket, and the new grant is `pending_device` (or `queued`).
- **Login**: `planUserLogin` with `deviceUnseenEvictMinutes`; `replace: true`
  turns `device_limit` into "the device that joined first leaves"
  (`replaced`). The grant's own deadline is `sessionMinutes`.
- **Retries are idempotent**: the same code (or user) from a device that
  already holds it answers that grant.
- **Answer**: the grant and its group, each signed (`signGrant` /
  `signGroup`) under the current epoch, `base*` as in the full set. The
  router applies it at once; its delivery is acknowledged by the next sync.
  Pushes for everything else the sign-in changed (the evicted device, a
  swapped bucket, the offline list) go out right after the answer.
- **Deadline**: the router redeems offline from its own list only when the
  controller session is gone (no socket). A live session that stays silent
  for 8 s gets `controller_unreachable` on the guest page, never an offline
  redemption: the controller may still be spending the code. A sign-in that
  has not started within 5 s (queued behind a long sync) is dropped
  unstarted and answered `controller_unreachable` as well, so the same code
  is never spent twice.
- **Brute force**: failures only, 15-minute windows, bounded map (4096):
  `controllerFailuresPerDevicePer15Minutes` per (portal, MAC) for both;
  `controllerFailuresPerUsernamePer15Minutes` per (portal, username) for
  logins. An unknown username costs a hash verify like a wrong password.

### 13.6 Router relay: the Paid Hotspot API (decision 22)

`portal.relay` serves the router's `/portal/v1/authorizations[/:mac]` for
paid-hotspot integrations such as coin-operated vending boxes on the guest
network. The router passes the request untouched; the controller answers
`{status, body}` with exactly the HTTP API's bodies (§11.6: `{data: …}`, or
`{error, message, …}`, or 422 `{errors}`).

- Only `perch_pa_` tokens: anything else (a controller access token
  included) is 401 `invalid_api_token`.
- Failed tokens are charged to `relay:<gatewayId>`: 20 in 15 minutes and the
  gateway's relay answers 429 before any lookup.
- Accepted calls count against the client's `apiRequestsPerClientPerMinute`
  (429 `rate_limited`, `retryAfterSeconds` in the body: no headers cross the
  socket).
- The portal is the one the request came in on (`portalId` of the relay
  params); a `portalId` in the body is overwritten. It must be one of the
  relaying gateway's, and the client's `portalIds` apply (403
  `portal_not_allowed`), as do scopes, caps, ownership and idempotency.
- The ledger records `via: 'relay'` and the guest-side `clientIp`.
- The router adds its own per-address and per-portal limits before asking.

### 13.7 Shaping seam (`portal_shaping.ts`)

Speed caps and single-device quotas go to traffic shaping through
`PortalShaping { sync(gatewayId, entries), apply(gatewayId, upserts,
releases) }`. An entry is `{sourceRef: 'portal-grant:<id>' |
'portal-local:<portalId>:<localRef>', portalId, mac, downKbps, upKbps,
quotaBytes, expiresAt}`; `quotaBytes` is what is left of a one-device group
(a shared quota cannot be split per device: the router's tick stays its only
enforcement). Full syncs call `sync` with the complete set, deltas `apply`.
Every call is best effort: errors are logged, never fail a delivery.

**Wired** (integration, 2026-09-23): the default is `QosPortalShaping`
(`portal_qos_shaping.ts`) over `qos_shaping.ts`. Each entry becomes a
`source: 'portal'` device assignment with the entry's `sourceRef`, its own
rate (`downKbps`/`upKbps` in kbit/s, no tier policies), `expiresAt`, and a
`block` quota when `quotaBytes` is given. Rules: only a gateway in managed
mode is shaped (otherwise a no-op); an admin's cap on the MAC wins
(`qos_mac_assigned`, logged); refusals (e.g. a rate below the device floor)
are logged and skipped; the quota is set once, when the assignment first
gets it, and kept on later updates (QoS counts the bytes from then on, so the
portal's shrinking "bytes left" would count the usage twice); an entry past
its expiry, or with nothing left to shape, is released. `sync` releases the
gateway's portal assignments (`portal-grant:*`, `portal-local:*`) missing
from the set. The shaper's `quota_exhausted` for a portal assignment is
written to `portal_events` as `shaping_quota_exhausted` (`grant_id` from
`portal-grant:<id>`). Tests can install another implementation with
`setPortalShaping` (`NoopPortalShaping`).

A portal device stays inside its network's shaping (2026-09-24): the planner
puts it in the bucket of the portal network's default and never lets its cap
exceed that network's per-device cap (`docs/gateway/qos.md` section 3.2).

### 13.8 Key epoch rotation

`POST /api/v1/portal/gateways/:gatewayId/rotate-key` (admin; 404
`gateway_not_found`) → `{data: {keyEpoch, delivery}}`. The new epoch is
`max(key_epoch, router_key_epoch) + 1` (never an epoch the router already
had); `key_rotated` is logged with the admin. A `configure` (it carries the
key, the epochs now differ) and a `sync` (re-signs every grant, new voucher
verifiers) are queued and drained at once when the gateway is ready;
otherwise the reconnect does it. A router that reports an epoch above the
controller's (restored database) makes the controller move past it the same
way.

### 13.9 Deviations from the WP1/WP3 contract

- **Connect order**: configure → template → sync → reconcile → full authorize
  → vouchers. The vouchers go after reconciliation, not before the sync: a
  list built before it would re-offer the router vouchers it spent offline
  under older revisions.
- **`portal.configure` is per gateway**, not per portal (design §6): one
  message with every portal, the key and the settings, as the router builds
  it. `configure:<portalId>` outbox rows all deliver the same message.
- **`replace`** on redeem has no effect (a voucher always moves to the newest
  device, decision 23); on login it allows evicting the oldest device.
- **Username limiter key** is (portal, username), not (username, MAC): per
  device is already covered by the device limiter.
- **No openNDS**: no `readOpenNds` / `proposeOpenNds`, no `native` config;
  the portal status reports Perch's enforcement.

### 13.10 Offline voucher list: parts and `firstUsedAt`

- **Parts.** `offlineVoucherLimit` goes up to 50 000, which as one message
  would exceed the kit's 4 MiB frame. `buildVouchersMessages` splits the list
  into messages of at most `VOUCHERS_PER_MESSAGE` (4000, ~0.6 KB each):
  `{enabled, serverNow, nonce, keyEpoch, vouchers, append, part, parts, sig}`.
  Part 1 (`append: false`) replaces the router's list; parts 2… (`append:
true`) add to it. `append` is signed: the envelope's `reason` is `'append'`
  for those parts and null otherwise (`full` stays `enabled`), so the
  envelope's canonical form is unchanged. Each part has its own nonce. They
  are sent in order; a failed part leaves the router with the earlier parts
  (active vouchers and the newest batches come first) and the retry or next
  sync sends the whole list again. An empty or disabled list is one message.
- **`firstUsedAt`** (epoch ms or null) is the offline voucher record's new
  last field, signed: canonical `… bytesUsed, revision, firstUsedAt`. It tells
  the router a used voucher from an unused one (`redeemBy` only applies to
  unused ones) instead of inferring it. Vectors in `crypto.spec.ts`
  (`firstUsedAt: null` → `fF58SkU0g5C47axcdZN2dLM0sGtvRKWO0ksDlD1kaY8`,
  `1790000000000` → `AMBsGy99v8xLEJ_uEq9C2LFi2cVgrIzUBYewJLuzLMo`).
- **Router change needed** (perch-collector `gw/portal-agent`): add
  `FirstUsedAt *int64` to `WireOfflineVoucher` and its canonical form; in
  `Vouchers`, build the envelope with `Reason: "append"` when `p.Append`, and
  merge instead of replacing when `p.Append`.

## 14. Paid Hotspot and click-through (decisions 28 and 32)

Status: built on branches `gw/hotspot` (controller) and `gw/hotspot-agent`
(perch-collector), September 2026. Code: `app/services/portal/hotspot.ts`
(pure: pricing, records, texts, settings), `portal_hotspot.ts` (admin,
configure payload, terminal reports), `portal_hotspot_ingest.ts` (the
journal), `app/transformers/hotspot.ts`, `app/controllers/portal_hotspot_controller.ts`,
migrations `1779000000100`–`101`; on the router `internal/portal/hotspot*.go`
(go-collector `CONFIG.md`, "Paid Hotspot checkouts and click-through").

The per-MAC authorize API of §11.6 is the **Paid Hotspot API**. This section
adds what decision 28 lists for it and decision 32's click-through method:

| Piece                         | What                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Coin terminals                | Resources with their own token, bound to one portal, several per portal                                                                  |
| Checkout sessions             | A guest opens a checkout on terminal X; X is locked for it; 60 s idle timeout reset by each coin; live running total on the portal page |
| Price tables                  | Operator rates: amount → minutes, data, speed tier; the price is locked when the checkout starts                                        |
| Reference codes               | Shown after payment ("screenshot or save this code"); a voucher minted from the payment, so reusing it moves the rest (decision 23)     |
| Router-local checkouts        | The router runs every checkout, so paid access works through a controller outage; the controller reconciles the journal                |
| Click-through                 | Accept the terms → a free grant with a time and/or speed cap and a repeat limit per MAC (e.g. 30 min per 24 h)                          |
| No reference coin client      | The terminal protocol is documented with a shell reference (§14.10); no firmware ships                                                  |

### 14.1 Model

```
 coin box ──signed HTTP──▶ router :2080 ◀──── guest page (polls /portal/checkout)
                            │ checkout state machine, price lock, idle timer
                            │ finalise: grant (group c:<ref>) + local voucher + journal
                            ▼
                 checkout_finalized (signed) ──portal.event/portal.sync──▶ controller
                            │                  verify sig, derive the code, mint a
                            │                  `payment` voucher, ledger row, then an
                            │                  ordinary offline_redeemed of that voucher
                            ◀── portal.authorize {full}: grant id, group v:<voucherId>
```

- **The router is the checkout authority**, online or not. Terminal and guest
  both talk only to the router (the guest network never reaches the
  controller, §1), and the live total needs sub-second answers. There is one
  code path: an outage only delays the reconciliation.
- **Finalising is an offline redemption.** The router authorises the paying
  MAC under a fresh `localRef` in a local group `c:<checkoutRef>` (placement as
  §4.6: a time grant over a running data bucket swaps, anything else over a
  live entitlement queues). The controller turns the event into an
  `offline_redeemed` of the payment voucher it minted, so binding, clock,
  placement and totals follow §4.7 unchanged, and the next full set renames
  the router's group to `v:<voucherId>`.
- **HMAC-signed results.** The record (§14.4) is signed with the gateway's
  `signKey`; the controller refuses records that do not verify at the
  event's `keyEpoch` (`checkout_rejected`), and the router then loses the
  grant with the next full set.

### 14.2 Price tables

`{name, currency (ISO 4217, display), decimals (0–3, display), durationMode,
entries: [{amount, minutes, quotaBytes?, downKbps?, upKbps?}]}`, ≤ 32 rates,
distinct amounts, either every rate has a quota or none (`mixed_quota`).
Amounts are integers in the table's minor units (`5` with `decimals: 0` is
PHP 5).

**Pricing** (`priceEntitlement`, both sides, pinned by vectors): greedy, the
coin-box convention. Take the largest rate as often as it fits, then the next
smaller, and so on. Minutes and data add up; the **speed tier** is the most
expensive rate taken; what is left below the smallest rate is `unusedAmount`.
Time is capped at one year, data at 10 TB. With rates {1: 10 min},
{5: 1 h, 5/2 Mbit/s}, {20: 5 h, 10/5 Mbit/s}: PHP 7 → 1 h 20 min at 5 Mbit/s;
PHP 47 → 11 h 20 min at 10 Mbit/s.

**Revisions.** Every change bumps `revision` and keeps the revision in
`hotspot_price_revisions`. The router snapshots the table when a checkout
opens (price locked at checkout start); the record names
`priceTableId`/`priceRevision` and the ledger row copies that revision's
snapshot. A table change reaches the routers at once (`configure`).

Each portal with the payment method has a default table
(`portals.payment.priceTableId`); a terminal may override it.

### 14.3 Terminals

- **Token** `perch_pt_` + 32 base64url characters (192 bits), shown once
  (create, rotate). Stored as SHA-256 (lookup, `prefix` for display) and
  APP_KEY-encrypted: the router needs the token itself, since it is the HMAC
  key the terminal signs with (§14.10). After an APP_KEY change a terminal
  reads `tokenRecoverable: false` and is left out of the configure: rotate it.
- **Binding**: one portal; optional **MAC pin** (requests from another MAC are
  403 `mac_mismatch`); `enabled`; optional `priceTableId`.
- **Delivery**: `portal.configure` carries, per portal with the payment
  method, `payment: {idleTimeoutSeconds, priceTableId, terminals: [{terminalId,
  name, token, mac, enabled, priceTableId}], priceTables: [PriceTable]}`
  (every table its terminals use). Every terminal or table change pushes
  `configure` to the gateways it touches.
- **Status**: the router's `portal.terminals` notification (every 30 s, and on
  changes) sets `last_seen_at` and `status {online, acceptor, firmware, error,
  checkout, at}`; the view reads online only while the report is ≤ 90 s old.

### 14.4 The checkout record, its signature and the reference code

Canonical lines (§6.3 encoding): tag `perch-portal-checkout-v1`, gatewayId,
epoch, then checkoutRef, portalId, terminalId, mac, amount, currency,
priceTableId, priceRevision, durationMode, durationSeconds, quotaBytes,
downKbps, upKbps, openedAt, finalizedAt, reason (`done` guest, `terminal` the
box's button, `timeout` idle with credit), localRef, unusedAmount, coinCount.

```
checkoutKey   = HMAC-SHA256(gatewayKey, "perch-portal-checkout-v1")
sig           = base64url_nopad(HMAC-SHA256(signKey, canonical))
referenceCode = 10 Crockford symbols: symbol i = alphabet[HMAC-SHA256(checkoutKey, canonical)[i] & 31]
```

The code is a 50-bit MAC of the record, so **it never crosses the network**:
the router shows it, the controller recomputes it from the verified record.
Vectors (`tests/unit/services/portal/hotspot.spec.ts`, gateway 7, epoch 1,
the §6.3 APP_KEY): record `{ck-0123456789abcdef, portal 3, terminal 4,
02:00:00:aa:bb:cc, 7, PHP, table 2 rev 3, wall_clock, 4800, null, 5000, 2000,
1790000000000, 1790000042000, done, k5-a1b2c3d4, 0, 3}` → sig
`addRWmtev4ux-XcOWgh524P90PI5NMkRip7TT-If_Ow`, code `GE6RH9AQ1S`
(`GE6RH-9AQ1S`).

### 14.5 Ledger and reconciliation

`materializeHotspotEvents` runs on every `portal.sync` report before
`loadServerPortalState`/`reconcile` (§7), inside the gateway's queue:

| Router event                                      | Controller                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout_finalized`                              | Checks the record, the portal (the gateway's), `keyEpoch ≤ key_epoch`, the signature; derives the code; in one transaction mints a `payment` batch of one voucher (bound to the portal, one device, first-use clock, the bought limits) and the ledger row (`kind` payment, `state` paid, coins, locked price snapshot). Continues as `offline_redeemed {voucherId, localRef, placement, startsAt, expiresAt}` |
| `offline_redeemed` with `voucherId: 0`, `checkoutRef` | The router redeemed a reference code it minted before the controller knew it: the voucher id comes from the ledger (`unknown_checkout` otherwise)                                                                                                                                                                  |
| `checkout_unclaimed`                              | Ledger row `kind` unclaimed (`late` coin after the checkout closed, `full`, `below_minimum` at timeout)                                                                                                                                                                                                                |
| `clickthrough_granted`                            | A `g:` grant (`source` clickthrough) with the router's localRef, deadline and limits                                                                                                                                                                                                                                  |

- **Idempotent.** `hotspot_checkouts.event_key` is unique per gateway
  (`checkout:<ref>`, `coin:<terminal>:<eventId>`, `below:<ref>`), click-through
  grants are keyed by `(portal_id, local_ref)`; a replayed report (a lost ack,
  a journal reset) transforms the same way and writes nothing twice.
- **Payment batches** (`voucher_batches.kind = 'payment'`) are not listed in
  `/portal/voucher-batches`; the payment voucher is an ordinary voucher
  everywhere else (grants, lookup by code, offline list).
- **Void** (refund, mistake): the payment's voucher is revoked, its devices go
  offline (`revoked`), the code stops working; `refundAmount` and `note`
  record what the operator did with the money.
- **Unclaimed** coins: an admin **credits** them (a voucher for what they buy
  under the terminal's current table, or `minutes` given; the code is in
  that answer only) or **dismisses** them.
- **Retention**: after `sessionRetentionDays` a ledger row loses its guest MAC,
  address and host name (RA 10173); amounts stay.

### 14.6 Reference codes and MAC rotation

- The payment voucher allows **one device**. Entering the code on another
  device (a randomised MAC, a new phone) moves the rest of the entitlement
  there and ends the old device's grant `moved` (decision 23).
- Voucher entry is on while the portal offers `voucher` **or** `payment`.
- **Before the controller knows the payment** (just paid, or controller down)
  the router redeems the code from its **local voucher** (same verifier,
  §6.2) even with the controller online, and journals `offline_redeemed`
  with `voucherId: 0` + `checkoutRef`. A local voucher is dropped when a full
  set acknowledges the checkout's journal position (from then on the
  controller's offline list carries it, and a voided one must not stay
  redeemable) or when the offline list holds its verifier.
- The receipt shows on the paying device's portal and status pages for 24 h;
  a terminal may print it (`referenceCode` for 120 s after finalising).

### 14.7 Click-through (decision 32)

`portals.click_through`: `{minutes 1–1440 (30), quotaBytes?, downKbps?,
upKbps?, windowHours 1–720 (24), perWindow 1–24 (1), terms ≤ 4000}`. The
router grants `minutes` of free access (a local group `t:<localRef>`,
wall clock from the grant) to a MAC with no live grant on the portal that
accepted the terms, at most `perWindow` times in any `windowHours`
(`clickthrough_used` + Retry-After otherwise). It works offline; the router
keeps the uses (30 days). The controller records the grant as a `g:` grant
(`source: 'clickthrough'`), and the full set renames the group.

### 14.8 Guest pages

Router routes (the portal's own origin, same-origin POSTs, forms answer 303
`/?m=<code>`): `GET /portal/checkout` (the guest's hotspot state, JSON),
`POST /portal/checkout` `terminalId`, `/portal/checkout/done`,
`/portal/checkout/cancel` (only while nothing is paid), `/portal/clickthrough`
`accept=1`. Shapes: go-collector `CONFIG.md`.

- **Busy terminals**: a terminal holds one open checkout; a second guest gets
  `terminal_busy` (the picker marks it busy/offline) and picks another. A
  guest has one open checkout; an empty one moves when they pick another
  terminal, a paid one refuses (`checkout_open`).
- **Walk-away**: 60 s (setting `idleTimeoutSeconds`, 15–600) without a coin
  closes the checkout; with credit it is finalised (`timeout`), the device is
  online when the guest comes back and the receipt waits on the page.
- **Template variables** (both sides, §12.2): `checkout_form` (the terminal
  picker with the rates, or the open checkout's live panel), `receipt`,
  `clickthrough_form` (snippets) and `reference_code` (plain). The builtin
  pages (byte-identical on both sides, `builtin_template.ts`) now also ship
  `checkout.js`, which polls `/portal/checkout` every second for the live
  total; without script the panel has a Refresh link. New message codes:
  `checkout_started checkout_closed checkout_cancelled paid terminal_busy
  terminal_offline terminal_unknown checkout_open checkout_paid below_minimum
  no_checkout clickthrough_used terms_required not_ready`.

### 14.9 REST API (for the dashboard)

Auth as §11.1 (R any signed-in user, A admin). `Cache-Control: no-store` on
answers with a token or a code.

| Method, path                                    | Auth | Request                                                                                                                                  | Response                                                                                  | Errors                                                                                                                                      |
| ----------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/portal/price-tables`                      | R    | –                                                                                                                                        | `PriceTable[]` by name                                                                    | –                                                                                                                                           |
| GET `/portal/price-tables/:id`                  | R    | –                                                                                                                                        | `{priceTable, revisions: PriceRevision[]}` (newest first, ≤ 100)                          | 404 `price_table_not_found`                                                                                                                 |
| POST `/portal/price-tables/:id/quote`           | R    | `{amount 0–1e7}`                                                                                                                         | `{amount, amountText, durationMode, durationSeconds, quotaBytes, downKbps, upKbps, unusedAmount, previewText, text, priceTableId, revision}` | 404                                                                                                                                         |
| POST `/portal/price-tables`                     | A    | `{name 1–80, currency /^[A-Z]{3}$/ (upper-cased), decimals? 0–3 =0, durationMode? =wall_clock, entries 1–32: [{amount 1–1e6, minutes 1–525600, quotaBytes? 1e6–1e13, downKbps?/upKbps? 64–1e7}]}` | 201 `PriceTable`                                                                          | 422 `no_entries`, `too_many_entries`, `duplicate_amount`, `mixed_quota`, `invalid_entry`, `invalid_currency`                                |
| PATCH `/portal/price-tables/:id`                | A    | same fields, optional                                                                                                                    | `{priceTable, delivery}` (a change bumps `revision`, pushes configure)                    | 404; 422 as above                                                                                                                           |
| DELETE `/portal/price-tables/:id`               | A    | –                                                                                                                                        | 204                                                                                       | 404; 409 `price_table_in_use` `{portalIds, terminalIds}`                                                                                    |
| GET `/portal/terminals`                         | R    | `?portalId`                                                                                                                              | `Terminal[]`                                                                              | –                                                                                                                                           |
| GET `/portal/terminals/:id`                     | R    | –                                                                                                                                        | `Terminal`                                                                                | 404 `terminal_not_found`                                                                                                                    |
| POST `/portal/terminals`                        | A    | `{portalId, name 1–80, mac?, enabled? =true, priceTableId?}`                                                                             | 201 `{terminal, token, delivery}`                                                         | 404 `portal_not_found`, `price_table_not_found`; 422 `invalid_mac`                                                                          |
| PATCH `/portal/terminals/:id`                   | A    | same fields, optional (`portalId` moves it)                                                                                              | `{terminal, delivery}`                                                                    | 404; 422                                                                                                                                    |
| POST `/portal/terminals/:id/rotate`             | A    | –                                                                                                                                        | `{terminal, token, delivery}` (the old token dies with the router's next configure)       | 404                                                                                                                                         |
| DELETE `/portal/terminals/:id`                  | A    | –                                                                                                                                        | 204 (ledger rows keep its name)                                                           | 404                                                                                                                                         |
| GET `/portal/checkouts`                         | R    | `?portalId&gatewayId&terminalId&kind=payment\|unclaimed&state=paid\|voided\|unclaimed\|credited\|dismissed&mac&from&to&limit&offset`       | `{items: Checkout[], total, totals: [{currency, amount, count}]}` (paid rows) newest first | 422 `invalid_mac`, `invalid_date`, `invalid_range`                                                                                          |
| GET `/portal/checkouts/:id`                     | R    | –                                                                                                                                        | `Checkout`                                                                                | 404 `checkout_not_found`                                                                                                                    |
| POST `/portal/checkouts/:id/void`               | A    | `{note? ≤200, refundAmount? 0–1e7}`                                                                                                      | `{checkout, delivery}`                                                                    | 404; 409 `not_a_payment`, `checkout_voided`; 422 `refund_exceeds_amount`                                                                    |
| POST `/portal/checkouts/:id/credit`             | A    | `{minutes? 1–525600, note?}`                                                                                                             | `{checkout, code, delivery}` (`XXXXX-XXXXX`, once)                                        | 404; 409 `not_unclaimed`, `already_resolved`; 422 `below_minimum`                                                                           |
| POST `/portal/checkouts/:id/dismiss`            | A    | `{note?}`                                                                                                                                | `Checkout`                                                                                | 404; 409 `not_unclaimed`, `already_resolved`                                                                                                |

Portals (§11.4) take and show `methods: {voucher, password, payment,
clickThrough}`, `payment: {priceTableId, idleTimeoutSeconds 15–600 (60)}` and
`clickThrough` (§14.7); turning `payment` on without a table is 422
`price_table_required`. `PortalGrant.source` gains `clickthrough`;
`VoucherBatch` gains `kind`.

```ts
type PriceTable = { id; name; currency; decimals; durationMode: 'wall_clock' | 'active_time'
  entries: { amount; minutes; quotaBytes: number | null; downKbps: number | null
             upKbps: number | null; amountText }[]
  revision; usedBy: { portalIds: number[]; terminalIds: number[] }; createdAt; updatedAt }
type PriceRevision = { revision; name; currency; decimals; durationMode; entries; createdAt }
type Terminal = { id; portalId; name; prefix /* perch_pt_ + 4 */; mac: string | null; enabled
  priceTableId: number | null; effectivePriceTableId: number | null; online: boolean
  lastSeenAt: string | null
  status: { acceptor; firmware; error
            checkout: { checkoutRef; state; amount; openedAt: string | null } | null
            reportedAt: string | null } | null
  tokenRecoverable: boolean; createdAt; updatedAt }
type Checkout = { id; kind: 'payment' | 'unclaimed'
  state: 'paid' | 'voided' | 'unclaimed' | 'credited' | 'dismissed'
  gatewayId; portalId: number | null; terminal: { id: number | null; name: string | null }
  checkoutRef: string | null; mac: string | null; ip: string | null; hostname: string | null
  amount; amountText: string | null; unusedAmount; refundAmount: number | null
  currency: string | null; decimals: number | null
  price: { priceTableId; revision; snapshot: PriceTableWire | null } | null   // payments
  entitlement: { durationMode; durationSeconds; quotaBytes; downKbps; upKbps } | null
  coinCount; coins: { eventId; amount; at }[]
  reason: 'done' | 'timeout' | 'terminal' | 'late' | 'full' | 'below_minimum' | null
  openedAt; finalizedAt
  voucher: { id; batchId; hint; status: 'unused' | 'active' | 'exhausted' | 'expired' | 'revoked' } | null
  keyEpoch: number | null; note; resolvedAt; resolvedBy: { id; email } | null; createdAt }
```

### 14.10 Terminal protocol (reference, no firmware ships)

A terminal (coin acceptor + microcontroller) sits on the portal's network and
talks to the router's guest-page port. Every request is signed with its
token; the token itself never crosses the (usually open) guest Wi-Fi:

```
X-Perch-Terminal:  <terminalId>
X-Perch-Session:   <session>   (absent/empty for /session)
X-Perch-Seq:       <n>         (0 for /session, then strictly increasing per session)
X-Perch-Signature: base64url_nopad(HMAC-SHA256(key = token,
    "perch-terminal-v1\n" METHOD "\n" PATH "\n" terminalId "\n" session "\n" seq "\n" hex(sha256(body))))
```

| Route (`/portal/v1/terminal/…`) | Body → answer                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST session`                  | `{nonce}` (16–64 `[A-Za-z0-9_-]`, never reused) → `{session, heartbeatSeconds: 5, terminal: {terminalId, name, portalId}, currency, decimals, now}` |
| `POST heartbeat`                | `{status?: {acceptor: "on"\|"off", firmware?, error?}}` → `{checkout, heartbeatSeconds, now}`                                                    |
| `GET checkout`                  | → `{checkout}`                                                                                                                                   |
| `POST coins`                    | `{checkoutRef, eventId, amount}` → `{accepted, checkout}` (`accepted: false` = that eventId was already counted)                                 |
| `POST done`                     | `{checkoutRef}` → `{checkout}` (finalised, reason `terminal`)                                                                                    |

`checkout` is the terminal's open checkout (enable the acceptor), else its
last one for 120 s (`referenceCode` while finalised, for a receipt
printer), else null (disable the acceptor). Replays: a request's session must
be the current one (401 `session_unknown` → open a new session and retry) and
its seq above the last (409 `stale_seq`); a coin's `eventId` counts once, so
a retry after a lost answer is safe even in a new session (keep the eventId).
A coin for a closed checkout is 409 `checkout_closed {recorded: true}`: the
money lands in the ledger as unclaimed.

Shell reference (curl, openssl, jq; the lab's fake terminal is this script):

```sh
ROUTER=http://192.168.20.1:2080 TERMINAL=4 TOKEN=perch_pt_...   # from POST /portal/terminals
b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
sign() {   # METHOD PATH SESSION SEQ BODY
  body_sha=$(printf %s "$5" | openssl dgst -sha256 -hex | sed 's/^.*= //')
  printf 'perch-terminal-v1\n%s\n%s\n%s\n%s\n%s\n%s' "$1" "$2" "$TERMINAL" "$3" "$4" "$body_sha" |
    openssl dgst -sha256 -hmac "$TOKEN" -binary | b64url
}
call() {   # METHOD PATH [BODY]
  SEQ=$((SEQ + 1))
  curl -sS -X "$1" "$ROUTER$2" -H 'Content-Type: application/json' \
    -H "X-Perch-Terminal: $TERMINAL" -H "X-Perch-Session: $SESSION" -H "X-Perch-Seq: $SEQ" \
    -H "X-Perch-Signature: $(sign "$1" "$2" "$SESSION" "$SEQ" "${3:-}")" ${3:+--data-binary "$3"}
}
# 1. open a session (at boot, and after 401 session_unknown)
body="{\"nonce\":\"$(openssl rand -hex 16)\"}"
SESSION=$(curl -sS -X POST "$ROUTER/portal/v1/terminal/session" -H 'Content-Type: application/json' \
  -H "X-Perch-Terminal: $TERMINAL" -H 'X-Perch-Seq: 0' \
  -H "X-Perch-Signature: $(sign POST /portal/v1/terminal/session '' 0 "$body")" \
  --data-binary "$body" | jq -r .session); SEQ=0
# 2. heartbeat every heartbeatSeconds; a checkout appears when a guest picks this terminal
REF=$(call POST /portal/v1/terminal/heartbeat '{"status":{"acceptor":"off"}}' | jq -r '.checkout.checkoutRef // empty')
# 3. report each coin as it drops (eventId: unique per coin, kept across retries)
call POST /portal/v1/terminal/coins "{\"checkoutRef\":\"$REF\",\"eventId\":\"boot7-1\",\"amount\":5}"
# 4. the box's "done" button (the guest can also press Done on the page)
call POST /portal/v1/terminal/done "{\"checkoutRef\":\"$REF\"}"
```

### 14.11 Wire additions (router ↔ controller)

- `portal.configure` portals: `methods.payment`, `methods.clickThrough`,
  `payment` (§14.3), `clickThrough` (§14.7). Hello `portal.hotspot: 1`.
- Journal events: `checkout_finalized` (record fields + `coins`, `keyEpoch`,
  `sig`, `placement`, `demotedGrantId?`, `demotedLocalRef?`, `startsAt?`,
  `expiresAt?`, `ip?`, `hostname?`), `checkout_unclaimed` `{terminalId,
  eventId ("" for below_minimum), amount, currency, checkoutRef?, reason}`,
  `clickthrough_granted` `{localRef, startsAt, expiresAt, durationSeconds,
  quotaBytes, downKbps, upKbps, ip?, hostname?}`, `offline_redeemed` with
  `voucherId: 0` + `checkoutRef`.
- Notification `portal.terminals` `{collectedAt, terminals: [{terminalId,
  portalId, online, lastSeenAt, status, checkout}]}`.
- Local group keys `c:<checkoutRef>` and `t:<localRef>` exist only on the
  router; the controller never sends them and renames them through the full
  set (grant `groupKey`).

### 14.12 Threat model

| Threat                                                          | Mitigation                                                                                                                                                                                                                                                   | Residual                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal token stolen (box opened, firmware dumped)             | Scoped to one terminal on one portal; checkouts only open from a guest's page; MAC pin; per-address rate limits; every payment in the ledger with its coins (compare with the cash box); rotate or disable at once (next configure); hash + APP_KEY encryption at rest | Until rotated, the thief can report coins into checkouts on that terminal: free access for themselves, visible as ledger payments without cash |
| Token sniffed on the open guest Wi-Fi                           | Never sent: requests are HMAC-signed with it                                                                                                                                                                                                                 | –                                                                                                                                                         |
| Replayed coin events or requests                                | Router-issued session per terminal (a replayed `/session` nonce is refused), strictly increasing seq, body inside the signature; `eventId` counts once per checkout; late or duplicate coins never credit twice                                             | A captured request is useless after its seq; a lost answer is retried with the same eventId                                                               |
| Two guests racing one terminal                                  | One open checkout per terminal, taken under the engine lock; the second guest gets `terminal_busy` and the picker shows busy/offline                                                                                                                         | –                                                                                                                                                         |
| Guest claims a terminal and walks away                          | Idle timeout (60 s default, reset by each coin); an empty checkout expires, a paid one is finalised to the claimer                                                                                                                                          | The terminal is blocked for up to one idle period                                                                                                         |
| Terminal offline mid-checkout                                   | The page shows "not responding"; the guest can press Done for what was counted; idle timeout finalises; coins reported after the close are `checkout_unclaimed` (ledger) for an admin to credit                                                          | A coin the box never reported is invisible to Perch (cash-box reconciliation)                                                                             |
| Controller down mid-checkout                                    | Nothing changes for the guest: the router finalises, shows the code, the grant works; reconciliation on reconnect (idempotent)                                                                                                                              | Voids and credits wait for the controller                                                                                                                 |
| Price table changed mid-checkout                                | The router snapshots the table at open: the guest pays the price they saw; the ledger keeps that revision's snapshot                                                                                                                                         | –                                                                                                                                                         |
| Forged or altered checkout record (router journal on USB, MITM on plain HTTP) | Signed with the gateway's `signKey`; unverifiable records are refused and the grant removed; the code is derived from the verified record                                                                                                      | The key crosses a plain-HTTP link once in configure (§6.1): use TLS                                                                                       |
| Reference code shared or leaked                                 | One device: the newest takes it, the first is kicked (decision 23); 50-bit codes; guest brute-force limits (§13.5)                                                                                                                                           | Whoever holds the code holds the rest of the time (it is a bearer receipt)                                                                                |
| Refund or mistaken payment                                      | Admin void: voucher revoked, devices offline, refund amount and note recorded                                                                                                                                                                                | Money handling is outside Perch                                                                                                                           |
| Click-through abuse by rotating MACs                            | Per-MAC window limit, speed cap, short grant                                                                                                                                                                                                                 | A device that randomises its MAC per join gets a new window; the limit is per MAC by design                                                              |
| Router reset loses local state                                  | Checkouts, coins and grants are written through at once (grant class); click-through uses too                                                                                                                                                               | A reset router forgets click-through uses (one extra free grant per MAC) and open checkouts                                                              |

### 14.13 Deviations and notes

- **One checkout authority.** Checkouts always run on the router (not
  "controller when online, router as a fallback"): the terminal and the guest
  page both live on the guest network, and one code path cannot disagree with
  itself. "HMAC-signed checkout results" are the router's signed records.
- **No controller-side terminal API.** Terminals talk only to the router.
- **`below_minimum`**: Done refuses a total that buys nothing; at the idle
  timeout such money is recorded as unclaimed.
- **Receipts**: the paying device's pages show the code for 24 h.
