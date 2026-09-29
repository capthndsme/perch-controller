import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { animated } from '@react-spring/web'
import { useSheetDrag } from '@/hooks/use-sheet-drag'
import { cn } from '@/lib/utils'

const FULL: readonly number[] = [1]

type BottomSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Visible heights it rests at, as fractions of its height, largest first:
   * `[1]` (default) or Maps-style `[1, 0.5]`. It opens at the lowest one
   * unless `initialDetent` (an index) says otherwise.
   */
  detents?: readonly number[]
  initialDetent?: number
  /**
   * Modal (default): scrim over the page, scroll lock, focus trapped, a tap
   * outside closes. Non-modal: the page stays usable while the sheet rests at
   * its lowest detent; the scrim dims only above it, and a tap on it lowers
   * the sheet back there.
   */
  modal?: boolean
  /** The sheet scrolls its own content (at its top detent; lower down, dragging it raises the sheet). */
  scrollable?: boolean
  /** Its full visible height (a CSS length such as `90svh`); by default its content's. */
  height?: string
  /** It heads for a detent (index) or off screen (null); `top` = its top edge there, in viewport px. */
  onDetentChange?: (detent: number | null, top: number) => void
  /** Focus goes here when it closes (the button that opened it); by default to what had focus when it opened. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
  /** The sheet: z-index, width, padding (it has no padding of its own). */
  className?: string
  /** The scrim: z-index, colour (default `bg-black/40`). */
  overlayClassName?: string
  /** The sheet element (for a scrollable one, its scroller). */
  contentRef?: React.Ref<HTMLDivElement>
  'aria-label'?: string
  children: React.ReactNode
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

/**
 * A sheet docked to the bottom edge. Radix Dialog gives it focus handling,
 * Escape, aria and the scroll lock; the motion is react-spring + use-gesture
 * (`hooks/use-sheet-drag.ts`). It rises from the edge on a critically damped
 * spring, follows the finger 1:1 from anywhere on it (the grab handle
 * always, a scrolling body once that is scrolled to its top), rubber-bands
 * past its top, and on release carries the flick's speed to the detent it was
 * thrown at, or off the screen. Caught mid-flight it stops under the finger;
 * the scrim's dim is locked to its position. Closing plays the exit first:
 * `onOpenChange(false)` fires as it starts, the unmount once it is off
 * screen. Reduced motion: it fades in and out (150 ms) instead of
 * travelling, and a drag stops at the top instead of rubber-banding.
 *
 * Keeps react-spring and use-gesture out of the entry chunk: the shell loads
 * this module lazily (layout/bottom-nav.tsx).
 */
function BottomSheet({
  open,
  onOpenChange,
  detents = FULL,
  initialDetent,
  modal = true,
  scrollable = false,
  height,
  onDetentChange,
  returnFocusRef,
  className,
  overlayClassName,
  contentRef,
  children,
  ...aria
}: BottomSheetProps) {
  const { engine, bind } = useSheetDrag()
  // Mounted (Radix `open`) until the exit has played; `open` is the page's wish.
  const [present, setPresent] = React.useState(open)
  if (open && !present) setPresent(true)
  const returnFocus = React.useRef<Element | null>(null)

  React.useLayoutEffect(() => {
    engine.configure({
      detents,
      initial: initialDetent ?? detents.length - 1,
      modal,
      scrollable,
      open,
      onDismiss: () => onOpenChange(false),
      onRevive: () => onOpenChange(true),
      onClosed: () => setPresent(false),
      onDetentChange,
    })
  })

  React.useLayoutEffect(() => {
    if (!present) return
    if (open) engine.reopen()
    else engine.close()
  }, [engine, open, present])

  const sheetRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      assignRef(contentRef, el)
      engine.setSheet(el)
    },
    [engine, contentRef],
  )
  const scrimRef = React.useCallback((el: HTMLDivElement | null) => engine.setScrim(el), [engine])

  const gesture = bind()
  const scrimClass = cn('fixed inset-0 z-50 touch-none bg-black/40', overlayClassName)
  const scrimStyle = { opacity: engine.scrimOpacity }
  return (
    <DialogPrimitive.Root
      open={present}
      modal={modal}
      onOpenChange={(next) => (next ? onOpenChange(true) : engine.dismiss())}
    >
      <DialogPrimitive.Portal>
        {modal ? (
          <DialogPrimitive.Overlay asChild>
            <animated.div ref={scrimRef} className={scrimClass} style={scrimStyle} />
          </DialogPrimitive.Overlay>
        ) : (
          <animated.div
            ref={scrimRef}
            aria-hidden
            className={scrimClass}
            style={scrimStyle}
            onClick={() => engine.collapse()}
          />
        )}
        <DialogPrimitive.Content
          asChild
          aria-describedby={undefined}
          {...aria}
          onOpenAutoFocus={(event) => {
            // Focus the sheet itself, not its first button (no ring on a random control).
            event.preventDefault()
            returnFocus.current = document.activeElement
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const el = returnFocusRef?.current ?? returnFocus.current
            if (el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus({ preventScroll: true })
          }}
          onInteractOutside={modal ? undefined : (event) => event.preventDefault()}
        >
          <animated.div
            ref={sheetRef}
            {...gesture}
            onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
              engine.pointerDown(event.nativeEvent)
              gesture.onPointerDown?.(event)
            }}
            onPointerUp={(event: React.PointerEvent<HTMLDivElement>) => {
              engine.pointerUp(event.nativeEvent)
              gesture.onPointerUp?.(event)
            }}
            onPointerCancel={(event: React.PointerEvent<HTMLDivElement>) => {
              engine.pointerUp(event.nativeEvent)
              gesture.onPointerCancel?.(event)
            }}
            onLostPointerCapture={(event: React.PointerEvent<HTMLDivElement>) => {
              engine.pointerUp(event.nativeEvent)
              gesture.onLostPointerCapture?.(event)
            }}
            // A mouse drag that starts on a tile would drag the link away instead of the sheet.
            onDragStart={(event: React.DragEvent<HTMLDivElement>) => event.preventDefault()}
            style={{
              transform: engine.transform,
              opacity: engine.fade,
              height: height ? `calc(${height} + var(--sheet-guard))` : undefined,
            }}
            className={cn(
              'fixed inset-x-0 z-50 bg-card text-card-foreground shadow-xl outline-none will-change-transform',
              'rounded-t-2xl border-t border-border',
              // It runs on below the screen's edge by --sheet-guard (its bottom border, in the card's colour),
              // so a pull past its top or a settle's overshoot never uncovers the page under it.
              '[--sheet-guard:40svh] -bottom-(--sheet-guard) border-b-(length:--sheet-guard) border-b-card',
              'data-[dragging]:select-none',
              scrollable ? 'overflow-y-auto overscroll-contain' : 'touch-none',
              className,
            )}
          >
            <div
              data-sheet-handle
              aria-hidden
              className={cn(
                'flex cursor-grab touch-none justify-center pt-2 pb-2 select-none',
                scrollable && 'sticky top-0 z-10 bg-card',
              )}
            >
              <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
            </div>
            {children}
          </animated.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

const BottomSheetTitle = DialogPrimitive.Title
const BottomSheetClose = DialogPrimitive.Close

export { BottomSheet, BottomSheetTitle, BottomSheetClose }
