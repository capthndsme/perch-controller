import { useState } from 'react'
import { ArrowCounterClockwise, Check, Pause, Play } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { DiffList, ErrorLine, ToneBadge, UciValueText } from '@/components/gateway-config/bits'
import {
  useAcceptDrift,
  useResolveSections,
  useResumeEnforcement,
  useRevertDriftNow,
  useSections,
  type ResolveItem,
} from '@/hooks/use-gateways'
import { useNow } from '@/hooks/use-now'
import {
  formatAgo,
  formatCountdown,
  formatUciValue,
  refusalMessage,
  routerAuthorLabel,
  secondsUntil,
} from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { ConfigDiffEntry, Gateway, GatewaySection, UciValue } from '@/types/gateway-config'

// ── Conflicts (two-way) ────────────────────────────────────────────────────

/**
 * The conflict queue (plan 1 section 5.2): both sides changed the same
 * option. The router's value stays live until the admin picks a side, per
 * option or for the whole section.
 */
export function ConflictsPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const sections = useSections(gateway.id, { status: 'conflict' })
  const list = (sections.data ?? []).filter((s) => s.conflict)
  return (
    <Panel
      title="Conflicts"
      description="Both the router and Perch changed the same thing. The router’s value stays live until you decide."
      updating={sections.isPlaceholderData}
    >
      {sections.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState title="No conflicts" description="Router edits and Perch’s drafts agree." />
      ) : (
        <ul className="space-y-3">
          {list.map((s) => (
            <ConflictCard key={s.perchId} gateway={gateway} section={s} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

type Side = 'router' | 'controller'

function ConflictCard({ gateway, section, isAdmin }: { gateway: Gateway; section: GatewaySection; isAdmin: boolean }) {
  const conflict = section.conflict!
  const resolve = useResolveSections(gateway.id)
  const [choice, setChoice] = useState<Record<string, Side>>({})
  const perOption = conflict.kind === 'options' && conflict.options.length > 0
  const discarded = conflict.origin === 'rollback_discarded'
  const allChosen = perOption && conflict.options.every((o) => choice[o.name])

  function submit(item: ResolveItem) {
    resolve.mutate([item])
  }

  function resolveChoices() {
    const sides = new Set(conflict.options.map((o) => choice[o.name]))
    if (sides.size === 1) {
      submit({ perchId: section.perchId, take: [...sides][0] })
      return
    }
    const options: Record<string, UciValue | null> = {}
    for (const o of conflict.options) {
      const value = choice[o.name] === 'router' ? o.router : o.controller
      options[o.name] = (value ?? null) as UciValue | null
    }
    submit({ perchId: section.perchId, take: 'custom', options })
  }

  return (
    <li className="rounded-lg border border-status-critical/30" data-testid="conflict-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-status-critical/5 px-3 py-2 text-xs">
        <span className="font-mono font-medium">
          {section.config}.{section.section}
        </span>
        <span className="text-muted-foreground">{section.type}</span>
        <ToneBadge tone="critical">
          {conflict.kind === 'options'
            ? `${conflict.options.length} option${conflict.options.length === 1 ? '' : 's'}`
            : conflict.kind === 'delete_vs_edit'
              ? 'Deleted on one side, edited on the other'
              : conflict.kind === 'type'
                ? 'Type changed'
                : 'Order'}
        </ToneBadge>
        {discarded ? <ToneBadge tone="serious">Undone by a rollback</ToneBadge> : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {routerAuthorLabel(section.routerAuthor) ? `Router side: ${routerAuthorLabel(section.routerAuthor)} · ` : ''}
          {formatAgo(conflict.detectedAt)}
        </span>
      </div>
      <div className="space-y-3 p-3 text-xs">
        {discarded ? (
          <p className="text-muted-foreground">
            This router edit was made while a change of Perch’s was waiting for its confirmation, and the rollback undid it.
            It is no longer on the router. <strong className="text-foreground">Keep the router’s</strong> puts it back into
            Perch’s draft so the next apply restores it.
          </p>
        ) : null}
        {perOption ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[560px] text-[11px]">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                  <th className="px-2.5 py-1 font-medium">Option</th>
                  <th className="px-2.5 py-1 font-medium">Base</th>
                  <th className="px-2.5 py-1 font-medium">Router</th>
                  <th className="px-2.5 py-1 font-medium">Perch</th>
                </tr>
              </thead>
              <tbody>
                {conflict.options.map((o) => (
                  <tr key={o.name} className="border-t border-border/60 align-top">
                    <td className="px-2.5 py-1.5 font-mono">{o.name}</td>
                    <td className="px-2.5 py-1.5">
                      <UciValueText value={o.base} />
                    </td>
                    {(['router', 'controller'] as const).map((side) => (
                      <td key={side} className="px-2.5 py-1.5">
                        <label
                          className={cn(
                            'flex cursor-pointer items-start gap-1.5 rounded-sm px-1 py-0.5',
                            choice[o.name] === side && 'bg-primary/10 ring-1 ring-primary/40',
                            !isAdmin && 'cursor-default',
                          )}
                        >
                          {isAdmin && conflict.options.length > 1 ? (
                            <input
                              type="radio"
                              name={`${section.perchId}-${o.name}`}
                              className="mt-0.5"
                              checked={choice[o.name] === side}
                              onChange={() => setChoice((c) => ({ ...c, [o.name]: side }))}
                              aria-label={`${o.name}: take ${side === 'router' ? 'the router' : 'Perch'}’s ${formatUciValue(o[side])}`}
                            />
                          ) : null}
                          <UciValueText value={o[side]} />
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : discarded && conflict.discarded ? (
          <DiffList
            entries={[contentDiff(section, conflict.discarded.options)]}
            beforeLabel="Perch"
            afterLabel="Discarded router edit"
          />
        ) : null}

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => submit({ perchId: section.perchId, take: 'router' })}>
              Keep the router’s{perOption ? ' for all' : ''}
            </Button>
            <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => submit({ perchId: section.perchId, take: 'controller' })}>
              Keep Perch’s{perOption ? ' for all' : ''}
            </Button>
            {perOption && conflict.options.length > 1 ? (
              <Button size="sm" disabled={!allChosen || resolve.isPending} onClick={resolveChoices}>
                <Check weight="bold" />
                Resolve with my picks
              </Button>
            ) : null}
            {resolve.isPending ? <Spinner className="size-3.5" /> : null}
          </div>
        ) : null}
        <ErrorLine message={resolve.error ? refusalMessage(resolve.error) : null} />
      </div>
    </li>
  )
}

/** The discarded router content against Perch's, as a diff entry. */
function contentDiff(section: GatewaySection, discarded: Record<string, UciValue>): ConfigDiffEntry {
  const perch = section.desired?.options ?? {}
  const names = [...new Set([...Object.keys(perch), ...Object.keys(discarded)])]
  return {
    perchId: section.perchId,
    config: section.config,
    section: section.section,
    type: section.type,
    domain: section.domain,
    action: 'update',
    options: names
      .filter((n) => JSON.stringify(perch[n] ?? null) !== JSON.stringify(discarded[n] ?? null))
      .map((n) => ({ name: n, before: perch[n] ?? null, after: discarded[n] ?? null })),
  }
}

// ── Drift (Authoritative Mode) ─────────────────────────────────────────────

export function EnforcementSuspendedBanner({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const resume = useResumeEnforcement(gateway.id)
  if (!gateway.authoritative || gateway.enforcement !== 'suspended') return null
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-status-critical/40 bg-status-critical/10 px-3 py-2.5 text-xs" role="alert">
      <Pause weight="fill" className="mt-0.5 size-4 shrink-0 text-status-critical" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold">Enforcement is suspended on {gateway.name}</p>
        <p className="text-muted-foreground">
          Reverting router edits failed repeatedly, so Perch stopped trying. Drift stays visible; nothing is reverted until
          you resume. Look at the Activity tab for why the reverts failed.
        </p>
        <ErrorLine message={resume.error ? refusalMessage(resume.error) : null} />
      </div>
      {isAdmin ? (
        <Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}>
          {resume.isPending ? <Spinner className="size-3.5 text-current" /> : <Play weight="fill" />}
          Resume enforcement
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Drift (plan 1 section 5.3): router edits under Authoritative Mode, each
 * with its revert countdown, Accept (the router's version becomes Perch's)
 * and Revert now.
 */
export function DriftPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const sections = useSections(gateway.id, { scope: 'synced' })
  const accept = useAcceptDrift(gateway.id)
  const revert = useRevertDriftNow(gateway.id)
  const list = (sections.data ?? []).filter((s) => s.status === 'drift' || s.status === 'reverting' || s.driftSince)
  const now = useNow(1000, list.length > 0)
  const busy = accept.isPending || revert.isPending
  const error = accept.error ?? revert.error

  if (!gateway.authoritative) {
    return (
      <Panel title="Drift" description="Router edits Perch reverts under Authoritative Mode.">
        <EmptyState
          title="Authoritative Mode is off"
          description="Router edits are imported two-way. Turn on Authoritative Mode on the Overview tab to make Perch’s configuration win."
        />
      </Panel>
    )
  }

  return (
    <Panel
      title="Drift"
      description="Router edits to synced sections. Each is reverted after the grace delay unless you accept it."
      updating={sections.isPlaceholderData}
      actions={
        isAdmin && list.length > 1 ? (
          <>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => accept.mutate(undefined)}>
              Accept all
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || gateway.enforcement === 'suspended'}
              onClick={() => revert.mutate(undefined)}
            >
              Revert all now
            </Button>
          </>
        ) : null
      }
    >
      <ErrorLine message={error ? refusalMessage(error) : null} />
      {sections.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState title="No drift" description="The router matches Perch’s configuration." />
      ) : (
        <ul className="space-y-3">
          {list.map((s) => {
            const left = secondsUntil(s.revertAt, now)
            const created = !s.base && !s.desired
            const entry: ConfigDiffEntry = {
              perchId: s.perchId,
              config: s.config,
              section: s.section,
              type: s.type,
              domain: s.domain,
              action: created ? 'create' : !s.router ? 'delete' : 'update',
              options: optionDiff(s.desired?.options ?? {}, s.router?.options ?? {}),
            }
            return (
              <li key={s.perchId} className="space-y-2 rounded-lg border border-status-serious/30 p-3 text-xs" data-testid="drift-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">
                    {s.config}.{s.section}
                  </span>
                  {s.status === 'reverting' ? (
                    <ToneBadge tone="warning" dot>
                      Reverting
                    </ToneBadge>
                  ) : gateway.enforcement === 'suspended' ? (
                    <ToneBadge tone="neutral">Not reverted (suspended)</ToneBadge>
                  ) : left !== null ? (
                    <ToneBadge tone="serious">
                      {left > 0 ? `Reverted in ${formatCountdown(left)}` : 'Revert due'}
                    </ToneBadge>
                  ) : null}
                  <span className="text-muted-foreground">
                    by {routerAuthorLabel(s.routerAuthor) ?? 'the router'} · {formatAgo(s.driftSince)}
                  </span>
                  {isAdmin && s.status !== 'reverting' ? (
                    <span className="ml-auto flex gap-2">
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => accept.mutate([s.perchId])}>
                        <Check />
                        Accept
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || gateway.enforcement === 'suspended'}
                        onClick={() => revert.mutate([s.perchId])}
                      >
                        <ArrowCounterClockwise />
                        Revert now
                      </Button>
                    </span>
                  ) : null}
                </div>
                {created ? (
                  <p className="text-muted-foreground">A new section on the router: the revert removes it (its content is kept with the revert).</p>
                ) : null}
                <DiffList entries={[entry]} beforeLabel="Perch" afterLabel="Router now" />
              </li>
            )
          })}
        </ul>
      )}
      {busy ? <Spinner className="mt-2 size-3.5" /> : null}
    </Panel>
  )
}

function optionDiff(before: Record<string, UciValue>, after: Record<string, UciValue>) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return names
    .filter((n) => JSON.stringify(before[n] ?? null) !== JSON.stringify(after[n] ?? null))
    .map((n) => ({ name: n, before: before[n] ?? null, after: after[n] ?? null }))
}
