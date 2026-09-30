import type { SectionState } from '#services/gateway_config/sync_engine'
import type { ConfigDiffEntry, Issue } from '#services/gateway_config/types'
import { scalarOf } from '#services/wifi_config/domains/normalize'
import { channelBlock, radioFields } from '#services/wifi_config/domains/wifi_radios'
import { wifiConfirmWindow, type WifiConfigSettings } from '#services/wifi_config/settings'
import type { ApCapabilities, ImpactAp, ImpactPreview } from '#services/wifi_config/types'

/**
 * Impact preview (docs/design/wifi controller.md section 6.3): what a
 * rollout step does to one AP before it runs: radios that restart (a
 * `wifi-device` option changes), BSSes touched, clients affected, the
 * radar-check time of a DFS radio, whether the admin's own device is there,
 * and the confirm window it gets. Pure: client counts come from the caller
 * (`stationConnectedSql()`, never raw `wifi_station_latest` rows).
 */

export interface ImpactInput {
  ap: { id: number; name: string; online: boolean; caps: ApCapabilities | null }
  /** Position in the rollout (0-based). */
  order: number
  /** The planned jobs (`planApply`) with their changes. */
  jobs: Array<{ kind: string; protected: boolean; changes: ConfigDiffEntry[] }>
  /** The AP's rows; C (desired) is what the radios will run. */
  rows: SectionState[]
  /** Connected clients per `wifi-iface` section name. */
  clientsBySection: Record<string, number>
  /** Where the requesting admin's device is connected, when known. */
  adminDevice: { apId: number; section: string | null } | null
  settings: WifiConfigSettings
}

function contentOf(row: SectionState | undefined) {
  return row ? (row.desired ?? row.router) : null
}

/**
 * The radar check a radio needs after a restart (controller.md 6.3): the
 * largest CAC of the DFS channels it may come up on: its fixed channel's
 * block at its width, or with channel `auto` every allowed DFS channel.
 */
export function cacFor(
  caps: ApCapabilities | null,
  radioSection: string,
  row: SectionState | undefined
): number {
  const radio = caps?.radios?.find((r) => r.section === radioSection)
  const content = contentOf(row)
  if (!radio || !content || radio.band !== '5g') return 0
  const f = radioFields(content.options, radio.band)
  const dfs = radio.channels.filter((c) => c.dfs && !c.disabled)
  if (dfs.length === 0) return 0
  let candidates: number[]
  if (f.channelMode === 'fixed' && f.channel !== null) {
    candidates = channelBlock(f.channel, f.width ?? 20) ?? [f.channel]
  } else {
    candidates = f.allowed ?? radio.channels.map((c) => c.channel)
  }
  return Math.max(
    0,
    ...dfs.filter((c) => candidates.includes(c.channel)).map((c) => c.cacSeconds ?? 60)
  )
}

/** One AP's impact (see the module comment). */
export function impactForAp(input: ImpactInput): ImpactAp {
  const { ap } = input
  const changes = input.jobs.flatMap((j) => j.changes)
  const wireless = changes.filter((c) => c.config === 'wireless')
  const restartsRadio = [
    ...new Set(wireless.filter((c) => c.type === 'wifi-device').map((c) => c.section)),
  ].sort()
  const byName = new Map(input.rows.filter((r) => r.config === 'wireless').map((r) => [r.name, r]))
  const radioOfIface = (section: string, change?: ConfigDiffEntry): string | null => {
    const fromRow = scalarOf(contentOf(byName.get(section))?.options ?? {}, 'device')
    if (fromRow) return fromRow
    const device = change?.options.find((o) => o.name === 'device')
    const value = device?.after ?? device?.before
    return typeof value === 'string' ? value : null
  }
  const touched = wireless.filter((c) => c.type === 'wifi-iface')
  const touchedSections = new Set(touched.map((c) => c.section))
  let clients = 0
  for (const [section, n] of Object.entries(input.clientsBySection)) {
    const radio = radioOfIface(section)
    if (touchedSections.has(section) || (radio !== null && restartsRadio.includes(radio))) {
      clients += n
    }
  }
  let dfs: ImpactAp['dfs'] = null
  for (const radio of restartsRadio) {
    const cac = cacFor(ap.caps, radio, byName.get(radio))
    if (cac > 0 && (!dfs || cac > dfs.cacSeconds)) dfs = { radio, cacSeconds: cac }
  }
  const isProtected = input.jobs.some((j) => j.protected)
  const windowSeconds = wifiConfirmWindow(input.settings, {
    protected: isProtected,
    cacAllowanceSeconds: dfs?.cacSeconds ?? 0,
    apMaxSeconds: ap.caps?.confirmMaxSeconds ?? null,
  })
  return {
    apId: ap.id,
    apName: ap.name,
    order: input.order,
    online: ap.online,
    jobs: input.jobs.map((j) => ({ kind: j.kind, protected: j.protected, changes: j.changes })),
    restartsRadio,
    touchedBss: touchedSections.size,
    clientsAffected: clients,
    dfs,
    adminDeviceHere: input.adminDevice?.apId === ap.id,
    windowSeconds,
  }
}

/**
 * The whole preview: every AP's impact in rollout order, plus warnings the
 * dashboard shows before the admin starts (offline APs, the admin's own
 * device, radar checks).
 */
export function previewImpact(
  aps: ImpactAp[],
  adminDevice: ImpactPreview['adminDevice']
): ImpactPreview {
  const warnings: Issue[] = []
  const ordered = [...aps].sort((a, b) => a.order - b.order)
  for (const ap of ordered) {
    if (!ap.online) {
      warnings.push({
        severity: 'warning',
        code: 'ap_offline',
        message: `${ap.apName} is offline: it gets the change when it is back`,
      })
    }
    if (ap.adminDeviceHere && (ap.touchedBss > 0 || ap.restartsRadio.length > 0)) {
      warnings.push({
        severity: 'warning',
        code: 'admin_device_affected',
        message: `Your device is connected to ${ap.apName}: it may drop for a moment (this AP goes last)`,
      })
    }
    if (ap.dfs) {
      warnings.push({
        severity: 'warning',
        code: 'dfs_radar_check',
        message: `${ap.apName} ${ap.dfs.radio} needs a ${ap.dfs.cacSeconds} s radar check before it transmits`,
      })
    }
  }
  return { aps: ordered, adminDevice, warnings }
}
