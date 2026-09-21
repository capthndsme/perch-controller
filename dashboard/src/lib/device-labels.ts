import {
  Broadcast,
  Car,
  DeviceMobile,
  DeviceTablet,
  Desktop,
  GameController,
  HardDrive,
  HardDrives,
  Laptop,
  Lightbulb,
  Network,
  Printer,
  Question,
  SpeakerHigh,
  Television,
  VideoCamera,
  Watch,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { DeviceType } from '@/types/api'

/**
 * Operator-supplied device identity (`device_labels` on the API): a personal
 * name, a device type from a fixed list, free-form tags and notes.
 *
 * Everything the dashboard shows for a device has *two* possible names — what
 * DHCP calls it (`hostname`) and what the operator called it (`customName`).
 * `deviceDisplayName` is the single place that decides between them; use it
 * anywhere a device gets a heading, a row title or a chart legend entry.
 */

type DeviceTypeMeta = {
  id: DeviceType
  label: string
  Icon: Icon
}

/**
 * The full taxonomy, in picker order (personal devices, then media, then
 * infrastructure). Kept in sync with `DEVICE_TYPES` in the API — the
 * `Record` type makes a missing member a compile error.
 */
const DEVICE_TYPE_META: Record<DeviceType, Omit<DeviceTypeMeta, 'id'>> = {
  phone: { label: 'Phone', Icon: DeviceMobile },
  tablet: { label: 'Tablet', Icon: DeviceTablet },
  laptop: { label: 'Laptop', Icon: Laptop },
  desktop: { label: 'Desktop', Icon: Desktop },
  tv: { label: 'TV / streaming box', Icon: Television },
  console: { label: 'Game console', Icon: GameController },
  speaker: { label: 'Speaker / audio', Icon: SpeakerHigh },
  wearable: { label: 'Wearable', Icon: Watch },
  camera: { label: 'Camera', Icon: VideoCamera },
  iot: { label: 'IoT / smart home', Icon: Lightbulb },
  printer: { label: 'Printer', Icon: Printer },
  nas: { label: 'NAS / storage', Icon: HardDrives },
  server: { label: 'Server', Icon: HardDrive },
  router: { label: 'Router / gateway', Icon: Network },
  access_point: { label: 'Access point', Icon: Broadcast },
  vehicle: { label: 'Vehicle', Icon: Car },
  other: { label: 'Other', Icon: Question },
}

export const DEVICE_TYPE_ORDER = Object.keys(DEVICE_TYPE_META) as DeviceType[]

export const DEVICE_TYPE_OPTIONS: DeviceTypeMeta[] = DEVICE_TYPE_ORDER.map((id) => ({
  id,
  ...DEVICE_TYPE_META[id],
}))

/** Meta for a stored type, or `null` for an unset / unknown one. */
export function deviceTypeMeta(type: DeviceType | null | undefined): DeviceTypeMeta | null {
  if (!type) return null
  const meta = DEVICE_TYPE_META[type]
  return meta ? { id: type, ...meta } : null
}

export function deviceTypeLabel(type: DeviceType | null | undefined): string | null {
  return deviceTypeMeta(type)?.label ?? null
}

/**
 * The parts of a device any endpoint can return. Every field is optional so
 * one helper covers device rows, identities, Wi-Fi clients, server rows and
 * chart legend entries alike.
 */
export type NameableDevice = {
  mac?: string | null
  customName?: string | null
  hostname?: string | null
  primaryIp?: string | null
  ips?: string[]
  tags?: string[]
  notes?: string | null
}

/**
 * What to call a device on screen, most specific first: the operator's name,
 * the DHCP hostname, an address, then the MAC. Never empty.
 */
export function deviceDisplayName(device: NameableDevice, fallback = 'Unknown device'): string {
  return (
    device.customName ||
    device.hostname ||
    device.primaryIp ||
    device.ips?.[0] ||
    device.mac ||
    fallback
  )
}

/** True when the name on screen came from the operator, not from DHCP. */
export function hasCustomName(device: NameableDevice): boolean {
  return Boolean(device.customName)
}

/**
 * Lowercased haystack for client-side filtering: every name a device answers
 * to, plus its addresses, tags and notes — so searching "kids" or "garage"
 * finds devices tagged that way.
 */
export function deviceSearchText(device: NameableDevice): string {
  return [
    device.customName ?? '',
    device.hostname ?? '',
    device.primaryIp ?? '',
    ...(device.ips ?? []),
    device.mac ?? '',
    ...(device.tags ?? []),
    device.notes ?? '',
  ]
    .join(' ')
    .toLowerCase()
}
