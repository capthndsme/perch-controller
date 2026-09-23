import type { UciOptions, UciValue } from '#services/gateway_config/types'

/**
 * UCI `sqm` `queue` section ⇄ Perch's WAN queue model (docs/gateway/qos.md
 * section 2.1; plan 3 section 2.1). Pure: no I/O, fixture-tested
 * (tests/unit/services/sqm_mapping.spec.ts).
 *
 * The source of truth is the section's **full option map**. The API fields
 * are views over it (`parseSqmQueue`), and a write (`applySqmPatch`) touches
 * only the options it maps: options Perch does not model (`tcMTU`, `ilimit`,
 * `itarget`, `linklayer_adaptation_mechanism`, anything newer) survive, and
 * so do the cake keywords Perch does not model inside `iqdisc_opts` /
 * `eqdisc_opts` (`wash`, `ack-filter`, `memlimit 32mb`, …).
 *
 * sqm-scripts semantics this follows (1.6.0):
 * - `download` / `upload` are kbit/s; 0 = that direction unshaped.
 * - `squash_dscp`, `squash_ingress`, `ingress_ecn`, `egress_ecn` only take
 *   effect with `qdisc_advanced '1'`; `iqdisc_opts` / `eqdisc_opts` only with
 *   `qdisc_really_really_advanced '1'` as well; `tcMPU` only with
 *   `linklayer_advanced '1'`; `overhead` only with a link layer.
 *   The views read the effective value, so an inert option never shows.
 * - `piece_of_cake.qos` runs cake besteffort, `layer_cake.qos` diffserv3;
 *   a `diffserv4` / `diffserv8` keyword in the opts overrides the tin mode.
 * - Cake's default flow isolation is `triple-isolate`, its default `nonat`.
 */

export const SQM_DIFFSERV = ['besteffort', 'diffserv3', 'diffserv4', 'diffserv8'] as const
export type SqmDiffserv = (typeof SQM_DIFFSERV)[number]

export const SQM_FAIRNESS = ['per_host', 'triple_isolate', 'per_flow'] as const
export type SqmFairness = (typeof SQM_FAIRNESS)[number]

export const SQM_LINK_LAYERS = ['none', 'ethernet', 'atm'] as const
export type SqmLinkLayer = (typeof SQM_LINK_LAYERS)[number]

/** Qdiscs Perch writes. Any other router value is kept and shown read-only. */
export const SQM_WRITABLE_QDISCS = ['cake', 'fq_codel'] as const
export type SqmWritableQdisc = (typeof SQM_WRITABLE_QDISCS)[number]

/** Options the mapping reads or writes; every other option rides along verbatim. */
export const SQM_MAPPED_OPTIONS: readonly string[] = Object.freeze([
  'enabled',
  'interface',
  'download',
  'upload',
  'qdisc',
  'script',
  'qdisc_advanced',
  'qdisc_really_really_advanced',
  'iqdisc_opts',
  'eqdisc_opts',
  'linklayer',
  'overhead',
  'linklayer_advanced',
  'tcMPU',
  'ingress_ecn',
  'egress_ecn',
  'squash_dscp',
  'squash_ingress',
])

/** Options `advanced` may not set: they have typed fields (or are identity). */
export const SQM_TYPED_OPTIONS: readonly string[] = SQM_MAPPED_OPTIONS

/**
 * sqm-scripts' defaults (`defaults.sh` + the LuCI app), used to decide
 * equality (`normalizeSqmOptions`): an option spelled out at its default and
 * an absent one are the same queue.
 */
export const SQM_OPTION_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  enabled: '0',
  qdisc: 'fq_codel',
  script: 'simple.qos',
  qdisc_advanced: '0',
  qdisc_really_really_advanced: '0',
  iqdisc_opts: '',
  eqdisc_opts: '',
  ingress_ecn: 'ECN',
  egress_ecn: 'NOECN',
  squash_dscp: '1',
  squash_ingress: '1',
  linklayer: 'none',
  overhead: '0',
  linklayer_advanced: '0',
  tcMTU: '2047',
  tcTSIZE: '128',
  tcMPU: '0',
  linklayer_adaptation_mechanism: 'default',
  debug_logging: '0',
  verbosity: '5',
})

const BOOLEAN_OPTIONS = new Set([
  'enabled',
  'qdisc_advanced',
  'qdisc_really_really_advanced',
  'squash_dscp',
  'squash_ingress',
  'linklayer_advanced',
  'debug_logging',
])

const NUMERIC_OPTIONS = new Set([
  'download',
  'upload',
  'overhead',
  'tcMTU',
  'tcTSIZE',
  'tcMPU',
  'verbosity',
  'ilimit',
  'elimit',
])

const OPTS_OPTIONS = new Set(['iqdisc_opts', 'eqdisc_opts'])
const ECN_OPTIONS = new Set(['ingress_ecn', 'egress_ecn'])

const DIFFSERV_TOKENS = new Set(['besteffort', 'diffserv3', 'diffserv4', 'diffserv8', 'precedence'])
const FAIRNESS_TOKENS = new Set([
  'dual-srchost',
  'dual-dsthost',
  'triple-isolate',
  'flows',
  'srchost',
  'dsthost',
  'hosts',
  'flowblind',
])
const NAT_TOKENS = new Set(['nat', 'nonat'])

const SCRIPT_BESTEFFORT = 'piece_of_cake.qos'
const SCRIPT_LAYERED = 'layer_cake.qos'
const SCRIPT_SIMPLE = 'simple.qos'

/** The typed view of one queue (the API's `QosWanQueue` without ids, sync and live data). */
export interface SqmQueueView {
  device: string
  enabled: boolean
  downloadKbit: number
  uploadKbit: number
  /** The router's qdisc as written (`cake`, `fq_codel`, or anything else, read-only). */
  qdisc: string
  script: string
  /** Cake tin mode; null when the qdisc is not cake or the mode is not one Perch models. */
  diffserv: SqmDiffserv | null
  /** Cake flow isolation; `per_flow` for fq_codel; null when unmodelled. */
  fairness: SqmFairness | null
  /** Cake NAT awareness; null when the qdisc is not cake. */
  nat: boolean | null
  linkLayer: SqmLinkLayer
  overhead: number | null
  mpu: number | null
  ingressEcn: boolean
  egressEcn: boolean
  squashDscp: boolean
  squashIngress: boolean
  /** Things the dashboard should say about this queue (see `SQM_FLAGS`). */
  flags: string[]
}

/**
 * Per-queue flags:
 * - `qdisc_unmodeled`: a qdisc other than cake / fq_codel (e.g. a router-set
 *   `sfq`): shown and kept, not editable by type.
 * - `script_unmodeled`: a cake queue whose script is neither piece_of_cake
 *   nor layer_cake (tin mode unknown).
 * - `fairness_unmodeled`: a cake isolation keyword the model has no name for
 *   (`srchost`, `hosts`, `flowblind`, …).
 * - `fairness_mixed`, `nat_mixed`: egress and ingress disagree (the egress
 *   side is reported).
 * - `diffserv_unmodeled`: `precedence` or conflicting tin keywords.
 * - `invalid_rate`, `invalid_overhead`, `invalid_mpu`: not a whole number
 *   (read as 0 / null).
 * - `unknown_linklayer`: a link layer other than none / ethernet / atm
 *   (read as none).
 * - `inert_opts`: opts are set but `qdisc_really_really_advanced` is off, so
 *   sqm ignores them.
 * - `duplicate_device` (set by `sqmQueueSetFlags`): another enabled queue
 *   uses the same device.
 */
export const SQM_FLAGS = [
  'qdisc_unmodeled',
  'script_unmodeled',
  'fairness_unmodeled',
  'fairness_mixed',
  'nat_mixed',
  'diffserv_unmodeled',
  'invalid_rate',
  'invalid_overhead',
  'invalid_mpu',
  'unknown_linklayer',
  'inert_opts',
  'duplicate_device',
] as const

function scalar(options: UciOptions, key: string): string | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(' ') : value
}

function isOn(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase())
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const text = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false
  return fallback
}

function wholeNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

function signedNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!/^-?\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** Whitespace-separated cake keywords of an opts value. */
export function optsTokens(value: string | undefined): string[] {
  if (!value) return []
  return value.split(/\s+/).filter((token) => token.length > 0)
}

function isCake(qdisc: string): boolean {
  return qdisc === 'cake'
}

function fairnessOfToken(token: string | undefined): SqmFairness | null | undefined {
  switch (token) {
    case undefined:
      return undefined
    case 'dual-srchost':
    case 'dual-dsthost':
      return 'per_host'
    case 'triple-isolate':
      return 'triple_isolate'
    case 'flows':
      return 'per_flow'
    default:
      return null
  }
}

/** The effective opts of both directions (empty when sqm ignores them). */
function effectiveOpts(options: UciOptions): {
  egress: string[]
  ingress: string[]
  active: boolean
} {
  const active =
    isOn(scalar(options, 'qdisc_advanced')) && isOn(scalar(options, 'qdisc_really_really_advanced'))
  if (!active) return { egress: [], ingress: [], active }
  return {
    egress: optsTokens(scalar(options, 'eqdisc_opts')),
    ingress: optsTokens(scalar(options, 'iqdisc_opts')),
    active,
  }
}

/** UCI options → the typed view. Never throws; oddities become flags. */
export function parseSqmQueue(options: UciOptions): SqmQueueView {
  const flags = new Set<string>()
  const qdisc = scalar(options, 'qdisc')?.trim() || SQM_OPTION_DEFAULTS.qdisc
  const script = scalar(options, 'script')?.trim() || SQM_OPTION_DEFAULTS.script
  const cake = isCake(qdisc)
  if (!(SQM_WRITABLE_QDISCS as readonly string[]).includes(qdisc)) flags.add('qdisc_unmodeled')

  const rate = (key: 'download' | 'upload') => {
    const raw = scalar(options, key)
    if (raw === undefined) return 0
    const n = wholeNumber(raw)
    if (n === null) {
      flags.add('invalid_rate')
      return 0
    }
    return n
  }

  const opts = effectiveOpts(options)
  if (
    !opts.active &&
    (optsTokens(scalar(options, 'eqdisc_opts')).length > 0 ||
      optsTokens(scalar(options, 'iqdisc_opts')).length > 0)
  ) {
    flags.add('inert_opts')
  }

  let diffserv: SqmDiffserv | null = null
  let fairness: SqmFairness | null = null
  let nat: boolean | null = null
  if (cake) {
    const tinTokens = [...opts.egress, ...opts.ingress].filter((t) => DIFFSERV_TOKENS.has(t))
    const distinct = [...new Set(tinTokens)]
    if (distinct.length > 1 || distinct[0] === 'precedence') {
      flags.add('diffserv_unmodeled')
    } else if (distinct.length === 1) {
      diffserv = distinct[0] as SqmDiffserv
    } else if (script === SCRIPT_BESTEFFORT) {
      diffserv = 'besteffort'
    } else if (script === SCRIPT_LAYERED) {
      diffserv = 'diffserv3'
    } else {
      flags.add('script_unmodeled')
    }

    const egressFairness = fairnessOfToken(opts.egress.findLast((t) => FAIRNESS_TOKENS.has(t)))
    const ingressFairness = fairnessOfToken(opts.ingress.findLast((t) => FAIRNESS_TOKENS.has(t)))
    const egressValue = egressFairness === undefined ? 'triple_isolate' : egressFairness
    const ingressValue = ingressFairness === undefined ? 'triple_isolate' : ingressFairness
    if (egressValue === null) flags.add('fairness_unmodeled')
    else if (ingressValue !== egressValue) flags.add('fairness_mixed')
    fairness = egressValue

    const natOf = (tokens: string[]) => tokens.findLast((t) => NAT_TOKENS.has(t)) === 'nat'
    nat = natOf(opts.egress)
    if (natOf(opts.ingress) !== nat) flags.add('nat_mixed')
  } else if (qdisc === 'fq_codel') {
    fairness = 'per_flow'
  }

  const linkRaw = scalar(options, 'linklayer')?.trim() || 'none'
  let linkLayer: SqmLinkLayer = 'none'
  if ((SQM_LINK_LAYERS as readonly string[]).includes(linkRaw)) {
    linkLayer = linkRaw as SqmLinkLayer
  } else {
    flags.add('unknown_linklayer')
  }

  let overhead: number | null = null
  if (linkLayer !== 'none') {
    const raw = scalar(options, 'overhead')
    if (raw === undefined) overhead = 0
    else {
      overhead = signedNumber(raw)
      if (overhead === null) flags.add('invalid_overhead')
    }
  }

  let mpu: number | null = null
  if (linkLayer !== 'none' && isOn(scalar(options, 'linklayer_advanced'))) {
    const raw = scalar(options, 'tcMPU')
    if (raw !== undefined) {
      mpu = wholeNumber(raw)
      if (mpu === null) flags.add('invalid_mpu')
      else if (mpu === 0) mpu = null
    }
  }

  const advanced = isOn(scalar(options, 'qdisc_advanced'))
  const ecn = (key: string, fallback: boolean) => {
    if (!advanced) return fallback
    const raw = scalar(options, key)?.trim().toUpperCase()
    if (raw === 'ECN') return true
    if (raw === 'NOECN') return false
    return fallback
  }

  return {
    device: scalar(options, 'interface')?.trim() ?? '',
    enabled: isOn(scalar(options, 'enabled')),
    downloadKbit: rate('download'),
    uploadKbit: rate('upload'),
    qdisc,
    script,
    diffserv,
    fairness,
    nat,
    linkLayer,
    overhead,
    mpu,
    ingressEcn: ecn('ingress_ecn', true),
    egressEcn: ecn('egress_ecn', false),
    squashDscp: advanced ? boolOr(scalar(options, 'squash_dscp'), true) : true,
    squashIngress: advanced ? boolOr(scalar(options, 'squash_ingress'), true) : true,
    flags: [...flags].sort(),
  }
}

/** A write to a queue: every field optional (POST fills the required ones). */
export interface SqmQueuePatch {
  device?: string
  enabled?: boolean
  downloadKbit?: number
  uploadKbit?: number
  qdisc?: SqmWritableQdisc
  diffserv?: SqmDiffserv
  fairness?: SqmFairness
  nat?: boolean
  linkLayer?: SqmLinkLayer
  /** null clears it. */
  overhead?: number | null
  /** null clears it. */
  mpu?: number | null
  ingressEcn?: boolean
  egressEcn?: boolean
  squashDscp?: boolean
  squashIngress?: boolean
  /** Raw UCI options Perch does not type: keys merge, `null` removes. */
  advanced?: Record<string, string | null>
}

/** A patch the mapping refuses; `code` is the API's 422 error. */
export class SqmMappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string
  ) {
    super(message)
  }
}

export interface SqmPatchResult {
  options: UciOptions
  /** UCI options whose value changed (added, removed or different), sorted. */
  changed: string[]
  /** Non-blocking notes (`sqm_inert_opts_replaced`). */
  warnings: string[]
}

const ADVANCED_KEY = /^[A-Za-z0-9_]{1,64}$/

/**
 * Replaces the keywords of one class (`classTokens`) in an opts token list:
 * the first one is replaced in place by `replacement` (or dropped when null),
 * later ones are removed, and `replacement` is appended when there was none.
 */
function replaceTokens(
  tokens: string[],
  classTokens: Set<string>,
  replacement: string | null
): string[] {
  const out: string[] = []
  let placed = false
  for (const token of tokens) {
    if (!classTokens.has(token)) {
      out.push(token)
      continue
    }
    if (!placed && replacement !== null) out.push(replacement)
    placed = true
  }
  if (!placed && replacement !== null) out.push(replacement)
  return out
}

/**
 * Applies a patch to a queue's options and returns the new map. Only the
 * options a patched field maps to change; everything else is copied
 * verbatim. Throws `SqmMappingError` for combinations sqm cannot express
 * (a cake field on a non-cake queue, an overhead without a link layer, an
 * `advanced` key that has a typed field).
 */
export function applySqmPatch(options: UciOptions, patch: SqmQueuePatch): SqmPatchResult {
  const out: UciOptions = {}
  for (const [key, value] of Object.entries(options)) {
    out[key] = Array.isArray(value) ? [...value] : value
  }
  const warnings: string[] = []

  for (const [key, value] of Object.entries(patch.advanced ?? {})) {
    if (!ADVANCED_KEY.test(key)) {
      throw new SqmMappingError('qos_invalid_option', `"${key}" is not a UCI option name`, key)
    }
    if (SQM_TYPED_OPTIONS.includes(key)) {
      throw new SqmMappingError(
        'qos_option_has_field',
        `"${key}" has its own field; set that instead`,
        key
      )
    }
    if (value === null) delete out[key]
    else out[key] = value
  }

  if (patch.device !== undefined) out.interface = patch.device
  if (patch.enabled !== undefined) out.enabled = patch.enabled ? '1' : '0'
  if (patch.downloadKbit !== undefined) out.download = String(patch.downloadKbit)
  if (patch.uploadKbit !== undefined) out.upload = String(patch.uploadKbit)

  // Qdisc and script first: the cake-only fields below depend on them.
  if (patch.qdisc !== undefined) {
    out.qdisc = patch.qdisc
    const script = scalar(out, 'script') ?? SQM_OPTION_DEFAULTS.script
    const cakeScript = script === SCRIPT_BESTEFFORT || script === SCRIPT_LAYERED
    if (patch.qdisc === 'cake' && !cakeScript) {
      out.script =
        patch.diffserv && patch.diffserv !== 'besteffort' ? SCRIPT_LAYERED : SCRIPT_BESTEFFORT
    } else if (patch.qdisc === 'fq_codel' && cakeScript) {
      out.script = SCRIPT_SIMPLE
    }
  }
  const qdisc = scalar(out, 'qdisc')?.trim() || SQM_OPTION_DEFAULTS.qdisc
  const cakeFields = (['diffserv', 'fairness', 'nat'] as const).filter(
    (field) => patch[field] !== undefined
  )
  if (cakeFields.length > 0 && !isCake(qdisc)) {
    throw new SqmMappingError(
      'qos_field_needs_cake',
      `${cakeFields.join(', ')} only apply to a cake queue (this one runs ${qdisc})`,
      cakeFields[0]
    )
  }

  if (cakeFields.length > 0) {
    const wasActive =
      isOn(scalar(out, 'qdisc_advanced')) && isOn(scalar(out, 'qdisc_really_really_advanced'))
    let egress = wasActive ? optsTokens(scalar(out, 'eqdisc_opts')) : []
    let ingress = wasActive ? optsTokens(scalar(out, 'iqdisc_opts')) : []
    const fresh = !wasActive || (egress.length === 0 && ingress.length === 0)
    if (
      !wasActive &&
      (optsTokens(scalar(out, 'eqdisc_opts')).length > 0 ||
        optsTokens(scalar(out, 'iqdisc_opts')).length > 0)
    ) {
      // Turning the opts on would bring old, inert keywords to life: start clean.
      warnings.push('sqm_inert_opts_replaced')
    }

    if (patch.diffserv !== undefined) {
      out.script = patch.diffserv === 'besteffort' ? SCRIPT_BESTEFFORT : SCRIPT_LAYERED
      const token =
        patch.diffserv === 'diffserv4' || patch.diffserv === 'diffserv8' ? patch.diffserv : null
      egress = replaceTokens(egress, DIFFSERV_TOKENS, token)
      ingress = replaceTokens(ingress, DIFFSERV_TOKENS, token)
    }
    if (patch.fairness !== undefined) {
      const [eg, ig] =
        patch.fairness === 'per_host'
          ? ['dual-srchost', 'dual-dsthost']
          : patch.fairness === 'triple_isolate'
            ? ['triple-isolate', 'triple-isolate']
            : ['flows', 'flows']
      egress = replaceTokens(egress, FAIRNESS_TOKENS, eg)
      ingress = replaceTokens(ingress, FAIRNESS_TOKENS, ig)
    }
    if (patch.nat !== undefined) {
      const keepNonat = (tokens: string[]) => tokens.includes('nonat')
      egress = replaceTokens(
        egress,
        NAT_TOKENS,
        patch.nat ? 'nat' : keepNonat(egress) ? 'nonat' : null
      )
      ingress = replaceTokens(
        ingress,
        NAT_TOKENS,
        patch.nat ? 'nat' : keepNonat(ingress) ? 'nonat' : null
      )
    }
    // A queue Perch sets up from scratch gets the plan's ingress spelling
    // (`nat dual-dsthost ingress`); an existing one keeps what it had.
    if (fresh && ingress.length > 0 && !ingress.includes('ingress')) ingress.push('ingress')
    // Cake reads `nat` first by convention; keep the order stable for a
    // fresh queue (the live queue's spelling: `nat dual-srchost`).
    if (fresh) {
      egress = orderFresh(egress)
      ingress = orderFresh(ingress)
    }
    out.qdisc_advanced = '1'
    out.qdisc_really_really_advanced = '1'
    out.eqdisc_opts = egress.join(' ')
    out.iqdisc_opts = ingress.join(' ')
  }

  if (patch.linkLayer !== undefined) out.linklayer = patch.linkLayer
  const linkLayer = scalar(out, 'linklayer')?.trim() || 'none'
  if (patch.overhead !== undefined) {
    if (patch.overhead === null) {
      delete out.overhead
    } else {
      if (linkLayer === 'none') {
        throw new SqmMappingError(
          'qos_overhead_needs_linklayer',
          'An overhead needs a link layer (ethernet or atm)',
          'overhead'
        )
      }
      out.overhead = String(patch.overhead)
    }
  }
  if (patch.mpu !== undefined) {
    if (patch.mpu === null) {
      delete out.tcMPU
    } else {
      if (linkLayer === 'none') {
        throw new SqmMappingError(
          'qos_overhead_needs_linklayer',
          'An MPU needs a link layer (ethernet or atm)',
          'mpu'
        )
      }
      out.linklayer_advanced = '1'
      out.tcMPU = String(patch.mpu)
    }
  }

  const advancedFields: Array<[keyof SqmQueuePatch, string, (v: boolean) => string]> = [
    ['ingressEcn', 'ingress_ecn', (v) => (v ? 'ECN' : 'NOECN')],
    ['egressEcn', 'egress_ecn', (v) => (v ? 'ECN' : 'NOECN')],
    ['squashDscp', 'squash_dscp', (v) => (v ? '1' : '0')],
    ['squashIngress', 'squash_ingress', (v) => (v ? '1' : '0')],
  ]
  for (const [field, option, render] of advancedFields) {
    const value = patch[field]
    if (typeof value !== 'boolean') continue
    out[option] = render(value)
    out.qdisc_advanced = '1'
  }

  return { options: out, changed: changedOptions(options, out), warnings }
}

function orderFresh(tokens: string[]): string[] {
  const rank = (t: string) =>
    NAT_TOKENS.has(t) ? 0 : DIFFSERV_TOKENS.has(t) ? 1 : FAIRNESS_TOKENS.has(t) ? 2 : 3
  return tokens
    .map((token, index) => ({ token, index }))
    .sort((a, b) => rank(a.token) - rank(b.token) || a.index - b.index)
    .map((entry) => entry.token)
}

/** Names of the options that differ between two maps (exact text), sorted. */
export function changedOptions(before: UciOptions, after: UciOptions): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names]
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .sort()
}

/** What POST /qos/wan-queues needs on top of a patch. */
export type NewSqmQueue = SqmQueuePatch & {
  device: string
  downloadKbit: number
  uploadKbit: number
}

/**
 * The options of a queue Perch creates: cake, besteffort, per-host fairness
 * with NAT awareness ("Fair sharing": the live gateway's shape), ECN on
 * ingress, default squash, no link-layer compensation, enabled. Explicit
 * fields in `input` override these.
 */
export function newSqmQueueOptions(input: NewSqmQueue): SqmPatchResult {
  const qdisc = input.qdisc ?? 'cake'
  const base: UciOptions = {
    enabled: '1',
    interface: input.device,
    download: '0',
    upload: '0',
    qdisc,
    script: qdisc === 'cake' ? SCRIPT_BESTEFFORT : SCRIPT_SIMPLE,
    linklayer: 'none',
    debug_logging: '0',
    verbosity: '5',
    qdisc_advanced: '1',
    squash_dscp: '1',
    squash_ingress: '1',
    ingress_ecn: 'ECN',
    egress_ecn: 'NOECN',
  }
  const cakeDefaults: SqmQueuePatch =
    qdisc === 'cake'
      ? {
          diffserv: input.diffserv ?? 'besteffort',
          fairness: input.fairness ?? 'per_host',
          nat: input.nat ?? true,
        }
      : {}
  const result = applySqmPatch(base, { ...input, qdisc, ...cakeDefaults })
  return { ...result, changed: changedOptions({}, result.options), warnings: [] }
}

function normalizeTokens(value: string): string {
  return optsTokens(value).join(' ')
}

/**
 * One option's value in its equality form (never stored): booleans as
 * '1' / '0', whole numbers without padding, ECN upper case, opts with single
 * spaces. Unknown options are trimmed only. Also the `normalize` hook of the
 * `sqm` config domain.
 */
export function normalizeSqmOption(option: string, value: UciValue): UciValue {
  if (Array.isArray(value)) return value.map((item) => item.trim())
  const text = value.trim()
  if (BOOLEAN_OPTIONS.has(option)) {
    const lower = text.toLowerCase()
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(lower)) return '1'
    if (['0', 'false', 'no', 'off', 'disabled'].includes(lower)) return '0'
    return text
  }
  if (NUMERIC_OPTIONS.has(option) && /^-?\d+$/.test(text)) return String(Number(text))
  if (ECN_OPTIONS.has(option)) return text.toUpperCase()
  if (OPTS_OPTIONS.has(option)) return normalizeTokens(text)
  return text
}

/**
 * A queue's options in equality form: every option normalised and sqm's
 * defaults filled in, so formatting and spelled-out defaults never count as
 * drift. Keys sorted.
 */
export function normalizeSqmOptions(options: UciOptions): Record<string, UciValue> {
  const merged: UciOptions = { ...SQM_OPTION_DEFAULTS }
  for (const [key, value] of Object.entries(options)) merged[key] = value
  const out: Record<string, UciValue> = {}
  for (const key of Object.keys(merged).sort()) {
    out[key] = normalizeSqmOption(key, merged[key])
  }
  return out
}

/** Equality of two queues' options under `normalizeSqmOptions`. */
export function sqmOptionsEqual(a: UciOptions, b: UciOptions): boolean {
  return JSON.stringify(normalizeSqmOptions(a)) === JSON.stringify(normalizeSqmOptions(b))
}

/**
 * Flags that need the whole set of a gateway's queues: `duplicate_device`
 * when two enabled queues shape the same device (both are kept; sqm would
 * run only one of them). Returns flags per input index.
 */
export function sqmQueueSetFlags(queues: Array<{ options: UciOptions }>): string[][] {
  const views = queues.map((q) => parseSqmQueue(q.options))
  const enabledPerDevice = new Map<string, number>()
  for (const view of views) {
    if (!view.enabled || view.device === '') continue
    enabledPerDevice.set(view.device, (enabledPerDevice.get(view.device) ?? 0) + 1)
  }
  return views.map((view) =>
    view.enabled && (enabledPerDevice.get(view.device) ?? 0) > 1 ? ['duplicate_device'] : []
  )
}

/** Linux interface name rule (IFNAMSIZ 16 incl. NUL; no '/', ':' or whitespace). */
export const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,14}$/
