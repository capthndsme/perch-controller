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

/**
 * The `perch_qos` config domain (docs/gateway/qos.md section 6.3; README
 * section 2): the whole Perch-owned `/etc/config/perch-qos` package that the
 * QoS planner renders (`planQos().sections`: `globals`, `bucket`, `network`,
 * `schedule`). Registered after `sqm` in `gateway_config/domains/index.ts`.
 *
 * - **One-way** (`oneWay`): router edits of its sections are drift even
 *   without Authoritative Mode, and the enforcement tick reverts them. The
 *   first import of the package (the file perch-qos installs) is not drift.
 * - **Decision 15** (`routerPause`): the router switching `globals.enabled`
 *   to `'0'` is a local safety pause. It is imported as a pause (the option
 *   becomes the router's: never drift, never reverted, writes keep `'0'`),
 *   until the router switches it back or an admin resumes over it
 *   (`POST /qos/resume {overrideRouter: true}` → a put with `reclaim`).
 *   The controller's own pause (`POST /qos/pause`) writes `'0'` itself; the
 *   agreed base then says `'0'` and that is not a router pause.
 * - Options are carried verbatim (`parse`/`render` round-trip); `normalize`
 *   is the equality form (booleans, numbers without padding).
 */

export const PERCH_QOS_CONFIG = 'perch-qos'
export const PERCH_QOS_DOMAIN = 'perch_qos'
export const PERCH_QOS_TYPES = ['globals', 'bucket', 'network', 'schedule'] as const
export type PerchQosType = (typeof PERCH_QOS_TYPES)[number]

/** Options `globals` may carry (the planner's, plus the plane's `revision`). */
export const PERCH_QOS_GLOBALS_OPTIONS = [
  'enabled',
  'revision',
  'min_wan_kbit',
  'min_device_kbit',
  'leaf_flows',
  'leaf_limit',
  'leaf_memory_kb',
  'rest_memlimit_kb',
  'dynamic_idle',
  'dynamic_limit',
  'exempt',
]

/** One section of the package, options verbatim. */
export interface PerchQosSection {
  perchId: string | null
  name: string
  type: PerchQosType
  options: UciOptions
}

const BOOLEAN_OPTIONS = new Set(['enabled', 'include_lan'])
const NUMERIC = /^\s*0*(\d+)\s*$/
const NAME = /^[A-Za-z0-9_]{1,32}$/
const DAY = '(?:mon|tue|wed|thu|fri|sat|sun)'
const WINDOW = new RegExp(
  `^${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)* (?:[01]\\d|2[0-3]):[0-5]\\d-(?:[01]\\d|2[0-3]|24):[0-5]\\d$`
)
const RATE_OPTIONS = ['down_kbit', 'up_kbit', 'each_down_kbit', 'each_up_kbit']

/** perch-collector's boolean spelling (`uciBool`). */
function normalizeBool(value: string): string {
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'on':
    case 'true':
    case 'yes':
    case 'enabled':
      return '1'
    case '0':
    case 'off':
    case 'false':
    case 'no':
    case 'disabled':
      return '0'
    default:
      return value
  }
}

/** The equality form of one option (never applied to stored content). */
export function normalizePerchQosOption(option: string, value: UciValue): UciValue {
  if (Array.isArray(value)) return value.map((v) => v.trim())
  if (BOOLEAN_OPTIONS.has(option)) return normalizeBool(value)
  const numeric = NUMERIC.exec(value)
  if (numeric) return numeric[1]
  return value.trim()
}

/** Is `globals.enabled` (undefined = absent = on) the paused value? */
export function perchQosPaused(value: UciValue | undefined): boolean {
  return typeof value === 'string' && normalizeBool(value) === '0'
}

export const PERCH_QOS_PAUSE: RouterPauseRule = {
  type: 'globals',
  option: 'enabled',
  isPaused: perchQosPaused,
}

/**
 * What Perch owns in a section: everything, except `globals.enabled` while
 * the router's `globals` says `'0'` (decision 15). The engine calls this on
 * first import and on a router-side pause; a section Perch creates is always
 * wholly Perch's.
 */
export function perchQosOwnership(section: {
  type: string
  options: UciOptions
}): SectionOwnership {
  if (section.type !== 'globals' || !perchQosPaused(section.options.enabled)) {
    return { kind: 'section' }
  }
  const owned = new Set([...PERCH_QOS_GLOBALS_OPTIONS, ...Object.keys(section.options)])
  owned.delete('enabled')
  return { kind: 'options', options: [...owned].sort() }
}

function cloneOptions(options: UciOptions): UciOptions {
  const out: UciOptions = {}
  for (const [key, value] of Object.entries(options)) {
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

function first(value: UciValue | undefined): string {
  if (value === undefined) return ''
  return Array.isArray(value) ? (value[0] ?? '') : value
}

function list(value: UciValue | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean)
}

export const perchQosDomain = {
  key: PERCH_QOS_DOMAIN,
  configs: [PERCH_QOS_CONFIG],
  types: [...PERCH_QOS_TYPES],
  oneWay: true,
  routerPause: PERCH_QOS_PAUSE,

  claims(section: UciSection & { config: string }, _all?: UciConfigSet): boolean {
    return (
      section.config === PERCH_QOS_CONFIG &&
      (PERCH_QOS_TYPES as readonly string[]).includes(section.type) &&
      // perch-collector ignores anonymous sections other than globals.
      (!section.anonymous || section.type === 'globals')
    )
  },

  ownership(section: UciSection & { config: string }): SectionOwnership {
    return perchQosOwnership(section)
  },

  requires(caps: GatewayCapabilities): string | null {
    const packages = caps.packages ?? {}
    if (!('perch-qos' in packages)) return 'perch-qos is not installed'
    return null
  },

  normalize(_type: string, option: string, value: UciValue): UciValue {
    return normalizePerchQosOption(option, value)
  },

  listSemantics: {
    // Exemptions and windows are sets; a schedule list is in precedence order.
    'globals.exempt': 'set',
    'schedule.window': 'set',
  },

  parse(sections: SyncedSection[]): PerchQosSection[] {
    return sections
      .filter(
        (s) =>
          s.config === PERCH_QOS_CONFIG && (PERCH_QOS_TYPES as readonly string[]).includes(s.type)
      )
      .map((s) => ({
        perchId: s.perchId,
        name: s.name,
        type: s.type as PerchQosType,
        options: cloneOptions(s.options),
      }))
  },

  /** A section's options are the whole map: the render is the map itself. */
  render(obj: PerchQosSection, _current?: SyncedSection[]): SectionEdit[] {
    return [
      {
        op: 'put',
        perchId: obj.perchId,
        config: PERCH_QOS_CONFIG,
        type: obj.type,
        ...(obj.perchId === null ? { name: obj.name } : {}),
        options: cloneOptions(obj.options),
      },
    ]
  },

  /**
   * What perch-collector would refuse or ignore (`internal/qos/config.go`):
   * errors block an apply of the touched sections.
   */
  validate(desired: SyncedSection[], _ctx?: ValidationCtx): Issue[] {
    const own = desired.filter((s) => s.config === PERCH_QOS_CONFIG)
    const issues: Issue[] = []
    const add = (
      s: SyncedSection,
      severity: Issue['severity'],
      code: string,
      message: string,
      option?: string
    ) =>
      issues.push({
        perchId: s.perchId,
        config: s.config,
        section: s.name,
        severity,
        code,
        message,
        ...(option ? { option } : {}),
      })
    const byType = (type: string) => own.filter((s) => s.type === type)
    const buckets = new Set(byType('bucket').map((s) => s.name))
    const schedules = new Set(byType('schedule').map((s) => s.name))

    const globals = byType('globals')
    if (globals.length > 1) {
      for (const s of globals.slice(1)) {
        add(
          s,
          'error',
          'perch_qos_duplicate_globals',
          'perch-qos has more than one globals section'
        )
      }
    }
    const seen = new Map<string, SyncedSection>()
    for (const s of own) {
      if (s.type !== 'globals' && !NAME.test(s.name)) {
        add(s, 'error', 'perch_qos_bad_name', `"${s.name}" is not a perch-qos section name`)
      }
      const key = `${s.type}/${s.name}`
      if (seen.has(key))
        add(s, 'error', 'perch_qos_duplicate', `${s.type} ${s.name} is defined twice`)
      seen.set(key, s)
      for (const option of RATE_OPTIONS) {
        const value = first(s.options[option])
        if (value !== '' && !/^\d+$/.test(value.trim())) {
          add(
            s,
            'error',
            'perch_qos_bad_rate',
            `${option} "${value}" is not a whole kbit/s`,
            option
          )
        }
      }
      for (const name of list(s.options.schedule)) {
        if (!schedules.has(name)) {
          add(
            s,
            'warning',
            'perch_qos_unknown_schedule',
            `schedule ${name} does not exist`,
            'schedule'
          )
        }
      }
    }
    for (const s of byType('bucket')) {
      const cls = first(s.options.class).toLowerCase()
      const minor = /^0x[0-9a-f]{1,4}$/.test(cls) ? Number.parseInt(cls.slice(2), 16) : Number.NaN
      if (!(minor >= 0x02 && minor <= 0xff)) {
        add(s, 'error', 'perch_qos_bad_class', `bucket class "${cls}" is not 0x02-0xff`, 'class')
      }
      const parent = first(s.options.parent)
      if (parent !== '' && !buckets.has(parent)) {
        add(
          s,
          'error',
          'perch_qos_unknown_bucket',
          `parent bucket ${parent} does not exist`,
          'parent'
        )
      }
      const fairness = first(s.options.fairness)
      if (fairness !== '' && fairness !== 'per_host' && fairness !== 'per_flow') {
        add(
          s,
          'error',
          'perch_qos_bad_value',
          `fairness "${fairness}" is not per_host or per_flow`,
          'fairness'
        )
      }
    }
    for (const s of byType('network')) {
      const bucket = first(s.options.bucket)
      if (bucket !== '' && !buckets.has(bucket)) {
        add(s, 'error', 'perch_qos_unknown_bucket', `bucket ${bucket} does not exist`, 'bucket')
      }
    }
    for (const s of byType('schedule')) {
      const windows = list(s.options.window)
      const raw = s.options.window
      const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
      if (windows.length === 0)
        add(s, 'error', 'perch_qos_bad_window', 'a schedule needs a window', 'window')
      for (const w of items) {
        if (!WINDOW.test(w.trim())) {
          add(
            s,
            'error',
            'perch_qos_bad_window',
            `window "${w}" is not "<days> HH:MM-HH:MM"`,
            'window'
          )
        }
      }
      const action = first(s.options.action)
      if (!['limit', 'unlimited', 'block', 'move'].includes(action)) {
        add(
          s,
          'error',
          'perch_qos_bad_value',
          `action "${action}" is not limit, unlimited, block or move`,
          'action'
        )
      }
      const bucket = first(s.options.bucket)
      if (action === 'move' && bucket !== '' && !buckets.has(bucket)) {
        add(
          s,
          'error',
          'perch_qos_unknown_bucket',
          `schedule moves to bucket ${bucket}, which does not exist`,
          'bucket'
        )
      }
    }
    return issues
  },
} satisfies ConfigDomain<PerchQosSection>
