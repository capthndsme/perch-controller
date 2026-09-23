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
 * name, a device type from a fixed list, free-form tags and notes. The naming
 * helpers live in device-names.ts (kept free of icons for the entry chunk) and
 * are re-exported here.
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

export {
  deviceDisplayName,
  deviceSearchText,
  hasCustomName,
  type NameableDevice,
} from '@/lib/device-names'
