import {
  contentsEqual,
  DEFAULT_RULES,
  diffEntry,
  itemsOf,
} from '#services/gateway_config/canonical'
import {
  applySectionEdits,
  compareConfigs,
  contentOf,
  EXCLUDED_CONFIGS,
  SectionEditError,
  type DomainRegistry,
  type SectionEdit,
  type SyncedSection,
} from '#services/gateway_config/domain'
import { wireOptions } from '#services/gateway_config/secrets'
import {
  applyControllerEdit,
  controllerWins,
  type SectionState,
} from '#services/gateway_config/sync_engine'
import type {
  ApplyKind,
  ApplyOp,
  ConfigDiffEntry,
  LedgerChange,
  LedgerEntry,
  ManagementPath,
  OpPosition,
  SectionContent,
} from '#services/gateway_config/types'

/**
 * Apply planning (docs/gateway/config-plane.md sections 3.4, 4 and 5; README
 * 3.5–3.8): from the controller's rows to the ops of `gateway.config.apply`.
 * Pure: the lifecycle (S3) sends the jobs and persists the outcome.
 *
 * - One op list per job, configs in the README 3.5 order (system → network →
 *   dhcp → firewall → sqm / perch-qos → opennds → mwan3 / pbr → the rest);
 *   within a config: adopt, delete, put, order. One rollback covers a job.
 * - `put` writes the owned options from C and the router-owned options from
 *   the latest R (`controllerWins`), so a router edit to a foreign option
 *   since the last read is never clobbered.
 * - Sections on the management path (README 3.8) go into a job of their own,
 *   marked `protected`, which the lifecycle sends with the longer confirm
 *   window.
 * - Sections that only need a ledger entry (named, unchanged) form an
 *   `adopt` job, which the agent finishes without a confirm window.
 *   Renaming an anonymous section changes the file and goes through the
 *   normal apply + confirm (README 7.6).
 * - Sections with an open conflict, or not synced, are never planned
 *   (`blocked`).
 *
 * Jobs are meant to be sent one at a time: after the first finishes the
 * hashes change, so the caller re-plans for the next.
 */

export type BlockReason = 'conflict' | 'not_synced' | 'excluded_config' | 'no_drift'

export interface PlannedJob {
  kind: ApplyKind
  /** Carries the management path: its own job, longer confirm window. */
  protected: boolean
  configs: string[]
  /** Router hashes of `configs` the ops were planned against (`stale_base` otherwise). */
  base: Record<string, string>
  ops: ApplyOp[]
  ledger: LedgerChange
  perchIds: string[]
  /** `gateway_secrets` refs the apply must carry in `secrets`. */
  secretRefs: string[]
  /** What each planned section will be on the router (router side → after). */
  changes: ConfigDiffEntry[]
  /** The content each section has once confirmed (for `markConfirmed`), by perchId. */
  written: Record<string, SectionContent | null>
  /** Router contents the job replaces (kept on a revert for "Restore router version"). */
  replaced: Record<string, SectionContent | null>
}

export interface ApplyPlan {
  jobs: PlannedJob[]
  blocked: Array<{ perchId: string; config: string; section: string; reason: BlockReason }>
}

export interface PlanApplyInput {
  /** Every row of the gateway (ledger clean-up looks at all of them). */
  sections: SectionState[]
  /** Restrict to these sections; default: every synced section with work. */
  perchIds?: string[]
  /** `revert` (Authoritative enforcement) plans only drifted sections. */
  kind: 'apply' | 'revert'
  /** The router's ledger from the last read. */
  ledger: LedgerEntry[]
  /** The router's current file hashes. */
  hashes: Record<string, string>
  management: ManagementPath | null
  registry: DomainRegistry | null
  /**
   * Desired order of ordered types, by perchId (C of `gateway_section_orders`,
   * docs/gateway/firewall.md section 3). An order is planned when the request
   * covers one of its members (or has no filter), or when `force` (an
   * Authoritative revert of order drift). Created members are placed with a
   * `position` next to their neighbour in C; when the router's order still
   * differs, an `order` op lists the members, and members the ledger does
   * not hold yet are adopted in the same job. `reorder: false` (an order in
   * conflict) only places created members.
   */
  orders?: PlannedOrder[]
}

export interface PlannedOrder {
  config: string
  type: string
  perchIds: string[]
  force?: boolean
  reorder?: boolean
}

type SectionWork = {
  state: SectionState
  ops: ApplyOp[]
  ledgerSet: LedgerEntry[]
  ledgerRemove: string[]
  written: SectionContent | null
  refs: string[]
  adoptOnly: boolean
  protected: boolean
  change: ConfigDiffEntry | null
}

/** The planned jobs for the given rows (see the module comment). */
export function planApply(input: PlanApplyInput): ApplyPlan {
  const blocked: ApplyPlan['blocked'] = []
  const ledgerByPerch = new Map(input.ledger.map((e) => [e.perchId, e]))
  const wanted = input.perchIds ? new Set(input.perchIds) : null
  const works: SectionWork[] = []

  for (const state of input.sections) {
    if (wanted && !wanted.has(state.perchId)) continue
    const at = { perchId: state.perchId, config: state.config, section: state.name }
    if (EXCLUDED_CONFIGS.includes(state.config)) {
      if (wanted) blocked.push({ ...at, reason: 'excluded_config' })
      continue
    }
    if (state.scope !== 'synced') {
      if (wanted) blocked.push({ ...at, reason: 'not_synced' })
      continue
    }
    if (state.conflict) {
      blocked.push({ ...at, reason: 'conflict' })
      continue
    }
    if (input.kind === 'revert' && state.status !== 'drift') {
      if (wanted) blocked.push({ ...at, reason: 'no_drift' })
      continue
    }
    const work = planSection(state, ledgerByPerch.get(state.perchId) ?? null, input)
    if (work) works.push(work)
  }

  // Ledger entries of rows that are no longer synced (or gone) are dropped
  // with the next job that goes out.
  const synced = new Set(input.sections.filter((s) => s.scope === 'synced').map((s) => s.perchId))
  const stale = input.ledger.map((e) => e.perchId).filter((id) => !synced.has(id))

  const orderPlan = planOrders(input, works, ledgerByPerch, wanted)
  works.push(...orderPlan.adoptions)

  const groups: Array<{
    kind: ApplyKind
    protected: boolean
    works: SectionWork[]
    extra?: OrderPlan
  }> = []
  const adoptOnly = works.filter((w) => w.adoptOnly)
  const normal = works.filter((w) => !w.adoptOnly && !w.protected)
  const guarded = works.filter((w) => !w.adoptOnly && w.protected)
  const ordersToGo = orderPlan.ops.length > 0
  if (adoptOnly.length > 0) groups.push({ kind: 'adopt', protected: false, works: adoptOnly })
  if (normal.length > 0 || ordersToGo) {
    groups.push({ kind: input.kind, protected: false, works: normal, extra: orderPlan })
  }
  if (guarded.length > 0) groups.push({ kind: input.kind, protected: true, works: guarded })

  const jobs = groups.map((g, i) =>
    buildJob(g.kind, g.protected, g.works, i === 0 ? stale : [], input, g.extra)
  )
  if (jobs.length === 0 && stale.length > 0) {
    jobs.push(buildJob('adopt', false, [], stale, input))
  }
  return { jobs, blocked }
}

function planSection(
  state: SectionState,
  entry: LedgerEntry | null,
  input: PlanApplyInput
): SectionWork | null {
  const rules = input.registry?.rules(state.domain) ?? DEFAULT_RULES
  const ops: ApplyOp[] = []
  const ledgerSet: LedgerEntry[] = []
  const ledgerRemove: string[] = []
  const refs: string[] = []
  const onRouter = state.router !== null
  const ledgered = entry !== null && entry.config === state.config && entry.section === state.name
  const domain = state.domain ?? ''
  let name = state.name
  let written: SectionContent | null = state.router
  let renamed = false

  if (state.desired === null) {
    if (!onRouter) {
      // Nothing on the router: only a stale ledger entry may remain.
      if (entry) ledgerRemove.push(state.perchId)
      return ledgerRemove.length > 0 ? work(true) : null
    }
    ops.push({ op: 'delete', config: state.config, section: state.name })
    if (entry) ledgerRemove.push(state.perchId)
    written = null
  } else {
    written = controllerWins(state.router, state.desired, state.ownership)
    const changed = !contentsEqual(written, state.router, rules)
    if (onRouter && !ledgered) {
      renamed = state.anonymous
      const renameTo = renamed ? `perch_${state.perchId}` : undefined
      ops.push({
        op: 'adopt',
        config: state.config,
        section: state.name,
        perchId: state.perchId,
        ...(renameTo ? { renameTo } : {}),
      })
      if (renameTo) name = renameTo
    }
    if (changed || !onRouter) {
      const wire = wireOptions(written!)
      refs.push(...wire.refs)
      ops.push({
        op: 'put',
        config: state.config,
        section: name,
        type: written!.type,
        options: wire.options,
      })
      if (!onRouter) {
        ledgerSet.push({ perchId: state.perchId, config: state.config, section: name, domain })
      }
    }
    if (ops.length === 0) return null
  }
  return work(ops.every((op) => op.op === 'adopt') && !renamed)

  function work(adoptOnly: boolean): SectionWork {
    const protectedPath =
      !adoptOnly &&
      (touchesManagementPath(
        state.config,
        state.name,
        state.router,
        input.management,
        input.registry,
        state.domain
      ) ||
        touchesManagementPath(
          state.config,
          state.name,
          state.desired,
          input.management,
          input.registry,
          state.domain
        ))
    const where = {
      perchId: state.perchId,
      config: state.config,
      section: name,
      domain: state.domain,
    }
    const change = adoptOnly
      ? { ...where, type: state.type, action: 'adopt' as const, options: [] }
      : diffEntry(where, state.router, written, rules)
    return {
      state,
      ops,
      ledgerSet,
      ledgerRemove,
      written,
      refs,
      adoptOnly,
      protected: protectedPath,
      change:
        change && ops.some((op) => op.op === 'adopt') && change.action === 'update'
          ? { ...change, action: 'adopt' }
          : change,
    }
  }
}

const OP_RANK: Record<ApplyOp['op'], number> = { adopt: 0, delete: 1, put: 2, order: 3 }

function buildJob(
  kind: ApplyKind,
  guarded: boolean,
  works: SectionWork[],
  staleLedger: string[],
  input: PlanApplyInput,
  orders?: OrderPlan
): PlannedJob {
  const sorted = [...works].sort(
    (a, b) =>
      compareConfigs(a.state.config, b.state.config) ||
      (a.state.position ?? Number.MAX_SAFE_INTEGER) -
        (b.state.position ?? Number.MAX_SAFE_INTEGER) ||
      a.state.perchId.localeCompare(b.state.perchId)
  )
  const ops = sorted
    .flatMap((w) => w.ops)
    .map((op, i) => ({ op, i }))
    .sort(
      (a, b) =>
        compareConfigs(a.op.config, b.op.config) || OP_RANK[a.op.op] - OP_RANK[b.op.op] || a.i - b.i
    )
    .map((x) => x.op)

  // Order ops of ordered types (planOrders) go with the ordinary job.
  ops.push(...(orders?.ops ?? []))
  ops.sort((a, b) => compareConfigs(a.config, b.config) || OP_RANK[a.op] - OP_RANK[b.op])

  const configs = [...new Set(ops.map((op) => op.config))].sort(compareConfigs)
  const base: Record<string, string> = {}
  for (const config of configs) {
    if (input.hashes[config] !== undefined) base[config] = input.hashes[config]
  }
  return {
    kind,
    protected: guarded,
    configs,
    base,
    ops,
    ledger: {
      set: sorted.flatMap((w) => w.ledgerSet),
      remove: [...new Set([...sorted.flatMap((w) => w.ledgerRemove), ...staleLedger])],
    },
    perchIds: sorted.map((w) => w.state.perchId),
    secretRefs: [...new Set(sorted.flatMap((w) => w.refs))],
    changes: [
      ...sorted.map((w) => w.change).filter((c): c is ConfigDiffEntry => c !== null),
      ...(orders?.changes ?? []),
    ],
    written: Object.fromEntries(sorted.map((w) => [w.state.perchId, w.written])),
    replaced: Object.fromEntries(sorted.map((w) => [w.state.perchId, w.state.router])),
  }
}

interface OrderPlan {
  ops: ApplyOp[]
  changes: ConfigDiffEntry[]
  /** Members the ledger does not hold yet, adopted for the order op. */
  adoptions: SectionWork[]
}

function byRouterPosition(a: SectionState, b: SectionState): number {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER
  const pb = b.position ?? Number.MAX_SAFE_INTEGER
  return pa - pb || a.perchId.localeCompare(b.perchId)
}

/**
 * The order half of a plan (docs/gateway/firewall.md section 3): places
 * created members next to their neighbour in C (a `position` on their put),
 * and when the router's order after the job would still differ from C, an
 * `order` op over the members (the agent permutes them inside the slots
 * they occupy together). Members not in the ledger are adopted in the same
 * job: the agent orders owned sections only.
 */
function planOrders(
  input: PlanApplyInput,
  works: SectionWork[],
  ledgerByPerch: Map<string, LedgerEntry>,
  wanted: Set<string> | null
): OrderPlan {
  const plan: OrderPlan = { ops: [], changes: [], adoptions: [] }
  if (!input.orders || input.orders.length === 0) return plan
  const workOf = new Map(works.map((w) => [w.state.perchId, w]))
  const rowOf = new Map(input.sections.map((s) => [s.perchId, s]))
  const nameOf = (id: string) => {
    const w = workOf.get(id)
    return w ? nameAfter(w) : rowOf.get(id)!.name
  }
  for (const order of input.orders) {
    const members = order.perchIds.filter((id) => {
      const r = rowOf.get(id)
      return (
        r !== undefined &&
        r.scope === 'synced' &&
        r.config === order.config &&
        r.desired !== null &&
        r.desired.type === order.type &&
        !r.conflict
      )
    })
    const inScope =
      order.force === true ||
      wanted === null ||
      members.some((id) => wanted.has(id) || workOf.has(id))
    if (!inScope || members.length === 0) continue
    const deleted = (id: string) => workOf.get(id)?.ops.some((op) => op.op === 'delete') ?? false
    const created = (id: string) => {
      const w = workOf.get(id)
      return (
        rowOf.get(id)!.router === null &&
        w !== undefined &&
        !w.protected &&
        w.ops.some((op) => op.op === 'put')
      )
    }
    const routerNow = input.sections
      .filter(
        (s) =>
          s.scope === 'synced' &&
          s.config === order.config &&
          s.router !== null &&
          s.router.type === order.type
      )
      .sort(byRouterPosition)
      .map((s) => s.perchId)
    const after = routerNow.filter((id) => members.includes(id) && !deleted(id))
    const before = after.map(nameOf)
    for (let i = 0; i < members.length; i++) {
      const id = members[i]
      if (!created(id)) continue
      let position: OpPosition | undefined
      let at = -1
      for (let j = i - 1; j >= 0 && !position; j--) {
        const k = after.indexOf(members[j])
        if (k !== -1) {
          position = { after: nameOf(members[j]) }
          at = k + 1
        }
      }
      for (let j = i + 1; j < members.length && !position; j++) {
        const k = after.indexOf(members[j])
        if (k !== -1) {
          position = { before: nameOf(members[j]) }
          at = k
        }
      }
      const put = workOf.get(id)!.ops.find((op) => op.op === 'put')
      if (position && put && put.op === 'put') {
        put.position = position
        after.splice(at, 0, id)
      } else {
        after.push(id)
      }
    }
    const target = members.filter((id) => after.includes(id))
    if (order.reorder === false || sameList(after, target)) continue

    for (const id of target) {
      const w = workOf.get(id)
      if (w) {
        if (w.adoptOnly) w.adoptOnly = false
        continue
      }
      const r = rowOf.get(id)!
      const entry = ledgerByPerch.get(id)
      if (entry && entry.config === r.config && entry.section === r.name) continue
      const renameTo = r.anonymous ? `perch_${id}` : undefined
      const adoption: SectionWork = {
        state: r,
        ops: [
          {
            op: 'adopt',
            config: r.config,
            section: r.name,
            perchId: id,
            ...(renameTo ? { renameTo } : {}),
          },
        ],
        ledgerSet: [],
        ledgerRemove: [],
        written: r.router,
        refs: [],
        adoptOnly: false,
        protected: false,
        change: {
          perchId: id,
          config: r.config,
          section: renameTo ?? r.name,
          type: r.type,
          domain: r.domain,
          action: 'adopt',
          options: [],
        },
      }
      plan.adoptions.push(adoption)
      workOf.set(id, adoption)
    }
    const names = target.map(nameOf)
    plan.ops.push({ op: 'order', config: order.config, type: order.type, sections: names })
    plan.changes.push({
      perchId: null,
      config: order.config,
      section: '',
      type: order.type,
      domain: rowOf.get(target[0])?.domain ?? null,
      action: 'order',
      options: [{ name: '.order', before, after: names }],
    })
  }
  return plan
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function nameAfter(w: SectionWork): string {
  const adopt = w.ops.find((op) => op.op === 'adopt')
  return adopt && adopt.op === 'adopt' && adopt.renameTo ? adopt.renameTo : w.state.name
}

/**
 * Does a section carry the management path (README 3.8)? Built-in rules
 * for the native configs, plus the domain's own `touchesManagement`:
 *
 * - `network`: the path's `interface`; an interface on the path's device;
 *   the `device` section that is the path's device or its parent (br-lan
 *   for br-lan.1); a `bridge-vlan` on that bridge.
 * - `firewall`: the zone listing the path's network, and `defaults`.
 *
 * DHCP pools are not on the path: a bad pool bites at lease renewal, long
 * after any confirm window (plan 2 section 4.1).
 */
export function touchesManagementPath(
  config: string,
  name: string,
  content: SectionContent | null,
  path: ManagementPath | null,
  registry?: DomainRegistry | null,
  domainKey?: string | null
): boolean {
  if (!path || !content) return false
  const o = content.options
  const scalar = (key: string) => (typeof o[key] === 'string' ? (o[key] as string) : null)
  const onDevice = (device: string | null) =>
    device !== null && (path.device === device || path.device.startsWith(`${device}.`))

  if (config === 'network') {
    if (content.type === 'interface') {
      if (path.network !== null && name === path.network) return true
      if (scalar('device') === path.device || scalar('ifname') === path.device) return true
    }
    if (content.type === 'device' && onDevice(scalar('name'))) return true
    if (content.type === 'bridge-vlan') {
      const device = scalar('device')
      const vlan = scalar('vlan')
      if (device !== null && (path.device === device || path.device === `${device}.${vlan}`)) {
        return true
      }
    }
  }
  if (config === 'firewall') {
    if (content.type === 'defaults') return true
    if (content.type === 'zone' && path.network !== null) {
      if (
        itemsOf(o.network)
          .flatMap((v) => v.split(/\s+/))
          .includes(path.network)
      )
        return true
    }
  }
  const domain = registry?.get(domainKey ?? null)
  return domain?.touchesManagement?.({ type: content.type, name, options: o }, path) ?? false
}

/**
 * Three-way merge of a section order (ordered types, section 5.1 "rule
 * order changed on both sides → conflict at config level"): the router's
 * order when only it moved, the controller's when only it moved, either when
 * they agree, else a conflict. Members are compared as sets first: a
 * section added or removed on one side is carried over.
 */
export function mergeOrder(
  base: string[],
  router: string[],
  desired: string[]
): { kind: 'ok'; order: string[] } | { kind: 'conflict' } {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  // Final members: the router's, plus sections only the controller added,
  // minus sections only the controller removed.
  const members = [...new Set([...router, ...desired])].filter((x) => {
    if (base.includes(x) && !desired.includes(x)) return false
    return router.includes(x) || !base.includes(x)
  })
  const project = (list: string[]) => list.filter((x) => members.includes(x))
  const b = project(base)
  const r = project(router)
  const c = project(desired)
  // Whether a side reordered the members it shares with the base.
  const moved = (side: string[]) =>
    !same(
      side.filter((x) => b.includes(x)),
      b.filter((x) => side.includes(x))
    )
  const fill = (order: string[]) => [...order, ...members.filter((x) => !order.includes(x))]
  if (!moved(r)) return { kind: 'ok', order: fill(c) }
  if (!moved(c)) return { kind: 'ok', order: fill(r) }
  // Both reordered: fine only when the shared members keep one relative order.
  const shared = r.filter((x) => c.includes(x))
  if (
    !same(
      shared,
      c.filter((x) => r.includes(x))
    )
  )
    return { kind: 'conflict' }
  return { kind: 'ok', order: fill(r) }
}

// ── editSections: domain edits into C ────────────────────────────────────

export interface EditSectionsInput {
  rows: SectionState[]
  edits: SectionEdit[]
  /** The domain making the edits (new rows belong to it). */
  domain: string
  registry: DomainRegistry | null
  authoritative: boolean
  newPerchId: () => string
}

export interface EditSectionsResult {
  /** Rows whose C changed, and new rows (base and router null). */
  upserts: SectionState[]
  /** Rows to drop: controller-only sections deleted before they reached the router. */
  deleted: string[]
  /** Order requests, for `planApply({ orders })`. */
  orders: Array<{ config: string; type: string; perchIds: string[] }>
}

export class EditRefusedError extends SectionEditError {
  constructor(
    readonly code: 'not_synced' | 'unknown_section' | 'wrong_domain' | 'excluded_config',
    message: string
  ) {
    super(message)
  }
}

/**
 * The pure core of `gatewayConfig.editSections(gatewayId, userId, edits)`,
 * the single write entry point for domain REST handlers (section 7): turns
 * a domain's edits into new desired contents (C). Only synced sections of
 * the editing domain can be edited; excluded and unmodeled ones are the
 * router's. The caller persists `upserts`/`deleted` and validates the
 * result (`validateDesired`) before offering an apply.
 */
export function planSectionEdits(input: EditSectionsInput): EditSectionsResult {
  const synced = input.rows.filter((r) => r.scope === 'synced' && r.domain === input.domain)
  for (const edit of input.edits) {
    if (edit.op === 'order') continue
    if (edit.op === 'put' && EXCLUDED_CONFIGS.includes(edit.config)) {
      throw new EditRefusedError('excluded_config', `${edit.config} is never managed`)
    }
    if (edit.perchId === null) continue
    const row = input.rows.find((r) => r.perchId === edit.perchId)
    if (!row) throw new EditRefusedError('unknown_section', `no section ${edit.perchId}`)
    if (row.scope !== 'synced') {
      throw new EditRefusedError('not_synced', `section ${edit.perchId} is ${row.scope}`)
    }
    if (row.domain !== input.domain) {
      throw new EditRefusedError('wrong_domain', `section ${edit.perchId} belongs to ${row.domain}`)
    }
  }

  const current: SyncedSection[] = synced
    .filter((r) => r.desired !== null)
    .map((r) => ({
      perchId: r.perchId,
      config: r.config,
      name: r.name,
      type: r.desired!.type,
      anonymous: r.anonymous,
      options: { ...r.desired!.options },
      ...(r.desired!.secrets ? { secrets: { ...r.desired!.secrets } } : {}),
    }))
  const created: string[] = []
  const after = applySectionEdits(current, input.edits, () => {
    const id = input.newPerchId()
    created.push(id)
    return id
  })

  const domain = input.registry?.get(input.domain) ?? null
  const rules = input.registry?.rules(input.domain) ?? DEFAULT_RULES
  const upserts: SectionState[] = []
  const deleted: string[] = []
  for (const row of synced) {
    const next = after.find((s) => s.perchId === row.perchId)
    const desired = next ? contentOf(next) : null
    if (contentsEqual(desired, row.desired, rules) && sameSecretRefs(desired, row.desired)) continue
    if (!desired && row.base === null && row.router === null) {
      deleted.push(row.perchId)
      continue
    }
    upserts.push(
      applyControllerEdit(row, desired, {
        authoritative: input.authoritative,
        rules,
        ownership: ownershipFor(row.ownership, row.desired, desired),
      })
    )
  }
  for (const id of created) {
    const section = after.find((s) => s.perchId === id)
    if (!section) continue
    const desired = contentOf(section)
    const claimed = domain?.ownership?.({
      name: section.name,
      type: section.type,
      anonymous: false,
      index: 0,
      options: section.options,
      config: section.config,
    })
    const ownership = claimed && claimed.kind === 'options' ? claimed : null
    upserts.push({
      perchId: id,
      config: section.config,
      name: section.name,
      type: section.type,
      anonymous: false,
      scope: 'synced',
      domain: input.domain,
      ownership,
      issue: null,
      base: null,
      baseRevision: null,
      router: null,
      desired,
      status: 'ahead',
      conflict: null,
      driftSince: null,
      position: null,
    })
  }
  const orders = input.edits
    .filter((e): e is Extract<SectionEdit, { op: 'order' }> => e.op === 'order')
    .map((e) => ({ config: e.config, type: e.type, perchIds: [...e.perchIds] }))
  return { upserts, deleted, orders }
}

function sameSecretRefs(a: SectionContent | null, b: SectionContent | null): boolean {
  const refs = (c: SectionContent | null) =>
    JSON.stringify(
      Object.entries(c?.secrets ?? {})
        .map(([k, v]) => [k, v.ref ?? null])
        .sort()
    )
  return refs(a) === refs(b)
}

/**
 * Item-owned list options after a controller edit: the owned items are the
 * ones C now has that the router's foreign items do not explain, i.e. the
 * previous owned items still in C plus every item C gained.
 */
function ownershipFor(
  ownership: SectionState['ownership'],
  previous: SectionContent | null,
  desired: SectionContent | null
): SectionState['ownership'] {
  if (!ownership || ownership.kind === 'section' || !ownership.items) return ownership
  const items: Record<string, string[]> = {}
  for (const [name, owned] of Object.entries(ownership.items)) {
    const before = itemsOf(previous?.options[name])
    items[name] = itemsOf(desired?.options[name]).filter(
      (item) => owned.includes(item) || !before.includes(item)
    )
  }
  return { ...ownership, items }
}
