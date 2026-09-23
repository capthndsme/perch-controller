import ApGroupState, { type ApGroupStation } from '#models/ap_group_state'
import DeviceGroup from '#models/device_group'
import DeviceGroupKey from '#models/device_group_key'
import DeviceGroupMember from '#models/device_group_member'
import WifiAccessPoint from '#models/wifi_access_point'
import hub, { AgentOfflineError, AgentRpcError } from '#services/ap_agent_hub'
import { getDeviceGroupSettings } from '#services/device_group_settings'
import { listGatewayNetworks } from '#services/gateway_config/networks_service'
import encryption from '@adonisjs/core/services/encryption'
import logger from '@adonisjs/core/services/logger'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * The device groups' Wi-Fi on the access points (perch-apd `groups.*`,
 * docs/gateway/device-groups.md section 7).
 *
 * Every AP whose agent offers `wifi_groups` gets the same desired state: the
 * group SSIDs (Settings → Device groups), the VLAN of every group with a
 * network, a station per group passphrase and one per group with bound
 * members (a binding: the MACs keep the SSID's own passphrase). A changed
 * state gets the AP's next revision; the AP applies it and waits for a
 * confirm, which this side sends once the agent is still (or again)
 * connected a moment after the reload, else the AP rolls back by itself.
 * Devices bound by a portal sign-in are kicked once their AP confirmed, so
 * they rejoin in the group's VLAN.
 *
 * Runs on changes (requestApGroupsSync, debounced), on every agent connect
 * (onApAgentReady) and every two minutes (the sweep task). One AP at a time
 * per AP.
 */

export type ApGroupsDesired = {
  confirmSeconds: number
  trunk: string
  ssids: string[]
  vlans: Array<{ vid: number }>
  stations: Array<{ key?: string; vid: number; macs?: string[] }>
}

const timings = {
  debounceMs: 300,
  /** After an apply: wait this long, check the agent, then confirm. */
  confirmDelayMs: 15_000,
  applyTimeoutMs: 90_000,
}

/** Tests: shorter waits. */
export function _setApGroupsTimings(patch: Partial<typeof timings>): void {
  Object.assign(timings, patch)
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** The VLAN id of every group network, per gateway. */
async function groupVlans(): Promise<Map<number, number>> {
  const out = new Map<number, number>() // group id → vid
  const groups = await DeviceGroup.query().whereNotNull('networkPerchId')
  const byGateway = new Map<number, DeviceGroup[]>()
  for (const g of groups) byGateway.set(g.gatewayId, [...(byGateway.get(g.gatewayId) ?? []), g])
  for (const [gatewayId, list] of byGateway) {
    let networks: Awaited<ReturnType<typeof listGatewayNetworks>> = []
    try {
      networks = await listGatewayNetworks(gatewayId)
    } catch (error) {
      logger.debug({ gatewayId, err: error }, 'ap_groups: networks unavailable')
    }
    for (const g of list) {
      const vid = networks.find((n) => n.perchId === g.networkPerchId)?.vlanId ?? null
      if (vid !== null) out.set(g.id, vid)
    }
  }
  return out
}

/** The state every AP should hold (without its revision and trunk). */
export async function desiredApGroups(): Promise<Omit<ApGroupsDesired, 'trunk'>> {
  const settings = await getDeviceGroupSettings()
  if (settings.ssids.length === 0) {
    return { confirmSeconds: settings.confirmSeconds, ssids: [], vlans: [], stations: [] }
  }
  const vlanOf = await groupVlans()
  const vids = [...new Set(vlanOf.values())].sort((a, b) => a - b)
  const stations: ApGroupsDesired['stations'] = []
  for (const k of await DeviceGroupKey.query().orderBy('id')) {
    const vid = vlanOf.get(k.groupId)
    if (vid === undefined) continue
    const key = encryption.decrypt<string>(k.passphraseEncrypted)
    if (typeof key !== 'string') {
      logger.warn({ keyId: k.id }, 'ap_groups: a Wi-Fi key cannot be decrypted; left out')
      continue
    }
    stations.push({ key, vid })
  }
  const members = await DeviceGroupMember.query().orderBy('mac')
  const bound = new Map<number, string[]>()
  for (const m of members) {
    if (!vlanOf.has(m.groupId)) continue
    bound.set(m.groupId, [...(bound.get(m.groupId) ?? []), m.mac])
  }
  for (const [groupId, macs] of [...bound.entries()].sort((a, b) => a[0] - b[0])) {
    stations.push({ vid: vlanOf.get(groupId)!, macs })
  }
  return {
    confirmSeconds: settings.confirmSeconds,
    ssids: settings.ssids,
    vlans: vids.map((vid) => ({ vid })),
    stations,
  }
}

function supported(ap: WifiAccessPoint): boolean {
  const caps = (ap.agentInfo as { capabilities?: unknown } | null)?.capabilities
  return Array.isArray(caps) && caps.includes('wifi_groups')
}

async function stateOf(apId: number): Promise<ApGroupState> {
  const row = await ApGroupState.find(apId)
  if (row) return row
  return ApGroupState.create({ apId, revision: 0, state: 'idle', converted: false })
}

type ApStateReport = {
  appliedRevision?: number
  pending?: { revision: number; deadline: string } | null
  lastRollback?: { revision: number; at: string; reason: string } | null
  trunkPort?: string
  stations?: ApGroupStation[]
  issues?: string[]
}

type ApApplyResult = {
  revision: number
  state: 'pending_confirm' | 'noop'
  deadline?: string
  trunkPort?: string
  converted?: boolean
  issues?: string[]
}

function errorText(error: unknown): string {
  if (error instanceof AgentRpcError) {
    const data = error.data as { error?: string } | undefined
    return `${data?.error ?? error.code}: ${error.message}`.slice(0, 500)
  }
  return String(error instanceof Error ? error.message : error).slice(0, 500)
}

/** MACs to kick once their AP confirmed a binding (portal sign-ins). */
const pendingKicks = new Set<string>()
const queues = new Map<number, Promise<void>>()
const confirmTimers = new Map<number, NodeJS.Timeout>()
let debounce: NodeJS.Timeout | null = null

/** Runs work for one AP after what is queued for it. */
function onAp(apId: number, work: () => Promise<void>): Promise<void> {
  const prev = queues.get(apId) ?? Promise.resolve()
  const next = prev.then(work).catch((error) => {
    logger.warn({ apId, err: error }, 'ap_groups: sync failed')
  })
  queues.set(apId, next)
  void next.then(() => {
    if (queues.get(apId) === next) queues.delete(apId)
  })
  return next
}

/** Asks for every connected AP's state to be brought in line (debounced). */
export function requestApGroupsSync(reason: string, options: { kick?: string[] } = {}): void {
  for (const mac of options.kick ?? []) pendingKicks.add(mac.toLowerCase())
  logger.debug({ reason, kick: options.kick }, 'ap_groups: sync requested')
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    void syncAllApGroups()
  }, timings.debounceMs)
  debounce.unref()
}

/** Every connected agent. */
export async function syncAllApGroups(): Promise<void> {
  const ids = hub.onlineIds()
  await Promise.all(ids.map((id) => onAp(id, () => syncAp(id))))
}

/** After an agent's `system.info`: its groups state follows. */
export function onApAgentReady(apId: number): void {
  void onAp(apId, () => syncAp(apId))
}

async function syncAp(apId: number): Promise<void> {
  const ap = await WifiAccessPoint.find(apId)
  if (!ap || !hub.isOnline(apId)) return
  const st = await stateOf(apId)
  if (!supported(ap)) {
    if (st.state !== 'unsupported') {
      st.state = 'unsupported'
      await st.save()
    }
    return
  }
  const base = await desiredApGroups()
  const desired: ApGroupsDesired = { ...base, trunk: st.trunkOverride ?? 'auto' }
  const fingerprint = sha256(desired)

  let report: ApStateReport
  try {
    report = await hub.request<ApStateReport>(apId, 'groups.state', {}, { timeoutMs: 15_000 })
  } catch (error) {
    if (error instanceof AgentOfflineError) return
    st.state = 'failed'
    st.error = errorText(error)
    await st.save()
    return
  }
  st.trunkPort = report.trunkPort ?? st.trunkPort
  st.stations = Array.isArray(report.stations) ? report.stations : []
  st.reportedAt = DateTime.utc()

  // An apply this side sent and the agent still holds: confirm it now (the
  // agent answered, so it reaches the controller), then carry on.
  if (report.pending) {
    if (report.pending.revision === st.revision) {
      await confirm(apId, st)
    } else {
      // Not ours (a controller restart lost track): let it roll back.
      st.state = 'waiting'
      st.error = `revision ${report.pending.revision} is waiting on the AP; it rolls back by itself`
      await st.save()
      return
    }
  } else if (st.state === 'pending_confirm' && report.lastRollback?.revision === st.revision) {
    st.state = 'rolled_back'
    st.error = report.lastRollback.reason
  }

  const inLine =
    st.fingerprint === fingerprint &&
    report.appliedRevision === st.revision &&
    (st.state === 'applied' || st.state === 'pending_confirm')
  if (!inLine) {
    const revision = Math.max(st.revision, report.appliedRevision ?? 0) + 1
    st.revision = revision
    st.fingerprint = fingerprint
    st.state = 'sending'
    st.error = null
    await st.save()
    let result: ApApplyResult
    try {
      result = await hub.request<ApApplyResult>(
        apId,
        'groups.apply',
        { ...desired, revision },
        { timeoutMs: timings.applyTimeoutMs }
      )
    } catch (error) {
      st.state = error instanceof AgentOfflineError ? 'offline' : 'failed'
      st.error = errorText(error)
      await st.save()
      return
    }
    st.trunkPort = result.trunkPort ?? st.trunkPort
    st.converted = Boolean(result.converted)
    if (result.state === 'noop') {
      st.state = 'applied'
      st.appliedRevision = revision
      await st.save()
    } else {
      st.state = 'pending_confirm'
      await st.save()
      scheduleConfirm(apId, revision)
      return
    }
  } else {
    await st.save()
  }
  await kick(apId, st)
}

/** A moment after the reload: if the agent is still there, keep the apply. */
function scheduleConfirm(apId: number, revision: number): void {
  const prev = confirmTimers.get(apId)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    confirmTimers.delete(apId)
    void onAp(apId, async () => {
      const st = await ApGroupState.find(apId)
      if (!st || st.revision !== revision || st.state !== 'pending_confirm') return
      if (!hub.isOnline(apId)) return // the reconnect confirms (syncAp)
      try {
        await hub.request(apId, 'ping', {}, { timeoutMs: 10_000 })
      } catch {
        return // no answer: the reconnect confirms, or the AP rolls back
      }
      await confirm(apId, st)
      await kick(apId, st)
    })
  }, timings.confirmDelayMs)
  timer.unref()
  confirmTimers.set(apId, timer)
}

async function confirm(apId: number, st: ApGroupState): Promise<void> {
  try {
    await hub.request(apId, 'groups.confirm', { revision: st.revision }, { timeoutMs: 15_000 })
    st.state = 'applied'
    st.appliedRevision = st.revision
    st.error = null
  } catch (error) {
    st.state = 'failed'
    st.error = errorText(error)
  }
  await st.save()
}

/** Kicks the bound devices waiting for this AP (not associated here = ignored). */
async function kick(apId: number, st: ApGroupState): Promise<void> {
  if (pendingKicks.size === 0 || st.state !== 'applied') return
  for (const mac of [...pendingKicks]) {
    try {
      await hub.request(apId, 'client.kick', { mac, banTimeMs: 0 }, { timeoutMs: 10_000 })
      pendingKicks.delete(mac)
      logger.info({ apId, mac }, 'ap_groups: kicked a bound device into its VLAN')
    } catch (error) {
      // -32002: not on this AP. Another AP may have it.
      if (!(error instanceof AgentRpcError)) {
        logger.debug({ apId, mac, err: error }, 'ap_groups: kick failed')
      }
    }
  }
}

/** Tests: forget timers and queues. */
export function _resetApGroupsState(): void {
  if (debounce) clearTimeout(debounce)
  debounce = null
  for (const t of confirmTimers.values()) clearTimeout(t)
  confirmTimers.clear()
  queues.clear()
  pendingKicks.clear()
}

export type ApGroupStateView = {
  apId: number
  name: string
  online: boolean
  supported: boolean
  state: string
  revision: number
  appliedRevision: number | null
  trunkPort: string | null
  trunkOverride: string | null
  converted: boolean
  error: string | null
  stations: ApGroupStation[]
  reportedAt: string | null
}

/** GET /device-groups/aps */
export async function listApGroupStates(): Promise<ApGroupStateView[]> {
  const aps = await WifiAccessPoint.query().where('transport', 'agent').orderBy('name')
  const states = await ApGroupState.query()
  return aps.map((ap) => {
    const st = states.find((s) => s.apId === ap.id)
    return {
      apId: ap.id,
      name: ap.friendlyName ?? ap.name,
      online: hub.isOnline(ap.id),
      supported: supported(ap),
      state: st?.state ?? (supported(ap) ? 'idle' : 'unsupported'),
      revision: st?.revision ?? 0,
      appliedRevision: st?.appliedRevision ?? null,
      trunkPort: st?.trunkPort ?? null,
      trunkOverride: st?.trunkOverride ?? null,
      converted: Boolean(st?.converted),
      error: st?.error ?? null,
      stations: st?.stations ?? [],
      reportedAt: st?.reportedAt ? st.reportedAt.toUTC().toISO() : null,
    }
  })
}

/** PATCH /device-groups/aps/:apId `{trunk}`: the port towards the gateway, null = detect. */
export async function setApTrunk(apId: number, trunk: string | null): Promise<ApGroupStateView> {
  const ap = await WifiAccessPoint.find(apId)
  if (!ap) throw new Error('ap_not_found')
  const st = await stateOf(apId)
  st.trunkOverride = trunk
  await st.save()
  onApAgentReady(apId)
  const view = (await listApGroupStates()).find((v) => v.apId === apId)!
  return view
}
