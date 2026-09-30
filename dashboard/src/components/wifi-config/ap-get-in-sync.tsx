import { useState } from 'react'
import { ArrowClockwise, CheckCircle, Crown, WarningCircle } from '@phosphor-icons/react'
import { DiffList, ErrorLine, PasswordField, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { DivergenceList } from '@/components/wifi-config/divergence-list'
import { EditorSheet } from '@/components/wifi-config/sheet'
import {
  useApSyncStatus,
  useDiscardApDraft,
  useDivergences,
  useResolveApConflicts,
  useResolveDivergences,
  useStartRollout,
  useUpdateApConfig,
  useWifiConfigSettings,
} from '@/hooks/use-wifi-config'
import { apiErrorCode } from '@/lib/api'
import { blockerText, formatAgo, refusalField } from '@/lib/gateway-config'
import { plural, wifiRefusalMessage } from '@/lib/wifi-config'
import type { SyncBlocker } from '@/types/gateway-config'
import type { ApConfig } from '@/types/wifi-config'

type SectionBlocker = Extract<SyncBlocker, { perchId: string | null }>

/** What Authoritative Mode does on an access point (config-plane.md 5.3, controller.md 4.5). */
function Explainer({ delaySeconds }: { delaySeconds: number }) {
  return (
    <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
      <li>Perch’s networks and radios win. Edits made in LuCI or uci on this access point count as drift.</li>
      <li>
        Drift is reverted after a grace delay of <strong className="text-foreground">{delaySeconds} s</strong>. Until then
        you can accept the access point’s version instead.
      </li>
      <li>New WiFi interfaces added on the access point are removed; unmodeled ones (mesh, client mode) are left alone.</li>
      <li>After repeated failed reverts enforcement suspends itself until you resume it.</li>
      <li>It can only be switched on when both sides are in sync. Switching it off is always allowed.</li>
    </ul>
  )
}

function blockerLine(blocker: SyncBlocker): string {
  if (blocker.kind === 'feature' && blocker.feature === 'fleet') {
    return blocker.code === 'render_pending'
      ? 'Perch has network changes for this access point that are not applied yet.'
      : 'A change made on the access point differs from its network.'
  }
  if (blocker.kind === 'offline') return 'The access point’s agent is offline: Perch cannot read it.'
  if (blocker.kind === 'mode_not_managed') return 'The access point is not managed.'
  return blockerText(blocker).replace(/router/g, 'access point').replace(/gateway/g, 'access point')
}

/**
 * Turning Authoritative Mode on for one AP (dashboard.md 1.4): a fresh read
 * lists what keeps it from being in sync (conflicts, drafts, router edits,
 * open divergences), with "Use the AP's for all" and "Push Perch's for all";
 * the switch sends the reviewed head revision and the admin's password.
 */
export function ApAuthoritativeDialog({
  ap,
  open,
  onOpenChange,
}: {
  ap: ApConfig
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const status = useApSyncStatus(ap.apId, { fresh: true, enabled: open })
  const divergences = useDivergences({ apId: ap.apId, open: true }, { enabled: open })
  const settings = useWifiConfigSettings({ enabled: open })
  const patch = useUpdateApConfig(ap.apId)
  const resolveConflicts = useResolveApConflicts(ap.apId)
  const discard = useDiscardApDraft(ap.apId)
  const resolveDivergences = useResolveDivergences()
  const start = useStartRollout()
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'ap' | 'perch' | null>(null)
  const delay = settings.data?.settings.authoritativeRevertDelaySeconds ?? 90
  const code = apiErrorCode(patch.error)
  const data = status.data
  const blockers = data?.blockers ?? []
  const sectionBlockers = blockers.filter((b): b is SectionBlocker => 'perchId' in b)
  const otherBlockers = blockers.filter(
    (b) => !('perchId' in b) && !(b.kind === 'feature' && b.feature === 'fleet' && b.code === 'divergence_open'),
  )
  const openDivergences = divergences.data ?? []
  const inSync = data?.inSync === true && !status.isFetching
  const bulkError = resolveConflicts.error ?? discard.error ?? resolveDivergences.error ?? start.error

  async function takeApForAll() {
    setBusy('ap')
    setNotice(null)
    try {
      const conflicts = sectionBlockers.filter((b) => b.kind === 'conflict' && b.perchId).map((b) => b.perchId!)
      if (conflicts.length > 0) await resolveConflicts.mutateAsync(conflicts.map((perchId) => ({ perchId, take: 'router' })))
      const drafts = sectionBlockers.filter((b) => b.kind === 'controller_ahead' && b.perchId).map((b) => b.perchId!)
      if (drafts.length > 0) await discard.mutateAsync(drafts)
      const keep = openDivergences.filter((d) => d.resolutions.includes('override'))
      if (keep.length > 0) {
        await resolveDivergences.mutateAsync({ items: keep.map((d) => ({ id: d.id, resolution: 'override' })), apply: false })
      }
      const left = openDivergences.length - keep.length
      setNotice(left > 0 ? `${plural(left, 'change')} on the access point cannot be kept as an override: pick one below.` : null)
    } finally {
      setBusy(null)
      void status.refetch()
    }
  }

  async function pushPerchForAll() {
    setBusy('perch')
    setNotice(null)
    try {
      const conflicts = sectionBlockers.filter((b) => b.kind === 'conflict' && b.perchId).map((b) => b.perchId!)
      if (conflicts.length > 0) await resolveConflicts.mutateAsync(conflicts.map((perchId) => ({ perchId, take: 'controller' })))
      const revert = openDivergences.filter((d) => d.resolutions.includes('revert'))
      if (revert.length > 0) {
        await resolveDivergences.mutateAsync({ items: revert.map((d) => ({ id: d.id, resolution: 'revert' })), apply: false })
      }
      await start.mutateAsync({ apIds: [ap.apId], note: 'Get in sync before Authoritative Mode' })
      setNotice('Perch’s settings are going out to this access point. Check again once the rollout has finished.')
    } catch (error) {
      if (apiErrorCode(error) === 'nothing_to_apply') setNotice(null)
    } finally {
      setBusy(null)
      void status.refetch()
    }
  }

  async function enable() {
    if (!data) return
    setNotice(null)
    try {
      await patch.mutateAsync({ authoritative: true, expectRevision: data.headRevision, currentPassword: password })
      onOpenChange(false)
    } catch (error) {
      const refused = apiErrorCode(error)
      if (refused === 'sync_changed' || refused === 'not_in_sync') {
        const count = refusalField<SyncBlocker[]>(error, 'blockers')?.length ?? 0
        setNotice(
          refused === 'sync_changed'
            ? `The access point changed while you were looking (${plural(count, 'blocker')} now). Review the list again.`
            : 'Not in sync any more: review the list again.',
        )
        patch.reset()
        void status.refetch()
      }
    }
  }

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      tall
      title={
        <span className="flex items-center gap-2">
          <Crown weight="fill" className="size-4 text-status-warning" />
          Authoritative Mode for {ap.name}
        </span>
      }
      description="Perch’s WiFi settings become the source of truth on this access point."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={enable} disabled={!inSync || password === '' || patch.isPending}>
            {patch.isPending ? <Spinner className="size-3.5 text-current" /> : <Crown weight="bold" />}
            Turn on Authoritative Mode
          </Button>
        </>
      }
    >
      <Explainer delaySeconds={delay} />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="section-label">Sync check</p>
          <Button size="xs" variant="ghost" onClick={() => status.refetch()} disabled={status.isFetching}>
            {status.isFetching ? <Spinner className="size-3" /> : <ArrowClockwise />}
            Read the access point again
          </Button>
        </div>
        {status.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-3.5" /> Reading the access point…
          </p>
        ) : status.error ? (
          <ErrorLine message={wifiRefusalMessage(status.error)} />
        ) : inSync ? (
          <p className="flex items-center gap-2 rounded-md border border-status-good/40 bg-status-good/10 px-2.5 py-2">
            <CheckCircle weight="fill" className="size-4 text-status-good" />
            In sync at revision {data?.headRevision} (read {formatAgo(data?.observedAt)}).
          </p>
        ) : (
          <div className="space-y-2" data-testid="ap-sync-blocked">
            <p className="flex items-start gap-2 rounded-md border border-status-serious/40 bg-status-serious/10 px-2.5 py-2">
              <WarningCircle weight="fill" className="mt-px size-4 shrink-0 text-status-serious" />
              <span>
                Not in sync: {plural(blockers.length, 'thing')} to settle first. Settle them one by one, or all at once:
              </span>
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" onClick={takeApForAll} disabled={busy !== null}>
                {busy === 'ap' ? <Spinner className="size-3.5" /> : null}
                Use the access point’s for all
              </Button>
              <Button variant="outline" onClick={pushPerchForAll} disabled={busy !== null}>
                {busy === 'perch' ? <Spinner className="size-3.5" /> : null}
                Push Perch’s for all
              </Button>
            </div>
            {data?.luciPending ? (
              <p className="rounded-md border border-border px-2.5 py-2">
                LuCI has changes staged but not applied{data.uncommitted.length > 0 ? ` (${data.uncommitted.join(', ')})` : ''}.
                Apply or revert them in LuCI first.
              </p>
            ) : null}
            {otherBlockers.map((b, i) => (
              <p key={`${b.kind}-${i}`} className="rounded-md border border-border px-2.5 py-2">
                {blockerLine(b)}
              </p>
            ))}
            {sectionBlockers.length > 0 ? (
              <ul className="space-y-2">
                {sectionBlockers.map((b, i) => (
                  <li key={`${b.config}.${b.section}.${i}`} className="space-y-1.5 rounded-md border border-border p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ToneBadge tone={b.kind === 'conflict' ? 'critical' : 'warning'}>{b.kind.replace('_', ' ')}</ToneBadge>
                      <span className="font-mono text-[11px]">
                        {b.config}.{b.section}
                      </span>
                    </div>
                    <p className="text-muted-foreground">{blockerLine(b)}</p>
                    <DiffList entries={[b.diff]} beforeLabel="Access point" afterLabel="Perch" />
                  </li>
                ))}
              </ul>
            ) : null}
            {openDivergences.length > 0 ? (
              <DivergenceList divergences={openDivergences} isAdmin onResolved={() => void status.refetch()} />
            ) : null}
          </div>
        )}
      </div>
      {inSync ? (
        <PasswordField
          value={password}
          onChange={setPassword}
          error={code === 'invalid_password' ? wifiRefusalMessage(patch.error) : null}
        />
      ) : null}
      {notice ? <ErrorLine message={notice} /> : null}
      {bulkError ? <ErrorLine message={wifiRefusalMessage(bulkError)} /> : null}
      {code && code !== 'invalid_password' && code !== 'sync_changed' && code !== 'not_in_sync' ? (
        <ErrorLine message={wifiRefusalMessage(patch.error)} />
      ) : null}
    </EditorSheet>
  )
}
