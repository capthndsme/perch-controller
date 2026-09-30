import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Info, TextAa, Warning, X } from '@phosphor-icons/react'
import { AmbiguityResolveDialog } from '@/components/gateway-sync/ambiguity-resolve-dialog'
import { Button } from '@/components/ui/button'
import { useDialog } from '@/hooks/use-dialog'
import { useAmbiguities } from '@/hooks/use-gateway-sync'
import { groupNoun, memberName } from '@/lib/gateway-sync'
import { cn } from '@/lib/utils'
import type { Gateway } from '@/types/gateway-config'
import type { AmbiguityGroup, AmbiguityResolveAnswer } from '@/types/gateway-sync'

type GatewayRef = Pick<Gateway, 'id' | 'name' | 'mode'>

/** "4 port forwards" when every group is one kind, else "6 sections". */
function headline(groups: AmbiguityGroup[]): string {
  const members = groups.reduce((n, g) => n + g.members.length, 0)
  const kinds = new Set(groups.map((g) => `${g.config}.${g.type}`))
  return kinds.size === 1 ? `${members} ${groupNoun(groups[0], members)}` : `${members} sections`
}

/** One clash as a chip: "GAME ×2", "WGX / wgx". Opens the resolve dialog. */
export function AmbiguityBadge({ group, onClick }: { group: AmbiguityGroup; onClick?: () => void }) {
  const names = [...new Set(group.members.map((m) => memberName(group, m)).filter((n): n is string => Boolean(n)))]
  const label = names.length === 1 ? `${names[0]} ×${group.members.length}` : names.join(' / ') || group.key
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={`Name clash (${group.key}): resolve`}
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1 truncate rounded-md border border-status-warning/40 bg-background px-2 font-mono text-[11px] select-none',
        'transition-colors duration-base active:duration-0 enabled:hover:bg-status-warning/10 enabled:active:bg-status-warning/15 disabled:cursor-default sm:h-6',
      )}
    >
      <TextAa className="size-3 shrink-0 text-status-warning" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * "Needs attention" (design gateway-sync dashboard.md 6–7): router sections
 * that share a name, which Perch can only mirror and which block
 * Authoritative Mode, with a way to resolve them in one change. Renders
 * nothing when there are none, or when this controller cannot list them yet.
 * `configs` narrows it to one page's kind (the firewall page: `firewall`).
 * Without `onResolved` it reports the result itself.
 */
export function AmbiguityPanel({
  gateway,
  isAdmin,
  configs,
  onResolved,
  className,
}: {
  gateway: GatewayRef
  isAdmin: boolean
  configs?: string[]
  onResolved?: (answer: AmbiguityResolveAnswer) => void
  className?: string
}) {
  const view = useAmbiguities(gateway.id, { enabled: isAdmin && gateway.mode !== 'off' })
  const dialog = useDialog()
  const [result, setResult] = useState<AmbiguityResolveAnswer | null>(null)
  const [resolvedWhat, setResolvedWhat] = useState<string | null>(null)

  const groups = (view.data?.groups ?? []).filter((g) => !configs || configs.includes(g.config))
  const managed = gateway.mode === 'managed'

  // Mounted whatever the list says, so it can play its exit after the clashes are gone.
  const resolveDialog =
    isAdmin && managed ? (
      <AmbiguityResolveDialog
        key={dialog.key}
        gateway={gateway}
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        groups={configs ? groups.map((g) => g.key) : undefined}
        onResolved={(answer) => {
          if (onResolved) onResolved(answer)
          else {
            setResult(answer)
            setResolvedWhat(headline(groups))
          }
        }}
      />
    ) : null

  // The dialog keeps its place in the tree whether the list is empty or not.
  if (groups.length === 0) {
    return (
      <>
        {result && !onResolved ? (
          <ResultNote gatewayId={gateway.id} answer={result} what={resolvedWhat} onDismiss={() => setResult(null)} className={className} />
        ) : null}
        {resolveDialog}
      </>
    )
  }

  return (
    <>
      <section
        className={cn(
          'flex flex-col gap-2.5 rounded-lg border border-status-warning/50 bg-status-warning/10 px-3 py-2.5 text-xs sm:flex-row sm:items-start',
          className,
        )}
        aria-label="Name clashes"
        data-testid="ambiguity-panel"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Warning weight="fill" className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-semibold">{headline(groups)} share names</p>
            <p className="text-muted-foreground">
              Perch cannot tell them apart, so it only mirrors them
              {view.data?.blocksAuthoritative ? ' and they block Authoritative Mode' : ''}. Rename, delete or leave them
              router-only, all in one change.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((group) => (
                <AmbiguityBadge key={group.key} group={group} onClick={isAdmin && managed ? dialog.show : undefined} />
              ))}
            </div>
            {!managed ? <p className="text-muted-foreground">Resolving needs managed mode.</p> : null}
          </div>
        </div>
        {isAdmin && managed ? (
          <Button size="sm" className="self-stretch sm:self-start" onClick={dialog.show} data-testid="ambiguity-open">
            Resolve…
          </Button>
        ) : null}
      </section>
      {resolveDialog}
    </>
  )
}

/** What the resolve did, until dismissed (the confirm itself is the apply banner's). */
function ResultNote({
  gatewayId,
  answer,
  what,
  onDismiss,
  className,
}: {
  gatewayId: number
  answer: AmbiguityResolveAnswer
  what: string | null
  onDismiss: () => void
  className?: string
}) {
  const counts = [
    answer.promoted.length > 0 ? `${answer.promoted.length} now managed by Perch` : null,
    answer.excluded.length > 0 ? `${answer.excluded.length} left router-only` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <section
      className={cn('flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs', className)}
      aria-live="polite"
      data-testid="ambiguity-result"
    >
      {answer.apply ? (
        <CheckCircle weight="fill" className="mt-0.5 size-4 shrink-0 text-status-good" />
      ) : (
        <Info weight="fill" className="mt-0.5 size-4 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold">Name clashes resolved{what ? ` (${what})` : ''}</p>
        <p className="text-muted-foreground">
          {counts ? `${counts}. ` : ''}
          {answer.apply
            ? 'The change is on its way to the router: keep it in the banner at the top.'
            : answer.applyError
              ? `Saved in the draft; no apply started: ${answer.applyError.message}`
              : 'Saved in the draft: apply it from the pending changes.'}
        </p>
        {!answer.apply ? (
          <Link to={`/gateway/config/${gatewayId}?tab=changes`} className="inline-block text-primary underline underline-offset-2">
            Open the pending changes
          </Link>
        ) : null}
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </section>
  )
}
