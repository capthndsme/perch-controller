import type {
  CheckItemResult,
  GatewayApplyCheckItem,
  GatewayApplyCheckResults,
  GatewayApplyChecks,
} from '#models/gateway_apply'
import type { ChecksPlan } from '#services/gateway_config/domain'
import type { GatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import type { GatewaySyncSettings } from '#services/gateway_config/gateway_sync_settings'

/**
 * Apply checks on the controller side (docs/design/gateway-sync/domains.md
 * 1.5, protocol.md 1): the wire form of a job's checks, the agent's reports
 * (the apply reply's baseline, `gateway.config.checks`, the hello's
 * `apply.checks`, a `checks_failed` result) merged into the apply row, and
 * the `GatewayApply.checks` view. Pure.
 */

/** Set states (the router's), plus `overridden` (the admin's "Keep anyway"). */
export const CHECKS_STATES = ['pending', 'running', 'passed', 'failed', 'overridden'] as const
export type ChecksState = (typeof CHECKS_STATES)[number]
export const CHECK_ITEM_STATES = ['pending', 'running', 'passed', 'failed', 'skipped'] as const

/** States that let the confirm go out. */
export function checksAllowConfirm(state: string | null): boolean {
  return state === null || state === 'passed' || state === 'overridden'
}

/** The router's floor and ceiling of a checks budget (protocol.md 1.1). */
export const CHECKS_MIN_SECONDS = 10
export const CHECKS_MAX_SECONDS = 900
/** The budget ends this long before the confirm deadline (protocol.md 1.1). */
export const CHECKS_MARGIN_SECONDS = 20

/**
 * The confirm window of a checked job (domains.md 1.5): the WAN window, or
 * the management window when it is also protected, whichever is longer;
 * capped by the router's `config_confirm_max`.
 */
export function checkedConfirmWindow(
  settings: GatewayConfigSettings,
  gatewaySync: GatewaySyncSettings,
  options: { protected: boolean; routerMaxSeconds?: number | null }
): number {
  const wanted = Math.max(
    gatewaySync.wanConfirmTimeoutSeconds,
    options.protected ? settings.managementConfirmTimeoutSeconds : 0
  )
  const cap = options.routerMaxSeconds
  return typeof cap === 'number' && cap > 0 ? Math.min(wanted, cap) : wanted
}

/**
 * The `checks` param of a job: the plan's items, the budget clamped to the
 * window minus the margin (10–900 s). `items: []` stays empty: the request
 * said "no checks" (protocol.md 1.6), so the agent adds no net of its own.
 */
export function wireChecks(
  plan: ChecksPlan | null,
  windowSeconds: number
): GatewayApplyChecks | null {
  if (!plan) return null
  if (plan.items.length === 0) return { v: 1, timeoutSeconds: 0, items: [] }
  const ceiling = Math.max(
    CHECKS_MIN_SECONDS,
    Math.min(CHECKS_MAX_SECONDS, windowSeconds - CHECKS_MARGIN_SECONDS)
  )
  const timeout = Math.min(ceiling, Math.max(CHECKS_MIN_SECONDS, Math.round(plan.timeoutSeconds)))
  return {
    v: 1,
    timeoutSeconds: timeout,
    items: plan.items.map((i) => ({ ...i })),
  }
}

/** The wire object (`{v, timeoutSeconds?, items}`); null = send nothing. */
export function checksParam(checks: GatewayApplyChecks | null): Record<string, unknown> | null {
  if (!checks || checks.agentAdded) return null
  if (checks.items.length === 0) return { v: 1, items: [] }
  return { v: 1, timeoutSeconds: checks.timeoutSeconds, items: checks.items }
}

// ── the agent's reports ──────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function itemResults(value: unknown): CheckItemResult[] {
  if (!Array.isArray(value)) return []
  const out: CheckItemResult[] = []
  for (const entry of value.slice(0, 32)) {
    if (!isObject(entry) || typeof entry.id !== 'string') continue
    const state = (CHECK_ITEM_STATES as readonly unknown[]).includes(entry.state)
      ? String(entry.state)
      : 'pending'
    out.push({
      id: entry.id.slice(0, 32),
      state,
      detail: text(entry.detail, 200),
      at: text(entry.at, 40),
    })
  }
  return out
}

/** One report of the agent on an apply's checks, as far as it parses. */
export type ChecksReport = {
  state: string | null
  startedAt: string | null
  timeoutSeconds: number | null
  allSkipped: boolean | null
  items: CheckItemResult[] | null
  baseline: CheckItemResult[] | null
  agentAdded: boolean
}

/**
 * Parses any of the agent's checks objects: the apply reply's
 * `{state, timeoutSeconds, agentAdded?, baseline}`, the notification's
 * `{applyId, state, startedAt, elapsedSeconds, allSkipped?, items}`, the
 * hello's `apply.checks` and a result's `checks`. Null when it is not one.
 */
export function parseChecksReport(value: unknown): ChecksReport | null {
  if (!isObject(value)) return null
  const state = (CHECKS_STATES as readonly unknown[]).includes(value.state)
    ? String(value.state)
    : null
  const items = Array.isArray(value.items) ? itemResults(value.items) : null
  const baseline = Array.isArray(value.baseline) ? itemResults(value.baseline) : null
  if (state === null && items === null && baseline === null) return null
  return {
    state,
    startedAt: text(value.startedAt, 40),
    timeoutSeconds:
      typeof value.timeoutSeconds === 'number' && Number.isFinite(value.timeoutSeconds)
        ? Math.round(value.timeoutSeconds)
        : null,
    allSkipped: typeof value.allSkipped === 'boolean' ? value.allSkipped : null,
    items,
    baseline,
    agentAdded: value.agentAdded === true,
  }
}

/**
 * The apply's results after a report: items merged by id (a report names
 * every item it knows; the reply's baseline makes the first ones, a skipped
 * baseline item stays skipped), the set's state the report's.
 */
export function mergeChecksReport(
  current: GatewayApplyCheckResults | null,
  report: ChecksReport,
  sent: GatewayApplyCheckItem[]
): GatewayApplyCheckResults {
  const byId = new Map<string, CheckItemResult>()
  for (const item of current?.items ?? []) byId.set(item.id, item)
  if (report.baseline && !report.items) {
    // The reply: a baseline that failed is skipped (unless mustPass), the
    // rest waits for the commit to settle.
    for (const b of report.baseline) {
      byId.set(
        b.id,
        b.state === 'skipped'
          ? { id: b.id, state: 'skipped', detail: b.detail, at: b.at }
          : { id: b.id, state: 'pending', detail: null, at: null }
      )
    }
  }
  for (const item of report.items ?? []) byId.set(item.id, item)
  const order = [
    ...sent.map((i) => i.id),
    ...[...byId.keys()].filter((id) => !sent.some((i) => i.id === id)),
  ]
  return {
    state: report.state ?? current?.state ?? 'pending',
    startedAt: report.startedAt ?? current?.startedAt ?? null,
    timeoutSeconds: report.timeoutSeconds ?? current?.timeoutSeconds ?? null,
    allSkipped: report.allSkipped ?? current?.allSkipped ?? false,
    items: order.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
    ...(report.baseline
      ? { baseline: report.baseline }
      : current?.baseline
        ? { baseline: current.baseline }
        : {}),
  }
}

/**
 * The next `checks_state` after a report. An override the admin gave holds
 * (the agent stops its checks then); a finished state never goes back to a
 * running one (a late notification).
 */
export function nextChecksState(current: string | null, reported: string | null): string | null {
  if (reported === null) return current
  if (current === 'overridden') return current
  if (
    (current === 'passed' || current === 'failed') &&
    (reported === 'pending' || reported === 'running')
  ) {
    return current
  }
  return reported
}

/** The items that failed, for `outcome.checks` of a `checks_failed` rollback. */
export function failedCheckItems(
  checks: GatewayApplyChecks | null,
  results: GatewayApplyCheckResults | null
) {
  return checkItemsView(checks, results).filter((i) => i.state === 'failed')
}

// ── the view (rest.md 2) ─────────────────────────────────────────────────

export type CheckItemView = {
  id: string
  kind: string
  network: string | null
  family: 4 | 6 | null
  targets: string[] | null
  name: string | null
  mustPass: boolean
  state: string
  detail: string | null
  at: string | null
}

export function checkItemsView(
  checks: GatewayApplyChecks | null,
  results: GatewayApplyCheckResults | null
): CheckItemView[] {
  const reported = new Map((results?.items ?? []).map((i) => [i.id, i]))
  return (checks?.items ?? []).map((item) => {
    const r = reported.get(item.id)
    return {
      id: item.id,
      kind: item.kind,
      network: item.network ?? null,
      family: item.family ?? null,
      targets: item.targets ?? null,
      name: item.name ?? null,
      mustPass: item.mustPass === true,
      state: r?.state ?? 'pending',
      detail: r?.detail ?? null,
      at: r?.at ?? null,
    }
  })
}

/**
 * `GatewayApply.checks` (rest.md 2): null without checks (none were sent,
 * or the admin confirmed an edit "without checks").
 */
export function checksView(
  apply: {
    checks: GatewayApplyChecks | null
    checkResults: GatewayApplyCheckResults | null
    checksState: string | null
    checksOverriddenAt: { toISO(): string | null } | null
  },
  overriddenBy: { id: number; email: string } | null
) {
  const checks = apply.checks
  if (!checks || checks.items.length === 0) return null
  const results = apply.checkResults
  return {
    state: apply.checksState ?? 'pending',
    timeoutSeconds: results?.timeoutSeconds ?? checks.timeoutSeconds,
    startedAt: results?.startedAt ?? null,
    allSkipped: results?.allSkipped ?? false,
    agentAdded: checks.agentAdded === true,
    items: checkItemsView(checks, results),
    overriddenBy,
    overriddenAt: apply.checksOverriddenAt?.toISO() ?? null,
  }
}

/** The items a draft job would send (their state `pending`). */
export function plannedCheckItems(plan: ChecksPlan | null): CheckItemView[] | null {
  if (!plan) return null
  return plan.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    network: item.network ?? null,
    family: item.family ?? null,
    targets: item.targets ?? null,
    name: item.name ?? null,
    mustPass: item.mustPass === true,
    state: 'pending',
    detail: null,
    at: null,
  }))
}
