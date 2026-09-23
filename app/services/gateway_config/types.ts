/**
 * Shared types of the managed gateway's config plane
 * (docs/gateway/config-plane.md). Pure data: no Lucid, no I/O, so the sync
 * engine, the domains and their tests import them without booting the app.
 */

/** A UCI option value: a scalar or a list (`ubus call uci get` returns lists as arrays). */
export type UciValue = string | string[]

/** Options of a section by name. */
export type UciOptions = Record<string, UciValue>

/**
 * A section as the agent reads it (`gateway.config.read`, section 4): secret
 * options are removed from `options` and appear in `secrets` as
 * `hmac:<hex16>` fingerprints.
 */
export interface UciSection {
  name: string
  type: string
  anonymous: boolean
  index: number
  options: UciOptions
  secrets?: Record<string, string>
}

/** One config as the agent reads it. */
export interface UciConfig {
  name: string
  hash: string
  sections: UciSection[]
}

/** Configs by name (a whole read). */
export type UciConfigSet = Record<string, UciConfig>

/** One entry of the router's sync ledger (`/etc/config/perch-managed`, README 3.1). */
export interface LedgerEntry {
  perchId: string
  config: string
  section: string
  domain: string
}

/**
 * A secret option's value on the controller side. `fingerprint` is the
 * router's `hmac:` form (the only thing compared). `ref` names the
 * `gateway_secrets` row that holds a value the controller set; without it
 * the router owns the value and an apply sends `{"$keep":true}`.
 */
export interface SecretSlot {
  fingerprint: string
  ref?: string
}

/**
 * Canonical content of one section, as stored in `gateway_sections`
 * (`base_content`, `router_content`, `desired_content`) and in revision
 * snapshots. `null` in those columns means "absent".
 */
export interface SectionContent {
  type: string
  options: UciOptions
  secrets?: Record<string, SecretSlot>
}

/** Per-section scope (section 2). */
export const SECTION_SCOPES = ['synced', 'excluded', 'unmodeled'] as const
export type SectionScope = (typeof SECTION_SCOPES)[number]

/**
 * Per-section status. The first four are the contract's (section 9);
 * `pending` (an apply carrying the section is in flight) and `reverting`
 * (an Authoritative Mode revert is in flight) are the transient states of
 * the diagrams in section 5.6.
 */
export const SECTION_STATUSES = [
  'in_sync',
  'ahead',
  'pending',
  'conflict',
  'drift',
  'reverting',
] as const
export type SectionStatus = (typeof SECTION_STATUSES)[number]

/** Why a modeled section cannot be managed; it is mirrored as `unmodeled`. */
export const SECTION_ISSUES = ['ambiguous', 'no_round_trip', 'duplicate'] as const
export type SectionIssue = (typeof SECTION_ISSUES)[number]

/**
 * What Perch owns inside a section (README 3.2, plan 2 P3/P4).
 *
 * - `section`: every option, including ones the domain does not model
 *   (those ride along verbatim).
 * - `options`: only the named options; the rest belong to the router and
 *   always take the router's value (never a conflict, never drift). `items`
 *   narrows a list option further to the items Perch added (e.g.
 *   `dnsmasq.server`): foreign items are the router's, and only the owned
 *   ones are merged and enforced.
 */
export type SectionOwnership =
  | { kind: 'section' }
  | { kind: 'options'; options: string[]; items?: Record<string, string[]> }

export const WHOLE_SECTION: SectionOwnership = Object.freeze({
  kind: 'section',
}) as SectionOwnership

/** Who changed a section on the router (section 3.3), best effort. */
export interface RouterAuthor {
  kind: 'luci' | 'cli' | 'perch' | 'unknown'
  user?: string
  via?: 'trigger' | 'poll'
  applyId?: string
}

/** One option-level disagreement of a conflict. */
export interface ConflictOption {
  name: string
  base: unknown
  router: unknown
  controller: unknown
}

/** An open conflict on a section (`gateway_sections.conflict`). */
export interface SectionConflict {
  kind: 'options' | 'delete_vs_edit' | 'type' | 'order'
  options: ConflictOption[]
  detectedAt: string
  /** Set when the conflict came back from a rollback's `discarded` edits (section 5.5). */
  origin?: 'merge' | 'rollback_discarded'
  /**
   * `rollback_discarded` only: the router edit the rollback threw away. It is
   * no longer on the router; "take router" puts it back into C.
   */
  discarded?: SectionContent | null
}

/** Gateway mode (section 2). */
export const GATEWAY_MODES = ['off', 'observe', 'managed'] as const
export type GatewayMode = (typeof GATEWAY_MODES)[number]

export const GATEWAY_ENFORCEMENT = ['active', 'suspended'] as const
export type GatewayEnforcement = (typeof GATEWAY_ENFORCEMENT)[number]

export const GATEWAY_SYNC_STATES = [
  'unknown',
  'in_sync',
  'ahead',
  'conflict',
  'drift',
  'applying',
] as const
export type GatewaySyncState = (typeof GATEWAY_SYNC_STATES)[number]

/** Router-side `config_access` (section 3.2). */
export const AGENT_ACCESS_LEVELS = ['none', 'read', 'write'] as const
export type AgentAccess = (typeof AGENT_ACCESS_LEVELS)[number]

/** `package`: a `gateway.package.install` job (README 7.7), confirmed like an apply. */
export const APPLY_KINDS = ['apply', 'revert', 'adopt', 'package'] as const
export type ApplyKind = (typeof APPLY_KINDS)[number]

export const APPLY_STATES = [
  'queued',
  'sending',
  'pending_confirm',
  'confirmed',
  'rolled_back',
  'failed',
  'expired',
  'cancelled',
] as const
export type ApplyState = (typeof APPLY_STATES)[number]

export const CONFIRM_MODES = ['agent', 'admin_and_agent'] as const
export type ConfirmMode = (typeof CONFIRM_MODES)[number]

export const REVISION_SOURCES = [
  'import',
  'router',
  'controller',
  'merge',
  'revert',
  'rollback',
] as const
export type RevisionSource = (typeof REVISION_SOURCES)[number]

/** Audit events (`gateway_config_events.event`, section 9). */
export const GATEWAY_EVENTS = [
  'mode_changed',
  'authoritative_changed',
  'read',
  'imported',
  'conflict_opened',
  'conflict_resolved',
  'drift_detected',
  'drift_accepted',
  'apply_requested',
  'applied',
  'confirmed',
  'rolled_back',
  'failed',
  'expired',
  'enforcement_suspended',
  'enforcement_resumed',
  'section_excluded',
  'section_included',
  'section_removed',
  'section_ambiguous',
  'read_refused',
  'revision_restored',
  'unmodeled_changed',
  'rejoin_offered',
  'rejoin_dismissed',
  'cancelled',
  'draft_discarded',
  'draft_edited',
  'bound',
  'dns_label_names_changed',
  'sign_key_changed',
  'pairing_started',
  'pairing_code_rejected',
  'pairing_code_accepted',
  'pairing_router_confirmed',
  'paired',
  'pairing_failed',
  'pairing_lost',
  'unpaired',
  'router_paused',
  'router_resumed',
] as const
export type GatewayEventName = (typeof GATEWAY_EVENTS)[number]

/**
 * How the agent reaches the controller (README 3.8), from `ip route get
 * <controller>` on the router: the logical network and its L3 device.
 * Everything that carries that network is protected.
 */
export interface ManagementPath {
  /** UCI `interface` section name, e.g. `lan` (null when the route leaves by a device netifd does not know). */
  network: string | null
  /** L3 device of the route, e.g. `br-lan` or `br-lan.1`. */
  device: string
  /** Controller address the route was resolved for (text only). */
  controllerAddress?: string
  reportedAt?: string
}

/** One option change of a diff entry (section 10 `ConfigDiffEntry`). */
export interface ConfigDiffOption {
  name: string
  before: UciValue | null
  after: UciValue | null
  secret?: true
}

/** Section 10 `ConfigDiffEntry`. */
export interface ConfigDiffEntry {
  perchId: string | null
  config: string
  section: string
  type: string
  domain: string | null
  action: 'create' | 'update' | 'delete' | 'adopt' | 'order'
  options: ConfigDiffOption[]
}

/** A validation finding; `error` blocks an apply, `warning` does not. */
export interface Issue {
  severity: 'error' | 'warning'
  code: string
  message: string
  perchId?: string | null
  config?: string
  section?: string
  option?: string
}

/** A value in an apply op: plain, a secret to resolve from `secrets`, or "leave the router's". */
export type WireValue = UciValue | { $secret: string } | { $keep: true }

/** Where a created or moved section goes (section 4 `position`). */
export interface OpPosition {
  after?: string
  before?: string
}

/**
 * One op of `gateway.config.apply` (section 4). `put` fully replaces the
 * section's options (creating it when absent); `adopt` registers an existing
 * section in the ledger, renaming an anonymous one to `perch_<id>`.
 */
export type ApplyOp =
  | {
      op: 'put'
      config: string
      section: string
      type: string
      options: Record<string, WireValue>
      position?: OpPosition
    }
  | {
      op: 'adopt'
      config: string
      section: string
      perchId: string
      renameTo?: string
      /** The ledger entry's domain (perch-collector writes it into `perch-managed`). */
      domain?: string
    }
  | { op: 'delete'; config: string; section: string }
  | { op: 'order'; config: string; type: string; sections: string[] }

/** Ledger edits that ride along with an apply. */
export interface LedgerChange {
  set: LedgerEntry[]
  remove: string[]
}

/**
 * `gateway.capabilities` result (section 4), as stored on `gateways.capabilities`.
 * Every field optional: older agents send less, and the controller must
 * degrade instead of failing.
 */
export interface GatewayCapabilities {
  protocol?: number
  access?: AgentAccess
  /** The effective allowlist: `managed_config` plus installed sibling packages' configs. */
  allowedConfigs?: string[]
  /**
   * README 7.7 (decision 7): sibling packages whose config joins the
   * allowlist once installed (`sqm-scripts` → `sqm`, `perch-qos` →
   * `perch-qos`), and why each is or is not allowed now.
   */
  siblingConfigs?: SiblingConfig[]
  transportOk?: boolean
  backend?: 'ubus' | 'uci-cli' | null
  openwrt?: { release?: string; revision?: string; target?: string; arch?: string; board?: string }
  firewall?: 'fw4' | 'fw3' | null
  packageManager?: 'opkg' | 'apk'
  packages?: Record<string, string>
  configs?: string[]
  hashes?: Record<string, string>
  uncommitted?: string[]
  apply?: Record<string, unknown>
  capture?: { networks: Array<{ network: string; device: string }> }
  /** README 7.18: what backs the local state path. */
  storage?: { path?: string; kind?: StorageKind; mounted?: boolean }
  management?: ManagementPath
  [key: string]: unknown
}

/** One sibling package's config on the router's allowlist (capabilities). */
export interface SiblingConfig {
  config: string
  package: string
  installed: boolean
  allowed: boolean
  /** `listed` (in managed_config), `installed` (joined by itself), `not_installed`, `opted_out` (UCI). */
  reason: 'listed' | 'installed' | 'not_installed' | 'opted_out'
}

/** Storage class behind the router-side state path (README 7.18). */
export const STORAGE_KINDS = ['spi_flash', 'emmc', 'usb', 'sata', 'ram', 'unknown'] as const
export type StorageKind = (typeof STORAGE_KINDS)[number]

// ── who changed it: users and Perch itself ───────────────────────────────

/**
 * What made a plane write that no user made (section 6.8): the QoS sender's
 * `perch-qos` package (`qos`: an admin's policy edit is debounced into it, a
 * portal grant or an expiry sweep changes it), the portal, Authoritative
 * Mode's reverts (`enforcement`). Stored in `system_actor` (≤ 16 chars) of
 * events, revisions and applies; shown as "Perch (system)".
 */
export const SYSTEM_ACTORS = ['qos', 'portal', 'enforcement', 'system'] as const
export type SystemActor = (typeof SYSTEM_ACTORS)[number]

/** The display name of every system actor. */
export const SYSTEM_ACTOR_NAME = 'Perch (system)'

/**
 * Who asks for a change of a gateway's desired state: an admin (REST) or
 * Perch itself. A bare number is a user id (the admin REST handlers).
 * Admin-only REST stays admin-only: only in-process callers (the QoS
 * sender, the enforcement tick) can name a system actor.
 */
export type PlaneActor = number | { userId: number } | { system: SystemActor }

/** The stored form of an actor: `user_id` and `system_actor` columns. */
export function actorColumns(actor: PlaneActor | null | undefined): {
  userId: number | null
  systemActor: SystemActor | null
} {
  if (actor === null || actor === undefined) return { userId: null, systemActor: null }
  if (typeof actor === 'number') return { userId: actor, systemActor: null }
  if ('userId' in actor) return { userId: actor.userId, systemActor: null }
  return { userId: null, systemActor: actor.system }
}

/** `system_actor` as stored, when it is a known one. */
export function parseSystemActor(value: string | null | undefined): SystemActor | null {
  return value && (SYSTEM_ACTORS as readonly string[]).includes(value)
    ? (value as SystemActor)
    : null
}
