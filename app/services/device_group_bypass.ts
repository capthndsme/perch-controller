import db from '@adonisjs/lucid/services/db'

/**
 * The bound MACs of a gateway's device groups that pass its guest portals
 * (`portal_bypass`, groups without a network of their own): what
 * `portal.configure` carries as `bypass` (docs/gateway/device-groups.md
 * section 6). A module of its own so the portal sender does not import the
 * device groups service (which pushes portal configurations itself).
 */
export async function portalBypassMacs(gatewayId: number): Promise<string[]> {
  const rows = (await db
    .from('device_group_members as m')
    .join('device_groups as g', 'g.id', 'm.group_id')
    .where('g.gateway_id', gatewayId)
    .where('g.portal_bypass', true)
    .whereNull('g.network_perch_id')
    .select('m.mac')) as Array<{ mac: string }>
  return [...new Set(rows.map((r) => r.mac.toLowerCase()))].sort()
}
