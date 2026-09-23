import SystemSetting from '#models/system_setting'
import {
  PORTAL_SETTING_KEY,
  type PortalSettings,
  mergePortalSettings,
  normalizePortalSettings,
} from '#services/portal/settings'

/**
 * Settings → Guest portal, DB side (pure part: `portal/settings.ts`). Read
 * per use, never cached, so a save applies to the next tick or request.
 */

export async function getPortalSettings(): Promise<PortalSettings> {
  return normalizePortalSettings(await SystemSetting.get<unknown>(PORTAL_SETTING_KEY))
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updatePortalSettings(
  changes: Partial<PortalSettings>
): Promise<PortalSettings> {
  const settings = mergePortalSettings(await getPortalSettings(), changes)
  await SystemSetting.set(PORTAL_SETTING_KEY, settings)
  return settings
}
