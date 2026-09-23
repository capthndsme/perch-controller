import { ApiError, apiErrorCode } from '@/lib/api'
import { formatMbps } from '@/lib/format-bytes'
import type {
  ApplyState,
  GatewayBrief,
  GatewayNetwork,
  NetworkIssue,
  NetworkL2Mode,
  NetworkPort,
  NetworkPurpose,
  SectionStatus,
} from '@/types/networks'

/** Networks: labels, formatting and refusal texts (docs/gateway/networks.md). */

export const L2_MODE_LABELS: Record<NetworkL2Mode, string> = {
  bridge: 'Bridge',
  bridge_vlan: 'Bridge VLAN',
  '8021q': '802.1q',
  device: 'Device',
}

export const L2_MODE_HINTS: Record<NetworkL2Mode, string> = {
  bridge: 'A bridge of its own (br-<key>) with the ports you pick.',
  bridge_vlan: 'A VLAN on an existing bridge; the ports carry it tagged or untagged.',
  '8021q': 'A kernel VLAN device on a parent interface (eth1 → eth1.<vid>).',
  device: 'The interface sits directly on one device.',
}

export const PURPOSES: Array<{ id: NetworkPurpose; label: string }> = [
  { id: 'lan', label: 'LAN' },
  { id: 'guest', label: 'Guest' },
  { id: 'iot', label: 'IoT' },
  { id: 'management', label: 'Management' },
  { id: 'custom', label: 'Custom' },
]

export function purposeLabel(purpose: string): string {
  return PURPOSES.find((p) => p.id === purpose)?.label ?? purpose
}

export function l2ModeLabel(mode: NetworkL2Mode | null): string {
  return mode ? L2_MODE_LABELS[mode] : 'Unknown'
}

/** "Bridge VLAN 30 on br-lan", "802.1q 40 on eth1", "Bridge br-guest", "Device eth2". */
export function kindLine(network: Pick<GatewayNetwork, 'l2Mode' | 'bridge' | 'vlanId' | 'parentDevice' | 'device'>): string {
  switch (network.l2Mode) {
    case 'bridge':
      return `Bridge ${network.bridge ?? network.device ?? ''}`.trim()
    case 'bridge_vlan':
      return `VLAN ${network.vlanId ?? '?'} on ${network.bridge ?? '?'}`
    case '8021q':
      return `802.1q ${network.vlanId ?? '?'}${network.parentDevice ? ` on ${network.parentDevice}` : ''}`
    case 'device':
      return `Device ${network.device ?? ''}`.trim()
    default:
      return network.device ?? 'Not in the config'
  }
}

/** `lan1:t`, `lan3:u*` (the UCI spelling, for the matrix and badges). */
export function portSpec(port: NetworkPort): string {
  return `${port.port}:${port.tagged ? 't' : 'u'}${port.pvid ? '*' : ''}`
}

/** Bits per second, as the dashboard's other rate figures ("12.4 Mbps"). */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—'
  const mbps = bps / 1_000_000
  if (Math.abs(mbps) < 0.1) return bps === 0 ? '0 Mbps' : `${Math.max(1, Math.round(bps / 1000))} kbps`
  return formatMbps(mbps)
}

export const SECTION_STATUS_LABELS: Record<SectionStatus, string> = {
  in_sync: 'In sync',
  ahead: 'Not applied yet',
  pending: 'Applying',
  conflict: 'Conflict',
  drift: 'Changed on the router',
  reverting: 'Reverting',
}

export function sectionStatusTone(status: SectionStatus | null): 'good' | 'warning' | 'critical' | 'muted' {
  switch (status) {
    case 'in_sync':
      return 'good'
    case 'ahead':
    case 'pending':
    case 'reverting':
      return 'warning'
    case 'conflict':
    case 'drift':
      return 'critical'
    default:
      return 'muted'
  }
}

export const APPLY_STATE_LABELS: Record<ApplyState, string> = {
  queued: 'Queued (the gateway is offline; it goes out when it reconnects)',
  sending: 'Sending to the gateway',
  pending_confirm: 'Applied, waiting for the confirmation',
  confirmed: 'Applied and confirmed',
  rolled_back: 'Rolled back',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
}

/** Where the config plane shows an apply's changes. */
export function applyChangesPath(gatewayId: number): string {
  return `/gateway/config/${gatewayId}?tab=changes`
}

/** Why network config fields cannot be written right now (label, purpose and capture always can). */
export function configWriteBlock(gateway: GatewayBrief | undefined): string | null {
  if (!gateway) return 'The gateway is not known to the config plane.'
  if (gateway.mode !== 'managed') {
    return 'Creating and changing networks needs the gateway in managed mode (Gateway config). Labels and capture work in any mode.'
  }
  if (!gateway.writable) {
    switch (gateway.writeBlockedReason) {
      case 'offline':
        return 'The gateway is offline: changes are stored and go out when it reconnects.'
      case 'router_access':
        return 'The router allows Perch read access only (agent access on the router).'
      case 'insecure_transport':
        return 'The gateway connects over plain HTTP without pairing: pair it under Gateway config first.'
      case 'not_paired':
        return 'Pair the gateway under Gateway config before changing its networks.'
      case 'sign_key_unknown':
        return 'The router expects signed writes with a key this controller does not have.'
      case 'no_capability':
        return 'This collector build cannot apply config.'
      default:
        return null
    }
  }
  return null
}

/** Offline gateways still take drafts (the apply queues); only these reasons stop the form. */
export function configWriteHardBlocked(gateway: GatewayBrief | undefined): boolean {
  if (!gateway || gateway.mode !== 'managed') return true
  return !gateway.writable && gateway.writeBlockedReason !== 'offline'
}

const REFUSALS: Record<string, string> = {
  not_managed: 'The gateway is not in managed mode. Labels and capture work anyway; config fields need managed mode.',
  openwrt_too_old: 'The router runs an OpenWrt release before 21.02, which lacks the `config device` syntax networks need.',
  firewall_not_managed:
    'Firewall management comes later: Perch cannot put a network into a firewall zone yet. Leave the zone empty and add the network to a zone on the router (LuCI) for now.',
  network_key_taken: 'The router already has a network section with that name.',
  dhcp_pool_exists: 'The router already has a DHCP pool for that name.',
  network_not_managed:
    'Perch does not manage this network (or its VLAN device) yet: include its sections under Gateway config → Sections, or change it on the router.',
  bridge_not_managed: 'Perch does not manage that bridge, so it cannot add ports to it.',
  bridge_exists: 'A device with that bridge name exists already.',
  port_in_use: 'That port belongs to another bridge.',
  conversion_needs_sync:
    'Turning VLANs on for this bridge moves every network on it: all of them (and the bridge) must be synced first.',
  dhcp_pool_not_managed: 'The DHCP pool is the router’s: Perch does not change it.',
  pending_apply: 'An apply carrying this network is still running. Wait for it to finish.',
  management_network:
    'This is the network the gateway reaches the controller through. Deleting it would cut Perch off from the router, so it is refused.',
  network_key_invalid: 'The key must start with a letter and use a–z, 0–9 and _ (at most 15 characters).',
  vlan_invalid: 'VLAN ids run from 1 to 4094.',
  ipv4_invalid: 'Give the router’s address with a prefix, e.g. 192.168.30.1/24 (/8 to /30).',
  port_invalid: 'A port name is not valid.',
  device_name_too_long: 'The resulting device name would be longer than 15 characters.',
  parent_device_required: 'Choose the parent device.',
  l2mode_invalid: 'That kind of network does not fit here.',
  bridge_not_found: 'That bridge does not exist on the router.',
  vlan_in_use: 'That VLAN id is already on the bridge (or is its untagged VLAN).',
  port_pvid_conflict: 'A port is already the untagged (PVID) port of another VLAN.',
  subnet_overlap: 'The address overlaps another interface’s subnet.',
  dhcp_needs_address: 'A DHCP pool needs the network to have an IPv4 address.',
  dhcp_range_invalid: 'The DHCP range is not valid.',
  dhcp_leasetime_invalid: 'The lease time is not valid (e.g. 12h, 30m, infinite).',
  dhcp_range_outside_subnet: 'The DHCP range does not fit in the subnet.',
  vlan_not_applicable: 'This kind of network has no VLAN id.',
  ports_not_applicable: 'This kind of network has no port list.',
  invalid_config: 'The change would leave an error in the config (see below).',
  admin_required: 'Only admins can change networks.',
  gateway_not_found: 'The gateway is gone.',
  network_not_found: 'The network is gone.',
  gateway_busy: 'The gateway is busy. Try again in a moment.',
}

function bodyOf(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null
  return typeof error.body === 'object' && error.body !== null ? (error.body as Record<string, unknown>) : null
}

/** A field of the refusal body (`{ error, message, …data }`). */
export function refusalDetail<T>(error: unknown, key: string): T | undefined {
  return bodyOf(error)?.[key] as T | undefined
}

/** The human line for a refusal: ours when we know the code, else the server's message. */
export function networkErrorMessage(error: unknown): string {
  const code = apiErrorCode(error)
  let text = code ? REFUSALS[code] : undefined
  if (code === 'port_in_use') {
    const port = refusalDetail<string>(error, 'port')
    const bridge = refusalDetail<string>(error, 'bridge')
    if (port) text = `Port ${port} belongs to ${bridge ?? 'another bridge'}.`
  } else if (code === 'subnet_overlap') {
    const other = refusalDetail<string>(error, 'network')
    const cidr = refusalDetail<string>(error, 'cidr')
    if (other) text = `The address overlaps ${other}${cidr ? ` (${cidr})` : ''}.`
  } else if (code === 'vlan_in_use') {
    const vid = refusalDetail<number>(error, 'vlanId')
    if (vid) text = `VLAN ${vid} is already on that bridge (or is its untagged VLAN).`
  } else if (code === 'port_pvid_conflict') {
    const port = refusalDetail<string>(error, 'port')
    const vid = refusalDetail<number>(error, 'vlanId')
    if (port) text = `Port ${port} is already the untagged port of VLAN ${vid ?? '?'}.`
  } else if (code === 'conversion_needs_sync') {
    const ids = refusalDetail<string[]>(error, 'perchIds')
    if (ids?.length) text = `${REFUSALS.conversion_needs_sync} Not synced: ${ids.join(', ')}.`
  }
  if (text) return text
  if (error instanceof ApiError && error.status === 422 && bodyOf(error)?.errors) {
    return 'Some fields are not valid.'
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** Issues carried by a refusal (`invalid_config`) or a write result. */
export function refusalIssues(error: unknown): NetworkIssue[] {
  const issues = refusalDetail<NetworkIssue[]>(error, 'issues')
  return Array.isArray(issues) ? issues : []
}

/** Vine 422 field errors, keyed by field (`dhcp.start`, `ports.0.port`). */
export function networkFieldErrors(error: unknown): Record<string, string> {
  const errors = bodyOf(error)?.errors
  if (!Array.isArray(errors)) return {}
  const out: Record<string, string> = {}
  for (const item of errors as Array<{ field?: string; message?: string }>) {
    if (item.field && item.message && !out[item.field]) out[item.field] = item.message
  }
  return out
}

export const NETWORK_KEY_PATTERN = /^[a-z][a-z0-9_]{0,14}$/

/** The first address of a CIDR's network and the size, for the pool hint ("192.168.30.0/24: .1–.254"). */
export function parseCidr(cidr: string): { address: number[]; prefix: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!m) return null
  const address = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (address.some((o) => o > 255) || prefix < 8 || prefix > 30) return null
  return { address, prefix }
}

/**
 * The address range a pool covers: OpenWrt counts `start` from the network
 * address and hands out `limit` leases. "192.168.30.100 – 192.168.30.249".
 */
export function poolRange(cidr: string | null, start: number | null, limit: number | null): string | null {
  if (!cidr || start === null || limit === null) return null
  const parsed = parseCidr(cidr)
  if (!parsed) return null
  const ip = parsed.address.reduce((acc, o) => acc * 256 + o, 0)
  const size = 2 ** (32 - parsed.prefix)
  const network = ip - (ip % size)
  const first = network + start
  const last = first + limit - 1
  const toText = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.')
  return `${toText(first)} – ${toText(last)}`
}

/** A network's name as people read it: its label, with the key when they differ. */
export function networkTitle(network: Pick<GatewayNetwork, 'label' | 'key'>): string {
  return network.label && network.label !== network.key ? network.label : network.key
}

/** Drops over the capture's lifetime worth a warning (the kernel ring overflowed). */
export function hasKernelDrops(network: GatewayNetwork): boolean {
  return (network.live?.capture?.kernelDrops ?? 0) > 0
}

/** The label of a scope-change mark on the charts (owner decision 8). */
export function scopeMarkLabel(scope: 'routed' | 'legacy'): string {
  return scope === 'routed' ? 'Routed LAN counts as LAN' : 'Legacy WAN/LAN split'
}
