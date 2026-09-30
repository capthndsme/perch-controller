import type {
  ConfigDomain,
  SecretEdit,
  SectionEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type { Issue, SectionOwnership, UciOptions, UciValue } from '#services/gateway_config/types'
import {
  groupsOwned,
  scalarOf,
  withOptions,
  wordsOf,
} from '#services/wifi_config/domains/normalize'
import type { ApCapabilities } from '#services/wifi_config/types'

/**
 * `ap_vlans` (phase 3): the VLAN plumbing of VLAN-bound SSIDs on the AP's
 * trunk bridge (docs/design/wifi controller.md section 3.3).
 *
 * Claims, in `network`: `bridge-vlan` sections on the trunk bridge (whole
 * section); `interface` sections whose `device` is that bridge or
 * `<bridge>.<vid>` (only `device` is Perch's: the AP's own IP settings stay
 * the router's), Perch's `interface perch_nv<vid>` whole; Perch's 802.1Q and
 * bridge `device` sections `perch_nd<vid>` / `perch_nb<vid>` (a trunk port
 * outside any bridge). Never the device-groups engine's sections.
 *
 * `planVlanPlumbing` renders what VLAN-bound networks need: per VID a
 * `bridge-vlan perch_nbv<vid>` with the trunk port tagged and an
 * `interface perch_nv<vid>`, reusing a VLAN the router already carries; on
 * an untagged bridge first the conversion (`perch_nbvu`, every interface on
 * the bare bridge moved onto `<bridge>.<untagged>`). The core's management
 * rules make the conversion and the uplink's bridge-vlan a protected job.
 * A conversion is never undone by the plane (undoing it is another uplink
 * change; the router keeps a working VLAN-filtering bridge).
 */

export const AP_VLANS_DOMAIN = 'ap_vlans'

const PERCH_VLAN_INTERFACE = /^perch_nv(\d{1,4})$/
const PERCH_VLAN_BRIDGE_VLAN = /^perch_nbv(\d{1,4})$/
const PERCH_UNTAGGED = 'perch_nbvu'
const PERCH_VLAN_DEVICE = /^perch_n[db](\d{1,4})$/

/** A network-config section of this domain, verbatim. */
export interface VlanSection {
  perchId: string | null
  section: string
  type: string
  options: UciOptions
  secretNames: string[]
}

export interface ApTrunkInfo {
  bridge: string | null
  port: string | null
  vlanFiltering: boolean
}

/** The trunk the plane renders onto: the admin's override wins over what the AP detected. */
export function trunkOf(caps: ApCapabilities | null, override?: string | null): ApTrunkInfo {
  return {
    bridge: caps?.trunk?.bridge ?? null,
    port: override ?? caps?.trunk?.port ?? null,
    vlanFiltering: caps?.trunk?.vlanFiltering ?? false,
  }
}

/** The VID of `<bridge>.<vid>`, or null. */
function vidOn(device: string | null, bridge: string): number | null {
  if (device === null || !device.startsWith(`${bridge}.`)) return null
  const vid = Number(device.slice(bridge.length + 1))
  return Number.isInteger(vid) && vid >= 1 && vid <= 4094 ? vid : null
}

function claimsSection(
  section: { name: string; type: string; options: UciOptions; owner?: unknown },
  trunk: ApTrunkInfo
): boolean {
  if (groupsOwned(section)) return false
  if (section.type === 'device') return PERCH_VLAN_DEVICE.test(section.name)
  if (!trunk.bridge) return false
  const device = scalarOf(section.options, 'device')
  if (section.type === 'bridge-vlan') return device === trunk.bridge
  if (section.type === 'interface') {
    return device === trunk.bridge || vidOn(device, trunk.bridge) !== null
  }
  return false
}

function ownershipOf(section: { name: string; type: string }): SectionOwnership {
  if (section.type === 'interface' && !PERCH_VLAN_INTERFACE.test(section.name)) {
    return { kind: 'options', options: ['device'] }
  }
  return { kind: 'section' }
}

function validateVlans(desired: SyncedSection[], ctx: ValidationCtx, trunk: ApTrunkInfo): Issue[] {
  const issues: Issue[] = []
  const ours = desired.filter(
    (s) =>
      s.config === 'network' &&
      (PERCH_VLAN_BRIDGE_VLAN.test(s.name) ||
        PERCH_VLAN_INTERFACE.test(s.name) ||
        PERCH_VLAN_DEVICE.test(s.name) ||
        s.name === PERCH_UNTAGGED)
  )
  if (ours.length === 0) return issues
  if (!trunk.bridge && !trunk.port) {
    for (const s of ours) {
      issues.push({
        severity: 'error',
        code: 'trunk_unknown',
        message: 'The port towards the gateway is not known: set it on the controller',
        perchId: s.perchId,
        config: s.config,
        section: s.name,
      })
    }
  }
  const everyBridgeVlan = [...ctx.all, ...(ctx.unmanaged ?? [])].filter(
    (s) => s.config === 'network' && s.type === 'bridge-vlan'
  )
  for (const s of ours.filter((x) => x.type === 'bridge-vlan')) {
    const device = scalarOf(s.options, 'device')
    const vlan = scalarOf(s.options, 'vlan')
    const others = everyBridgeVlan.filter(
      (o) =>
        o.name !== s.name &&
        scalarOf(o.options, 'device') === device &&
        scalarOf(o.options, 'vlan') === vlan
    )
    if (others.length > 0) {
      issues.push({
        severity: 'error',
        code: 'vlan_in_use',
        message: `VLAN ${vlan} is already on ${device} (${others.map((o) => o.name).join(', ')})`,
        perchId: s.perchId,
        config: s.config,
        section: s.name,
        option: 'vlan',
      })
    }
  }
  return issues
}

/** The domain for one AP: claims follow its trunk bridge. */
export function apVlansDomain(
  caps: ApCapabilities | null,
  options: { trunkOverride?: string | null } = {}
): ConfigDomain<VlanSection> {
  const trunk = trunkOf(caps, options.trunkOverride)
  return {
    key: AP_VLANS_DOMAIN,
    configs: ['network'],
    types: ['bridge-vlan', 'interface', 'device'],

    claims(section) {
      return (
        section.config === 'network' &&
        claimsSection(section as typeof section & { owner?: unknown }, trunk)
      )
    },

    ownership(section) {
      return ownershipOf(section)
    },

    normalize(type, option, value): UciValue {
      if (type === 'bridge-vlan' && option === 'ports') return [...new Set(wordsOf(value))].sort()
      if (typeof value === 'string' && (option === 'vlan' || option === 'vid')) {
        return /^\d+$/.test(value.trim()) ? String(Number(value)) : value
      }
      return value
    },

    identityKeys(section) {
      const device = scalarOf(section.options, 'device')
      if (section.type === 'bridge-vlan') {
        const vlan = scalarOf(section.options, 'vlan')
        return device !== null && vlan !== null ? [`bridge-vlan:${device}:${Number(vlan)}`] : []
      }
      if (section.type === 'device') {
        const name = scalarOf(section.options, 'name')
        return name ? [`device:${name}`] : []
      }
      return []
    },

    parse(sections) {
      return sections
        .filter((s) => s.config === 'network')
        .map((s) => ({
          perchId: s.perchId,
          section: s.name,
          type: s.type,
          options: withOptions(s.options, {}),
          secretNames: Object.keys(s.secrets ?? {}),
        }))
    },

    render(obj, current): SectionEdit[] {
      const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
      const secrets: Record<string, SecretEdit> = {}
      for (const name of obj.secretNames) {
        if (existing?.secrets?.[name]) secrets[name] = { keep: true }
      }
      return [
        {
          op: 'put',
          perchId: obj.perchId,
          config: 'network',
          type: obj.type,
          ...(obj.perchId === null ? { name: obj.section } : {}),
          options: withOptions(obj.options, {}),
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        },
      ]
    },

    validate(desired, ctx) {
      return validateVlans(desired, ctx, trunk)
    },
  }
}

// ── rendering what VLAN-bound networks need (fleet render step 7) ────────

/** A `network` config section as the planner sees it: C for synced ones, R for the rest. */
export interface NetworkRow {
  perchId: string | null
  name: string
  type: string
  options: UciOptions
  /** The owning domain (`ap_vlans` for rows the plane may edit), or null (unmodeled). */
  domain: string | null
  /** Created by the device-groups engine. */
  groups?: boolean
}

export interface VlanPlan {
  /** Edits for the `ap_vlans` domain. */
  edits: SectionEdit[]
  /** The `network` value a VLAN-bound wifi-iface uses, per VID. */
  networkFor: Record<number, string>
  /** The bridge is converted to VLAN filtering by this plan (a protected change). */
  converts: boolean
  issues: Issue[]
}

function issue(code: string, message: string, severity: Issue['severity'] = 'error'): Issue {
  return { severity, code, message, config: 'network' }
}

/**
 * The VLAN plumbing for the VIDs this AP's networks need (controller.md 3.3):
 * reuses what the router has, adds Perch's sections for the rest, removes
 * Perch's sections of VIDs no longer needed. Pure; the caller passes every
 * `network` row (synced and not) and writes the edits through the core's
 * `editSections` for the `ap_vlans` domain.
 */
export function planVlanPlumbing(input: {
  vids: number[]
  rows: NetworkRow[]
  trunk: ApTrunkInfo
}): VlanPlan {
  const vids = [...new Set(input.vids)].filter((v) => v >= 1 && v <= 4094).sort((a, b) => a - b)
  const plan: VlanPlan = { edits: [], networkFor: {}, converts: false, issues: [] }
  const { bridge, port } = input.trunk
  const rows = input.rows
  const byName = new Map(rows.map((r) => [r.name, r]))
  const put = (name: string, type: string, options: UciOptions) => {
    const row = byName.get(name)
    if (row && row.domain !== AP_VLANS_DOMAIN) {
      plan.issues.push(issue('name_taken', `${name} exists on the access point and is not Perch's`))
      return
    }
    if (row && JSON.stringify(row.options) === JSON.stringify(options)) return
    plan.edits.push({
      op: 'put',
      perchId: row?.perchId ?? null,
      config: 'network',
      type,
      ...(row ? {} : { name }),
      options,
    })
  }

  // Perch's sections no longer needed go (the conversion stays).
  for (const row of rows) {
    const m = PERCH_VLAN_BRIDGE_VLAN.exec(row.name) ?? PERCH_VLAN_INTERFACE.exec(row.name)
    const d = PERCH_VLAN_DEVICE.exec(row.name)
    const vid = m ? Number(m[1]) : d ? Number(d[1]) : null
    if (vid !== null && !vids.includes(vid) && row.domain === AP_VLANS_DOMAIN && row.perchId) {
      plan.edits.push({ op: 'delete', perchId: row.perchId })
    }
  }
  if (vids.length === 0) return plan
  if (!port && !bridge) {
    plan.issues.push(issue('trunk_unknown', 'The port towards the gateway is not known'))
    return plan
  }

  if (bridge) {
    const bridgeVlans = rows.filter(
      (r) => r.type === 'bridge-vlan' && scalarOf(r.options, 'device') === bridge
    )
    const theirs = bridgeVlans.filter(
      (r) => !PERCH_VLAN_BRIDGE_VLAN.test(r.name) && r.name !== PERCH_UNTAGGED
    )
    if (bridgeVlans.length === 0) {
      // Untagged bridge: convert it (every port untagged on the untagged VLAN).
      const bridgeDevice = rows.find(
        (r) => r.type === 'device' && scalarOf(r.options, 'name') === bridge
      )
      const ports = wordsOf(bridgeDevice?.options.ports)
      if (ports.length === 0) {
        plan.issues.push(issue('trunk_unknown', `The ports of ${bridge} are not known`))
        return plan
      }
      let untagged = 1
      while (vids.includes(untagged)) untagged++
      put(PERCH_UNTAGGED, 'bridge-vlan', {
        device: bridge,
        vlan: String(untagged),
        ports: ports.map((p) => `${p}:u*`),
      })
      for (const row of rows) {
        if (row.type !== 'interface' || scalarOf(row.options, 'device') !== bridge) continue
        if (row.domain !== AP_VLANS_DOMAIN || !row.perchId) {
          plan.issues.push(issue('vlan_unsupported', `${row.name} is on ${bridge} but not managed`))
          continue
        }
        plan.edits.push({
          op: 'put',
          perchId: row.perchId,
          config: 'network',
          type: 'interface',
          options: { ...row.options, device: `${bridge}.${untagged}` },
        })
      }
      plan.converts = true
    }
    if (!port) {
      plan.issues.push(issue('trunk_unknown', `The trunk port on ${bridge} is not known`))
      return plan
    }
    for (const vid of vids) {
      const existing = theirs.find((r) => Number(scalarOf(r.options, 'vlan')) === vid)
      if (existing?.groups) {
        plan.issues.push(
          issue(
            'vlan_in_use',
            `VLAN ${vid} is carried by the device groups on ${bridge}`,
            'warning'
          )
        )
      }
      if (!existing) {
        put(`perch_nbv${vid}`, 'bridge-vlan', {
          device: bridge,
          vlan: String(vid),
          ports: [`${port}:t`],
        })
      }
      const device = `${bridge}.${vid}`
      const routerInterface = rows.find(
        (r) =>
          r.type === 'interface' &&
          scalarOf(r.options, 'device') === device &&
          !PERCH_VLAN_INTERFACE.test(r.name) &&
          !r.groups
      )
      if (routerInterface) {
        plan.networkFor[vid] = routerInterface.name
      } else {
        put(`perch_nv${vid}`, 'interface', { proto: 'none', device })
        plan.networkFor[vid] = `perch_nv${vid}`
      }
    }
    return plan
  }

  // A trunk port outside any bridge: an 802.1Q device and a bridge per VLAN.
  for (const vid of vids) {
    const vdev = `${port}.${vid}`
    const br = `br-nv${vid}`
    put(`perch_nd${vid}`, 'device', { type: '8021q', ifname: port!, vid: String(vid), name: vdev })
    put(`perch_nb${vid}`, 'device', { type: 'bridge', name: br, ports: [vdev] })
    put(`perch_nv${vid}`, 'interface', { proto: 'none', device: br })
    plan.networkFor[vid] = `perch_nv${vid}`
  }
  return plan
}
