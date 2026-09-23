import Collector from '#models/collector'
import type Gateway from '#models/gateway'
import type GatewayApply from '#models/gateway_apply'
import type GatewayConfigEvent from '#models/gateway_config_event'
import type GatewayRevision from '#models/gateway_revision'
import GatewaySection from '#models/gateway_section'
import User from '#models/user'
import { domainRegistry } from '#services/gateway_config/domains/index'
import type { GatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import {
  gatewaySession,
  normalizeMode,
  writeAccess,
} from '#services/gateway_config/gateway_registry'
import { openApplies } from '#services/gateway_config/gateway_store'
import { pairingView } from '#services/gateway_config/pairing'
import { toSectionState } from '#services/gateway_config/section_rows'
import { revertDueAt } from '#services/gateway_config/sync_engine'
import {
  parseSystemActor,
  SYSTEM_ACTOR_NAME,
  type SecretSlot,
  type SectionContent,
  type SystemActor,
  type UciOptions,
} from '#services/gateway_config/types'
import { BaseTransformer } from '@adonisjs/core/transformers'
import type { DateTime } from 'luxon'

/**
 * Wire shapes of the gateway REST API (docs/gateway/config-plane.md section
 * 10): `Gateway`, `GatewayApply`, `GatewaySection`, `GatewayRevision` and
 * events. Secrets never appear: sections show a secret option as
 * `{ secret: true, fingerprint }` in `secrets`, and values the controller
 * set are write-only.
 */

type UserRef = { id: number; email: string } | null

/**
 * Who made a change, on the wire: a user, or Perch itself (section 6.8:
 * `{ id: null, email: null, system: true, name: 'Perch (system)', via }`).
 */
export type ActorRef =
  | { id: number; email: string }
  | { id: null; email: null; system: true; name: string; via: SystemActor }
  | null

/** A user reference, or "Perch (system)" when the row names a system actor. */
export function actorRef(
  userId: number | null,
  systemActor: string | null | undefined,
  users: Map<number, UserRef>
): ActorRef {
  const system = parseSystemActor(systemActor)
  if (system) return { id: null, email: null, system: true, name: SYSTEM_ACTOR_NAME, via: system }
  return userId !== null ? (users.get(userId) ?? null) : null
}

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}

export async function userRefs(
  ids: Array<number | null | undefined>
): Promise<Map<number, UserRef>> {
  const wanted = [...new Set(ids.filter((id): id is number => typeof id === 'number'))]
  const out = new Map<number, UserRef>()
  if (wanted.length === 0) return out
  const users = await User.query().whereIn('id', wanted).select('id', 'email')
  for (const u of users) out.set(u.id, { id: u.id, email: u.email })
  return out
}

// ── GatewayApply ─────────────────────────────────────────────────────────

export function applyView(
  apply: GatewayApply,
  users: Map<number, UserRef>,
  options: { changes?: boolean } = {}
) {
  const outcome = apply.outcome
    ? {
        ...(apply.outcome.reason ? { reason: apply.outcome.reason } : {}),
        ...(apply.outcome.error ? { error: apply.outcome.error } : {}),
        ...(apply.outcome.message ? { message: apply.outcome.message } : {}),
        ...(apply.outcome.discardedConfigs
          ? { discardedConfigs: apply.outcome.discardedConfigs }
          : {}),
        ...(apply.outcome.assumed ? { assumed: true } : {}),
        ...(apply.outcome.data && typeof apply.outcome.data === 'object'
          ? { data: apply.outcome.data as Record<string, unknown> }
          : {}),
      }
    : null
  return {
    id: apply.applyKey,
    kind: apply.kind,
    state: apply.state,
    confirmMode: apply.confirmMode,
    confirmTimeoutSeconds: apply.confirmTimeoutSeconds,
    protected: Boolean(apply.protected),
    signed: Boolean(apply.signed),
    deadlineAt: iso(apply.deadlineAt),
    confirmations: {
      agent: iso(apply.agentConfirmedAt),
      admin: iso(apply.adminConfirmedAt),
    },
    agentReconnectedAt: iso(apply.agentReconnectedAt),
    requestedBy: actorRef(apply.requestedByUserId, apply.systemActor, users),
    requestedAt: iso(apply.requestedAt),
    sentAt: iso(apply.sentAt),
    finishedAt: iso(apply.finishedAt),
    queueExpiresAt: apply.state === 'queued' ? iso(apply.queueExpiresAt) : null,
    note: apply.note,
    outcome: outcome && Object.keys(outcome).length > 0 ? outcome : null,
    revision: apply.revisionNumber,
    perchIds: apply.perchIds,
    configs: apply.configs ?? [],
    ...(options.changes ? { changes: apply.changes ?? [] } : {}),
  }
}

export async function applyViews(applies: GatewayApply[], options: { changes?: boolean } = {}) {
  const users = await userRefs(applies.map((a) => a.requestedByUserId))
  return applies.map((a) => applyView(a, users, options))
}

/** One `GatewayApply`. */
export async function applyViewOf(apply: GatewayApply, options: { changes?: boolean } = {}) {
  const [view] = await applyViews([apply], options)
  return view
}

// ── GatewaySection ───────────────────────────────────────────────────────

type SectionContentView = {
  type: string
  options: UciOptions
  secrets: Record<string, { fingerprint: string; setByController: boolean }>
} | null

function contentView(content: SectionContent | null): SectionContentView {
  if (!content) return null
  const secrets: Record<string, { fingerprint: string; setByController: boolean }> = {}
  for (const [name, slot] of Object.entries(content.secrets ?? {}) as Array<[string, SecretSlot]>) {
    secrets[name] = { fingerprint: slot.fingerprint, setByController: Boolean(slot.ref) }
  }
  return { type: content.type, options: content.options, secrets }
}

export function sectionView(
  row: GatewaySection,
  context: { authoritative: boolean; revertDelaySeconds: number }
) {
  const state = toSectionState(row)
  return {
    perchId: row.perchId,
    config: row.config,
    section: row.sectionName,
    type: row.sectionType,
    anonymous: Boolean(row.anonymous),
    scope: state.scope,
    domain: row.domain,
    issue: state.issue,
    ownership: row.ownership && row.ownership.kind === 'options' ? row.ownership : null,
    status: state.status,
    router: contentView(row.routerContent),
    desired: contentView(row.desiredContent),
    base: contentView(row.baseContent),
    baseRevision: row.baseRevision,
    routerAuthor: row.routerAuthor,
    routerChangedAt: iso(row.routerChangedAt),
    conflict: row.conflict,
    driftSince: iso(row.driftSince),
    // One-way domains (README 2) are enforced without Authoritative Mode too.
    revertAt:
      context.authoritative || domainRegistry().get(row.domain)?.oneWay
        ? revertDueAt(state, context.revertDelaySeconds)
        : null,
    position: row.position,
    updatedByUserId: row.updatedByUserId,
    updatedAt: iso(row.updatedAt),
  }
}

// ── GatewayRevision ──────────────────────────────────────────────────────

export function revisionView(
  revision: GatewayRevision,
  users: Map<number, UserRef>,
  applyKeys: Map<number, string>,
  options: { diff?: boolean; snapshot?: boolean } = {}
) {
  return {
    number: revision.number,
    source: revision.source,
    author: actorRef(revision.authorUserId, revision.systemActor, users),
    routerAuthor: revision.routerAuthor,
    summary: revision.summary,
    note: revision.note,
    createdAt: iso(revision.createdAt),
    confirmedAt: iso(revision.confirmedAt),
    applyId: revision.applyId !== null ? (applyKeys.get(Number(revision.applyId)) ?? null) : null,
    ...(options.diff ? { diff: revision.diff } : {}),
    ...(options.snapshot
      ? {
          snapshot: revision.snapshot.map((e) => ({ ...e, content: contentView(e.content) })),
        }
      : {}),
  }
}

// ── events ───────────────────────────────────────────────────────────────

export function eventView(
  event: GatewayConfigEvent,
  users: Map<number, UserRef>,
  applyKeys: Map<number, string>
) {
  return {
    id: Number(event.id),
    event: event.event,
    user: actorRef(event.userId, event.systemActor, users),
    applyId: event.applyId !== null ? (applyKeys.get(Number(event.applyId)) ?? null) : null,
    revision: event.revisionNumber,
    detail: event.detail,
    createdAt: iso(event.createdAt),
  }
}

// ── Gateway ──────────────────────────────────────────────────────────────

export type SectionCounts = {
  synced: number
  excluded: number
  unmodeled: number
  ahead: number
  conflicts: number
  drift: number
}

async function sectionCounts(gatewayIds: number[]): Promise<Map<number, SectionCounts>> {
  const out = new Map<number, SectionCounts>()
  if (gatewayIds.length === 0) return out
  const rows = await GatewaySection.query()
    .whereIn('gateway_id', gatewayIds)
    .select('gateway_id', 'scope', 'status')
    .count('* as total')
    .groupBy('gateway_id', 'scope', 'status')
  for (const row of rows) {
    const id = row.gatewayId
    const counts = out.get(id) ?? {
      synced: 0,
      excluded: 0,
      unmodeled: 0,
      ahead: 0,
      conflicts: 0,
      drift: 0,
    }
    const n = Number(row.$extras.total)
    if (row.scope === 'synced') counts.synced += n
    else if (row.scope === 'excluded') counts.excluded += n
    else counts.unmodeled += n
    if (row.scope === 'synced') {
      if (row.status === 'ahead') counts.ahead += n
      if (row.status === 'conflict') counts.conflicts += n
      if (row.status === 'drift' || row.status === 'reverting') counts.drift += n
    }
    out.set(id, counts)
  }
  return out
}

/** `Gateway` (section 10) for each row; `detail` adds capabilities and the management path. */
export async function gatewayViews(
  gateways: Gateway[],
  settings: GatewayConfigSettings,
  options: { detail?: boolean } = {}
) {
  const counts = await sectionCounts(gateways.map((g) => g.id))
  const collectorIds = gateways.map((g) => g.collectorId).filter((id): id is number => id !== null)
  const collectors =
    collectorIds.length > 0
      ? await Collector.query().whereIn('id', collectorIds).select('id', 'name')
      : []
  const names = new Map(collectors.map((c) => [c.id, c.name]))
  const out = []
  for (const gateway of gateways) {
    const open = await openApplies(gateway.id)
    const pending = open.length > 0 ? await applyViewOf(open[0]) : null
    const session = gatewaySession(gateway.collectorId)
    const access = writeAccess(gateway, settings)
    const caps = gateway.capabilities ?? null
    out.push({
      id: gateway.id,
      collectorId: gateway.collectorId,
      name:
        gateway.collectorId !== null
          ? (names.get(gateway.collectorId) ?? `Gateway ${gateway.id}`)
          : `Gateway ${gateway.id}`,
      detached: gateway.collectorId === null,
      online: session !== null,
      secure: session ? session.secure : null,
      mode: normalizeMode(gateway.mode),
      authoritative: Boolean(gateway.authoritative),
      authoritativeSince: iso(gateway.authoritativeSince),
      enforcement: gateway.enforcement === 'suspended' ? 'suspended' : 'active',
      agentAccess: session?.hello.access ?? gateway.agentAccess ?? null,
      agentAccessConfigured: session?.hello.accessConfigured ?? null,
      transportOk: session?.hello.transportOk ?? caps?.transportOk ?? null,
      allowInsecure: typeof caps?.allowInsecure === 'boolean' ? caps.allowInsecure : null,
      writable: access.writable,
      signedWrites: access.writable ? access.signed : false,
      signingKey: session?.hello.signing?.key ?? null,
      hasSignKey: gateway.configSignKey !== null,
      pairing: pairingView(gateway),
      writeBlockedReason: access.writable ? null : access.reason,
      syncState: gateway.syncState,
      counts: counts.get(gateway.id) ?? {
        synced: 0,
        excluded: 0,
        unmodeled: 0,
        ahead: 0,
        conflicts: 0,
        drift: 0,
      },
      headRevision: gateway.headRevision,
      observedAt: iso(gateway.observedAt),
      luciPending: gateway.observedState?.luciPending ?? false,
      uncommitted: gateway.observedState?.uncommitted ?? [],
      pendingApply: pending,
      rejoinOffer: gateway.rejoinOffer,
      dnsLabelNames: gateway.dnsLabelNames === 'off' ? 'off' : 'review',
      domains: domainRegistry()
        .list()
        .map((d) => ({ key: d.key, configs: d.configs })),
      ...(options.detail
        ? {
            capabilities: caps,
            capabilitiesAt: iso(gateway.capabilitiesAt),
            managementPath: gateway.managementPath,
            observedHashes: gateway.observedHashes ?? {},
          }
        : {}),
    })
  }
  return out
}

/** `Gateway` (section 10), as `gatewayViews` builds it. */
export type GatewayView = Awaited<ReturnType<typeof gatewayViews>>[number]

/**
 * The `Gateway` wire shape for the generated client types
 * (`.adonisjs/client/data.d.ts`): the views are built by `gatewayViews`
 * (they need the live session and the section counts), this passes one
 * through.
 */
export default class GatewayTransformer extends BaseTransformer<GatewayView> {
  toObject() {
    return this.resource
  }
}
