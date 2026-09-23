import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * Wire shape of the QoS read views (`qos_reads.ts` builds each row in the
 * contract's shape: docs/gateway/qos.md section 5). The transformer only
 * gives lists the `{ data: [...] }` envelope every API response has.
 */
export default class QosViewTransformer<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends BaseTransformer<T> {
  toObject() {
    return this.resource
  }
}
