import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CaretRight } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

export type Crumb = { label: string; to?: string }

type PageHeaderProps = {
  title: ReactNode
  /** One line under the title; keep it short. */
  description?: ReactNode
  /** Breadcrumb trail rendered above the title (last item is the page). */
  crumbs?: Crumb[]
  /** Right-aligned controls (time picker, scope, actions). */
  actions?: ReactNode
  /** Extra content under the description — badges, identity chips. */
  children?: ReactNode
  className?: string
}

/**
 * Page title block used by every routed page so the shell has one rhythm:
 * breadcrumbs → title + actions → description → optional chips.
 */
export function PageHeader({ title, description, crumbs, actions, children, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {crumbs && crumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
              {index > 0 ? <CaretRight className="size-3 opacity-60" /> : null}
              {crumb.to ? (
                <Link to={crumb.to} className="transition-colors hover:text-foreground">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-foreground">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}
