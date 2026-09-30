import { startDeliveryWorker, stopDeliveryWorker } from '#services/alerts/delivery_worker'
import {
  startControllerLifecycle,
  stopControllerLifecycle,
} from '#services/alerts/detectors/controller_lifecycle'
import { startAlertEngine, stopAlertEngine } from '#services/alerts/engine'
import { ensureVapidKeys } from '#services/alerts/push/vapid'
import logger from '@adonisjs/core/services/logger'

/**
 * The only thing `providers/alerts_provider.ts` calls (web environment,
 * `ready()`): the engine worker, the delivery worker (WP-A2), the VAPID keys
 * (WP-A3) and the controller lifecycle (WP-A5a: heartbeat, shutdown marker,
 * database probe, `controller.started`). Each part fails alone: a broken
 * delivery worker never keeps the engine from recording.
 */

async function step(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn()
  } catch (error) {
    logger.error({ err: error, step: name }, 'alerts: boot step failed')
  }
}

export async function bootAlerts(): Promise<void> {
  await step('engine', () => startAlertEngine())
  await step('delivery worker', () => startDeliveryWorker())
  await step('vapid keys', () => ensureVapidKeys())
  await step('controller lifecycle', () => startControllerLifecycle())
}

/** `terminating`: the clean-shutdown marker first, then drain for at most 2 s. */
export async function shutdownAlerts(): Promise<void> {
  await step('controller lifecycle', () => stopControllerLifecycle())
  await step('delivery worker', () => stopDeliveryWorker())
  await step('engine', () => stopAlertEngine(2000))
}
