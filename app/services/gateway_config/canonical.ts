import type {
  ConfigDiffEntry,
  ConfigDiffOption,
  SecretSlot,
  SectionContent,
  SectionOwnership,
  UciValue,
} from '#services/gateway_config/types'

/**
 * Canonical form, equality and diffs of section contents
 * (docs/gateway/config-plane.md section 5.1: "type plus options sorted by
 * name, list order kept, secrets compared by fingerprint").
 *
 * A domain can refine equality per option through `MergeRules`: a
 * normaliser (`12h` and `720m` are the same lease time, `mac 'a b'` and
 * `list mac` the same MAC set) and list semantics (`set` for a zone's
 * `list network`, `keyed` for `dhcp_option` items keyed by option code).
 * Equality always goes through the rules; stored content never is
 * normalised, so a round trip reproduces the router's spelling.
 */

/**
 * How a list option merges. `atomic` (default): the whole list is one value,
 * order matters (`list ports`). `set`: items merge one by one, order is not
 * significant. `keyed`: items merge one by one by the key the function
 * extracts; two different values under one key are a change of that key.
 */
export type ListSemantics = 'atomic' | 'set' | { keyed: (item: string) => string }

export interface MergeRules {
  listSemantics(type: string, option: string): ListSemantics
  normalize(type: string, option: string, value: UciValue): UciValue
  /** Secret option names (removed from `options`, compared by fingerprint). */
  isSecret(type: string, option: string): boolean
}

/** Rules without any domain knowledge: atomic lists, exact values. */
export const DEFAULT_RULES: MergeRules = Object.freeze({
  listSemantics: () => 'atomic' as const,
  normalize: (_type: string, _option: string, value: UciValue) => value,
  isSecret: () => false,
})

/** One named entry of a section: a plain value or a secret slot. */
export type Entry = { kind: 'value'; value: UciValue } | { kind: 'secret'; slot: SecretSlot }

/** Plain values and secrets of a content by name. Secrets win on a (malformed) clash. */
export function entriesOf(content: SectionContent | null): Map<string, Entry> {
  const map = new Map<string, Entry>()
  if (!content) return map
  for (const [name, value] of Object.entries(content.options ?? {})) {
    map.set(name, { kind: 'value', value })
  }
  for (const [name, slot] of Object.entries(content.secrets ?? {})) {
    map.set(name, { kind: 'secret', slot })
  }
  return map
}

/** Inverse of `entriesOf`. */
export function contentFromEntries(type: string, entries: Map<string, Entry>): SectionContent {
  const options: Record<string, UciValue> = {}
  const secrets: Record<string, SecretSlot> = {}
  for (const name of [...entries.keys()].sort()) {
    const entry = entries.get(name)!
    if (entry.kind === 'value') options[name] = cloneValue(entry.value)
    else secrets[name] = { ...entry.slot }
  }
  return Object.keys(secrets).length > 0 ? { type, options, secrets } : { type, options }
}

export function cloneValue(value: UciValue): UciValue {
  return Array.isArray(value) ? [...value] : value
}

export function cloneContent(content: SectionContent | null): SectionContent | null {
  if (!content) return null
  return contentFromEntries(content.type, entriesOf(content))
}

/** Items of a value seen as a list (a scalar is a one-item list). */
export function itemsOf(value: UciValue | undefined | null): string[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * The comparison key of a plain value under the rules: normalised, lists
 * sorted when their semantics say order does not matter. Scalars and lists
 * stay distinct (`option x 'a'` is not `list x 'a'`) unless the normaliser
 * maps one onto the other.
 */
export function valueKey(type: string, option: string, value: UciValue, rules: MergeRules): string {
  const normalized = rules.normalize(type, option, value)
  if (!Array.isArray(normalized)) return JSON.stringify(normalized)
  const semantics = rules.listSemantics(type, option)
  if (semantics === 'atomic') return JSON.stringify(['L', ...normalized])
  return JSON.stringify(['S', ...[...normalized].sort()])
}

/** Equality of two entries (either may be absent). */
export function entriesEqual(
  type: string,
  option: string,
  a: Entry | undefined,
  b: Entry | undefined,
  rules: MergeRules
): boolean {
  if (!a || !b) return !a && !b
  if (a.kind !== b.kind) return false
  if (a.kind === 'secret' && b.kind === 'secret') return a.slot.fingerprint === b.slot.fingerprint
  return (
    valueKey(type, option, (a as { value: UciValue }).value, rules) ===
    valueKey(type, option, (b as { value: UciValue }).value, rules)
  )
}

/** Whether Perch owns option `name` (item-owned list options count as owned). */
export function ownsOption(ownership: SectionOwnership | null | undefined, name: string): boolean {
  if (!ownership || ownership.kind === 'section') return true
  return ownership.options.includes(name) || Boolean(ownership.items && name in ownership.items)
}

/** The owned items of an item-owned list option, or null when the option is owned whole. */
export function ownedItems(
  ownership: SectionOwnership | null | undefined,
  name: string
): string[] | null {
  if (!ownership || ownership.kind === 'section') return null
  const items = ownership.items?.[name]
  return items ? items : null
}

/**
 * The part of a content Perch owns: owned options, and of item-owned list
 * options only the owned items (in the content's order). Used for drift
 * detection and for "in sync" checks; foreign options never count.
 */
export function ownedProjection(
  content: SectionContent | null,
  ownership: SectionOwnership | null | undefined
): SectionContent | null {
  if (!content) return null
  if (!ownership || ownership.kind === 'section') return content
  const entries = new Map<string, Entry>()
  for (const [name, entry] of entriesOf(content)) {
    if (!ownsOption(ownership, name)) continue
    const items = ownedItems(ownership, name)
    if (items && entry.kind === 'value') {
      const kept = itemsOf(entry.value).filter((item) => items.includes(item))
      if (kept.length > 0) entries.set(name, { kind: 'value', value: kept })
      continue
    }
    entries.set(name, entry)
  }
  return contentFromEntries(content.type, entries)
}

/**
 * Canonical equality of two contents (either may be null = absent).
 * With `ownership`, only the owned projection is compared.
 */
export function contentsEqual(
  a: SectionContent | null,
  b: SectionContent | null,
  rules: MergeRules = DEFAULT_RULES,
  ownership?: SectionOwnership | null
): boolean {
  if (!a || !b) return !a && !b
  if (a.type !== b.type) return false
  const left = entriesOf(ownership ? ownedProjection(a, ownership) : a)
  const right = entriesOf(ownership ? ownedProjection(b, ownership) : b)
  if (left.size !== right.size) return false
  for (const [name, entry] of left) {
    if (!entriesEqual(a.type, name, entry, right.get(name), rules)) return false
  }
  return true
}

/**
 * Stable text of a content: type, options sorted by name, lists in order,
 * secrets by fingerprint. Two contents with equal canonical text are equal
 * under `DEFAULT_RULES`.
 */
export function canonicalText(content: SectionContent | null): string {
  if (!content) return 'null'
  const entries = entriesOf(content)
  const parts = [...entries.keys()].sort().map((name) => {
    const entry = entries.get(name)!
    return [name, entry.kind === 'secret' ? { secret: entry.slot.fingerprint } : entry.value]
  })
  return JSON.stringify([content.type, parts])
}

/** Display form of an entry in a diff: secrets never show a value. */
function displayValue(entry: Entry | undefined): UciValue | null {
  if (!entry) return null
  if (entry.kind === 'secret') return entry.slot.fingerprint
  return cloneValue(entry.value)
}

/** Option-level changes from `before` to `after` (either may be null). */
export function diffOptions(
  before: SectionContent | null,
  after: SectionContent | null,
  rules: MergeRules = DEFAULT_RULES
): ConfigDiffOption[] {
  const type = after?.type ?? before?.type ?? ''
  const left = entriesOf(before)
  const right = entriesOf(after)
  const names = [...new Set([...left.keys(), ...right.keys()])].sort()
  const out: ConfigDiffOption[] = []
  for (const name of names) {
    const a = left.get(name)
    const b = right.get(name)
    if (entriesEqual(type, name, a, b, rules)) continue
    const option: ConfigDiffOption = { name, before: displayValue(a), after: displayValue(b) }
    if (a?.kind === 'secret' || b?.kind === 'secret') option.secret = true
    out.push(option)
  }
  return out
}

/**
 * One `ConfigDiffEntry` (section 10) for a section going from `before` to
 * `after`, or null when nothing changed.
 */
export function diffEntry(
  where: { perchId: string | null; config: string; section: string; domain: string | null },
  before: SectionContent | null,
  after: SectionContent | null,
  rules: MergeRules = DEFAULT_RULES
): ConfigDiffEntry | null {
  if (!before && !after) return null
  const type = after?.type ?? before!.type
  if (before && after && before.type !== after.type) {
    return {
      ...where,
      type,
      action: 'update',
      options: [
        { name: '.type', before: before.type, after: after.type },
        ...diffOptions(before, { ...after, type: before.type }, rules),
      ],
    }
  }
  const options = diffOptions(before, after, rules)
  if (before && after && options.length === 0) return null
  return {
    ...where,
    type,
    action: !before ? 'create' : !after ? 'delete' : 'update',
    options,
  }
}
