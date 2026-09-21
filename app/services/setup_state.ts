import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'

/**
 * Single source of truth for "where in the wizard are we?". Used by both
 * the setup controller (to drive its own routing) and the
 * `requireSetupComplete` middleware (to short-circuit normal API traffic
 * until setup is done).
 */
export type SetupStep = 'admin' | 'instance' | 'collector' | 'complete'

export type SetupSnapshot = {
  step: SetupStep
  adminExists: boolean
  hasInstance: boolean
  hasCollector: boolean
  /** The admin chose "skip for now" in the wizard's collector step. */
  collectorsDeferred: boolean
}

/**
 * Set by the wizard's "skip for now". The controller is deployed first and
 * collectors and access points join afterwards, in any order, so setup must be
 * able to finish with no collector at all: they are adopted later, from the
 * wizard's candidate list or Settings → Collectors, as they announce.
 */
export const COLLECTORS_DEFERRED_KEY = 'setup_collectors_deferred'

async function adminExists(): Promise<boolean> {
  const row = await User.query().where('role', 'admin').first()
  return row !== null
}

async function instanceConfigured(): Promise<boolean> {
  const siteName = await SystemSetting.get<string>('site_name')
  // A non-empty siteName is the discriminator: timezone defaults to UTC and
  // can be left implicit on minimal setups.
  return typeof siteName === 'string' && siteName.length > 0
}

/**
 * Only an ADOPTED collector counts as "setup has a collector".
 *
 * Discovery means a router can announce itself into a fresh install and
 * create a `pending` row before the wizard has ever been opened. Counting
 * that row would mark setup complete, open the whole API through
 * `requireSetupComplete`, and leave the poller with nothing to poll — the
 * pending row is `enabled = false` and is never dispatched.
 */
async function collectorExists(): Promise<boolean> {
  const row = await Collector.query().where('lifecycle', 'adopted').first()
  return row !== null
}

async function collectorsDeferred(): Promise<boolean> {
  return (await SystemSetting.get<boolean>(COLLECTORS_DEFERRED_KEY)) === true
}

export async function deferCollectors(): Promise<void> {
  await SystemSetting.set(COLLECTORS_DEFERRED_KEY, true)
}

export async function snapshot(): Promise<SetupSnapshot> {
  const [admin, hasInstance, hasCollector, deferred] = await Promise.all([
    adminExists(),
    instanceConfigured(),
    collectorExists(),
    collectorsDeferred(),
  ])

  let step: SetupStep
  if (!admin) step = 'admin'
  else if (!hasInstance) step = 'instance'
  else if (!hasCollector && !deferred) step = 'collector'
  else step = 'complete'

  return { step, adminExists: admin, hasInstance, hasCollector, collectorsDeferred: deferred }
}

export async function isSetupComplete(): Promise<boolean> {
  const snap = await snapshot()
  return snap.step === 'complete'
}
