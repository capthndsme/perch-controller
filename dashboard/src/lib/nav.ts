import {
  ArrowsLeftRight,
  Broadcast,
  ChartBar,
  Clock,
  Signpost,
  AddressBook,
  Planet,
  Devices,
  DoorOpen,
  Gauge,
  GearSix,
  Globe,
  HardDrives,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  Speedometer,
  SquaresFour,
  TreeStructure,
} from '@phosphor-icons/react'

export type NavItem = {
  to: string
  label: string
  icon: typeof Gauge
  /** Match nested routes (e.g. /wifi/*). */
  end?: boolean
  /** Other path prefixes that also mark the entry active (a folded section). */
  also?: string[]
}

/** Whether `pathname` is `prefix` or below it. */
export function underPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * The Gateway section: one sidebar entry, and this sub-nav above each of its
 * pages (components/layout/gateway-section-nav.tsx). The URLs stay where the
 * pages were built (`/networks`, `/firewall`, `/shaping`, `/portal`): devices, the apply
 * banner and the settings pages link to them.
 */
export const GATEWAY_SECTION: NavItem[] = [
  { to: '/gateway', label: 'Overview', icon: SquaresFour, end: true },
  { to: '/gateway/config', label: 'Configuration', icon: SlidersHorizontal },
  { to: '/networks', label: 'Networks', icon: Network },
  { to: '/gateway/dhcp', label: 'DHCP', icon: AddressBook },
  { to: '/gateway/dns', label: 'DNS', icon: Planet },
  { to: '/firewall', label: 'Firewall', icon: ShieldCheck },
  { to: '/gateway/routing', label: 'Routing', icon: Signpost },
  { to: '/gateway/system', label: 'System', icon: Clock },
  { to: '/shaping', label: 'Shaping', icon: Speedometer },
  { to: '/portal', label: 'Guest portal', icon: DoorOpen },
]

/** Whether a path belongs to the Gateway section. */
export function inGatewaySection(pathname: string): boolean {
  return GATEWAY_SECTION.some((item) => underPath(pathname, item.to))
}

/** Whether a section entry is the active one (`/gateway` is only the overview itself). */
export function sectionItemActive(item: NavItem, pathname: string): boolean {
  return item.end ? pathname === item.to || pathname === `${item.to}/` : underPath(pathname, item.to)
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/traffic', label: 'Traffic', icon: ArrowsLeftRight },
  { to: '/usage', label: 'Usage', icon: ChartBar },
  { to: '/devices', label: 'Devices', icon: Devices },
  { to: '/servers', label: 'Servers', icon: HardDrives },
  { to: '/wifi', label: 'WiFi', icon: Broadcast },
  {
    to: '/gateway',
    label: 'Gateway',
    icon: Globe,
    also: GATEWAY_SECTION.map((item) => item.to).filter((to) => to !== '/gateway'),
  },
  { to: '/infrastructure', label: 'Infrastructure', icon: TreeStructure },
  { to: '/settings', label: 'Settings', icon: GearSix },
]
