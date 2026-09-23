import SystemSetting from '#models/system_setting'

/**
 * Settings → Traffic shaping: the QoS tunables (docs/gateway/qos.md section
 * 4.7), one `system_settings` row (key `qos`), the presence pattern
 * (`presence_settings.ts`): read per use, never cached, so a save applies
 * from the next request or plan.
 */
export const QOS_SETTING_KEY = 'qos'

export interface QosSettings {
  /** Lowest WAN SQM rate a queue may have, kbit/s (the agent refuses less too). */
  minWanKbit: number
  /** Lowest per-device or bucket cap, kbit/s. */
  minDeviceKbit: number
  /** A dynamic per-MAC class is freed after this long without a neighbour entry or bytes. */
  dynamicIdleMinutes: number
  /** Cap on dynamic per-MAC classes per gateway. */
  dynamicClassLimit: number
  /** fq_codel flows per device leaf. */
  leafFlows: number
  /** fq_codel packet limit per device leaf (kernel default 10240; amendment 3.3). */
  leafLimitPackets: number
  /** fq_codel memory_limit per device leaf, KB (kernel default 32 MB; amendment 3.3). */
  leafMemoryKb: number
  /** CAKE memlimit per bucket rest leaf, KB (amendment 3.3). */
  restMemlimitKb: number
  /** Structure changes wait this long for more edits before going to the config plane. */
  applyDebounceSeconds: number
  /** How often quota usage is persisted from the router's reports. */
  quotaPersistSeconds: number
  /**
   * Deepest bucket nesting (owner decision 16): 1 = no nesting. HTB allows
   * 8 levels; the kernel spike amendment caps buckets at 4.
   */
  maxBucketDepth: number
}

export const QOS_DEFAULTS: Readonly<QosSettings> = Object.freeze({
  minWanKbit: 1000,
  minDeviceKbit: 64,
  dynamicIdleMinutes: 30,
  dynamicClassLimit: 1024,
  leafFlows: 64,
  leafLimitPackets: 1000,
  leafMemoryKb: 1024,
  restMemlimitKb: 4096,
  applyDebounceSeconds: 2,
  quotaPersistSeconds: 60,
  maxBucketDepth: 4,
})

export type QosLimits = Record<keyof QosSettings, { min: number; max: number }>

/** Accepted range of each setting (whole numbers). */
export const QOS_LIMITS: Readonly<QosLimits> = Object.freeze({
  minWanKbit: { min: 64, max: 100000 },
  minDeviceKbit: { min: 8, max: 10000 },
  dynamicIdleMinutes: { min: 5, max: 1440 },
  dynamicClassLimit: { min: 16, max: 8192 },
  leafFlows: { min: 16, max: 1024 },
  leafLimitPackets: { min: 100, max: 10240 },
  leafMemoryKb: { min: 128, max: 32768 },
  restMemlimitKb: { min: 1024, max: 65536 },
  applyDebounceSeconds: { min: 0, max: 30 },
  quotaPersistSeconds: { min: 10, max: 3600 },
  maxBucketDepth: { min: 1, max: 4 },
})

export const QOS_SETTING_KEYS = Object.keys(QOS_DEFAULTS) as Array<keyof QosSettings>

/**
 * A stored value that is not a whole number reads as the default; one outside
 * the range (limits changed since it was saved) is clamped into it.
 */
export function normalizeQosSettings(value: unknown): QosSettings {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const settings: QosSettings = { ...QOS_DEFAULTS }
  for (const key of QOS_SETTING_KEYS) {
    const candidate = stored[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) continue
    const { min, max } = QOS_LIMITS[key]
    settings[key] = Math.min(max, Math.max(min, candidate))
  }
  return settings
}

export async function getQosSettings(): Promise<QosSettings> {
  return normalizeQosSettings(await SystemSetting.get<unknown>(QOS_SETTING_KEY))
}

/** Applies the given fields over the stored ones; the rest keep their value. */
export async function updateQosSettings(changes: Partial<QosSettings>): Promise<QosSettings> {
  const merged: Record<string, unknown> = { ...(await getQosSettings()) }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value
  }
  const settings = normalizeQosSettings(merged)
  await SystemSetting.set(QOS_SETTING_KEY, settings)
  return settings
}

/** GET / PATCH /api/v1/settings/qos body. */
export function qosSettingsView(settings: QosSettings) {
  return { settings, defaults: QOS_DEFAULTS, limits: QOS_LIMITS }
}
