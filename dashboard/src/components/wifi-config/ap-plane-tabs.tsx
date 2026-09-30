import { useState } from 'react'
import {
  ArrowCounterClockwise,
  CaretDown,
  Check,
  CheckCircle,
  Crosshair,
  Eye,
  Pause,
  Play,
  Trash,
} from '@phosphor-icons/react'
import { ActorName } from '@/components/gateway-config/actor'
import { ConfirmDialog, DiffList, ErrorLine, FactRow, IssueList, ToneBadge, UciValueText } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { ImpactSheet } from '@/components/wifi-config/impact-preview'
import { useDialog } from '@/hooks/use-dialog'
import { useNow } from '@/hooks/use-now'
import {
  useApDraft,
  useApDrift,
  useApEvents,
  useApRevision,
  useApRevisions,
  useApSections,
  useDiscardApDraft,
  useResolveApConflicts,
  useRestoreApRevision,
  useRolloutPreview,
  useSetApSectionScope,
  useStartRollout,
} from '@/hooks/use-wifi-config'
import { apiErrorCode } from '@/lib/api'
import {
  EVENT_LABEL,
  eventTone,
  formatAgo,
  formatCountdown,
  formatDateTime,
  optionRows,
  REVISION_SOURCE_LABEL,
  routerAuthorLabel,
  SCOPE_META,
  secondsUntil,
  STATUS_META,
} from '@/lib/gateway-config'
import { BAND_LABEL, FEATURE_LABEL, optionLabel, plural, WIFI_EVENT_LABEL, wifiRefusalMessage } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { GatewayRevision, GatewaySection, SectionScope, UciValue } from '@/types/gateway-config'
import type { ApConfig, HostapdFeature, ImpactPreview } from '@/types/wifi-config'

// ── Changes (the draft) ─────────────────────────────────────────────────────

/** What Perch will write to this AP (its rows `ahead`), with Review and apply or Discard. */
export function ApDraftPanel({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const draft = useApDraft(ap.apId)
  const discard = useDiscardApDraft(ap.apId)
  const preview = useRolloutPreview()
  const start = useStartRollout()
  const [impact, setImpact] = useState<ImpactPreview | null>(null)
  const [open, setOpen] = useState(false)
  const discardDialog = useDialog()
  const changes = draft.data?.changes ?? []
  const [notice, setNotice] = useState<string | null>(null)

  async function review() {
    setNotice(null)
    try {
      setImpact(await preview.mutateAsync({ apIds: [ap.apId] }))
      setOpen(true)
    } catch (e) {
      setNotice(apiErrorCode(e) === 'nothing_to_apply' ? 'There is nothing to apply.' : wifiRefusalMessage(e))
    }
  }

  return (
    <Panel
      title="Changes"
      description="What Perch will write to this access point with the next rollout."
      updating={draft.isPlaceholderData}
      actions={
        isAdmin && changes.length > 0 ? (
          <>
            <Button size="sm" variant="outline" onClick={discardDialog.show}>
              <Trash />
              Discard
            </Button>
            <Button size="sm" onClick={review} disabled={preview.isPending || ap.mode !== 'managed'}>
              {preview.isPending ? <Spinner className="size-3.5 text-current" /> : <Eye />}
              Review and apply
            </Button>
          </>
        ) : null
      }
    >
      {draft.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : changes.length === 0 ? (
        <EmptyState title="No changes waiting" description="Everything Perch has for this access point is on it." />
      ) : (
        <div className="space-y-3">
          {draft.data!.blockedByConflicts.length > 0 ? (
            <p className="text-xs text-status-critical">
              {plural(draft.data!.blockedByConflicts.length, 'section')} wait for a conflict to be resolved first.
            </p>
          ) : null}
          <IssueList issues={draft.data!.issues} />
          <DiffList entries={changes} beforeLabel="On the AP" afterLabel="Perch" />
        </div>
      )}
      {notice ? <ErrorLine message={notice} /> : null}
      <ImpactSheet
        open={open}
        onOpenChange={setOpen}
        title={`Apply to ${ap.name}?`}
        preview={impact}
        applying={start.isPending}
        error={start.error ? wifiRefusalMessage(start.error) : null}
        onApply={() => start.mutate({ apIds: [ap.apId] }, { onSuccess: () => setOpen(false) })}
        onKeepDraft={() => setOpen(false)}
        applyLabel={`Apply to ${ap.name}`}
      />
      <ConfirmDialog
        open={discardDialog.open}
        onOpenChange={discardDialog.setOpen}
        title="Discard the changes?"
        description="Perch forgets them for this access point. Network settings they came from stay; the network then shows as different here."
        confirmLabel="Discard"
        destructive
        pending={discard.isPending}
        error={discard.error ? wifiRefusalMessage(discard.error) : null}
        onConfirm={() => discard.mutate(undefined, { onSuccess: () => discardDialog.setOpen(false) })}
      />
    </Panel>
  )
}

// ── Conflicts ───────────────────────────────────────────────────────────────

type Side = 'router' | 'controller'

function ConflictCard({ ap, section, isAdmin }: { ap: ApConfig; section: GatewaySection; isAdmin: boolean }) {
  const conflict = section.conflict!
  const resolve = useResolveApConflicts(ap.apId)
  const [choice, setChoice] = useState<Record<string, Side>>({})
  const perOption = conflict.kind === 'options' && conflict.options.length > 0
  const allChosen = perOption && conflict.options.every((o) => choice[o.name])

  function resolveChoices() {
    const sides = new Set(conflict.options.map((o) => choice[o.name]))
    if (sides.size === 1) {
      resolve.mutate([{ perchId: section.perchId, take: [...sides][0] }])
      return
    }
    const options: Record<string, UciValue | null> = {}
    for (const o of conflict.options) options[o.name] = ((choice[o.name] === 'router' ? o.router : o.controller) ?? null) as UciValue | null
    resolve.mutate([{ perchId: section.perchId, take: 'custom', options }])
  }

  return (
    <li className="overflow-hidden rounded-lg border border-status-critical/30" data-testid="ap-conflict">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-status-critical/5 px-3 py-2 text-xs">
        <span className="font-mono font-medium">
          {section.config}.{section.section}
        </span>
        <ToneBadge tone="critical">Both changed it</ToneBadge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {routerAuthorLabel(section.routerAuthor) ? `On the AP: ${routerAuthorLabel(section.routerAuthor)} · ` : ''}
          {formatAgo(conflict.detectedAt)}
        </span>
      </div>
      <div className="space-y-3 p-3 text-xs">
        {perOption ? (
          <ul className="space-y-2">
            {conflict.options.map((o) => (
              <li key={o.name} className="space-y-1.5">
                <p className="font-medium">{optionLabel(o.name)}</p>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={optionLabel(o.name)}>
                  {(['router', 'controller'] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      role="radio"
                      aria-checked={choice[o.name] === side}
                      disabled={!isAdmin}
                      onClick={() => setChoice((c) => ({ ...c, [o.name]: side }))}
                      className={cn(
                        'flex min-h-11 flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors duration-base active:duration-0 sm:min-h-0',
                        choice[o.name] === side ? 'border-brand/60 bg-brand/5 ring-1 ring-brand/30' : 'border-border hover:bg-muted/40',
                      )}
                    >
                      <span className="text-[11px] text-muted-foreground">{side === 'router' ? 'The access point’s' : 'Perch’s'}</span>
                      <UciValueText value={side === 'router' ? o.router : o.controller} />
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            {conflict.kind === 'delete_vs_edit' ? 'Deleted on one side, edited on the other.' : 'The section changed shape.'}
          </p>
        )}
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate([{ perchId: section.perchId, take: 'router' }])}>
              Keep the access point’s
            </Button>
            <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate([{ perchId: section.perchId, take: 'controller' }])}>
              Keep Perch’s
            </Button>
            {perOption && conflict.options.length > 1 ? (
              <Button size="sm" disabled={!allChosen || resolve.isPending} onClick={resolveChoices}>
                Use my picks
              </Button>
            ) : null}
            {resolve.isPending ? <Spinner className="size-3.5" /> : null}
          </div>
        ) : null}
        <ErrorLine message={resolve.error ? wifiRefusalMessage(resolve.error) : null} />
      </div>
    </li>
  )
}

/** Both the AP and Perch changed the same option: the AP's value stays live until someone picks. */
export function ApConflictsPanel({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const sections = useApSections(ap.apId, { status: 'conflict' })
  const list = (sections.data ?? []).filter((s) => s.conflict)
  return (
    <Panel
      title="Conflicts"
      description="The access point and Perch changed the same thing. The access point’s value stays live until you decide."
      updating={sections.isPlaceholderData}
    >
      {sections.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState title="No conflicts" description="Edits on the access point and Perch’s agree." />
      ) : (
        <ul className="space-y-3">
          {list.map((s) => (
            <ConflictCard key={s.perchId} ap={ap} section={s} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ── Drift (Authoritative Mode) ──────────────────────────────────────────────

function DriftRow({ ap, section, isAdmin }: { ap: ApConfig; section: GatewaySection; isAdmin: boolean }) {
  const drift = useApDrift(ap.apId)
  const now = useNow(1000, section.revertAt !== null)
  const left = secondsUntil(section.revertAt, now)
  return (
    <li className="space-y-2 rounded-md border border-status-serious/30 p-3 text-xs" data-testid="ap-drift">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">
          {section.config}.{section.section}
        </span>
        {routerAuthorLabel(section.routerAuthor) ? (
          <span className="text-muted-foreground">changed in {routerAuthorLabel(section.routerAuthor)}</span>
        ) : null}
        {left !== null && ap.enforcement === 'active' ? (
          <ToneBadge tone={left <= 15 ? 'critical' : 'warning'}>Reverts in {formatCountdown(left)}</ToneBadge>
        ) : null}
      </div>
      {isAdmin ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={drift.accept.isPending} onClick={() => drift.accept.mutate([section.perchId])}>
            <Check />
            Accept the access point’s
          </Button>
          <Button size="sm" variant="outline" disabled={drift.revertNow.isPending} onClick={() => drift.revertNow.mutate([section.perchId])}>
            <ArrowCounterClockwise />
            Revert now
          </Button>
        </div>
      ) : null}
      <ErrorLine message={drift.accept.error || drift.revertNow.error ? wifiRefusalMessage(drift.accept.error ?? drift.revertNow.error) : null} />
    </li>
  )
}

/** Under Authoritative Mode, edits on the AP are drift, reverted after the grace delay unless accepted. */
export function ApDriftPanel({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const sections = useApSections(ap.apId, { status: 'drift' })
  const drift = useApDrift(ap.apId)
  const list = sections.data ?? []
  return (
    <Panel
      title="Drift"
      description={ap.authoritative ? 'Edits on the access point Perch will revert.' : 'Only under Authoritative Mode.'}
      actions={
        isAdmin && ap.enforcement === 'suspended' ? (
          <Button size="sm" onClick={() => drift.resume.mutate()} disabled={drift.resume.isPending}>
            <Play />
            Resume enforcement
          </Button>
        ) : null
      }
    >
      {ap.enforcement === 'suspended' ? (
        <p className="mb-3 flex items-center gap-2 text-xs text-status-serious">
          <Pause weight="fill" className="size-3.5" />
          Enforcement is suspended after failed reverts.
        </p>
      ) : null}
      {sections.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState title="No drift" description="The access point runs what Perch has." />
      ) : (
        <ul className="space-y-2">
          {list.map((s) => (
            <DriftRow key={s.perchId} ap={ap} section={s} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ── Sections ────────────────────────────────────────────────────────────────

function SectionRow({ ap, section, isAdmin }: { ap: ApConfig; section: GatewaySection; isAdmin: boolean }) {
  const [open, setOpen] = useState(false)
  const scope = useSetApSectionScope(ap.apId)
  const status = STATUS_META[section.status]
  const likely = section.routerAuthor && section.routerAuthor.kind !== 'perch' && section.routerChangedAt
  const rows = open ? optionRows(section) : []
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-left text-xs transition-colors duration-base hover:bg-muted/30 active:bg-muted/50 active:duration-0"
      >
        <CaretDown
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform duration-base ease-out motion-reduce:transition-none', open ? '' : '-rotate-90')}
        />
        <span className="font-mono text-[11px] font-medium">
          {section.config}.{section.section}
        </span>
        <span className="text-muted-foreground">{section.type}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <ToneBadge tone={SCOPE_META[section.scope].tone} title={SCOPE_META[section.scope].hint}>
            {SCOPE_META[section.scope].label}
          </ToneBadge>
          {section.scope === 'synced' && section.status !== 'in_sync' ? <ToneBadge tone={status.tone}>{status.label}</ToneBadge> : null}
          {likely ? <ToneBadge tone="info">Changed in {routerAuthorLabel(section.routerAuthor)}</ToneBadge> : null}
        </span>
      </button>
      {open ? (
        <div className="space-y-2 bg-muted/20 px-4 py-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Option</th>
                  <th className="px-2 py-1 font-medium">On the AP</th>
                  <th className="px-2 py-1 font-medium">Perch</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className={cn('border-t border-border/60', !row.owned && 'text-muted-foreground')}>
                    <td className="px-2 py-1 font-mono">{row.name}</td>
                    <td className="px-2 py-1">
                      <UciValueText value={row.router} />
                    </td>
                    <td className="px-2 py-1">
                      <UciValueText value={row.owned ? row.desired : null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">Greyed options stay the access point’s: Perch never writes them.</p>
          {isAdmin && section.scope !== 'unmodeled' ? (
            <Button
              size="xs"
              variant="outline"
              disabled={scope.isPending}
              onClick={() => scope.mutate({ perchId: section.perchId, scope: section.scope === 'synced' ? 'excluded' : 'synced' })}
            >
              {section.scope === 'synced' ? 'Exclude from Perch' : 'Sync with Perch'}
            </Button>
          ) : null}
          <ErrorLine message={scope.error ? wifiRefusalMessage(scope.error) : null} />
        </div>
      ) : null}
    </li>
  )
}

/** Every `wireless` and `network` section of the AP: synced, excluded or unmodeled. */
export function ApSectionsPanel({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const [scope, setScope] = useState<'all' | SectionScope>('all')
  const sections = useApSections(ap.apId, scope === 'all' ? {} : { scope })
  const list = sections.data ?? []
  return (
    <Panel
      title="Sections"
      description="The access point’s wireless and network configuration as Perch sees it."
      updating={sections.isPlaceholderData}
      flush
      actions={
        <Segmented
          size="xs"
          ariaLabel="Scope"
          value={scope}
          onChange={setScope}
          options={[
            { id: 'all', label: 'All' },
            { id: 'synced', label: 'Synced' },
            { id: 'excluded', label: 'Excluded' },
            { id: 'unmodeled', label: 'Unmodeled' },
          ]}
        />
      }
    >
      {sections.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No sections" description={ap.observedAt ? 'Nothing in this scope.' : 'Perch has not read this access point yet.'} />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border">
          {list.map((s) => (
            <SectionRow key={s.perchId} ap={ap} section={s} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ── History ─────────────────────────────────────────────────────────────────

function RevisionDetail({ ap, revision, isAdmin }: { ap: ApConfig; revision: GatewayRevision; isAdmin: boolean }) {
  const detail = useApRevision(ap.apId, revision.number)
  const restore = useRestoreApRevision(ap.apId)
  const dialog = useDialog()
  const isHead = revision.number === ap.headRevision
  return (
    <div className="space-y-2 bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {revision.confirmedAt ? <span>Confirmed working {formatDateTime(revision.confirmedAt)}</span> : <span>Not confirmed on the AP</span>}
        {revision.note ? <span>Note: {revision.note}</span> : null}
        {isAdmin && ap.mode === 'managed' && !isHead ? (
          <Button size="xs" variant="outline" className="ml-auto" onClick={dialog.show}>
            <ArrowCounterClockwise />
            Restore
          </Button>
        ) : null}
      </div>
      {detail.isPending ? <Spinner className="size-3.5" /> : <DiffList entries={detail.data?.diff ?? []} />}
      <ConfirmDialog
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        title={`Restore revision #${revision.number}?`}
        description={`${ap.name} goes back to that WiFi configuration, as a rollout of this access point alone.`}
        confirmLabel="Restore and apply"
        pending={restore.isPending}
        error={restore.error ? wifiRefusalMessage(restore.error) : null}
        onConfirm={() => restore.mutate({ number: revision.number }, { onSuccess: () => dialog.setOpen(false) })}
      />
    </div>
  )
}

/** Revisions: every state both sides agreed on; a tick marks states known to work. */
export function ApHistoryPanel({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const revisions = useApRevisions(ap.apId)
  const [open, setOpen] = useState<number | null>(null)
  const items = revisions.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <Panel title="History" description="Every WiFi configuration both sides agreed on, whoever made it." flush>
      {revisions.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No revisions yet" description="The first read records revision 1." />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border text-xs">
          {items.map((rev) => (
            <li key={rev.number}>
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors duration-base hover:bg-muted/40 active:bg-muted/60 active:duration-0"
                onClick={() => setOpen(open === rev.number ? null : rev.number)}
                aria-expanded={open === rev.number}
              >
                <span className="w-10 font-mono font-medium">#{rev.number}</span>
                {rev.confirmedAt ? (
                  <CheckCircle weight="fill" className="size-3.5 text-status-good" aria-label="Confirmed working" />
                ) : (
                  <span className="size-3.5" />
                )}
                <ToneBadge tone={rev.source === 'rollback' ? 'serious' : rev.source === 'controller' ? 'info' : 'neutral'}>
                  {REVISION_SOURCE_LABEL[rev.source].replace('router', 'access point').replace('Router', 'AP')}
                </ToneBadge>
                <span className="min-w-0 flex-1 truncate">{rev.summary}</span>
                <span className="text-muted-foreground">
                  <ActorName actor={rev.author} fallback={routerAuthorLabel(rev.routerAuthor) ?? '—'} /> · {formatDateTime(rev.createdAt)}
                </span>
              </button>
              {open === rev.number ? <RevisionDetail ap={ap} revision={rev} isAdmin={isAdmin} /> : null}
            </li>
          ))}
        </ul>
      )}
      {revisions.hasNextPage ? (
        <div className="border-t border-border px-4 py-2">
          <Button size="xs" variant="ghost" onClick={() => revisions.fetchNextPage()} disabled={revisions.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

// ── Activity ────────────────────────────────────────────────────────────────

/** Everything that happened to this AP's WiFi configuration, newest first. */
export function ApActivityPanel({ ap }: { ap: ApConfig }) {
  const events = useApEvents(ap.apId)
  const items = events.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <Panel title="Activity" description="Reads, edits on the access point, applies, confirms, rollbacks." flush>
      {events.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="Nothing yet" />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border text-xs">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <ToneBadge tone={eventTone(e.event)}>{WIFI_EVENT_LABEL[e.event] ?? EVENT_LABEL[e.event] ?? e.event}</ToneBadge>
              {e.revision !== null ? <span className="font-mono text-[11px] text-muted-foreground">#{e.revision}</span> : null}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {typeof e.detail?.message === 'string' ? e.detail.message : ''}
              </span>
              <span className="text-muted-foreground">
                <ActorName actor={e.user} fallback="" /> {formatDateTime(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {events.hasNextPage ? (
        <div className="border-t border-border px-4 py-2">
          <Button size="xs" variant="ghost" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

// ── Capabilities ────────────────────────────────────────────────────────────

const FEATURES: HostapdFeature[] = ['sae', 'owe', '11r', '11ax', '11be', 'acs', 'eap', 'mesh', 'wps', 'ocv']

/** What the AP is and can do (`wifi.capabilities`): wpad and its features, regulatory, radios and their channels. */
export function ApCapabilitiesPanel({ ap }: { ap: ApConfig }) {
  const caps = ap.capabilities
  if (!caps) {
    return (
      <Panel title="Capabilities">
        <EmptyState title="Not reported yet" description={ap.capable ? 'Perch asks when the access point connects.' : 'This perch-apd has no WiFi plane.'} />
      </Panel>
    )
  }
  const features = caps.hostapd?.features ?? {}
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Software">
        <div className="divide-y divide-border/60">
          <FactRow label="OpenWrt">{caps.openwrt?.release ?? '—'}</FactRow>
          <FactRow label="Board">
            <span className="font-mono text-[11px]">{caps.openwrt?.board ?? '—'}</span>
          </FactRow>
          <FactRow label="Target">
            <span className="font-mono text-[11px]">{caps.openwrt?.target ?? '—'}</span>
          </FactRow>
          <FactRow label="Packages">{caps.packageManager ?? '—'}</FactRow>
          <FactRow label="wpad">
            <span className="font-mono text-[11px]">{caps.hostapd?.variant ?? '—'}</span>
          </FactRow>
          <FactRow label="WiFi scripts">{caps.wifiScripts ?? '—'}</FactRow>
          <FactRow label="Boot guard">{caps.guard ?? '—'}</FactRow>
          <FactRow label="Longest confirm window">{caps.confirmMaxSeconds ? `${caps.confirmMaxSeconds} s` : '—'}</FactRow>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {FEATURES.map((f) => (
            <ToneBadge key={f} tone={features[f] ? 'good' : 'neutral'} className={features[f] ? '' : 'line-through decoration-muted-foreground/60'}>
              {FEATURE_LABEL[f]}
            </ToneBadge>
          ))}
        </div>
      </Panel>
      <Panel title="Regulatory and uplink">
        <div className="divide-y divide-border/60">
          <FactRow label="Country in the kernel">{caps.regulatory?.global ?? '—'}</FactRow>
          <FactRow label="Country settable">
            {caps.regulatory?.settable === false ? `No (${caps.regulatory.reason ?? 'platform'})` : 'Yes'}
          </FactRow>
          {caps.regulatory?.selfManaged?.length ? (
            <FactRow label="Self-managed radios">{caps.regulatory.selfManaged.join(', ')}</FactRow>
          ) : null}
          <FactRow label="Trunk port">
            {caps.trunk?.port ? `${caps.trunk.port} on ${caps.trunk.bridge}${caps.trunk.vlanFiltering ? ' (VLAN filtering)' : ''}` : '—'}
          </FactRow>
          <FactRow label="Management network">
            {ap.managementPath ? `${ap.managementPath.network ?? '—'} (${ap.managementPath.device})` : '—'}
          </FactRow>
        </div>
      </Panel>
      <Panel title="Radios" className="lg:col-span-2">
        <ul className="space-y-3">
          {(caps.radios ?? []).map((r) => (
            <li key={r.section} className={cn('space-y-1.5 text-xs', !r.present && 'opacity-60')}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.band ? BAND_LABEL[r.band] : 'Radio'}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {r.section}
                  {r.phy ? ` · ${r.phy}` : ''}
                </span>
                {!r.present ? <ToneBadge tone="neutral">Not present</ToneBadge> : null}
                {r.retrySetupFailed ? <ToneBadge tone="critical">Setup failed</ToneBadge> : null}
                <span className="text-muted-foreground">
                  {r.widths?.length ? `${r.widths.join('/')} MHz` : ''}
                  {r.txpowerMaxDbm ? ` · up to ${r.txpowerMaxDbm} dBm` : ''}
                  {r.maxBss ? ` · ${r.maxBss} networks max` : ''}
                </span>
              </p>
              {r.channels?.length ? (
                <div className="flex flex-wrap gap-1">
                  {r.channels.map((c) => (
                    <span
                      key={c.channel}
                      className={cn(
                        'inline-flex h-5 items-center gap-0.5 rounded-sm border px-1 font-mono text-[10.5px]',
                        c.disabled ? 'border-border text-muted-foreground line-through' : 'border-border',
                        c.dfs && 'border-status-warning/50',
                      )}
                      title={c.dfs ? `DFS, ${c.cacSeconds ?? 60} s radar check` : undefined}
                    >
                      {c.channel}
                      {c.dfs ? <Crosshair aria-label="DFS" weight="bold" className="size-2.5 text-status-warning" /> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
