import { useEffect } from 'react'
import { ShieldCheck } from '@phosphor-icons/react'
import { DiffList, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { PlannedChecksList } from '@/components/gateway-sync/apply-checks'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useCreateApply, useDraft, useDryRunApply } from '@/hooks/use-gateways'
import { syncRefusalMessage } from '@/lib/gateway-sync'
import type { SyncDraft, SyncDraftJob } from '@/types/gateway-sync'

/**
 * The review of every WAN write (design gateway-sync dashboard.md 2.4): the
 * change is already staged (`?apply=0`); this shows its diff (a dry run of
 * exactly those sections), the jobs the planner will send with the checks
 * the router runs, their confirm window and mode (from `GET /draft`, never
 * computed here), then applies them or leaves them in the draft.
 */
export function WanReviewDialog({
  gatewayId,
  perchIds,
  title,
  onClose,
}: {
  gatewayId: number
  perchIds: string[]
  title: string
  onClose: () => void
}) {
  const dryRun = useDryRunApply(gatewayId)
  const draft = useDraft(gatewayId)
  const apply = useCreateApply(gatewayId)
  const { mutate } = dryRun
  const idsKey = perchIds.join(',')
  useEffect(() => {
    mutate({ perchIds: idsKey.split(',') })
  }, [mutate, idsKey])

  const jobs = ((draft.data as SyncDraft | undefined)?.jobs ?? []).filter((j) =>
    j.perchIds.some((id) => perchIds.includes(id)),
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Saved as a draft. Nothing changes on the router until you apply it; then the router tests the connection and
            undoes the change by itself if the internet does not come back.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {dryRun.isPending ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Working out the change…
            </p>
          ) : dryRun.error ? (
            <ErrorLine message={syncRefusalMessage(dryRun.error)} />
          ) : dryRun.data ? (
            <>
              <DiffList entries={dryRun.data.changes} empty="Nothing differs from the router: there is nothing to apply." />
              <IssueList issues={dryRun.data.issues} />
            </>
          ) : null}
          {jobs.map((job, i) => (
            <JobChecks key={`${job.kind}-${i}`} job={job} />
          ))}
          {apply.error ? <ErrorLine message={syncRefusalMessage(apply.error)} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={apply.isPending}>
            Keep as draft
          </Button>
          <Button
            onClick={() => apply.mutate({ perchIds }, { onSuccess: onClose })}
            disabled={apply.isPending || dryRun.isPending || (dryRun.data?.changes.length ?? 0) === 0}
          >
            {apply.isPending ? <Spinner className="size-3.5 text-current" /> : <ShieldCheck className="size-3.5" />}
            Apply with checks
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function JobChecks({ job }: { job: SyncDraftJob }) {
  const seconds = job.confirmTimeoutSeconds
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/20 px-3 py-2">
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
        What the router verifies
        {job.protected ? <ToneBadge tone="info">Protected</ToneBadge> : null}
        {seconds ? (
          <span className="font-normal text-muted-foreground">
            {seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`} to confirm
            {job.confirmMode === 'admin_and_agent' ? ', then you press Keep changes' : ''}
          </span>
        ) : null}
      </p>
      <PlannedChecksList items={job.checks ?? []} />
    </div>
  )
}
