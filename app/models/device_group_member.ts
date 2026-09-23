import { DeviceGroupMemberSchema } from '#database/schema'

export const DEVICE_GROUP_MEMBER_SOURCES = ['manual', 'portal'] as const
export type DeviceGroupMemberSource = (typeof DEVICE_GROUP_MEMBER_SOURCES)[number]

/**
 * A bound member of a device group: added by an admin (`manual`) or by a
 * portal user's sign-in (`portal`, decision 31). A MAC is in one group per
 * gateway at most.
 */
export default class DeviceGroupMember extends DeviceGroupMemberSchema {}
