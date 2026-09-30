import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { intProblem } from '@/lib/alert-settings'
import { cn } from '@/lib/utils'
import type { Limit } from '@/types/alerts'

/**
 * A whole-number field with its unit after it and its limits under it (from the controller's `limits`),
 * the same rule the server applies.
 */
export function NumberField({
  id,
  label,
  value,
  onChange,
  limit,
  unit,
  hint,
  error,
  zeroOr = false,
  className,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  limit?: Limit
  unit?: string
  hint?: ReactNode
  error?: string | null
  zeroOr?: boolean
  className?: string
}) {
  const problem = error ?? (value === '' ? null : intProblem(value, limit, { zeroOr }))
  const range = limit ? (zeroOr ? `0 or ${limit.min}–${limit.max}` : `${limit.min}–${limit.max}`) : null
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          className="h-9 w-28 rounded-md tabular-nums"
          value={value}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => onChange(event.target.value.replace(/[^\d-]/g, ''))}
        />
        {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
      </div>
      {problem ? (
        <p className="text-xs text-destructive">{problem}</p>
      ) : hint || range ? (
        <p className="text-xs text-muted-foreground">
          {hint}
          {hint && range ? ' ' : ''}
          {range ? <span className="whitespace-nowrap">({range})</span> : null}
        </p>
      ) : null}
    </div>
  )
}
