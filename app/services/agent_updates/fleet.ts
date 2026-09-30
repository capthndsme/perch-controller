import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import AgentUpdateJob from '#models/agent_update_job'
import AgentUpdateRollout, {
  OPEN_ROLLOUT_STATES,
  type RolloutState,
} from '#models/agent_update_rollout'
import AgentUpdateRolloutDevice from '#models/agent_update_rollout_device'
import { loadAllDevices, reportOf, type DeviceHandle } from '#services/agent_updates/devices'
import { artefactPath, downloadKey, wireDeviceKey } from '#services/agent_updates/download_tokens'
import { githubState } from '#services/agent_updates/github'
import {
  jobSummary,
  selfUpdateSupport,
  type AgentUpdateJobSummary,
} from '#services/agent_updates/jobs'
import { MANIFEST_SCHEMA_VERSION, type AgentProduct } from '#services/agent_updates/manifest'
import { notOfferableReason, releaseManifest } from '#services/agent_updates/releases'
import type { UpdateMethod } from '#services/agent_updates/report'
import type { AgentUpdateSettings, AutoUpdate, Channel } from '#services/agent_updates/settings'
import { binaryArtefactFor, deviceTarget, selectArtefacts } from '#services/agent_updates/targets'
import { compareVersions } from '#services/agent_updates/versions'
import { windowView } from '#services/agent_updates/window'
import { perchVersions } from '#services/perch_version'
import { instanceTimezone } from '#services/usage_history'
import { DateTime } from 'luxon'

/**
 * The fleet view (agent-updates controller.md sections 9.1 and 9.3): every
 * device's version, self-update support, channel, what it could update to,
 * its open and last job, and for agents that cannot update themselves the
 * exact one-time command. Read per request; nothing is cached.
 */

export type InstallKindView = 'package' | 'swapped' | 'unowned' | 'manual' | 'docker' | 'other'

export type ManualCommand = {
  title: string
  targetVersion: string
  command: string
  expiresAt: string | null
  notes: string[]
}

export type AgentUpdateDeviceView = {
  key: string
  kind: 'ap' | 'collector'
  id: number
  name: string
  role: 'ap' | 'gateway' | 'collector'
  product: AgentProduct
  online: boolean
  secure: boolean | null
  version: string | null
  versionState: 'current' | 'update_available' | 'below_controller' | 'unknown'
  selfUpdate: {
    supported: boolean
    reason: string | null
    installKind: InstallKindView | null
    methods: UpdateMethod[]
    packageManager: 'opkg' | 'apk' | null
    packageVersion: string | null
    packageRecordStale: boolean
    openwrtRelease: string | null
    arch: string | null
    pkgArch: string | null
    flash: { fsType: string; freeBytes: number; totalBytes: number } | null
    floor: string | null
    guard: 'installed' | 'missing' | 'outdated' | null
    previous: { version: string; store: 'flash' } | null
    reportedAt: string | null
  }
  channel: Channel
  channelSetting: Channel | null
  autoUpdate: AutoUpdate
  autoUpdateSetting: 'inherit' | AutoUpdate
  pinnedVersion: string | null
  available: {
    version: string
    releaseId: number
    channel: Channel
    method: UpdateMethod
    downloadBytes: number
    newerThanController: boolean
  } | null
  activeJob: AgentUpdateJobSummary | null
  lastJob: AgentUpdateJobSummary | null
  manualCommand: ManualCommand | null
  /**
   * The open rollout that still has to update this device (pending or running
   * there): `state` is the rollout's, `deviceState` the device's in it. Manual
   * updates are refused meanwhile (`rollout_owns_device`).
   */
  rollout: RolloutMembership | null
}

export type RolloutMembership = {
  id: number
  state: RolloutState
  deviceState: 'pending' | 'running'
  isCanary: boolean
}

export type FleetContext = {
  settings: AgentUpdateSettings
  releases: AgentRelease[]
  artefacts: Map<number, AgentArtefact[]>
  /** Base URL agents and admins reach this controller at (manual commands). */
  controllerUrl: string | null
  now: DateTime
}

const CHANNEL_SEES: Record<Channel, readonly Channel[]> = {
  stable: ['stable'],
  pre: ['stable', 'pre'],
  local: ['stable', 'pre', 'local'],
}

export function effectiveChannel(device: DeviceHandle, settings: AgentUpdateSettings): Channel {
  return device.settings?.channel ?? settings.defaultChannel
}

export function effectiveAutoUpdate(
  device: DeviceHandle,
  settings: AgentUpdateSettings
): AutoUpdate {
  const own = device.settings?.autoUpdate ?? 'inherit'
  if (own !== 'inherit') return own
  return device.kind === 'ap' ? settings.autoUpdateAp : settings.autoUpdateCollector
}

function controllerPin(product: AgentProduct): string {
  const versions = perchVersions()
  return product === 'perch-apd' ? versions.apdVersion : versions.collectorVersion
}

export type Offer = {
  release: AgentRelease
  method: UpdateMethod
  artefacts: AgentArtefact[]
  downloadBytes: number
}

/**
 * Releases the device could take, newest first: on its channel, offerable,
 * newer than it runs, at or above its floor, installable over its version
 * (`minFromVersion`), readable by its updater, with artefacts for its target.
 * A pinned ("hold at") device is offered nothing.
 */
export function offersFor(device: DeviceHandle, context: FleetContext): Offer[] {
  const support = selfUpdateSupport(device)
  if (!support.supported) return []
  const report = support.report
  if (device.settings?.pinnedVersion) return []
  const channel = effectiveChannel(device, context.settings)
  const target = deviceTarget(device.product, report, device.arch)
  const offers: Offer[] = []
  for (const release of context.releases) {
    if (release.product !== device.product) continue
    if (!CHANNEL_SEES[channel].includes(release.channel)) continue
    if (notOfferableReason(release)) continue
    if (compareVersions(release.version, device.version) <= 0) continue
    if (report.floor && compareVersions(release.version, report.floor) < 0) continue
    if (release.minFromVersion && compareVersions(device.version, release.minFromVersion) < 0) {
      continue
    }
    if (report.protocol < MANIFEST_SCHEMA_VERSION) continue
    const artefacts = context.artefacts.get(release.id) ?? []
    const selection = selectArtefacts(artefacts, releaseManifest(release), target)
    if (!selection.ok) continue
    offers.push({
      release,
      method: selection.method,
      artefacts: selection.artefacts,
      downloadBytes: selection.downloadBytes,
    })
  }
  return offers.sort((a, b) => compareVersions(b.release.version, a.release.version))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const PLAIN_HTTP_NOTE =
  'This controller is reached over plain HTTP. The file is checked against its SHA-256 before ' +
  'anything is replaced, but keep devices and the controller on a management VLAN.'

/**
 * The one-time command for an agent that cannot update itself (controller.md
 * 9.3): download from this controller with a 24-hour link (or from the
 * GitHub release when the file is not stored here), check the SHA-256, then
 * the stop / replace / start the owner does by hand today.
 */
export async function manualCommandFor(
  device: DeviceHandle,
  context: FleetContext
): Promise<ManualCommand | null> {
  const report = reportOf(device)
  if (report?.installKind === 'docker') {
    return {
      title: `Update ${device.product} with Docker`,
      targetVersion: 'latest',
      command: 'docker compose pull && docker compose up -d',
      expiresAt: null,
      notes: ['Run in the directory of the compose file that starts this collector.'],
    }
  }
  if (device.kind === 'collector' && device.transport === 'poll') return null
  const channel = effectiveChannel(device, context.settings)
  const target = deviceTarget(device.product, report, device.arch)
  if (!target.arch) return null
  for (const release of context.releases) {
    if (release.product !== device.product) continue
    if (!CHANNEL_SEES[channel].includes(release.channel)) continue
    if (notOfferableReason(release)) continue
    if (device.version && compareVersions(release.version, device.version) <= 0) continue
    const binary = binaryArtefactFor(context.artefacts.get(release.id) ?? [], target)
    if (!binary) continue

    let url: string | null = null
    let expiresAt: string | null = null
    if (binary.storedPath && context.controllerUrl) {
      const exp = Math.floor(context.now.toSeconds()) + 24 * 3600
      url =
        context.controllerUrl +
        artefactPath(await downloadKey(), {
          artefactId: binary.id,
          file: binary.fileName,
          deviceKey: wireDeviceKey(device.kind, device.id),
          exp,
        })
      expiresAt = DateTime.fromSeconds(exp, { zone: 'utc' }).toISO()
    } else if (binary.sourceUrl) {
      url = binary.sourceUrl
    }
    if (!url) continue

    const program = device.product
    const binaryLine =
      device.kind === 'ap'
        ? `B=/usr/bin/${program}; [ -x "$B" ] || B=/opt/perch-apd/perch-apd`
        : `B=/usr/bin/${program}`
    const command = [
      `U=${shellQuote(url)}`,
      `S='${binary.sha256}'; ${binaryLine}`,
      `wget -qO /tmp/${program}.new "$U" && echo "$S  /tmp/${program}.new" | sha256sum -c - \\`,
      ` && cp "$B" /tmp/${program}.prev && /etc/init.d/${program} stop && rm -f "$B" \\`,
      ` && { cp /tmp/${program}.new "$B" || cp /tmp/${program}.prev "$B"; } && chmod 755 "$B" \\`,
      ` && /etc/init.d/${program} start && rm -f /tmp/${program}.new`,
    ].join('\n')
    const notes = [
      'Run as root on the device. The configuration and join credentials stay as they are.',
      `The replaced binary is kept as /tmp/${program}.prev until the next reboot.`,
    ]
    if (device.kind === 'collector') {
      notes.push('The static collector build exists for x86-64 only.')
    }
    if (context.controllerUrl?.startsWith('http://')) notes.push(PLAIN_HTTP_NOTE)
    return {
      title: `Update ${program} to ${release.version} by hand`,
      targetVersion: release.version,
      command,
      expiresAt,
      notes,
    }
  }
  return null
}

function installKindView(value: string | null): InstallKindView | null {
  return value === null ? null : (value as InstallKindView)
}

export async function deviceView(
  device: DeviceHandle,
  context: FleetContext,
  jobs: { active: AgentUpdateJob | null; last: AgentUpdateJob | null },
  rollout: RolloutMembership | null = null
): Promise<AgentUpdateDeviceView> {
  const support = selfUpdateSupport(device)
  const report = support.report
  const offers = offersFor(device, context)
  const offer = offers[0] ?? null
  const pin = controllerPin(device.product)
  let versionState: AgentUpdateDeviceView['versionState'] = 'current'
  if (!device.version || compareVersions(device.version, '0.0.0') < 0) versionState = 'unknown'
  else if (offer) versionState = 'update_available'
  else if (pin !== 'latest' && compareVersions(device.version, pin) < 0) {
    versionState = 'below_controller'
  }
  const channelSetting = device.settings?.channel ?? null
  return {
    key: device.key,
    kind: device.kind,
    id: device.id,
    name: device.name,
    role: device.role,
    product: device.product,
    online: device.online,
    secure: device.secure,
    version: device.version,
    versionState,
    selfUpdate: {
      supported: support.supported,
      reason: support.supported ? null : support.reason,
      installKind: installKindView(report?.installKind ?? null),
      methods: report?.methods ?? [],
      packageManager: report?.packageManager ?? null,
      packageVersion: report?.packageVersion ?? null,
      packageRecordStale: report?.installKind === 'swapped',
      openwrtRelease: report?.openwrt?.release ?? null,
      arch: report?.arch ?? device.arch,
      pkgArch: report?.openwrt?.pkgArch ?? null,
      flash: report?.flash
        ? {
            fsType: report.flash.fsType ?? '',
            freeBytes: report.flash.freeBytes,
            totalBytes: report.flash.totalBytes,
          }
        : null,
      floor: report?.floor ?? null,
      guard: report?.guard ?? null,
      previous: report?.previous ? { version: report.previous.version, store: 'flash' } : null,
      reportedAt: device.settings?.reportedAt?.toISO() ?? null,
    },
    channel: effectiveChannel(device, context.settings),
    channelSetting,
    autoUpdate: effectiveAutoUpdate(device, context.settings),
    autoUpdateSetting: device.settings?.autoUpdate ?? 'inherit',
    pinnedVersion: device.settings?.pinnedVersion ?? null,
    available: offer
      ? {
          version: offer.release.version,
          releaseId: offer.release.id,
          channel: offer.release.channel,
          method: offer.method,
          downloadBytes: offer.downloadBytes,
          newerThanController: pin !== 'latest' && compareVersions(offer.release.version, pin) > 0,
        }
      : null,
    activeJob: jobs.active ? jobSummary(jobs.active) : null,
    lastJob: jobs.last ? jobSummary(jobs.last) : null,
    manualCommand: support.supported ? null : await manualCommandFor(device, context),
    rollout,
  }
}

/** Device key → the open rollout that still has to update it. */
export async function rolloutMemberships(): Promise<Map<string, RolloutMembership>> {
  const open = await AgentUpdateRollout.query().whereIn('state', [...OPEN_ROLLOUT_STATES])
  const out = new Map<string, RolloutMembership>()
  if (open.length === 0) return out
  const byId = new Map(open.map((rollout) => [rollout.id, rollout]))
  const rows = await AgentUpdateRolloutDevice.query()
    .whereIn('rollout_id', [...byId.keys()])
    .whereIn('state', ['pending', 'running'])
  for (const row of rows) {
    const key = row.apId !== null ? `ap:${row.apId}` : `collector:${row.collectorId}`
    out.set(key, {
      id: row.rolloutId,
      state: byId.get(row.rolloutId)!.state,
      deviceState: row.state as 'pending' | 'running',
      isCanary: row.isCanary,
    })
  }
  return out
}

/** `AgentFleet.openRollouts`. */
export async function openRolloutSummaries(product?: AgentProduct) {
  const query = AgentUpdateRollout.query()
    .whereIn('state', [...OPEN_ROLLOUT_STATES])
    .orderBy('id')
  if (product) query.where('product', product)
  const rows = await query
  return rows.map((rollout) => ({
    id: rollout.id,
    product: rollout.product,
    version: rollout.version,
    state: rollout.state,
  }))
}

export async function fleetContext(
  settings: AgentUpdateSettings,
  controllerUrl: string | null,
  now: DateTime = DateTime.utc()
): Promise<FleetContext> {
  const releases = await AgentRelease.query().whereNull('withdrawn_at')
  releases.sort((a, b) => compareVersions(b.version, a.version))
  const artefactRows =
    releases.length === 0
      ? []
      : await AgentArtefact.query()
          .whereIn(
            'release_id',
            releases.map((release) => release.id)
          )
          .orderBy('id')
  const artefacts = new Map<number, AgentArtefact[]>()
  for (const artefact of artefactRows) {
    const list = artefacts.get(artefact.releaseId) ?? []
    list.push(artefact)
    artefacts.set(artefact.releaseId, list)
  }
  return { settings, releases, artefacts, controllerUrl, now }
}

/** The open and the latest job per device key. */
export async function jobsByDevice(devices: DeviceHandle[]) {
  const map = new Map<string, { active: AgentUpdateJob | null; last: AgentUpdateJob | null }>()
  for (const device of devices) map.set(device.key, { active: null, last: null })
  const open = await AgentUpdateJob.query().whereNotNull('active_key')
  for (const job of open) {
    const entry = job.activeKey ? map.get(job.activeKey) : undefined
    if (entry) entry.active = job
  }
  const apIds = devices.filter((d) => d.kind === 'ap').map((d) => d.id)
  const collectorIds = devices.filter((d) => d.kind === 'collector').map((d) => d.id)
  for (const [column, ids, kind] of [
    ['ap_id', apIds, 'ap'],
    ['collector_id', collectorIds, 'collector'],
  ] as const) {
    if (ids.length === 0) continue
    const latestIds = (await AgentUpdateJob.query()
      .whereIn(column, ids)
      .whereNull('active_key')
      .groupBy(column)
      .max('id as latest')
      .pojo()) as Array<{ latest: number | string }>
    const ids2 = latestIds.map((row) => Number(row.latest)).filter((id) => id > 0)
    if (ids2.length === 0) continue
    const lastJobs = await AgentUpdateJob.query().whereIn('id', ids2)
    for (const job of lastJobs) {
      const id = kind === 'ap' ? job.apId : job.collectorId
      const entry = id !== null ? map.get(`${kind}:${id}`) : undefined
      if (entry) entry.last = job
    }
  }
  return map
}

/** GET /api/v1/agent-updates/fleet (`AgentFleet`). */
export async function buildFleet(
  settings: AgentUpdateSettings,
  options: { product?: AgentProduct; controllerUrl: string | null }
) {
  const now = DateTime.utc()
  const context = await fleetContext(settings, options.controllerUrl, now)
  const all = await loadAllDevices()
  const devices = all.filter((device) => !options.product || device.product === options.product)
  const jobs = await jobsByDevice(devices)
  const memberships = await rolloutMemberships()
  const views: AgentUpdateDeviceView[] = []
  for (const device of devices) {
    views.push(
      await deviceView(
        device,
        context,
        jobs.get(device.key) ?? { active: null, last: null },
        memberships.get(device.key) ?? null
      )
    )
  }
  const github = await githubState()
  const timezone = await instanceTimezone()
  const versions = perchVersions()
  return {
    devices: views,
    summary: {
      total: views.length,
      current: views.filter((view) => view.versionState === 'current').length,
      updateAvailable: views.filter((view) => view.available !== null).length,
      updating: views.filter((view) => view.activeJob !== null).length,
      unsupported: views.filter((view) => !view.selfUpdate.supported).length,
    },
    controller: {
      version: versions.version,
      apdVersion: versions.apdVersion,
      collectorVersion: versions.collectorVersion,
    },
    lastGithubCheckAt: github.lastCheckAt,
    githubCheck: settings.githubCheck,
    window: windowView(settings, timezone, now),
    openRollouts: await openRolloutSummaries(options.product),
  }
}

/** How many devices could take each release (`AgentRelease.devicesEligible`). */
export async function eligibleCounts(settings: AgentUpdateSettings): Promise<Map<number, number>> {
  const context = await fleetContext(settings, null)
  const counts = new Map<number, number>()
  for (const device of await loadAllDevices()) {
    for (const offer of offersFor(device, context)) {
      counts.set(offer.release.id, (counts.get(offer.release.id) ?? 0) + 1)
    }
  }
  return counts
}
