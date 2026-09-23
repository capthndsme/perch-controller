import {
  ArrowsLeftRight,
  Broadcast,
  ChartBar,
  Devices,
  DoorOpen,
  Gauge,
  GearSix,
  Globe,
  HardDrives,
  Speedometer,
  SlidersHorizontal,
  TreeStructure,
} from '@phosphor-icons/react'

export type NavItem = {
  to: string
  label: string
  icon: typeof Gauge
  /** Match nested routes (e.g. /wifi/*). */
  end?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/traffic', label: 'Traffic', icon: ArrowsLeftRight },
  { to: '/usage', label: 'Usage', icon: ChartBar },
  { to: '/devices', label: 'Devices', icon: Devices },
  { to: '/servers', label: 'Servers', icon: HardDrives },
  { to: '/wifi', label: 'WiFi', icon: Broadcast },
  { to: '/gateway', label: 'Gateway', icon: Globe },
  { to: '/infrastructure', label: 'Infrastructure', icon: TreeStructure },
  { to: '/portal', label: 'Guest portal', icon: DoorOpen },
  { to: '/shaping', label: 'Shaping', icon: Speedometer },
  { to: '/gateway/config', label: 'Gateway config', icon: SlidersHorizontal },
  { to: '/settings', label: 'Settings', icon: GearSix },
]
