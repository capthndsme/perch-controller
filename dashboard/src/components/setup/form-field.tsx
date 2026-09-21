import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type FieldProps = {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  children: ReactNode
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {children}
      {hint && !error ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

type FormErrorProps = {
  message: string
}

export function FormError({ message }: FormErrorProps) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {message}
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function formClassName(className?: string) {
  return cn('space-y-4', className)
}
