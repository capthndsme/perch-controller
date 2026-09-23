import Portal from '#models/portal'
import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import { sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, portalNotFound, portalUserNotFound } from '#services/portal_errors'
import { emptyPushes, endGrants, grantPushList, num } from '#services/portal_grants'
import { runInPortalQueue } from '#services/portal_queue'
import { portalUserView } from '#transformers/portal'
import { firstOf } from '#services/portal_params'
import db from '@adonisjs/lucid/services/db'

/**
 * Portal users (docs/gateway/portal.md section 11.4): password logins for the
 * guest page, never controller users. Admin-only. Changing a user's limits
 * resends its live grants; disabling or deleting a user ends them.
 */

export type PortalUserInput = {
  username?: string
  displayName?: string | null
  password?: string
  enabled?: boolean
  maxDevices?: number
  sessionMinutes?: number | null
  downKbps?: number | null
  upKbps?: number | null
  portalIds?: number[] | null
  deviceGroupId?: number | null
}

async function checkDeviceGroup(id: number | null | undefined): Promise<number | null> {
  if (id === null || id === undefined) return null
  const row = await db.from('device_groups').where('id', id).first()
  if (!row) {
    throw new PortalError(422, 'device_group_not_found', `There is no device group ${id}.`, {
      field: 'deviceGroupId',
    })
  }
  return id
}

async function activeDevices(userIds: number[]): Promise<Map<number, number>> {
  if (!userIds.length) return new Map()
  const rows = (await db
    .from('portal_grants')
    .whereIn('portal_user_id', userIds)
    .whereIn('state', ['pending_device', 'active', 'paused'])
    .groupBy('portal_user_id')
    .select('portal_user_id')
    .count('* as n')) as Array<{ portal_user_id: number; n: number | string }>
  return new Map(rows.map((r) => [r.portal_user_id, Number(r.n)]))
}

async function views(users: PortalUser[]) {
  const counts = await activeDevices(users.map((u) => u.id))
  return users.map((u) => portalUserView(u, counts.get(u.id) ?? 0))
}

export async function listPortalUsers() {
  return views(await PortalUser.query().orderBy('username'))
}

async function findUser(id: number): Promise<PortalUser> {
  const user = await PortalUser.find(id)
  if (!user) throw portalUserNotFound(id)
  return user
}

async function checkPortals(ids: number[] | null | undefined): Promise<number[] | null> {
  if (ids === null || ids === undefined) return null
  const unique = [...new Set(ids)].sort((a, b) => a - b)
  if (!unique.length) return []
  const rows = await Portal.query().whereIn('id', unique).whereNull('deleted_at').select('id')
  const found = new Set(rows.map((p) => p.id))
  const missing = unique.find((id) => !found.has(id))
  if (missing !== undefined) throw portalNotFound(missing)
  return unique
}

function taken(username: string): PortalError {
  return new PortalError(422, 'username_taken', `The username "${username}" is taken.`, {
    field: 'username',
  })
}

export async function createPortalUser(
  input: Required<Pick<PortalUserInput, 'username' | 'password'>> & PortalUserInput
) {
  const portalIds = await checkPortals(input.portalIds)
  const deviceGroupId = await checkDeviceGroup(input.deviceGroupId)
  if (await PortalUser.findBy('username', input.username)) throw taken(input.username)
  try {
    const user = await PortalUser.create({
      username: input.username,
      displayName: input.displayName ?? null,
      password: input.password,
      enabled: input.enabled ?? true,
      maxDevices: input.maxDevices ?? 2,
      sessionMinutes: input.sessionMinutes ?? null,
      downKbps: input.downKbps ?? null,
      upKbps: input.upKbps ?? null,
      portalIds,
      deviceGroupId,
      revision: 1,
      lastLoginAt: null,
    })
    return await firstOf(views([user]))
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw taken(input.username)
    throw error
  }
}

/**
 * Ends (`revoked`) or resends the user's non-ended grants, per gateway and
 * inside each gateway's queue.
 */
async function touchUserGrants(userId: number, action: 'end' | 'resend'): Promise<void> {
  const grants = await PortalGrant.query()
    .where('portal_user_id', userId)
    .whereNot('state', 'ended')
  if (!grants.length) return
  const portals = await Portal.query().whereIn('id', [...new Set(grants.map((g) => g.portalId))])
  const gatewayOf = new Map(portals.map((p) => [p.id, p.gatewayId]))
  const byGateway = new Map<number, number[]>()
  for (const g of grants) {
    const gw = gatewayOf.get(g.portalId)
    if (gw === undefined) continue
    byGateway.set(gw, [...(byGateway.get(gw) ?? []), num(g.id)])
  }
  for (const [gatewayId, ids] of byGateway) {
    await runInPortalQueue(gatewayId, async () => {
      const pushes = emptyPushes()
      if (action === 'end') {
        await db.transaction(async (trx) => {
          const rows = await PortalGrant.query({ client: trx }).whereIn('id', ids).forUpdate()
          await endGrants(trx, rows, 'revoked', Date.now(), pushes)
        })
      } else {
        // The group's limits changed (its revision was bumped): the live
        // grants go out again with the new group.
        const live = await PortalGrant.query()
          .whereIn('id', ids)
          .whereIn('state', ['pending_device', 'active', 'paused'])
        for (const g of live) pushes.authorize.add(num(g.id))
      }
      await sendPortalPushes(gatewayId, grantPushList(pushes))
    })
  }
}

export async function updatePortalUser(id: number, input: PortalUserInput) {
  const user = await findUser(id)
  let limitsChanged = false
  if (input.username !== undefined && input.username !== user.username) {
    const other = await PortalUser.findBy('username', input.username)
    if (other && other.id !== id) throw taken(input.username)
    user.username = input.username
  }
  if (input.displayName !== undefined) user.displayName = input.displayName
  if (input.portalIds !== undefined) user.portalIds = await checkPortals(input.portalIds)
  if (input.deviceGroupId !== undefined) {
    user.deviceGroupId = await checkDeviceGroup(input.deviceGroupId)
  }
  if (input.sessionMinutes !== undefined) user.sessionMinutes = input.sessionMinutes
  for (const key of ['maxDevices', 'downKbps', 'upKbps'] as const) {
    if (input[key] !== undefined && input[key] !== user[key]) {
      ;(user as unknown as Record<string, unknown>)[key] = input[key]
      limitsChanged = true
    }
  }
  const disabling = input.enabled === false && user.enabled
  if (input.enabled !== undefined) user.enabled = input.enabled
  if (limitsChanged) user.revision += 1
  await user.save()
  if (disabling) await touchUserGrants(id, 'end')
  else if (limitsChanged) await touchUserGrants(id, 'resend')
  return await firstOf(views([user]))
}

/** A new password. Devices already online stay online. */
export async function setPortalUserPassword(id: number, password: string): Promise<void> {
  const user = await findUser(id)
  user.password = password
  await user.save()
}

/** Deletes the user and ends its grants. */
export async function deletePortalUser(id: number): Promise<void> {
  await findUser(id)
  await touchUserGrants(id, 'end')
  const user = await findUser(id)
  await user.delete()
}
