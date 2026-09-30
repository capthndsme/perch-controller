import type { ReactNode } from 'react'
import { X } from '@phosphor-icons/react'
import { BottomSheet, BottomSheetClose, BottomSheetTitle } from '@/components/ui/bottom-sheet'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'

type UpdatesSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** Under the title: badges, one line of context. */
  subtitle?: ReactNode
  /** Sticks to the bottom edge (the sheet's actions). */
  footer?: ReactNode
  /** From sm up the side panel is wider (the rollout). */
  wide?: boolean
  children: ReactNode
}

/**
 * A record's details beside the list it came from: on a phone the shared
 * BottomSheet (drag it down, flick it away; it sits over the tab bar), from
 * `sm` up the side Drawer. Header, scrolling body and a sticky footer either way.
 */
export function UpdatesSheet({ open, onOpenChange, title, subtitle, footer, wide = false, children }: UpdatesSheetProps) {
  const phone = useMediaQuery('(width < 40rem)')

  if (phone) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={onOpenChange}
        scrollable
        height="90svh"
        className="flex flex-col"
      >
        <div className="flex items-start gap-2 border-b border-border px-4 pb-3">
          <div className="min-w-0 flex-1 space-y-1">
            <BottomSheetTitle className="text-base font-semibold">{title}</BottomSheetTitle>
            {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
          </div>
          <BottomSheetClose
            className="-mr-1 rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2"
            aria-label="Close"
          >
            <X className="size-4" />
          </BottomSheetClose>
        </div>
        <div className="flex-1 space-y-5 px-4 py-4 text-xs">{children}</div>
        {footer ? (
          <div className="sticky bottom-0 z-10 flex flex-wrap gap-2 border-t border-border bg-card px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </BottomSheet>
    )
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={cn(wide && 'sm:max-w-lg')} aria-describedby={undefined}>
        <div className="space-y-1 border-b border-border px-4 py-3 pr-10">
          <DialogTitle className="text-base">{title}</DialogTitle>
          {subtitle ? <DialogDescription asChild><div>{subtitle}</div></DialogDescription> : null}
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 text-xs">{children}</div>
        {footer ? (
          <div className="flex flex-wrap gap-2 border-t border-border bg-muted/20 px-4 py-3">{footer}</div>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

/** A titled block inside a sheet. */
export function SheetSection({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="section-label">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** Label → value rows (install facts). */
export function FactList({ rows }: { rows: { label: string; value: ReactNode; hint?: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-border/70 rounded-md border border-border">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-3 px-3 py-2">
          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 text-right">
            <div className="break-words">{row.value}</div>
            {row.hint ? <div className="text-[11px] text-muted-foreground">{row.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
