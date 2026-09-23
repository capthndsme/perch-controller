import type { DomainRegistry } from '#services/gateway_config/domain'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { ApplyOp, GatewayMode, OpPosition } from '#services/gateway_config/types'

/**
 * The order of ordered section types (docs/gateway/firewall.md section 3;
 * config-plane.md section 5.1): firewall rules and redirects are evaluated
 * top to bottom, so their order is state the controller syncs.
 *
 * Per (config, type) the controller keeps B (`base`, the order both sides
 * last agreed on) and C (`desired`) as perch ids of the synced sections of
 * that type; R is the router's, read from the rows' `position`. Only
 * **synced** sections take part: excluded and unmodeled ones keep their
 * slots (the agent's `order` op permutes the listed sections inside the
 * slots they occupy together).
 *
 * - R = C (for the sections on the router): in sync, B := R.
 * - Only the controller moved: `ahead`; the next apply of the order carries
 *   an `order` op.
 * - Only the router moved (two-way): imported, C := R.
 * - Both moved differently (two-way): `conflict` until the admin takes a side.
 * - Authoritative Mode: a router reorder is `drift`, reverted after the
 *   grace delay like a section.
 *
 * "Moved" compares the relative order of the members a side shares with B,
 * so sections that appear or disappear never count as a reorder. Pure: the
 * store (`order_store.ts`) loads and saves.
 */

export type OrderStatus = 'in_sync' | 'ahead' | 'conflict' | 'drift'

export interface OrderKey {
  config: string
  type: string
}

export interface OrderState extends OrderKey {
  base: string[]
  desired: string[]
  status: OrderStatus
  conflict: { router: string[]; detectedAt: string } | null
  driftSince: string | null
}

export type OrderEvent = {
  event: 'order_imported' | 'order_conflict' | 'order_drift' | 'order_drift_cleared'
  config: string
  type: string
  detail: Record<string, unknown>
}

/** Every ordered (config, type) of the registry's domains. */
export function orderKeys(registry: DomainRegistry): OrderKey[] {
  const out: OrderKey[] = []
  for (const domain of registry.list()) {
    for (const type of domain.orderedTypes ?? []) {
      for (const config of domain.configs) {
        if (!out.some((k) => k.config === config && k.type === type)) out.push({ config, type })
      }
    }
  }
  return out
}

function byPosition(a: SectionState, b: SectionState): number {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER
  const pb = b.position ?? Number.MAX_SAFE_INTEGER
  return pa - pb || a.perchId.localeCompare(b.perchId)
}

/** R: synced sections of the key on the router, in file order. */
export function routerOrder(states: SectionState[], key: OrderKey): string[] {
  return states
    .filter(
      (s) =>
        s.scope === 'synced' &&
        s.config === key.config &&
        s.router !== null &&
        s.router.type === key.type
    )
    .sort(byPosition)
    .map((s) => s.perchId)
}

/** The members of C: synced sections of the key the controller wants to exist. */
export function orderMembers(states: SectionState[], key: OrderKey): string[] {
  return states
    .filter(
      (s) =>
        s.scope === 'synced' &&
        s.config === key.config &&
        s.desired !== null &&
        s.desired.type === key.type
    )
    .sort(byPosition)
    .map((s) => s.perchId)
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Whether `side` reordered the members it shares with `base`. */
export function reordered(side: string[], base: string[]): boolean {
  const shared = new Set(side.filter((x) => base.includes(x)))
  return !sameOrder(
    side.filter((x) => shared.has(x)),
    base.filter((x) => shared.has(x))
  )
}

/**
 * C brought up to date with the members: dropped sections leave, sections
 * the router has that C lacks go right after their predecessor in R (or
 * first), controller-only ones not in C go last.
 */
export function integrateMembers(desired: string[], members: string[], router: string[]): string[] {
  const memberSet = new Set(members)
  const out = desired.filter((id, i) => memberSet.has(id) && desired.indexOf(id) === i)
  for (let i = 0; i < router.length; i++) {
    const id = router[i]
    if (!memberSet.has(id) || out.includes(id)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(router[j])
      if (k !== -1) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
  }
  for (const id of members) if (!out.includes(id)) out.push(id)
  return out
}

/**
 * The router's order with the controller-only members of `desired` kept
 * after their predecessor in `desired` (an import must not drop a section
 * the controller is about to create).
 */
function routerWithExtras(router: string[], desired: string[]): string[] {
  const out = [...router]
  for (let i = 0; i < desired.length; i++) {
    const id = desired[i]
    if (out.includes(id)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(desired[j])
      if (k !== -1) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
  }
  return out
}

export interface ReconcileOrderInput {
  prev: OrderState | null
  states: SectionState[]
  key: OrderKey
  mode: GatewayMode
  authoritative: boolean
  now: string
}

/**
 * One order after the rows changed (a read, an edit, a confirm). Returns
 * null when there is nothing to keep (no members, no row), else the next
 * state and the event to log, if any.
 */
export function reconcileOrder(
  input: ReconcileOrderInput
): { next: OrderState; event: OrderEvent | null } | null {
  const { key, prev } = input
  const router = routerOrder(input.states, key)
  const members = orderMembers(input.states, key)
  if (!prev && members.length === 0 && router.length === 0) return null
  const onRouter = new Set(router)
  const desired = integrateMembers(prev?.desired ?? router, members, router)
  const desiredOnRouter = desired.filter((id) => onRouter.has(id))
  const routerMembers = router.filter((id) => members.includes(id))
  const base = prev?.base ?? router
  const at = { config: key.config, type: key.type }
  const inSync = (d: string[]): OrderState => ({
    ...at,
    base: router,
    desired: d,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
  })

  if (!prev || input.mode !== 'managed') {
    const next = inSync(routerWithExtras(router, desired).filter((id) => members.includes(id)))
    const imported = prev !== null && !sameOrder(prev.desired, next.desired)
    return {
      next,
      event: imported ? { event: 'order_imported', ...at, detail: { order: next.desired } } : null,
    }
  }

  if (sameOrder(routerMembers, desiredOnRouter)) {
    const next = inSync(desired)
    const cleared = prev.status === 'drift' || prev.status === 'conflict'
    return {
      next,
      event: cleared
        ? { event: 'order_drift_cleared', ...at, detail: { status: prev.status } }
        : null,
    }
  }

  const routerMoved = reordered(router, base)
  if (!routerMoved) {
    // Only the controller wants another order: B follows the router's
    // membership, the order op goes with the next apply.
    return {
      next: { ...at, base: router, desired, status: 'ahead', conflict: null, driftSince: null },
      event: null,
    }
  }
  if (input.authoritative) {
    const next: OrderState = {
      ...at,
      base,
      desired,
      status: 'drift',
      conflict: null,
      driftSince: prev.driftSince ?? input.now,
    }
    return {
      next,
      event: prev.driftSince
        ? null
        : { event: 'order_drift', ...at, detail: { router: routerMembers, desired } },
    }
  }
  const controllerMoved = reordered(desiredOnRouter, base) || prev.status === 'ahead'
  if (!controllerMoved) {
    const next = inSync(routerWithExtras(routerMembers, desired))
    return { next, event: { event: 'order_imported', ...at, detail: { order: next.desired } } }
  }
  const detectedAt = prev.conflict?.detectedAt ?? input.now
  const next: OrderState = {
    ...at,
    base,
    desired,
    status: 'conflict',
    conflict: { router: routerMembers, detectedAt },
    driftSince: null,
  }
  return {
    next,
    event: prev.conflict
      ? null
      : { event: 'order_conflict', ...at, detail: { router: routerMembers, desired } },
  }
}

/**
 * The admin settles an order conflict or drift: `router` takes the router's
 * order (C := R), `controller` keeps C (the next apply writes it).
 */
export function resolveOrder(
  state: OrderState,
  states: SectionState[],
  take: 'router' | 'controller'
): OrderState {
  const router = routerOrder(states, state)
  const members = orderMembers(states, state)
  const desired = integrateMembers(state.desired, members, router)
  if (take === 'router') {
    return {
      ...state,
      base: router,
      desired: routerWithExtras(
        router.filter((id) => members.includes(id)),
        desired
      ),
      status: 'in_sync',
      conflict: null,
      driftSince: null,
    }
  }
  const onRouter = new Set(router)
  const same = sameOrder(
    router.filter((id) => members.includes(id)),
    desired.filter((id) => onRouter.has(id))
  )
  return {
    ...state,
    base: router,
    desired,
    status: same ? 'in_sync' : 'ahead',
    conflict: null,
    driftSince: null,
  }
}

/** A controller reorder (`PUT …/rules/order`): C := `order`, members only. */
export function setDesiredOrder(
  state: OrderState | null,
  key: OrderKey,
  states: SectionState[],
  order: string[]
): OrderState {
  const router = routerOrder(states, key)
  const members = orderMembers(states, key)
  const desired = integrateMembers(order, members, router)
  const onRouter = new Set(router)
  const same = sameOrder(
    router.filter((id) => members.includes(id)),
    desired.filter((id) => onRouter.has(id))
  )
  return {
    ...key,
    base: state?.base ?? router,
    desired,
    status: same ? 'in_sync' : state?.status === 'drift' ? 'drift' : 'ahead',
    conflict: null,
    driftSince: state?.status === 'drift' ? state.driftSince : null,
  }
}

/** Orders whose Authoritative revert is due (the section grace delay applies). */
export function ordersDueForRevert(
  orders: OrderState[],
  options: { now: string; delaySeconds: number }
): OrderState[] {
  const now = Date.parse(options.now)
  return orders.filter(
    (o) =>
      o.status === 'drift' &&
      o.driftSince !== null &&
      Date.parse(o.driftSince) + options.delaySeconds * 1000 <= now
  )
}

// ── positions after a job (the agent's semantics, section 4 "Writes") ────

/**
 * The file order of the touched configs after the router ran `ops`, as row
 * positions: adopt renames, delete removes, put appends a new section (or
 * moves it next to `position`), order puts the listed sections into the
 * slots they occupy together. Used when a job is confirmed, so the rows'
 * positions follow the router until the next read.
 *
 * `rows` are every row of the gateway (their `position` is the router's
 * index, null when the section is not on the router); `created` maps the
 * names of sections the job creates to their perch ids.
 */
export function positionsAfterOps(
  rows: Array<{
    perchId: string
    config: string
    name: string
    position: number | null
    onRouter: boolean
  }>,
  ops: ApplyOp[],
  created: Map<string, string>
): Map<string, number> {
  const out = new Map<string, number>()
  const configs = [...new Set(ops.map((op) => op.config))]
  for (const config of configs) {
    const file = rows
      .filter((r) => r.config === config && r.onRouter)
      .sort(
        (a, b) =>
          (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
          a.perchId.localeCompare(b.perchId)
      )
      .map((r) => ({ id: r.perchId, name: r.name }))
    const find = (name: string) => file.findIndex((e) => e.name === name)
    const place = (index: number, position: OpPosition | undefined) => {
      if (!position) return
      const ref = position.after ?? position.before
      if (!ref) return
      const [entry] = file.splice(index, 1)
      const at = find(ref)
      if (at === -1) {
        file.splice(index, 0, entry)
        return
      }
      file.splice(position.after ? at + 1 : at, 0, entry)
    }
    for (const op of ops) {
      if (op.config !== config) continue
      if (op.op === 'adopt') {
        const i = find(op.section)
        if (i !== -1 && op.renameTo) file[i] = { ...file[i], name: op.renameTo }
      } else if (op.op === 'delete') {
        const i = find(op.section)
        if (i !== -1) file.splice(i, 1)
      } else if (op.op === 'put') {
        let i = find(op.section)
        if (i === -1) {
          const id = created.get(op.section)
          if (!id) continue
          file.push({ id, name: op.section })
          i = file.length - 1
        }
        place(i, op.position)
      } else if (op.op === 'order') {
        const slots = op.sections.map(find).filter((i) => i !== -1)
        const entries = op.sections
          .map((name) => file[find(name)])
          .filter((e): e is { id: string; name: string } => e !== undefined)
        slots.sort((a, b) => a - b)
        slots.forEach((slot, k) => {
          file[slot] = entries[k]
        })
      }
    }
    file.forEach((e, index) => out.set(e.id, index))
  }
  return out
}
