import Gateway from '#models/gateway'
import QosAssignment from '#models/qos_assignment'
import QosGroup from '#models/qos_group'
import QosGroupMember from '#models/qos_group_member'
import QosPolicy from '#models/qos_policy'
import QosSchedule from '#models/qos_schedule'
import { isDuplicateEntryError } from '#services/db_errors'
import {
  qosRefusal,
  type QosError,
  requireManaged,
  resolveGateway,
  type GatewayRef,
} from '#services/qos_gateway'
import {
  allocateClassMinor,
  checkPolicyTree,
  planQos,
  PLAN_DAY_NAMES,
  type PlanIssue,
} from '#services/qos_plan'
import {
  listAssignments,
  listGroups,
  listPolicies,
  listSchedules,
  loadPlanInput,
  type QosRate,
} from '#services/qos_reads'
import { getQosSettings, type QosSettings } from '#services/qos_settings'
import { invalidateQosPlanCache } from '#services/qos_plan_cache'
import { requestQosSync, stateRow } from '#services/qos_sync'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * Admin writes of policies, groups, assignments and schedules
 * (docs/gateway/qos.md section 5.2; plan 3 section 5, WP-C). Every write:
 *
 * 1. resolves the gateway (404 / 409 / 422 as the reads) and requires
 *    managed mode (409 `qos_not_managed`);
 * 2. checks the fields (422 `qos_rate_below_floor`, `qos_each_exceeds_shared`,
 *    `qos_policy_empty`, …) and the targets (404 `qos_not_found`, 409
 *    `qos_mac_assigned`, `qos_target_assigned`, `qos_mac_in_group`);
 * 3. applies the change in a transaction, re-plans the gateway inside it and
 *    rolls back when the change adds a planner or bucket-tree error (422 with
 *    the issue's code and `issues`; errors that were already there before do
 *    not block unrelated edits);
 * 4. after the commit, asks the sender (`qos_sync.ts`) to deliver: device
 *    entries go out 1 s later, the `perch-qos` package after
 *    `applyDebounceSeconds`. Writes succeed while the gateway is offline.
 *
 * The same functions back the portal's in-process API (`qos_shaping.ts`),
 * which passes `source: 'portal'`.
 */

type Trx = TransactionClientContract

export interface WriteContext {
  userId: number | null
  source?: 'admin' | 'portal'
  sourceRef?: string | null
}

/** Planner codes that are conflicts (409) rather than bad input (422). */
const CONFLICT_CODES = new Set(['qos_mac_assigned', 'qos_target_assigned', 'qos_mac_in_group'])

function issueKey(issue: PlanIssue): string {
  return [
    issue.code,
    issue.policyId ?? '',
    issue.assignmentId ?? '',
    issue.scheduleId ?? '',
    issue.mac ?? '',
    issue.network ?? '',
  ].join('|')
}

async function gatewayIssues(
  gatewayId: number,
  trx: Trx,
  settings: QosSettings
): Promise<PlanIssue[]> {
  const input = await loadPlanInput(gatewayId, new Date(), trx)
  return [
    ...planQos(input).issues,
    ...checkPolicyTree(input.policies, settings.maxBucketDepth),
  ].filter((issue) => issue.severity === 'error')
}

/**
 * Runs `change` in a transaction and refuses it (rolling back) when it adds a
 * planner error. Afterwards the gateway is re-planned and delivered.
 */
async function mutate<T>(
  gatewayId: number,
  userId: number | null,
  change: (trx: Trx) => Promise<T>
): Promise<T> {
  const settings = await getQosSettings()
  let result: T
  try {
    result = await db.transaction(async (trx) => {
      const initial = await gatewayIssues(gatewayId, trx, settings)
      const before = new Set(initial.map(issueKey))
      const value = await change(trx)
      const after = await gatewayIssues(gatewayId, trx, settings)
      const fresh = after.filter((issue) => !before.has(issueKey(issue)))
      if (fresh.length > 0) {
        const first = fresh[0]
        throw qosRefusal(CONFLICT_CODES.has(first.code) ? 409 : 422, first.code, first.message, {
          issues: fresh,
        })
      }
      return value
    })
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      throw qosRefusal(
        409,
        'qos_conflict',
        'Another change got there first (a name, MAC or target is already taken). Reload and retry.'
      )
    }
    throw error
  }
  invalidateQosPlanCache(gatewayId)
  requestQosSync(gatewayId, { userId })
  return result
}

async function managedGateway(ref: GatewayRef): Promise<Gateway> {
  const { gateway } = await resolveGateway(ref)
  requireManaged(gateway)
  return gateway
}

async function gatewayOf(gatewayId: number): Promise<Gateway> {
  const gateway = await Gateway.find(gatewayId)
  if (!gateway) {
    throw qosRefusal(404, 'gateway_not_found', `There is no gateway ${gatewayId}.`, { gatewayId })
  }
  requireManaged(gateway)
  return gateway
}

function notFound(resource: string, id: number): QosError {
  return qosRefusal(404, 'qos_not_found', `There is no ${resource} ${id}.`, { resource, id })
}

// ---------------------------------------------------------------------------
// Rates

/** `QosRate` → columns (null / 0 = unlimited → 0); `null` = no such part; undefined = unchanged. */
function rateColumns(rate: QosRate | null | undefined) {
  if (rate === undefined) return undefined
  if (rate === null) return { down: null, up: null }
  return { down: rate.downloadKbit ?? 0, up: rate.uploadKbit ?? 0 }
}

type OverrideInput = { downloadKbit?: number | null; uploadKbit?: number | null } | null | undefined

/** A schedule override → columns (null = keep); `null` = no override; undefined = unchanged. */
function overrideColumns(rate: OverrideInput) {
  if (rate === undefined) return undefined
  if (rate === null) return { down: null, up: null }
  return { down: rate.downloadKbit ?? null, up: rate.uploadKbit ?? null }
}

function requireFloor(
  field: string,
  columns: { down: number | null; up: number | null } | undefined,
  min: number
) {
  if (!columns) return
  for (const [direction, value] of [
    ['downloadKbit', columns.down],
    ['uploadKbit', columns.up],
  ] as const) {
    if (value !== null && value !== 0 && value < min) {
      throw qosRefusal(
        422,
        'qos_rate_below_floor',
        `${field}.${direction} must be unlimited or at least ${min} kbit/s.`,
        { field: `${field}.${direction}`, min }
      )
    }
  }
}

/**
 * Per direction: a per-device cap above the shared bucket (0 = unlimited:
 * no per-device cap that way is fine, the bucket still holds it).
 */
function exceeds(
  each: { down: number | null; up: number | null },
  shared: { down: number | null; up: number | null }
): boolean {
  const over = (e: number, s: number) => s > 0 && e > s
  return over(each.down ?? 0, shared.down ?? 0) || over(each.up ?? 0, shared.up ?? 0)
}

function hasRate(columns: { down: number | null; up: number | null } | null | undefined) {
  return Boolean(columns) && (columns!.down !== null || columns!.up !== null)
}

function parseExpiry(value: string | null | undefined, now: DateTime): DateTime | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const parsed = DateTime.fromISO(value, { setZone: true })
  if (!parsed.isValid || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw qosRefusal(
      422,
      'qos_invalid_date',
      'expiresAt must be an ISO 8601 time with an offset.',
      {
        field: 'expiresAt',
      }
    )
  }
  if (parsed.toMillis() <= now.toMillis()) {
    throw qosRefusal(422, 'qos_expiry_past', 'expiresAt must be in the future.', {
      field: 'expiresAt',
    })
  }
  return parsed.toUTC()
}

// ---------------------------------------------------------------------------
// Policies

export interface PolicyInput {
  name?: string
  notes?: string | null
  shared?: QosRate | null
  each?: QosRate | null
  fairness?: 'per_host' | 'per_flow'
  includeLan?: boolean
  parentPolicyId?: number | null
  enabled?: boolean
}

async function requirePolicyName(gatewayId: number, name: string, selfId: number | null) {
  const clash = await QosPolicy.query()
    .where('gatewayId', gatewayId)
    .where('name', name)
    .if(selfId !== null, (q) => q.whereNot('id', selfId!))
    .first()
  if (clash) {
    throw qosRefusal(409, 'qos_name_taken', `A policy is already called "${name}".`, {
      field: 'name',
      id: clash.id,
    })
  }
}

async function checkPolicyFields(
  gatewayId: number,
  selfId: number | null,
  merged: {
    shared: { down: number | null; up: number | null }
    each: { down: number | null; up: number | null }
    parentPolicyId: number | null
  },
  settings: QosSettings
) {
  requireFloor('shared', merged.shared, settings.minDeviceKbit)
  requireFloor('each', merged.each, settings.minDeviceKbit)
  const shared = hasRate(merged.shared)
  const each = hasRate(merged.each)
  if (!shared && !each) {
    throw qosRefusal(
      422,
      'qos_policy_empty',
      'A policy needs a shared bucket, a per-device cap, or both.'
    )
  }
  if (shared && each && exceeds(merged.each, merged.shared)) {
    throw qosRefusal(
      422,
      'qos_each_exceeds_shared',
      'The per-device cap is above the shared bucket; lower it or raise the bucket.'
    )
  }
  if (merged.parentPolicyId !== null) {
    if (merged.parentPolicyId === selfId) {
      throw qosRefusal(422, 'qos_parent_cycle', 'A policy cannot sit inside itself.')
    }
    const parent = await QosPolicy.find(merged.parentPolicyId)
    if (!parent || parent.gatewayId !== gatewayId) throw notFound('policy', merged.parentPolicyId)
  }
}

export async function createPolicy(
  ref: GatewayRef,
  input: PolicyInput & { name: string },
  context: WriteContext
) {
  const gateway = await managedGateway(ref)
  const settings = await getQosSettings()
  const shared = rateColumns(input.shared ?? null)!
  const each = rateColumns(input.each ?? null)!
  await requirePolicyName(gateway.id, input.name, null)
  await checkPolicyFields(
    gateway.id,
    null,
    { shared, each, parentPolicyId: input.parentPolicyId ?? null },
    settings
  )
  const id = await mutate(gateway.id, context.userId, async (trx) => {
    const used = await QosPolicy.query({ client: trx })
      .where('gatewayId', gateway.id)
      .forUpdate()
      .select('classMinor')
    const minor = allocateClassMinor(used.map((p) => p.classMinor))
    if (minor === null) {
      throw qosRefusal(
        409,
        'qos_class_exhausted',
        'This gateway has 254 policies, the most its shaper can hold.'
      )
    }
    const policy = await QosPolicy.create(
      {
        gatewayId: gateway.id,
        name: input.name,
        notes: input.notes ?? null,
        sharedDownKbit: shared.down,
        sharedUpKbit: shared.up,
        eachDownKbit: each.down,
        eachUpKbit: each.up,
        fairness: input.fairness ?? 'per_host',
        includeLan: input.includeLan ?? false,
        parentPolicyId: input.parentPolicyId ?? null,
        enabled: input.enabled ?? true,
        source: context.source ?? 'admin',
        sourceRef: context.sourceRef ?? null,
        classMinor: minor,
        createdByUserId: context.userId,
      },
      { client: trx }
    )
    return policy.id
  })
  return policyView(gateway.id, id)
}

export async function updatePolicy(id: number, input: PolicyInput, context: WriteContext) {
  const policy = await QosPolicy.find(id)
  if (!policy) throw notFound('policy', id)
  const gateway = await gatewayOf(policy.gatewayId)
  const settings = await getQosSettings()
  const shared = rateColumns(input.shared) ?? {
    down: policy.sharedDownKbit,
    up: policy.sharedUpKbit,
  }
  const each = rateColumns(input.each) ?? { down: policy.eachDownKbit, up: policy.eachUpKbit }
  const parentPolicyId =
    input.parentPolicyId === undefined ? policy.parentPolicyId : input.parentPolicyId
  if (input.name !== undefined) await requirePolicyName(gateway.id, input.name, policy.id)
  await checkPolicyFields(gateway.id, policy.id, { shared, each, parentPolicyId }, settings)
  await mutate(gateway.id, context.userId, async (trx) => {
    policy.useTransaction(trx)
    policy.merge({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      sharedDownKbit: shared.down,
      sharedUpKbit: shared.up,
      eachDownKbit: each.down,
      eachUpKbit: each.up,
      ...(input.fairness !== undefined ? { fairness: input.fairness } : {}),
      ...(input.includeLan !== undefined ? { includeLan: input.includeLan } : {}),
      parentPolicyId,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    })
    await policy.save()
  })
  return policyView(gateway.id, policy.id)
}

/**
 * 409 `qos_policy_in_use` while assignments use it, buckets nest in it, or a
 * schedule moves devices into it (those would vanish or change silently).
 */
export async function deletePolicy(id: number, context: WriteContext) {
  const policy = await QosPolicy.find(id)
  if (!policy) throw notFound('policy', id)
  const gateway = await gatewayOf(policy.gatewayId)
  const [assignments, children, schedules] = await Promise.all([
    QosAssignment.query().where('policyId', id).select('id'),
    QosPolicy.query().where('parentPolicyId', id).select('id'),
    QosSchedule.query().where('usePolicyId', id).select('id'),
  ])
  if (assignments.length + children.length + schedules.length > 0) {
    throw qosRefusal(
      409,
      'qos_policy_in_use',
      'Remove its assignments, nested buckets and the schedules that move devices into it first.',
      {
        assignmentIds: assignments.map((a) => a.id),
        childPolicyIds: children.map((c) => c.id),
        scheduleIds: schedules.map((s) => s.id),
      }
    )
  }
  await mutate(gateway.id, context.userId, async (trx) => {
    policy.useTransaction(trx)
    await policy.delete()
  })
}

async function policyView(gatewayId: number, id: number) {
  const views = await listPolicies({ gatewayId })
  const view = views.find((p) => p.id === id)
  if (!view) throw notFound('policy', id)
  return view
}

// ---------------------------------------------------------------------------
// Groups

async function requireGroupName(gatewayId: number, name: string, selfId: number | null) {
  const clash = await QosGroup.query()
    .where('gatewayId', gatewayId)
    .where('name', name)
    .if(selfId !== null, (q) => q.whereNot('id', selfId!))
    .first()
  if (clash) {
    throw qosRefusal(409, 'qos_name_taken', `A group is already called "${name}".`, {
      field: 'name',
      id: clash.id,
    })
  }
}

/** 409 `qos_mac_in_group` when a MAC is already in another group of the gateway. */
async function requireMacsFree(gatewayId: number, macs: string[], selfId: number | null) {
  if (macs.length === 0) return
  const taken = await QosGroupMember.query()
    .where('gatewayId', gatewayId)
    .whereIn('mac', macs)
    .if(selfId !== null, (q) => q.whereNot('groupId', selfId!))
    .first()
  if (taken) {
    throw qosRefusal(
      409,
      'qos_mac_in_group',
      `${taken.mac} is already in another group; a device is in one group at most.`,
      { mac: taken.mac, groupId: taken.groupId }
    )
  }
}

export async function createGroup(
  ref: GatewayRef,
  input: { name: string; notes?: string | null; members?: string[] },
  context: WriteContext
) {
  const gateway = await managedGateway(ref)
  const members = [...new Set(input.members ?? [])].sort()
  await requireGroupName(gateway.id, input.name, null)
  await requireMacsFree(gateway.id, members, null)
  const id = await mutate(gateway.id, context.userId, async (trx) => {
    const group = await QosGroup.create(
      { gatewayId: gateway.id, name: input.name, notes: input.notes ?? null },
      { client: trx }
    )
    if (members.length > 0) {
      await QosGroupMember.createMany(
        members.map((mac) => ({ gatewayId: gateway.id, groupId: group.id, mac })),
        { client: trx }
      )
    }
    return group.id
  })
  return groupView(gateway.id, id)
}

export async function updateGroup(
  id: number,
  input: { name?: string; notes?: string | null; addMacs?: string[]; removeMacs?: string[] },
  context: WriteContext
) {
  const group = await QosGroup.find(id)
  if (!group) throw notFound('group', id)
  const gateway = await gatewayOf(group.gatewayId)
  const remove = new Set(input.removeMacs ?? [])
  const add = [...new Set(input.addMacs ?? [])].filter((mac) => !remove.has(mac)).sort()
  if (input.name !== undefined) await requireGroupName(gateway.id, input.name, group.id)
  await requireMacsFree(gateway.id, add, group.id)
  await mutate(gateway.id, context.userId, async (trx) => {
    group.useTransaction(trx)
    if (input.name !== undefined) group.name = input.name
    if (input.notes !== undefined) group.notes = input.notes
    // Touch the row so updatedAt follows membership changes too.
    group.updatedAt = DateTime.utc()
    await group.save()
    if (remove.size > 0) {
      await QosGroupMember.query({ client: trx })
        .where('groupId', group.id)
        .whereIn('mac', [...remove])
        .delete()
    }
    if (add.length > 0) {
      const current = await QosGroupMember.query({ client: trx })
        .where('groupId', group.id)
        .select('mac')
      const existing = new Set(current.map((m) => m.mac))
      const fresh = add.filter((mac) => !existing.has(mac))
      if (fresh.length > 0) {
        await QosGroupMember.createMany(
          fresh.map((mac) => ({ gatewayId: gateway.id, groupId: group.id, mac })),
          { client: trx }
        )
      }
    }
  })
  return groupView(gateway.id, group.id)
}

/** Its assignment (and that assignment's schedules) cascade. */
export async function deleteGroup(id: number, context: WriteContext) {
  const group = await QosGroup.find(id)
  if (!group) throw notFound('group', id)
  const gateway = await gatewayOf(group.gatewayId)
  await mutate(gateway.id, context.userId, async (trx) => {
    group.useTransaction(trx)
    await group.delete()
  })
}

async function groupView(gatewayId: number, id: number) {
  const views = await listGroups({ gatewayId })
  const view = views.find((g) => g.id === id)
  if (!view) throw notFound('group', id)
  return view
}

// ---------------------------------------------------------------------------
// Assignments

export type AssignmentTargetInput =
  | { type: 'device'; mac?: string; groupId?: number; network?: string }
  | { type: 'group'; mac?: string; groupId?: number; network?: string }
  | { type: 'network'; mac?: string; groupId?: number; network?: string }

export interface QuotaInput {
  limitBytes: number
  onExhausted: 'block' | 'throttle'
  throttle?: QosRate | null
}

export interface AssignmentInput {
  policyId?: number | null
  rate?: QosRate | null
  quota?: QuotaInput | null
  expiresAt?: string | null
}

/** The one field a target type needs (422 `qos_target_invalid` otherwise). */
function targetOf(target: AssignmentTargetInput) {
  const refuse = (field: string) =>
    qosRefusal(422, 'qos_target_invalid', `A ${target.type} target needs ${field} (only).`, {
      field: `target.${field}`,
    })
  const extras = [target.mac, target.groupId, target.network].filter((v) => v !== undefined)
  if (target.type === 'device') {
    if (!target.mac || extras.length !== 1) throw refuse('mac')
    return { type: 'device' as const, mac: target.mac }
  }
  if (target.type === 'group') {
    if (target.groupId === undefined || extras.length !== 1) throw refuse('groupId')
    return { type: 'group' as const, groupId: target.groupId }
  }
  if (!target.network || extras.length !== 1) throw refuse('network')
  return { type: 'network' as const, network: target.network }
}

async function requirePolicyOf(gatewayId: number, policyId: number | null | undefined) {
  if (policyId === null || policyId === undefined) return null
  const policy = await QosPolicy.find(policyId)
  if (!policy || policy.gatewayId !== gatewayId) throw notFound('policy', policyId)
  return policy
}

function quotaColumns(quota: QuotaInput | null | undefined, settings: QosSettings) {
  if (quota === undefined) return undefined
  if (quota === null) {
    return {
      quotaBytes: null,
      quotaOnExhausted: null,
      throttleDownKbit: null,
      throttleUpKbit: null,
    }
  }
  const throttle = rateColumns(quota.throttle ?? null)!
  if (quota.onExhausted === 'throttle' && !hasRate(throttle)) {
    throw qosRefusal(
      422,
      'qos_throttle_required',
      'A quota that throttles when used up needs the throttle rate.',
      { field: 'quota.throttle' }
    )
  }
  if (quota.onExhausted === 'block' && hasRate(throttle)) {
    throw qosRefusal(
      422,
      'qos_field_not_applicable',
      'A quota that blocks when used up has no throttle rate.',
      { field: 'quota.throttle' }
    )
  }
  requireFloor('quota.throttle', throttle, settings.minDeviceKbit)
  return {
    quotaBytes: quota.limitBytes,
    quotaOnExhausted: quota.onExhausted,
    throttleDownKbit: throttle.down,
    throttleUpKbit: throttle.up,
  }
}

/** 409 `qos_mac_assigned` / `qos_target_assigned` when the target already has an assignment. */
async function requireTargetFree(
  gatewayId: number,
  target: ReturnType<typeof targetOf>,
  selfId: number | null
) {
  const query = QosAssignment.query().where('gatewayId', gatewayId)
  if (selfId !== null) query.whereNot('id', selfId)
  if (target.type === 'device') query.where('mac', target.mac)
  else if (target.type === 'group') query.where('groupId', target.groupId)
  else query.where('network', target.network)
  const existing = await query.first()
  if (!existing) return
  if (target.type === 'device') {
    throw qosRefusal(409, 'qos_mac_assigned', `${target.mac} already has an assignment.`, {
      assignmentId: existing.id,
      source: existing.source,
    })
  }
  throw qosRefusal(409, 'qos_target_assigned', 'That target already has an assignment.', {
    assignmentId: existing.id,
    source: existing.source,
  })
}

export async function createAssignment(
  ref: GatewayRef,
  input: AssignmentInput & { target: AssignmentTargetInput },
  context: WriteContext
) {
  const gateway = await managedGateway(ref)
  const settings = await getQosSettings()
  const target = targetOf(input.target)
  const now = DateTime.utc()
  const policy = await requirePolicyOf(gateway.id, input.policyId)
  if (target.type === 'group') {
    const group = await QosGroup.find(target.groupId)
    if (!group || group.gatewayId !== gateway.id) throw notFound('group', target.groupId)
  }
  const rate = rateColumns(input.rate ?? null)!
  requireFloor('rate', rate, settings.minDeviceKbit)
  const quota = quotaColumns(input.quota ?? null, settings)!
  if (quota.quotaBytes !== null && target.type !== 'device') {
    throw qosRefusal(422, 'qos_quota_needs_device', 'Quotas apply to single devices only.', {
      field: 'quota',
    })
  }
  if (!policy && !hasRate(rate) && quota.quotaBytes === null) {
    throw qosRefusal(
      422,
      'qos_policy_empty',
      'An assignment needs a policy, its own rate or a quota.'
    )
  }
  const expiresAt = parseExpiry(input.expiresAt ?? null, now) ?? null
  await requireTargetFree(gateway.id, target, null)
  const id = await mutate(gateway.id, context.userId, async (trx) => {
    const row = await QosAssignment.create(
      {
        gatewayId: gateway.id,
        policyId: policy?.id ?? null,
        targetType: target.type,
        mac: target.type === 'device' ? target.mac : null,
        groupId: target.type === 'group' ? target.groupId : null,
        network: target.type === 'network' ? target.network : null,
        downKbit: rate.down,
        upKbit: rate.up,
        ...quota,
        quotaUsedBytes: 0,
        expiresAt,
        source: context.source ?? 'admin',
        sourceRef: context.sourceRef ?? null,
        createdByUserId: context.userId,
      },
      { client: trx }
    )
    return row.id
  })
  return assignmentView(gateway.id, id)
}

export async function updateAssignment(
  id: number,
  input: AssignmentInput,
  context: WriteContext & { target?: AssignmentTargetInput }
) {
  const row = await QosAssignment.find(id)
  if (!row) throw notFound('assignment', id)
  const gateway = await gatewayOf(row.gatewayId)
  const settings = await getQosSettings()
  const now = DateTime.utc()
  const policy =
    input.policyId === undefined
      ? row.policyId === null
        ? null
        : await QosPolicy.find(row.policyId)
      : await requirePolicyOf(gateway.id, input.policyId)
  const rate = rateColumns(input.rate) ?? { down: row.downKbit, up: row.upKbit }
  if (input.rate !== undefined) requireFloor('rate', rate, settings.minDeviceKbit)
  const quota = quotaColumns(input.quota, settings)
  let target: ReturnType<typeof targetOf> | null = null
  if (context.target) {
    // The portal moves a voucher to a new MAC (owner decision 23).
    target = targetOf(context.target)
    if (target.type !== row.targetType) {
      throw qosRefusal(422, 'qos_field_not_applicable', 'The target type cannot change.', {
        field: 'target',
      })
    }
    await requireTargetFree(gateway.id, target, row.id)
  }
  const quotaBytes = quota ? quota.quotaBytes : row.quotaBytes
  if (!policy && !hasRate(rate) && quotaBytes === null) {
    throw qosRefusal(
      422,
      'qos_policy_empty',
      'An assignment needs a policy, its own rate or a quota.'
    )
  }
  const expiresAt = parseExpiry(input.expiresAt, now)
  await mutate(gateway.id, context.userId, async (trx) => {
    row.useTransaction(trx)
    if (input.policyId !== undefined) row.policyId = input.policyId
    row.downKbit = rate.down
    row.upKbit = rate.up
    if (quota) {
      const limitChanged =
        quota.quotaBytes === null || Number(row.quotaBytes ?? -1) !== quota.quotaBytes
      row.merge(quota)
      if (quota.quotaBytes === null) {
        row.quotaUsedBytes = 0
        row.exhaustedAt = null
        row.quotaResetAt = null
      } else if (limitChanged && row.exhaustedAt && Number(row.quotaUsedBytes) < quota.quotaBytes) {
        // A raised limit lifts the exhaustion; the router's next report confirms it.
        row.exhaustedAt = null
      }
    }
    if (expiresAt !== undefined) row.expiresAt = expiresAt
    if (target?.type === 'device' && target.mac !== row.mac) {
      // The grant moves to a new MAC; its quota usage moves with it.
      row.mac = target.mac
    }
    await row.save()
  })
  return assignmentView(gateway.id, row.id)
}

/** Deletes an assignment (its schedules cascade). */
export async function deleteAssignment(id: number, context: WriteContext) {
  const row = await QosAssignment.find(id)
  if (!row) throw notFound('assignment', id)
  const gateway = await gatewayOf(row.gatewayId)
  await mutate(gateway.id, context.userId, async (trx) => {
    row.useTransaction(trx)
    await row.delete()
  })
}

/** POST /qos/assignments/:id/quota/reset: usage back to 0, exhaustion lifted. */
export async function resetAssignmentQuota(id: number, context: WriteContext) {
  const row = await QosAssignment.find(id)
  if (!row) throw notFound('assignment', id)
  const gateway = await gatewayOf(row.gatewayId)
  if (row.quotaBytes === null) {
    throw qosRefusal(422, 'qos_no_quota', 'This assignment has no quota to reset.')
  }
  await mutate(gateway.id, context.userId, async (trx) => {
    row.useTransaction(trx)
    row.quotaUsedBytes = 0
    row.exhaustedAt = null
    row.quotaResetAt = DateTime.utc()
    await row.save()
  })
  return assignmentView(gateway.id, row.id)
}

export async function assignmentView(gatewayId: number, id: number) {
  const views = await listAssignments({ gatewayId })
  const view = views.find((a) => a.id === id)
  if (!view) throw notFound('assignment', id)
  return view
}

// ---------------------------------------------------------------------------
// Schedules

type ScheduleAction = 'limit' | 'unlimited' | 'block' | 'policy'

export interface ScheduleInput {
  name?: string
  enabled?: boolean
  action?: ScheduleAction
  usePolicyId?: number | null
  shared?: OverrideInput
  each?: OverrideInput
  rate?: OverrideInput
  days?: Array<(typeof PLAN_DAY_NAMES)[number]>
  startMinute?: number
  endMinute?: number
}

function dayMask(days: Array<(typeof PLAN_DAY_NAMES)[number]>): number {
  return days.reduce((mask, day) => mask | (1 << PLAN_DAY_NAMES.indexOf(day)), 0)
}

interface ScheduleShape {
  targetType: 'policy' | 'assignment'
  action: ScheduleAction
  usePolicyId: number | null
  shared: { down: number | null; up: number | null }
  each: { down: number | null; up: number | null }
  rate: { down: number | null; up: number | null }
  targetAssignment: QosAssignment | null
}

async function checkSchedule(gatewayId: number, shape: ScheduleShape, settings: QosSettings) {
  const unsupported = (message: string) =>
    qosRefusal(422, 'qos_schedule_unsupported', message, { field: 'action' })
  const notApplicable = (field: string, message: string) =>
    qosRefusal(422, 'qos_field_not_applicable', message, { field })
  if (shape.targetType === 'policy') {
    if (shape.action !== 'limit' && shape.action !== 'unlimited') {
      throw unsupported(`"${shape.action}" does not apply to a policy (limit or unlimited).`)
    }
    if (hasRate(shape.rate)) {
      throw notApplicable('rate', 'A policy schedule changes `shared` and `each`, not `rate`.')
    }
  } else {
    if (hasRate(shape.shared) || hasRate(shape.each)) {
      throw notApplicable(
        hasRate(shape.shared) ? 'shared' : 'each',
        'An assignment schedule changes `rate`, not `shared` or `each`.'
      )
    }
    if (shape.action === 'block' && shape.targetAssignment?.targetType === 'network') {
      throw unsupported('A network default cannot be blocked.')
    }
  }
  if (shape.action === 'policy') {
    if (shape.usePolicyId === null) {
      throw qosRefusal(
        422,
        'qos_schedule_policy_missing',
        'A "policy" schedule names the policy to use (usePolicyId).',
        { field: 'usePolicyId' }
      )
    }
    const alt = await QosPolicy.find(shape.usePolicyId)
    if (!alt || alt.gatewayId !== gatewayId) throw notFound('policy', shape.usePolicyId)
  } else if (shape.usePolicyId !== null) {
    throw notApplicable('usePolicyId', 'Only a "policy" schedule names another policy.')
  }
  if (shape.action === 'limit') {
    if (!hasRate(shape.shared) && !hasRate(shape.each) && !hasRate(shape.rate)) {
      throw qosRefusal(
        422,
        'qos_schedule_empty',
        'A "limit" schedule needs the rates it applies.',
        {
          field: shape.targetType === 'policy' ? 'shared' : 'rate',
        }
      )
    }
  } else if (hasRate(shape.shared) || hasRate(shape.each) || hasRate(shape.rate)) {
    throw notApplicable('rate', `A "${shape.action}" schedule carries no rates.`)
  }
  requireFloor('shared', shape.shared, settings.minDeviceKbit)
  requireFloor('each', shape.each, settings.minDeviceKbit)
  requireFloor('rate', shape.rate, settings.minDeviceKbit)
}

export async function createSchedule(
  ref: GatewayRef,
  input: ScheduleInput & {
    name: string
    action: ScheduleAction
    target: { type: 'policy' | 'assignment'; policyId?: number; assignmentId?: number }
    days: Array<(typeof PLAN_DAY_NAMES)[number]>
    startMinute: number
    endMinute: number
  },
  context: WriteContext
) {
  const gateway = await managedGateway(ref)
  const settings = await getQosSettings()
  let targetAssignment: QosAssignment | null = null
  if (input.target.type === 'policy') {
    if (input.target.policyId === undefined || input.target.assignmentId !== undefined) {
      throw qosRefusal(422, 'qos_target_invalid', 'A policy target needs policyId (only).', {
        field: 'target.policyId',
      })
    }
    await requirePolicyOf(gateway.id, input.target.policyId)
  } else {
    if (input.target.assignmentId === undefined || input.target.policyId !== undefined) {
      throw qosRefusal(
        422,
        'qos_target_invalid',
        'An assignment target needs assignmentId (only).',
        { field: 'target.assignmentId' }
      )
    }
    targetAssignment = await QosAssignment.find(input.target.assignmentId)
    if (!targetAssignment || targetAssignment.gatewayId !== gateway.id) {
      throw notFound('assignment', input.target.assignmentId)
    }
  }
  const shape: ScheduleShape = {
    targetType: input.target.type,
    action: input.action,
    usePolicyId: input.usePolicyId ?? null,
    shared: overrideColumns(input.shared ?? null)!,
    each: overrideColumns(input.each ?? null)!,
    rate: overrideColumns(input.rate ?? null)!,
    targetAssignment,
  }
  await checkSchedule(gateway.id, shape, settings)
  const id = await mutate(gateway.id, context.userId, async (trx) => {
    const row = await QosSchedule.create(
      {
        gatewayId: gateway.id,
        name: input.name,
        enabled: input.enabled ?? true,
        targetType: input.target.type,
        policyId: input.target.type === 'policy' ? input.target.policyId! : null,
        assignmentId: input.target.type === 'assignment' ? input.target.assignmentId! : null,
        action: input.action,
        usePolicyId: shape.usePolicyId,
        sharedDownKbit: shape.shared.down,
        sharedUpKbit: shape.shared.up,
        eachDownKbit: shape.each.down,
        eachUpKbit: shape.each.up,
        rateDownKbit: shape.rate.down,
        rateUpKbit: shape.rate.up,
        days: dayMask(input.days),
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        createdByUserId: context.userId,
      },
      { client: trx }
    )
    return row.id
  })
  return scheduleView(gateway.id, id)
}

export async function updateSchedule(id: number, input: ScheduleInput, context: WriteContext) {
  const row = await QosSchedule.find(id)
  if (!row) throw notFound('schedule', id)
  const gateway = await gatewayOf(row.gatewayId)
  const settings = await getQosSettings()
  const targetAssignment =
    row.targetType === 'assignment' && row.assignmentId !== null
      ? await QosAssignment.find(row.assignmentId)
      : null
  const action = (input.action ?? row.action) as ScheduleAction
  // Rates that no longer apply to a new action are dropped with it.
  const keepRates = input.action === undefined || input.action === 'limit'
  const shape: ScheduleShape = {
    targetType: row.targetType === 'assignment' ? 'assignment' : 'policy',
    action,
    usePolicyId:
      input.usePolicyId !== undefined
        ? input.usePolicyId
        : action === 'policy'
          ? row.usePolicyId
          : null,
    shared:
      overrideColumns(input.shared) ??
      (keepRates ? { down: row.sharedDownKbit, up: row.sharedUpKbit } : { down: null, up: null }),
    each:
      overrideColumns(input.each) ??
      (keepRates ? { down: row.eachDownKbit, up: row.eachUpKbit } : { down: null, up: null }),
    rate:
      overrideColumns(input.rate) ??
      (keepRates ? { down: row.rateDownKbit, up: row.rateUpKbit } : { down: null, up: null }),
    targetAssignment,
  }
  await checkSchedule(gateway.id, shape, settings)
  await mutate(gateway.id, context.userId, async (trx) => {
    row.useTransaction(trx)
    row.merge({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      action,
      usePolicyId: shape.usePolicyId,
      sharedDownKbit: shape.shared.down,
      sharedUpKbit: shape.shared.up,
      eachDownKbit: shape.each.down,
      eachUpKbit: shape.each.up,
      rateDownKbit: shape.rate.down,
      rateUpKbit: shape.rate.up,
      ...(input.days !== undefined ? { days: dayMask(input.days) } : {}),
      ...(input.startMinute !== undefined ? { startMinute: input.startMinute } : {}),
      ...(input.endMinute !== undefined ? { endMinute: input.endMinute } : {}),
    })
    await row.save()
  })
  return scheduleView(gateway.id, row.id)
}

export async function deleteSchedule(id: number, context: WriteContext) {
  const row = await QosSchedule.find(id)
  if (!row) throw notFound('schedule', id)
  const gateway = await gatewayOf(row.gatewayId)
  await mutate(gateway.id, context.userId, async (trx) => {
    row.useTransaction(trx)
    await row.delete()
  })
}

async function scheduleView(gatewayId: number, id: number) {
  const views = await listSchedules({ gatewayId })
  const view = views.find((s) => s.id === id)
  if (!view) throw notFound('schedule', id)
  return view
}

// ---------------------------------------------------------------------------
// Pause (plan 3 section 8: the controller's pause is `globals.enabled '0'`)

export async function setQosPaused(
  ref: GatewayRef,
  paused: boolean,
  context: WriteContext & { overrideRouter?: boolean; routerPausedAt?: string | null }
): Promise<Gateway> {
  const gateway = await managedGateway(ref)
  if (!paused && context.routerPausedAt && !context.overrideRouter) {
    throw qosRefusal(
      409,
      'qos_paused_on_router',
      'Shaping was paused on the router itself. Resume it there, or resume with overrideRouter.',
      { pausedAt: context.routerPausedAt }
    )
  }
  const state = await stateRow(gateway.id)
  state.pausedAt = paused ? DateTime.utc() : null
  state.pausedByUserId = paused ? context.userId : null
  await state.save()
  invalidateQosPlanCache(gateway.id)
  requestQosSync(gateway.id, {
    overrideRouterPause: !paused && Boolean(context.overrideRouter),
    forceConfig: true,
    userId: context.userId,
  })
  return gateway
}

// ---------------------------------------------------------------------------
// Expiry (`qos_expire.task.ts`, every 30 s)

/**
 * Assignments past `expiresAt` already drop out of every plan (the router
 * drops their entries on its own too, even offline). The sweep delivers the
 * shorter entry list and, `expiredKeepMinutes` after expiry, deletes the
 * rows (their schedules cascade). Returns the deleted ids.
 */
export async function expireQosAssignments(now: DateTime = DateTime.utc()): Promise<number[]> {
  const { expiredKeepMinutes } = await getQosSettings()
  const cutoff = now.minus({ minutes: expiredKeepMinutes })
  const stale = await QosAssignment.query()
    .whereNotNull('expiresAt')
    .where('expiresAt', '<=', cutoff.toFormat('yyyy-MM-dd HH:mm:ss'))
    .select('id', 'gatewayId')
  if (stale.length === 0) return []
  const ids = stale.map((a) => a.id)
  await QosAssignment.query().whereIn('id', ids).delete()
  for (const gatewayId of new Set(stale.map((a) => a.gatewayId))) {
    invalidateQosPlanCache(gatewayId)
  }
  return ids
}
