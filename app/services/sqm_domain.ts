import type {
  ConfigDomain,
  RouterPauseRule,
  SectionEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type {
  GatewayCapabilities,
  Issue,
  SectionOwnership,
  UciConfigSet,
  UciOptions,
  UciSection,
  UciValue,
} from '#services/gateway_config/types'
import {
  DEVICE_NAME,
  normalizeSqmOption,
  parseSqmQueue,
  SQM_MAPPED_OPTIONS,
  sqmQueueSetFlags,
} from '#services/sqm_mapping'

/**
 * The `sqm` config domain (docs/gateway/qos.md section 2.2; plan 3 section
 * 9.2): how the config plane models `/etc/config/sqm` `queue` sections.
 * Registered in `gateway_config/domains/index.ts`; `SQM_PAUSE` makes the
 * engine hold a router-side pause on every read (config-plane.md 6.8).
 *
 * Two-way synced, whole-package ownership, untagged pre-existing sections
 * (the live gateway's `eth1`) are imported as they are; `normalizeSqmOption`
 * is the equality form. Owner decision 15: a router-side `enabled '0'` is a
 * safety pause that Authoritative Mode never reverts. The domain expresses
 * that through ownership: while the router's section says `enabled '0'`,
 * Perch does not own `enabled` (the router's value always wins, it is never
 * drift and never a conflict), and owns every other option it sees.
 */

/** The domain object: one queue section, options verbatim. */
export interface SqmQueueObject {
  perchId: string | null
  section: string
  options: UciOptions
}

export const SQM_CONFIG = 'sqm'
export const SQM_QUEUE_TYPE = 'queue'

/**
 * What Perch owns in a queue section: everything, except `enabled` while
 * the router holds the queue paused (decision 15).
 */
export function sqmOwnership(section: { options: UciOptions }): SectionOwnership {
  const enabled = section.options.enabled
  const paused = typeof enabled === 'string' && normalizeSqmOption('enabled', enabled) === '0'
  if (!paused) return { kind: 'section' }
  const owned = new Set([...SQM_MAPPED_OPTIONS, ...Object.keys(section.options)])
  owned.delete('enabled')
  return { kind: 'options', options: [...owned].sort() }
}

/** Decision 15 as the engine's pause rule: a router-side `enabled '0'`. */
export const SQM_PAUSE: RouterPauseRule = {
  type: SQM_QUEUE_TYPE,
  option: 'enabled',
  isPaused: (value) => typeof value === 'string' && normalizeSqmOption('enabled', value) === '0',
}

export const sqmDomain = {
  key: 'sqm',
  configs: [SQM_CONFIG],
  types: [SQM_QUEUE_TYPE],
  routerPause: SQM_PAUSE,

  claims(section: UciSection & { config: string }, _all?: UciConfigSet): boolean {
    return section.config === SQM_CONFIG && section.type === SQM_QUEUE_TYPE
  },

  ownership(section: UciSection & { config: string }): SectionOwnership {
    return sqmOwnership(section)
  },

  requires(caps: GatewayCapabilities): string | null {
    const packages = caps.packages ?? {}
    if (!('sqm-scripts' in packages)) return 'sqm-scripts is not installed'
    return null
  },

  normalize(type: string, option: string, value: UciValue): UciValue {
    return type === SQM_QUEUE_TYPE ? normalizeSqmOption(option, value) : value
  },

  // No identityKeys: two queues on one device are kept and flagged
  // (`duplicate_device`, plan 3 section 2.1), never made ambiguous.

  parse(sections: SyncedSection[]): SqmQueueObject[] {
    return sections
      .filter((s) => s.config === SQM_CONFIG && s.type === SQM_QUEUE_TYPE)
      .map((s) => ({ perchId: s.perchId, section: s.name, options: cloneOptions(s.options) }))
  },

  /** The object's options are the full map, so the render is the map itself. */
  render(obj: SqmQueueObject, _current?: SyncedSection[]): SectionEdit[] {
    return [
      {
        op: 'put',
        perchId: obj.perchId,
        config: SQM_CONFIG,
        type: SQM_QUEUE_TYPE,
        ...(obj.perchId === null ? { name: obj.section } : {}),
        options: cloneOptions(obj.options),
      },
    ]
  },

  validate(desired: SyncedSection[], _ctx?: ValidationCtx): Issue[] {
    const queues = desired.filter((s) => s.config === SQM_CONFIG && s.type === SQM_QUEUE_TYPE)
    const issues: Issue[] = []
    const setFlags = sqmQueueSetFlags(queues)
    queues.forEach((s, index) => {
      const view = parseSqmQueue(s.options)
      const base = { perchId: s.perchId, config: s.config, section: s.name }
      if (!view.device) {
        issues.push({
          ...base,
          severity: 'error',
          code: 'qos_device_required',
          message: 'A queue needs an interface',
          option: 'interface',
        })
      } else if (!DEVICE_NAME.test(view.device)) {
        issues.push({
          ...base,
          severity: 'error',
          code: 'qos_invalid_device',
          message: `"${view.device}" is not an interface name`,
          option: 'interface',
        })
      }
      if (setFlags[index].includes('duplicate_device')) {
        issues.push({
          ...base,
          severity: 'warning',
          code: 'qos_duplicate_device',
          message: `Another enabled queue also shapes ${view.device}`,
          option: 'interface',
        })
      }
      if (view.flags.includes('invalid_rate')) {
        issues.push({
          ...base,
          severity: 'error',
          code: 'qos_invalid_rate',
          message: 'download and upload must be whole kbit/s',
        })
      }
    })
    return issues
  },
} satisfies ConfigDomain<SqmQueueObject>

function cloneOptions(options: UciOptions): UciOptions {
  const out: UciOptions = {}
  for (const [key, value] of Object.entries(options)) {
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}
