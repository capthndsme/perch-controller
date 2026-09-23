import Gateway from '#models/gateway'
import type GatewayApply from '#models/gateway_apply'
import GatewaySection from '#models/gateway_section'
import { requestApply, type DryRunResult } from '#services/gateway_config/apply_lifecycle'
import type { SectionEdit } from '#services/gateway_config/domain'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import { discardDraft, editSections } from '#services/gateway_config/gateway_config_service'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import { onApplySaved, onRouterRead, type RouterRead } from '#services/gateway_config/hooks'
import { toSectionState } from '#services/gateway_config/section_rows'
import type { PlaneActor, UciOptions } from '#services/gateway_config/types'
import { PERCH_QOS_CONFIG, PERCH_QOS_DOMAIN, perchQosPaused } from '#services/perch_qos_domain'
import {
  QosPlaneError,
  setQosPlaneWriter,
  type QosConfigChange,
  type QosPlaneAccepted,
  type QosPlaneWriter,
} from '#services/qos_plane'
import { noteQosConfigApply, qosConfigWaiting, requestQosSync, stateRow } from '#services/qos_sync'
import { recordRouterSqm, type PlaneSqmSection } from '#services/qos_wan_queues'
import { SQM_CONFIG, SQM_QUEUE_TYPE, sqmDomain } from '#services/sqm_domain'
import {
  setSqmPlaneWriter,
  SqmPlaneError,
  type SqmPlaneAccepted,
  type SqmPlaneState,
  type SqmPlaneWriter,
  type SqmQueueChange,
} from '#services/sqm_plane'
import { notAllowed } from '#services/plane_config_access'
import { applyViewOf } from '#transformers/gateway_transformer'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The QoS feature's writers on the config plane (docs/gateway/qos.md
 * sections 2.4 and 6.3; config-plane.md section 6.8): the one write path
 * (README section 2) for `/etc/config/sqm` (WAN queues, two-way synced) and
 * `/etc/config/perch-qos` (the shaper's package, Perch-owned, one-way).
 *
 * Both turn a change into section edits of their domain
 * (`gatewayConfig.editSections`), then ask for an apply of exactly those
 * sections (`requestApply`), and report where it stands:
 *
 * - `queued`: in the draft; the apply waits for the agent (offline), or for
 *   another apply to finish (`apply_in_flight`: the draft is kept, the
 *   package is applied when that apply ends, a WAN queue from the gateway
 *   page);
 * - `applying`: sent, waiting for the router's fresh session and the confirm
 *   (the confirm mode of Settings → Gateway for an admin's WAN queue; the
 *   agent alone for the package, which Perch writes by itself too);
 * - `applied` / `in_sync`, or `rolled_back` / `failed` with the reason.
 *
 * A router refusal of the apply (`invalid_config` with `sqm_below_floor`, a
 * config not on its allowlist, …) discards the draft of those sections and
 * becomes a `SqmPlaneError` / `QosPlaneError` with a message that says what
 * to do. Writes Perch makes by itself (a portal grant, the expiry sweep:
 * `userId` null) are authored `{ system: 'qos' }` ("Perch (system)").
 *
 * `installPlaneWriters()` installs both writers and the plane listeners;
 * the `qos_plane_provider` calls it at boot.
 */

/** Router refusal codes after which nothing changed on the router (the draft is dropped). */
const ROUTER_REFUSALS = new Set([
  'invalid_config',
  'config_not_allowed',
  'bad_params',
  'not_owned',
  'name_taken',
  'foreign_staged',
  'not_managed',
  'insecure_transport',
  'signature_required',
  'bad_signature',
  'stale_base',
])

function actorOf(userId: number | null): PlaneActor {
  return userId !== null ? userId : { system: 'qos' }
}

/** A router refusal of an apply, in words (the agent's `detail` and data). */
function refusalMessage(config: string, apply: GatewayApply): string {
  const outcome = apply.outcome ?? {}
  const data = (outcome.data ?? {}) as Record<string, unknown>
  if (outcome.error === 'invalid_config' && data.detail === 'sqm_below_floor') {
    return `The router refused the queue: it shapes below the gateway's floor of ${String(
      data.minWanKbit ?? '?'
    )} kbit/s (perch-qos globals.min_wan_kbit). Raise the rate or use 0 (unshaped).`
  }
  if (outcome.error === 'config_not_allowed') {
    return `The router does not let Perch write ${config}: allow it on the router (managed_config, or install the package).`
  }
  return `The router refused the change (${outcome.error ?? 'refused'}): ${outcome.message ?? ''}`.trim()
}

function stateOfApply(apply: GatewayApply): SqmPlaneState | 'failed' | 'rolled_back' {
  switch (apply.state) {
    case 'queued':
      return 'queued'
    case 'sending':
    case 'pending_confirm':
      return 'applying'
    case 'confirmed':
      return 'applied'
    case 'rolled_back':
      return 'rolled_back'
    case 'cancelled':
      return apply.outcome?.reason === 'nothing_to_apply' ? 'applied' : 'failed'
    default:
      return 'failed'
  }
}

/** A plane refusal as the writer's error (the QoS endpoints send it as is). */
function sqmError(error: GatewayPlaneError): SqmPlaneError {
  const status = error.status === 422 ? 422 : error.status === 503 ? 503 : 409
  return new SqmPlaneError(status, error.code, error.message, error.data)
}

function qosError(error: GatewayPlaneError): QosPlaneError {
  const status = error.status === 422 ? 422 : error.status === 503 ? 503 : 409
  return new QosPlaneError(status, error.code, error.message, error.data)
}

type ApplyStart = {
  apply: GatewayApply | null
  applyError: { error: string; message: string } | null
}

/**
 * Asks for an apply of exactly these sections. A plane refusal that leaves
 * the draft usable (another apply is open, the agent is offline or not
 * writable) comes back as `applyError`; anything else throws.
 */
async function startApply(
  gatewayId: number,
  userId: number | null,
  perchIds: string[],
  confirmMode?: 'agent'
): Promise<ApplyStart> {
  try {
    const apply = await requestApply(gatewayId, {
      userId,
      actor: actorOf(userId),
      perchIds,
      ...(confirmMode ? { confirmMode } : {}),
      note: userId === null ? 'Traffic shaping (Perch)' : null,
    })
    return { apply: apply as Exclude<typeof apply, DryRunResult>, applyError: null }
  } catch (error) {
    if (!(error instanceof GatewayPlaneError)) throw error
    if (error.code === 'nothing_to_apply') return { apply: null, applyError: null }
    return { apply: null, applyError: { error: error.code, message: error.message } }
  }
}

// ── sqm ──────────────────────────────────────────────────────────────────

/** WAN queue writes (docs/gateway/qos.md section 2.4) through the `sqm` domain. */
export class PlaneSqmWriter implements SqmPlaneWriter {
  async submit(change: SqmQueueChange): Promise<SqmPlaneAccepted> {
    const gateway = await Gateway.find(change.gatewayId)
    if (!gateway) throw new SqmPlaneError(409, 'gateway_not_found', 'The gateway is gone.')
    if (normalizeMode(gateway.mode) !== 'managed') {
      throw new SqmPlaneError(409, 'qos_not_managed', 'The gateway is not in managed mode.')
    }
    const blocked = notAllowed(gateway, SQM_CONFIG)
    if (blocked) throw new SqmPlaneError(409, blocked.code, blocked.message, { config: SQM_CONFIG })

    const rows = await GatewaySection.query()
      .where('gateway_id', gateway.id)
      .where('config', SQM_CONFIG)
    const row =
      (change.perchId ? rows.find((r) => r.perchId === change.perchId) : undefined) ??
      (change.uciSection ? rows.find((r) => r.sectionName === change.uciSection) : undefined) ??
      null
    let edits: SectionEdit[]
    if (change.action === 'create') {
      edits = [
        {
          op: 'put',
          perchId: null,
          config: SQM_CONFIG,
          type: SQM_QUEUE_TYPE,
          options: change.options!,
        },
      ]
    } else {
      if (!row) {
        throw new SqmPlaneError(
          409,
          'sqm_not_read',
          'The controller has not read this queue from the router yet; refresh the gateway and try again.'
        )
      }
      if (row.scope !== 'synced' || row.domain !== sqmDomain.key) {
        throw new SqmPlaneError(
          409,
          'sqm_not_synced',
          `The router's queue ${row.sectionName} is ${row.scope}: Perch does not manage it (include it on the gateway page first).`,
          { perchId: row.perchId }
        )
      }
      edits =
        change.action === 'delete'
          ? [{ op: 'delete', perchId: row.perchId }]
          : sqmDomain.render(
              { perchId: row.perchId, section: row.sectionName, options: change.options! },
              []
            )
    }

    let perchId: string
    try {
      const outcome = await editSections(gateway.id, actorOf(change.userId), sqmDomain.key, edits)
      perchId =
        change.action === 'create' ? outcome.perchIds[0] : (row?.perchId ?? outcome.perchIds[0])
    } catch (error) {
      if (error instanceof GatewayPlaneError) throw sqmError(error)
      throw error
    }
    const section = await GatewaySection.query()
      .where('gateway_id', gateway.id)
      .where('perch_id', perchId)
      .first()
    if (!section) {
      // A controller-only queue deleted before it reached the router: gone.
      return {
        perchId,
        uciSection: null,
        revision: gateway.headRevision,
        applyId: null,
        state: 'applied',
        apply: null,
        applyError: null,
      }
    }

    const { apply, applyError } = await startApply(gateway.id, change.userId, [perchId])
    if (apply && apply.state === 'failed' && ROUTER_REFUSALS.has(apply.outcome?.error ?? '')) {
      // Nothing changed on the router: the draft goes too, and the
      // endpoint answers with the router's reason.
      await discardDraft(gateway.id, actorOf(change.userId), [perchId]).catch(() => 0)
      const error = apply.outcome?.error ?? 'refused'
      throw new SqmPlaneError(
        error === 'invalid_config' || error === 'bad_params' ? 422 : 409,
        error === 'invalid_config' &&
          (apply.outcome?.data as Record<string, unknown> | undefined)?.detail === 'sqm_below_floor'
          ? 'sqm_below_floor'
          : error,
        refusalMessage(SQM_CONFIG, apply),
        { applyId: apply.applyKey, ...((apply.outcome?.data as object) ?? {}) }
      )
    }
    await gateway.refresh()
    return {
      perchId,
      uciSection: section.sectionName,
      revision: gateway.headRevision,
      applyId: apply?.applyKey ?? null,
      state: apply ? (stateOfApply(apply) as SqmPlaneState) : applyError ? 'queued' : 'applied',
      apply: apply ? await applyViewOf(apply, { changes: true }) : null,
      applyError,
    }
  }
}

// ── perch-qos ────────────────────────────────────────────────────────────

/** Drops `''` options: UCI does not keep empty values (absent = `''` for perch-collector). */
function stripEmpty(options: UciOptions): UciOptions {
  const out: UciOptions = {}
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      const items = value.filter((v) => v !== '')
      if (items.length > 0) out[key] = items
    } else if (value !== '') {
      out[key] = value
    }
  }
  return out
}

/** The perch-qos package (docs/gateway/qos.md section 6.3) through the `perch_qos` domain. */
export class PlaneQosWriter implements QosPlaneWriter {
  async submit(change: QosConfigChange): Promise<QosPlaneAccepted> {
    const gateway = await this.#gateway(change.gatewayId)
    const loaded = await GatewaySection.query()
      .where('gateway_id', gateway.id)
      .where('config', PERCH_QOS_CONFIG)
    const rows = loaded.map(toSectionState)
    const synced = rows.filter((r) => r.scope === 'synced' && r.domain === PERCH_QOS_DOMAIN)
    if (synced.length === 0 && !rows.some((r) => r.router !== null)) {
      // The router's file (the perch-qos package ships a globals section)
      // was never read: a fresh gateway, or perch-qos is missing.
      const packages = gateway.capabilities?.packages
      if (packages && typeof packages === 'object' && !('perch-qos' in packages)) {
        throw new QosPlaneError(
          409,
          'qos_package_missing',
          'perch-qos is not installed on the gateway (Install on gateway).',
          { missing: ['perch-qos'] }
        )
      }
    }

    // The package revision: past anything the plane or the router has seen.
    const state = await stateRow(gateway.id)
    const routerRevision = Math.max(
      0,
      ...rows
        .filter((r) => r.type === 'globals')
        .map((r) => Number(r.router?.options.revision ?? r.desired?.options.revision ?? 0))
        .filter((n) => Number.isFinite(n))
    )
    const revision = Math.max(Number(state.configRevision ?? 0), routerRevision) + 1

    const edits: SectionEdit[] = []
    const kept = new Set<string>()
    for (const section of change.sections) {
      const options = stripEmpty(section.options)
      if (section.type === 'globals') options.revision = String(revision)
      const row =
        section.type === 'globals'
          ? (synced.find((r) => r.type === 'globals') ?? null)
          : (synced.find((r) => r.type === section.type && r.name === section.name) ?? null)
      if (row) kept.add(row.perchId)
      edits.push({
        op: 'put',
        perchId: row?.perchId ?? null,
        config: PERCH_QOS_CONFIG,
        type: section.type,
        ...(row ? {} : { name: section.name }),
        options,
        ...(section.type === 'globals' && change.overrideRouterPause && row
          ? { reclaim: ['enabled'] }
          : {}),
      })
    }
    for (const row of synced) {
      if (!kept.has(row.perchId) && row.desired !== null) {
        edits.push({ op: 'delete', perchId: row.perchId })
      }
    }

    let perchIds: string[]
    try {
      const outcome = await editSections(
        gateway.id,
        actorOf(change.userId),
        PERCH_QOS_DOMAIN,
        edits
      )
      perchIds = [...outcome.perchIds, ...outcome.deleted]
    } catch (error) {
      if (error instanceof GatewayPlaneError) {
        // Another apply carries these sections now: wait for it (the
        // listener resubmits when it ends).
        if (error.code === 'pending_apply') {
          throw new QosPlaneError(409, 'apply_in_flight', 'An apply of the package is running.')
        }
        throw qosError(error)
      }
      throw error
    }
    // Every synced section of the package goes into the apply (the whole
    // file is one package; an unchanged section adds no op).
    const all = await this.#packagePerchIds(gateway.id)
    return this.#apply(gateway, change.userId, [...new Set([...perchIds, ...all])], revision)
  }

  /** The draft waited for another apply: start its apply now. */
  async resume(gatewayId: number, userId: number | null): Promise<QosPlaneAccepted | null> {
    const gateway = await Gateway.find(gatewayId)
    if (!gateway || normalizeMode(gateway.mode) !== 'managed') return null
    const loaded = await GatewaySection.query()
      .where('gateway_id', gatewayId)
      .where('config', PERCH_QOS_CONFIG)
      .where('domain', PERCH_QOS_DOMAIN)
      .where('scope', 'synced')
    const rows = loaded.map(toSectionState)
    if (!rows.some((r) => r.status === 'ahead')) return null
    const state = await stateRow(gatewayId)
    return this.#apply(
      gateway,
      userId,
      rows.map((r) => r.perchId),
      Number(state.configRevision ?? 0)
    )
  }

  async #gateway(gatewayId: number): Promise<Gateway> {
    const gateway = await Gateway.find(gatewayId)
    if (!gateway) throw new QosPlaneError(409, 'gateway_not_found', 'The gateway is gone.')
    if (normalizeMode(gateway.mode) !== 'managed') {
      throw new QosPlaneError(409, 'qos_not_managed', 'The gateway is not in managed mode.')
    }
    const blocked = notAllowed(gateway, PERCH_QOS_CONFIG)
    if (blocked) {
      throw new QosPlaneError(409, blocked.code, blocked.message, { config: PERCH_QOS_CONFIG })
    }
    return gateway
  }

  async #packagePerchIds(gatewayId: number): Promise<string[]> {
    const rows = await GatewaySection.query()
      .where('gateway_id', gatewayId)
      .where('config', PERCH_QOS_CONFIG)
      .where('domain', PERCH_QOS_DOMAIN)
      .where('scope', 'synced')
      .select('perch_id')
    return rows.map((r) => r.perchId)
  }

  async #apply(
    gateway: Gateway,
    userId: number | null,
    perchIds: string[],
    revision: number
  ): Promise<QosPlaneAccepted> {
    // The package confirms by the agent alone: Perch writes it by itself
    // (portal grants, expiry), and it never touches the management path.
    const { apply, applyError } = await startApply(gateway.id, userId, perchIds, 'agent')
    if (apply && apply.state === 'failed' && ROUTER_REFUSALS.has(apply.outcome?.error ?? '')) {
      await discardDraft(gateway.id, actorOf(userId), perchIds).catch(() => 0)
      const error = apply.outcome?.error ?? 'refused'
      throw new QosPlaneError(
        error === 'invalid_config' || error === 'bad_params' ? 422 : 409,
        error,
        refusalMessage(PERCH_QOS_CONFIG, apply),
        { applyId: apply.applyKey, ...((apply.outcome?.data as object) ?? {}) }
      )
    }
    if (applyError && !['apply_in_flight', 'agent_offline'].includes(applyError.error)) {
      throw new QosPlaneError(409, applyError.error, applyError.message)
    }
    const state = apply ? stateOfApply(apply) : applyError ? 'queued' : 'applied'
    return {
      revision,
      applyId: apply?.applyKey ?? null,
      state: state === 'applied' ? 'in_sync' : state === 'applying' ? 'applying' : 'queued',
      error: applyError?.error === 'apply_in_flight' ? 'apply_in_flight' : null,
    }
  }
}

// ── plane listeners ──────────────────────────────────────────────────────

const FINISHED = new Set(['confirmed', 'rolled_back', 'failed', 'expired', 'cancelled'])

/**
 * Follows the applies: a `perch-qos` one moves the package's state
 * (queued → applying → applied / rolled back); when any apply ends while the
 * package waits for one, the sender tries again (outside the queue).
 */
async function onApply(apply: GatewayApply): Promise<void> {
  if (apply.kind === 'package') return
  const carriesQos = (apply.configs ?? []).includes(PERCH_QOS_CONFIG)
  if (carriesQos) noteQosConfigApply(apply.gatewayId, apply)
  if (FINISHED.has(apply.state) && qosConfigWaiting(apply.gatewayId)) {
    setTimeout(() => requestQosSync(apply.gatewayId, { immediate: true }), 0).unref()
  }
}

/** Every router read: the `sqm` queues into `qos_wan_queues` (qos.md section 2.3). */
async function onRead(read: RouterRead) {
  const sqm = read.configs.find((c) => c.name === SQM_CONFIG)
  if (!sqm) return
  const plane = await GatewaySection.query()
    .where('gateway_id', read.gatewayId)
    .where('config', SQM_CONFIG)
  const sections = new Map<string, PlaneSqmSection>()
  for (const row of plane) {
    const s = toSectionState(row)
    sections.set(s.name, {
      perchId: s.perchId,
      synced: s.scope === 'synced',
      onRouter: s.router !== null,
      desired: s.desired !== null,
      pending: s.scope === 'synced' && s.status !== 'in_sync' && s.status !== 'drift',
    })
  }
  const result = await recordRouterSqm(
    read.gatewayId,
    sqm,
    DateTime.utc(),
    read.perchIds[SQM_CONFIG] ?? {},
    sections
  )
  if (result.paused.length > 0 || result.resumed.length > 0) {
    logger.info(
      { gatewayId: read.gatewayId, paused: result.paused, resumed: result.resumed },
      'qos: a WAN queue was switched on the router (decision 15: never reverted)'
    )
  }
}

let installed: Array<() => void> = []

/** Installs the real writers and the plane listeners (idempotent). */
export function installPlaneWriters(): { sqm: PlaneSqmWriter; qos: PlaneQosWriter } {
  const sqm = new PlaneSqmWriter()
  const qos = new PlaneQosWriter()
  setSqmPlaneWriter(sqm)
  setQosPlaneWriter(qos)
  if (installed.length === 0) {
    installed = [onApplySaved(onApply), onRouterRead(onRead)]
  }
  return { sqm, qos }
}

/** Test-only: removes the listeners (the writers stay until replaced). */
export function _uninstallPlaneListeners(): void {
  for (const off of installed) off()
  installed = []
}

/** Whether a perch-qos value is the paused one (re-exported for views). */
export { perchQosPaused }
