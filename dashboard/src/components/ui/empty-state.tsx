import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type EmptyStateProps = {
  title: string
  description?: ReactNode
  icon?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-4 py-8 text-center',
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-md text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}
