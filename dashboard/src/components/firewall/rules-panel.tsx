import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowLineUp,
  PencilSimple,
  Plus,
  Prohibit,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/firewall/confirm-dialog'
import { ApplyNowCheckbox, ErrorNote, PathIssueNote, SyncBadge, ToneBadge } from '@/components/firewall/firewall-ui'
import { OrderStatus } from '@/components/firewall/order-status'
import { RuleDialog } from '@/components/firewall/rule-dialog'
import { useDeleteRule, useReorder, useUpdateRule, type FirewallDevice } from '@/hooks/use-firewall'
import {
  firewallErrorMessage,
  moveSynced,
  orderedForDisplay,
  ruleMatchSummary,
  ruleTitle,
  syncedIds,
  targetTone,
  zoneLabel,
} from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallOverview, FirewallRule, FirewallWriteSummary } from '@/types/firewall'

const TARGET_WORD: Record<string, string> = { ACCEPT: 'Allow', REJECT: 'Reject', DROP: 'Drop' }

/**
 * Traffic rules in the order the router checks them (firewall.md section 3):
 * Perch's rules move with up / down, router-owned ones keep their slots; the
 * new order is sent as one `PUT …/rules/order`. Shadowed rules and rules that
 * cover the management path are flagged.
 */
export function RulesPanel({
  gatewayId,
  overview,
  devices,
  canWrite,
  writeHint,
  onWrite,
}: {
  gatewayId: number
  overview: FirewallOverview
  devices: FirewallDevice[]
  canWrite: boolean
  writeHint: string | null
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const order = overview.orders.rule
  const [draft, setDraft] = useState<string[] | null>(null)
  const [editing, setEditing] = useState<FirewallRule | 'new' | null>(null)
  const [deleting, setDeleting] = useState<FirewallRule | null>(null)
  const [applyOrderNow, setApplyOrderNow] = useState(true)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const reorder = useReorder(gatewayId, 'rule')
  const update = useUpdateRule(gatewayId)
  const remove = useDeleteRule(gatewayId)

  const byId = useMemo(() => new Map(overview.rules.map((r) => [r.id, r])), [overview.rules])
  const nameOf = (id: string) => {
    const r = byId.get(id)
    return r ? ruleTitle(r) : id
  }
  // In a conflict the router's order stays live until the admin chooses: show that one.
  const saved = useMemo(
    () => orderedForDisplay(overview.rules, order?.status === 'conflict' ? null : (order?.desired ?? null)),
    [overview.rules, order],
  )
  const list = useMemo(() => (draft ? orderedForDisplay(overview.rules, draft) : saved), [overview.rules, draft, saved])
  const savedIndex = useMemo(() => new Map(saved.map((r, i) => [r.id, i])), [saved])
  const canReorder = canWrite && order?.status !== 'conflict'
  const syncedCount = list.filter((r) => r.sync.scope === 'synced').length
  const warnings = list.filter((r) => r.shadowedBy || r.pathIssue).length

  function move(id: string, direction: -1 | 1 | 'top') {
    setDraft(syncedIds(moveSynced(list, id, direction)))
  }

  function saveOrder() {
    if (!draft) return
    reorder.mutate(
      { ids: syncedIds(list), apply: applyOrderNow },
      {
        onSuccess: (data) => {
          setDraft(null)
          onWrite({ what: 'Saved the new order of the rules', issues: [], apply: data.apply, applyError: data.applyError })
        },
      },
    )
  }

  function toggle(rule: FirewallRule, enabled: boolean) {
    setToggleError(null)
    update.mutate(
      { id: rule.id, body: { enabled } },
      {
        onSuccess: (data) =>
          onWrite({
            what: `${enabled ? 'Enabled' : 'Disabled'} “${ruleTitle(rule)}”`,
            issues: data.issues,
            apply: data.apply,
            applyError: data.applyError,
          }),
        onError: (error) => setToggleError(`${ruleTitle(rule)}: ${firewallErrorMessage(error)}`),
      },
    )
  }

  const editable = (r: FirewallRule) => canWrite && r.sync.scope === 'synced' && !r.perchBlock && r.sync.issue !== 'ambiguous'

  return (
    <div className="flex flex-col gap-3">
      <OrderStatus type="rule" order={order} gatewayId={gatewayId} canWrite={canWrite} nameOf={nameOf} onWrite={onWrite} />
      <Panel
        flush
        title="Traffic rules"
        description={
          <>
            Checked top to bottom; the first rule that matches decides. {list.length} rules
            {warnings > 0 ? <span className="text-status-warning"> · {warnings} with warnings</span> : null}
          </>
        }
        actions={
          canWrite || writeHint ? (
            <Button size="sm" variant="outline" disabled={!canWrite} title={writeHint ?? undefined} onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New rule
            </Button>
          ) : null
        }
      >
        {draft ? (
          <div className="mx-4 mb-3 flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span>The order changed here. Save it to send it to the router; router-owned rules keep their places.</span>
            <div className="flex flex-wrap items-center gap-2">
              <ApplyNowCheckbox id="rules-order-apply" checked={applyOrderNow} onChange={setApplyOrderNow} />
              <Button size="xs" variant="outline" onClick={() => (setDraft(null), reorder.reset())}>
                Discard
              </Button>
              <Button size="xs" disabled={reorder.isPending} onClick={saveOrder}>
                {reorder.isPending ? 'Saving…' : 'Save order'}
              </Button>
            </div>
          </div>
        ) : null}
        {reorder.error ? <ErrorNote error={reorder.error} className="mx-4 mb-3" /> : null}
        {toggleError ? <p className="px-4 pb-2 text-xs text-destructive">{toggleError}</p> : null}
        {canWrite && order?.status === 'conflict' ? (
          <p className="px-4 pb-2 text-[11.5px] text-muted-foreground">Reordering is off until the order conflict is settled.</p>
        ) : null}

        {list.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState title="No traffic rules" description="The zones’ default policies decide everything." />
          </div>
        ) : (
          <ol className="divide-y divide-border/70 border-t border-border">
            {list.map((rule, index) => {
              const synced = rule.sync.scope === 'synced'
              const moved = draft !== null && savedIndex.get(rule.id) !== index
              const syncedPos = list.filter((r) => r.sync.scope === 'synced').indexOf(rule)
              const shadow = rule.shadowedBy ? byId.get(rule.shadowedBy) : undefined
              return (
                <li
                  key={rule.id}
                  className={cn(
                    'flex gap-2 px-3 py-2.5 sm:gap-3 sm:px-4',
                    !rule.enabled && 'text-muted-foreground',
                    moved && 'bg-primary/5',
                  )}
                >
                  <div className="flex w-7 shrink-0 flex-col items-center gap-0.5 pt-0.5">
                    <span className="text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
                    {canReorder && synced ? (
                      <>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Move ${ruleTitle(rule)} up`}
                          disabled={syncedPos === 0}
                          onClick={() => move(rule.id, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Move ${ruleTitle(rule)} down`}
                          disabled={syncedPos === syncedCount - 1}
                          onClick={() => move(rule.id, 1)}
                        >
                          <ArrowDown />
                        </Button>
                      </>
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ToneBadge tone={targetTone(rule.target)} className="font-medium">
                        {TARGET_WORD[rule.target.toUpperCase()] ?? rule.target}
                      </ToneBadge>
                      <span className={cn('text-[13px] font-medium', rule.enabled && 'text-foreground')}>{ruleTitle(rule)}</span>
                      {!rule.enabled ? <ToneBadge tone="muted">Disabled</ToneBadge> : null}
                      {rule.perchBlock ? (
                        <ToneBadge tone="info" title="Part of the per-device internet block: change it from a device's page.">
                          <Prohibit />
                          Internet block
                        </ToneBadge>
                      ) : null}
                    </div>
                    <p className="flex flex-wrap items-center gap-1 text-[12px]">
                      <span className="font-mono">{zoneLabel(rule.src, 'src')}</span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                      <span className="font-mono">{zoneLabel(rule.dest, 'dest')}</span>
                      <span className="text-muted-foreground">· {ruleMatchSummary(rule)}</span>
                    </p>
                    {shadow || rule.shadowedBy ? (
                      <p className="flex items-start gap-1.5 text-[11.5px] text-status-warning">
                        <Warning className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          Never matches: “{shadow ? ruleTitle(shadow) : rule.shadowedBy}” above already{' '}
                          {shadow && shadow.target.toUpperCase() === 'ACCEPT' ? 'allows' : 'blocks'} all of this traffic.
                          {synced ? ' Move this rule above it, or narrow the other one.' : ''}
                        </span>
                      </p>
                    ) : null}
                    {rule.pathIssue ? (
                      <div className="pt-0.5">
                        <PathIssueNote code={rule.pathIssue} compact />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          This rule is already on the router; Perch would refuse to create it.{' '}
                          {rule.enabled ? 'If it is live, the router may be reachable only because of an earlier rule.' : ''}
                        </p>
                      </div>
                    ) : null}
                    {rule.perchBlock ? (
                      <p className="text-[11px] text-muted-foreground">
                        Blocks the devices in the {rule.ipset ?? 'perch_block_wan'} set;{' '}
                        <Link to="/devices" className="underline underline-offset-2">
                          block or allow a device on its page
                        </Link>
                        .
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <SyncBadge sync={rule.sync} />
                    {editable(rule) ? (
                      <div className="flex items-center gap-1">
                        <Switch
                          checked={rule.enabled}
                          disabled={update.isPending && update.variables?.id === rule.id}
                          onCheckedChange={(next) => toggle(rule, next)}
                          aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${ruleTitle(rule)}`}
                        />
                        {canReorder && syncedPos > 0 ? (
                          <Button size="icon-xs" variant="ghost" aria-label={`Move ${ruleTitle(rule)} to the top`} onClick={() => move(rule.id, 'top')}>
                            <ArrowLineUp />
                          </Button>
                        ) : null}
                        <Button size="icon-xs" variant="ghost" aria-label={`Edit ${ruleTitle(rule)}`} onClick={() => setEditing(rule)}>
                          <PencilSimple />
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label={`Delete ${ruleTitle(rule)}`} onClick={() => setDeleting(rule)}>
                          <Trash />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Panel>

      {editing ? (
        <RuleDialog
          gatewayId={gatewayId}
          overview={overview}
          devices={devices}
          rule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete “${ruleTitle(deleting)}”?`}
          description="The rule is removed from the router once the change is applied; the traffic it matched falls through to the next rule or the zone’s policy."
          confirmLabel="Delete"
          destructive
          pending={remove.isPending}
          error={remove.error}
          onClose={() => {
            setDeleting(null)
            remove.reset()
          }}
          onConfirm={(apply) =>
            remove.mutate(
              { id: deleting.id, apply },
              {
                onSuccess: (data) => {
                  onWrite({ what: `Deleted “${ruleTitle(deleting)}”`, issues: data.issues, apply: data.apply, applyError: data.applyError })
                  setDeleting(null)
                },
              },
            )
          }
        />
      ) : null}
    </div>
  )
}
