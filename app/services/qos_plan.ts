import { createHash } from 'node:crypto'
import type { UciOptions } from '#services/gateway_config/types'
import { QOS_DEFAULTS, type QosSettings } from '#services/qos_settings'
import { DateTime } from 'luxon'

/**
 * The QoS planner (docs/gateway/qos.md section 3; plan 3 sections 3.3, 3.4
 * and WP-C, with the kernel spike amendment of 2026-09-23): policies, groups,
 * assignments and schedules in, the router's desired shaping out. Pure: no
 * I/O, no clock (the caller passes `at`, used only for expiries and the
 * preview), so the same input always yields the same plan
 * (tests/unit/services/qos_plan.spec.ts).
 *
 * Output, the contract with the agent (WP-E):
 * - `sections`: the Perch-owned `/etc/config/perch-qos` (controller → router
 *   through the config plane): `globals`, one `bucket` per referenced policy
 *   with a shared part (parents before children), one `network` per network
 *   default, one `schedule` per schedule in use.
 * - `devices`: the per-MAC `DeviceEntry[]` of the `qos.devices.set` runtime
 *   RPC, sorted by MAC.
 *
 * Schedules are data, not plan changes (amendment section 6): the router
 * evaluates the windows on its own clock and switches rates / classes
 * hitlessly, so they keep working while the controller is away. The plan
 * never depends on the time of day; `activeSchedules` is only a preview for
 * the dashboard (in `timezone`, the gateway's zone).
 *
 * Precedence per MAC: the device's own assignment, else its group's, else
 * the network default (which the router applies dynamically). An assignment
 * that is inactive (expired, its policy disabled or gone, nothing to shape)
 * falls through to the next level.
 *
 * A device target may name the network it sits in (`within`, set for guest
 * portal devices: their portal's network). Such a device stays inside that
 * network's default: without a bucket of its own it sits in the network's
 * bucket, and its caps are never above the network's per-device cap.
 *
 * Owner decisions 2026-09-23 built in:
 * - 13: caps are internet-only unless the policy's `includeLan` is on
 *   (`include_lan '1'` on its bucket / network, `includeLan: true` on its
 *   device entries).
 * - 16: nested buckets (`parent`, depth ≤ `maxBucketDepth` ≤ 4, amendment
 *   section 5) and weekly schedules (`config schedule`).
 */

// ---------------------------------------------------------------------------
// Class ids (plan 3 section 3.2)

/** Bucket class minors, one per policy (assigned by the controller). */
export const BUCKET_MINOR_MIN = 0x02
export const BUCKET_MINOR_MAX = 0xff
/** A bucket's rest leaf is `0x100 | bucket minor` (derived by the agent). */
export const REST_LEAF_BASE = 0x100
/** Device leaves (allocated by the agent per MAC and reported back). */
export const DEVICE_MINOR_MIN = 0x200
export const DEVICE_MINOR_MAX = 0xfffe
/** `qos.devices.set` carries at most this many entries. */
export const MAX_DEVICE_ENTRIES = 4096
/**
 * HTB's 8 levels (TC_HTB_MAXDEPTH) minus the root class and the leaves:
 * the deepest bucket nesting the router can build (amendment section 5).
 */
export const MAX_BUCKET_DEPTH = 4

export function isBucketMinor(minor: number): boolean {
  return Number.isInteger(minor) && minor >= BUCKET_MINOR_MIN && minor <= BUCKET_MINOR_MAX
}

/** The lowest free bucket minor, or null when all 254 are taken. */
export function allocateClassMinor(used: Iterable<number>): number | null {
  const taken = new Set(used)
  for (let minor = BUCKET_MINOR_MIN; minor <= BUCKET_MINOR_MAX; minor++) {
    if (!taken.has(minor)) return minor
  }
  return null
}

/** `perch-qos` section name of a bucket: `b` + the minor in hex (`b12`). */
export function bucketSectionName(minor: number): string {
  return `b${minor.toString(16)}`
}

/** `class` option of a bucket: `0x12`. */
export function bucketClassOption(minor: number): string {
  return `0x${minor.toString(16)}`
}

/** The rest leaf's minor of a bucket. */
export function restLeafMinor(minor: number): number {
  return REST_LEAF_BASE | minor
}

/** `perch-qos` section name of a schedule: `s` + its id. */
export function scheduleSectionName(id: number): string {
  return `s${id}`
}

// ---------------------------------------------------------------------------
// Input

/** A rate pair in kbit/s; 0 = unlimited that way. */
export interface PlanRate {
  downKbit: number
  upKbit: number
}

/** A partial rate of a schedule: null = keep the target's own value that way. */
export interface PlanRateOverride {
  downKbit: number | null
  upKbit: number | null
}

/** Two nullable columns → a rate: both NULL = none, else NULL reads as 0 (unlimited). */
export function rateFromColumns(
  down: number | null | undefined,
  up: number | null | undefined
): PlanRate | null {
  if ((down === null || down === undefined) && (up === null || up === undefined)) return null
  return { downKbit: down ?? 0, upKbit: up ?? 0 }
}

/** Two nullable columns → an override (both NULL = no override). */
export function overrideFromColumns(
  down: number | null | undefined,
  up: number | null | undefined
): PlanRateOverride | null {
  if ((down === null || down === undefined) && (up === null || up === undefined)) return null
  return { downKbit: down ?? null, upKbit: up ?? null }
}

export interface PlanPolicy {
  id: number
  name: string
  shared: PlanRate | null
  each: PlanRate | null
  fairness: 'per_host' | 'per_flow'
  includeLan: boolean
  parentId: number | null
  enabled: boolean
  classMinor: number
}

export interface PlanGroup {
  id: number
  members: string[]
}

export interface PlanQuota {
  limitBytes: number
  usedBytes: number
  onExhausted: 'block' | 'throttle'
  throttle: PlanRate | null
  /** When an admin last reset the quota (the agent starts over from `usedBytes` after it). */
  resetAt?: Date | null
}

export type PlanTarget =
  | {
      type: 'device'
      mac: string
      /**
       * The network the device sits in (a UCI interface name): the device
       * stays inside that network's default (its bucket, at most its
       * per-device cap). Set for guest portal devices.
       */
      within?: string | null
    }
  | { type: 'group'; groupId: number }
  | { type: 'network'; network: string }

export interface PlanAssignment {
  id: number
  policyId: number | null
  target: PlanTarget
  /** Overrides the policy's `each` for this target. */
  rate: PlanRate | null
  quota: PlanQuota | null
  expiresAt: Date | null
}

export const PLAN_DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export interface PlanSchedule {
  id: number
  enabled: boolean
  target: { type: 'policy'; policyId: number } | { type: 'assignment'; assignmentId: number }
  action: 'limit' | 'unlimited' | 'block' | 'policy'
  usePolicyId: number | null
  /** Policy targets, `limit`: the bucket's rates. */
  shared: PlanRateOverride | null
  /** Policy targets, `limit`: the members' own caps. */
  each: PlanRateOverride | null
  /** Assignment targets, `limit`. */
  rate: PlanRateOverride | null
  /** Bit 0 = Monday … bit 6 = Sunday: the days a window starts on. */
  days: number
  /** Minutes after local midnight (the gateway's clock), 0-1439. `end <= start` crosses midnight. */
  startMinute: number
  endMinute: number
}

export interface PlanInput {
  policies: PlanPolicy[]
  groups: PlanGroup[]
  assignments: PlanAssignment[]
  schedules?: PlanSchedule[]
  settings?: Partial<QosSettings>
  /** The controller paused shaping (`globals.enabled '0'`). */
  paused?: boolean
  /**
   * Extra never-shaped prefixes (`list exempt`). The router's own LAN
   * prefixes are always exempt, each exactly (amendment section 3.1).
   */
  exempt?: string[]
  /** The gateway's LAN networks (UCI interface names); when given, other network targets are refused. */
  networks?: string[]
  at: Date
  /** The gateway's zone, for the `activeSchedules` preview only (default UTC). */
  timezone?: string
}

// ---------------------------------------------------------------------------
// Output

/** Plan 3 section 3.4 `DeviceEntry`, plus the v1 additions (decisions 13 and 16). */
export interface DeviceEntry {
  mac: string
  /** `perch-qos` bucket section name; with no caps the MAC sits in its rest leaf. */
  bucket: string | null
  /** null = unlimited that way. */
  downKbit: number | null
  upKbit: number | null
  quota: {
    limitBytes: number
    usedBytes: number
    onExhausted: 'block' | 'throttle'
    throttleDownKbit: number | null
    throttleUpKbit: number | null
    /**
     * Present after an admin reset: the agent normally keeps the larger of
     * its own count and `usedBytes`; a `resetAt` newer than the one it holds
     * makes it start over from `usedBytes`.
     */
    resetAt?: string
  } | null
  expiresAt: string | null
  /** Decision 13: also shape LAN-to-LAN traffic of this MAC (absent = internet only). */
  includeLan?: true
  /**
   * Decision 16: `perch-qos` schedule sections that apply to this entry, in
   * precedence order (the first active one wins; the assignment's own before
   * its policy's). Absent = none.
   */
  schedules?: string[]
}

export interface PlanSection {
  name: string
  type: 'globals' | 'bucket' | 'network' | 'schedule'
  options: UciOptions
}

export interface PlanIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  policyId?: number
  assignmentId?: number
  scheduleId?: number
  mac?: string
  network?: string
}

/** Which assignment shapes a MAC with its own entry (device level or group level). */
export interface PlanOrigin {
  assignmentId: number
  policyId: number | null
  via: 'device' | 'group'
}

export interface QosPlan {
  sections: PlanSection[]
  devices: DeviceEntry[]
  /** Per MAC with an entry: where the entry came from (the read side's `via`). */
  origins: Record<string, PlanOrigin>
  /** Per network with a default: the assignment and policy behind it. */
  networkOrigins: Record<string, { assignmentId: number; policyId: number | null }>
  issues: PlanIssue[]
  /** Preview: rendered schedules whose window covers `at` in `timezone`, by id. */
  activeSchedules: number[]
  /** Preview: the next window edge or expiry after `at`, ISO UTC. */
  nextChangeAt: string | null
  /**
   * sha256 of the sections and of the device entries: a sender sends only on
   * change. The devices fingerprint leaves out `quota.usedBytes` (persisting
   * the router's own count must not trigger a resend).
   */
  fingerprints: { config: string; devices: string }
}

// ---------------------------------------------------------------------------
// Schedule windows

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/
const UCI_NAME = /^[A-Za-z0-9_]{1,32}$/

function normalizeMac(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/-/g, ':')
  return MAC.test(cleaned) ? cleaned : null
}

/** A valid IANA zone name (luxon), else null. */
export function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null
  return DateTime.now().setZone(zone).isValid ? zone : null
}

function dayBit(days: number, weekdayIndex: number): boolean {
  return (days & (1 << weekdayIndex)) !== 0
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** Bitmask → `mon-fri`, `mon,wed,sat-sun` (runs of three or more days become ranges). */
export function daySpec(days: number): string {
  const parts: string[] = []
  let index = 0
  while (index < 7) {
    if (!dayBit(days, index)) {
      index++
      continue
    }
    let end = index
    while (end + 1 < 7 && dayBit(days, end + 1)) end++
    if (end - index >= 2) parts.push(`${PLAN_DAY_NAMES[index]}-${PLAN_DAY_NAMES[end]}`)
    else for (let d = index; d <= end; d++) parts.push(PLAN_DAY_NAMES[d])
    index = end + 1
  }
  return parts.join(',')
}

/**
 * A schedule's window in the `perch-qos` grammar: `<days> <HH:MM>-<HH:MM>`,
 * gateway-local time; days are the days a window starts on; an end at or
 * before the start runs past midnight (equal = 24 hours).
 */
export function scheduleWindow(
  schedule: Pick<PlanSchedule, 'days' | 'startMinute' | 'endMinute'>
): string {
  return `${daySpec(schedule.days)} ${hhmm(schedule.startMinute)}-${hhmm(schedule.endMinute)}`
}

/** Whether a schedule's window covers `at` in `zone` (ignores `enabled`). */
export function scheduleCovers(
  schedule: Pick<PlanSchedule, 'days' | 'startMinute' | 'endMinute'>,
  at: Date,
  zone: string
): boolean {
  const local = DateTime.fromJSDate(at).setZone(zone)
  const minute = local.hour * 60 + local.minute
  const today = local.weekday - 1
  const yesterday = (today + 6) % 7
  const { startMinute: start, endMinute: end, days } = schedule
  if (start < end) return dayBit(days, today) && minute >= start && minute < end
  return (dayBit(days, today) && minute >= start) || (dayBit(days, yesterday) && minute < end)
}

/** Window edges of a schedule after `at` in `zone`, within the next 8 days. */
export function scheduleEdgesAfter(
  schedule: Pick<PlanSchedule, 'days' | 'startMinute' | 'endMinute'>,
  at: Date,
  zone: string
): DateTime[] {
  const now = DateTime.fromJSDate(at).setZone(zone)
  const edges: DateTime[] = []
  const { startMinute: start, endMinute: end, days } = schedule
  for (let offset = -1; offset <= 8; offset++) {
    const day = now.startOf('day').plus({ days: offset })
    if (!dayBit(days, day.weekday - 1)) continue
    const startAt = day.set({ hour: Math.floor(start / 60), minute: start % 60 })
    const endDay = end <= start ? day.plus({ days: 1 }) : day
    const endAt = endDay.set({ hour: Math.floor(end / 60), minute: end % 60 })
    for (const edge of [startAt, endAt]) {
      if (edge.toMillis() > at.getTime()) edges.push(edge)
    }
  }
  return edges.sort((a, b) => a.toMillis() - b.toMillis())
}

// ---------------------------------------------------------------------------
// The planner

type Resolution =
  | { kind: 'skip' }
  | { kind: 'shape'; policy: PlanPolicy | null; rate: PlanRate | null }

/** Where an entry or a network section got its shaping (for schedule attachment). */
interface Origin {
  assignmentId: number
  policyId: number | null
  via: 'device' | 'group' | 'network'
  /** The cap comes from the policy's `each` (not the assignment's own rate). */
  capFromPolicy: boolean
}

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4_CIDR = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}/(3[0-2]|[12]?\\d)$`)

/** An IPv4 or IPv6 prefix in CIDR form (the IPv6 check is shape-only). */
function isCidr(value: string): boolean {
  if (IPV4_CIDR.test(value)) return true
  const [address, length, ...rest] = value.split('/')
  if (
    rest.length > 0 ||
    length === undefined ||
    !/^\d{1,3}$/.test(length) ||
    Number(length) > 128
  ) {
    return false
  }
  return address.includes(':') && /^[0-9a-f:]+$/i.test(address) && address.split('::').length <= 2
}

function kbitOrNull(value: number): number | null {
  return value === 0 ? null : value
}

/** Per direction: the child allows more than the parent (0 = unlimited). */
function exceeds(child: PlanRate, parent: PlanRate): boolean {
  const over = (c: number, p: number) => p > 0 && (c === 0 || c > p)
  return over(child.downKbit, parent.downKbit) || over(child.upKbit, parent.upKbit)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The device entries' fingerprint, blind to `quota.usedBytes` (see `QosPlan.fingerprints`). */
export function devicesFingerprint(devices: DeviceEntry[]): string {
  return sha256(
    devices.map((entry) =>
      entry.quota ? { ...entry, quota: { ...entry.quota, usedBytes: 0 } } : entry
    )
  )
}

function optionKbit(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * Plans the shaping of one gateway. Never throws on bad data: whatever cannot
 * be planned is left out and reported in `issues` (the sender decides what
 * an error blocks).
 */
export function planQos(input: PlanInput): QosPlan {
  const settings: QosSettings = { ...QOS_DEFAULTS, ...(input.settings ?? {}) }
  const maxDepth = Math.min(MAX_BUCKET_DEPTH, Math.max(1, settings.maxBucketDepth))
  const at = input.at
  const zone = validZone(input.timezone) ?? 'UTC'
  const issues: PlanIssue[] = []
  const issue = (entry: PlanIssue) => issues.push(entry)

  const policies = new Map(input.policies.map((p) => [p.id, p]))

  // Which policies may render a bucket: a valid, unique class minor.
  const minorOwner = new Map<number, number>()
  const bucketUsable = new Set<number>()
  for (const policy of [...input.policies].sort((a, b) => a.id - b.id)) {
    if (!isBucketMinor(policy.classMinor)) {
      issue({
        severity: 'error',
        code: 'qos_class_invalid',
        message: `Policy ${policy.id} has class minor ${policy.classMinor}, outside 0x02-0xff.`,
        policyId: policy.id,
      })
      continue
    }
    const owner = minorOwner.get(policy.classMinor)
    if (owner !== undefined) {
      issue({
        severity: 'error',
        code: 'qos_class_duplicate',
        message: `Policies ${owner} and ${policy.id} share class minor ${bucketClassOption(policy.classMinor)}.`,
        policyId: policy.id,
      })
      continue
    }
    minorOwner.set(policy.classMinor, policy.id)
    bucketUsable.add(policy.id)
    if (policy.shared && policy.each && exceeds(policy.each, policy.shared)) {
      issue({
        severity: 'warning',
        code: 'qos_each_exceeds_shared',
        message: `Policy ${policy.id}: the per-device cap is above the shared bucket; the bucket limits it.`,
        policyId: policy.id,
      })
    }
  }

  // Bucket parents, validated once per policy (amendment section 5: depth ≤ 4,
  // a child's ceiling within its parent's).
  const parentOf = new Map<number, number | null>()
  const depthOf = new Map<number, number>()
  const isAncestor = (id: number, start: number): boolean => {
    const seen = new Set<number>()
    let cursor: number | null = start
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === id) return true
      seen.add(cursor)
      cursor = policies.get(cursor)?.parentId ?? null
    }
    return false
  }
  const resolveParent = (policy: PlanPolicy): number | null => {
    if (parentOf.has(policy.id)) return parentOf.get(policy.id)!
    parentOf.set(policy.id, null) // guard while resolving
    let result: number | null = null
    const parentId = policy.parentId
    const refuse = (code: string, message: string) =>
      issue({ severity: 'error', code, message, policyId: policy.id })
    if (parentId !== null) {
      const parent = policies.get(parentId)
      if (!parent) {
        refuse(
          'qos_parent_missing',
          `Policy ${policy.id}: parent policy ${parentId} does not exist.`
        )
      } else if (!parent.enabled) {
        issue({
          severity: 'warning',
          code: 'qos_parent_disabled',
          message: `Policy ${policy.id}: parent policy ${parentId} is disabled; its bucket stands alone.`,
          policyId: policy.id,
        })
      } else if (!parent.shared || !bucketUsable.has(parentId)) {
        refuse(
          'qos_parent_not_bucket',
          `Policy ${policy.id}: parent policy ${parentId} has no usable shared bucket.`
        )
      } else if (isAncestor(policy.id, parentId)) {
        refuse('qos_parent_cycle', `Policy ${policy.id}: its parents form a cycle.`)
      } else if (policy.shared && exceeds(policy.shared, parent.shared)) {
        refuse(
          'qos_child_exceeds_parent',
          `Policy ${policy.id}: its bucket allows more than its parent's; HTB cannot nest it there.`
        )
      } else {
        resolveParent(parent)
        const depth = depthOf.get(parentId)! + 1
        if (depth > maxDepth) {
          refuse(
            'qos_bucket_too_deep',
            `Policy ${policy.id}: nesting ${depth} deep, the limit is ${maxDepth}.`
          )
        } else {
          result = parentId
          depthOf.set(policy.id, depth)
        }
      }
    }
    if (result === null) depthOf.set(policy.id, 1)
    parentOf.set(policy.id, result)
    return result
  }

  const floor = (rate: PlanRate, context: Omit<PlanIssue, 'severity' | 'code' | 'message'>) => {
    const clamp = (value: number) =>
      value !== 0 && value < settings.minDeviceKbit ? settings.minDeviceKbit : value
    const out = { downKbit: clamp(rate.downKbit), upKbit: clamp(rate.upKbit) }
    if (out.downKbit !== rate.downKbit || out.upKbit !== rate.upKbit) {
      issue({
        severity: 'warning',
        code: 'qos_rate_below_floor',
        message: `A cap below ${settings.minDeviceKbit} kbit/s was raised to it.`,
        ...context,
      })
    }
    return out
  }
  const floorOne = (value: number | null) =>
    value === null || value === 0 || value >= settings.minDeviceKbit
      ? value
      : settings.minDeviceKbit

  // Assignments → what each one shapes (independent of the time of day).
  const resolve = (assignment: PlanAssignment): Resolution => {
    if (assignment.expiresAt && assignment.expiresAt.getTime() <= at.getTime()) {
      return { kind: 'skip' }
    }
    if (assignment.policyId === null) return { kind: 'shape', policy: null, rate: assignment.rate }
    const policy = policies.get(assignment.policyId)
    if (!policy) {
      issue({
        severity: 'error',
        code: 'qos_policy_missing',
        message: `Assignment ${assignment.id}: policy ${assignment.policyId} does not exist.`,
        assignmentId: assignment.id,
      })
      return { kind: 'skip' }
    }
    if (!policy.enabled) return { kind: 'skip' }
    return { kind: 'shape', policy, rate: assignment.rate }
  }

  const resolutions = new Map<number, Resolution>()
  const resolveOnce = (assignment: PlanAssignment): Resolution => {
    let resolution = resolutions.get(assignment.id)
    if (!resolution) {
      resolution = resolve(assignment)
      resolutions.set(assignment.id, resolution)
    }
    return resolution
  }

  const referenced = new Set<number>()
  const bucketFor = (
    policy: PlanPolicy | null,
    context: Omit<PlanIssue, 'severity' | 'code' | 'message'>
  ) => {
    if (!policy || !policy.shared) return null
    if (!bucketUsable.has(policy.id)) {
      issue({
        severity: 'error',
        code: 'qos_bucket_unusable',
        message: `Policy ${policy.id} has no usable class; its members are not put in its bucket.`,
        ...context,
      })
      return null
    }
    referenced.add(policy.id)
    return bucketSectionName(policy.classMinor)
  }

  const ordered = [...input.assignments].sort((a, b) => a.id - b.id)
  const knownNetworks = input.networks ? new Set(input.networks) : null

  // The network defaults, first per network (level 3 below reports their
  // problems): what a device `within` a network stays inside.
  const networkDefaults = new Map<string, Extract<Resolution, { kind: 'shape' }>>()
  for (const assignment of ordered) {
    if (assignment.target.type !== 'network') continue
    const network = assignment.target.network
    if (!UCI_NAME.test(network) || (knownNetworks && !knownNetworks.has(network))) continue
    if (networkDefaults.has(network)) continue
    const resolution = resolveOnce(assignment)
    if (resolution.kind === 'shape') networkDefaults.set(network, resolution)
    else networkDefaults.set(network, { kind: 'shape', policy: null, rate: null })
  }

  /** Per direction the lower cap (0 = unlimited that way). */
  const lowerCap = (a: PlanRate | null, b: PlanRate | null): PlanRate | null => {
    if (!a) return b
    if (!b) return a
    const low = (x: number, y: number) => (x === 0 ? y : y === 0 ? x : Math.min(x, y))
    return { downKbit: low(a.downKbit, b.downKbit), upKbit: low(a.upKbit, b.upKbit) }
  }

  const entryOrigin = new Map<string, Origin>()
  const entryFor = (
    mac: string,
    assignment: PlanAssignment,
    resolution: Extract<Resolution, { kind: 'shape' }>
  ): DeviceEntry | null => {
    const context = { assignmentId: assignment.id, mac }
    const { policy } = resolution
    let bucket = bucketFor(policy, context)
    let capsRaw = resolution.rate ?? policy?.each ?? null
    const within = assignment.target.type === 'device' ? assignment.target.within : null
    const home = within ? networkDefaults.get(within) : undefined
    if (home) {
      // The device stays inside its network's default (portal devices).
      if (!bucket) bucket = bucketFor(home.policy, { ...context, network: within! })
      capsRaw = lowerCap(capsRaw, home.rate ?? home.policy?.each ?? null)
    }
    const caps = capsRaw ? floor(capsRaw, context) : null
    let quota: DeviceEntry['quota'] = null
    if (assignment.quota && assignment.target.type === 'device') {
      const q = assignment.quota
      quota = {
        limitBytes: q.limitBytes,
        usedBytes: q.usedBytes,
        onExhausted: q.onExhausted,
        throttleDownKbit: q.throttle ? kbitOrNull(q.throttle.downKbit) : null,
        throttleUpKbit: q.throttle ? kbitOrNull(q.throttle.upKbit) : null,
      }
      if (q.resetAt) quota.resetAt = q.resetAt.toISOString()
    }
    if (!bucket && !caps && !quota) {
      issue({
        severity: 'warning',
        code: 'qos_policy_empty',
        message: `Assignment ${assignment.id} shapes nothing (no bucket, no cap, no quota).`,
        ...context,
      })
      return null
    }
    const entry: DeviceEntry = {
      mac,
      bucket,
      downKbit: caps ? kbitOrNull(caps.downKbit) : null,
      upKbit: caps ? kbitOrNull(caps.upKbit) : null,
      quota,
      expiresAt: assignment.expiresAt ? assignment.expiresAt.toISOString() : null,
    }
    if (policy?.includeLan) entry.includeLan = true
    entryOrigin.set(mac, {
      assignmentId: assignment.id,
      policyId: policy?.id ?? null,
      via: assignment.target.type === 'device' ? 'device' : 'group',
      capFromPolicy: resolution.rate === null && Boolean(policy?.each),
    })
    return entry
  }

  const byMac = new Map<string, DeviceEntry>()
  const groups = new Map(input.groups.map((g) => [g.id, g]))
  const assignments = new Map(ordered.map((a) => [a.id, a]))

  // Level 2: groups (device assignments override below).
  for (const assignment of ordered) {
    if (assignment.target.type !== 'group') continue
    const group = groups.get(assignment.target.groupId)
    if (!group) {
      issue({
        severity: 'error',
        code: 'qos_group_missing',
        message: `Assignment ${assignment.id}: group ${assignment.target.groupId} does not exist.`,
        assignmentId: assignment.id,
      })
      continue
    }
    if (assignment.quota) {
      issue({
        severity: 'warning',
        code: 'qos_quota_needs_device',
        message: `Assignment ${assignment.id}: quotas apply to single devices; the group's quota is ignored.`,
        assignmentId: assignment.id,
      })
    }
    const resolution = resolveOnce(assignment)
    if (resolution.kind === 'skip') continue
    for (const raw of group.members) {
      const mac = normalizeMac(raw)
      if (!mac) {
        issue({
          severity: 'warning',
          code: 'qos_invalid_mac',
          message: `Group ${group.id}: "${raw}" is not a MAC address.`,
          assignmentId: assignment.id,
        })
        continue
      }
      if (byMac.has(mac)) {
        issue({
          severity: 'warning',
          code: 'qos_mac_in_two_groups',
          message: `${mac} is in more than one assigned group; the first applies.`,
          mac,
          assignmentId: assignment.id,
        })
        continue
      }
      const entry = entryFor(mac, assignment, resolution)
      if (entry) byMac.set(mac, entry)
    }
  }

  // Level 1: the device's own assignment.
  const deviceSeen = new Set<string>()
  for (const assignment of ordered) {
    if (assignment.target.type !== 'device') continue
    const mac = normalizeMac(assignment.target.mac)
    if (!mac) {
      issue({
        severity: 'error',
        code: 'qos_invalid_mac',
        message: `Assignment ${assignment.id}: "${assignment.target.mac}" is not a MAC address.`,
        assignmentId: assignment.id,
      })
      continue
    }
    if (deviceSeen.has(mac)) {
      issue({
        severity: 'error',
        code: 'qos_mac_assigned',
        message: `${mac} has more than one device assignment; the first applies.`,
        mac,
        assignmentId: assignment.id,
      })
      continue
    }
    deviceSeen.add(mac)
    const resolution = resolveOnce(assignment)
    if (resolution.kind === 'skip') continue
    const entry = entryFor(mac, assignment, resolution)
    if (entry) byMac.set(mac, entry)
  }

  // Level 3: network defaults.
  const networkSections: PlanSection[] = []
  const networkOrigin = new Map<string, Origin>()
  const networkSeen = new Set<string>()
  for (const assignment of ordered) {
    if (assignment.target.type !== 'network') continue
    const network = assignment.target.network
    const context = { assignmentId: assignment.id, network }
    if (!UCI_NAME.test(network) || (knownNetworks && !knownNetworks.has(network))) {
      issue({
        severity: 'error',
        code: 'qos_unknown_network',
        message: `Assignment ${assignment.id}: the gateway has no network "${network}".`,
        ...context,
      })
      continue
    }
    if (networkSeen.has(network)) {
      issue({
        severity: 'error',
        code: 'qos_target_assigned',
        message: `Network ${network} has more than one default; the first applies.`,
        ...context,
      })
      continue
    }
    networkSeen.add(network)
    if (assignment.quota) {
      issue({
        severity: 'warning',
        code: 'qos_quota_needs_device',
        message: `Assignment ${assignment.id}: quotas apply to single devices; the network's quota is ignored.`,
        ...context,
      })
    }
    const resolution = resolveOnce(assignment)
    if (resolution.kind === 'skip') continue
    const { policy } = resolution
    const bucket = bucketFor(policy, context)
    const eachRaw = resolution.rate ?? policy?.each ?? null
    const each = eachRaw ? floor(eachRaw, context) : null
    if (!bucket && !each) {
      issue({
        severity: 'warning',
        code: 'qos_policy_empty',
        message: `Assignment ${assignment.id} shapes nothing on ${network}.`,
        ...context,
      })
      continue
    }
    networkSections.push({
      name: network,
      type: 'network',
      options: {
        policy: policy ? String(policy.id) : '',
        bucket: bucket ?? '',
        each_down_kbit: each ? String(each.downKbit) : '',
        each_up_kbit: each ? String(each.upKbit) : '',
        include_lan: policy?.includeLan ? '1' : '0',
      },
    })
    networkOrigin.set(network, {
      assignmentId: assignment.id,
      policyId: policy?.id ?? null,
      via: 'network',
      capFromPolicy: resolution.rate === null && Boolean(policy?.each),
    })
  }
  networkSections.sort((a, b) => a.name.localeCompare(b.name))

  // Schedules (decision 16, amendment section 6): rendered as data the router
  // evaluates; attached to the buckets, entries and networks they change.
  const scheduleSections: PlanSection[] = []
  const bucketSchedules = new Map<number, string[]>()
  const attached = new Map<string, string[]>() // 'mac:<mac>' | 'net:<name>' → schedule names
  const attach = (key: string, name: string) =>
    attached.set(key, [...(attached.get(key) ?? []), name])
  const rendered: PlanSchedule[] = []
  // Assignment schedules come first so they win over their policy's.
  const scheduleOrder = [...(input.schedules ?? [])].sort(
    (a, b) =>
      (a.target.type === 'assignment' ? 0 : 1) - (b.target.type === 'assignment' ? 0 : 1) ||
      a.id - b.id
  )
  for (const schedule of scheduleOrder) {
    if (!schedule.enabled) continue
    const name = scheduleSectionName(schedule.id)
    const context = { scheduleId: schedule.id }
    const refuse = (code: string, message: string) =>
      issue({ severity: 'error', code, message, ...context })
    if ((schedule.days & 0x7f) === 0) {
      refuse('qos_schedule_no_days', `Schedule ${schedule.id} runs on no day.`)
      continue
    }
    if (
      !Number.isInteger(schedule.startMinute) ||
      !Number.isInteger(schedule.endMinute) ||
      schedule.startMinute < 0 ||
      schedule.startMinute > 1439 ||
      schedule.endMinute < 0 ||
      schedule.endMinute > 1439
    ) {
      refuse('qos_schedule_bad_window', `Schedule ${schedule.id}: minutes must be 0-1439.`)
      continue
    }
    const options: UciOptions = { window: [scheduleWindow(schedule)] }
    let targets: string[] = []

    if (schedule.target.type === 'policy') {
      const policyId = schedule.target.policyId
      const policy = policies.get(policyId)
      if (!policy) {
        refuse(
          'qos_schedule_target_missing',
          `Schedule ${schedule.id}: policy ${policyId} does not exist.`
        )
        continue
      }
      if (schedule.action !== 'limit' && schedule.action !== 'unlimited') {
        refuse(
          'qos_schedule_unsupported',
          `Schedule ${schedule.id}: "${schedule.action}" does not apply to a policy.`
        )
        continue
      }
      options.policy = String(policyId)
      options.action = schedule.action
      if (schedule.action === 'limit') {
        if (schedule.shared && !policy.shared) {
          issue({
            severity: 'warning',
            code: 'qos_schedule_no_bucket',
            message: `Schedule ${schedule.id}: policy ${policyId} has no shared bucket; its shared rates are ignored.`,
            ...context,
          })
        }
        options.down_kbit = policy.shared
          ? optionKbit(floorOne(schedule.shared?.downKbit ?? null))
          : ''
        options.up_kbit = policy.shared ? optionKbit(floorOne(schedule.shared?.upKbit ?? null)) : ''
        options.each_down_kbit = optionKbit(floorOne(schedule.each?.downKbit ?? null))
        options.each_up_kbit = optionKbit(floorOne(schedule.each?.upKbit ?? null))
      }
      // The policy's bucket carries its shared override.
      if (policy.shared && bucketUsable.has(policyId)) {
        bucketSchedules.set(policyId, [...(bucketSchedules.get(policyId) ?? []), name])
        targets.push(`bucket:${policyId}`)
      }
      // Entries and defaults whose cap is the policy's own `each` (an assignment's
      // own rate is not the policy's to change).
      for (const [mac, origin] of entryOrigin) {
        if (origin.policyId === policyId && origin.capFromPolicy && byMac.has(mac)) {
          attach(`mac:${mac}`, name)
          targets.push(mac)
        }
      }
      for (const [network, origin] of networkOrigin) {
        if (origin.policyId === policyId && origin.capFromPolicy) {
          attach(`net:${network}`, name)
          targets.push(network)
        }
      }
    } else {
      const assignmentId = schedule.target.assignmentId
      const assignment = assignments.get(assignmentId)
      if (!assignment) {
        refuse(
          'qos_schedule_target_missing',
          `Schedule ${schedule.id}: assignment ${assignmentId} does not exist.`
        )
        continue
      }
      options.assignment = String(assignmentId)
      if (schedule.action === 'block' && assignment.target.type === 'network') {
        refuse(
          'qos_schedule_unsupported',
          `Schedule ${schedule.id}: a network default cannot be blocked.`
        )
        continue
      }
      if (schedule.action === 'policy') {
        const alt = schedule.usePolicyId === null ? undefined : policies.get(schedule.usePolicyId)
        if (!alt || !alt.enabled) {
          refuse(
            'qos_schedule_policy_missing',
            `Schedule ${schedule.id}: policy ${schedule.usePolicyId} does not exist or is disabled.`
          )
          continue
        }
        const bucket = bucketFor(alt, context)
        const each = alt.each ? floor(alt.each, context) : null
        options.action = 'move'
        options.policy = String(alt.id)
        options.bucket = bucket ?? ''
        options.each_down_kbit = each ? String(each.downKbit) : ''
        options.each_up_kbit = each ? String(each.upKbit) : ''
      } else {
        options.action = schedule.action
        if (schedule.action === 'limit') {
          options.each_down_kbit = optionKbit(floorOne(schedule.rate?.downKbit ?? null))
          options.each_up_kbit = optionKbit(floorOne(schedule.rate?.upKbit ?? null))
        }
      }
      for (const [mac, origin] of entryOrigin) {
        if (origin.assignmentId === assignmentId && byMac.has(mac)) {
          attach(`mac:${mac}`, name)
          targets.push(mac)
        }
      }
      for (const [network, origin] of networkOrigin) {
        if (origin.assignmentId === assignmentId) {
          attach(`net:${network}`, name)
          targets.push(network)
        }
      }
    }
    targets = [...new Set(targets)]
    if (targets.length === 0) continue // its target shapes nothing right now
    scheduleSections.push({ name, type: 'schedule', options })
    rendered.push(schedule)
  }
  scheduleSections.sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))

  for (const [key, names] of attached) {
    if (key.startsWith('mac:')) {
      const entry = byMac.get(key.slice(4))
      if (entry) entry.schedules = names
    } else {
      const section = networkSections.find((s) => s.name === key.slice(4))
      if (section) section.options.schedule = names
    }
  }

  // Buckets: the referenced ones and their ancestors, parents first.
  for (const id of [...referenced]) {
    let cursor = resolveParent(policies.get(id)!)
    while (cursor !== null && !referenced.has(cursor)) {
      referenced.add(cursor)
      cursor = resolveParent(policies.get(cursor)!)
    }
  }
  const bucketPolicies = [...referenced]
    .map((id) => policies.get(id)!)
    .sort(
      (a, b) => (depthOf.get(a.id) ?? 1) - (depthOf.get(b.id) ?? 1) || a.classMinor - b.classMinor
    )
  const bucketRates = new Map<number, PlanRate>()
  const bucketSections: PlanSection[] = bucketPolicies.map((policy) => {
    const rate = floor(policy.shared!, { policyId: policy.id })
    bucketRates.set(policy.id, rate)
    const parent = parentOf.get(policy.id) ?? null
    const options: UciOptions = {
      policy: String(policy.id),
      class: bucketClassOption(policy.classMinor),
      parent: parent === null ? '' : bucketSectionName(policies.get(parent)!.classMinor),
      down_kbit: String(rate.downKbit),
      up_kbit: String(rate.upKbit),
      fairness: policy.fairness,
      include_lan: policy.includeLan ? '1' : '0',
    }
    const schedules = bucketSchedules.get(policy.id)
    if (schedules) options.schedule = schedules
    return { name: bucketSectionName(policy.classMinor), type: 'bucket', options }
  })

  // HTB's guarantee: a parent's rate covers the sum of its children's (amendment section 5).
  for (const parent of bucketPolicies) {
    const children = bucketPolicies.filter((c) => parentOf.get(c.id) === parent.id)
    if (children.length === 0) continue
    const parentRate = bucketRates.get(parent.id)!
    const sum = (pick: (r: PlanRate) => number) =>
      children.reduce((acc, c) => {
        const value = pick(bucketRates.get(c.id)!)
        return value === 0 || acc === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : acc + value
      }, 0)
    const over = (p: number, s: number) => p > 0 && s > p
    if (
      over(
        parentRate.downKbit,
        sum((r) => r.downKbit)
      ) ||
      over(
        parentRate.upKbit,
        sum((r) => r.upKbit)
      )
    ) {
      issue({
        severity: 'error',
        code: 'qos_children_exceed_parent',
        message: `Policy ${parent.id}: its nested buckets add up to more than its own rate.`,
        policyId: parent.id,
      })
    }
  }

  const globals: PlanSection = {
    name: 'globals',
    type: 'globals',
    options: {
      enabled: input.paused ? '0' : '1',
      min_wan_kbit: String(settings.minWanKbit),
      min_device_kbit: String(settings.minDeviceKbit),
      leaf_flows: String(settings.leafFlows),
      leaf_limit: String(settings.leafLimitPackets),
      leaf_memory_kb: String(settings.leafMemoryKb),
      rest_memlimit_kb: String(settings.restMemlimitKb),
      dynamic_idle: String(settings.dynamicIdleMinutes * 60),
      dynamic_limit: String(settings.dynamicClassLimit),
    },
  }
  const exempt = [...new Set(input.exempt ?? [])].filter((prefix) => {
    if (isCidr(prefix)) return true
    issue({
      severity: 'error',
      code: 'qos_invalid_prefix',
      message: `"${prefix}" is not an address prefix; it is left out of the exemptions.`,
    })
    return false
  })
  exempt.sort()
  if (exempt.length > 0) globals.options.exempt = exempt

  let devices = [...byMac.values()].sort((a, b) => a.mac.localeCompare(b.mac))
  if (devices.length > MAX_DEVICE_ENTRIES) {
    issue({
      severity: 'error',
      code: 'qos_too_many_devices',
      message: `${devices.length} device entries; the router takes ${MAX_DEVICE_ENTRIES}. The rest are left out.`,
    })
    devices = devices.slice(0, MAX_DEVICE_ENTRIES)
  }

  // Preview for the dashboard: what is in force now, and when that changes.
  const activeSchedules = rendered
    .filter((s) => scheduleCovers(s, at, zone))
    .map((s) => s.id)
    .sort((a, b) => a - b)
  let next: number | null = null
  const consider = (millis: number) => {
    if (millis > at.getTime() && (next === null || millis < next)) next = millis
  }
  for (const schedule of rendered) {
    const [edge] = scheduleEdgesAfter(schedule, at, zone)
    if (edge) consider(edge.toMillis())
  }
  for (const assignment of input.assignments) {
    if (assignment.expiresAt) consider(assignment.expiresAt.getTime())
  }

  const sections = [globals, ...bucketSections, ...networkSections, ...scheduleSections]
  const origins: Record<string, PlanOrigin> = {}
  for (const entry of devices) {
    const origin = entryOrigin.get(entry.mac)
    if (origin && origin.via !== 'network') {
      origins[entry.mac] = {
        assignmentId: origin.assignmentId,
        policyId: origin.policyId,
        via: origin.via,
      }
    }
  }
  const networkOrigins: QosPlan['networkOrigins'] = {}
  for (const section of networkSections) {
    const origin = networkOrigin.get(section.name)
    if (origin) {
      networkOrigins[section.name] = {
        assignmentId: origin.assignmentId,
        policyId: origin.policyId,
      }
    }
  }
  return {
    sections,
    devices,
    origins,
    networkOrigins,
    issues,
    activeSchedules,
    nextChangeAt: next === null ? null : new Date(next).toISOString(),
    fingerprints: { config: sha256(sections), devices: devicesFingerprint(devices) },
  }
}

/**
 * The bucket tree's rules over every policy of a gateway, referenced or not
 * (`planQos` only checks the buckets it renders): the write endpoints refuse
 * a change that adds one of these errors (amendment section 5).
 *
 * - `qos_parent_missing`, `qos_parent_cycle`, `qos_parent_not_bucket`
 *   (the parent has no shared bucket), `qos_child_not_bucket` (only a
 *   policy with a shared bucket can nest), `qos_child_exceeds_parent`,
 *   `qos_bucket_too_deep` (depth > `maxDepth`), and on the parent
 *   `qos_children_exceed_parent` (its enabled children's rates add up to
 *   more than its own: HTB's guarantee).
 * - Warning `qos_parent_disabled`.
 */
export function checkPolicyTree(policies: PlanPolicy[], maxDepth: number): PlanIssue[] {
  const limit = Math.min(MAX_BUCKET_DEPTH, Math.max(1, maxDepth))
  const byId = new Map(policies.map((p) => [p.id, p]))
  const issues: PlanIssue[] = []
  const refuse = (policyId: number, code: string, message: string) =>
    issues.push({ severity: 'error', code, message, policyId })

  const depth = (policy: PlanPolicy): number | null => {
    const seen = new Set<number>([policy.id])
    let levels = 1
    let cursor = policy.parentId
    while (cursor !== null) {
      if (seen.has(cursor)) return null
      seen.add(cursor)
      const parent = byId.get(cursor)
      if (!parent) return levels
      levels++
      cursor = parent.parentId
    }
    return levels
  }

  for (const policy of [...policies].sort((a, b) => a.id - b.id)) {
    if (policy.parentId === null) continue
    const parent = byId.get(policy.parentId)
    if (!parent) {
      refuse(policy.id, 'qos_parent_missing', `Parent policy ${policy.parentId} does not exist.`)
      continue
    }
    const levels = depth(policy)
    if (levels === null) {
      refuse(policy.id, 'qos_parent_cycle', `Policy ${policy.id}: its parents form a cycle.`)
      continue
    }
    if (!policy.shared) {
      refuse(
        policy.id,
        'qos_child_not_bucket',
        'Only a policy with a shared bucket can sit inside another bucket.'
      )
      continue
    }
    if (!parent.shared) {
      refuse(
        policy.id,
        'qos_parent_not_bucket',
        `Parent policy ${parent.id} has no shared bucket to nest in.`
      )
      continue
    }
    if (exceeds(policy.shared, parent.shared)) {
      refuse(
        policy.id,
        'qos_child_exceeds_parent',
        `Policy ${policy.id}: its bucket allows more than its parent's.`
      )
    }
    if (levels > limit) {
      refuse(
        policy.id,
        'qos_bucket_too_deep',
        `Policy ${policy.id}: nesting ${levels} deep, the limit is ${limit}.`
      )
    }
    if (!parent.enabled) {
      issues.push({
        severity: 'warning',
        code: 'qos_parent_disabled',
        message: `Policy ${policy.id}: parent policy ${parent.id} is disabled; its bucket stands alone.`,
        policyId: policy.id,
      })
    }
  }

  for (const parent of policies) {
    if (!parent.shared) continue
    const children = policies.filter((c) => c.parentId === parent.id && c.enabled && c.shared)
    if (children.length === 0) continue
    const over = (pick: (r: PlanRate) => number) => {
      const own = pick(parent.shared!)
      if (own === 0) return false
      let sum = 0
      for (const child of children) {
        const value = pick(child.shared!)
        if (value === 0) return true
        sum += value
      }
      return sum > own
    }
    if (over((r) => r.downKbit) || over((r) => r.upKbit)) {
      refuse(
        parent.id,
        'qos_children_exceed_parent',
        `Policy ${parent.id}: its nested buckets add up to more than its own rate.`
      )
    }
  }
  return issues
}
