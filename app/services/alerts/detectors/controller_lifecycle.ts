/**
 * Controller lifecycle (WP-A5a, events.md §3.9): heartbeat, shutdown marker, database
 * probe, controller.started. Stub created by WP-A1 (no-ops); A5a replaces the bodies.
 * `app/services/alerts/boot.ts` calls both.
 */
export async function startControllerLifecycle(): Promise<void> {}

export async function stopControllerLifecycle(): Promise<void> {}
