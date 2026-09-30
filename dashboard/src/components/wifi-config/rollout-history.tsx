import { useState } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { StatusPill } from '@/components/wifi-config/rows'
import { RolloutDetailSheet, StepDots } from '@/components/wifi-config/rollout-sheet'
import { useRetained } from '@/hooks/use-retained'
import { useRollouts } from '@/hooks/use-wifi-config'
import { formatAgo, formatDateTime } from '@/lib/gateway-config'
import { plural, ROLLOUT_KIND_LABEL, ROLLOUT_STATE_META, wifiRefusalMessage } from '@/lib/wifi-config'
import type { WifiRollout } from '@/types/wifi-config'

function who(rollout: WifiRollout): string {
  if (rollout.requestedBy?.email) return rollout.requestedBy.email
  return rollout.requestedBy?.system ? 'Perch' : 'Perch (system)'
}

/** Past and current rollouts (dashboard.md 1.4): state, kind, who, when, per-AP steps; a row opens its sheet. */
export function RolloutHistory({ isAdmin }: { isAdmin: boolean }) {
  const rollouts = useRollouts()
  const [open, setOpen] = useState<WifiRollout | null>(null)
  const shown = useRetained(open)
  const items = rollouts.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <Panel title="Rollouts" description="Every change sent to the access points, one access point at a time." flush>
      {rollouts.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : rollouts.error ? (
        <p className="px-4 pb-4 text-xs text-destructive">{wifiRefusalMessage(rollouts.error)}</p>
      ) : items.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No rollouts yet" description="Changes you apply show here with each access point’s outcome." />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border">
          {items.map((r) => {
            const meta = ROLLOUT_STATE_META[r.state]
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-xs transition-colors duration-base hover:bg-muted/30 active:bg-muted/60 active:duration-0"
                  data-testid="rollout-row"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                      <span className="font-medium">{ROLLOUT_KIND_LABEL[r.kind]}</span>
                      <span className="text-muted-foreground">{plural(r.steps.length, 'AP')}</span>
                      <StepDots rollout={r} />
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground" title={formatDateTime(r.createdAt)}>
                      {who(r)} · {formatAgo(r.createdAt)}
                      {r.note ? ` · ${r.note}` : ''}
                    </p>
                  </div>
                  <CaretRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {rollouts.hasNextPage ? (
        <div className="border-t border-border px-4 py-2">
          <Button size="xs" variant="ghost" onClick={() => rollouts.fetchNextPage()} disabled={rollouts.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      ) : null}
      {shown ? (
        <RolloutDetailSheet
          rolloutId={shown.id}
          initial={shown}
          open={open !== null}
          onOpenChange={(next) => !next && setOpen(null)}
          isAdmin={isAdmin}
        />
      ) : null}
    </Panel>
  )
}
