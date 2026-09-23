import { ApiError, apiErrorCode } from '@/lib/api'
import type {
  FirewallIssue,
  FirewallOrder,
  FirewallPathIssue,
  FirewallRule,
  FwApplyState,
  FwGateway,
  FwSectionStatus,
  PortForward,
  WanFlush,
} from '@/types/firewall'

/** Firewall: labels, formatting, order and overlap helpers, refusal texts (docs/gateway/firewall.md). */

export const SECTION_STATUS_LABELS: Record<FwSectionStatus, string> = {
  in_sync: 'In sync',
  ahead: 'Not applied yet',
  pending: 'Applying',
  conflict: 'Conflict',
  drift: 'Changed on the router',
  reverting: 'Reverting',
}

export type Tone = 'good' | 'warning' | 'critical' | 'muted' | 'info'

export function sectionStatusTone(status: FwSectionStatus | null): Tone {
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

export const APPLY_STATE_LABELS: Record<FwApplyState, string> = {
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

/** Why the firewall cannot be written right now (null = it can). */
export function firewallWriteBlock(gateway: FwGateway | undefined): string | null {
  if (!gateway) return 'The gateway is not known to the config plane.'
  if (gateway.mode !== 'managed') {
    return 'Changing the firewall needs the gateway in managed mode (Gateway config). Until then this page only shows what the router has.'
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
        return 'Pair the gateway under Gateway config before changing its firewall.'
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

/** Offline gateways still take drafts (the apply queues); only these reasons stop the forms. */
export function firewallWriteHardBlocked(gateway: FwGateway | undefined): boolean {
  if (!gateway || gateway.mode !== 'managed') return true
  return !gateway.writable && gateway.writeBlockedReason !== 'offline'
}

// ── the management path ──────────────────────────────────────────────────

/** Plain explanations of the path guard (firewall.md section 2.1). */
export const PATH_ISSUE_TEXT: Record<FirewallPathIssue, { title: string; body: string }> = {
  firewall_controller_path: {
    title: 'This rule would cut the gateway off from Perch',
    body:
      'It blocks the network the router uses to reach this controller (or the controller’s own address). Once applied, the router could not report back or confirm the change, and Perch could no longer manage it. Perch refuses such rules. Narrow it to specific devices (MACs), ports or addresses that do not include the controller, or use another zone.',
  },
  firewall_admin_path: {
    title: 'This rule would lock you out',
    body:
      'It blocks the network you are using right now from the router’s SSH or web interface (ports 22, 80, 443), or from reaching the controller through the router. You would lose the way to undo it. Perch refuses such rules. Leave those ports out, or narrow the rule to other devices.',
  },
}

export function pathIssueOf(code: string | null): FirewallPathIssue | null {
  return code === 'firewall_controller_path' || code === 'firewall_admin_path' ? code : null
}

// ── refusals ─────────────────────────────────────────────────────────────

const REFUSALS: Record<string, string> = {
  not_managed: 'The gateway is not in managed mode. The firewall can be read, but changes need managed mode.',
  not_synced:
    'This entry belongs to the router (excluded or observed only). Include it under Gateway config → Sections before changing it here.',
  pending_apply: 'An apply carrying this is still running. Wait for it to finish.',
  invalid_config: 'The change would leave an error in the firewall (see below).',
  admin_required: 'Only admins can see and change the firewall.',
  gateway_not_found: 'The gateway is gone.',
  gateway_busy: 'The gateway is busy. Try again in a moment.',
  agent_offline: 'The gateway agent is not connected.',
  firewall_port_taken: 'Another enabled port forward already uses that external port.',
  device_no_lease:
    'The device has no current DHCP lease, so Perch cannot reserve an address for it. Wait until it is online, or forward to a fixed address instead.',
  dhcp_host_exists:
    'The router already has a DHCP host entry for this device that Perch does not manage. Include it under Gateway config → Sections, or forward to its address.',
  firewall_dest_not_reserved:
    'No DHCP reservation holds that address, so the device could get another one and the forward would point at nothing. Pick the device instead (Perch reserves its address), or tick “The address is static”.',
  firewall_port_invalid: 'A port or range is not valid (1–65535, low–high).',
  firewall_zone_unknown: 'That firewall zone does not exist on the router.',
  firewall_ip_invalid: 'An address does not parse.',
  firewall_dest_required: 'Pick the device or give the address to forward to.',
  port_forward_not_found: 'The port forward is gone (deleted on the router?).',
  firewall_order_incomplete: 'The order changed meanwhile (a rule came or went). Reload and try again.',
  firewall_controller_path: PATH_ISSUE_TEXT.firewall_controller_path.body,
  firewall_admin_path: PATH_ISSUE_TEXT.firewall_admin_path.body,
  firewall_rule_unsupported:
    'Perch does not create that kind of rule: rules need a source zone (no output rules), and ports need TCP or UDP.',
  invalid_mac: 'A MAC address is not valid.',
  firewall_rule_not_found: 'The rule is gone (deleted on the router?).',
  firewall_rule_perch_block: 'This rule belongs to the per-device internet block: change it from the device’s page.',
  nothing_to_resolve: 'There is nothing to resolve any more.',
  wan_block_self: 'This device is one Perch depends on; blocking it would cut Perch off.',
  wan_block_router_owned:
    'The router’s perch_block_wan set is excluded or observed only. Include it under Gateway config → Sections first.',
  firewall_no_wan_zone: 'The firewall has no WAN zone, so there is nothing to block.',
  gateway_ambiguous: 'Several gateways are managed: pick one.',
}

function bodyOf(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null
  return typeof error.body === 'object' && error.body !== null ? (error.body as Record<string, unknown>) : null
}

/** A field of the refusal body (`{ error, message, …data }`). */
export function refusalDetail<T>(error: unknown, key: string): T | undefined {
  return bodyOf(error)?.[key] as T | undefined
}

/**
 * The human line for a refusal: ours when we know the code, else the server's
 * message. `nameOf` turns a perch id into the name of a forward or rule.
 */
export function firewallErrorMessage(error: unknown, nameOf?: (id: string) => string | null): string {
  const code = apiErrorCode(error)
  let text = code ? REFUSALS[code] : undefined
  if (code === 'firewall_port_taken') {
    const id = refusalDetail<string>(error, 'id')
    const name = id ? (nameOf?.(id) ?? id) : null
    if (name) text = `The external port is already forwarded by “${name}”. Two forwards on one port never both work (the first one wins).`
  } else if (code === 'wan_block_self') {
    const server = error instanceof Error ? error.message : ''
    text = `${server || REFUSALS.wan_block_self} Blocking the controller, an access point or the computer you are using would cut Perch (or you) off from the network.`
  }
  if (text) return text
  if (error instanceof ApiError && error.status === 422 && bodyOf(error)?.errors) {
    return 'Some fields are not valid.'
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** Issues carried by a refusal (`invalid_config`). */
export function refusalIssues(error: unknown): FirewallIssue[] {
  const issues = refusalDetail<FirewallIssue[]>(error, 'issues')
  return Array.isArray(issues) ? issues : []
}

/** Vine 422 field errors, keyed by field. */
export function firewallFieldErrors(error: unknown): Record<string, string> {
  const errors = bodyOf(error)?.errors
  if (!Array.isArray(errors)) return {}
  const out: Record<string, string> = {}
  for (const item of errors as Array<{ field?: string; message?: string }>) {
    if (item.field && item.message && !out[item.field]) out[item.field] = item.message
  }
  return out
}

// ── formatting ───────────────────────────────────────────────────────────

/** `['tcp','udp']` → "TCP+UDP"; `[]`/`all` → "Any". */
export function formatProto(proto: string[]): string {
  if (proto.length === 0 || proto.includes('all')) return 'Any'
  return proto.map((p) => p.toUpperCase()).join('+')
}

/** "80", "8000–8010". */
export function formatPorts(value: string | null): string {
  if (!value) return ''
  return value
    .split(/\s+/)
    .map((p) => p.replace(/[-:]/, '–'))
    .join(', ')
}

/** A zone as people read it: `*` is any zone, null the router itself. */
export function zoneLabel(zone: string | null, side: 'src' | 'dest'): string {
  if (zone === '*') return 'any zone'
  if (zone === null) return side === 'dest' ? 'this router' : 'this router (output)'
  return zone
}

export function ruleTitle(rule: Pick<FirewallRule, 'name' | 'sync'>): string {
  return rule.name || rule.sync.section
}

export function forwardTitle(forward: Pick<PortForward, 'name' | 'sync'>): string {
  return forward.name || forward.sync.section
}

/** "TCP 22 from 02:00:00:00:00:01, 192.168.1.0/24 · IPv4". */
export function ruleMatchSummary(rule: FirewallRule): string {
  const parts: string[] = []
  const proto = formatProto(rule.proto)
  const ports = rule.destPort ? ` ${formatPorts(rule.destPort)}` : ''
  parts.push(proto === 'Any' && !ports ? 'Any protocol' : `${proto}${ports}`)
  if (rule.srcPort) parts.push(`from port ${formatPorts(rule.srcPort)}`)
  const from = [...rule.srcMac, ...rule.srcIp]
  if (rule.ipset) from.push(`set ${rule.ipset}`)
  if (from.length) parts.push(`from ${from.slice(0, 3).join(', ')}${from.length > 3 ? ` +${from.length - 3}` : ''}`)
  if (rule.destIp.length) parts.push(`to ${rule.destIp.slice(0, 3).join(', ')}${rule.destIp.length > 3 ? ` +${rule.destIp.length - 3}` : ''}`)
  if (rule.family && rule.family !== 'any') parts.push(rule.family === 'ipv6' || rule.family === '6' ? 'IPv6' : 'IPv4')
  return parts.join(' · ')
}

export function targetTone(target: string): Tone {
  const t = target.toUpperCase()
  if (t === 'ACCEPT') return 'good'
  if (t === 'REJECT' || t === 'DROP') return 'critical'
  return 'muted'
}

/** Why a conntrack flush did not run (firewall.md section 5). */
export function flushReasonText(flush: WanFlush): string {
  switch (flush.reason) {
    case 'capability_missing':
      return 'the collector on the router cannot flush connections (update it)'
    case 'offline':
      return 'the gateway was offline'
    case 'no_address':
      return 'Perch knows no address of this device'
    default:
      return flush.reason ?? 'unknown reason'
  }
}

// ── ports and overlaps ───────────────────────────────────────────────────

export const PORT_PATTERN = /^\d{1,5}([-:]\d{1,5})?$/

/** "80" → [80, 80]; "8000-8010" / "8000:8010" → [8000, 8010]; invalid → null. */
export function parsePortRange(value: string | null | undefined): [number, number] | null {
  if (!value) return null
  const m = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(value.trim())
  if (!m) return null
  const lo = Number(m[1])
  const hi = m[2] ? Number(m[2]) : lo
  if (lo < 1 || hi > 65535 || hi < lo) return null
  return [lo, hi]
}

/** Every range in a (possibly space-separated) port value. */
function rangesOf(value: string | null): Array<[number, number]> {
  if (!value) return []
  return value
    .split(/\s+/)
    .map((p) => parsePortRange(p))
    .filter((r): r is [number, number] => r !== null)
}

function rangesMeet(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  // No port = every port.
  if (a.length === 0 || b.length === 0) return true
  return a.some(([alo, ahi]) => b.some(([blo, bhi]) => alo <= bhi && blo <= ahi))
}

function protosMeet(a: string[], b: string[]): boolean {
  const norm = (p: string[]) => (p.length === 0 || p.includes('all') ? ['tcp', 'udp'] : p)
  const x = norm(a)
  return norm(b).some((p) => x.includes(p))
}

/**
 * Enabled forwards in the same source zone whose protocols and external ports
 * meet the candidate's: the server refuses such a write (409
 * `firewall_port_taken`), so the dialog warns first.
 */
export function overlappingForwards(
  candidate: { id?: string; proto: string[]; externalPort: string | null; srcZone: string | null },
  forwards: PortForward[],
): PortForward[] {
  return forwards.filter(
    (f) =>
      f.id !== candidate.id &&
      f.enabled &&
      (f.srcZone ?? 'wan') === (candidate.srcZone ?? 'wan') &&
      protosMeet(f.proto, candidate.proto) &&
      rangesMeet(rangesOf(f.externalPort), rangesOf(candidate.externalPort)),
  )
}

/** The first port of an external range, for sorting. */
export function firstPort(value: string | null): number {
  return rangesOf(value)[0]?.[0] ?? Number.MAX_SAFE_INTEGER
}

// ── order ────────────────────────────────────────────────────────────────

/**
 * The list as the router will have it once Perch's order is applied: items in
 * file order, the slots of synced members refilled in `desired` order (the
 * agent's `order` op moves synced sections within the slots they occupy
 * together; router-owned ones keep theirs). Members missing from `desired`
 * keep their place.
 */
export function orderedForDisplay<T extends { id: string; position: number | null; sync: { scope: string } }>(
  items: T[],
  desired: string[] | null,
): T[] {
  const inFile = [...items].sort(
    (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
  )
  if (!desired || desired.length === 0) return inFile
  const byId = new Map(inFile.map((i) => [i.id, i]))
  const members = inFile.filter((i) => i.sync.scope === 'synced' && desired.includes(i.id))
  const queue = desired.filter((id) => members.some((m) => m.id === id)).map((id) => byId.get(id)!)
  let next = 0
  return inFile.map((item) => (members.includes(item) ? queue[next++] : item))
}

/** The ids a reorder sends: every synced member once, in the new list's order. */
export function syncedIds<T extends { id: string; sync: { scope: string } }>(list: T[]): string[] {
  return list.filter((i) => i.sync.scope === 'synced').map((i) => i.id)
}

/**
 * Moves a synced item up or down past the next synced neighbour; router-owned
 * items stay where they are (the router keeps their slots).
 */
export function moveSynced<T extends { id: string; sync: { scope: string } }>(
  list: T[],
  id: string,
  direction: -1 | 1 | 'top' | 'bottom',
): T[] {
  const slots = list.map((item, i) => (item.sync.scope === 'synced' ? i : -1)).filter((i) => i >= 0)
  const members = slots.map((i) => list[i])
  const at = members.findIndex((m) => m.id === id)
  if (at < 0) return list
  const target =
    direction === 'top' ? 0 : direction === 'bottom' ? members.length - 1 : Math.min(members.length - 1, Math.max(0, at + direction))
  if (target === at) return list
  const [moved] = members.splice(at, 1)
  members.splice(target, 0, moved)
  const out = [...list]
  slots.forEach((slot, i) => {
    out[slot] = members[i]
  })
  return out
}

export const ORDER_STATUS_TEXT: Record<FirewallOrder['status'], string> = {
  in_sync: 'The router has this order.',
  ahead: 'Perch’s order is not on the router yet: the next apply of these entries moves them.',
  conflict: 'The order was changed both here and on the router.',
  drift: 'The order was changed on the router; Authoritative Mode puts Perch’s order back.',
}
