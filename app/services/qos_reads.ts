import QosAssignment from '#models/qos_assignment'
import QosGroup from '#models/qos_group'
import QosGroupMember from '#models/qos_group_member'
import QosPolicy from '#models/qos_policy'
import QosSchedule from '#models/qos_schedule'
import SystemSetting from '#models/system_setting'
import { resolveGateway, type GatewayRef } from '#services/qos_gateway'
import {
  overrideFromColumns,
  PLAN_DAY_NAMES,
  rateFromColumns,
  scheduleCovers,
  scheduleWindow,
  validZone,
  type PlanAssignment,
  type PlanGroup,
  type PlanInput,
  type PlanPolicy,
  type PlanRate,
  type PlanRateOverride,
  type PlanSchedule,
} from '#services/qos_plan'
import { getQosSettings } from '#services/qos_settings'
import QosGatewayState from '#models/qos_gateway_state'
import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { DateTime } from 'luxon'

/**
 * Read side of policies, groups, assignments and schedules (docs/gateway/qos.md
 * section 5). Any signed-in user reads them (owner decision 16: operators see
 * every cap, nested bucket and schedule); the admin write endpoints come with
 * WP-C. Also loads a gateway's planner input (`loadPlanInput`).
 */

/** Plan 3 section 5 `QosRate`: kbit/s, null = unlimited that way. */
export interface QosRate {
  downloadKbit: number | null
  uploadKbit: number | null
}

/** A stored rate (0 = unlimited) on the wire. */
export function wireRate(rate: PlanRate | null): QosRate | null {
  if (!rate) return null
  return {
    downloadKbit: rate.downKbit === 0 ? null : rate.downKbit,
    uploadKbit: rate.upKbit === 0 ? null : rate.upKbit,
  }
}

/** An override on the wire: null = keep, 0 = unlimited. */
function wireOverride(rate: PlanRateOverride | null) {
  if (!rate) return null
  return { downloadKbit: rate.downKbit, uploadKbit: rate.upKbit }
}

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}

function num(value: bigint | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value)
}

/** Device label names by MAC (joined in JS: collation note in CLAUDE.md). */
async function labelNames(macs: string[]): Promise<Map<string, string | null>> {
  if (macs.length === 0) return new Map()
  const rows = (await db
    .from('device_labels')
    .whereIn('mac', macs)
    .select('mac', 'name')) as Array<{ mac: string; name: string | null }>
  return new Map(rows.map((r) => [r.mac.toLowerCase(), r.name]))
}

export async function listPolicies(ref: GatewayRef) {
  const { gateway } = await resolveGateway(ref)
  const policies = await QosPolicy.query().where('gatewayId', gateway.id).orderBy('name')
  const assignments = await QosAssignment.query().where('gatewayId', gateway.id)
  return policies.map((p) => {
    const own = assignments.filter((a) => a.policyId === p.id)
    return {
      id: p.id,
      gatewayId: gateway.id,
      collectorId: gateway.collectorId,
      name: p.name,
      notes: p.notes,
      shared: wireRate(rateFromColumns(p.sharedDownKbit, p.sharedUpKbit)),
      each: wireRate(rateFromColumns(p.eachDownKbit, p.eachUpKbit)),
      fairness: p.fairness === 'per_flow' ? 'per_flow' : 'per_host',
      includeLan: Boolean(p.includeLan),
      parentPolicyId: p.parentPolicyId,
      classMinor: p.classMinor,
      enabled: Boolean(p.enabled),
      source: p.source === 'portal' ? 'portal' : 'admin',
      sourceRef: p.sourceRef,
      counts: {
        devices: own.filter((a) => a.targetType === 'device').length,
        groups: own.filter((a) => a.targetType === 'group').length,
        networks: own
          .filter((a) => a.targetType === 'network' && a.network)
          .map((a) => a.network!)
          .sort(),
        children: policies.filter((c) => c.parentPolicyId === p.id).length,
      },
      live: null,
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt ?? p.createdAt),
    }
  })
}

export async function listGroups(ref: GatewayRef) {
  const { gateway } = await resolveGateway(ref)
  const groups = await QosGroup.query().where('gatewayId', gateway.id).orderBy('name')
  const members = await QosGroupMember.query().where('gatewayId', gateway.id).orderBy('mac')
  const names = await labelNames(members.map((m) => m.mac))
  return groups.map((g) => ({
    id: g.id,
    gatewayId: gateway.id,
    collectorId: gateway.collectorId,
    name: g.name,
    notes: g.notes,
    members: members
      .filter((m) => m.groupId === g.id)
      .map((m) => ({ mac: m.mac, name: names.get(m.mac.toLowerCase()) ?? null })),
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt ?? g.createdAt),
  }))
}

function targetOf(a: QosAssignment) {
  if (a.targetType === 'group') return { type: 'group' as const, groupId: a.groupId! }
  if (a.targetType === 'network') return { type: 'network' as const, network: a.network! }
  return { type: 'device' as const, mac: a.mac! }
}

export interface AssignmentFilter extends GatewayRef {
  policyId?: number
  mac?: string
  source?: 'admin' | 'portal'
}

export async function listAssignments(filter: AssignmentFilter) {
  const { gateway } = await resolveGateway(filter)
  const query = QosAssignment.query().where('gatewayId', gateway.id).orderBy('id')
  if (filter.policyId !== undefined) query.where('policyId', filter.policyId)
  if (filter.mac !== undefined) query.where('mac', filter.mac.toLowerCase())
  if (filter.source !== undefined) query.where('source', filter.source)
  const rows = await query
  return rows.map((a) => ({
    id: a.id,
    gatewayId: gateway.id,
    collectorId: gateway.collectorId,
    policyId: a.policyId,
    target: targetOf(a),
    rate: wireRate(rateFromColumns(a.downKbit, a.upKbit)),
    quota:
      a.quotaBytes === null
        ? null
        : {
            limitBytes: num(a.quotaBytes),
            usedBytes: num(a.quotaUsedBytes),
            onExhausted: a.quotaOnExhausted === 'block' ? 'block' : 'throttle',
            throttle: wireRate(rateFromColumns(a.throttleDownKbit, a.throttleUpKbit)),
            exhaustedAt: iso(a.exhaustedAt),
            resetAt: iso(a.quotaResetAt),
          },
    expiresAt: iso(a.expiresAt),
    source: a.source === 'portal' ? 'portal' : 'admin',
    sourceRef: a.sourceRef,
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt ?? a.createdAt),
  }))
}

/** Bitmask → day names (`['mon', 'tue', …]`). */
export function dayNames(mask: number): string[] {
  return PLAN_DAY_NAMES.filter((_, index) => (mask & (1 << index)) !== 0)
}

function planScheduleOf(s: QosSchedule): PlanSchedule {
  return {
    id: s.id,
    enabled: Boolean(s.enabled),
    target:
      s.targetType === 'policy'
        ? { type: 'policy', policyId: s.policyId! }
        : { type: 'assignment', assignmentId: s.assignmentId! },
    action: (['limit', 'unlimited', 'block', 'policy'] as const).includes(
      s.action as PlanSchedule['action']
    )
      ? (s.action as PlanSchedule['action'])
      : 'limit',
    usePolicyId: s.usePolicyId,
    shared: overrideFromColumns(s.sharedDownKbit, s.sharedUpKbit),
    each: overrideFromColumns(s.eachDownKbit, s.eachUpKbit),
    rate: overrideFromColumns(s.rateDownKbit, s.rateUpKbit),
    days: s.days,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
  }
}

/**
 * The zone schedule previews are shown in: the controller's `timezone`
 * setting (the setup wizard's), else UTC. The router runs the windows on its
 * own clock (`system.zonename`); the two are the same zone on a normal
 * install. TODO: prefer the gateway's reported zone once the capabilities
 * carry it.
 */
export async function controllerTimezone(): Promise<string> {
  return validZone(await SystemSetting.get<string>('timezone')) ?? 'UTC'
}

export async function listSchedules(ref: GatewayRef, at: Date = new Date()) {
  const { gateway } = await resolveGateway(ref)
  const rows = await QosSchedule.query().where('gatewayId', gateway.id).orderBy('id')
  const zone = await controllerTimezone()
  return rows.map((s) => {
    const plan = planScheduleOf(s)
    return {
      id: s.id,
      gatewayId: gateway.id,
      collectorId: gateway.collectorId,
      name: s.name,
      enabled: plan.enabled,
      target: plan.target,
      action: plan.action,
      usePolicyId: plan.usePolicyId,
      shared: wireOverride(plan.shared),
      each: wireOverride(plan.each),
      rate: wireOverride(plan.rate),
      days: dayNames(s.days),
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      /** The window as the router gets it (`list window` of `perch-qos`). */
      window: scheduleWindow(plan),
      /** Preview: in force right now, judged in `previewTimezone` (the router decides for real). */
      active: plan.enabled && (s.days & 0x7f) !== 0 && scheduleCovers(plan, at, zone),
      previewTimezone: zone,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt ?? s.createdAt),
    }
  })
}

/**
 * Everything `planQos` needs for one gateway, read from the tables. The
 * network list is left out until the config plane models networks (M5);
 * the planner then accepts any valid network name.
 */
export async function loadPlanInput(
  gatewayId: number,
  at: Date = new Date(),
  client?: QueryClientContract
): Promise<PlanInput> {
  const options = client ? { client } : undefined
  const [policies, groups, members, assignments, schedules, settings, zone, paused] =
    await Promise.all([
      QosPolicy.query(options).where('gatewayId', gatewayId),
      QosGroup.query(options).where('gatewayId', gatewayId),
      QosGroupMember.query(options).where('gatewayId', gatewayId),
      QosAssignment.query(options).where('gatewayId', gatewayId),
      QosSchedule.query(options).where('gatewayId', gatewayId),
      getQosSettings(),
      controllerTimezone(),
      QosGatewayState.query(options).where('gatewayId', gatewayId).whereNotNull('pausedAt').first(),
    ])
  const planPolicies: PlanPolicy[] = policies.map((p) => ({
    id: p.id,
    name: p.name,
    shared: rateFromColumns(p.sharedDownKbit, p.sharedUpKbit),
    each: rateFromColumns(p.eachDownKbit, p.eachUpKbit),
    fairness: p.fairness === 'per_flow' ? 'per_flow' : 'per_host',
    includeLan: Boolean(p.includeLan),
    parentId: p.parentPolicyId,
    enabled: Boolean(p.enabled),
    classMinor: p.classMinor,
  }))
  const planGroups: PlanGroup[] = groups.map((g) => ({
    id: g.id,
    members: members.filter((m) => m.groupId === g.id).map((m) => m.mac),
  }))
  const planAssignments: PlanAssignment[] = assignments.map((a) => ({
    id: a.id,
    policyId: a.policyId,
    target: targetOf(a),
    rate: rateFromColumns(a.downKbit, a.upKbit),
    quota:
      a.quotaBytes === null
        ? null
        : {
            limitBytes: num(a.quotaBytes),
            usedBytes: num(a.quotaUsedBytes),
            onExhausted: a.quotaOnExhausted === 'block' ? 'block' : 'throttle',
            throttle: rateFromColumns(a.throttleDownKbit, a.throttleUpKbit),
            resetAt: a.quotaResetAt ? a.quotaResetAt.toJSDate() : null,
          },
    expiresAt: a.expiresAt ? a.expiresAt.toJSDate() : null,
  }))
  return {
    policies: planPolicies,
    groups: planGroups,
    assignments: planAssignments,
    schedules: schedules.map(planScheduleOf),
    settings,
    paused: paused !== null,
    at,
    timezone: zone,
  }
}
