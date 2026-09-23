import { useState } from 'react'
import { ArrowClockwise, CheckCircle, Crown, WarningCircle } from '@phosphor-icons/react'
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
import { DiffList, ErrorLine, PasswordField, ToneBadge } from '@/components/gateway-config/bits'
import {
  useCreateApply,
  useDiscardDraft,
  useGatewayConfigSettings,
  usePatchGateway,
  useResolveSections,
  useResumeEnforcement,
  useSetSectionScope,
  useSyncStatus,
} from '@/hooks/use-gateways'
import { apiErrorCode } from '@/lib/api'
import { blockerText, formatAgo, refusalField, refusalMessage } from '@/lib/gateway-config'
import type { Gateway, SyncBlocker } from '@/types/gateway-config'

/** What Authoritative Mode does, in the words the dialog and the overview share. */
export function AuthoritativeExplainer({ delaySeconds }: { delaySeconds: number }) {
  return (
    <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
      <li>Perch’s configuration wins. Router edits to synced sections (LuCI, uci, ssh) count as drift.</li>
      <li>
        Drift is reverted after a grace delay of <strong className="text-foreground">{delaySeconds} s</strong>. Until
        then you can accept the router’s version instead; it is kept either way.
      </li>
      <li>New router sections of a type Perch models are removed; excluded and unmodeled sections are left alone.</li>
      <li>After repeated failed reverts enforcement suspends itself: drift stays visible, nothing is reverted until you resume.</li>
      <li>It can only be switched on when both sides are verifiably in sync. Switching it off is always allowed.</li>
    </ul>
  )
}

type SectionBlocker = Extract<SyncBlocker, { perchId: string | null }>

function BlockerRow({ gateway, blocker }: { gateway: Gateway; blocker: SectionBlocker }) {
  const resolve = useResolveSections(gateway.id)
  const apply = useCreateApply(gateway.id)
  const discard = useDiscardDraft(gateway.id)
  const scope = useSetSectionScope(gateway.id)
  const [showDiff, setShowDiff] = useState(false)
  const busy = resolve.isPending || apply.isPending || discard.isPending || scope.isPending
  const error = resolve.error ?? apply.error ?? discard.error ?? scope.error
  const perchId = blocker.perchId

  return (
    <li className="space-y-2 rounded-md border border-border p-2.5" data-testid="sync-blocker">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={blocker.kind === 'conflict' ? 'critical' : 'warning'}>{blocker.kind.replace('_', ' ')}</ToneBadge>
        <span className="font-mono text-[11px] font-medium">
          {blocker.config}.{blocker.section}
        </span>
        <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => setShowDiff((v) => !v)}>
          {showDiff ? 'Hide diff' : 'Show diff'}
        </button>
      </div>
      <p className="text-muted-foreground">{blockerText(blocker)}</p>
      {showDiff ? <DiffList entries={[blocker.diff]} beforeLabel="Router" afterLabel="Perch" /> : null}
      {perchId ? (
        <div className="flex flex-wrap gap-2">
          {blocker.kind === 'conflict' ? (
            <>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => resolve.mutate([{ perchId, take: 'router' }])}>
                Keep the router’s
              </Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => resolve.mutate([{ perchId, take: 'controller' }])}>
                Keep Perch’s
              </Button>
            </>
          ) : blocker.kind === 'unimported_section' ? (
            <>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => apply.mutate({ perchIds: [perchId] })}>
                Adopt (apply)
              </Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => scope.mutate({ perchId, scope: 'excluded' })}>
                Exclude it
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => apply.mutate({ perchIds: [perchId] })}>
                Apply Perch’s version
              </Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => discard.mutate([perchId])}>
                Discard Perch’s draft
              </Button>
            </>
          )}
          {busy ? <Spinner className="size-3.5" /> : null}
        </div>
      ) : null}
      <ErrorLine message={error ? refusalMessage(error) : null} />
    </li>
  )
}

/**
 * Turning Authoritative Mode on (plan 1 section 5.4): a fresh read lists the
 * blockers, each with its "Get in sync" actions; the switch sends the head
 * revision the admin reviewed (`expectRevision`) and the password.
 */
export function AuthoritativeDialog({
  gateway,
  open,
  onOpenChange,
}: {
  gateway: Gateway
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const status = useSyncStatus(gateway.id, { fresh: true, enabled: open })
  const settings = useGatewayConfigSettings({ enabled: open })
  const patch = usePatchGateway(gateway.id)
  const resume = useResumeEnforcement(gateway.id)
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const delay = settings.data?.settings.authoritativeRevertDelaySeconds ?? 90
  const code = apiErrorCode(patch.error)
  const data = status.data
  const blockers = data?.blockers ?? []
  const sectionBlockers = blockers.filter((b): b is SectionBlocker => 'config' in b)
  const gatewayBlockers = blockers.filter((b) => !('config' in b))
  const inSync = data?.inSync === true && !status.isFetching

  async function enable() {
    if (!data) return
    setNotice(null)
    try {
      await patch.mutateAsync({ authoritative: true, expectRevision: data.headRevision, currentPassword: password })
      onOpenChange(false)
    } catch (error) {
      const refused = apiErrorCode(error)
      if (refused === 'sync_changed' || refused === 'not_in_sync') {
        // The server's blockers are newer than the list on screen: read again and show those.
        const count = refusalField<SyncBlocker[]>(error, 'blockers')?.length ?? 0
        setNotice(
          refused === 'sync_changed'
            ? `The router changed while you were looking (${count} blocker${count === 1 ? '' : 's'} now). Review the list again.`
            : 'Not in sync any more: review the list again.',
        )
        patch.reset()
        void status.refetch()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown weight="fill" className="size-4 text-status-warning" />
            Authoritative Mode for {gateway.name}
          </DialogTitle>
          <DialogDescription>Perch becomes the source of truth for the synced sections.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <AuthoritativeExplainer delaySeconds={delay} />

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="section-label">Sync check</p>
              <Button size="xs" variant="ghost" onClick={() => status.refetch()} disabled={status.isFetching}>
                {status.isFetching ? <Spinner className="size-3" /> : <ArrowClockwise />}
                Read the router again
              </Button>
            </div>
            {status.isPending ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-3.5" /> Reading the router…
              </p>
            ) : status.error ? (
              <ErrorLine message={refusalMessage(status.error)} />
            ) : inSync ? (
              <p className="flex items-center gap-2 rounded-md border border-status-good/40 bg-status-good/10 px-2.5 py-2">
                <CheckCircle weight="fill" className="size-4 text-status-good" />
                In sync at revision {data?.headRevision} (read {formatAgo(data?.observedAt)}).
              </p>
            ) : (
              <div className="space-y-2" data-testid="sync-blocked">
                <p className="flex items-start gap-2 rounded-md border border-status-serious/40 bg-status-serious/10 px-2.5 py-2">
                  <WarningCircle weight="fill" className="mt-px size-4 shrink-0 text-status-serious" />
                  <span>
                    Not in sync: {blockers.length || (data?.luciPending ? 1 : 0)} thing
                    {blockers.length === 1 ? '' : 's'} to settle first. Work through the list; each fix re-reads the router.
                  </span>
                </p>
                {data?.luciPending ? (
                  <p className="rounded-md border border-border px-2.5 py-2">
                    LuCI has changes that are staged but not applied
                    {data.uncommitted.length > 0 ? ` (${data.uncommitted.join(', ')})` : ''}. Apply or revert them in
                    LuCI first.
                  </p>
                ) : null}
                {gatewayBlockers.map((b) => (
                  <p key={b.kind} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-2">
                    {blockerText(b)}
                    {b.kind === 'enforcement_suspended' ? (
                      <Button size="xs" variant="outline" onClick={() => resume.mutate()} disabled={resume.isPending}>
                        Resume enforcement
                      </Button>
                    ) : null}
                  </p>
                ))}
                {sectionBlockers.length > 0 ? (
                  <ul className="space-y-2">
                    {sectionBlockers.map((b, i) => (
                      <BlockerRow key={`${b.config}.${b.section}.${i}`} gateway={gateway} blocker={b} />
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>

          {inSync ? (
            <PasswordField
              value={password}
              onChange={setPassword}
              error={code === 'invalid_password' ? refusalMessage(patch.error) : null}
            />
          ) : null}
          {notice ? <ErrorLine message={notice} /> : null}
          {code && code !== 'invalid_password' ? <ErrorLine message={refusalMessage(patch.error)} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={enable} disabled={!inSync || password === '' || patch.isPending}>
            {patch.isPending ? <Spinner className="size-3.5 text-current" /> : <Crown weight="bold" />}
            Turn on Authoritative Mode
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
