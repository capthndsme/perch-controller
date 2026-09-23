import { ApiError, apiErrorCode } from '@/lib/api'
import { refusalDetail } from '@/lib/networks'
import type { DhcpOptionsInput, DhcpOptionsView } from '@/types/gateway-native'

/** Helpers of the native-sync pages (DHCP, DNS, Routing, System). */

const REFUSALS: Record<string, string> = {
  not_managed: 'The gateway is not in managed mode (Gateway → Configuration).',
  not_synced: 'That object is the router’s: include it under Configuration → Sections first.',
  pending_apply: 'An apply carrying this is still running. Wait for it to finish.',
  admin_required: 'Only admins can change the router’s configuration.',
  gateway_busy: 'The gateway is busy. Try again in a moment.',
  invalid_config: 'The change would leave an error in the config (see below).',
  dhcp_pool_not_found: 'That DHCP pool is gone.',
  dhcp_tag_exists: 'The dhcp config already has a section of that name.',
  dhcp_tag_invalid: 'A tag name is 1–32 letters, digits or _.',
  dhcp_tag_in_use: 'Reservations still carry this tag. Remove it from them first.',
  dhcp_dns_invalid: 'A DNS server must be an IPv4 address.',
  dhcp_ntp_invalid: 'An NTP server must be an IPv4 address (DHCP option 42).',
  dhcp_gateway_invalid: 'The gateway must be an IPv4 address.',
  dhcp_domain_invalid: 'That is not a domain name.',
  dhcp_option_invalid: 'Option codes run 1–254; 3, 6, 15 and 42 have their own fields.',
  dhcp_range_outside_subnet: 'The range does not fit the network’s subnet.',
  dhcp_leasetime_invalid: 'The lease time is not valid (e.g. 12h, 30m, infinite).',
  dhcp_ip_invalid: 'That is not an IPv4 address.',
  dhcp_host_empty: 'A reservation needs an address or a name.',
  dns_instance_not_found: 'The router has no dnsmasq instance to edit.',
  dns_no_upstream: 'With “ignore resolv file” on and no upstream server the router could not resolve names.',
  dns_server_invalid: 'A server is an address with an optional #port (e.g. 192.168.1.2#5353).',
  dns_address_invalid: 'An override needs a domain and an address (or nothing, for NXDOMAIN).',
  dns_rebind_domain_invalid: 'That is not a domain.',
  dns_domain_invalid: 'That is not a domain.',
  dns_local_invalid: 'That is not a domain.',
  routing_interface_unknown: 'The router has no interface of that name.',
  routing_interface_required: 'Pick the interface the route leaves by.',
  routing_target_invalid: 'The target must be a prefix of the route’s family, e.g. 192.168.50.0/24.',
  routing_gateway_invalid: 'The gateway must be an address of the route’s family.',
  routing_type_invalid: 'That is not a route type.',
  routing_route_not_found: 'That route is gone.',
  system_hostname_invalid: 'A host name is letters, digits and dashes, up to 63 characters.',
  system_timezone_invalid: 'Pick a zone from the list.',
  system_ntp_server_invalid: 'A time server is a host name or an address.',
  system_not_found: 'The router reported no system section.',
}

/** Codes whose server message is the useful part (it names the controller, the path, …). */
const SERVER_MESSAGE = new Set([
  'dns_controller_name_pinned',
  'routing_controller_path',
  'dhcp_confirm_required',
  'dhcp_gateway_not_router',
])

export function nativeErrorMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code && SERVER_MESSAGE.has(code) && error instanceof ApiError) return error.message
  if (code && REFUSALS[code]) return REFUSALS[code]
  if (error instanceof ApiError && error.status === 422 && refusalDetail(error, 'errors')) {
    return 'Some fields are not valid.'
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** The editable form of a pool's or a tag's DHCP options. */
export type OptionsDraft = {
  gateway: string
  dnsServers: string[]
  ntpServers: string[]
  domain: string
  /** Only the other items with a numeric code are editable; the rest stay as they are. */
  other: Array<{ code: string; value: string }>
}

export function optionsDraft(view: DhcpOptionsView): OptionsDraft {
  return {
    gateway: view.gateway ?? '',
    dnsServers: [...view.dnsServers],
    ntpServers: [...view.ntpServers],
    domain: view.domain ?? '',
    other: view.other.filter((o) => o.code !== null && !o.raw.startsWith('tag:')).map((o) => ({ code: String(o.code), value: o.value })),
  }
}

/** Only what changed goes to the server, so untouched items keep the router's spelling. */
export function optionsPatch(view: DhcpOptionsView, draft: OptionsDraft): DhcpOptionsInput | undefined {
  const out: DhcpOptionsInput = {}
  if (draft.gateway.trim() !== (view.gateway ?? '')) out.gateway = draft.gateway.trim() || null
  if (draft.dnsServers.join(',') !== view.dnsServers.join(',')) out.dnsServers = draft.dnsServers
  if (draft.ntpServers.join(',') !== view.ntpServers.join(',')) out.ntpServers = draft.ntpServers
  if (draft.domain.trim() !== (view.domain ?? '')) out.domain = draft.domain.trim() || null
  const before = optionsDraft(view).other
  const other = draft.other.filter((o) => o.code.trim() && o.value.trim())
  if (JSON.stringify(other) !== JSON.stringify(before)) {
    out.other = other.map((o) => ({ code: Number(o.code), value: o.value.trim() }))
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** One line per option for the read views. */
export function optionLines(view: DhcpOptionsView, routerAddress: string | null): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['Router', view.gateway ?? (routerAddress ? `${routerAddress} (router)` : 'the router')],
    ['DNS servers', view.dnsServers.length > 0 ? view.dnsServers.join(', ') : routerAddress ? `${routerAddress} (router)` : 'the router'],
  ]
  if (view.ntpServers.length > 0) out.push(['NTP servers', view.ntpServers.join(', ')])
  if (view.domain) out.push(['Domain', view.domain])
  for (const o of view.other) {
    const label = o.raw.startsWith('tag:') ? 'Tagged option' : o.code !== null ? `Option ${o.code}` : (o.name ?? 'Option')
    out.push([label, o.code !== null && !o.raw.startsWith('tag:') ? o.value : o.raw])
  }
  return out
}
/** Comma/space separated text → list. */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}
