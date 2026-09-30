import type { Sender } from '#services/alerts/senders'

/**
 * The webhook sender (WP-A4, docs/design/alerts/delivery.md §2). Stub from
 * WP-A2 so the delivery worker has something to register; WP-A4 replaces this
 * file (keep the `webhookSender` export).
 */
export const webhookSender: Sender = {
  kind: 'webhook',
  async send() {
    return {
      outcome: 'failed',
      error: 'Webhooks are not built on this controller yet',
      durationMs: 0,
    }
  },
}
