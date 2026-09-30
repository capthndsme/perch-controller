/**
 * The delivery worker (WP-A2, docs/design/alerts/delivery.md §3). Stub from
 * WP-A1 so `boot.ts` can call it; WP-A2 replaces it.
 */
export function startDeliveryWorker(): void {}

export async function stopDeliveryWorker(): Promise<void> {}
