import {
  cloneContent,
  contentFromEntries,
  contentsEqual,
  DEFAULT_RULES,
  diffEntry,
  entriesEqual,
  entriesOf,
  itemsOf,
  ownedItems,
  ownsOption,
  valueKey,
  type Entry,
  type MergeRules,
} from '#services/gateway_config/canonical'
import {
  compareConfigs,
  EXCLUDED_CONFIGS,
  LEDGER_CONFIG,
  roundTripsSection,
  syncedFromRouter,
  type DomainRegistry,
} from '#services/gateway_config/domain'
import { routerSecretSlots } from '#services/gateway_config/secrets'
import type {
  ApplyState,
  ConfigDiffEntry,
  ConflictOption,
  GatewayEnforcement,
  GatewayEventName,
  GatewayMode,
  GatewaySyncState,
  LedgerEntry,
  RevisionSource,
  SectionConflict,
  SectionContent,
  SectionIssue,
  SectionOwnership,
  SectionScope,
  SectionStatus,
  UciConfig,
  UciConfigSet,
  UciSection,
  UciValue,
} from '#services/gateway_config/types'

/**
 * The pure sync engine of the config plane (docs/gateway/config-plane.md
 * section 5, README 3.1 and 3.2): three-way merge per option against a
 * per-section base, conflicts, Authoritative Mode drift, the "in sync"
 * predicate and the gateway's sync-state rollup. No I/O: callers (the agent
 * wiring, the REST layer) load `SectionState`s, call in here and persist
 * what comes back, inside the gateway's serial queue.
 *
 * Terms: B = base (last content both sides agreed on), R = the router's
 * content at the last read, C = the controller's desired content. `null`
 * means "absent". Only options Perch owns (the section's `ownership`) are
 * merged three-way; router-owned options always take R.
 */

// ── state ────────────────────────────────────────────────────────────────

/** One `gateway_sections` row as the engine sees it. */
export interface SectionState {
  perchId: string
  config: string
  /** Section name on the router (or to be created with). */
  name: string
  type: string
  anonymous: boolean
  scope: SectionScope
  domain: string | null
  /** Null = the whole section. */
  ownership: SectionOwnership | null
  issue: SectionIssue | null
  base: SectionContent | null
  baseRevision: number | null
  router: SectionContent | null
  desired: SectionContent | null
  status: SectionStatus
  conflict: SectionConflict | null
  driftSince: string | null
  /** Index among the router's sections of its config at the last read. */
  position: number | null
}

/** Rules for a section: its domain's, else the defaults. */
function rulesOf(registry: DomainRegistry | null, state: { domain: string | null }): MergeRules {
  return registry ? registry.rules(state.domain) : DEFAULT_RULES
}

// ── three-way merge of one section ───────────────────────────────────────

/** An admin's decision for one conflicting option (section 5.2 resolution). */
export type OptionResolution =
  | { take: 'router' }
  | { take: 'controller' }
  | { take: 'custom'; value: UciValue | null }

/** Decisions for a conflicted section: per option, or for the whole section. */
export type ConflictResolution =
  | { take: 'router' }
  | { take: 'controller' }
  | { take: 'custom'; options: Record<string, OptionResolution> }

export interface MergeInput {
  base: SectionContent | null
  router: SectionContent | null
  desired: SectionContent | null
  ownership?: SectionOwnership | null
  rules?: MergeRules
  /** Per-option decisions that settle conflicts (`resolveConflict`). */
  resolutions?: Record<string, OptionResolution>
  /** Whole-section decision (delete-vs-edit and type conflicts). */
  sectionResolution?: 'router' | 'controller'
}

export type MergeResult =
  /** R = B: the router did not move; C stands. */
  | { kind: 'unchanged' }
  /**
   * The router moved and the merge is clean: B := R, C := `desired`.
   * `imported` when C was not moved by the controller (C = R afterwards).
   */
  | {
      kind: 'merged'
      base: SectionContent | null
      desired: SectionContent | null
      imported: boolean
      ownership: SectionOwnership | null
    }
  /** Both moved on the same owned option (or delete vs edit, or type). B and C stay. */
  | { kind: 'conflict'; conflict: Omit<SectionConflict, 'detectedAt'> }

/**
 * Three-way merge of one section (section 5.1):
 *
 * - R = B: unchanged, C stands (it may be a pending controller edit);
 * - C = B: import R (C := B := R);
 * - both moved: per owned option, C[o] if R[o] = B[o], R[o] if C[o] = B[o],
 *   either if equal, else a conflict on o. Router-owned options take R.
 *   Set and keyed lists, and item-owned lists, merge item by item.
 * - deleted on one side and edited on the other, or the type changed while
 *   the controller also moved: a section-level conflict. Deleted on both:
 *   gone.
 */
export function mergeSection(input: MergeInput): MergeResult {
  const rules = input.rules ?? DEFAULT_RULES
  const ownership = input.ownership ?? null
  const { base, router, desired } = input

  if (contentsEqual(router, base, rules)) return { kind: 'unchanged' }

  const controllerMoved = !contentsEqual(desired, base, rules)
  const takeRouter = (): MergeResult => ({
    kind: 'merged',
    base: cloneContent(router),
    desired: cloneContent(router),
    imported: true,
    ownership: pruneOwnership(ownership, router),
  })

  if (!controllerMoved || input.sectionResolution === 'router') return takeRouter()
  if (input.sectionResolution === 'controller') {
    return {
      kind: 'merged',
      base: cloneContent(router),
      desired: cloneContent(desired),
      imported: contentsEqual(desired, router, rules),
      ownership,
    }
  }

  // Both moved from here on.
  if (!router && !desired) {
    return { kind: 'merged', base: null, desired: null, imported: true, ownership }
  }
  if (!router || !desired) {
    // Deleted on one side, edited (or created) on the other.
    return {
      kind: 'conflict',
      conflict: {
        kind: 'delete_vs_edit',
        options: conflictDisplay(base, router, desired, rules),
        origin: 'merge',
      },
    }
  }
  const baseType = base?.type ?? router.type
  let type = router.type
  if (router.type !== desired.type) {
    if (router.type === baseType) {
      type = desired.type
    } else {
      return {
        kind: 'conflict',
        conflict: {
          kind: 'type',
          options: [
            {
              name: '.type',
              base: base?.type ?? null,
              router: router.type,
              controller: desired.type,
            },
          ],
          origin: 'merge',
        },
      }
    }
  }

  const b = entriesOf(base)
  const r = entriesOf(router)
  const c = entriesOf(desired)
  const merged = new Map<string, Entry>()
  const conflicts: ConflictOption[] = []
  const nextItems: Record<string, string[]> = {}
  const names = [...new Set([...b.keys(), ...r.keys(), ...c.keys()])].sort()

  for (const name of names) {
    const rb = b.get(name)
    const rr = r.get(name)
    const rc = c.get(name)

    if (!ownsOption(ownership, name)) {
      if (rr) merged.set(name, rr)
      continue
    }

    const owned = ownedItems(ownership, name)
    if (owned && isListish(rb, rr, rc)) {
      const out = mergeOwnedItems(owned, rb, rr, rc)
      if (out.value.length > 0) merged.set(name, { kind: 'value', value: out.value })
      nextItems[name] = out.owned
      continue
    }

    const resolution = input.resolutions?.[name]
    const outcome = mergeEntry(type, name, rb, rr, rc, rules)
    if (outcome.kind === 'conflict') {
      if (resolution) {
        const chosen = resolveEntry(resolution, rr, rc)
        if (chosen) merged.set(name, chosen)
        continue
      }
      conflicts.push({
        name,
        base: display(rb),
        router: display(rr),
        controller: display(rc),
      })
      continue
    }
    if (outcome.entry) merged.set(name, outcome.entry)
  }

  if (conflicts.length > 0) {
    return { kind: 'conflict', conflict: { kind: 'options', options: conflicts, origin: 'merge' } }
  }
  const result = contentFromEntries(type, merged)
  return {
    kind: 'merged',
    base: cloneContent(router),
    desired: result,
    imported: contentsEqual(result, router, rules),
    ownership: withItems(ownership, nextItems),
  }
}

function isListish(...entries: Array<Entry | undefined>): boolean {
  return entries.every((e) => !e || e.kind === 'value')
}

function display(entry: Entry | undefined): unknown {
  if (!entry) return null
  return entry.kind === 'secret' ? { secret: entry.slot.fingerprint } : entry.value
}

function conflictDisplay(
  base: SectionContent | null,
  router: SectionContent | null,
  desired: SectionContent | null,
  rules: MergeRules
): ConflictOption[] {
  const b = entriesOf(base)
  const r = entriesOf(router)
  const c = entriesOf(desired)
  const type = base?.type ?? router?.type ?? desired?.type ?? ''
  const out: ConflictOption[] = []
  for (const name of [...new Set([...b.keys(), ...r.keys(), ...c.keys()])].sort()) {
    const same =
      entriesEqual(type, name, b.get(name), r.get(name), rules) &&
      entriesEqual(type, name, b.get(name), c.get(name), rules)
    if (same) continue
    out.push({
      name,
      base: display(b.get(name)),
      router: display(r.get(name)),
      controller: display(c.get(name)),
    })
  }
  return out
}

type EntryOutcome = { kind: 'value'; entry: Entry | undefined } | { kind: 'conflict' }

/** Three-way merge of one owned option. */
function mergeEntry(
  type: string,
  name: string,
  b: Entry | undefined,
  r: Entry | undefined,
  c: Entry | undefined,
  rules: MergeRules
): EntryOutcome {
  if (entriesEqual(type, name, r, b, rules)) return { kind: 'value', entry: c }
  if (entriesEqual(type, name, c, b, rules)) return { kind: 'value', entry: r }
  if (entriesEqual(type, name, r, c, rules)) return { kind: 'value', entry: r }

  const semantics = rules.listSemantics(type, name)
  const plain = [b, r, c].every((e) => !e || e.kind === 'value')
  if (semantics !== 'atomic' && plain) {
    const values = [b, r, c].map((e) => (e ? itemsOf((e as { value: UciValue }).value) : null))
    const merged =
      semantics === 'set'
        ? mergeSetItems(values[0] ?? [], values[1] ?? [], values[2] ?? [])
        : mergeKeyedItems(semantics.keyed, values[0] ?? [], values[1] ?? [], values[2] ?? [])
    if (merged === null) return { kind: 'conflict' }
    return {
      kind: 'value',
      entry: merged.length > 0 ? { kind: 'value', value: merged } : undefined,
    }
  }
  return { kind: 'conflict' }
}

function resolveEntry(
  resolution: OptionResolution,
  router: Entry | undefined,
  controller: Entry | undefined
): Entry | undefined {
  if (resolution.take === 'router') return router
  if (resolution.take === 'controller') return controller
  return resolution.value === null ? undefined : { kind: 'value', value: resolution.value }
}

/**
 * Item-level three-way merge of a set list: an item is present in the
 * result when the router kept the base's answer and the controller has it,
 * or the controller kept the base's answer and the router has it. Never a
 * conflict (both changing one item's presence agree by construction).
 * Order: the router's, then items only the controller added, in its order.
 */
export function mergeSetItems(base: string[], router: string[], desired: string[]): string[] {
  const inB = new Set(base)
  const inR = new Set(router)
  const inC = new Set(desired)
  const present = (item: string) => {
    const b = inB.has(item)
    const r = inR.has(item)
    const c = inC.has(item)
    return r === b ? c : r
  }
  const out: string[] = []
  for (const item of [...router, ...desired]) {
    if (!out.includes(item) && present(item)) out.push(item)
  }
  return out
}

/**
 * Item-level three-way merge of a keyed list (`dhcp_option` by option
 * code): per key, the value merges like an option; both sides changing one
 * key differently is a conflict (null).
 */
export function mergeKeyedItems(
  keyOf: (item: string) => string,
  base: string[],
  router: string[],
  desired: string[]
): string[] | null {
  const index = (items: string[]) => {
    const map = new Map<string, string[]>()
    for (const item of items) {
      const key = keyOf(item)
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return map
  }
  const b = index(base)
  const r = index(router)
  const c = index(desired)
  const same = (x: string[] | undefined, y: string[] | undefined) =>
    JSON.stringify(x ?? null) === JSON.stringify(y ?? null)
  const keys = [...new Set([...r.keys(), ...c.keys(), ...b.keys()])]
  const chosen = new Map<string, string[] | undefined>()
  for (const key of keys) {
    const vb = b.get(key)
    const vr = r.get(key)
    const vc = c.get(key)
    if (same(vr, vb)) chosen.set(key, vc)
    else if (same(vc, vb)) chosen.set(key, vr)
    else if (same(vr, vc)) chosen.set(key, vr)
    else return null
  }
  const out: string[] = []
  const emitted = new Set<string>()
  for (const item of [...router, ...desired]) {
    const key = keyOf(item)
    if (emitted.has(key)) continue
    emitted.add(key)
    out.push(...(chosen.get(key) ?? []))
  }
  return out
}

/**
 * Item-owned list option (README 3.2, plan 2 P4): foreign items are the
 * router's (kept in its order), owned items merge three-way by presence.
 * Returns the merged list and the owned items still present.
 */
function mergeOwnedItems(
  owned: string[],
  b: Entry | undefined,
  r: Entry | undefined,
  c: Entry | undefined
): { value: string[]; owned: string[] } {
  const items = (e: Entry | undefined) => (e && e.kind === 'value' ? itemsOf(e.value) : [])
  const base = items(b)
  const router = items(r)
  const desired = items(c)
  const isOwned = (item: string) => owned.includes(item)
  const mergedOwned = mergeSetItems(
    base.filter(isOwned),
    router.filter(isOwned),
    desired.filter(isOwned)
  )
  const value: string[] = []
  for (const item of router) {
    if (!isOwned(item)) value.push(item)
    else if (mergedOwned.includes(item) && !value.includes(item)) value.push(item)
  }
  for (const item of mergedOwned) if (!value.includes(item)) value.push(item)
  return { value, owned: owned.filter((item) => mergedOwned.includes(item)) }
}

function withItems(
  ownership: SectionOwnership | null,
  items: Record<string, string[]>
): SectionOwnership | null {
  if (!ownership || ownership.kind === 'section' || !ownership.items) return ownership
  return { ...ownership, items: { ...ownership.items, ...items } }
}

/** Drops owned items the content no longer has (after an import). */
function pruneOwnership(
  ownership: SectionOwnership | null,
  content: SectionContent | null
): SectionOwnership | null {
  if (!ownership || ownership.kind === 'section' || !ownership.items) return ownership
  const items: Record<string, string[]> = {}
  for (const [name, owned] of Object.entries(ownership.items)) {
    const present = itemsOf(content?.options[name])
    items[name] = owned.filter((item) => present.includes(item))
  }
  return { ...ownership, items }
}

/**
 * Content where every router-owned option follows the router and every
 * owned option follows `desired` (Authoritative Mode's "controller wins",
 * and what a revert writes). Item-owned lists: the router's foreign items
 * plus the desired owned items.
 */
export function controllerWins(
  router: SectionContent | null,
  desired: SectionContent | null,
  ownership: SectionOwnership | null
): SectionContent | null {
  if (!desired) return null
  if (!ownership || ownership.kind === 'section' || !router) return cloneContent(desired)
  const r = entriesOf(router)
  const c = entriesOf(desired)
  const out = new Map<string, Entry>()
  for (const name of new Set([...r.keys(), ...c.keys()])) {
    if (!ownsOption(ownership, name)) {
      const entry = r.get(name)
      if (entry) out.set(name, entry)
      continue
    }
    const owned = ownedItems(ownership, name)
    const rr = r.get(name)
    const cc = c.get(name)
    if (owned && isListish(rr, cc)) {
      const foreign = itemsOf(rr && rr.kind === 'value' ? rr.value : undefined).filter(
        (item) => !owned.includes(item)
      )
      const mine = itemsOf(cc && cc.kind === 'value' ? cc.value : undefined).filter((item) =>
        owned.includes(item)
      )
      const value = [...foreign, ...mine.filter((item) => !foreign.includes(item))]
      if (value.length > 0) out.set(name, { kind: 'value', value })
      continue
    }
    if (cc) out.set(name, cc)
  }
  return contentFromEntries(desired.type, out)
}

// ── statuses ─────────────────────────────────────────────────────────────

/** What is in flight for a section, from the apply lifecycle. */
export type InFlight = 'apply' | 'revert' | null

/**
 * A section's status from its contents (section 5.6):
 * conflict > reverting / pending (in flight) > drift (authoritative, the
 * router moved away from B and C on owned options) > ahead (C ≠ R) >
 * in_sync. Non-synced sections are always `in_sync`.
 */
export function deriveStatus(
  state: Pick<SectionState, 'scope' | 'base' | 'router' | 'desired' | 'conflict' | 'ownership'>,
  ctx: { authoritative: boolean; inFlight?: InFlight; rules?: MergeRules }
): SectionStatus {
  if (state.scope !== 'synced') return 'in_sync'
  if (state.conflict) return 'conflict'
  if (ctx.inFlight === 'revert') return 'reverting'
  if (ctx.inFlight === 'apply') return 'pending'
  const rules = ctx.rules ?? DEFAULT_RULES
  if (ctx.authoritative && isDrifted(state, rules)) return 'drift'
  if (!contentsEqual(state.desired, state.router, rules)) return 'ahead'
  return 'in_sync'
}

/** Authoritative drift: owned R differs from both owned B and owned C. */
export function isDrifted(
  state: Pick<SectionState, 'base' | 'router' | 'desired' | 'ownership'>,
  rules: MergeRules = DEFAULT_RULES
): boolean {
  return (
    !contentsEqual(state.router, state.base, rules, state.ownership) &&
    !contentsEqual(state.router, state.desired, rules, state.ownership)
  )
}

/**
 * The gateway's `sync_state` rollup: unknown (mode off or never read) >
 * applying (an apply in flight) > conflict > drift > ahead > in_sync.
 */
export function rollupSyncState(input: {
  mode: GatewayMode
  observedAt: string | null
  applyInFlight: boolean
  statuses: Iterable<SectionStatus>
}): GatewaySyncState {
  if (input.mode === 'off' || !input.observedAt) return 'unknown'
  if (input.applyInFlight) return 'applying'
  const seen = new Set(input.statuses)
  if (seen.has('conflict')) return 'conflict'
  if (seen.has('drift') || seen.has('reverting')) return 'drift'
  if (seen.has('pending')) return 'applying'
  if (seen.has('ahead')) return 'ahead'
  return 'in_sync'
}

// ── reconciling one read ─────────────────────────────────────────────────

/** An engine event, persisted by the caller as a `gateway_config_events` row. */
export interface EngineEvent {
  event: GatewayEventName
  perchId: string | null
  config: string
  section: string
  detail?: Record<string, unknown>
}

export type SectionChangeKind =
  /** New row: a router section seen for the first time. */
  | 'created'
  /** Router edit imported (B := C := R). */
  | 'imported'
  /** Both moved, merged cleanly (B := R, C := merged, status ahead). */
  | 'merged'
  | 'conflict'
  | 'drift'
  /** Authoritative: the router came back to B or C. */
  | 'drift_cleared'
  /** Excluded / unmodeled mirror updated. */
  | 'mirrored'
  /** Row gone: mirror vanished, or deleted on both sides, or a deletion imported. */
  | 'removed'
  /** Re-linked to a router section under another name (identity keys). */
  | 'relinked'
  /** Router section left alone: an apply carrying it is in flight. */
  | 'deferred'
  /** Scope changed (a mirror became synced, a synced one became unmodeled). */
  | 'rescoped'

export interface SectionChange {
  perchId: string
  kind: SectionChangeKind
  before: SectionState | null
  /** Null = delete the row. */
  after: SectionState | null
  /** B changed: the caller records a revision covering it. */
  baseChanged: boolean
}

export interface ReconcileReadInput {
  /** Every current row of the gateway. */
  rows: SectionState[]
  /** The fresh `gateway.config.read` result. */
  read: { configs: UciConfig[]; ledger: LedgerEntry[] }
  registry: DomainRegistry
  mode: GatewayMode
  authoritative: boolean
  /** ISO timestamp used for `driftSince` and conflicts. */
  now: string
  /** A fresh perchId not used by any row (the caller checks the table). */
  newPerchId: () => string
  /** Rows carried by an apply in flight: their router side is not merged now (section 5.5). */
  inFlight?: Map<string, InFlight>
  /** Admin choice per (config, section name) for sections seen for the first time. */
  initialScope?: (config: string, section: UciSection) => 'synced' | 'excluded' | null
}

export interface ReconcileReadResult {
  changes: SectionChange[]
  events: EngineEvent[]
  /** The source a revision for the changed bases should carry. */
  revisionSource: RevisionSource | null
  /** Synced rows whose section is not (or not correctly) in the router's ledger. */
  unledgered: string[]
}

/**
 * Merges one fresh read into the controller's rows (sections 5.1–5.5,
 * README 3.1): matches router sections to rows through the ledger (then by
 * name, then by the domain's identity keys), claims new sections for their
 * domain (round trip checked), mirrors excluded and unmodeled ones and runs
 * the per-section merge or drift detection. Configs that are not in the read
 * are left alone. Nothing here writes; the caller persists `changes` and
 * `events` and, when any `baseChanged`, a revision with `revisionSource`.
 */
export function reconcileRead(input: ReconcileReadInput): ReconcileReadResult {
  const { registry } = input
  const changes: SectionChange[] = []
  const events: EngineEvent[] = []
  const readConfigs = input.read.configs.filter(
    (c) => c.name !== LEDGER_CONFIG && !EXCLUDED_CONFIGS.includes(c.name)
  )
  const all: UciConfigSet = Object.fromEntries(readConfigs.map((c) => [c.name, c]))
  const firstRead = input.rows.length === 0
  const ledgerByPerch = new Map(input.read.ledger.map((e) => [e.perchId, e]))
  let merges = 0

  for (const config of [...readConfigs].sort((a, b) => compareConfigs(a.name, b.name))) {
    const rows = input.rows.filter((r) => r.config === config.name)
    const byName = new Map(config.sections.map((s, i) => [s.name, { section: s, index: i }]))
    const used = new Set<string>()
    const pendingRows: Array<{
      row: SectionState
      found: { section: UciSection; index: number } | null
    }> = []

    // 1. Synced rows: ledger first, then their own name.
    for (const row of rows.filter((r) => r.scope === 'synced')) {
      const entry = ledgerByPerch.get(row.perchId)
      let found = entry && entry.config === config.name ? byName.get(entry.section) : undefined
      if (!found) found = byName.get(row.name)
      if (found && used.has(found.section.name)) found = undefined
      if (found) used.add(found.section.name)
      pendingRows.push({ row, found: found ?? null })
    }

    // 2. Mirrors (excluded / unmodeled) by name.
    for (const row of rows.filter((r) => r.scope !== 'synced')) {
      const found = byName.get(row.name)
      if (found && !used.has(found.section.name)) {
        used.add(found.section.name)
        pendingRows.push({ row, found })
      } else {
        pendingRows.push({ row, found: null })
      }
    }

    // 3. Router sections nobody matched: claim them once, find duplicates by
    // identity key (plan 2 P6), and re-link synced rows the router lost from
    // the ledger or renamed.
    const claimOf = new Map<string, ReturnType<DomainRegistry['claim']>>()
    const keysOf = new Map<string, string[]>()
    const keyCount = new Map<string, number>()
    for (const section of config.sections) {
      const claim = registry.claim({ ...section, config: config.name }, all)
      claimOf.set(section.name, claim)
      const keys = claim
        ? (claim.domain.identityKeys?.({ type: section.type, options: section.options }) ?? []).map(
            (k) => `${claim.domain.key}|${k}`
          )
        : []
      keysOf.set(section.name, keys)
      for (const key of new Set(keys)) keyCount.set(key, (keyCount.get(key) ?? 0) + 1)
    }
    const leftovers = config.sections
      .map((section, index) => ({ section, index }))
      .filter((s) => !used.has(s.section.name))
    const ambiguous = new Set(
      leftovers
        .filter((l) => (keysOf.get(l.section.name) ?? []).some((k) => (keyCount.get(k) ?? 0) > 1))
        .map((l) => l.section.name)
    )
    const relinked = new Set<string>()
    for (const left of leftovers) {
      if (ambiguous.has(left.section.name)) continue
      const claim = claimOf.get(left.section.name)
      const keys = keysOf.get(left.section.name) ?? []
      if (!claim || keys.length === 0) continue
      const candidates = pendingRows.filter((p) => {
        if (p.found || p.row.scope !== 'synced' || p.row.domain !== claim.domain.key) return false
        const known = p.row.router ?? p.row.base
        if (!known) return false
        const rowKeys = (
          claim.domain.identityKeys?.({ type: known.type, options: known.options }) ?? []
        ).map((k) => `${claim.domain.key}|${k}`)
        return rowKeys.some((k) => keys.includes(k))
      })
      if (candidates.length !== 1) continue
      candidates[0].found = left
      used.add(left.section.name)
      relinked.add(candidates[0].row.perchId)
    }

    // 4. Per-row merge. One-way domains (README 2, Perch-owned config) are
    // authoritative whatever the gateway's flag; a config's first import is
    // never drift.
    const firstOfConfig = !rows.some((r) => r.scope === 'synced')
    for (const { row, found } of pendingRows) {
      const change = reconcileRow(row, found, config.name, all, rowInput(input, row.domain), events)
      if (!change) continue
      if (relinked.has(row.perchId)) {
        change.kind = 'relinked'
        events.push({
          event: 'imported',
          perchId: row.perchId,
          config: config.name,
          section: change.after?.name ?? row.name,
          detail: { relinkedFrom: row.name },
        })
      }
      if (change.kind === 'merged') merges++
      changes.push(change)
    }

    // 5. New router sections.
    for (const left of leftovers) {
      if (used.has(left.section.name)) continue
      const claim = claimOf.get(left.section.name) ?? null
      const change = newRouterSection(
        left.section,
        left.index,
        config.name,
        claim,
        ambiguous.has(left.section.name),
        claim?.domain.oneWay && firstOfConfig ? input : rowInput(input, claim?.domain.key ?? null),
        events
      )
      changes.push(change)
    }
  }

  const unledgered = computeUnledgered(
    [
      ...input.rows.filter((r) => !changes.some((c) => c.perchId === r.perchId)),
      ...changes.map((c) => c.after).filter((s): s is SectionState => s !== null),
    ],
    input.read.ledger
  )
  const baseChanged = changes.some((c) => c.baseChanged)
  return {
    changes,
    events,
    revisionSource: !baseChanged ? null : firstRead ? 'import' : merges > 0 ? 'merge' : 'router',
    unledgered,
  }
}

/** Synced rows present on the router whose ledger entry is missing or names another section. */
export function computeUnledgered(rows: SectionState[], ledger: LedgerEntry[]): string[] {
  const byPerch = new Map(ledger.map((e) => [e.perchId, e]))
  return rows
    .filter((r) => r.scope === 'synced' && r.router !== null)
    .filter((r) => {
      const entry = byPerch.get(r.perchId)
      return !entry || entry.config !== r.config || entry.section !== r.name
    })
    .map((r) => r.perchId)
}

/**
 * Whether a section's position is part of its state: only for the ordered
 * types of its domain (firewall rules). Elsewhere a shifted index (a section
 * above it was deleted) is not a change of this section.
 */
function positionMatters(row: SectionState, registry: DomainRegistry): boolean {
  return registry.get(row.domain)?.orderedTypes?.includes(row.type) ?? false
}

function contentFromRouter(section: UciSection): SectionContent {
  const secrets = routerSecretSlots(section.secrets)
  return secrets
    ? { type: section.type, options: { ...section.options }, secrets }
    : { type: section.type, options: { ...section.options } }
}

/**
 * The read input as one row sees it: a one-way domain's rows are
 * authoritative in managed mode, whatever the gateway's flag.
 */
function rowInput(input: ReconcileReadInput, domain: string | null): ReconcileReadInput {
  if (input.authoritative || input.mode !== 'managed') return input
  return input.registry.get(domain)?.oneWay ? { ...input, authoritative: true } : input
}

/**
 * Whether a section is authoritative for the engine: the gateway's flag in
 * managed mode, or a one-way domain's section in managed mode (README 2).
 */
export function authoritativeFor(
  gateway: { mode: GatewayMode; authoritative: boolean },
  registry: DomainRegistry | null,
  domain: string | null
): boolean {
  if (gateway.mode !== 'managed') return false
  return gateway.authoritative || registry?.get(domain)?.oneWay === true
}

/** A decision-15 pause change of one synced row (`routerPause`). */
export interface PauseTransition {
  kind: 'hold' | 'release' | 'refresh'
  ownership: SectionOwnership | null
}

/** Does this ownership leave `option` to the router? */
export function pauseHeld(ownership: SectionOwnership | null, option: string): boolean {
  return ownership !== null && ownership.kind === 'options' && !ownsOption(ownership, option)
}

/**
 * Owner decision 15 for one synced row and the router's content: the router
 * paused (its value paused, the agreed base not) → hold the option; it
 * resumed while held → release. Null = nothing changes. Pure.
 */
export function pauseTransition(
  row: Pick<SectionState, 'config' | 'name' | 'anonymous' | 'base' | 'ownership' | 'domain'>,
  observed: SectionContent | null,
  registry: DomainRegistry
): PauseTransition | null {
  const domain = registry.get(row.domain)
  const rule = domain?.routerPause
  if (!domain || !rule || !observed || observed.type !== rule.type) return null
  const held = pauseHeld(row.ownership, rule.option)
  const routerPaused = rule.isPaused(observed.options[rule.option])
  const claimed = () => {
    const own =
      domain.ownership?.({
        config: row.config,
        name: row.name,
        type: observed.type,
        anonymous: row.anonymous,
        index: 0,
        options: observed.options,
      }) ?? null
    return own && own.kind === 'options' ? own : null
  }
  if (held) {
    if (!routerPaused) return { kind: 'release', ownership: null }
    const next = claimed()
    if (
      next &&
      pauseHeld(next, rule.option) &&
      canonicalJson(next) !== canonicalJson(row.ownership)
    ) {
      return { kind: 'refresh', ownership: next }
    }
    return null
  }
  const basePaused =
    row.base !== null && row.base.type === rule.type && rule.isPaused(row.base.options[rule.option])
  if (!routerPaused || basePaused) return null
  const next = claimed()
  const ownership: SectionOwnership =
    next && pauseHeld(next, rule.option)
      ? next
      : {
          kind: 'options',
          options: [
            ...new Set([...Object.keys(observed.options), ...Object.keys(row.base?.options ?? {})]),
          ]
            .filter((o) => o !== rule.option)
            .sort(),
        }
  return { kind: 'hold', ownership }
}

function withOption(
  content: SectionContent | null,
  option: string,
  value: UciValue | undefined
): SectionContent | null {
  if (!content) return content
  const options = { ...content.options }
  if (value === undefined) delete options[option]
  else options[option] = Array.isArray(value) ? [...value] : value
  return { ...content, options }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function reconcileRow(
  row0: SectionState,
  found: { section: UciSection; index: number } | null,
  config: string,
  all: UciConfigSet,
  input: ReconcileReadInput,
  events: EngineEvent[]
): SectionChange | null {
  const inFlight = row0.scope === 'synced' && (input.inFlight?.get(row0.perchId) ?? null) !== null
  const transition =
    row0.scope === 'synced' && !inFlight && input.mode === 'managed'
      ? pauseTransition(row0, found ? contentFromRouter(found.section) : null, input.registry)
      : null
  if (!transition) return reconcileRowInner(row0, found, config, all, input, events)
  let row: SectionState = { ...row0, ownership: transition.ownership }
  if (transition.kind === 'release') {
    // The router resumed: B and C held the router's paused value; they take
    // its value back, so the resume is neither drift nor a merge.
    const option = input.registry.get(row.domain)!.routerPause!.option
    const value = found!.section.options[option]
    row = {
      ...row,
      base: withOption(row.base, option, value),
      desired: withOption(row.desired, option, value),
    }
  }
  if (transition.kind !== 'refresh') {
    events.push({
      event: transition.kind === 'hold' ? 'router_paused' : 'router_resumed',
      perchId: row.perchId,
      config,
      section: found?.section.name ?? row.name,
      detail: { option: input.registry.get(row.domain)!.routerPause!.option },
    })
  }
  const change = reconcileRowInner(row, found, config, all, input, events)
  const released =
    transition.kind === 'release' && !contentsEqual(row.base, row0.base, DEFAULT_RULES)
  if (change) return { ...change, before: row0, baseChanged: change.baseChanged || released }
  return { perchId: row.perchId, kind: 'imported', before: row0, after: row, baseChanged: released }
}

function reconcileRowInner(
  row: SectionState,
  found: { section: UciSection; index: number } | null,
  config: string,
  all: UciConfigSet,
  input: ReconcileReadInput,
  events: EngineEvent[]
): SectionChange | null {
  const observed = found ? contentFromRouter(found.section) : null
  const renamed = found && found.section.name !== row.name
  const located: SectionState = {
    ...row,
    name: found ? found.section.name : row.name,
    anonymous: found ? found.section.anonymous : row.anonymous,
    position: found ? found.index : row.position,
  }
  const rules = input.registry.rules(row.domain)
  const where = { perchId: row.perchId, config, section: located.name }
  const samePosition = located.position === row.position || !positionMatters(row, input.registry)

  // Mirrors: follow the router; gone when the router dropped them.
  if (row.scope !== 'synced') {
    if (!observed) {
      events.push({ event: 'section_removed', ...where, detail: { scope: row.scope } })
      return { perchId: row.perchId, kind: 'removed', before: row, after: null, baseChanged: false }
    }
    const moved = !contentsEqual(row.router, observed, DEFAULT_RULES)
    if (!moved && !renamed && samePosition) return null
    const after: SectionState = {
      ...located,
      type: observed.type,
      router: observed,
      base: observed,
      desired: observed,
      status: 'in_sync',
    }
    if (moved) events.push({ event: 'unmodeled_changed', ...where, detail: { scope: row.scope } })
    return { perchId: row.perchId, kind: 'mirrored', before: row, after, baseChanged: false }
  }

  const inFlight = input.inFlight?.get(row.perchId) ?? null
  if (inFlight) {
    // Queued behind the apply (section 5.5): keep the observation, merge later.
    if (contentsEqual(row.router, observed, DEFAULT_RULES) && !renamed) return null
    return {
      perchId: row.perchId,
      kind: 'deferred',
      before: row,
      after: { ...located, router: observed },
      baseChanged: false,
    }
  }

  const status = (s: SectionState) =>
    deriveStatus(s, { authoritative: input.authoritative && input.mode === 'managed', rules })

  // Observe mode: the router always wins, drafts are dropped.
  if (input.mode !== 'managed') {
    if (!observed) {
      events.push({ event: 'imported', ...where, detail: { deleted: true } })
      return { perchId: row.perchId, kind: 'removed', before: row, after: null, baseChanged: true }
    }
    const same =
      contentsEqual(row.base, observed, DEFAULT_RULES) &&
      contentsEqual(row.desired, observed, DEFAULT_RULES) &&
      !row.conflict
    if (same && !renamed && samePosition) return null
    const after: SectionState = {
      ...located,
      type: observed.type,
      base: observed,
      router: observed,
      desired: observed,
      conflict: null,
      driftSince: null,
      status: 'in_sync',
    }
    if (!contentsEqual(row.base, observed, DEFAULT_RULES))
      events.push({ event: 'imported', ...where })
    return {
      perchId: row.perchId,
      kind: 'imported',
      before: row,
      after,
      baseChanged: !contentsEqual(row.base, observed, DEFAULT_RULES),
    }
  }

  // Authoritative Mode: router edits to owned options are drift, never merged.
  if (input.authoritative) {
    return reconcileAuthoritative(row, located, observed, input, events, rules)
  }

  // Two-way.
  const merge = mergeSection({
    base: row.base,
    router: observed,
    desired: row.desired,
    ownership: row.ownership,
    rules,
  })
  if (merge.kind === 'conflict') {
    // A new conflict, or an open one whose router side moved again.
    const detectedAt = row.conflict?.detectedAt ?? input.now
    const conflict: SectionConflict = { ...merge.conflict, detectedAt }
    if (!row.conflict) {
      events.push({
        event: 'conflict_opened',
        ...where,
        detail: { kind: conflict.kind, options: conflict.options.map((o) => o.name) },
      })
    } else if (contentsEqual(row.router, observed, DEFAULT_RULES) && !renamed) {
      return null
    }
    const after: SectionState = { ...located, router: observed, conflict, status: 'conflict' }
    return { perchId: row.perchId, kind: 'conflict', before: row, after, baseChanged: false }
  }
  // A conflict whose router side came to C or back to B settles by itself.
  const settled = row.conflict !== null && row.conflict.origin !== 'rollback_discarded'
  if (settled) events.push({ event: 'conflict_resolved', ...where, detail: { by: 'router' } })

  if (merge.kind === 'unchanged') {
    const after: SectionState = {
      ...located,
      router: observed,
      conflict: settled ? null : row.conflict,
    }
    after.status = status(after)
    const quiet =
      !renamed &&
      !settled &&
      after.status === row.status &&
      samePosition &&
      contentsEqual(row.router, observed, DEFAULT_RULES)
    if (quiet) return null
    return { perchId: row.perchId, kind: 'imported', before: row, after, baseChanged: false }
  }
  if (!merge.base && !merge.desired) {
    events.push({ event: 'imported', ...where, detail: { deleted: true } })
    return { perchId: row.perchId, kind: 'removed', before: row, after: null, baseChanged: true }
  }
  const after: SectionState = {
    ...located,
    type: merge.desired?.type ?? merge.base?.type ?? row.type,
    base: merge.base,
    router: observed,
    desired: merge.desired,
    ownership: merge.ownership,
    conflict: settled ? null : row.conflict,
    driftSince: null,
    status: 'in_sync',
  }
  after.status = status(after)
  events.push({
    event: 'imported',
    ...where,
    detail: merge.imported ? undefined : { merged: true },
  })

  // The router may have edited the section into something its domain no
  // longer claims or cannot round-trip (a wildcard MAC, another type): it
  // drops out of sync and is mirrored from now on.
  const rescoped = found ? recheckClaim(after, found.section, config, all, input) : null
  return {
    perchId: row.perchId,
    kind: rescoped ? 'rescoped' : merge.imported ? 'imported' : 'merged',
    before: row,
    after: rescoped ?? after,
    baseChanged: true,
  }
}

function recheckClaim(
  state: SectionState,
  section: UciSection,
  config: string,
  all: UciConfigSet,
  input: ReconcileReadInput
): SectionState | null {
  const claim = input.registry.claim({ ...section, config }, all)
  const keeps =
    claim !== null &&
    claim.domain.key === state.domain &&
    roundTripsSection(claim.domain, syncedFromRouter(config, section, state.perchId))
  if (keeps) return null
  return {
    ...state,
    scope: 'unmodeled',
    domain: claim?.domain.key ?? null,
    issue: claim ? 'no_round_trip' : null,
    ownership: null,
    status: 'in_sync',
    base: state.router,
    desired: state.router,
    conflict: null,
  }
}

function reconcileAuthoritative(
  row: SectionState,
  located: SectionState,
  observed: SectionContent | null,
  input: ReconcileReadInput,
  events: EngineEvent[],
  rules: MergeRules
): SectionChange | null {
  const where = { perchId: row.perchId, config: row.config, section: located.name }
  const ownedSameAsBase = contentsEqual(observed, row.base, rules, row.ownership)
  const ownedSameAsDesired = contentsEqual(observed, row.desired, rules, row.ownership)

  if (!observed && !row.base && !row.desired) {
    // A new router section that was drift is gone again.
    events.push({ event: 'drift_detected', ...where, detail: { cleared: true, deleted: true } })
    return { perchId: row.perchId, kind: 'removed', before: row, after: null, baseChanged: false }
  }
  if (ownedSameAsBase || ownedSameAsDesired) {
    // No drift. Router-owned options follow the router silently; when the
    // router reached C (an echo, or someone typed Perch's value), B := R.
    const desired = controllerWins(observed, row.desired, row.ownership)
    const base = ownedSameAsDesired
      ? cloneContent(observed)
      : routerOwnedFollow(row.base, observed, row.ownership)
    const after: SectionState = {
      ...located,
      router: observed,
      base,
      desired,
      driftSince: null,
      conflict: null,
      status: 'in_sync',
    }
    after.status = deriveStatus(after, { authoritative: true, rules })
    const baseChanged = !contentsEqual(base, row.base, DEFAULT_RULES)
    const wasDrift = row.status === 'drift' || row.driftSince !== null
    if (wasDrift) events.push({ event: 'drift_detected', ...where, detail: { cleared: true } })
    if (
      !baseChanged &&
      !wasDrift &&
      after.status === row.status &&
      contentsEqual(row.router, observed, DEFAULT_RULES) &&
      contentsEqual(row.desired, desired, DEFAULT_RULES) &&
      located.name === row.name &&
      (located.position === row.position || !positionMatters(row, input.registry))
    ) {
      return null
    }
    return {
      perchId: row.perchId,
      kind: wasDrift ? 'drift_cleared' : 'imported',
      before: row,
      after,
      baseChanged,
    }
  }

  const after: SectionState = {
    ...located,
    router: observed,
    desired: controllerWins(observed, row.desired, row.ownership),
    driftSince: row.driftSince ?? input.now,
    status: 'drift',
  }
  if (!row.driftSince) {
    events.push({
      event: 'drift_detected',
      ...where,
      detail: {
        deleted: observed === null,
        options: observed
          ? diffEntry({ ...where, domain: row.domain }, row.desired, observed, rules)?.options.map(
              (o) => o.name
            )
          : [],
      },
    })
  }
  return { perchId: row.perchId, kind: 'drift', before: row, after, baseChanged: false }
}

/** B with its router-owned options replaced by the router's (owned ones kept). */
function routerOwnedFollow(
  base: SectionContent | null,
  router: SectionContent | null,
  ownership: SectionOwnership | null
): SectionContent | null {
  if (!base || !router || !ownership || ownership.kind === 'section') return cloneContent(base)
  return controllerWins(router, base, ownership)
}

function newRouterSection(
  section: UciSection,
  index: number,
  config: string,
  claim: ReturnType<DomainRegistry['claim']>,
  ambiguous: boolean,
  input: ReconcileReadInput,
  events: EngineEvent[]
): SectionChange {
  const content = contentFromRouter(section)
  const perchId = input.newPerchId()
  const where = { perchId, config, section: section.name }
  const mirror = (
    scope: SectionScope,
    issue: SectionIssue | null,
    domain: string | null
  ): SectionChange => ({
    perchId,
    kind: 'created',
    before: null,
    after: {
      perchId,
      config,
      name: section.name,
      type: section.type,
      anonymous: section.anonymous,
      scope,
      domain,
      ownership: null,
      issue,
      base: content,
      baseRevision: null,
      router: content,
      desired: content,
      status: 'in_sync',
      conflict: null,
      driftSince: null,
      position: index,
    },
    baseChanged: false,
  })

  if (!claim) return mirror('unmodeled', null, null)
  if (ambiguous) {
    events.push({ event: 'section_ambiguous', ...where, detail: { domain: claim.domain.key } })
    return mirror('unmodeled', 'ambiguous', claim.domain.key)
  }
  if (!roundTripsSection(claim.domain, syncedFromRouter(config, section, perchId))) {
    return mirror('unmodeled', 'no_round_trip', claim.domain.key)
  }
  const chosen = input.initialScope?.(config, section) ?? 'synced'
  if (chosen === 'excluded') return mirror('excluded', null, claim.domain.key)

  const ownership = claim.ownership.kind === 'section' ? null : claim.ownership
  const base: SectionState = {
    perchId,
    config,
    name: section.name,
    type: section.type,
    anonymous: section.anonymous,
    scope: 'synced',
    domain: claim.domain.key,
    ownership,
    issue: null,
    base: content,
    baseRevision: null,
    router: content,
    desired: content,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: index,
  }

  // Authoritative: a new router section of a modeled type is drift (the
  // revert deletes it; its content is kept for "Restore router version").
  if (input.mode === 'managed' && input.authoritative) {
    events.push({ event: 'drift_detected', ...where, detail: { created: true } })
    return {
      perchId,
      kind: 'drift',
      before: null,
      after: { ...base, base: null, desired: null, status: 'drift', driftSince: input.now },
      baseChanged: false,
    }
  }
  events.push({ event: 'imported', ...where, detail: { created: true, domain: claim.domain.key } })
  return { perchId, kind: 'created', before: null, after: base, baseChanged: true }
}

// ── lifecycle transitions of one section ─────────────────────────────────

/**
 * A controller edit (the domain REST writes through `editSections`): C :=
 * `desired`. An open conflict stays open (the edit only changes the
 * controller side); otherwise the status is re-derived. For item-owned list
 * options the caller passes the new `ownership` naming the items C owns
 * (an item Perch adds must be listed, or the merge treats it as foreign).
 */
export function applyControllerEdit(
  state: SectionState,
  desired: SectionContent | null,
  ctx: { authoritative: boolean; rules?: MergeRules; ownership?: SectionOwnership | null }
): SectionState {
  const next: SectionState = {
    ...state,
    desired: cloneContent(desired),
    ownership: ctx.ownership === undefined ? state.ownership : ctx.ownership,
  }
  next.status = deriveStatus(next, ctx)
  return next
}

/** An apply (or revert) carrying the section was sent. */
export function markInFlight(state: SectionState, kind: 'apply' | 'revert'): SectionState {
  return { ...state, status: kind === 'revert' ? 'reverting' : 'pending' }
}

/**
 * The apply was confirmed: the router now runs `written` (the content the
 * op wrote; C unless the planner merged router-owned options in), so B := R
 * := written, and C keeps any edit made meanwhile. Drift is over.
 */
export function markConfirmed(
  state: SectionState,
  written: SectionContent | null,
  ctx: { authoritative: boolean; rules?: MergeRules }
): SectionState {
  const next: SectionState = {
    ...state,
    base: cloneContent(written),
    router: cloneContent(written),
    driftSince: null,
  }
  next.status = deriveStatus(next, ctx)
  return next
}

/**
 * The apply rolled back or failed: the router is where it was (R), the
 * draft stays (C unchanged, B unchanged). Router edits the rollback
 * discarded (section 5.5) come back as a conflict so nothing is lost
 * silently: the discarded content is presented as the router side.
 */
export function markRolledBack(
  state: SectionState,
  ctx: {
    authoritative: boolean
    now: string
    discarded?: SectionContent | null
    rules?: MergeRules
  }
): SectionState {
  const rules = ctx.rules ?? DEFAULT_RULES
  const next: SectionState = { ...state }
  if (ctx.discarded !== undefined && !contentsEqual(ctx.discarded, state.router, rules)) {
    next.conflict = {
      kind: ctx.discarded === null || state.desired === null ? 'delete_vs_edit' : 'options',
      options: conflictDisplay(state.router, ctx.discarded, state.desired, rules),
      detectedAt: ctx.now,
      origin: 'rollback_discarded',
      discarded: cloneContent(ctx.discarded),
    }
  }
  next.status = deriveStatus(next, ctx)
  return next
}

/**
 * Settles a conflict (section 5.2 `POST …/sections/resolve`): router,
 * controller or per-option choices. B := R, C := the resolved content, and
 * the status becomes `ahead` when C ≠ R, else `in_sync`. Returns null when
 * the choices leave an option undecided. A result whose B, R and C are all
 * null (`isGone`) means the section is gone on both sides: delete the row.
 */
export function resolveConflict(
  state: SectionState,
  resolution: ConflictResolution,
  ctx: { authoritative: boolean; rules?: MergeRules }
): SectionState | null {
  if (!state.conflict) return null
  const rules = ctx.rules ?? DEFAULT_RULES
  // After a rollback the router's edit is no longer on the router: its side
  // of the conflict is the discarded content, and B stays the router's.
  const discarded = state.conflict.origin === 'rollback_discarded'
  const routerSide = discarded ? (state.conflict.discarded ?? null) : state.router
  const view: SectionState = { ...state, router: routerSide }
  let desired: SectionContent | null
  let ownership = state.ownership
  if (resolution.take === 'router') {
    desired = cloneContent(routerSide)
  } else if (resolution.take === 'controller') {
    desired = controllerWins(routerSide, state.desired, state.ownership)
  } else {
    if (state.conflict.kind !== 'options') {
      // Whole-section conflicts only take a side, or a custom set of options
      // on top of the controller's content.
      desired = state.desired ? cloneContent(state.desired) : cloneContent(state.router)
      if (desired) {
        for (const [name, choice] of Object.entries(resolution.options)) {
          applyChoice(desired, name, choice, view)
        }
      }
    } else {
      const merge = mergeSection({
        base: discarded ? state.router : state.base,
        router: routerSide,
        desired: state.desired,
        ownership: state.ownership,
        rules,
        resolutions: resolution.options,
      })
      if (merge.kind === 'conflict') return null
      if (merge.kind === 'unchanged') {
        desired = cloneContent(state.desired)
      } else {
        desired = merge.desired
        ownership = merge.ownership
      }
    }
  }
  const next: SectionState = {
    ...state,
    base: cloneContent(state.router),
    desired,
    ownership,
    conflict: null,
  }
  next.status = deriveStatus(next, { ...ctx, rules })
  return next
}

function applyChoice(
  target: SectionContent,
  name: string,
  choice: OptionResolution,
  state: SectionState
) {
  const source =
    choice.take === 'router' ? state.router : choice.take === 'controller' ? state.desired : null
  if (choice.take === 'custom') {
    if (choice.value === null) delete target.options[name]
    else target.options[name] = choice.value
    return
  }
  const value = source?.options[name]
  if (value === undefined) delete target.options[name]
  else target.options[name] = value
}

/**
 * Authoritative Mode: the admin accepts the router's version of a drifted
 * section (C := B := R). A new router section becomes a normal synced one;
 * a deletion is accepted by dropping the row (null).
 */
export function acceptDrift(
  state: SectionState,
  ctx: { rules?: MergeRules } = {}
): SectionState | null {
  if (state.router === null) return null
  const next: SectionState = {
    ...state,
    base: cloneContent(state.router),
    desired: cloneContent(state.router),
    driftSince: null,
    conflict: null,
    status: 'in_sync',
  }
  next.status = deriveStatus(next, { authoritative: true, rules: ctx.rules })
  return next
}

/** B, R and C all absent: the row has nothing left to track. */
export function isGone(state: Pick<SectionState, 'base' | 'router' | 'desired'>): boolean {
  return state.base === null && state.router === null && state.desired === null
}

/** When a drifted section's revert is due (section 5.3), or null when not drifted. */
export function revertDueAt(
  state: Pick<SectionState, 'status' | 'driftSince'>,
  delaySeconds: number
): string | null {
  if (state.status !== 'drift' || !state.driftSince) return null
  return new Date(Date.parse(state.driftSince) + delaySeconds * 1000).toISOString()
}

/** Drifted sections whose grace delay has elapsed, when enforcement is active. */
export function sectionsDueForRevert(
  states: SectionState[],
  ctx: {
    now: string
    delaySeconds: number
    enforcement: GatewayEnforcement
    authoritative: boolean
  }
): string[] {
  if (!ctx.authoritative || ctx.enforcement !== 'active') return []
  const now = Date.parse(ctx.now)
  return states
    .filter((s) => s.scope === 'synced')
    .filter((s) => {
      const due = revertDueAt(s, ctx.delaySeconds)
      return due !== null && Date.parse(due) <= now
    })
    .map((s) => s.perchId)
}

/**
 * Enforcement after a revert failed or rolled back (section 5.3): suspended
 * once `maxFailures` reverts failed inside the window, counting this one.
 */
export function enforcementAfterFailure(
  failureTimes: string[],
  ctx: { now: string; maxFailures: number; windowMinutes: number }
): GatewayEnforcement {
  const since = Date.parse(ctx.now) - ctx.windowMinutes * 60_000
  const recent = failureTimes.filter((t) => Date.parse(t) >= since).length
  return recent >= ctx.maxFailures ? 'suspended' : 'active'
}

// ── gateway-level transitions ────────────────────────────────────────────

export type ModeChangeError =
  | 'router_access_insufficient'
  | 'insecure_transport'
  | 'password_required'
  | 'no_capability'

/**
 * Gateway mode transitions (section 5.6): off → observe needs router
 * access ≥ read and the capability; → managed needs router access write,
 * a secure transport (or both opt-ins, README 7.1) and the step-up
 * password; any → off, and managed → observe, always. Leaving managed also
 * turns Authoritative Mode off (the caller clears it).
 */
export function checkModeChange(
  from: GatewayMode,
  to: GatewayMode,
  ctx: {
    hasCapability: boolean
    routerAccess: 'none' | 'read' | 'write' | null
    transportOk: boolean
    passwordVerified: boolean
  }
): ModeChangeError | null {
  if (from === to || to === 'off') return null
  if (!ctx.hasCapability) return 'no_capability'
  if (to === 'observe') {
    return ctx.routerAccess === 'read' || ctx.routerAccess === 'write'
      ? null
      : 'router_access_insufficient'
  }
  if (ctx.routerAccess !== 'write') return 'router_access_insufficient'
  if (!ctx.transportOk) return 'insecure_transport'
  if (!ctx.passwordVerified) return 'password_required'
  return null
}

/** What moves an apply through its states (section 5.6, the `Apply:` diagram). */
export type ApplyEvent =
  /** Queued job: agent online and the merge before sending opened no conflict. */
  | 'send'
  /** Agent answered `stale_base`: re-read and retry once (stays `sending`). */
  | 'stale_base'
  /** Agent refused the job (bad params, busy, not managed, …) or the retry failed. */
  | 'refused'
  /** Agent committed and replied `pending_confirm`. */
  | 'committed'
  /** Adopt-only job: agent replied `applied` (no confirm window). */
  | 'applied'
  /** Confirm conditions met (new session + push, and the admin in admin_and_agent). */
  | 'confirmed'
  /** Agent rolled back: deadline, admin revert, reboot (boot guard), reload failure. */
  | 'rolled_back'
  /** Agent reported `failed` (partial commit failure it could not roll back cleanly). */
  | 'failed'
  /** A queued job outlived `queueExpiryHours`. */
  | 'expired'
  /** Admin revert of a job that never left the queue. */
  | 'cancel'

const APPLY_TRANSITIONS: Record<string, Partial<Record<ApplyEvent, ApplyState>>> = {
  queued: { send: 'sending', expired: 'expired', cancel: 'cancelled', refused: 'failed' },
  sending: {
    stale_base: 'sending',
    refused: 'failed',
    committed: 'pending_confirm',
    applied: 'confirmed',
    rolled_back: 'rolled_back',
    failed: 'failed',
  },
  pending_confirm: { confirmed: 'confirmed', rolled_back: 'rolled_back', failed: 'failed' },
}

/**
 * The apply state machine (section 5.6): the next state, or null when the
 * event is not valid in `state` (terminal states accept nothing). A
 * rollback result that arrives late (the agent was offline, section 5.5)
 * still moves `pending_confirm` to `rolled_back`.
 */
export function nextApplyState(state: ApplyState, event: ApplyEvent): ApplyState | null {
  return APPLY_TRANSITIONS[state]?.[event] ?? null
}

/** Terminal apply states. */
export const FINISHED_APPLY_STATES: readonly ApplyState[] = [
  'confirmed',
  'rolled_back',
  'failed',
  'expired',
  'cancelled',
]

// ── "in sync" and Authoritative enabling (section 5.4) ───────────────────

export type SyncBlocker =
  | { kind: 'offline' | 'mode_not_managed' | 'apply_in_flight' | 'enforcement_suspended' }
  | {
      kind: 'conflict' | 'controller_ahead' | 'router_ahead' | 'unimported_section'
      perchId: string | null
      config: string
      section: string
      diff: ConfigDiffEntry
    }

export interface SyncStatus {
  inSync: boolean
  headRevision: number
  observedAt: string | null
  luciPending: boolean
  uncommitted: string[]
  blockers: SyncBlocker[]
}

export interface SyncStatusInput {
  mode: GatewayMode
  online: boolean
  enforcement: GatewayEnforcement
  headRevision: number
  observedAt: string | null
  applyInFlight: boolean
  luciPending: boolean
  uncommitted: string[]
  /** Rows after merging the fresh read (`reconcileRead` applied). */
  sections: SectionState[]
  /** Synced rows not (correctly) in the router's ledger (`computeUnledgered`). */
  unledgered: string[]
  registry: DomainRegistry | null
}

/**
 * The blockers of Authoritative Mode and whether both sides are in sync
 * (section 5.4): no open conflict, no draft (C = B) and nothing in flight;
 * for every synced section the router's content equals C; every modeled
 * section on the router is ledgered; no LuCI apply pending. Excluded and
 * unmodeled sections never block.
 */
export function computeSyncStatus(input: SyncStatusInput): SyncStatus {
  const blockers: SyncBlocker[] = []
  if (!input.online) blockers.push({ kind: 'offline' })
  if (input.mode !== 'managed') blockers.push({ kind: 'mode_not_managed' })
  if (input.applyInFlight) blockers.push({ kind: 'apply_in_flight' })
  if (input.enforcement === 'suspended') blockers.push({ kind: 'enforcement_suspended' })

  const unledgered = new Set(input.unledgered)
  const sorted = [...input.sections].sort(
    (a, b) => compareConfigs(a.config, b.config) || a.name.localeCompare(b.name)
  )
  for (const s of sorted) {
    if (s.scope !== 'synced') continue
    const rules = rulesOf(input.registry, s)
    const where = { perchId: s.perchId, config: s.config, section: s.name, domain: s.domain }
    const at = { perchId: s.perchId, config: s.config, section: s.name }
    if (s.conflict) {
      blockers.push({
        kind: 'conflict',
        ...at,
        diff: diffEntry(where, s.router, s.desired, rules) ?? emptyDiff(where, s),
      })
      continue
    }
    if (s.base === null && s.desired === null && s.router !== null) {
      blockers.push({
        kind: 'unimported_section',
        ...at,
        diff: diffEntry(where, null, s.router, rules) ?? emptyDiff(where, s),
      })
      continue
    }
    if (!contentsEqual(s.desired, s.base, rules)) {
      blockers.push({
        kind: 'controller_ahead',
        ...at,
        diff: diffEntry(where, s.router, s.desired, rules) ?? emptyDiff(where, s),
      })
      continue
    }
    if (!contentsEqual(s.router, s.desired, rules)) {
      blockers.push({
        kind: 'router_ahead',
        ...at,
        diff: diffEntry(where, s.desired, s.router, rules) ?? emptyDiff(where, s),
      })
      continue
    }
    if (unledgered.has(s.perchId)) {
      blockers.push({
        kind: 'unimported_section',
        ...at,
        diff: { ...emptyDiff(where, s), action: 'adopt' },
      })
    }
  }
  return {
    inSync: blockers.length === 0 && !input.luciPending,
    headRevision: input.headRevision,
    observedAt: input.observedAt,
    luciPending: input.luciPending,
    uncommitted: [...input.uncommitted],
    blockers,
  }
}

function emptyDiff(
  where: { perchId: string | null; config: string; section: string; domain: string | null },
  s: SectionState
): ConfigDiffEntry {
  return { ...where, type: s.type, action: 'update', options: [] }
}

export type EnableAuthoritativeCheck =
  | { ok: true }
  | { ok: false; error: 'sync_changed'; blockers: SyncBlocker[]; headRevision: number }
  | { ok: false; error: 'not_in_sync'; blockers: SyncBlocker[] }

/**
 * The PATCH `{authoritative:true, expectRevision}` decision (section 5.4
 * steps 2–3), on a status computed from a fresh read inside the gateway's
 * serial queue: the head revision must still be the one the admin saw
 * (else `sync_changed`), and the status must be in sync (else
 * `not_in_sync`). A LuCI apply pending counts as not in sync.
 */
export function checkEnableAuthoritative(
  status: SyncStatus,
  expectRevision: number
): EnableAuthoritativeCheck {
  if (status.headRevision !== expectRevision) {
    return {
      ok: false,
      error: 'sync_changed',
      blockers: status.blockers,
      headRevision: status.headRevision,
    }
  }
  if (!status.inSync) return { ok: false, error: 'not_in_sync', blockers: status.blockers }
  return { ok: true }
}

// ── helpers for callers ──────────────────────────────────────────────────

/** Section-level diff between two row sets' bases (a revision's `diff`). */
export function diffBases(
  before: SectionState[],
  after: SectionState[],
  registry: DomainRegistry | null
): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = []
  const ids = new Set([...before, ...after].map((s) => s.perchId))
  for (const id of ids) {
    const a = before.find((s) => s.perchId === id)
    const b = after.find((s) => s.perchId === id)
    const s = (b ?? a)!
    if (s.scope !== 'synced' && (!a || a.scope !== 'synced')) continue
    const entry = diffEntry(
      { perchId: id, config: s.config, section: s.name, domain: s.domain },
      a?.scope === 'synced' ? a.base : null,
      b?.scope === 'synced' ? b.base : null,
      rulesOf(registry, s)
    )
    if (entry) out.push(entry)
  }
  return out.sort(
    (x, y) => compareConfigs(x.config, y.config) || x.section.localeCompare(y.section)
  )
}

/**
 * Whether a change notification is the echo of the in-flight apply (section
 * 3.3): the router's new content equals what the apply wrote.
 */
export function isEcho(
  observed: SectionContent | null,
  inFlightDesired: SectionContent | null,
  rules: MergeRules = DEFAULT_RULES
): boolean {
  return contentsEqual(observed, inFlightDesired, rules)
}

/** Stable comparison key of an owned value (exported for domain tests). */
export { valueKey }
