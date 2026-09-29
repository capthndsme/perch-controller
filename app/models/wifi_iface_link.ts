import { WifiIfaceLinkSchema } from '#database/schema'
import type { IfaceLinkOrigin } from '#services/wifi_config/types'

/**
 * Which network an AP's `wifi-iface` section (by perch id) belongs to
 * (docs/design/wifi controller.md sections 5.2–5.3).
 */
export default class WifiIfaceLink extends WifiIfaceLinkSchema {
  declare origin: IfaceLinkOrigin
}
