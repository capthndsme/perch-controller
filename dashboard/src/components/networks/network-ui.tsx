import type { ReactNode } from 'react'
import { Warning } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { SECTION_STATUS_LABELS, networkErrorMessage, sectionStatusTone } from '@/lib/networks'
import { cn } from '@/lib/utils'
import type { SectionStatus } from '@/types/networks'

/** Small form and badge pieces the Networks pages share. */

export const selectClassName =
  'h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'

type FormFieldProps = {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}

export function FormField({ label, htmlFor, hint, error, children, className }: FormFieldProps) {
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

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive',
        className,
      )}
    >
      <Warning className="mt-0.5 size-3.5 shrink-0" />
      <span>{networkErrorMessage(error)}</span>
    </div>
  )
}

const TONE_CLASS = {
  good: 'border-status-good/30 bg-status-good/10 text-foreground',
  warning: 'border-status-warning/40 bg-status-warning/10 text-foreground',
  critical: 'border-destructive/30 bg-destructive/10 text-destructive',
  muted: 'border-border text-muted-foreground',
} as const

/** The config plane state of a network's sections (worst of them). */
export function SectionStatusBadge({ status, className }: { status: SectionStatus | null; className?: string }) {
  if (!status) return null
  return (
    <Badge variant="outline" className={cn('rounded font-normal', TONE_CLASS[sectionStatusTone(status)], className)}>
      {SECTION_STATUS_LABELS[status]}
    </Badge>
  )
}

export function ToneBadge({
  tone,
  children,
  title,
  className,
}: {
  tone: keyof typeof TONE_CLASS
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

/** Up / down dot with its word, for the live report. */
export function UpDot({ up }: { up: boolean | null | undefined }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        up === true ? 'bg-status-good' : up === false ? 'bg-status-critical' : 'bg-muted-foreground/40',
      )}
    />
  )
}
