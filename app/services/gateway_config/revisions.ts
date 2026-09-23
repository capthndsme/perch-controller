import type { RevisionSnapshotEntry } from '#models/gateway_revision'
import { cloneContent, diffEntry, type MergeRules } from '#services/gateway_config/canonical'
import { compareConfigs, type DomainRegistry } from '#services/gateway_config/domain'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { ConfigDiffEntry, SectionContent } from '#services/gateway_config/types'

/**
 * Revisions: the linear history of agreed states (docs/gateway/config-plane.md
 * sections 2 and 9, README 3.7). Pure helpers; the lifecycle writes the rows.
 *
 * `confirmed_at` marks a revision whose state is known to work on the
 * router: an apply that was confirmed (agent reconnect, and the admin in
 * `admin_and_agent` mode), or a router state reported by a live agent (an
 * import or a router edit: the router already runs it and still reaches
 * the controller). A merge revision is confirmed by the apply that pushes
 * its controller half. After a reset and re-join the controller offers the
 * newest confirmed revision, never simply the newest one: the newest may be
 * the change that broke the gateway.
 */

/** Every synced section's base, in apply order: a revision's `snapshot`. */
export function buildSnapshot(sections: SectionState[]): RevisionSnapshotEntry[] {
  return sections
    .filter((s) => s.scope === 'synced' && s.base !== null)
    .map((s) => ({
      perchId: s.perchId,
      config: s.config,
      section: s.name,
      domain: s.domain,
      content: cloneContent(s.base)!,
    }))
    .sort((a, b) => compareConfigs(a.config, b.config) || a.section.localeCompare(b.section))
}

/** Section-level diff between two snapshots (a revision's `diff`, or "compare with…"). */
export function diffSnapshots(
  before: RevisionSnapshotEntry[],
  after: RevisionSnapshotEntry[],
  registry: DomainRegistry | null = null
): ConfigDiffEntry[] {
  const ids = [...new Set([...before, ...after].map((e) => e.perchId))]
  const out: ConfigDiffEntry[] = []
  for (const id of ids) {
    const a = before.find((e) => e.perchId === id) ?? null
    const b = after.find((e) => e.perchId === id) ?? null
    const e = (b ?? a)!
    const rules: MergeRules | undefined = registry?.rules(e.domain)
    const entry = diffEntry(
      { perchId: id, config: e.config, section: e.section, domain: e.domain },
      a?.content ?? null,
      b?.content ?? null,
      rules
    )
    if (entry) out.push(entry)
  }
  return out.sort(
    (x, y) => compareConfigs(x.config, y.config) || x.section.localeCompare(y.section)
  )
}

/** A one-line summary for `gateway_revisions.summary` (≤ 255 chars). */
export function summarizeDiff(diff: ConfigDiffEntry[]): string {
  if (diff.length === 0) return 'No changes'
  const counts = { create: 0, update: 0, delete: 0, adopt: 0, order: 0 }
  for (const d of diff) counts[d.action]++
  const parts: string[] = []
  if (counts.create) parts.push(`${counts.create} added`)
  if (counts.update) parts.push(`${counts.update} changed`)
  if (counts.delete) parts.push(`${counts.delete} removed`)
  if (counts.adopt) parts.push(`${counts.adopt} adopted`)
  if (counts.order) parts.push(`${counts.order} reordered`)
  const configs = [...new Set(diff.map((d) => d.config))].sort(compareConfigs)
  return `${parts.join(', ')} (${configs.join(', ')})`.slice(0, 255)
}

type RevisionRef = { number: number; confirmedAt: string | Date | null | unknown }

/** The revision a re-joined gateway is offered (README 3.7): the newest confirmed one. */
export function rejoinOffer(revisions: RevisionRef[]): number | null {
  let best: number | null = null
  for (const r of revisions) {
    if (r.confirmedAt === null || r.confirmedAt === undefined) continue
    if (best === null || r.number > best) best = r.number
  }
  return best
}

/**
 * Revision numbers to delete when keeping `keep` (the `keepRevisions`
 * setting): everything older than the newest `keep`, except the newest
 * confirmed revision, which the rejoin offer needs whatever its age.
 */
export function revisionsToPrune(revisions: RevisionRef[], keep: number): number[] {
  const numbers = revisions.map((r) => r.number).sort((a, b) => b - a)
  if (numbers.length <= keep) return []
  const cutoff = numbers[keep - 1]
  const protectedNumber = rejoinOffer(revisions)
  return numbers.filter((n) => n < cutoff && n !== protectedNumber).sort((a, b) => a - b)
}

/**
 * Restoring a revision (`POST …/revisions/:number/restore`, and the rejoin
 * offer): C := the snapshot for every section it holds; synced sections of
 * the snapshot's configs that did not exist then get C := null (removed by
 * the apply); sections the snapshot has but the controller no longer knows
 * are created as controller sections. Nothing is applied here.
 */
export function planRestore(
  sections: SectionState[],
  snapshot: RevisionSnapshotEntry[]
): {
  updates: Array<{ perchId: string; desired: SectionContent | null }>
  creates: RevisionSnapshotEntry[]
} {
  const configs = new Set(snapshot.map((e) => e.config))
  const updates: Array<{ perchId: string; desired: SectionContent | null }> = []
  for (const s of sections) {
    if (s.scope !== 'synced') continue
    const entry = snapshot.find((e) => e.perchId === s.perchId)
    if (entry) updates.push({ perchId: s.perchId, desired: cloneContent(entry.content) })
    else if (configs.has(s.config)) updates.push({ perchId: s.perchId, desired: null })
  }
  const creates = snapshot.filter((e) => !sections.some((s) => s.perchId === e.perchId))
  return { updates, creates }
}
