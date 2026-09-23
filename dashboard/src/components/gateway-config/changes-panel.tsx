import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PaperPlaneTilt, ShieldWarning, TestTube, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { ActorName } from '@/components/gateway-config/actor'
import { ConfirmDialog, DiffList, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { useDialog } from '@/hooks/use-dialog'
import {
  useApplies,
  useApply,
  useCreateApply,
  useDiscardDraft,
  useDraft,
  useDryRunApply,
  useGatewayConfigSettings,
} from '@/hooks/use-gateways'
import {
  APPLY_KIND_LABEL,
  APPLY_STATE_META,
  formatDateTime,
  OUTCOME_REASON,
  refusalField,
  refusalMessage,
  WRITE_BLOCK_TEXT,
} from '@/lib/gateway-config'
import type { ConfirmMode, Gateway, GatewayApply, Issue } from '@/types/gateway-config'

/**
 * Pending changes (plan 1 section 12.2): the draft's diff, the jobs it will
 * become (the management-path one called out), validation issues, Apply with
 * the confirm mode, a dry run, and the list of applies below.
 */
export function ChangesPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const draft = useDraft(gateway.id, { enabled: gateway.mode !== 'off' })
  const settings = useGatewayConfigSettings({ enabled: isAdmin })
  const create = useCreateApply(gateway.id)
  const dryRun = useDryRunApply(gateway.id)
  const discard = useDiscardDraft(gateway.id)
  const discardDialog = useDialog()
  const [mode, setMode] = useState<ConfirmMode | null>(null)
  const [note, setNote] = useState('')
  const confirmMode = mode ?? settings.data?.settings.confirmMode ?? 'admin_and_agent'
  const data = draft.data
  const errors = (data?.issues ?? []).filter((i) => i.severity === 'error')
  const refusedIssues = refusalField<Issue[]>(create.error, 'issues')
  const hasChanges = (data?.changes.length ?? 0) > 0
  const managed = gateway.mode === 'managed'
  const blockedByWrite = gateway.writeBlockedReason && gateway.writeBlockedReason !== 'offline'

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Pending changes"
        description="Perch’s draft: what the next apply writes to the router."
        actions={
          isAdmin && hasChanges ? (
            <Button size="xs" variant="ghost" onClick={() => { discard.reset(); discardDialog.show() }}>
              <Trash />
              Discard draft
            </Button>
          ) : null
        }
      >
        {gateway.mode === 'off' ? (
          <EmptyState title="The config plane is off" description="Start observing on the Overview tab." />
        ) : draft.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : !data || !hasChanges ? (
          <EmptyState title="Nothing to apply" description="The router already has everything Perch wants." />
        ) : (
          <div className="space-y-4 text-xs">
            {data.blockedByConflicts.length > 0 ? (
              <p className="rounded-md border border-status-critical/40 bg-status-critical/10 px-2.5 py-2">
                {data.blockedByConflicts.length} section(s) wait for a conflict to be resolved and are left out.{' '}
                <Link to="?tab=conflicts" className="underline underline-offset-2">
                  Open conflicts
                </Link>
              </p>
            ) : null}
            <IssueList issues={data.issues} />
            {data.jobs.length > 1 || data.jobs.some((j) => j.protected) ? (
              <div className="space-y-1.5">
                <p className="section-label">Goes out as {data.jobs.length} step(s)</p>
                <ol className="space-y-1">
                  {data.jobs.map((job, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">{i + 1}.</span>
                      <span>{APPLY_KIND_LABEL[job.kind]}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{job.configs.join(', ')}</span>
                      {job.protected ? (
                        <ToneBadge tone="serious">
                          <ShieldWarning weight="fill" className="size-3" />
                          Management path: own step, longer confirm window
                          {settings.data ? ` (${Math.round(settings.data.settings.managementConfirmTimeoutSeconds / 60)} min)` : ''}
                        </ToneBadge>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <DiffList entries={data.changes} beforeLabel="Router" afterLabel="Perch" />

            {isAdmin ? (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-muted-foreground">Confirm</span>
                  <Segmented
                    size="xs"
                    ariaLabel="Confirm mode"
                    value={confirmMode}
                    onChange={setMode}
                    options={[
                      { id: 'admin_and_agent', label: 'I keep the changes', title: 'The agent reconnects and you press Keep changes (like LuCI)' },
                      { id: 'agent', label: 'Agent only', title: 'Confirmed as soon as the agent checks in on a fresh connection' },
                    ]}
                  />
                </div>
                <p className="text-muted-foreground">
                  {confirmMode === 'admin_and_agent'
                    ? 'After the router applies it, a banner counts down: press Keep changes once you have checked that the network works. Without it the router rolls back by itself.'
                    : 'Kept as soon as the agent reconnects on a fresh connection and checks in; otherwise the router rolls back by itself.'}
                </p>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the history (optional)" maxLength={500} aria-label="Note" />
                {!managed ? <p className="text-status-serious">Applying needs managed mode.</p> : null}
                {blockedByWrite ? <p className="text-status-serious">{WRITE_BLOCK_TEXT[gateway.writeBlockedReason!]}</p> : null}
                {!gateway.online && managed ? (
                  <p className="text-muted-foreground">The agent is offline: the change waits in the queue until it is back.</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={!managed || create.isPending || errors.length > 0 || gateway.pendingApply !== null}
                    onClick={() => create.mutate({ confirmMode, note: note.trim() || undefined })}
                  >
                    {create.isPending ? <Spinner className="size-3.5 text-current" /> : <PaperPlaneTilt weight="bold" />}
                    Apply to the router
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!managed || dryRun.isPending || !gateway.online}
                    onClick={() => dryRun.mutate({})}
                  >
                    {dryRun.isPending ? <Spinner className="size-3.5" /> : <TestTube />}
                    Dry run
                  </Button>
                  {gateway.pendingApply ? <span className="text-muted-foreground">A change is being applied.</span> : null}
                </div>
                <ErrorLine message={create.error ? refusalMessage(create.error) : null} />
                {refusedIssues ? <IssueList issues={refusedIssues} /> : null}
                <ErrorLine message={dryRun.error ? refusalMessage(dryRun.error) : null} />
                {dryRun.data ? (
                  <div className="space-y-1.5">
                    <p className="section-label">Dry run: the router would do</p>
                    <IssueList issues={dryRun.data.issues} />
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px]">
                      {JSON.stringify(dryRun.data.agentChanges, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Panel>

      <AppliesList gateway={gateway} />

      <ConfirmDialog
        open={discardDialog.open}
        onOpenChange={discardDialog.setOpen}
        title="Discard the draft?"
        description="Perch’s pending edits go back to what the router has. Nothing on the router changes."
        confirmLabel="Discard"
        destructive
        pending={discard.isPending}
        error={discard.error ? refusalMessage(discard.error) : null}
        onConfirm={async () => {
          try {
            await discard.mutateAsync(undefined)
            discardDialog.setOpen(false)
          } catch {
            // shown
          }
        }}
      />
    </div>
  )
}

function AppliesList({ gateway }: { gateway: Gateway }) {
  const applies = useApplies(gateway.id)
  const [open, setOpen] = useState<string | null>(null)
  const items = applies.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <Panel title="Applies" description="Every job sent to the router, newest first." flush>
      {applies.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No applies yet.</p>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border text-xs">
          {items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-muted/40"
                onClick={() => setOpen(open === a.id ? null : a.id)}
                aria-expanded={open === a.id}
              >
                <ToneBadge tone={APPLY_STATE_META[a.state].tone} dot>
                  {APPLY_STATE_META[a.state].label}
                </ToneBadge>
                <span>{APPLY_KIND_LABEL[a.kind]}</span>
                {a.protected ? <ToneBadge tone="serious">Management path</ToneBadge> : null}
                <span className="font-mono text-[11px] text-muted-foreground">{a.configs.join(', ')}</span>
                <span className="ml-auto text-muted-foreground">
                  <ActorName actor={a.requestedBy} fallback="Perch" /> · {formatDateTime(a.requestedAt)}
                </span>
              </button>
              {open === a.id ? <ApplyDetail gatewayId={gateway.id} apply={a} /> : null}
            </li>
          ))}
        </ul>
      )}
      {applies.hasNextPage ? (
        <div className="border-t border-border px-4 py-2">
          <Button size="xs" variant="ghost" onClick={() => applies.fetchNextPage()} disabled={applies.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

function ApplyDetail({ gatewayId, apply }: { gatewayId: number; apply: GatewayApply }) {
  const detail = useApply(gatewayId, apply.id)
  const reason = apply.outcome?.reason ? (OUTCOME_REASON[apply.outcome.reason] ?? apply.outcome.reason) : null
  return (
    <div className="space-y-2 bg-muted/20 px-4 py-3">
      <div className="grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
        <span>Apply id <span className="font-mono">{apply.id}</span></span>
        <span>Confirm: {apply.confirmMode === 'admin_and_agent' ? 'agent + admin' : 'agent'}, {apply.confirmTimeoutSeconds} s window</span>
        <span>Sent {formatDateTime(apply.sentAt)}</span>
        <span>Finished {formatDateTime(apply.finishedAt)}</span>
        {apply.signed ? <span>Signed (plain HTTP)</span> : null}
        {apply.revision !== null ? <span>Revision #{apply.revision}</span> : null}
        {apply.note ? <span className="sm:col-span-2">Note: {apply.note}</span> : null}
      </div>
      {reason || apply.outcome?.error ? (
        <p className="text-status-critical">
          {reason}
          {apply.outcome?.assumed ? ' (assumed)' : ''}
          {apply.outcome?.error ? ` ${apply.outcome.error}${apply.outcome.message ? `: ${apply.outcome.message}` : ''}` : ''}
        </p>
      ) : null}
      {apply.outcome?.discardedConfigs?.length ? (
        <p>Router edits undone by the rollback in: {apply.outcome.discardedConfigs.join(', ')} (back as conflicts).</p>
      ) : null}
      {detail.isPending ? <Spinner className="size-3.5" /> : <DiffList entries={detail.data?.changes ?? []} beforeLabel="Router" afterLabel="Perch" />}
    </div>
  )
}
