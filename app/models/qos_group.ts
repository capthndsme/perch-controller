import { QosGroupSchema } from '#database/schema'

/** An admin-only set of MACs that share one QoS assignment (docs/gateway/qos.md section 4). */
export default class QosGroup extends QosGroupSchema {}
