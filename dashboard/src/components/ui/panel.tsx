import type { ReactNode } from 'react'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import { cn } from '@/lib/utils'

type PanelProps = {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned header controls. */
  actions?: ReactNode
  children: ReactNode
  /** Shows the "Updating…" overlay while a new window is loading. */
  updating?: boolean
  /** Remove the inner padding (for edge-to-edge tables). */
  flush?: boolean
  className?: string
}

/** Card with the shared header rhythm every dashboard panel uses. */
export function Panel({ title, description, actions, children, updating = false, flush = false, className }: PanelProps) {
  return (
    <section className={cn('card-surface relative flex min-w-0 flex-col', className)}>
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5 pb-2.5">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn('min-w-0 flex-1', flush ? '' : 'px-4 pb-4')}>{children}</div>
      <PanelOverlay show={updating} label="Updating…" />
    </section>
  )
}
