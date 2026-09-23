# Guest portal: controller domain

Status: WP1 (controller domain) built on branch `gw/portal`, September 2026.
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

The code lives in `app/services/portal/*` (pure, no app imports),
`app/services/portal_{keys,settings,store,retention}.ts` (bound to the app and
the database), `app/models/portal*.ts`, `voucher*.ts`, migrations
`1779000000070`–`075` and `app/tasks/prune_portal_history.task.ts`.

## 1. Decisions at a glance

| Question                      | Decision                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enforcement                   | openNDS 10.x, one instance per portal network if the M1 spike allows it; otherwise Perch's own nftables table (`portals.enforcement`)                                   |
| Page hosting                  | Router-local FAS served by perch-collector (`:2080`), FAS level 1                                                                                                       |
| Controller exposure to guests | None                                                                                                                                                                    |
| Login identities              | `portal_users`, never controller `users`                                                                                                                                |
| Byte counting                 | The router's kernel counters (openNDS), never pcap                                                                                                                      |
| Authority                     | Controller: vouchers, grants (create, extend, revoke), the offline voucher list. Router: usage, session facts, offline redemptions                                      |
| Outage                        | The router keeps grants and enforces expiry and quotas. It also redeems the vouchers it holds (decision 20). Password logins and API authorizations need the controller |
| Scope v1                      | Several portals per gateway, one per network                                                                                                                            |

## 2. Three kinds of state

| Layer                | What                                                                                     | Where                               | Sync                                                            | Who wins                                             |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Native config        | `/etc/config/opennds` (one section per portal instance), `perch-collector.main.portal_*` | router UCI                          | two-way, config plane                                           | config plane rules; `faskey` never leaves the router |
| Perch app data       | portals, templates, vouchers, portal users, API clients, `system_settings.portal`        | controller DB                       | down (`portal.configure`, `portal.template`, `portal.vouchers`) | controller, always                                   |
| Runtime: entitlement | grants and their limits                                                                  | controller DB, cached on the router | down (`portal.authorize` / `deauthorize` / full sync)           | controller for create, extend, revoke                |
| Runtime: facts       | usage, sessions, router deauths, offline redemptions, outside auths                      | router                              | up (`portal.sync`, `portal.event`, `portal.sessions`)           | router: the controller never invents usage           |

The `portals` row stores no native setting. `network_perch_id` is the ledger
id of the `interface` section the portal sits on; it stays stable across
renames. `instance` names the openNDS section that serves the portal.

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
- **Idle.** openNDS idle deauth pauses a grant. The device is re-authorized
  automatically when it comes back.

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
- **openNDS backstops** (`ndsBackstops`):
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

`ndsctl auth` by hand, LuCI, and so on:

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

## 5. Data model (migrations 070–075)

All tables are `utf8mb4_unicode_ci`. Unions are strings enforced in the app;
JSON is stored as text and parsed by the models (`schema_rules.ts`).

| Table                   | Notes                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal_templates`      | `sha256` of the file set; `builtin` read-only; one seeded builtin row with no files (= the collector's compiled-in pages)                                                                                                                                                                                                                                           |
| `portal_template_files` | `content` MEDIUMBLOB; unique (template_id, name)                                                                                                                                                                                                                                                                                                                    |
| `portals`               | `gateway_id` → gateways CASCADE; `network_perch_id`, `instance`, `enforcement` (`opennds`\|`perch_nft`), `methods` JSON, `template_id` → templates SET NULL, `csp_connect_src` JSON, `privacy_notice`, `revision`, `applied_revision`, `status` JSON, `deleted_at`. Generated `active_network` = network while not deleted; **unique (gateway_id, active_network)** |
| `voucher_batches`       | `portal_id` → portals CASCADE (null = any portal); limits; `redeem_by`; `revoked_at`                                                                                                                                                                                                                                                                                |
| `vouchers`              | `code_hash` CHAR(64) unique (HMAC, §6.1), `code_encrypted` (APP_KEY), `hint`, `bound_portal_id` → portals SET NULL, clock (`first_used_at`, `starts_at`, `expires_at`), totals, `revision`, `revoked_at`, `exhausted_at`                                                                                                                                            |
| `portal_users`          | `username` unique, scrypt `password` (hashed by the model), `max_devices`, `session_minutes`, rates, `portal_ids` JSON, `revision`                                                                                                                                                                                                                                  |
| `portal_api_clients`    | `token_hash` unique (SHA-256), `token_prefix`, `scopes`/`portal_ids` JSON, per-call caps                                                                                                                                                                                                                                                                            |
| `portal_grants`         | BIGINT id; `portal_id` → portals CASCADE; `mac` CHAR(17); `source` voucher\|user\|api\|admin; `group_key`; FKs to voucher/user/api client/user SET NULL; `external_ref` (unique with api_client_id), `local_ref` (unique with portal_id); `g:` limits; counters; `state`, `delivery`, `revision`, `started_at`, `last_seen_at`, `ended_at`, `end_reason`            |
| `portal_sessions`       | per active stretch: `start_bytes_*` at open, `bytes_*` = end − start at close                                                                                                                                                                                                                                                                                       |
| `portal_gateway_states` | PK `gateway_id` → gateways CASCADE; `acked_event_seq` (one journal per router, shared by its portals), `key_epoch`, `router_key_epoch`, `last_sync_at`                                                                                                                                                                                                              |
| `portal_events`         | audit: `gateway_id` CASCADE, `portal_id` CASCADE null, `grant_id` SET NULL, `mac`, `type`, `detail` JSON                                                                                                                                                                                                                                                            |

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

| Record          | Tag                                                  | Fields in order                                                                                                                                                                         |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| group           | `perch-portal-group-v1`                              | groupKey, durationMode, expiresAt, durationSeconds, quotaBytes, baseTimeUsedSeconds, baseBytesUsed, downKbps, upKbps, maxDevices, revision                                              |
| grant           | `perch-portal-grant-v1`                              | grantId, localRef, portalId, groupKey, mac, expiresAt, revision                                                                                                                         |
| offline voucher | `perch-portal-voucher-v1`                            | voucherId, verifier, portalIds, groupKey, durationMode, startMode, durationSeconds, quotaBytes, downKbps, upKbps, maxDevices, redeemBy, expiresAt, timeUsedSeconds, bytesUsed, revision |
| envelope        | `perch-portal-<authorize\|deauthorize\|vouchers>-v1` | full, serverNow, nonce, ackedEventSeq, grantIds, reason, itemCount, externalCount; then one line per item signature (wire order), then `ext:<portalId>:<mac>` per external              |

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

// portal.vouchers params (new): the full offline list every time
{ enabled, serverNow, nonce, keyEpoch, vouchers: (WireOfflineVoucher & {sig})[], sig }

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
   and start its clock.
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

- **`portals` is keyed per network.** It has `network_perch_id`, `instance` and
  `enforcement` (decision 19). `acked_event_seq` moved to
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
