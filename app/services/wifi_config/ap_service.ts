import ApConfig from '#models/ap_config'
import type ApConfigApply from '#models/ap_config_apply'
import type User from '#models/user'
import WifiAccessPoint from '#models/wifi_access_point'
import WifiDivergence from '#models/wifi_divergence'
import WifiIfaceLink from '#models/wifi_iface_link'
import type WifiRollout from '#models/wifi_rollout'
import { sendAgentConfigure } from '#services/ap_agent_metrics'
import { cloneContent, contentsEqual } from '#services/gateway_config/canonical'
import {
  acceptDrift,
  checkEnableAuthoritative,
  checkModeChange,
  computeSyncStatus,
  computeUnledgered,
  deriveStatus,
  featureSyncIssues,
  isGone,
  resolveConflict,
  type ConflictResolution,
  type OptionResolution,
  type SectionState,
  type SyncStatus,
} from '#services/gateway_config/sync_engine'
import type { PlaneActor, UciValue } from '#services/gateway_config/types'
import { WIFI_RADIOS_DOMAIN, wifiRadiosDomain } from '#services/wifi_config/domains/wifi_radios'
import {
  agentErrorCode,
  ApOfflineError,
  fetchApCapabilities,
  fetchApHealth,
  readAndReconcileAp,
  type ApReadOutcome,
} from '#services/wifi_config/agent'
import { wifiError, WifiPlaneError } from '#services/wifi_config/errors'
import { emitWifiAlert, recordApEvent } from '#services/wifi_config/events'
import { renderAp } from '#services/wifi_config/fleet/render'
import {
  loadFleet,
  renderApDraft,
  renderInputOf,
  rolloutRenders,
  setApCountry,
  type RenderOutcome,
  type WriteOutcome,
} from '#services/wifi_config/fleet_service'
import { registryFor, startApRevert, validateApStates } from '#services/wifi_config/lifecycle'
import {
  apSession,
  clearConfigureBlock,
  normalizeApMode,
  setConfigureBlock,
  writeAccess,
  writeBlockCode,
  writeBlockMessage,
  WIFI_CONFIG_CAPABILITY,
} from '#services/wifi_config/registry'
import {
  activeRollout,
  createRollout,
  restoreRevisionDraft,
  rolloutStepActive,
} from '#services/wifi_config/rollouts'
import { fleetKey } from '#services/wifi_config/secrets'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import {
  apConfigQueue,
  FLEET,
  fleetQueue,
  hasOpenApApply,
  inFlightApApply,
  loadApSections,
  refreshApSyncState,
  saveApStates,
  statesAfter,
  writeApRevision,
} from '#services/wifi_config/store'
import type { CountryMode, WifiHealth } from '#services/wifi_config/types'
import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Admin operations on one AP's plane (docs/design/wifi controller.md
 * sections 4 and 7.2; the gateway's `gateway_config_service.ts` on AP rows):
 * modes and Authoritative Mode, the country policy, sync status with the
 * fleet's blockers, conflicts, drift, scope, drafts, revisions, the rejoin
 * offer and radio edits. Per-AP work runs in the AP's queue; anything that
 * starts a rollout goes through the fleet queue first (lock order fleet →
 * AP).
 */

export async function findApConfig(apId: number): Promise<ApConfig> {
  const ap = await ApConfig.find(apId)
  if (!ap) throw wifiError(404, 'ap_not_found', `No access point with id ${apId}.`)
  return ap
}

async function verifyPassword(user: User, password: string | undefined): Promise<boolean> {
  if (!password) return false
  return hash.verify(user.password, password)
}

function authoritativeOf(ap: ApConfig): boolean {
  return normalizeApMode(ap.mode) === 'managed' && Boolean(ap.authoritative)
}

/** Re-sends `agent.configure` with the AP's block (mode, Authoritative, settings). */
export async function pushApConfigure(ap: ApConfig): Promise<void> {
  const settings = await getWifiConfigSettings()
  await fleetKey()
  const session = apSession(ap.apId)
  if (session && !session.capabilities.includes(WIFI_CONFIG_CAPABILITY)) {
    clearConfigureBlock(ap.apId)
    return
  }
  setConfigureBlock(ap, settings)
  const row = await WifiAccessPoint.find(ap.apId)
  if (row) sendAgentConfigure(row)
}

// ── PATCH /wifi/config/aps/:apId ─────────────────────────────────────────

export type ApPatch = {
  mode?: 'off' | 'observe' | 'managed'
  authoritative?: boolean
  expectRevision?: number
  currentPassword?: string
  country?: { mode: CountryMode; code?: string | null }
  trunk?: string | null
}

const TRUNK = /^[A-Za-z0-9._-]{1,15}$/

/**
 * Mode changes (off → observe needs the AP's `read`; → managed needs its
 * `write`, a writable transport, the boot guard, no device-groups window,
 * and the step-up password; down is always allowed), Authoritative Mode
 * (ON only in sync, fleet blockers included), the country policy (written
 * by a one-AP `radios` rollout unless `?apply=0`) and the trunk override.
 * Entering managed starts the AP's adopt jobs (ledger only) at once.
 */
export async function patchAp(
  apId: number,
  user: User,
  patch: ApPatch,
  options: { apply: boolean; adminAddress?: string | null }
): Promise<WriteOutcome<ApConfig>> {
  return fleetQueue.run(FLEET, async () => {
    const ap = await findApConfig(apId)
    const from = normalizeApMode(ap.mode)
    const to = patch.mode ?? from
    const needsPassword = (to === 'managed' && from !== 'managed') || patch.authoritative === true
    if (needsPassword && !(await verifyPassword(user, patch.currentPassword))) {
      throw wifiError(403, 'invalid_password', 'Confirm with your current password.')
    }
    if (patch.trunk !== undefined && patch.trunk !== null && !TRUNK.test(patch.trunk)) {
      throw wifiError(422, 'trunk_invalid', 'That is not a port name.')
    }
    if (patch.country?.mode === 'fixed') {
      const code = (patch.country.code ?? '').toUpperCase()
      if (!/^[A-Z]{2}$/.test(code))
        throw wifiError(422, 'country_invalid', 'That is not a country code.')
    }
    let enteredManaged = false
    if (to !== from) {
      await changeMode(ap, from, to, user)
      enteredManaged = to === 'managed'
    }
    if (patch.authoritative === true && !ap.authoritative) {
      await enableAuthoritative(ap, user, patch.expectRevision)
    } else if (patch.authoritative === false && ap.authoritative) {
      await apConfigQueue.run(apId, async () => {
        ap.authoritative = false
        ap.authoritativeSince = null
        ap.authoritativeByUserId = null
        ap.pinnedHashes = null
        await ap.save()
        await recordApEvent(apId, 'authoritative_changed', {
          userId: user.id,
          detail: { authoritative: false },
        })
      })
      await pushApConfigure(ap)
      await readAndReconcileAp(apId, { reason: 'authoritative_off' }).catch(() => undefined)
    }
    if (patch.trunk !== undefined) {
      ap.trunkOverride = patch.trunk
      await ap.save()
    }
    let rollout: WifiRollout | null = null
    let rolloutError: WriteOutcome<ApConfig>['rolloutError'] = null
    if (patch.country) {
      await setApCountry(apId, patch.country, user)
      const renders = new Map<number, RenderOutcome>()
      const outcome = await renderApDraft(apId, { actor: user.id })
      if (outcome) renders.set(apId, outcome)
      const after = await loadApSections(apId)
      const radioIds = after.states
        .filter((s) => s.domain === WIFI_RADIOS_DOMAIN && s.status === 'ahead')
        .map((s) => s.perchId)
      const started = await rolloutRenders(renders, {
        apply: options.apply && normalizeApMode(ap.mode) === 'managed',
        actor: user.id,
        kind: 'radios',
        adminAddress: options.adminAddress,
        extra: new Map([[apId, radioIds]]),
      })
      rollout = started.rollout
      rolloutError = started.rolloutError
    }
    if (enteredManaged) {
      const started = await startAdopt(apId, user.id)
      if (!rollout) rollout = started
    }
    await ap.refresh()
    await refreshApSyncState(ap)
    return { object: ap, issues: [], rollout, rolloutError }
  })
}

async function changeMode(
  ap: ApConfig,
  from: 'off' | 'observe' | 'managed',
  to: 'off' | 'observe' | 'managed',
  user: User
) {
  const apId = ap.apId
  const settings = await getWifiConfigSettings()
  if (from === 'managed') {
    if (await hasOpenApApply(apId)) {
      throw wifiError(409, 'apply_in_flight', 'Wait for the running change to finish.')
    }
    if (await rolloutStepActive(apId)) {
      const active = await activeRollout()
      throw wifiError(409, 'rollout_running', 'A rollout is changing this access point.', {
        id: active ? Number(active.id) : null,
      })
    }
  }
  const session = apSession(apId)
  if (to !== 'off' && !session) {
    throw wifiError(409, 'agent_offline', 'The access point’s agent is not connected.')
  }
  const capable = Boolean(session?.block) && session!.capabilities.includes(WIFI_CONFIG_CAPABILITY)
  if (to === 'managed') {
    if (capable) await fetchApCapabilities(ap).catch(() => undefined)
    if (session?.block?.groups?.state === 'pending_confirm') {
      throw wifiError(409, 'groups_active', 'Device groups are applying a change on this AP.')
    }
    const access = writeAccess(ap, settings)
    if (!access.writable) {
      if (access.reason === 'guard_missing') {
        throw wifiError(409, 'guard_missing', writeBlockMessage('guard_missing'))
      }
      if (access.reason === 'not_paired' || access.reason === 'insecure_transport') {
        throw wifiError(409, access.reason, writeBlockMessage(access.reason))
      }
    }
  }
  const refusal = checkModeChange(from, to, {
    hasCapability: capable,
    routerAccess: session?.block?.access ?? (ap.agentAccess as 'none' | 'read' | 'write' | null),
    transportOk: true,
    passwordVerified: true,
  })
  if (refusal === 'router_access_insufficient') {
    throw wifiError(
      409,
      'router_access_insufficient',
      `The access point allows '${session?.block?.access ?? 'none'}' access; raise it with perch-apd wifi access.`
    )
  }
  if (refusal === 'no_capability') {
    throw wifiError(409, 'no_capability', 'This perch-apd has no Wi-Fi plane: update it.')
  }
  await apConfigQueue.run(apId, async () => {
    ap.mode = to
    if (to !== 'managed' && ap.authoritative) {
      ap.authoritative = false
      ap.authoritativeSince = null
      ap.authoritativeByUserId = null
    }
    if (to === 'off') {
      ap.syncState = 'unknown'
      ap.fleetState = 'unknown'
    }
    // A managed AP renders from scratch (its fingerprint names `managed`).
    ap.renderFingerprint = null
    await ap.save()
    await recordApEvent(apId, 'mode_changed', { userId: user.id, detail: { from, to } })
  })
  await pushApConfigure(ap)
  if (to !== 'off') {
    try {
      await readAndReconcileAp(apId, { reason: 'mode' })
    } catch (error) {
      if (!(error instanceof ApOfflineError)) throw error
    }
  }
}

/**
 * Entering managed (controller.md 4.3 step 7): the adopt jobs (ledger
 * entries only, no change on the AP) go out at once as a one-AP `adopt`
 * rollout. With another rollout active they go with the next one.
 */
async function startAdopt(apId: number, userId: number): Promise<WifiRollout | null> {
  if (await activeRollout()) return null
  try {
    return await createRollout({
      kind: 'adopt',
      actor: userId,
      targets: new Map([[apId, null]]),
      note: 'Adopt the access point’s sections',
    })
  } catch (error) {
    if (error instanceof WifiPlaneError) return null
    throw error
  }
}

/** The fleet's own blockers of "in sync" (controller.md 4.5). */
async function fleetBlockers(ap: ApConfig): Promise<SyncStatus['blockers']> {
  const out: SyncStatus['blockers'] = []
  const open = await WifiDivergence.query().where('ap_id', ap.apId).whereNull('resolved_at')
  for (const d of open) {
    out.push({
      kind: 'feature',
      feature: 'fleet',
      objectId: String(d.id),
      code: 'divergence_open',
      message: `${d.kind === 'option' ? `${d.option} differs` : d.kind} on this access point`,
    })
  }
  if (normalizeApMode(ap.mode) === 'managed') {
    const settings = await getWifiConfigSettings()
    const input = await renderInputOf(ap, await loadFleet(), settings)
    const render = renderAp(input)
    if (render.fingerprint !== ap.renderFingerprint || render.edits.length > 0) {
      out.push({
        kind: 'feature',
        feature: 'fleet',
        objectId: null,
        code: 'render_pending',
        message: 'The fleet’s networks have not been written into this AP’s draft yet.',
      })
    }
  }
  return out
}

export async function syncStatusOfAp(ap: ApConfig): Promise<SyncStatus> {
  const { states } = await loadApSections(ap.apId)
  const registry = registryFor(ap)
  const status = computeSyncStatus({
    mode: normalizeApMode(ap.mode),
    online: apSession(ap.apId) !== null,
    enforcement: ap.enforcement === 'suspended' ? 'suspended' : 'active',
    headRevision: ap.headRevision,
    observedAt: ap.observedAt?.toISO() ?? null,
    applyInFlight: await hasOpenApApply(ap.apId),
    luciPending: ap.observedState?.luciPending ?? false,
    uncommitted: ap.observedState?.uncommitted ?? [],
    sections: states,
    unledgered: computeUnledgered(states, ap.observedLedger ?? []),
    registry,
    features: featureSyncIssues(registry, states, {}),
  })
  const extra = await fleetBlockers(ap)
  return {
    ...status,
    blockers: [...status.blockers, ...extra],
    inSync: status.inSync && extra.length === 0,
  }
}

/** `GET …/sync-status?fresh=` (config-plane.md 5.4 plus the fleet's blockers). */
export async function syncStatusAp(apId: number, fresh: boolean): Promise<SyncStatus> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    if (fresh) {
      if (!apSession(apId)) {
        throw wifiError(409, 'agent_offline', 'The access point’s agent is not connected.')
      }
      if (normalizeApMode(ap.mode) !== 'off') {
        await readAndReconcileAp(apId, { reason: 'sync_status' })
        await ap.refresh()
      }
    }
    return syncStatusOfAp(ap)
  })
}

async function enableAuthoritative(ap: ApConfig, user: User, expectRevision: number | undefined) {
  if (normalizeApMode(ap.mode) !== 'managed') {
    throw wifiError(409, 'not_managed', 'Authoritative Mode needs managed mode.')
  }
  if (expectRevision === undefined) {
    throw wifiError(422, 'expect_revision_required', 'Send the head revision you reviewed.')
  }
  if (!apSession(ap.apId)) {
    throw wifiError(409, 'agent_offline', 'The access point’s agent is not connected.')
  }
  if ((await inFlightApApply(ap.apId)) !== null) {
    throw wifiError(409, 'apply_in_flight', 'Wait for the running change to finish.')
  }
  if (await rolloutStepActive(ap.apId)) {
    throw wifiError(409, 'rollout_running', 'A rollout is changing this access point.')
  }
  const outcome = await readAndReconcileAp(ap.apId, { reason: 'enable_authoritative' })
  await apConfigQueue.run(ap.apId, async () => {
    await ap.refresh()
    const status = await syncStatusOfAp(ap)
    const check = checkEnableAuthoritative(status, expectRevision)
    if (!check.ok) {
      if (check.error === 'sync_changed') {
        throw wifiError(409, 'sync_changed', 'The configuration changed since you looked.', {
          blockers: check.blockers,
          headRevision: check.headRevision,
        })
      }
      throw wifiError(409, 'not_in_sync', 'Both sides must be in sync first.', {
        blockers: check.blockers,
      })
    }
    const pinned = Object.fromEntries(outcome.read.configs.map((c) => [c.name, c.hash]))
    await db.transaction(async (trx) => {
      const locked = await ApConfig.query({ client: trx })
        .where('ap_id', ap.apId)
        .forUpdate()
        .firstOrFail()
      locked.authoritative = true
      locked.authoritativeSince = DateTime.utc()
      locked.authoritativeByUserId = user.id
      locked.pinnedHashes = pinned
      locked.enforcement = 'active'
      await locked.save()
      await recordApEvent(ap.apId, 'authoritative_changed', {
        userId: user.id,
        revision: status.headRevision,
        detail: { authoritative: true },
        trx,
      })
    })
    await ap.refresh()
  })
  await pushApConfigure(ap)
}

// ── refresh and health ───────────────────────────────────────────────────

export async function refreshAp(apId: number): Promise<{
  capabilities: unknown
  observedAt: string | null
  changedConfigs: string[]
  health: WifiHealth | null
}> {
  const ap = await findApConfig(apId)
  if (!apSession(apId)) {
    throw wifiError(409, 'agent_offline', 'The access point’s agent is not connected.')
  }
  const capabilities = await apConfigQueue.run(apId, () => fetchApCapabilities(ap))
  if (normalizeApMode(ap.mode) === 'off') {
    throw wifiError(409, 'mode_off', 'Turn the access point to observe or managed first.', {
      capabilities,
    })
  }
  const outcome: ApReadOutcome = await readAndReconcileAp(apId, { reason: 'refresh' })
  const health = await fetchApHealth(ap).catch(() => null)
  return {
    capabilities,
    observedAt: outcome.observedAt,
    changedConfigs: outcome.changedConfigs,
    health,
  }
}

/** `GET …/health?fresh=1`: the stored report, or the AP's now. */
export async function healthAp(apId: number, fresh: boolean): Promise<WifiHealth | null> {
  const ap = await findApConfig(apId)
  if (!fresh) return ap.health
  if (!apSession(apId)) {
    throw wifiError(409, 'agent_offline', 'The access point’s agent is not connected.')
  }
  try {
    return await fetchApHealth(ap)
  } catch (error) {
    const code = agentErrorCode(error)
    if (code) throw wifiError(502, code, (error as Error).message)
    throw error
  }
}

// ── rows: conflicts, drift, scope, draft, revisions ──────────────────────

function requireManaged(ap: ApConfig) {
  if (normalizeApMode(ap.mode) !== 'managed') {
    throw wifiError(409, 'not_managed', 'The access point is not managed by Perch.')
  }
}

async function saveWithRevision(
  ap: ApConfig,
  loaded: Awaited<ReturnType<typeof loadApSections>>,
  changes: Array<{ perchId: string; after: SectionState | null }>,
  revision: { source: 'router' | 'merge'; userId: number; confirmed: boolean } | null
): Promise<number | null> {
  const now = DateTime.utc()
  let number: number | null = null
  await db.transaction(async (trx) => {
    await saveApStates(ap.apId, loaded.rows, changes, { userId: revision?.userId, now, trx })
    if (revision) {
      ap.useTransaction(trx)
      number = await writeApRevision(ap, {
        before: loaded.states,
        after: statesAfter(loaded.states, changes),
        source: revision.source,
        actor: revision.userId,
        confirmed: revision.confirmed,
        now,
        trx,
      })
    }
  })
  await refreshApSyncState(ap)
  return number
}

export type ResolveSectionItem = {
  perchId: string
  take: 'router' | 'controller' | 'custom'
  options?: Record<string, UciValue | null>
}

/** `POST …/sections/resolve` (conflicts, config-plane.md 5.2). */
export async function resolveApSections(
  apId: number,
  userId: number,
  items: ResolveSectionItem[]
): Promise<string[]> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    requireManaged(ap)
    const loaded = await loadApSections(apId)
    const registry = registryFor(ap)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const item of items) {
      const state = loaded.states.find((s) => s.perchId === item.perchId)
      if (!state || !state.conflict) continue
      let resolution: ConflictResolution
      if (item.take === 'custom') {
        const options: Record<string, OptionResolution> = {}
        for (const [name, value] of Object.entries(item.options ?? {})) {
          options[name] = { take: 'custom', value }
        }
        resolution = { take: 'custom', options }
      } else {
        resolution = { take: item.take }
      }
      const next = resolveConflict(state, resolution, {
        authoritative: authoritativeOf(ap),
        rules: registry.rules(state.domain),
      })
      if (!next) {
        throw wifiError(422, 'resolution_incomplete', `Decide every option of ${state.name}.`, {
          perchId: state.perchId,
          options: state.conflict.options.map((o) => o.name),
        })
      }
      changes.push({ perchId: state.perchId, after: isGone(next) ? null : next })
    }
    if (changes.length === 0) {
      throw wifiError(409, 'nothing_to_resolve', 'None of these sections is in conflict.')
    }
    const revision = await saveWithRevision(ap, loaded, changes, {
      source: 'merge',
      userId,
      confirmed: true,
    })
    for (const change of changes) {
      await recordApEvent(apId, 'conflict_resolved', {
        userId,
        revision,
        detail: {
          perchId: change.perchId,
          take: items.find((i) => i.perchId === change.perchId)!.take,
        },
      })
    }
    return changes.map((c) => c.perchId)
  })
}

export async function acceptApDrift(apId: number, userId: number, perchIds?: string[]) {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    const loaded = await loadApSections(apId)
    const registry = registryFor(ap)
    const changes = loaded.states
      .filter((s) => s.status === 'drift' && (!perchIds || perchIds.includes(s.perchId)))
      .map((s) => ({
        perchId: s.perchId,
        after: acceptDrift(s, { rules: registry.rules(s.domain) }),
      }))
    if (changes.length === 0) throw wifiError(409, 'no_drift', 'Nothing has drifted.')
    const revision = await saveWithRevision(ap, loaded, changes, {
      source: 'router',
      userId,
      confirmed: true,
    })
    for (const change of changes) {
      await recordApEvent(apId, 'drift_accepted', {
        userId,
        revision,
        detail: { perchId: change.perchId },
      })
    }
    return changes.map((c) => c.perchId)
  })
}

export async function revertApDriftNow(
  apId: number,
  userId: number,
  perchIds?: string[]
): Promise<ApConfigApply> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    requireManaged(ap)
    if (ap.enforcement === 'suspended') {
      throw wifiError(409, 'enforcement_suspended', 'Resume enforcement first.')
    }
    const { states } = await loadApSections(apId)
    const drifted = states
      .filter((s) => s.status === 'drift' && (!perchIds || perchIds.includes(s.perchId)))
      .map((s) => s.perchId)
    if (drifted.length === 0) throw wifiError(409, 'no_drift', 'Nothing has drifted.')
    if (await hasOpenApApply(apId)) {
      throw wifiError(409, 'apply_in_flight', 'Wait for the running change to finish.')
    }
    const access = writeAccess(ap, await getWifiConfigSettings())
    if (!access.writable) {
      throw wifiError(409, writeBlockCode(access.reason), writeBlockMessage(access.reason))
    }
    const apply = await startApRevert(ap, drifted, userId)
    if (!apply) throw wifiError(409, 'no_drift', 'Nothing to revert.')
    emitWifiAlert({
      name: 'wifi.drift.detected',
      severity: 'info',
      source: { kind: 'ap', id: apId },
      dedupeKey: `wifi.drift.detected:${apId}:${apply.applyKey}`,
      payload: { apId, perchIds: drifted, revertAt: DateTime.utc().toISO() },
    })
    return apply
  })
}

export async function resumeApEnforcement(apId: number, userId: number): Promise<ApConfig> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    if (ap.enforcement !== 'active') {
      ap.enforcement = 'active'
      ap.enforcementChangedAt = DateTime.utc()
      await ap.save()
      await recordApEvent(apId, 'enforcement_resumed', { userId })
    }
    return ap
  })
}

/**
 * `PATCH …/sections/:perchId {scope}`: a synced section becomes router-only
 * (its link to a network goes too), or an excluded one is synced again.
 */
export async function setApSectionScope(
  apId: number,
  userId: number,
  perchId: string,
  scope: 'synced' | 'excluded'
): Promise<void> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    const loaded = await loadApSections(apId)
    const state = loaded.states.find((s) => s.perchId === perchId)
    if (!state) throw wifiError(404, 'section_not_found', `No section ${perchId}.`)
    if (state.scope === scope) return
    if (state.scope === 'unmodeled') {
      throw wifiError(409, 'unmodeled', 'No domain models this section; it stays router-only.')
    }
    const flight = await inFlightApApply(apId)
    if (flight?.perchIds.includes(perchId)) {
      throw wifiError(409, 'pending_apply', 'A change carrying this section is running.')
    }
    if (state.router === null) {
      throw wifiError(409, 'not_on_router', 'The section does not exist on the access point yet.')
    }
    const next: SectionState = {
      ...state,
      scope,
      base: cloneContent(state.router),
      desired: cloneContent(state.router),
      conflict: null,
      driftSince: null,
      status: 'in_sync',
    }
    next.status = deriveStatus(next, { authoritative: authoritativeOf(ap) })
    await saveWithRevision(ap, loaded, [{ perchId, after: next }], null)
    if (scope === 'excluded') {
      await WifiIfaceLink.query().where('ap_id', apId).where('perch_id', perchId).delete()
    }
    await recordApEvent(apId, scope === 'excluded' ? 'section_excluded' : 'section_included', {
      userId,
      detail: { perchId, config: state.config, section: state.name },
    })
  })
}

/** `DELETE …/draft {perchIds?}`: C := B where Perch moved. */
export async function discardApDraft(
  apId: number,
  actor: PlaneActor,
  perchIds?: string[]
): Promise<number> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    const loaded = await loadApSections(apId)
    const flight = await inFlightApApply(apId)
    const registry = registryFor(ap)
    const changes: Array<{ perchId: string; after: SectionState | null }> = []
    for (const s of loaded.states) {
      if (s.scope !== 'synced' || s.conflict) continue
      if (perchIds && !perchIds.includes(s.perchId)) continue
      if (flight?.perchIds.includes(s.perchId)) continue
      const rules = registry.rules(s.domain)
      if (contentsEqual(s.desired, s.base, rules)) continue
      if (s.base === null && s.router === null) {
        changes.push({ perchId: s.perchId, after: null })
        continue
      }
      const next: SectionState = { ...s, desired: cloneContent(s.base) }
      next.status = deriveStatus(next, { authoritative: authoritativeOf(ap), rules })
      changes.push({ perchId: s.perchId, after: next })
    }
    if (changes.length > 0) {
      await saveWithRevision(ap, loaded, changes, null)
      const dropped = changes.filter((c) => c.after === null).map((c) => c.perchId)
      if (dropped.length > 0) {
        await WifiIfaceLink.query().where('ap_id', apId).whereIn('perch_id', dropped).delete()
      }
      await recordApEvent(apId, 'draft_discarded', {
        actor,
        detail: { perchIds: changes.map((c) => c.perchId) },
      })
    }
    return changes.length
  })
}

/**
 * `POST …/revisions/:number/restore[?apply=0]`: C := the snapshot, and a
 * one-AP rollout unless `?apply=0`.
 */
export async function restoreApRevision(
  apId: number,
  user: User,
  number: number,
  options: { apply: boolean; adminAddress?: string | null }
): Promise<{
  perchIds: string[]
  rollout: WifiRollout | null
  rolloutError: WriteOutcome<null>['rolloutError']
}> {
  return fleetQueue.run(FLEET, async () => {
    const ap = await findApConfig(apId)
    requireManaged(ap)
    const perchIds = await restoreRevisionDraft(apId, number, user.id)
    if (!options.apply || perchIds.length === 0) {
      return {
        perchIds,
        rollout: null,
        rolloutError:
          perchIds.length === 0
            ? { error: 'nothing_to_apply', message: 'That revision is what the draft holds.' }
            : null,
      }
    }
    try {
      const rollout = await createRollout({
        kind: 'change',
        actor: user.id,
        targets: new Map([[apId, perchIds]]),
        note: `Restore revision ${number}`,
        adminAddress: options.adminAddress,
      })
      return { perchIds, rollout, rolloutError: null }
    } catch (error) {
      if (error instanceof WifiPlaneError) {
        return {
          perchIds,
          rollout: null,
          rolloutError: { error: error.code, message: error.message },
        }
      }
      throw error
    }
  })
}

// ── rejoin (controller.md 4.6) ───────────────────────────────────────────

export async function rejoinAp(
  apId: number,
  user: User,
  use: 'fleet' | 'revision',
  options: { adminAddress?: string | null }
): Promise<WifiRollout> {
  return fleetQueue.run(FLEET, async () => {
    const ap = await findApConfig(apId)
    const offer = ap.rejoinOffer
    if (!offer) throw wifiError(409, 'no_rejoin_offer', 'There is nothing to restore.')
    if (await activeRollout()) {
      const active = await activeRollout()
      throw wifiError(409, 'rollout_running', 'Another rollout is still going.', {
        id: Number(active!.id),
      })
    }
    let perchIds: string[] | null = null
    if (use === 'revision') {
      if (offer.revision === null) {
        throw wifiError(409, 'no_rejoin_offer', 'No confirmed revision to restore.')
      }
      perchIds = await restoreRevisionDraft(apId, offer.revision, user.id)
    } else {
      // The current fleet render: the AP's divergences are settled for the
      // fleet (a removed slot comes back as a new section).
      const open = await WifiDivergence.query().where('ap_id', apId).whereNull('resolved_at')
      for (const d of open) {
        if (d.kind === 'removed' && d.perchId) {
          await WifiIfaceLink.query().where('ap_id', apId).where('perch_id', d.perchId).delete()
        }
        d.resolvedAt = DateTime.utc()
        d.resolution = 'revert'
        d.resolvedByUserId = user.id
        await d.save()
      }
      await renderApDraft(apId, { actor: user.id })
    }
    ap.rejoinOffer = null
    await ap.save()
    await recordApEvent(apId, 'revision_restored', {
      userId: user.id,
      revision: use === 'revision' ? offer.revision : null,
      detail: { rejoin: use },
    })
    return createRollout({
      kind: 'rejoin',
      actor: user.id,
      targets: new Map([[apId, perchIds]]),
      note: use === 'revision' ? `Rejoin: revision ${offer.revision}` : 'Rejoin: the fleet',
      adminAddress: options.adminAddress,
    })
  })
}

export async function dismissApRejoin(apId: number, userId: number): Promise<ApConfig> {
  return apConfigQueue.run(apId, async () => {
    const ap = await findApConfig(apId)
    if (ap.rejoinOffer) {
      ap.rejoinOffer = null
      await ap.save()
      await recordApEvent(apId, 'rejoin_dismissed', { userId })
    }
    return ap
  })
}

// ── radios (controller.md 7.2) ───────────────────────────────────────────

export type RadioPatch = {
  channelMode?: 'auto' | 'fixed'
  channel?: number
  allowed?: number[] | null
  width?: number
  txpower?: { mode: 'auto' | 'fixed'; dbm?: number }
  enabled?: boolean
}

/**
 * `PATCH …/radios/:section[?apply=0]`: one radio's channel, width, power or
 * on/off, through the `wifi_radios` domain into the AP's draft, validated
 * with the AP's capabilities, then a one-AP `radios` rollout.
 */
export async function patchRadio(
  apId: number,
  section: string,
  patch: RadioPatch,
  user: User,
  options: { apply: boolean; adminAddress?: string | null }
): Promise<WriteOutcome<string>> {
  return fleetQueue.run(FLEET, async () => {
    const ap = await findApConfig(apId)
    const perchId = await apConfigQueue.run(apId, async () => {
      const loaded = await loadApSections(apId)
      const row = loaded.states.find(
        (s) => s.config === 'wireless' && s.name === section && s.domain === WIFI_RADIOS_DOMAIN
      )
      if (!row || row.desired === null) {
        throw wifiError(404, 'radio_not_found', `No radio ${section}.`)
      }
      requireManaged(ap)
      const caps = (ap.capabilities?.radios ?? []).find((r) => r.section === section)
      if (caps && !caps.present) throw wifiError(409, 'radio_absent', `${section} has no hardware.`)
      if (row.conflict) throw wifiError(409, 'conflict_open', 'Resolve the open conflict first.')
      const flight = await inFlightApApply(apId)
      if (flight?.perchIds.includes(row.perchId)) {
        throw wifiError(409, 'pending_apply', 'A change carrying this radio is running.')
      }
      const domain = wifiRadiosDomain(ap.capabilities)
      const current = {
        perchId: row.perchId,
        config: row.config,
        name: row.name,
        type: row.desired.type,
        anonymous: row.anonymous,
        options: { ...row.desired.options },
        ...(row.desired.secrets ? { secrets: { ...row.desired.secrets } } : {}),
      }
      const [obj] = domain.parse([current])
      if (patch.channelMode === 'auto') {
        obj.channelMode = 'auto'
        obj.channel = null
      } else if (patch.channelMode === 'fixed' || patch.channel !== undefined) {
        if (patch.channel === undefined && obj.channel === null) {
          throw wifiError(422, 'invalid_channel', 'Pick a channel.')
        }
        obj.channelMode = 'fixed'
        if (patch.channel !== undefined) obj.channel = patch.channel
      }
      if (patch.allowed !== undefined) {
        obj.allowed =
          patch.allowed === null ? null : [...new Set(patch.allowed)].sort((a, b) => a - b)
      }
      if (patch.width !== undefined) obj.width = patch.width
      if (patch.txpower !== undefined) {
        obj.txpower =
          patch.txpower.mode === 'auto'
            ? { mode: 'auto', dbm: null }
            : { mode: 'fixed', dbm: patch.txpower.dbm ?? obj.txpower.dbm ?? null }
      }
      if (patch.enabled !== undefined) obj.enabled = patch.enabled
      const edits = domain.render(obj, [current])
      const { planSectionEdits } = await import('#services/gateway_config/apply_plan')
      const planned = planSectionEdits({
        rows: loaded.states,
        edits,
        domain: WIFI_RADIOS_DOMAIN,
        registry: registryFor(ap),
        authoritative: authoritativeOf(ap),
        newPerchId: () => {
          throw new Error('a radio edit never creates a section')
        },
      })
      const candidate = statesAfter(
        loaded.states,
        planned.upserts.map((u) => ({ perchId: u.perchId, after: u }))
      )
      const errors = validateApStates(ap, candidate).filter(
        (i) => i.severity === 'error' && i.perchId === row.perchId
      )
      if (errors.length > 0) {
        const code = ['invalid_channel', 'invalid_width', 'width_channel'].includes(errors[0].code)
          ? errors[0].code
          : 'invalid_config'
        throw wifiError(422, code, errors[0].message, { issues: errors })
      }
      if (planned.upserts.length > 0) {
        await saveApStates(
          apId,
          loaded.rows,
          planned.upserts.map((u) => ({ perchId: u.perchId, after: u })),
          { userId: user.id }
        )
        await recordApEvent(apId, 'draft_edited', {
          userId: user.id,
          detail: { domain: WIFI_RADIOS_DOMAIN, perchIds: [row.perchId] },
        })
        await refreshApSyncState(ap)
      }
      return row.perchId
    })
    const { states } = await loadApSections(apId)
    const row = states.find((s) => s.perchId === perchId)!
    const issues = validateApStates(ap, states).filter((i) => i.perchId === perchId)
    if (!options.apply || row.status !== 'ahead') {
      return {
        object: section,
        issues,
        rollout: null,
        rolloutError:
          options.apply && row.status !== 'ahead'
            ? { error: 'nothing_to_apply', message: 'Nothing changes on the access point.' }
            : null,
      }
    }
    try {
      const rollout = await createRollout({
        kind: 'radios',
        actor: user.id,
        targets: new Map([[apId, [perchId]]]),
        adminAddress: options.adminAddress,
      })
      return { object: section, issues, rollout, rolloutError: null }
    } catch (error) {
      if (error instanceof WifiPlaneError) {
        return {
          object: section,
          issues,
          rollout: null,
          rolloutError: { error: error.code, message: error.message },
        }
      }
      throw error
    }
  })
}
