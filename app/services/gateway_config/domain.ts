import {
  canonicalText,
  DEFAULT_RULES,
  type ListSemantics,
  type MergeRules,
} from '#services/gateway_config/canonical'
import { isSecretOption, routerSecretSlots } from '#services/gateway_config/secrets'
import {
  WHOLE_SECTION,
  type GatewayCapabilities,
  type Issue,
  type ManagementPath,
  type SecretSlot,
  type SectionContent,
  type SectionOwnership,
  type UciConfigSet,
  type UciOptions,
  type UciSection,
  type UciValue,
} from '#services/gateway_config/types'

/**
 * Config domains: the extension point sibling plans plug into
 * (docs/gateway/config-plane.md section 7). A domain models some section
 * types of some UCI configs: it says which sections it claims and what it
 * owns inside them, turns sections into its objects (`parse`) and objects
 * back into section edits (`render`), validates the desired state and
 * refines the merge (list semantics, normalisation, secrets, identity).
 *
 * Invariant, tested for every domain (`checkRoundTrip`): rendering the
 * parsed objects back over the same sections is a no-op. The sync engine
 * also checks it per section on import; a section a domain cannot round-trip
 * stays `unmodeled` (issue `no_round_trip`), so a domain bug can never make
 * Perch rewrite a section it does not understand.
 */

/**
 * Configs that never go through the config plane (README 3.4, the union of
 * plans 1 and 2): the agent's own config, the AP daemon's, rpcd, uhttpd,
 * dropbear and LuCI. `perch-managed` (the ledger) is written by the agent
 * alone. The agent enforces the same list; the registry refuses a domain
 * that names one of them.
 */
export const EXCLUDED_CONFIGS: readonly string[] = Object.freeze([
  'perch-collector',
  'perch-apd',
  'rpcd',
  'uhttpd',
  'dropbear',
  'luci',
  'perch-managed',
])

/** The ledger config (README 3.1). */
export const LEDGER_CONFIG = 'perch-managed'

/**
 * Apply order across configs within one job (README 3.5, plan 2 P7):
 * system → network → dhcp → firewall → sqm / perch-qos → opennds → mwan3 /
 * pbr. Configs not listed come after, alphabetically.
 */
export const CONFIG_APPLY_ORDER: readonly string[] = Object.freeze([
  'system',
  'network',
  'dhcp',
  'firewall',
  'sqm',
  'perch-qos',
  'opennds',
  'mwan3',
  'pbr',
])

export function configOrderIndex(config: string): number {
  const index = CONFIG_APPLY_ORDER.indexOf(config)
  return index === -1 ? CONFIG_APPLY_ORDER.length : index
}

/** Compares two config names in apply order. */
export function compareConfigs(a: string, b: string): number {
  return configOrderIndex(a) - configOrderIndex(b) || a.localeCompare(b)
}

/**
 * A section as a domain sees it: the desired side of a synced section (or
 * the router's, for a section being imported). `perchId` is null for a
 * section not in the controller yet.
 */
export interface SyncedSection {
  perchId: string | null
  config: string
  name: string
  type: string
  anonymous: boolean
  options: UciOptions
  secrets?: Record<string, SecretSlot>
  /** Index among the router's sections of its config, when known (validation only). */
  position?: number | null
}

/** What a domain edit sets on a secret option. */
export type SecretEdit =
  /** A value stored in `gateway_secrets` under `ref`, with its fingerprint for this section. */
  | { ref: string; fingerprint: string }
  /** Leave the router's value (it owns it). */
  | { keep: true }

/**
 * A domain's edit of the desired state. `put` fully replaces the options of
 * the section (`perchId`, or a new one when null); `render` must therefore
 * carry every option it does not model verbatim. `order` sets the desired
 * order of an ordered type (`orderedTypes`).
 */
export type SectionEdit =
  | {
      op: 'put'
      perchId: string | null
      config: string
      type: string
      /** Name for a new section; default `perch_<perchId>`. Ignored for an existing one. */
      name?: string
      options: UciOptions
      secrets?: Record<string, SecretEdit>
    }
  | { op: 'delete'; perchId: string }
  | { op: 'order'; config: string; type: string; perchIds: string[] }

/** What `validate` gets besides the domain's own desired sections. */
export interface ValidationCtx {
  capabilities: GatewayCapabilities | null
  /** Every desired synced section of the gateway, all domains (cross-domain checks). */
  all: SyncedSection[]
  /** Router sections no domain manages (unmodeled/excluded), for collision checks. */
  unmanaged?: SyncedSection[]
  /** LAN-side networks with their IPv4 CIDRs (router address/prefix), when known. */
  networks?: Array<{ name: string; ipv4: string[] }>
  managementPath?: ManagementPath | null
}

/**
 * What the per-feature "in sync" checks see besides the sections (plan 2
 * section 4.6 (d)): the latest observation parts the agent reported, each
 * null when the agent does not report it or the report is stale (a check
 * that cannot be verified is skipped, never guessed).
 */
export interface FeatureObservation {
  /** `system` part: the host name the router runs with. */
  hostname?: string | null
  /** `resolver` part. */
  resolver?: {
    dnsmasqPort: number | null
    controllerHost: { name: string | null; addresses: string[]; error: string | null } | null
  } | null
  /** `interfaces` part: the networks netifd knows. */
  interfaces?: Array<{ network: string; up: boolean | null }> | null
}

/** A section as a feature check sees it: its desired content (the router's when not synced). */
export interface FeatureSection {
  perchId: string
  name: string
  type: string
  scope: 'synced' | 'excluded' | 'unmodeled'
  issue: string | null
  options: UciOptions
}

/** One reason a feature is not verifiably in sync (409 `authoritative_not_in_sync` reasons). */
export interface FeatureSyncIssue {
  feature: string
  objectId: string | null
  code: string
  message: string
}

export interface ConfigDomain<Obj = unknown> {
  /** 'networks' | 'dhcp_hosts' | 'firewall' | 'qos' | 'portal' | … (≤ 32 chars). */
  key: string
  /** UCI configs it reads and writes (must be on the router allowlist; never EXCLUDED_CONFIGS). */
  configs: string[]
  /** Section types it may claim (a fast filter; `claims` decides). */
  types: string[]
  /** Does this domain model the section? */
  claims(section: UciSection & { config: string }, all: UciConfigSet): boolean
  /**
   * What Perch owns inside a claimed section (README 3.2). Default: the
   * whole section. Option-level ownership keeps router-owned options out of
   * the merge (router always wins there) and out of drift.
   */
  ownership?(section: UciSection & { config: string }): SectionOwnership
  /** null = usable; else the reason ("sqm-scripts not installed"). */
  requires?(caps: GatewayCapabilities): string | null
  /** Types whose section order is meaningful (firewall `rule`, `redirect`). */
  orderedTypes?: string[]
  /** List merge semantics by `type.option`; default atomic. */
  listSemantics?: Record<string, ListSemantics>
  /** Extra secret options, `type.option` or bare option names. */
  secretOptions?: string[]
  /** Equality normaliser (never applied to stored content). */
  normalize?(type: string, option: string, value: UciValue): UciValue
  /**
   * Identity keys of a section (plan 2 P6): two sections sharing a key are
   * the same object (`mac:02:00:00:…`). Used to re-link a synced section the
   * router renamed or lost from the ledger, and to flag duplicates as
   * `ambiguous` (never managed until fixed).
   */
  identityKeys?(section: { type: string; options: UciOptions }): string[]
  /**
   * Does this section carry the management path (README 3.8)? Adds to the
   * engine's built-in rules for `network` and `firewall`.
   */
  touchesManagement?(
    section: { type: string; name: string; options: UciOptions },
    path: ManagementPath
  ): boolean
  /** UCI → domain objects (reads for its REST API). */
  parse(sections: SyncedSection[]): Obj[]
  /** Domain object → section edits; options it does not model are kept verbatim from `current`. */
  render(obj: Obj, current: SyncedSection[]): SectionEdit[]
  /** Cross-section checks; `error` issues block an apply. */
  validate(desired: SyncedSection[], ctx: ValidationCtx): Issue[]
  /**
   * The feature's own "in sync" check (plan 2 section 4.6 (d)), beyond the
   * engine's per-section equality: runtime facts the router reports (the
   * host name it runs with, dnsmasq answering, …). Gets every row of the
   * domain (synced sections with their desired content; ambiguous ones are
   * handled by the engine). An issue blocks enabling Authoritative Mode.
   */
  inSync?(sections: FeatureSection[], observed: FeatureObservation): FeatureSyncIssue[]
}

/** The result of claiming a router section. */
export interface DomainClaim {
  domain: ConfigDomain
  ownership: SectionOwnership
}

/** Merge rules for one domain (or the defaults when `domain` is null). */
export function rulesFor(domain: ConfigDomain | null | undefined): MergeRules {
  if (!domain) return DEFAULT_RULES
  const semantics = domain.listSemantics ?? {}
  const secrets = domain.secretOptions ?? []
  return {
    listSemantics: (type, option) => semantics[`${type}.${option}`] ?? 'atomic',
    normalize: (type, option, value) =>
      domain.normalize ? domain.normalize(type, option, value) : value,
    isSecret: (type, option) => isSecretOption(type, option, secrets),
  }
}

const DOMAIN_KEY = /^[a-z][a-z0-9_]{0,31}$/

/** The set of domains a controller runs with. */
export class DomainRegistry {
  readonly #domains: ConfigDomain[]
  readonly #byKey = new Map<string, ConfigDomain>()
  readonly #rules = new Map<string, MergeRules>()

  constructor(domains: ConfigDomain[]) {
    for (const domain of domains) {
      if (!DOMAIN_KEY.test(domain.key)) throw new Error(`invalid domain key "${domain.key}"`)
      if (this.#byKey.has(domain.key)) throw new Error(`duplicate domain key "${domain.key}"`)
      const excluded = domain.configs.filter((c) => EXCLUDED_CONFIGS.includes(c))
      if (excluded.length > 0) {
        throw new Error(`domain "${domain.key}" names excluded configs: ${excluded.join(', ')}`)
      }
      this.#byKey.set(domain.key, domain)
      this.#rules.set(domain.key, rulesFor(domain))
    }
    this.#domains = [...domains]
  }

  list(): readonly ConfigDomain[] {
    return this.#domains
  }

  get(key: string | null | undefined): ConfigDomain | null {
    return key ? (this.#byKey.get(key) ?? null) : null
  }

  /** Configs any domain reads or writes. */
  configs(): string[] {
    return [...new Set(this.#domains.flatMap((d) => d.configs))].sort(compareConfigs)
  }

  rules(key: string | null | undefined): MergeRules {
    return (key ? this.#rules.get(key) : undefined) ?? DEFAULT_RULES
  }

  /**
   * The domain that models a router section, first registered wins. A
   * section of an excluded config is never claimed.
   */
  claim(section: UciSection & { config: string }, all: UciConfigSet): DomainClaim | null {
    if (EXCLUDED_CONFIGS.includes(section.config)) return null
    for (const domain of this.#domains) {
      if (!domain.configs.includes(section.config)) continue
      if (!domain.types.includes(section.type)) continue
      if (!domain.claims(section, all)) continue
      return { domain, ownership: domain.ownership?.(section) ?? WHOLE_SECTION }
    }
    return null
  }
}

/** A section read from the router as a `SyncedSection` (secrets as ref-less slots). */
export function syncedFromRouter(
  config: string,
  section: UciSection,
  perchId: string | null = null
): SyncedSection {
  const secrets = routerSecretSlots(section.secrets)
  return {
    perchId,
    config,
    name: section.name,
    type: section.type,
    anonymous: section.anonymous,
    options: { ...section.options },
    ...(secrets ? { secrets } : {}),
  }
}

/** The stored content of a `SyncedSection`. */
export function contentOf(section: SyncedSection): SectionContent {
  return section.secrets && Object.keys(section.secrets).length > 0
    ? { type: section.type, options: { ...section.options }, secrets: { ...section.secrets } }
    : { type: section.type, options: { ...section.options } }
}

/** A section-edit failure (`applySectionEdits`). */
export class SectionEditError extends Error {}

/**
 * Applies domain edits to a list of sections, purely: the desired state
 * after the edits. `put` without a perchId creates a section with a fresh id
 * from `newPerchId`. Secrets: `{ref, fingerprint}` sets a controller slot,
 * `{keep}` keeps the current slot (and fails when there is none to keep).
 * Also used by the round-trip harness and by `planSectionEdits`.
 */
export function applySectionEdits(
  current: SyncedSection[],
  edits: SectionEdit[],
  newPerchId: () => string = defaultIdFactory(current)
): SyncedSection[] {
  const out = current.map((s) => ({ ...s, options: { ...s.options } }))
  const indexOf = (perchId: string) => out.findIndex((s) => s.perchId === perchId)
  for (const edit of edits) {
    if (edit.op === 'delete') {
      const index = indexOf(edit.perchId)
      if (index === -1) throw new SectionEditError(`no section ${edit.perchId} to delete`)
      out.splice(index, 1)
      continue
    }
    if (edit.op === 'order') {
      const wanted = edit.perchIds
      const members = out.filter((s) => s.config === edit.config && s.type === edit.type)
      const missing = wanted.filter((id) => !members.some((s) => s.perchId === id))
      if (missing.length > 0)
        throw new SectionEditError(`order names unknown ${missing.join(', ')}`)
      const ordered = [
        ...wanted.map((id) => members.find((s) => s.perchId === id)!),
        ...members.filter((s) => !wanted.includes(s.perchId ?? '')),
      ]
      let k = 0
      for (let i = 0; i < out.length; i++) {
        if (out[i].config === edit.config && out[i].type === edit.type) out[i] = ordered[k++]
      }
      continue
    }
    const existingIndex = edit.perchId ? indexOf(edit.perchId) : -1
    if (edit.perchId && existingIndex === -1) {
      throw new SectionEditError(`no section ${edit.perchId} to put`)
    }
    const existing = existingIndex === -1 ? null : out[existingIndex]
    const secrets: Record<string, SecretSlot> = {}
    for (const [name, secret] of Object.entries(edit.secrets ?? {})) {
      if ('keep' in secret) {
        const slot = existing?.secrets?.[name]
        if (!slot) throw new SectionEditError(`no secret ${name} to keep on ${edit.perchId}`)
        secrets[name] = { ...slot }
      } else {
        secrets[name] = { ref: secret.ref, fingerprint: secret.fingerprint }
      }
    }
    if (existing) {
      if (existing.config !== edit.config) {
        throw new SectionEditError(`section ${edit.perchId} is in ${existing.config}`)
      }
      out[existingIndex] = {
        ...existing,
        type: edit.type,
        options: { ...edit.options },
        ...(Object.keys(secrets).length > 0 ? { secrets } : { secrets: undefined }),
      }
      if (!out[existingIndex].secrets) delete out[existingIndex].secrets
    } else {
      const perchId = newPerchId()
      out.push({
        perchId,
        config: edit.config,
        name: edit.name ?? `perch_${perchId}`,
        type: edit.type,
        anonymous: false,
        options: { ...edit.options },
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      })
    }
  }
  return out
}

function defaultIdFactory(current: SyncedSection[]): () => string {
  let n = 0
  const taken = new Set(current.map((s) => s.perchId))
  return () => {
    let id: string
    do id = `new${++n}`
    while (taken.has(id))
    taken.add(id)
    return id
  }
}

/** One failure of the round-trip invariant. */
export interface RoundTripFailure {
  section: string
  reason: 'changed' | 'removed' | 'added' | 'error'
  before: string | null
  after: string | null
}

export interface RoundTripReport {
  ok: boolean
  failures: RoundTripFailure[]
}

/**
 * The round-trip invariant (section 7): for the sections a domain claims,
 * `render(parse(x))` applied to x must change nothing, exactly (list order,
 * scalar vs list, unknown options). Comparison is strict canonical text, not
 * the domain's normalised equality: a round trip that only normalises would
 * still produce apply ops against the router.
 *
 * Sections without a perchId get stand-in ids (`rt<index>`), so domains
 * that key their objects by perchId work unchanged.
 */
export function checkRoundTrip(domain: ConfigDomain, sections: SyncedSection[]): RoundTripReport {
  const input = sections.map((s, i) => ({ ...s, perchId: s.perchId ?? `rt${i}` }))
  const failures: RoundTripFailure[] = []
  let output: SyncedSection[]
  try {
    const objects = domain.parse(input)
    const edits = objects.flatMap((obj) => domain.render(obj, input))
    output = applySectionEdits(input, edits, () => {
      throw new SectionEditError('render created a section')
    })
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          section: input.map((s) => s.name).join(','),
          reason: 'error',
          before: null,
          after: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
  for (const before of input) {
    const after = output.find((s) => s.perchId === before.perchId)
    if (!after) {
      failures.push({ section: before.name, reason: 'removed', before: text(before), after: null })
    } else if (text(before) !== text(after) || before.name !== after.name) {
      failures.push({
        section: before.name,
        reason: 'changed',
        before: text(before),
        after: text(after),
      })
    }
  }
  for (const after of output) {
    if (!input.some((s) => s.perchId === after.perchId)) {
      failures.push({ section: after.name, reason: 'added', before: null, after: text(after) })
    }
  }
  return { ok: failures.length === 0, failures }
}

function text(section: SyncedSection): string {
  return canonicalText(contentOf(section))
}

/** Whether one router section survives the round trip on its own. */
export function roundTripsSection(domain: ConfigDomain, section: SyncedSection): boolean {
  return checkRoundTrip(domain, [section]).ok
}

/** Runs every domain's `validate` over the desired synced sections it owns. */
export function validateDesired(
  registry: DomainRegistry,
  desired: Array<SyncedSection & { domain: string | null }>,
  ctx: Omit<ValidationCtx, 'all'>
): Issue[] {
  const issues: Issue[] = []
  for (const domain of registry.list()) {
    const own = desired.filter((s) => s.domain === domain.key)
    if (own.length === 0) continue
    issues.push(...domain.validate(own, { ...ctx, all: desired }))
  }
  return issues
}
