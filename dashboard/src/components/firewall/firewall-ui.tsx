import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Info, LockKey, ShieldWarning, Warning, WarningCircle, X } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { apiErrorCode } from '@/lib/api'
import {
  APPLY_STATE_LABELS,
  PATH_ISSUE_TEXT,
  SECTION_STATUS_LABELS,
  applyChangesPath,
  firewallErrorMessage,
  pathIssueOf,
  refusalIssues,
  sectionStatusTone,
  type Tone,
} from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallIssue, FirewallPathIssue, FirewallSync, FwApply, FwApplyError } from '@/types/firewall'

/** Small form, badge and result pieces the firewall pages share. */

export const selectClassName =
  'h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function Checkbox({
  id,
  checked,
  onChange,
  label,
  disabled,
  description,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  disabled?: boolean
  description?: ReactNode
}) {
  return (
    <label htmlFor={id} className={cn('flex cursor-pointer items-start gap-2 text-xs', disabled && 'opacity-50')}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-3.5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="space-y-0.5">
        <span className="block font-medium">{label}</span>
        {description ? <span className="block text-[11px] text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  )
}

const TONE_CLASS: Record<Tone, string> = {
  good: 'border-status-good/30 bg-status-good/10 text-foreground',
  warning: 'border-status-warning/40 bg-status-warning/10 text-foreground',
  critical: 'border-destructive/30 bg-destructive/10 text-destructive',
  muted: 'border-border text-muted-foreground',
  info: 'border-primary/30 bg-primary/10 text-foreground',
}

export function ToneBadge({
  tone,
  children,
  title,
  className,
}: {
  tone: Tone
  children: ReactNode
  title?: string
  className?: string
}) {
  return (
    <Badge variant="outline" title={title} className={cn('rounded font-normal', TONE_CLASS[tone], className)}>
      {children}
    </Badge>
  )
}

/**
 * Where an entry stands in the sync: its section status for synced ones,
 * "Router’s" for sections Perch only observes (excluded / unmodeled).
 */
export function SyncBadge({ sync, className }: { sync: FirewallSync; className?: string }) {
  if (sync.issue === 'ambiguous') {
    return (
      <ToneBadge
        tone="warning"
        className={className}
        title="Two router sections share this name: Perch only observes them until one is renamed."
      >
        Ambiguous
      </ToneBadge>
    )
  }
  if (sync.scope !== 'synced') {
    return (
      <ToneBadge
        tone="muted"
        className={className}
        title={
          sync.scope === 'excluded'
            ? 'Excluded from sync: Perch shows it but never changes it.'
            : 'Observed only: Perch does not model this section.'
        }
      >
        Router’s
      </ToneBadge>
    )
  }
  return (
    <ToneBadge tone={sectionStatusTone(sync.status)} className={className}>
      {SECTION_STATUS_LABELS[sync.status]}
    </ToneBadge>
  )
}

/** Validation issues, errors first. Warnings never block a write. */
export function IssueList({ issues, className }: { issues: FirewallIssue[]; className?: string }) {
  if (issues.length === 0) return null
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return (
    <ul className={cn('space-y-1.5', className)}>
      {sorted.map((issue, i) => (
        <li
          key={`${issue.code}-${issue.perchId ?? ''}-${issue.option ?? ''}-${i}`}
          className={cn(
            'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
            issue.severity === 'error'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-status-warning/30 bg-status-warning/10 text-foreground',
          )}
        >
          {issue.severity === 'error' ? (
            <WarningCircle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
          )}
          <span className="min-w-0">
            {issue.message}
            {issue.section || issue.option ? (
              <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                {[issue.config, issue.section].filter(Boolean).join('.')}
                {issue.option ? ` · ${issue.option}` : ''}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The management-path guard, said plainly (firewall.md section 2.1). */
export function PathIssueNote({ code, compact = false }: { code: FirewallPathIssue; compact?: boolean }) {
  const text = PATH_ISSUE_TEXT[code]
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
    >
      <LockKey className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="space-y-0.5">
        <p className="font-medium text-destructive">{text.title}</p>
        {compact ? null : <p className="text-foreground/80">{text.body}</p>}
      </div>
    </div>
  )
}

/** A refusal: the management-path guard gets its own explanation, the rest one line plus issues. */
export function ErrorNote({
  error,
  nameOf,
  className,
}: {
  error: unknown
  nameOf?: (id: string) => string | null
  className?: string
}) {
  if (!error) return null
  const path = pathIssueOf(apiErrorCode(error))
  const issues = refusalIssues(error)
  if (path) {
    return (
      <div className={cn('space-y-2', className)}>
        <PathIssueNote code={path} />
        <IssueList issues={issues} />
      </div>
    )
  }
  return (
    <div className={cn('space-y-2', className)}>
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <Warning className="mt-0.5 size-3.5 shrink-0" />
        <span>{firewallErrorMessage(error, nameOf)}</span>
      </div>
      <IssueList issues={issues} />
    </div>
  )
}

/**
 * What a firewall write did: the warnings and the apply it started. The
 * confirm itself is the app-wide apply banner's job; this links to the
 * gateway's pending changes.
 */
export function WriteResult({
  gatewayId,
  issues,
  apply,
  applyError,
  extra,
}: {
  gatewayId: number
  issues: FirewallIssue[]
  apply: FwApply | null
  applyError: FwApplyError | null
  extra?: ReactNode
}) {
  return (
    <div className="space-y-3">
      <IssueList issues={issues} />
      {apply ? (
        <div className="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs">
          {apply.state === 'confirmed' ? (
            <CheckCircle className="mt-0.5 size-4 shrink-0 text-status-good" />
          ) : apply.protected ? (
            <ShieldWarning className="mt-0.5 size-4 shrink-0 text-status-warning" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          )}
          <div className="space-y-1">
            <p className="font-medium">Apply: {APPLY_STATE_LABELS[apply.state]}</p>
            <p className="text-muted-foreground">
              {apply.protected
                ? `This change touches the path the gateway uses to reach Perch, so it goes out on its own with a longer confirm window (${Math.max(1, Math.round(apply.confirmTimeoutSeconds / 60))} min). If the gateway does not come back, the router rolls it back by itself.`
                : `The router keeps the change once it reconnects and it is confirmed (within ${apply.confirmTimeoutSeconds} s); otherwise it rolls back by itself.`}{' '}
              Follow it in the banner at the top.
            </p>
            {extra}
            <Link to={applyChangesPath(gatewayId)} className="inline-block text-primary underline underline-offset-2">
              See the changes and applies
            </Link>
          </div>
        </div>
      ) : applyError ? (
        <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-2.5 text-xs">
          <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <div className="space-y-1">
            <p className="font-medium">Saved as a draft; no apply started.</p>
            <p className="text-muted-foreground">{applyError.message}</p>
            <Link to={applyChangesPath(gatewayId)} className="inline-block text-primary underline underline-offset-2">
              Open the pending changes
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-medium">Saved in the draft.</p>
            <p className="text-muted-foreground">Nothing goes to the router until you apply the pending changes.</p>
            <Link to={applyChangesPath(gatewayId)} className="inline-block text-primary underline underline-offset-2">
              Open the pending changes
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

/** The page-level note of the last inline write (toggle, delete, reorder, resolve). */
export function LastWriteNote({
  gatewayId,
  what,
  issues,
  apply,
  applyError,
  onDismiss,
}: {
  gatewayId: number
  what: string
  issues: FirewallIssue[]
  apply: FwApply | null
  applyError: FwApplyError | null
  onDismiss: () => void
}) {
  return (
    <section className="card-surface relative space-y-2 p-3" aria-live="polite">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold">{what}</p>
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </Button>
      </div>
      <WriteResult gatewayId={gatewayId} issues={issues} apply={apply} applyError={applyError} />
    </section>
  )
}

/** "Apply now" (default) vs. keep it in the draft (`?apply=0`). */
export function ApplyNowCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <Checkbox
      id={id}
      checked={checked}
      onChange={onChange}
      label="Apply now"
      description="Off: the change waits in the draft (Gateway config → Changes) with your other edits."
    />
  )
}

export function Callout({
  tone,
  icon,
  title,
  children,
  actions,
  className,
}: {
  tone: 'warning' | 'critical' | 'info'
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2.5 text-xs sm:flex-row sm:items-start sm:justify-between',
        tone === 'critical'
          ? 'border-destructive/30 bg-destructive/10'
          : tone === 'warning'
            ? 'border-status-warning/40 bg-status-warning/10'
            : 'border-primary/30 bg-primary/5',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            'mt-0.5 shrink-0',
            tone === 'critical' ? 'text-destructive' : tone === 'warning' ? 'text-status-warning' : 'text-primary',
          )}
        >
          {icon ?? <Warning className="size-4" />}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{title}</p>
          {children ? <div className="text-muted-foreground">{children}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">{actions}</div> : null}
    </div>
  )
}
