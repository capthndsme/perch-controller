import * as React from 'react'
import { X } from '@phosphor-icons/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * Modal dialog (Radix Dialog in the shadcn skin). Below `sm` it is a sheet
 * docked to the bottom of the screen with its own scroll, so long forms stay
 * usable on a phone; from `sm` up a centred card. The sheet rises from the
 * bottom edge by its own height on the sheet spring (475 ms) and drops back on
 * the exit spring (320 ms), no fade on the slab (a form: no drag); the card
 * settles in from 95 % with a fade (200 ms in, 150 ms out, ease-out). Reduced
 * motion (index.css): both fade without moving.
 */
const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

function DialogContent({
  className,
  children,
  wide = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { wide?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-black/40 transition-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          // The scrim keeps time with the sheet below sm, with the card from sm.
          'max-sm:data-[state=open]:duration-[475ms] max-sm:data-[state=open]:ease-spring-sheet max-sm:data-[state=closed]:duration-[320ms] max-sm:data-[state=closed]:ease-spring-exit',
          'sm:data-[state=open]:duration-base sm:data-[state=closed]:duration-fast sm:ease-out',
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex max-h-[92svh] w-full flex-col overflow-hidden border border-border bg-card text-card-foreground shadow-xl outline-none',
          'inset-x-0 bottom-0 rounded-t-xl',
          'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:max-h-[88svh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          // `transition-none`: the duration utilities below would otherwise give it a `transition: all`.
          'transition-none data-[state=open]:animate-in data-[state=closed]:animate-out',
          // Below sm: a sheet that rises from the bottom edge by its own height and drops back.
          'max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=open]:duration-[475ms] max-sm:data-[state=open]:ease-spring-sheet',
          'max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=closed]:duration-[320ms] max-sm:data-[state=closed]:ease-spring-exit',
          // sm and up: a centred card that settles in from 95 % (a modal: from its centre).
          'sm:data-[state=open]:fade-in-0 sm:data-[state=open]:zoom-in-95 sm:data-[state=open]:duration-base sm:data-[state=open]:ease-out',
          'sm:data-[state=closed]:fade-out-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=closed]:duration-fast sm:data-[state=closed]:ease-out',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('space-y-1 border-b border-border px-4 py-3 pr-10', className)} {...props} />
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-border bg-muted/20 px-4 py-3 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-sm font-semibold', className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-xs text-muted-foreground', className)} {...props} />
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription }
