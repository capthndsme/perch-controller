import type { Sender } from '#services/alerts/senders'

/**
 * The Web Push sender (WP-A3, docs/design/alerts/delivery.md §1.4). Stub from
 * WP-A2 so the delivery worker has something to register; WP-A3 replaces this
 * file (keep the `pushSender` export).
 */
export const pushSender: Sender = {
  kind: 'push',
  async send() {
    return {
      outcome: 'failed',
      error: 'Web Push is not built on this controller yet',
      durationMs: 0,
    }
  },
}
