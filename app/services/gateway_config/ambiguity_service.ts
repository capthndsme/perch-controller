import type Gateway from '#models/gateway'
import {
  EditRefusedError,
  planSectionEdits,
  type EditSectionsResult,
} from '#services/gateway_config/apply_plan'
import { validateStates } from '#services/gateway_config/apply_lifecycle'
import { cloneContent } from '#services/gateway_config/canonical'
import {
  SectionEditError,
  type DomainRegistry,
  type SectionEdit,
} from '#services/gateway_config/domain'
import { protocolsOf } from '#services/gateway_config/domains/firewall'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { findGateway } from '#services/gateway_config/gateway_config_service'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import {
  inFlightApply,
  loadSections,
  refreshSyncState,
  saveStates,
  writeRevision,
} from '#services/gateway_config/gateway_store'
import { applyNow, requireManaged, type WriteResult } from '#services/gateway_config/native_common'
import { refreshOrders } from '#services/gateway_config/order_store'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import { promoteForResolution, type SectionState } from '#services/gateway_config/sync_engine'
import type { Issue, UciOptions, UciValue } from '#services/gateway_config/types'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Ambiguous sections and their resolution (docs/design/gateway-sync/README.md
 * 5.3, rest.md 6, domains.md 1.4; work package B3). Two router sections that
 * share a domain's identity key (two port forwards named "GAME") are
 * `ambiguous`: mirrored, never written, and they block Authoritative Mode.
 * The admin decides per member: keep, rename, delete, or exclude (router
 * only). One request promotes the members it keeps, renames or deletes to
 * synced rows (B = R = C), writes the renames and deletes into the draft and
 * applies them as one job; anonymous members are adopted and renamed
 * `perch_<id>` in that job. Excluding a member takes it out of the
 * identity-key census, so the other member of a pair is promoted on the next
 * read. Works with any collector that has the config plane.
 */

export type AmbiguityAction = 'keep' | 'rename' | 'delete' | 'exclude'

export type AmbiguityMember = {
  perchId: string
  section: string
  anonymous: boolean
  position: number | null
  /** "GAME: wan tcp/udp 25500-25600 → 192.168.1.10:25500-25600 (disabled)". */
  summary: string
  enabled: boolean
  /** The router's options, read only. */
  options: Record<string, string | string[]>
  /** A unique name a rename could use (null when rename is not offered). */
  suggestedName: string | null
  excluded: boolean
}

export type AmbiguityGroup = {
  /** The shared identity key, e.g. `redirect:game`. */
  key: string
  domain: string
  config: string
  type: string
  reason: 'ambiguous' | 'duplicate'
  /** The option a rename edits (`name` for rules and redirects); null = rename not offered. */
  nameOption: string | null
  members: AmbiguityMember[]
}

export type AmbiguityOverview = {
  gatewayId: number
  headRevision: number
  groups: AmbiguityGroup[]
  /** Any member still unresolved (not excluded): Authoritative Mode cannot be enabled. */
  blocksAuthoritative: boolean
}

export type ResolveItem = { perchId: string; action: AmbiguityAction; name?: string }

export type ResolveResult = Omit<WriteResult<null>, 'object'> & {
  promoted: string[]
  excluded: string[]
  groups: AmbiguityGroup[]
}

/** Longest name a rename may set (the port-forward name limit of the firewall REST). */
export const RENAME_MAX_LENGTH = 64

/** Where a rename is offered: the option the domain's identity key is made of. */
const NAME_OPTIONS: Record<string, string> = {
  'firewall/redirect': 'name',
  'firewall/rule': 'name',
}

function isAmbiguousMirror(row: SectionState): boolean {
  return (
    (row.scope === 'unmodeled' || row.scope === 'excluded') &&
    (row.issue === 'ambiguous' || row.issue === 'duplicate') &&
    row.domain !== null &&
    row.router !== null
  )
}

function keysOf(registry: DomainRegistry, domain: string, type: string, options: UciOptions) {
  return registry.get(domain)?.identityKeys?.({ type, options }) ?? []
}

function scalar(options: UciOptions, key: string): string | null {
  const value = options[key]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(' ') : value
}

function enabledOf(options: UciOptions): boolean {
  const value = scalar(options, 'enabled')?.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/** One line a person recognises the section by. */
export function memberSummary(config: string, type: string, options: UciOptions, section: string) {
  const name = scalar(options, 'name')?.trim() || section
  const off = enabledOf(options) ? '' : ' (disabled)'
  const protos = (value: UciValue | undefined, fallback: string[]) => {
    const list = value === undefined ? fallback : protocolsOf(value)
    return list.join('/')
  }
  if (config === 'firewall' && type === 'redirect') {
    const src = scalar(options, 'src') ?? '*'
    const ext = scalar(options, 'src_dport') ?? 'any port'
    const destIp = scalar(options, 'dest_ip') ?? 'the router'
    const destPort = scalar(options, 'dest_port')
    return `${name}: ${src} ${protos(options.proto, ['tcp', 'udp'])} ${ext} → ${destIp}${destPort ? `:${destPort}` : ''}${off}`
  }
  if (config === 'firewall' && type === 'rule') {
    const src = scalar(options, 'src') ?? 'router'
    const dest = scalar(options, 'dest') ?? 'router'
    const port = scalar(options, 'dest_port')
    const target = scalar(options, 'target')?.toUpperCase() ?? 'ACCEPT'
    return `${name}: ${src} → ${dest} ${protos(options.proto, ['tcp', 'udp'])}${port ? ` ${port}` : ''} ${target}${off}`
  }
  const detail = ['mac', 'ip', 'interface', 'target']
    .map((k) => scalar(options, k))
    .filter((v): v is string => v !== null)
  return `${type} ${name}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}${off}`
}

/** The details that tell members apart, most telling first (a rename's suffix). */
function distinguishers(config: string, type: string, options: UciOptions): Array<string | null> {
  if (config === 'firewall' && type === 'redirect') {
    return [scalar(options, 'src_dport'), scalar(options, 'dest_port')]
  }
  if (config === 'firewall' && type === 'rule') {
    return [scalar(options, 'dest_port'), scalar(options, 'proto')]
  }
  return [null]
}

/**
 * Suggested unique names (rest.md 6): `<name> <external ports>` for
 * redirects, `<name> <dest port>` when the external ports are equal too,
 * then `-2`, `-3`; unique case-insensitively among every section of that
 * type in the config.
 */
function suggestNames(
  group: { config: string; type: string; nameOption: string },
  members: SectionState[],
  taken: Set<string>
): Map<string, string> {
  const out = new Map<string, string>()
  const details = members.map((m) => distinguishers(group.config, group.type, m.router!.options))
  members.forEach((member, i) => {
    const base = scalar(member.router!.options, group.nameOption)?.trim() || member.name
    let suffix: string | null = null
    for (let level = 0; level < details[i].length && suffix === null; level++) {
      const value = details[i][level]
      if (value === null) continue
      const unique = details.filter((d) => d[level] === value).length === 1
      if (unique) suffix = value
    }
    suffix ??= details[i].find((v) => v !== null) ?? null
    const candidate = suffix ? `${base} ${suffix}` : base
    let name = candidate.slice(0, RENAME_MAX_LENGTH)
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = `${candidate.slice(0, RENAME_MAX_LENGTH - String(n).length - 1)}-${n}`
    }
    taken.add(name.toLowerCase())
    out.set(member.perchId, name)
  })
  return out
}

/**
 * The ambiguity groups of a gateway's rows (pure): mirrors with issue
 * `ambiguous`/`duplicate` grouped by the identity key they share. A group is
 * listed while at least one member is unresolved (unmodeled); its excluded
 * members are listed with `excluded: true`.
 */
export function ambiguityGroups(
  states: SectionState[],
  registry: DomainRegistry = domainRegistry()
): AmbiguityGroup[] {
  const candidates = states.filter(isAmbiguousMirror)
  const keyed = candidates.map((row) => ({
    row,
    keys: keysOf(registry, row.domain!, row.router!.type, row.router!.options),
  }))
  const buckets = new Map<string, SectionState[]>()
  for (const { row, keys } of keyed) {
    const shared =
      keys.find((k) =>
        keyed.some(
          (o) =>
            o.row !== row &&
            o.row.config === row.config &&
            o.row.domain === row.domain &&
            o.keys.includes(k)
        )
      ) ?? keys[0]
    if (shared === undefined) continue
    const id = `${row.config}\u0000${row.domain}\u0000${shared}`
    buckets.set(id, [...(buckets.get(id) ?? []), row])
  }
  const groups: AmbiguityGroup[] = []
  for (const [id, rows] of buckets) {
    if (!rows.some((r) => r.scope === 'unmodeled')) continue
    const [config, domain, key] = id.split('\u0000')
    const members = [...rows].sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.perchId.localeCompare(b.perchId)
    )
    const type = members[0].router!.type
    const nameOption = NAME_OPTIONS[`${config}/${type}`] ?? null
    let suggested = new Map<string, string>()
    if (nameOption) {
      const taken = new Set(
        states
          .filter((s) => s.config === config && (s.desired ?? s.router)?.type === type)
          .map((s) =>
            scalar((s.desired ?? s.router)!.options, nameOption)
              ?.trim()
              .toLowerCase()
          )
          .filter((n): n is string => typeof n === 'string')
      )
      suggested = suggestNames({ config, type, nameOption }, members, taken)
    }
    groups.push({
      key,
      domain,
      config,
      type,
      reason: members.some((m) => m.issue === 'duplicate') ? 'duplicate' : 'ambiguous',
      nameOption,
      members: members.map((m) => ({
        perchId: m.perchId,
        section: m.name,
        anonymous: m.anonymous,
        position: m.position,
        summary: memberSummary(config, type, m.router!.options, m.name),
        enabled: enabledOf(m.router!.options),
        options: Object.fromEntries(
          Object.entries(m.router!.options).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
        ),
        suggestedName: suggested.get(m.perchId) ?? null,
        excluded: m.scope === 'excluded',
      })),
    })
  }
  return groups.sort(
    (a, b) =>
      a.config.localeCompare(b.config) ||
      (a.members[0].position ?? 0) - (b.members[0].position ?? 0) ||
      a.key.localeCompare(b.key)
  )
}

function blocksAuthoritative(states: SectionState[]): boolean {
  return states.some(
    (s) =>
      s.scope === 'unmodeled' && (s.issue === 'ambiguous' || s.issue === 'duplicate') && s.domain
  )
}

/** `GET /gateways/:id/ambiguities`. */
export async function ambiguityOverview(gatewayId: number): Promise<AmbiguityOverview> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  return {
    gatewayId: gateway.id,
    headRevision: gateway.headRevision,
    groups: ambiguityGroups(states),
    blocksAuthoritative: blocksAuthoritative(states),
  }
}

function authoritativeOf(gateway: Gateway): boolean {
  return normalizeMode(gateway.mode) === 'managed' && Boolean(gateway.authoritative)
}

/**
 * `POST /gateways/:id/ambiguities/resolve` (rest.md 6). Everything is checked
 * before anything is stored: every unresolved member of a touched group needs
 * an action, the members kept or renamed must not share a key afterwards
 * (with each other or any other section of the domain), and the draft must
 * validate. Then, in one transaction: exclusions, promotions, the draft
 * edits and a revision for the promoted bases. Unless `apply` is false, the
 * promoted members go out in one apply.
 */
export async function resolveAmbiguities(
  gatewayId: number,
  userId: number,
  input: { expectRevision: number; items: ResolveItem[]; apply: boolean }
): Promise<ResolveResult> {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await findGateway(gatewayId)
    requireManaged(gateway)
    if (input.expectRevision !== gateway.headRevision) {
      throw planeError(409, 'sync_changed', 'The configuration changed since you looked.', {
        headRevision: gateway.headRevision,
      })
    }
    const registry = domainRegistry()
    const loaded = await loadSections(gateway.id)
    const states = loaded.states
    const groups = ambiguityGroups(states, registry)
    const memberOf = new Map<string, AmbiguityGroup>()
    for (const group of groups) {
      for (const m of group.members) if (!m.excluded) memberOf.set(m.perchId, group)
    }

    // ── the request, checked ──
    const seen = new Set<string>()
    for (const item of input.items) {
      if (seen.has(item.perchId)) {
        throw planeError(422, 'ambiguity_item_repeated', `${item.perchId} is named twice.`, {
          perchId: item.perchId,
        })
      }
      seen.add(item.perchId)
      const group = memberOf.get(item.perchId)
      if (!group) {
        throw planeError(409, 'not_ambiguous', 'This section is not an unresolved ambiguous one.', {
          perchId: item.perchId,
        })
      }
      if (item.action === 'rename') {
        if (!group.nameOption) {
          throw planeError(
            422,
            'ambiguity_rename_unsupported',
            `A ${group.type} section cannot be renamed here; keep, delete or exclude it.`,
            { perchId: item.perchId }
          )
        }
        const name = item.name?.trim() ?? ''
        if (name.length === 0 || name.length > RENAME_MAX_LENGTH) {
          throw planeError(
            422,
            'ambiguity_name_required',
            `A rename needs a name of 1 to ${RENAME_MAX_LENGTH} characters.`,
            { perchId: item.perchId }
          )
        }
      }
    }
    const touched = groups.filter((g) => g.members.some((m) => seen.has(m.perchId)))
    for (const group of touched) {
      const missing = group.members.filter((m) => !m.excluded && !seen.has(m.perchId))
      if (missing.length > 0) {
        throw planeError(422, 'ambiguity_incomplete', 'Decide every member of the group.', {
          key: group.key,
          missing: missing.map((m) => m.perchId),
        })
      }
    }
    const itemOf = new Map(input.items.map((i) => [i.perchId, i]))
    const optionsAfter = (row: SectionState): UciOptions | null => {
      const item = itemOf.get(row.perchId)
      if (!item) return null
      if (item.action === 'keep') return row.router!.options
      if (item.action === 'rename') {
        const group = memberOf.get(row.perchId)!
        return { ...row.router!.options, [group.nameOption!]: item.name!.trim() }
      }
      return null
    }
    for (const group of touched) {
      const staying = states.filter(
        (s) =>
          memberOf.get(s.perchId) === group &&
          ['keep', 'rename'].includes(itemOf.get(s.perchId)!.action)
      )
      // Every other section of the domain in that config as it will be.
      const counts = new Map<string, number>()
      const count = (type: string, options: UciOptions) => {
        for (const k of new Set(keysOf(registry, group.domain, type, options))) {
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
      }
      for (const s of states) {
        if (s.config !== group.config || s.domain !== group.domain || s.scope === 'excluded')
          continue
        if (itemOf.has(s.perchId)) continue
        const content = s.scope === 'synced' ? (s.desired ?? s.router) : s.router
        if (content) count(content.type, content.options)
      }
      for (const s of states) {
        if (!itemOf.has(s.perchId) || s.config !== group.config) continue
        const after = optionsAfter(s)
        if (after) count(s.router!.type, after)
      }
      for (const s of staying) {
        const keys = keysOf(registry, group.domain, s.router!.type, optionsAfter(s)!)
        const clash = keys.find((k) => (counts.get(k) ?? 0) > 1)
        if (clash) {
          throw planeError(
            422,
            'ambiguity_unresolved',
            'The members kept or renamed would still share a name.',
            { key: clash, perchId: s.perchId }
          )
        }
      }
    }

    // ── the new rows, in memory ──
    const inFlight = await inFlightApply(gateway.id)
    if (inFlight && input.items.some((i) => inFlight.perchIds.includes(i.perchId))) {
      throw planeError(409, 'pending_apply', 'An apply carrying this section is running.')
    }
    const excludedIds = input.items.filter((i) => i.action === 'exclude').map((i) => i.perchId)
    const promotedIds = input.items.filter((i) => i.action !== 'exclude').map((i) => i.perchId)
    const { promoted, refused } = promoteForResolution(
      states,
      promotedIds,
      registry,
      gateway.capabilities
    )
    if (refused.length > 0) {
      const first = refused[0]
      if (first.reason === 'capability_missing') {
        throw planeError(
          409,
          'gateway_capability_missing',
          'The gateway agent cannot serve this.',
          {
            perchId: first.perchId,
          }
        )
      }
      throw planeError(409, 'not_ambiguous', `This section cannot be promoted (${first.reason}).`, {
        perchId: first.perchId,
        reason: first.reason,
      })
    }
    const candidate = new Map(states.map((s) => [s.perchId, s]))
    const changed = new Map<string, SectionState>()
    for (const id of excludedIds) {
      const row = candidate.get(id)!
      const next: SectionState = {
        ...row,
        scope: 'excluded',
        base: cloneContent(row.router),
        desired: cloneContent(row.router),
        conflict: null,
        driftSince: null,
        status: 'in_sync',
      }
      candidate.set(id, next)
      changed.set(id, next)
    }
    for (const row of promoted) {
      candidate.set(row.perchId, row)
      changed.set(row.perchId, row)
    }
    const byDomain = new Map<string, SectionEdit[]>()
    for (const row of promoted) {
      const item = itemOf.get(row.perchId)!
      let edit: SectionEdit | null = null
      if (item.action === 'rename') {
        edit = {
          op: 'put',
          perchId: row.perchId,
          config: row.config,
          type: row.router!.type,
          options: optionsAfter(row)!,
        }
      } else if (item.action === 'delete') {
        edit = { op: 'delete', perchId: row.perchId }
      }
      if (edit) byDomain.set(row.domain!, [...(byDomain.get(row.domain!) ?? []), edit])
    }
    const drafted: string[] = []
    for (const [domain, edits] of byDomain) {
      let result: EditSectionsResult
      try {
        result = planSectionEdits({
          rows: [...candidate.values()],
          edits,
          domain,
          registry,
          authoritative: authoritativeOf(gateway),
          newPerchId: () => {
            throw new SectionEditError('a resolution creates no section')
          },
        })
      } catch (error) {
        if (error instanceof EditRefusedError) throw planeError(409, error.code, error.message)
        if (error instanceof SectionEditError) throw planeError(422, 'invalid_edit', error.message)
        throw error
      }
      for (const u of result.upserts) {
        candidate.set(u.perchId, u)
        changed.set(u.perchId, u)
        drafted.push(u.perchId)
      }
    }
    const touchedIds = new Set(promotedIds)
    const issues: Issue[] = validateStates(gateway, [...candidate.values()]).filter(
      (i) => i.perchId && touchedIds.has(i.perchId)
    )
    const errors = issues.filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      throw planeError(422, 'invalid_config', errors[0].message, { issues: errors })
    }

    // ── stored in one transaction ──
    const now = DateTime.utc()
    const changes = [...changed.values()].map((after) => ({ perchId: after.perchId, after }))
    await db.transaction(async (trx) => {
      await saveStates(gateway.id, loaded.rows, changes, { userId, now, trx })
      gateway.useTransaction(trx)
      // The promoted bases are the router's content, reported by a live agent.
      const revision = await writeRevision(gateway, {
        before: states,
        after: [...candidate.values()],
        source: 'router',
        userId,
        confirmed: true,
        note: 'Ambiguous sections resolved',
        now,
        trx,
      })
      for (const id of excludedIds) {
        const row = candidate.get(id)!
        await recordGatewayEvent(gateway.id, 'section_excluded', {
          userId,
          revision,
          detail: { perchId: id, config: row.config, section: row.name, ambiguity: true },
          trx,
        })
      }
      await recordGatewayEvent(gateway.id, 'ambiguity_resolved', {
        userId,
        revision,
        detail: {
          items: input.items.map((i) => ({
            perchId: i.perchId,
            action: i.action,
            ...(i.action === 'rename' ? { name: i.name?.trim() } : {}),
          })),
          promoted: promotedIds,
          excluded: excludedIds,
        },
        trx,
      })
      if (drafted.length > 0) {
        await recordGatewayEvent(gateway.id, 'draft_edited', {
          userId,
          detail: { domains: [...byDomain.keys()], perchIds: drafted, ambiguity: true },
          trx,
        })
      }
    })
    await gateway.refresh()
    const finalStates = [...candidate.values()]
    await refreshOrders(gateway, finalStates)
    await refreshSyncState(gateway)

    const { apply, applyError } = await applyNow(gateway, userId, promotedIds, input.apply)
    return {
      gatewayId: gateway.id,
      promoted: promotedIds,
      excluded: excludedIds,
      groups: ambiguityGroups(finalStates, registry),
      issues,
      apply,
      applyError,
    }
  })
}
