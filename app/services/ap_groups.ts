import logger from '@adonisjs/core/services/logger'

/**
 * The device groups' Wi-Fi on the access points (perch-apd `groups.*`,
 * docs/gateway/device-groups.md section 7). Filled in below.
 */

/** Asks for the APs' desired state to be recomputed and sent (debounced). */
export function requestApGroupsSync(reason: string): void {
  logger.debug({ reason }, 'ap_groups: sync requested')
}
