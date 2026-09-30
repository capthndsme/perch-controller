import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowsClockwise, Warning } from '@phosphor-icons/react'
import { ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
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
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAmbiguities, useResolveAmbiguities } from '@/hooks/use-gateway-sync'
import { apiErrorCode } from '@/lib/api'
import {
  ACTION_HINT,
  ACTION_LABEL,
  defaultChoice,
  groupNoun,
  hasProblems,
  memberName,
  NAME_MAX,
  resolutionSummary,
  syncRefusalMessage,
  validateResolution,
  type MemberChoice,
} from '@/lib/gateway-sync'
import { cn } from '@/lib/utils'
import type { Gateway } from '@/types/gateway-config'
import type {
  AmbiguityAction,
  AmbiguityGroup,
  AmbiguityMember,
  AmbiguityResolveAnswer,
} from '@/types/gateway-sync'

type GatewayRef = Pick<Gateway, 'id' | 'name' | 'mode'>

const ACTIONS: AmbiguityAction[] = ['keep', 'rename', 'delete', 'exclude']

/**
 * The resolve dialog (design gateway-sync dashboard.md 7, rest.md 6): every
 * group of router sections that share an identity key, and per member a
 * choice: keep, rename (prefilled with the suggested name), delete, or keep
 * router-only. Names are checked here first (the kept and renamed ones must
 * differ ignoring case); one request then promotes the touched sections and
 * sends the renames and deletes to the router in one job, which the apply
 * banner follows. A `sync_changed` answer reloads the groups and says so.
 * A sheet on a phone, a centred card from `sm` (the shared `Dialog`).
 */
export function AmbiguityResolveDialog({
  gateway,
  open,
  onOpenChange,
  groups: only,
  onResolved,
}: {
  gateway: GatewayRef
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Only these group keys (a page that shows one kind); every group when absent. */
  groups?: string[]
  onResolved: (answer: AmbiguityResolveAnswer) => void
}) {
  const view = useAmbiguities(gateway.id)
  const resolve = useResolveAmbiguities(gateway.id)
  const applyId = useId()
  const [choices, setChoices] = useState<Record<string, MemberChoice>>({})
  const [applyNow, setApplyNow] = useState(true)
  const [reloaded, setReloaded] = useState(false)
  // What it was sent for, kept while it animates out (the list empties meanwhile).
  const [sent, setSent] = useState<AmbiguityGroup[] | null>(null)

  const live = useMemo(
    () => (view.data?.groups ?? []).filter((g) => !only || only.includes(g.key)),
    [view.data?.groups, only],
  )
  const groups = sent ?? live
  const effective = (group: AmbiguityGroup, member: AmbiguityMember) =>
    choices[member.perchId] ?? defaultChoice(group, member)
  const problems = useMemo(() => validateResolution(groups, choices), [groups, choices])
  const allChoices = groups.flatMap((g) => g.members.map((m) => effective(g, m)))
  const managed = gateway.mode === 'managed'

  const setChoice = (perchId: string, next: MemberChoice) => setChoices((current) => ({ ...current, [perchId]: next }))

  async function submit() {
    if (!view.data || hasProblems(problems)) return
    setReloaded(false)
    const items = groups.flatMap((group) =>
      group.members.map((member) => {
        const choice = effective(group, member)
        return choice.action === 'rename'
          ? { perchId: member.perchId, action: choice.action, name: choice.name.trim() }
          : { perchId: member.perchId, action: choice.action }
      }),
    )
    try {
      const answer = await resolve.mutateAsync({
        request: { expectRevision: view.data.headRevision, items },
        apply: applyNow,
      })
      setSent(groups)
      onResolved(answer)
      onOpenChange(false)
    } catch (error) {
      if (apiErrorCode(error) === 'sync_changed') {
        // The router moved under us: reload, keep the choices of members still there.
        await view.refetch()
        setReloaded(true)
        resolve.reset()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        className="sm:max-w-2xl"
        data-testid="ambiguity-dialog"
        // Focus the sheet itself: the first radio is not the chosen one, and a
        // name field would raise a phone's keyboard over the list.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Resolve name clashes on {gateway.name}</DialogTitle>
          <DialogDescription>
            These router sections share a name, so Perch cannot tell them apart and only mirrors them. Choose what
            happens to each; everything goes to the router in one change you confirm.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {reloaded ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs"
            >
              <ArrowsClockwise className="mt-0.5 size-3.5 shrink-0 text-primary" />
              The router’s configuration changed while you were choosing. The list is reloaded: check your choices.
            </p>
          ) : null}
          {view.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : view.error ? (
            <ErrorLine message={syncRefusalMessage(view.error)} />
          ) : groups.length === 0 ? (
            <p className="text-muted-foreground">No name clashes are left.</p>
          ) : (
            groups.map((group) => (
              <GroupBlock
                key={group.key}
                group={group}
                problem={problems.groups[group.key] ?? null}
                memberProblems={problems.members}
                choiceOf={(member) => effective(group, member)}
                onChoice={setChoice}
                disabled={resolve.isPending || !managed}
              />
            ))
          )}
          {!managed ? (
            <p className="text-muted-foreground">Resolving needs managed mode (Gateway config → Mode).</p>
          ) : null}
          <ErrorLine message={resolve.error ? syncRefusalMessage(resolve.error) : null} />
        </DialogBody>
        <DialogFooter className="sm:items-center">
          <div className="flex flex-col gap-2 max-sm:order-last sm:mr-auto sm:flex-row sm:items-center sm:gap-3">
            {allChoices.length > 0 ? (
              <p className="text-xs font-medium" data-testid="ambiguity-summary">
                {resolutionSummary(allChoices)}
              </p>
            ) : null}
            <label htmlFor={applyId} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                id={applyId}
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={applyNow}
                onChange={(e) => setApplyNow(e.target.checked)}
              />
              Apply now
              <span className="text-muted-foreground">(off: it waits in the draft)</span>
            </label>
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!managed || resolve.isPending || groups.length === 0 || hasProblems(problems)}
            data-testid="ambiguity-submit"
          >
            {resolve.isPending ? <Spinner className="size-3.5 text-current" /> : null}
            {applyNow ? 'Resolve and apply' : 'Resolve into the draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GroupBlock({
  group,
  problem,
  memberProblems,
  choiceOf,
  onChoice,
  disabled,
}: {
  group: AmbiguityGroup
  problem: string | null
  memberProblems: Record<string, string>
  choiceOf: (member: AmbiguityMember) => MemberChoice
  onChoice: (perchId: string, next: MemberChoice) => void
  disabled: boolean
}) {
  const names = [...new Set(group.members.map((m) => memberName(group, m)).filter((n): n is string => Boolean(n)))]
  const heading =
    group.reason === 'duplicate'
      ? `${group.members.length} identical ${groupNoun(group, group.members.length)}`
      : `${group.members.length} ${groupNoun(group, group.members.length)} named ${names.map((n) => `“${n}”`).join(' / ') || 'alike'}`
  return (
    <section className="space-y-2" aria-label={heading} data-group={group.key}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[13px] font-semibold">{heading}</h3>
        <span className="font-mono text-[11px] text-muted-foreground">{group.key}</span>
      </header>
      <ul className="space-y-2">
        {group.members.map((member) => (
          <MemberCard
            key={member.perchId}
            group={group}
            member={member}
            choice={choiceOf(member)}
            problem={memberProblems[member.perchId] ?? null}
            onChoice={(next) => onChoice(member.perchId, next)}
            disabled={disabled}
          />
        ))}
      </ul>
      {problem ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-status-critical">
          <Warning weight="fill" className="mt-0.5 size-3.5 shrink-0" />
          {problem}
        </p>
      ) : null}
    </section>
  )
}

function MemberCard({
  group,
  member,
  choice,
  problem,
  onChoice,
  disabled,
}: {
  group: AmbiguityGroup
  member: AmbiguityMember
  choice: MemberChoice
  problem: string | null
  onChoice: (next: MemberChoice) => void
  disabled: boolean
}) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const current = memberName(group, member)
  const renaming = choice.action === 'rename'
  // Focus the name field when the admin picks Rename (not on the first paint).
  const [picked, setPicked] = useState(false)
  useEffect(() => {
    if (picked && renaming) inputRef.current?.focus({ preventScroll: true })
  }, [picked, renaming])

  return (
    <li
      className={cn(
        'rounded-lg border bg-card p-3 transition-colors duration-base',
        choice.action === 'delete' ? 'border-destructive/40 bg-destructive/[0.04]' : 'border-border',
      )}
      data-member={member.perchId}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className={cn('min-w-0 flex-1 break-words text-xs', choice.action === 'delete' && 'line-through decoration-destructive/50')}>
          {member.summary}
        </p>
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          <ToneBadge tone={member.enabled ? 'good' : 'neutral'} dot>
            {member.enabled ? 'Enabled' : 'Disabled'}
          </ToneBadge>
          {member.excluded ? <ToneBadge tone="neutral">Router-only now</ToneBadge> : null}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        {group.config}.{member.section}
        {member.position !== null ? ` · #${member.position + 1} in the list` : ''}
        {member.anonymous ? ' · unnamed (Perch names it when it adopts it)' : ''}
      </p>

      <ChoicePicker
        className="mt-2.5"
        label={`What happens to ${current ?? member.section}`}
        value={choice.action}
        renameOffered={group.nameOption !== null}
        disabled={disabled}
        onChange={(action) => {
          setPicked(true)
          onChoice({
            action,
            name: action === 'rename' ? choice.name || member.suggestedName || current || '' : choice.name,
          })
        }}
      />

      <Reveal open={renaming}>
        <div className="space-y-1 pt-2.5">
          <label htmlFor={inputId} className="text-xs font-medium">
            New name{current ? <span className="font-normal text-muted-foreground"> (now “{current}”)</span> : null}
          </label>
          <Input
            ref={inputRef}
            id={inputId}
            value={choice.name}
            maxLength={NAME_MAX}
            disabled={disabled || !renaming}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => onChoice({ action: 'rename', name: e.target.value })}
          />
        </div>
      </Reveal>

      <p
        className={cn(
          'mt-2 text-[11px]',
          problem ? 'text-status-critical' : choice.action === 'delete' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {problem ?? ACTION_HINT[choice.action]}
      </p>
    </li>
  )
}

/**
 * Keep / Rename / Delete / Router-only as one row of segments that fills the
 * card (tall enough for a thumb on a phone). The chosen one tints at once on
 * press; Delete tints red.
 */
function ChoicePicker({
  value,
  onChange,
  renameOffered,
  disabled,
  label,
  className,
}: {
  value: AmbiguityAction
  onChange: (next: AmbiguityAction) => void
  renameOffered: boolean
  disabled: boolean
  label: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('grid grid-cols-4 gap-0.5 rounded-lg border border-border bg-background p-0.5', className)}
    >
      {ACTIONS.map((action) => {
        const checked = value === action
        const off = disabled || (action === 'rename' && !renameOffered)
        return (
          <button
            key={action}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={off}
            title={action === 'rename' && !renameOffered ? 'This kind of section cannot be renamed here' : undefined}
            onClick={() => onChange(action)}
            className={cn(
              'h-9 min-w-0 truncate rounded-md px-1 text-xs font-medium select-none sm:h-7',
              'transition-colors duration-base active:duration-0 [-webkit-touch-callout:none]',
              'focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40',
              checked
                ? action === 'delete'
                  ? 'bg-destructive/15 text-destructive ring-1 ring-destructive/30'
                  : 'bg-foreground/[0.07] text-foreground shadow-xs ring-1 ring-foreground/15 dark:bg-secondary dark:ring-0'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted',
            )}
          >
            {ACTION_LABEL[action]}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Opens from nothing and closes back (rows and opacity), so the card grows
 * around the name field instead of jumping. Reduced motion: a fade only.
 */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-base ease-out motion-reduce:transition-opacity',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
      aria-hidden={!open || undefined}
      inert={!open}
    >
      {/* The clip reaches past the field by its focus ring. */}
      <div className="-mx-1 min-h-0 overflow-hidden px-1 pb-0.5">{children}</div>
    </div>
  )
}
