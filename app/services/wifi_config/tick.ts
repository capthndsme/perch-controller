import ApConfig from '#models/ap_config'
import { renderFingerprint } from '#services/wifi_config/fleet/render'
import {
  loadFleet,
  renderApDraft,
  renderInputOf,
  type FleetData,
} from '#services/wifi_config/fleet_service'
import { tickApJobs } from '#services/wifi_config/lifecycle'
import { apSession, normalizeApMode } from '#services/wifi_config/registry'
import {
  activeRollout,
  advanceRollouts,
  catchUpAp,
  missedSections,
  rolloutStepActive,
} from '#services/wifi_config/rollouts'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import { apConfigQueue } from '#services/wifi_config/store'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The Wi-Fi plane's 5 s tick (docs/design/wifi controller.md sections 4.3,
 * 4.5, 5.2 and 6.4), run by `app/tasks/wifi_config_tick.task.ts`. Per
 * managed AP, in its queue: its jobs' timers (queued sends, confirm retries
 * while the AP's health check runs, assumed rollbacks, unanswered sends),
 * Authoritative enforcement (not while a rollout step is on the AP), and a
 * re-render when the render's inputs moved (a crash between two APs'
 * writes heals here). Then the rollouts move on, and a reconnected AP that
 * missed a change while no rollout could run catches up. Never throws.
 */
export async function wifiConfigTick(now: DateTime = DateTime.utc()): Promise<void> {
  const aps = await ApConfig.query().where('mode', 'managed').orderBy('ap_id')
  const settings = await getWifiConfigSettings()
  let fleet: FleetData | null = null
  for (const ap of aps) {
    try {
      await apConfigQueue.run(ap.apId, async () => {
        await ap.refresh()
        if (normalizeApMode(ap.mode) !== 'managed') return
        await tickApJobs(ap, now, { rolloutStepActive: await rolloutStepActive(ap.apId) })
        fleet ??= await loadFleet()
        const input = await renderInputOf(ap, fleet, settings)
        if (renderFingerprint(input) !== ap.renderFingerprint) {
          await renderApDraft(ap.apId, { settings })
          fleet = null
        }
      })
    } catch (error) {
      logger.warn({ apId: ap.apId, error: (error as Error).message }, 'wifi_config: tick failed')
    }
  }
  try {
    await advanceRollouts()
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'wifi_config: rollouts did not advance')
  }
  try {
    if (settings.catchUpOnReconnect === 'auto' && !(await activeRollout())) {
      for (const ap of aps) {
        if (!apSession(ap.apId)) continue
        const missed = await missedSections(ap.apId)
        if (missed.length === 0) continue
        if (await catchUpAp(ap.apId)) break
      }
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'wifi_config: catch-up failed')
  }
}
