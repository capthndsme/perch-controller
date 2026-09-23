import { QosGroupMemberSchema } from '#database/schema'

/** One MAC of a QoS group; a MAC is in at most one group per gateway. */
export default class QosGroupMember extends QosGroupMemberSchema {}
