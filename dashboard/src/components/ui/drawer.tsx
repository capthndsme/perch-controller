import * as React from 'react'
import { X } from '@phosphor-icons/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * Side drawer (Radix Dialog): a panel docked to the right from `sm` up, a
 * bottom sheet below it (like `Dialog`). For a record's details beside the
 * list it came from. Reuses `DialogHeader`/`DialogBody`/`DialogFooter`/
 * `DialogTitle`/`DialogDescription` from `dialog.tsx` for its parts. It slides
 * in from its edge by its own size on the sheet spring (475 ms) and leaves the
 * same way on the exit spring (320 ms), no fade on the panel; the scrim fades
 * in step. Reduced motion (index.css): it fades without moving.
 */
const Drawer = DialogPrimitive.Root

function DrawerContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-black/30 transition-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-[475ms] data-[state=open]:ease-spring-sheet',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[320ms] data-[state=closed]:ease-spring-exit',
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex w-full flex-col overflow-hidden border-border bg-card text-card-foreground shadow-xl outline-none',
          'inset-x-0 bottom-0 max-h-[92svh] rounded-t-xl border-t',
          'sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:max-w-md sm:rounded-none sm:border-t-0 sm:border-l',
          // `transition-none`: the duration utilities below would otherwise give it a `transition: all`.
          'transition-none data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:duration-[475ms] data-[state=open]:ease-spring-sheet data-[state=closed]:duration-[320ms] data-[state=closed]:ease-spring-exit',
          // A bottom sheet below sm, a panel on the right edge from sm: each leaves the way it came.
          'max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom',
          'sm:data-[state=open]:slide-in-from-right sm:data-[state=closed]:slide-out-to-right',
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

export { Drawer, DrawerContent }
