import { lazy, Suspense, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'

/**
 * The bottom sheet's module carries react-spring and use-gesture: it loads
 * only on a phone, when a sheet first opens (desktops never fetch it).
 */
const BottomSheet = lazy(() => import('@/components/ui/bottom-sheet').then((m) => ({ default: m.BottomSheet })))

/** Phones and small tablets get the draggable sheet; wider screens a dialog. */
const PHONE_QUERY = '(width < 48rem)'

function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY)
}

/**
 * A per-item editor (a radio, one AP's overrides, a divergence's passphrase,
 * the impact preview): a draggable bottom sheet on a phone that scrolls its
 * own content with the footer pinned at the bottom, a centred dialog from
 * 768 px up. The sheet rides the shell's sheet spring; nothing here animates
 * on its own.
 */
export function EditorSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
  tall = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Full height on a phone (long forms, the adoption wizard). */
  tall?: boolean
}) {
  const phone = useIsPhone()
  if (phone) {
    return (
      <Suspense fallback={null}>
        <BottomSheet
          open={open}
          onOpenChange={onOpenChange}
          scrollable
          height={tall ? '92svh' : undefined}
          className={cn(
            'z-[56] flex flex-col pb-[env(safe-area-inset-bottom)]',
            !tall && 'max-h-[calc(92svh+var(--sheet-guard))]',
          )}
          overlayClassName="z-[55]"
        >
          <div className="px-4 pb-3">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
          </div>
          <div className="flex-1 space-y-4 px-4 pb-4 text-xs">{children}</div>
          {footer ? (
            <div className="sticky bottom-0 z-10 flex flex-col-reverse gap-2 border-t border-border bg-card px-4 py-3 [&>*]:w-full">
              {footer}
            </div>
          ) : null}
        </BottomSheet>
      </Suspense>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide={wide}
        onOpenAutoFocus={(event) => {
          // Focus the dialog itself, not its first control (no ring on "Show changes").
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription asChild><div>{description}</div></DialogDescription> : null}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  )
}
