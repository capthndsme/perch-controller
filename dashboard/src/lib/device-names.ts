/**
 * Everything the dashboard shows for a device has *two* possible names — what
 * DHCP calls it (`hostname`) and what the operator called it (`customName`).
 * `deviceDisplayName` is the single place that decides between them; use it
 * anywhere a device gets a heading, a row title or a chart legend entry.
 *
 * No icons here: the top bar's search imports this module, so it ships in the
 * entry chunk. The device-type taxonomy with its icons is in device-labels.ts,
 * which also re-exports everything below.
 */

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
