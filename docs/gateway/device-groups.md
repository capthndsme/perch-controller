# Device groups (owner decisions 30 and 31)

A **device group** is the multi-tenant unit of a managed gateway: an apartment unit, a
family, the IoT gear, the staff. There is no separate "unit" or "room" model. A group
has members (devices) and attributes that apply to every member: a network (VLAN),
Wi-Fi keys (per-group passphrases on shared SSIDs), a speed limit, internet access and
a guest portal bypass. The QoS groups of plan 3 are folded into device groups.

Status: v1, 2026-09-24 (branch `gw/integration`).

## 1. Model

Groups belong to one gateway (`device_groups.gateway_id`). A MAC is in at most one group
per gateway.

| Field | Meaning |
|---|---|
| `name` | 1-64 chars, unique per gateway |
| `notes` | ≤ 500 chars |
| `networkPerchId` | The group's own network (a gateway network, normally a VLAN). Optional. Required for Wi-Fi keys and for moving devices by binding |
| `qos` | `{policyId, rate}` or null: realised as a QoS assignment (section 4) |
| `internet` | `true` = allowed (default). `false` blocks the members from every WAN zone (section 5) |
| `portalBypass` | Members pass the gateway's guest portals without signing in (groups without a network; section 6) |

Two kinds of members:

- **Bound** (stored, `device_group_members`): added by an admin (`source: 'manual'`) or by a
  portal sign-in of a user who belongs to the group (`source: 'portal'`, decision 31). On a
  group with a network, a bound MAC is moved to the group's VLAN on the access points
  (section 7): it keeps the SSID's own passphrase.
- **On the network** (computed, groups with a network only): every device the gateway sees on
  the group's network, whichever key brought it there. Shown with the members; not stored.

Wi-Fi keys (`device_group_keys`): per-group passphrases, 8-63 printable ASCII characters,
unique per gateway (a passphrase names one VLAN), stored encrypted with `APP_KEY` plus a
SHA-256 for the uniqueness check. Admins can reveal a key again (a tenant's key is handed
out more than once). A group needs a network with a VLAN id to have keys.

## 2. Tables (migrations 120-123)

- `device_groups`: `id`, `gateway_id` (FK, cascade), `name`, `notes`, `network_perch_id`
  (nullable), `internet` (bool, default 1), `portal_bypass` (bool, default 0),
  `created_at`, `updated_at`; unique (`gateway_id`, `name`).
- `device_group_members`: `id`, `gateway_id`, `group_id` (FK, cascade), `mac`, `source`
  (`manual` | `portal`), `portal_user_id` (FK, set null), `created_by_user_id`,
  `created_at`; unique (`gateway_id`, `mac`).
- `device_group_keys`: `id`, `gateway_id`, `group_id` (FK, cascade), `label`,
  `passphrase_encrypted`, `passphrase_digest`, `created_by_user_id`, `created_at`;
  unique (`gateway_id`, `passphrase_digest`).
- `portal_users.device_group_id` (FK, set null).
- Fold (migration 123): every `qos_groups` row becomes a `device_groups` row (same gateway,
  name, notes; its members `source: 'manual'`), `qos_assignments.group_id` is repointed and
  its foreign key moves to `device_groups`; `qos_groups` and `qos_group_members` are dropped.
  `/qos/groups` keeps working as a view of device groups (name, notes, members).
- AP state: `ap_group_states` (`ap_id` FK cascade, `fingerprint`, `revision`,
  `applied_revision`, `state`, `error`, `trunk_port`, `converted`, `stations` JSON,
  `updated_at`).

## 3. REST (admin writes, every signed-in user reads)

| Method | Path | Body / result |
|---|---|---|
| GET | `/device-groups?gatewayId=` | `DeviceGroup[]` |
| GET | `/device-groups/:id` | `DeviceGroup` with `members`, `onNetwork`, `keys` (no passphrases), `aps` |
| POST | `/device-groups` | `{gatewayId?, name, notes?, networkPerchId?, internet?, portalBypass?, qos?}` → 201 |
| PATCH | `/device-groups/:id` | any of the above fields |
| DELETE | `/device-groups/:id` | 204; its QoS assignment, firewall sections and AP entries go too |
| POST | `/device-groups/:id/members` | `{mac}` → bound manually (409 `group_mac_taken` + `groupId` when another group has it; `move: true` moves it) |
| DELETE | `/device-groups/:id/members/:mac` | 204 |
| POST | `/device-groups/:id/keys` | `{label, passphrase?}` (generated when absent) → 201 `{key, passphrase}` |
| GET | `/device-groups/:id/keys/:keyId/passphrase` | `{passphrase}` (admin) |
| DELETE | `/device-groups/:id/keys/:keyId` | 204 |
| GET/PATCH | `/settings/device-groups` | `{ssids: string[], confirmSeconds}` |
| GET | `/device-groups/aps` | per AP: `{apId, name, online, supported, state, revision, appliedRevision, trunkPort, trunkOverride, converted, error, stations[], reportedAt}` |
| PATCH | `/device-groups/aps/:apId` | `{trunk: string \| null}`: the port towards the gateway (null = the AP detects it) |
| GET | `/devices/:mac/group?gatewayId=` | the device's group (bound or on the network) or null |

`DeviceGroup`:

```ts
{ id, gatewayId, name, notes,
  network: { perchId, name, label, vlanId, ipv4 } | null,
  qos: { assignmentId, policyId, rate: {downKbit, upKbit} | null, via: 'group' | 'network' } | null,
  internet: boolean, portalBypass: boolean,
  counts: { bound, onNetwork, keys },
  firewall: { state: 'none' | 'pending' | 'applied' | 'conflict' },
  createdAt, updatedAt }
```

Errors (`{error, message, ...}`): 422 `group_network_unknown`, `group_network_taken` (another
group has it), `group_keys_need_vlan`, `group_bypass_with_network`, `group_passphrase_invalid`;
409 `group_name_taken`, `group_mac_taken`, `group_passphrase_taken`; 404 `group_not_found`.

## 4. Speed limit (QoS)

A group's `qos` is a QoS assignment with `source: 'group'` and `sourceRef: 'device-group:<id>'`:

- a group with a network: the **network default** of that network (the router caps every
  device on it, however it got there);
- a group without one: a **group** assignment over its bound members.

A group can have one or the other, never both. Setting `qos` refuses when the network already
has a default from elsewhere (`qos_target_assigned`). Portal devices on a group's network stay
inside it like every portal device (qos.md 3.2).

## 5. Internet access (firewall)

`internet: false` renders, through the config plane (firewall domain):

- a group with a network: one REJECT rule per WAN zone, `perch_g<id>_<zone>`, matching the
  network's zone when that zone holds the network alone (IPv4 and IPv6), else its IPv4
  prefixes (`src_ip`);
- a group without one: an ipset `perch_g<id>` (`match src_mac`, the bound MACs) and the same
  rules with `ipset perch_g<id>`.

The rules go first among the rules toward WAN zones (like the per-device WAN block), and
the bound members' connections are flushed after the apply. `internet: true` removes them.
A per-gateway job reconciles every group's sections after a change, debounced, and retries
every 3 s while another apply holds the gateway (`pending_apply`, `apply_in_flight`).

## 6. Guest portal

- **Bypass**: `portal.configure` carries `bypass: string[]` per portal: the bound MACs of the
  gateway's groups with `portalBypass`. The router authorises them without a grant and never
  counts or ends them.
- **Sign-in binds** (decision 31): a portal user with `deviceGroupId` who signs in binds the
  device's MAC to that group (`source: 'portal'`, `portalUserId`), within the user's
  `maxDevices` (over it: `device_limit`, or with "sign the other device out" the user's oldest
  bound device leaves the group). Then:
  - a group with a network: no grant. The AP entries are updated and the device is kicked so
    it rejoins in the group's VLAN; the guest page says so (`bound: {groupId, groupName, moved: true}`);
  - a group without one: the grant is created as before (the membership adds its QoS, internet
    and bypass).

## 7. Access points (perch-apd `groups.*`)

The AP daemon manages Perch-owned sections of its `wireless` and `network` configs so a
shared SSID carries the groups' keys and VLANs (OpenWrt `wifi-station` / `wifi-vlan`, 24.10
and 25.12 alike). Opt-in on the AP: `option wifi_groups '1'` in `/etc/config/perch-apd`
(capability `wifi_groups`); over plain `ws://` it also needs `option wifi_groups_insecure '1'`.

Desired state, sent to every opted-in AP (`groups.apply`, JSON-RPC):

```json
{ "revision": 7, "confirmSeconds": 120, "trunk": "auto",
  "ssids": ["Apartment"],
  "vlans": [{"vid": 101}, {"vid": 102}],
  "stations": [
    {"key": "<group passphrase>", "vid": 101},
    {"macs": ["02:00:00:00:00:21"], "vid": 102} ] }
```

A station without `key` is a binding: it uses the SSID's own passphrase. The AP answers
`{revision, state: "pending_confirm" | "noop", trunkPort, converted, deadline}`; the controller
calls `groups.confirm {revision}` once the AP is still (or again) connected, else the AP
restores its previous `wireless` and `network` and reloads (`rolled_back`). `groups.state`
returns `{revision, appliedRevision, pending, trunkPort, stations: [{mac, vid, ifname}], issues}`.

On the AP (`internal/groups` of perch-apd):

- every managed `wifi-iface` (mode `ap`, SSID in `ssids`, WPA-PSK/SAE) gets `dynamic_vlan '1'`;
- per VLAN: the trunk carries it tagged (a VLAN-filtering bridge gets a `bridge-vlan`; an
  untagged bridge is converted first, its interfaces moving to `<bridge>.1`, like the
  gateway's networks), an interface `perch_v<vid>` on `<bridge>.<vid>`, and a `wifi-vlan`
  `perch_wv<vid>` (`name 'g<vid>'`, the managed ifaces);
- per station a `wifi-station` `perch_ws<n>`;
- `trunk: "auto"` = the bridge port behind which the default gateway's MAC is learned.
- Only a change of stations reloads with `RELOAD_WPA_PSK` (no client drops); VLAN changes
  restart the managed BSSes.

## 8. Settings (`system_settings` key `device_groups`)

`ssids` (the SSIDs group keys and bindings apply to; empty = none), `confirmSeconds`
(30-600, default 120).

## 9. Controller side of the access points (`ap_groups.ts`)

Every agent that offers `wifi_groups` gets the same desired state (the settings' SSIDs, the
VLAN of every group with a network, a station per key, one binding station per group with
bound members), fingerprinted; a new fingerprint is the AP's next revision. On every agent
connect (after `system.info`), on changes (debounced 300 ms) and every two minutes: `groups.state`
first (a pending revision this side sent is confirmed at once: the agent answered), then
`groups.apply` when out of line, and 15 s after a `pending_confirm` a `ping` and `groups.confirm`
(no answer: the reconnect confirms, or the AP rolls back). Devices bound by a portal sign-in
are kicked (`client.kick`) on each AP once it holds the binding. `ap_group_states.state`:
`idle`, `sending`, `pending_confirm`, `applied`, `failed`, `rolled_back`, `waiting`, `offline`,
`unsupported`.

