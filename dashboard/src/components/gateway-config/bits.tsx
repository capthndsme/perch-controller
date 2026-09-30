import { useId, type ReactNode } from 'react'
import { Lock } from '@phosphor-icons/react'
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
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  diffActionLabel,
  formatUciValue,
  TONE_CLASS,
  TONE_DOT,
  type Tone,
} from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { ConfigDiffEntry, Issue } from '@/types/gateway-config'

/** A small status pill in one of the status tones. */
export function ToneBadge({
  tone,
  children,
  dot = false,
  className,
  title,
}: {
  tone: Tone
  children: ReactNode
  dot?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-[11px] font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} /> : null}
      {children}
    </span>
  )
}

/** Monospace UCI value; long lists wrap. */
export function UciValueText({ value, className }: { value: unknown; className?: string }) {
  const text = formatUciValue(value)
  return (
    <span className={cn('font-mono text-[11px] break-all', text === '—' && 'text-muted-foreground', className)}>
      {text}
    </span>
  )
}

/** A list of `ConfigDiffEntry`: one block per section, one line per option. */
export function DiffList({
  entries,
  empty = 'No changes.',
  beforeLabel = 'Before',
  afterLabel = 'After',
}: {
  entries: ConfigDiffEntry[]
  empty?: string
  beforeLabel?: string
  afterLabel?: string
}) {
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>
  return (
    <ul className="space-y-2">
      {entries.map((entry, index) => (
        <li key={`${entry.perchId ?? entry.section}-${index}`} className="rounded-md border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2.5 py-1.5">
            <ToneBadge tone={entry.action === 'delete' ? 'critical' : entry.action === 'create' ? 'good' : 'info'}>
              {diffActionLabel(entry.action)}
            </ToneBadge>
            <span className="font-mono text-[11px] font-medium">
              {entry.config}.{entry.section}
            </span>
            {entry.renamedFrom ? (
              <span className="text-[11px] text-muted-foreground">
                renamed from <span className="font-mono">{entry.renamedFrom}</span>
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground">{entry.type}</span>
            {entry.domain ? <span className="text-[11px] text-muted-foreground">· {entry.domain}</span> : null}
          </div>
          {entry.options.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="w-1/4 px-2.5 py-1 font-medium">Option</th>
                    <th className="px-2.5 py-1 font-medium">{beforeLabel}</th>
                    <th className="px-2.5 py-1 font-medium">{afterLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.options.map((option) => (
                    <tr key={option.name} className="border-t border-border/60 align-top">
                      <td className="px-2.5 py-1 font-mono">
                        {option.name}
                        {option.secret ? <Lock className="ml-1 inline size-3 text-muted-foreground" aria-label="secret" /> : null}
                      </td>
                      <td className="px-2.5 py-1">
                        <span className="rounded-sm bg-status-critical/10 px-1 line-through decoration-status-critical/50">
                          <UciValueText value={option.before} />
                        </span>
                      </td>
                      <td className="px-2.5 py-1">
                        <span className="rounded-sm bg-status-good/10 px-1">
                          <UciValueText value={option.after} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null
  return (
    <ul className="space-y-1">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="flex items-start gap-2 text-xs">
          <ToneBadge tone={issue.severity === 'error' ? 'critical' : 'warning'}>
            {issue.severity === 'error' ? 'Error' : 'Warning'}
          </ToneBadge>
          <span>
            {issue.config && issue.section ? (
              <span className="mr-1 font-mono text-[11px] text-muted-foreground">
                {issue.config}.{issue.section}
                {issue.option ? `.${issue.option}` : ''}
              </span>
            ) : null}
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The admin's current password, for the step-up writes. */
export function PasswordField({
  value,
  onChange,
  error,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  error?: string | null
  autoFocus?: boolean
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        Your password
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">Asked again because this lets Perch change the router.</p>
      )}
    </div>
  )
}

export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
      {message}
    </p>
  )
}

/** A yes/no confirmation dialog around one async action. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  destructive = false,
  pending = false,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string | null
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children || error ? (
          <DialogBody>
            {children}
            <ErrorLine message={error} />
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={pending}>
            {pending ? <Spinner className="size-3.5 text-current" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Label + value row used by the fact lists. */
export function FactRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}
