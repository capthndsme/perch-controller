import { ApiError, apiErrorCode } from '@/lib/api'
import { APPLY_STATE_META, OUTCOME_REASON } from '@/lib/gateway-config'
import type { GatewayApply } from '@/types/gateway-config'
import type {
  QosApplyError,
  DeviceShaping,
  QosApplyState,
  QosDay,
  QosOverview,
  QosPlanIssue,
  QosPolicy,
  QosQuota,
  QosRate,
  QosRateOverride,
  QosSchedule,
  QosShapingState,
} from '@/types/api'

/**
 * Pure helpers of the traffic-shaping screens (metrics-be/docs/gateway/qos.md).
 * The API speaks kbit/s; people read and type Mbit/s (1 Mbit/s = 1000 kbit/s).
 */

// ---------------------------------------------------------------------------
// Rates

/** `50 Mbit/s`, `512 kbit/s`; `null` (the API's "unlimited that way") reads Unlimited. */
export function formatKbit(kbit: number | null | undefined, unlimited = 'Unlimited'): string {
  if (kbit === null || kbit === undefined) return unlimited
  if (kbit === 0) return '0'
  if (Math.abs(kbit) < 1000) return `${Math.round(kbit)} kbit/s`
  const mbit = kbit / 1000
  const digits = mbit >= 100 ? 0 : mbit >= 10 ? 1 : 2
  return `${Number(mbit.toFixed(digits))} Mbit/s`
}

/** A number of Mbit/s without the unit (axis ticks, compact cells). */
export function kbitToMbitText(kbit: number | null | undefined): string {
  if (kbit === null || kbit === undefined) return '∞'
  const mbit = kbit / 1000
  return String(Number(mbit.toFixed(mbit >= 100 ? 0 : mbit >= 10 ? 1 : 2)))
}

/** `↓ 50 / ↑ 10 Mbit/s`, each direction on its own when one is unlimited. */
export function formatRatePair(rate: QosRate | null | undefined, unlimited = 'Unlimited'): string {
  if (!rate) return unlimited
  const { downloadKbit: down, uploadKbit: up } = rate
  if (down === null && up === null) return unlimited
  const sameUnit = down !== null && up !== null && down >= 1000 && up >= 1000
  if (sameUnit) return `↓ ${kbitToMbitText(down)} / ↑ ${kbitToMbitText(up)} Mbit/s`
  return `↓ ${formatKbit(down, '∞')} / ↑ ${formatKbit(up, '∞')}`
}

/** What a rate input holds: Mbit/s as typed, empty = unlimited. */
export function kbitToInput(kbit: number | null | undefined): string {
  if (kbit === null || kbit === undefined) return ''
  return String(Number((kbit / 1000).toFixed(3)))
}

export type ParsedRate = { ok: true; kbit: number | null } | { ok: false; message: string }

/** Mbit/s text → kbit/s. Empty = unlimited (`null`); a comma works as the decimal mark. */
export function parseMbitInput(text: string): ParsedRate {
  const value = text.trim().replace(',', '.')
  if (value === '') return { ok: true, kbit: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return { ok: false, message: 'Enter a rate in Mbit/s, or leave it empty.' }
  const kbit = Math.round(n * 1000)
  if (n > 0 && kbit === 0) return { ok: false, message: 'Too small: the smallest step is 0.001 Mbit/s.' }
  return { ok: true, kbit: kbit === 0 ? null : kbit }
}

/** Both directions of a rate form; `null` when both are unlimited and `emptyIsNull`. */
export function parseRatePair(
  down: string,
  up: string,
): { ok: true; rate: QosRate } | { ok: false; field: 'down' | 'up'; message: string } {
  const d = parseMbitInput(down)
  if (!d.ok) return { ok: false, field: 'down', message: d.message }
  const u = parseMbitInput(up)
  if (!u.ok) return { ok: false, field: 'up', message: u.message }
  return { ok: true, rate: { downloadKbit: d.kbit, uploadKbit: u.kbit } }
}

/** A schedule override field: empty = keep (`null`), `0` = unlimited, else kbit/s. */
export function parseOverrideInput(text: string): { ok: true; kbit: number | null } | { ok: false; message: string } {
  const value = text.trim().replace(',', '.')
  if (value === '') return { ok: true, kbit: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return { ok: false, message: 'Mbit/s, 0 for unlimited, or empty to keep.' }
  return { ok: true, kbit: Math.round(n * 1000) }
}

export function overrideToInput(kbit: number | null | undefined): string {
  if (kbit === null || kbit === undefined) return ''
  if (kbit === 0) return '0'
  return kbitToInput(kbit)
}

/** A schedule override for reading: `keep`, `unlimited` or the rate. */
export function formatOverride(kbit: number | null | undefined): string {
  if (kbit === null || kbit === undefined) return 'keep'
  if (kbit === 0) return 'unlimited'
  return formatKbit(kbit)
}

export function formatOverridePair(o: QosRateOverride | null): string | null {
  if (!o) return null
  return `↓ ${formatOverride(o.downloadKbit)} / ↑ ${formatOverride(o.uploadKbit)}`
}

/** A kbit/s value that caps (a number); `null` (unlimited) never does. */
function capOf(kbit: number | null | undefined): number | null {
  return kbit === null || kbit === undefined || kbit <= 0 ? null : kbit
}

// ---------------------------------------------------------------------------
// Quotas (bytes; shown with formatBytes' 1024 steps, so they are typed in them too)

export const QUOTA_UNITS = [
  { id: 'MB', bytes: 1024 ** 2 },
  { id: 'GB', bytes: 1024 ** 3 },
] as const
export type QuotaUnit = (typeof QUOTA_UNITS)[number]['id']

export function bytesToQuotaInput(bytes: number): { value: string; unit: QuotaUnit } {
  const gb = bytes / 1024 ** 3
  if (gb >= 1 && Math.abs(gb * 100 - Math.round(gb * 100)) < 1e-6) {
    return { value: String(Number(gb.toFixed(2))), unit: 'GB' }
  }
  return { value: String(Number((bytes / 1024 ** 2).toFixed(2))), unit: 'MB' }
}

export function parseQuotaInput(value: string, unit: QuotaUnit): number | null {
  const n = Number(value.trim().replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const factor = QUOTA_UNITS.find((u) => u.id === unit)?.bytes ?? 1024 ** 2
  return Math.round(n * factor)
}

/** 0–100, how much of the quota is used. */
export function quotaPercent(quota: Pick<QosQuota, 'limitBytes' | 'usedBytes'>): number {
  if (quota.limitBytes <= 0) return 100
  return Math.min(100, Math.max(0, (quota.usedBytes / quota.limitBytes) * 100))
}

// ---------------------------------------------------------------------------
// Days and times (the API takes day names; the store keeps a bitmask, bit 0 = Monday)

export const DAYS: readonly QosDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_LABEL: Record<QosDay, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

export function dayLabel(day: QosDay): string {
  return DAY_LABEL[day]
}

export function daysToMask(days: readonly QosDay[]): number {
  return days.reduce((mask, day) => mask | (1 << DAYS.indexOf(day)), 0)
}

export function maskToDays(mask: number): QosDay[] {
  return DAYS.filter((_, i) => (mask & (1 << i)) !== 0)
}

/** `Every day`, `Mon–Fri`, `Sat, Sun`, `Mon, Wed, Fri–Sun`. */
export function formatDays(days: readonly QosDay[]): string {
  const mask = daysToMask(days)
  if (mask === 0x7f) return 'Every day'
  if (mask === 0) return 'No days'
  const runs: string[] = []
  let i = 0
  while (i < 7) {
    if (!(mask & (1 << i))) {
      i++
      continue
    }
    let j = i
    while (j + 1 < 7 && mask & (1 << (j + 1))) j++
    const from = DAY_LABEL[DAYS[i]]
    const to = DAY_LABEL[DAYS[j]]
    if (j === i) runs.push(from)
    else if (j === i + 1) runs.push(from, to)
    else runs.push(`${from}–${to}`)
    i = j + 1
  }
  return runs.join(', ')
}

export function minuteToTime(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** `HH:MM` (what `<input type="time">` gives) → minutes after midnight, or null. */
export function timeToMinute(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/** `18:00–23:00`, `22:00–06:00 (next day)`, `all day`. */
export function formatWindowTimes(startMinute: number, endMinute: number): string {
  if (startMinute === endMinute) return startMinute === 0 ? 'all day' : `${minuteToTime(startMinute)} for 24 h`
  const text = `${minuteToTime(startMinute)}–${minuteToTime(endMinute)}`
  return endMinute < startMinute ? `${text} (next day)` : text
}

export function formatScheduleWindow(s: Pick<QosSchedule, 'days' | 'startMinute' | 'endMinute'>): string {
  return `${formatDays(s.days)} · ${formatWindowTimes(s.startMinute, s.endMinute)}`
}

/** Weekday (0 = Monday) and minute of the day at `at` in `timeZone`. */
export function zonedClock(at: Date, timeZone: string): { day: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'))
    const hour = Number(get('hour')) % 24
    const minute = Number(get('minute'))
    if (day < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return { day, minute: hour * 60 + minute }
  } catch {
    return null
  }
}

/**
 * Is a weekly window in force at `at`, judged in `timeZone` (the same rule as
 * the planner's preview, docs/gateway/qos.md 3.4): the days are the days a
 * window starts on; an end at or before the start runs past midnight (equal =
 * 24 hours). A preview only: the router decides on its own clock.
 */
export function windowActiveAt(
  days: readonly QosDay[],
  startMinute: number,
  endMinute: number,
  at: Date,
  timeZone: string,
): boolean | null {
  const clock = zonedClock(at, timeZone)
  if (!clock) return null
  const mask = daysToMask(days)
  const on = (day: number) => (mask & (1 << ((day + 7) % 7))) !== 0
  const { day, minute } = clock
  if (endMinute > startMinute) return on(day) && minute >= startMinute && minute < endMinute
  // Past midnight (or a full 24 hours when equal).
  return (on(day) && minute >= startMinute) || (on(day - 1) && minute < endMinute)
}

// ---------------------------------------------------------------------------
// Bucket tree (nested policies, depth ≤ maxBucketDepth; section 3.3)

export type PolicyNode = {
  policy: QosPolicy
  depth: number
  children: PolicyNode[]
  /** Sum of the enabled children's shared rates (numeric directions only). */
  childSum: { down: number; up: number }
  problems: TreeProblem[]
}

export type TreeProblem = { code: string; message: string; severity: 'error' | 'warning' }

/** Policies as a forest, parents first, siblings by name. Orphans and cycles land at the top. */
export function buildPolicyTree(policies: readonly QosPolicy[]): PolicyNode[] {
  const byId = new Map(policies.map((p) => [p.id, p]))
  const nodes = new Map<number, PolicyNode>()
  for (const p of policies) {
    nodes.set(p.id, { policy: p, depth: 0, children: [], childSum: { down: 0, up: 0 }, problems: [] })
  }
  const roots: PolicyNode[] = []
  for (const p of policies) {
    const node = nodes.get(p.id)!
    const parent = p.parentPolicyId !== null ? nodes.get(p.parentPolicyId) : undefined
    if (parent && !reachesSelf(p.id, byId)) parent.children.push(node)
    else roots.push(node)
  }
  const byName = (a: PolicyNode, b: PolicyNode) => a.policy.name.localeCompare(b.policy.name)
  const walk = (list: PolicyNode[], depth: number) => {
    list.sort(byName)
    for (const node of list) {
      node.depth = depth
      for (const child of node.children) {
        if (!child.policy.enabled) continue
        node.childSum.down += capOf(child.policy.shared?.downloadKbit) ?? 0
        node.childSum.up += capOf(child.policy.shared?.uploadKbit) ?? 0
      }
      walk(node.children, depth + 1)
    }
  }
  walk(roots, 0)
  for (const node of nodes.values()) node.problems = treeProblems(node, byId)
  return roots
}

function reachesSelf(id: number, byId: Map<number, QosPolicy>): boolean {
  const seen = new Set<number>()
  let cur = byId.get(id)?.parentPolicyId ?? null
  while (cur !== null) {
    if (cur === id) return true
    if (seen.has(cur)) return false
    seen.add(cur)
    cur = byId.get(cur)?.parentPolicyId ?? null
  }
  return false
}

/** Flattened tree for rendering (each node once, parents before children). */
export function flattenTree(roots: readonly PolicyNode[]): PolicyNode[] {
  const out: PolicyNode[] = []
  const visit = (list: readonly PolicyNode[]) => {
    for (const node of list) {
      out.push(node)
      visit(node.children)
    }
  }
  visit(roots)
  return out
}

/**
 * The client-side mirror of the server's checks for one policy (the server's
 * `checkPolicyTree` and `qos_each_exceeds_shared` stay the authority; this
 * shows the same problems before a save and on the tree).
 */
function treeProblems(node: PolicyNode, byId: Map<number, QosPolicy>): TreeProblem[] {
  const p = node.policy
  const problems: TreeProblem[] = []
  const each = eachExceedsShared(p.shared, p.each)
  if (each) problems.push({ code: 'qos_each_exceeds_shared', message: each, severity: 'error' })
  if (p.shared) {
    const sd = capOf(p.shared.downloadKbit)
    const su = capOf(p.shared.uploadKbit)
    if (sd !== null && node.childSum.down > sd) {
      problems.push({
        code: 'qos_children_exceed_parent',
        severity: 'error',
        message: `Nested buckets add up to ${formatKbit(node.childSum.down)} down, more than this bucket's ${formatKbit(sd)}.`,
      })
    }
    if (su !== null && node.childSum.up > su) {
      problems.push({
        code: 'qos_children_exceed_parent',
        severity: 'error',
        message: `Nested buckets add up to ${formatKbit(node.childSum.up)} up, more than this bucket's ${formatKbit(su)}.`,
      })
    }
  }
  if (p.parentPolicyId !== null) {
    const parent = byId.get(p.parentPolicyId)
    if (!parent) {
      problems.push({ code: 'qos_parent_missing', severity: 'error', message: 'Its parent policy is gone.' })
    } else {
      if (!parent.enabled) {
        problems.push({ code: 'qos_parent_disabled', severity: 'warning', message: `Parent ${parent.name} is turned off.` })
      }
      if (!parent.shared) {
        problems.push({
          code: 'qos_parent_not_bucket',
          severity: 'error',
          message: `Parent ${parent.name} has no shared bucket to nest in.`,
        })
      } else {
        const over = childExceedsParent(p.shared, parent.shared)
        if (over) problems.push({ code: 'qos_child_exceeds_parent', severity: 'error', message: over })
      }
    }
    if (!p.shared) {
      problems.push({ code: 'qos_child_not_bucket', severity: 'error', message: 'Only a policy with a shared bucket can nest.' })
    }
  }
  return problems
}

/** Message when a numeric per-device cap is above the shared bucket (`qos_each_exceeds_shared`). */
export function eachExceedsShared(shared: QosRate | null, each: QosRate | null): string | null {
  if (!shared || !each) return null
  const parts: string[] = []
  const sd = capOf(shared.downloadKbit)
  const ed = capOf(each.downloadKbit)
  if (sd !== null && ed !== null && ed > sd) parts.push(`download ${formatKbit(ed)} > ${formatKbit(sd)}`)
  const su = capOf(shared.uploadKbit)
  const eu = capOf(each.uploadKbit)
  if (su !== null && eu !== null && eu > su) parts.push(`upload ${formatKbit(eu)} > ${formatKbit(su)}`)
  return parts.length ? `Per-device cap above the shared bucket (${parts.join(', ')}).` : null
}

/** Message when a child's ceiling is above its parent's (`qos_child_exceeds_parent`); unlimited child under a capped parent counts. */
export function childExceedsParent(child: QosRate | null, parent: QosRate | null): string | null {
  if (!child || !parent) return null
  const parts: string[] = []
  const pd = capOf(parent.downloadKbit)
  const cd = capOf(child.downloadKbit)
  if (pd !== null && (cd === null || cd > pd)) parts.push(`download ${formatKbit(cd)} > ${formatKbit(pd)}`)
  const pu = capOf(parent.uploadKbit)
  const cu = capOf(child.uploadKbit)
  if (pu !== null && (cu === null || cu > pu)) parts.push(`upload ${formatKbit(cu)} > ${formatKbit(pu)}`)
  return parts.length ? `Above its parent's bucket (${parts.join(', ')}).` : null
}

/** Depth a policy would sit at under `parentId` (1 = top level). */
export function depthUnder(parentId: number | null, policies: readonly QosPolicy[]): number {
  const byId = new Map(policies.map((p) => [p.id, p]))
  let depth = 1
  const seen = new Set<number>()
  let cur = parentId
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    depth++
    cur = byId.get(cur)?.parentPolicyId ?? null
  }
  return depth
}

/** Deepest level below a policy (0 = no children). */
export function subtreeHeight(id: number, policies: readonly QosPolicy[]): number {
  const kids = policies.filter((p) => p.parentPolicyId === id)
  if (kids.length === 0) return 0
  return 1 + Math.max(...kids.map((k) => subtreeHeight(k.id, policies)))
}

/** Policies a policy may nest under: buckets, not itself or its descendants. */
export function parentCandidates(policies: readonly QosPolicy[], selfId: number | null): QosPolicy[] {
  const descendants = new Set<number>()
  if (selfId !== null) {
    const stack = [selfId]
    while (stack.length) {
      const id = stack.pop()!
      descendants.add(id)
      for (const p of policies) if (p.parentPolicyId === id && !descendants.has(p.id)) stack.push(p.id)
    }
  }
  return policies.filter((p) => p.shared !== null && !descendants.has(p.id))
}

// ---------------------------------------------------------------------------
// WAN queue presets (plan 3 section 2.1)

export type LinkPreset = {
  id: string
  label: string
  linkLayer: 'none' | 'ethernet' | 'atm'
  overhead: number | null
  mpu: number | null
  hint: string
}

export const LINK_PRESETS: readonly LinkPreset[] = [
  { id: 'none', label: 'No compensation', linkLayer: 'none', overhead: null, mpu: null, hint: 'sqm default; fine when the rate is set well below the line.' },
  { id: 'fibre', label: 'Fibre / Ethernet', linkLayer: 'ethernet', overhead: 44, mpu: null, hint: 'ethernet, overhead 44' },
  { id: 'docsis', label: 'Cable (DOCSIS)', linkLayer: 'ethernet', overhead: 18, mpu: 64, hint: 'ethernet, overhead 18, MPU 64' },
  { id: 'vdsl', label: 'VDSL', linkLayer: 'ethernet', overhead: 34, mpu: null, hint: 'ethernet, overhead 34' },
  { id: 'adsl', label: 'ADSL', linkLayer: 'atm', overhead: 44, mpu: null, hint: 'atm, overhead 44' },
]

export function matchLinkPreset(q: { linkLayer: string; overhead: number | null; mpu: number | null }): LinkPreset | null {
  return (
    LINK_PRESETS.find(
      (p) => p.linkLayer === q.linkLayer && (p.overhead ?? null) === (q.overhead ?? null) && (p.mpu ?? null) === (q.mpu ?? null),
    ) ?? null
  )
}

export const WAN_FAIRNESS_LABEL: Record<string, string> = {
  per_host: 'Fair sharing per device',
  triple_isolate: 'Per device, then per flow',
  per_flow: 'Per connection',
}

export const WAN_FLAG_TEXT: Record<string, string> = {
  qdisc_unmodeled: 'Its qdisc is not one Perch edits (kept as is).',
  script_unmodeled: 'Its sqm script is not one Perch models (kept as is).',
  fairness_unmodeled: 'Its fairness keywords are not ones Perch models.',
  fairness_mixed: 'Upload and download use different fairness.',
  nat_mixed: 'NAT awareness differs between upload and download.',
  diffserv_unmodeled: 'Its diffserv setting is not one Perch models.',
  invalid_rate: 'A rate on the router is not a number.',
  invalid_overhead: 'The overhead on the router is not a number.',
  invalid_mpu: 'The MPU on the router is not a number.',
  unknown_linklayer: 'Unknown link layer on the router.',
  inert_opts: 'Advanced options are set but switched off on the router (sqm ignores them).',
  duplicate_device: 'Two enabled queues on this device: sqm runs only one of them.',
  router_paused: 'Switched off on the router.',
  pending_delete: 'Being removed: the router drops it once the apply confirms.',
}

// ---------------------------------------------------------------------------
// States and wording

export const SHAPING_STATE: Record<QosShapingState, { label: string; tone: Tone; hint: string }> = {
  enforced: { label: 'Enforced', tone: 'good', hint: 'The router reports the device in its class.' },
  pending: { label: 'Pending', tone: 'warning', hint: 'Sent to the router, not confirmed yet.' },
  not_seen: { label: 'Not seen', tone: 'muted', hint: 'Ready on the router; the device has not shown up there.' },
  paused: { label: 'Paused', tone: 'warning', hint: 'Shaping is paused on this gateway.' },
  exhausted: { label: 'Quota used up', tone: 'critical', hint: 'Its data quota ran out.' },
  failed: { label: 'Refused', tone: 'critical', hint: 'The router refused this device entry.' },
}

export type Tone = 'good' | 'warning' | 'critical' | 'muted' | 'info'

export const TONE_DOT: Record<Tone, string> = {
  good: 'bg-status-good',
  warning: 'bg-status-warning',
  critical: 'bg-status-critical',
  muted: 'bg-muted-foreground/40',
  info: 'bg-brand',
}

export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
  muted: 'text-muted-foreground',
  info: 'text-brand',
}

const APPLY_LABEL: Record<QosApplyState['state'], { label: string; tone: Tone }> = {
  in_sync: { label: 'In sync', tone: 'good' },
  queued: { label: 'Queued', tone: 'warning' },
  applying: { label: 'Applying', tone: 'info' },
  rolled_back: { label: 'Rolled back', tone: 'critical' },
  failed: { label: 'Failed', tone: 'critical' },
  offline: { label: 'Gateway offline', tone: 'muted' },
  drift: { label: 'Changed on the router', tone: 'warning' },
  conflict: { label: 'Conflict', tone: 'critical' },
}

/** Plain words for a delivery state and its error code. */
export function describeApply(
  state: QosApplyState,
  kind: 'config' | 'devices' | 'wan',
): { label: string; tone: Tone; detail: string | null } {
  const base = APPLY_LABEL[state.state] ?? { label: state.state, tone: 'muted' as Tone }
  const error = state.error
  if (error === 'plane_unavailable') {
    return {
      label: 'Queued: config plane unavailable',
      tone: 'warning',
      detail:
        kind === 'config'
          ? 'The shaper package (buckets, network defaults, schedules) waits for the config plane, which is not available on this controller yet. Nothing is lost: Perch offers it again on every change and every 5 minutes.'
          : 'Router config changes wait for the config plane, which is not available on this controller yet.',
    }
  }
  if (error === 'qos_not_active') {
    return { label: 'Queued: shaper not running', tone: 'warning', detail: 'The gateway has not started its shaper yet; the entries go out once it reports active.' }
  }
  if (error === 'qos_unsupported') {
    return { label: 'Collector without shaping', tone: 'critical', detail: 'The collector on this gateway does not support traffic shaping. Update it; Perch retries on reconnect.' }
  }
  if (error === 'timeout') {
    return { label: 'Timed out', tone: 'critical', detail: 'The gateway did not answer in 15 s. Perch retries every 30 s.' }
  }
  if (error === 'qos_not_managed') {
    return { label: 'Queued: not managed', tone: 'warning', detail: 'The gateway is not in managed mode.' }
  }
  if (error === 'config_not_allowed') {
    return {
      label: 'Not allowed on the router',
      tone: 'critical',
      detail:
        kind === 'wan'
          ? 'The router does not let Perch write its sqm config. See the note above the queues.'
          : 'The router does not let Perch write the perch-qos config, so buckets, network defaults and schedules stay here until it does.',
    }
  }
  if (error === 'apply_in_flight') {
    return { label: 'Queued: another change first', tone: 'warning', detail: 'Another change is being applied on this gateway; this one goes out when it ends.' }
  }
  if (error === 'agent_offline' || error === 'offline') {
    return { label: 'Queued: gateway offline', tone: 'warning', detail: 'The change is kept and goes out when the gateway is back.' }
  }
  if (error === 'qos_package_missing') {
    return { label: 'perch-qos not installed', tone: 'critical', detail: 'Install perch-qos on the gateway (Gateway config → Packages); until then only per-device caps apply.' }
  }
  if (state.state === 'rolled_back') {
    const why = error && error !== 'rolled_back' ? (OUTCOME_REASON[error] ?? error) : null
    return {
      label: 'Rolled back',
      tone: 'critical',
      detail: `The router took the change and then undid it${why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}. The router runs the previous version; Perch tries again with the next change.`,
    }
  }
  if (state.state === 'failed') {
    const why = error && error !== 'failed' ? (OUTCOME_REASON[error] ?? error) : null
    return {
      label: 'Failed',
      tone: 'critical',
      detail: `The router did not take the change${why ? ` (${why.charAt(0).toLowerCase()}${why.slice(1)})` : ''}. Nothing changed on the router.`,
    }
  }
  return { label: base.label, tone: base.tone, detail: error }
}

/**
 * A write's config-plane apply in words (WAN queue writes answer
 * `{apply, applyError}`): what happened to the change right after saving.
 */
export function describeWriteApply(
  apply: GatewayApply | null,
  applyError: QosApplyError | null,
): { tone: Tone; title: string; detail: string } {
  if (applyError) {
    const known: Record<string, string> = {
      apply_in_flight: 'Another change is being applied on this gateway. This one is kept as a draft and goes out when that one ends.',
      agent_offline: 'The gateway is offline. The change is kept as a draft and goes out when it is back.',
    }
    return {
      tone: 'warning',
      title: 'Saved, not sent yet',
      detail: known[applyError.error] ?? `${applyError.message} The change is kept as a draft; apply it from the gateway's Changes tab.`,
    }
  }
  if (!apply) return { tone: 'good', title: 'Saved', detail: 'Nothing had to change on the router.' }
  const state = APPLY_STATE_META[apply.state]?.label ?? apply.state
  switch (apply.state) {
    case 'queued':
      return { tone: 'warning', title: 'Queued', detail: 'The change waits its turn and goes to the router shortly.' }
    case 'sending':
      return { tone: 'info', title: 'Sending to the router', detail: 'The router is writing the change.' }
    case 'pending_confirm':
      return {
        tone: 'info',
        title: 'Applying on the router',
        detail: `${state}: the router runs the change and rolls it back by itself unless it is confirmed within ${apply.confirmTimeoutSeconds} s.`,
      }
    case 'confirmed':
      return { tone: 'good', title: 'Applied', detail: 'The router runs the change.' }
    case 'rolled_back':
    case 'failed': {
      const reason = apply.outcome?.message ?? (apply.outcome?.reason ? OUTCOME_REASON[apply.outcome.reason] : null) ?? apply.outcome?.error
      return {
        tone: 'critical',
        title: apply.state === 'rolled_back' ? 'Rolled back on the router' : 'The router refused the change',
        detail: `${reason ? `${reason}. ` : ''}The router keeps its previous version.`,
      }
    }
    default:
      return { tone: 'muted', title: state, detail: 'The change did not go out.' }
  }
}

/** The body of an API refusal (`{error, message, issues?, …}`), or null. */
export function refusalBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
}

export function refusalIssues(error: unknown): QosPlanIssue[] {
  const issues = refusalBody(error)?.issues
  return Array.isArray(issues) ? (issues as QosPlanIssue[]) : []
}

const REFUSAL_TEXT: Record<string, string> = {
  qos_not_managed:
    'This gateway is not in managed mode, so Perch only watches it. Turn on management for the gateway first; until then shaping stays read-only.',
  qos_not_gateway: 'No collector runs on a managed gateway yet.',
  qos_gateway_required: 'Several gateways: open this page with ?gateway=<id>.',
  qos_name_taken: 'That name is already in use on this gateway.',
  qos_class_exhausted: 'All 254 buckets are taken on this gateway.',
  qos_policy_in_use: 'The policy is still in use (assignments, nested buckets or schedules): move or delete those first.',
  qos_mac_in_group: 'That device is already in another group (one group per device).',
  qos_mac_assigned: 'That device already has its own assignment.',
  qos_target_assigned: 'That group or network already has an assignment.',
  qos_conflict: 'Someone else changed this at the same time. Reload and try again.',
  qos_policy_empty: 'Give it at least one of: a shared bucket, a per-device cap (or for an assignment a policy, a rate or a quota).',
  qos_each_exceeds_shared: 'A per-device cap cannot be above the shared bucket.',
  qos_parent_cycle: 'A bucket cannot nest inside itself or its own children.',
  qos_parent_not_bucket: 'The parent has no shared bucket to nest in.',
  qos_child_not_bucket: 'Only a policy with a shared bucket can nest inside another.',
  qos_child_exceeds_parent: "A nested bucket cannot be larger than its parent's.",
  qos_children_exceed_parent: "The nested buckets would add up to more than the parent's bucket.",
  qos_bucket_too_deep: 'Buckets nest at most as deep as the Traffic shaping setting allows (4 at most).',
  qos_target_invalid: 'The target is incomplete.',
  qos_quota_needs_device: 'Quotas work on single devices only.',
  qos_throttle_required: 'A throttling quota needs the throttle rate.',
  qos_invalid_date: 'That expiry date is not valid.',
  qos_expiry_past: 'The expiry must be in the future.',
  qos_no_quota: 'This assignment has no quota to reset.',
  qos_schedule_unsupported: 'That action does not work on this target (block and move are for device and group assignments).',
  qos_schedule_policy_missing: 'Pick the policy the devices move to.',
  qos_schedule_empty: 'A limit schedule needs at least one rate.',
  qos_paused_on_router: 'The router paused shaping itself. Resume over it only if you are sure.',
  qos_unknown_device: 'That device is not a WAN interface or port of this gateway.',
  qos_duplicate_device: 'That device already has a queue.',
  qos_field_needs_cake: 'That setting needs the cake qdisc.',
  qos_overhead_needs_linklayer: 'Overhead and MPU need a link layer.',
  sqm_below_floor: 'The router refused rates this low for a WAN queue.',
  qos_package_missing: 'perch-qos is not installed on the gateway. Install it from the gateway config page (Packages).',
  apply_in_flight: 'Another change is being applied on this gateway. Try again in a moment.',
  plane_unavailable:
    'Queued: config plane unavailable. The router config cannot be written from this controller yet, so nothing was stored or sent.',
  admin_required: 'Only admins can change traffic shaping.',
}

/** A sentence for an API refusal, with the server's message as the fallback. */
export function refusalText(error: unknown): string {
  const code = apiErrorCode(error)
  const body = refusalBody(error)
  if (code === 'qos_rate_below_floor') {
    const min = typeof body?.min === 'number' ? formatKbit(body.min) : 'the floor'
    return `Rates must be at least ${min} (Settings → Traffic shaping), or empty for unlimited.`
  }
  if (code === 'sqm_below_floor' && typeof body?.minWanKbit === 'number') {
    return `The router refused it: a WAN queue needs at least ${formatKbit(body.minWanKbit)} each way.`
  }
  // The server's words carry the router owner's next step (README 7.7).
  if (code === 'config_not_allowed' && typeof body?.message === 'string') return body.message
  if (code && REFUSAL_TEXT[code]) return REFUSAL_TEXT[code]
  if (error instanceof ApiError && error.status === 403) return REFUSAL_TEXT.admin_required
  if (error instanceof Error) return error.message
  return 'The request failed.'
}

// ---------------------------------------------------------------------------
// Events

export const EVENT_TEXT: Record<string, { label: string; tone: Tone }> = {
  cap_hit: { label: 'Cap reached', tone: 'info' },
  quota_exhausted: { label: 'Quota used up', tone: 'critical' },
  pool_exhausted: { label: 'Out of device classes', tone: 'critical' },
  apply_failed: { label: 'Apply failed', tone: 'critical' },
  local_pause: { label: 'Paused on the router', tone: 'warning' },
  local_resume: { label: 'Resumed on the router', tone: 'good' },
  schedule_clock_unsynced: { label: 'Router clock not synced', tone: 'warning' },
  sqm_paused: { label: 'WAN queue switched off', tone: 'critical' },
  sqm_resumed: { label: 'WAN queue back on', tone: 'good' },
}

export function eventDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object') {
    const entries = Object.entries(detail as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => `${k} ${String(v)}`)
    return entries.length ? entries.join(' · ') : null
  }
  return String(detail)
}

// ---------------------------------------------------------------------------
// Overview helpers

/** A router-side pause of any kind: the perch-qos globals or a WAN queue (decision 15). */
export function routerPauses(overview: QosOverview): { shaper: boolean; queues: string[] } {
  return {
    shaper: overview.paused?.by === 'router',
    queues: overview.wan.filter((q) => q.pausedByRouter).map((q) => q.device),
  }
}

/** `Speed limit` one-liner for a device: `↓ 5 / ↑ 1 Mbit/s`, or the bucket when it has no own cap. */
export function shapingSummary(s: DeviceShaping): string {
  const own = s.cap.downloadKbit !== null || s.cap.uploadKbit !== null
  if (own) return formatRatePair(s.cap)
  if (s.bucket) return `shares ${formatRatePair(s.bucket.rate)}`
  if (s.quota) return 'quota only'
  return 'Unlimited'
}

export function viaLabel(via: DeviceShaping['via']): string {
  if (via === 'device') return 'Own assignment'
  if (via === 'group') return 'Group'
  return 'Network default'
}

/** Gateway selection: `?gateway=N` on the page, else the only gateway. */
export function gatewayParams(gatewayId: number | null): string {
  return gatewayId ? `gatewayId=${gatewayId}` : ''
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return '—'
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return value
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(ts)
}

/** Normalised MAC (lowercase, colons), or null. The server accepts `-` too; this keeps lists tidy. */
export function normalizeMacInput(text: string): string | null {
  const hex = text.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g)!.join(':')
}

/** An instant that has passed (an assignment's expiry); read against the clock at call time. */
export function isPast(iso: string | null | undefined, now = Date.now()): boolean {
  return iso !== null && iso !== undefined && Date.parse(iso) <= now
}
