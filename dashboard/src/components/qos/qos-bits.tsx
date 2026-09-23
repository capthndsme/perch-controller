import { useId, type ReactNode } from 'react'
import { Warning, WarningOctagon } from '@phosphor-icons/react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBytes } from '@/lib/format-bytes'
import { quotaPercent, refusalIssues, refusalText, TONE_DOT, TONE_TEXT, type Tone } from '@/lib/qos'
import { cn } from '@/lib/utils'
import type { QosPlanIssue, QosQuota } from '@/types/api'

/** Small shared pieces of the traffic-shaping screens. */

export function ToneDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE_DOT[tone], className)} />
}

/** A dot and a word, e.g. the delivery or shaping state. */
export function StatePill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[11px] whitespace-nowrap"
    >
      <ToneDot tone={tone} />
      <span className={tone === 'muted' ? 'text-muted-foreground' : undefined}>{children}</span>
    </span>
  )
}

/** Used / limit with a bar; red once used up. */
export function QuotaBar({ quota, compact = false }: { quota: Pick<QosQuota, 'limitBytes' | 'usedBytes' | 'exhaustedAt'>; compact?: boolean }) {
  const pct = quotaPercent(quota)
  const exhausted = quota.exhaustedAt !== null || pct >= 100
  const tone = exhausted ? 'bg-status-critical' : pct >= 80 ? 'bg-status-warning' : 'bg-brand'
  return (
    <div className={cn('min-w-0', compact ? 'w-40' : 'w-full')}>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Quota used"
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      <p className={cn('mt-0.5 text-[11px] tabular-nums', exhausted ? 'text-status-critical' : 'text-muted-foreground')}>
        {formatBytes(quota.usedBytes)} of {formatBytes(quota.limitBytes)}
        {exhausted ? ' · used up' : ''}
      </p>
    </div>
  )
}

/** A usage bar against a cap (live rate vs its ceiling); a thin line when unlimited. */
export function RateBar({ kbit, capKbit, className }: { kbit: number | null; capKbit: number | null; className?: string }) {
  const pct = capKbit && kbit !== null ? Math.min(100, (kbit / capKbit) * 100) : null
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-muted', className)} aria-hidden>
      {pct !== null ? (
        <div
          className={cn('h-full rounded-full', pct >= 95 ? 'bg-status-warning' : 'bg-brand')}
          style={{ width: `${pct}%` }}
        />
      ) : null}
    </div>
  )
}

type RateFieldsProps = {
  idPrefix: string
  label: string
  down: string
  up: string
  onDown: (v: string) => void
  onUp: (v: string) => void
  hint?: ReactNode
  error?: string | null
  placeholder?: string
  disabled?: boolean
}

/** Two Mbit/s inputs (download, upload). Empty = unlimited unless the placeholder says otherwise. */
export function RateFields({ idPrefix, label, down, up, onDown, onUp, hint, error, placeholder = 'Unlimited', disabled }: RateFieldsProps) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-xs font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-down`} className="text-[11px] text-muted-foreground">
            Download (Mbit/s)
          </Label>
          <Input
            id={`${idPrefix}-down`}
            inputMode="decimal"
            value={down}
            placeholder={placeholder}
            onChange={(e) => onDown(e.target.value)}
            className="rounded-md"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-up`} className="text-[11px] text-muted-foreground">
            Upload (Mbit/s)
          </Label>
          <Input
            id={`${idPrefix}-up`}
            inputMode="decimal"
            value={up}
            placeholder={placeholder}
            onChange={(e) => onUp(e.target.value)}
            className="rounded-md"
          />
        </div>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </fieldset>
  )
}

/** A labelled checkbox row with an explanation. */
export function CheckRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-3.5 accent-[var(--brand)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  )
}

/** Planner issues (from a 422's `issues` or the overview), errors first. */
export function IssueList({ issues, className }: { issues: QosPlanIssue[]; className?: string }) {
  if (issues.length === 0) return null
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return (
    <ul className={cn('space-y-1', className)}>
      {sorted.map((issue, i) => (
        <li key={`${issue.code}-${i}`} className="flex items-start gap-1.5 text-xs">
          {issue.severity === 'error' ? (
            <WarningOctagon className="mt-0.5 size-3.5 shrink-0 text-status-critical" />
          ) : (
            <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
          )}
          <span>
            {issue.message}
            {issue.code !== 'check' ? <span className="ml-1 font-mono text-[10px] text-muted-foreground">{issue.code}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A refused write: the plain sentence, then the planner's issues when the server sent them. */
export function RefusalAlert({ error }: { error: unknown }) {
  if (!error) return null
  const issues = refusalIssues(error)
  return (
    <div role="alert" className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <p>{refusalText(error)}</p>
      {issues.length ? <IssueList issues={issues} className="text-foreground" /> : null}
    </div>
  )
}

/** Loud strip for things an operator must not miss (router-side pauses). */
export function LoudBanner({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: 'critical' | 'warning' | 'info'
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
}) {
  const skin =
    tone === 'critical'
      ? 'border-status-critical/50 bg-status-critical/10'
      : tone === 'warning'
        ? 'border-status-warning/50 bg-status-warning/10'
        : 'border-border bg-muted/30'
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={cn('flex flex-col gap-2 rounded-lg border px-3.5 py-3 sm:flex-row sm:items-start', skin)}>
      {icon ? <span className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}>{icon}</span> : null}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {children ? <div className="space-y-1 text-xs text-muted-foreground [&_strong]:text-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
