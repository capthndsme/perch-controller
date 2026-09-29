import { useState } from 'react'
import { SpringValue, to } from '@react-spring/web'
import { useDrag, type FullGestureState } from '@use-gesture/react'
import { MOTION_MS, easeOut, prefersReducedMotion } from '@/lib/motion'
import { SPRING, rubberBand, type Spring } from '@/lib/spring'

/**
 * The motion of a bottom sheet (components/ui/bottom-sheet.tsx) on
 * react-spring + use-gesture: the sheet follows the finger 1:1, rubber-bands
 * past its top detent, and on release heads for where the flick would coast
 * to (Apple's projection) on a spring that starts at the finger's speed.
 * A touch on a moving sheet stops it under the finger; a retarget while it
 * moves keeps its velocity (react-spring carries it), so nothing ever jumps.
 * The scrim's opacity is an interpolation of the same spring value.
 *
 * Geometry: `y` is the sheet's translateY. 0 = its top detent (fully up),
 * each lower detent a larger `y`, closed = its visible height + 40 px. Above
 * the top detent (`y` < 0) it is elastic: what is drawn is `y` through the
 * rubber band, for the finger and for a throw's overshoot alike.
 */

/** An Apple spring as react-spring config: its `frequency` is Apple's response (s), `damping` the damping ratio. */
function apple({ damping, response }: Spring) {
  return { frequency: response, damping }
}

/** ζ 1, response 0.35 s (~475 ms): present, snap between detents. */
const PRESENT = apple(SPRING.sheet)
/** ζ 0.85, response 0.30 s: back to a detent after a fast flick (momentum earns a hair of overshoot). */
const SETTLE = apple(SPRING.settle)
/** ζ 1, response 0.30 s: dismiss (off screen after ~200 ms, where the sheet unmounts). */
const EXIT = apple(SPRING.snappy)
/** Reduced motion: a short ease-out fade (present, dismiss) or slide (snap back after a drag). */
const GENTLE = { duration: MOTION_MS.fast, easing: easeOut }

/** A drag starts after this much travel; less is a tap, so tiles and buttons inside still work. */
const SLOP_PX = 10
/** The release velocity is measured over the last stretch of the gesture… */
const VELOCITY_WINDOW_MS = 100
/** …and is zero when the finger rested this long before lifting. */
const REST_MS = 60
/** Apple's projection, UIScrollView's normal rate 0.998: (v / 1000) · d / (1 − d) = v · 0.499 s. */
const PROJECTION_S = 0.998 / (1 - 0.998) / 1000
/** A flick (≥ 0.11 px/ms) moves the sheet at least one detent its way. */
const FLICK_PX_S = 110
/** A release this far below the lowest detent (share of the travel from there to closed) closes it. */
const DISMISS_SHARE = 0.25
/** Back to a detent faster than this, the settle spring (ζ 0.85) instead of the present one. */
const BOUNCE_PX_S = 500
/** Closed sits this far below the visible height, so the sheet's shadow leaves the screen too. */
const CLOSED_EXTRA_PX = 40
/** Where the sheet waits before it has been measured: surely below any screen. */
const OFF_SCREEN = 10_000

export type SheetDragConfig = {
  /** Visible heights to rest at, as fractions of the sheet's height, largest first (`[1]`, `[1, 0.5]`). */
  detents: readonly number[]
  /** The detent (index) it rises to when it opens. */
  initial: number
  /** Modal sheets dim the page over their whole travel; the others only above their lowest detent. */
  modal: boolean
  /** The sheet scrolls its own content (at its top detent; lower, a drag on it moves the sheet). */
  scrollable: boolean
  /** The latest `open` of the component, for a release after the page closed the sheet meanwhile. */
  open: boolean
  /** The user closed it (drag, flick, Escape, scrim, close button), as its exit starts. */
  onDismiss: () => void
  /** The user caught it while it was leaving after `onDismiss`: it stays. */
  onRevive: () => void
  /** Off screen at last: unmount it. */
  onClosed: () => void
  /** It heads for a detent (index into `detents`) or off screen (null); `top` = its top edge there, viewport px. */
  onDetentChange?: (detent: number | null, top: number) => void
}

type Geometry = {
  visible: number
  /** Resting `y` of each detent, ascending (index 0 = top). */
  detents: number[]
  closed: number
  /** At or below this `y` the scrim is clear. */
  undimmed: number
}

type Drag = {
  reduced: boolean
  samples: { t: number; y: number }[]
}

type DragState = FullGestureState<'drag'>

function createSheetEngine() {
  let cfg: SheetDragConfig = {
    detents: [1],
    initial: 0,
    modal: true,
    scrollable: false,
    open: false,
    onDismiss: () => {},
    onRevive: () => {},
    onClosed: () => {},
  }
  const y = new SpringValue(OFF_SCREEN)
  /** Sheet opacity: 1 but for reduced motion, where presenting and dismissing fade instead of travelling. */
  const fade = new SpringValue(1)
  let sheet: HTMLElement | null = null
  let scrim: HTMLElement | null = null
  let geo: Geometry = { visible: 0, detents: [0], closed: 0, undimmed: 0 }
  /** The detent it rests at or heads for; null = off screen or leaving. */
  let detent: number | null = null
  /** The last detent it rested at, for a reopen while it leaves. */
  let restDetent = 0
  let leaving: 'user' | 'page' | null = null
  /** The pointer that is down on the sheet (one drives it; a second finger is ignored). */
  let pointerId: number | null = null
  /** Where a motion stopped by the touch was heading (detent or null = off screen); undefined = none. */
  let stopped: number | null | undefined
  let drag: Drag | null = null
  let touchStartX = 0
  let touchStartY = 0
  let touchSideways = false
  let detachPending = false
  /** A motion waiting for the next frame(s) (see `moveSoon`). */
  let pending = 0

  /** Where the sheet is drawn for a spring value: past the top detent, through the rubber band. */
  function shown(at: number): number {
    return at >= 0 ? at : rubberBand(at, geo.closed)
  }

  /** Scrim opacity at `at`: 0 at or below the undimmed point, 1 at the top detent and above. */
  function dim(at: number): number {
    const u = geo.undimmed
    return u <= 0 ? 0 : Math.min(1, Math.max(0, (u - at) / u))
  }

  function measure() {
    if (!sheet) return
    const visible = sheet.offsetHeight - (parseFloat(getComputedStyle(sheet).borderBottomWidth) || 0)
    const detents = cfg.detents.map((share) => Math.round(visible * (1 - share)))
    // A modal scrim is clear exactly as the sheet leaves the screen, so the unmount never pops it.
    geo = { visible, detents, closed: visible + CLOSED_EXTRA_PX, undimmed: cfg.modal ? visible : detents[detents.length - 1] }
  }

  /** Touch and scrim behaviour for where the sheet is heading. */
  function applyRest(next: number | null) {
    if (!sheet) return
    // Scrolls its content only at the top detent; anywhere else a drag moves the sheet.
    sheet.style.touchAction = cfg.scrollable && next === 0 ? 'pan-y' : 'none'
    // A clear scrim lets the page under a non-modal sheet be used.
    if (scrim && !cfg.modal) {
      scrim.style.pointerEvents = next !== null && geo.detents[next] < geo.undimmed ? 'auto' : 'none'
    }
  }

  /** The sheet's top edge (viewport px) were it resting at `at`. */
  function topAt(at: number): number {
    if (!sheet) return 0
    let drawn = shown(y.get())
    try {
      // What is on screen: react-spring writes the transform on the next frame.
      drawn = new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42
    } catch {
      // Keep the spring's value.
    }
    return sheet.getBoundingClientRect().top - drawn + at
  }

  function cancelPending() {
    if (pending) cancelAnimationFrame(pending)
    pending = 0
  }

  /**
   * Start a motion `frames` frames late: after the page's own work for the
   * change (its re-render, focus, scroll lock). A spring started inside that
   * long frame would catch up in one visible jump; started after it, its first
   * frames are even. Not for a drag's release, whose velocity must carry on.
   */
  function moveSoon(next: number | null, frames: number) {
    cancelPending()
    detent = next
    // The page hears where it is heading at once (the map camera starts alongside).
    announce(next)
    const wait = (left: number) => {
      pending = requestAnimationFrame(() => {
        if (left > 1) wait(left - 1)
        else {
          pending = 0
          moveTo(next, 0, false)
        }
      })
    }
    wait(frames)
  }

  /** Tell the page which detent the sheet heads for (null = off screen) and where its top edge will rest. */
  function announce(next: number | null) {
    measure()
    cfg.onDetentChange?.(next, topAt(next === null ? geo.closed : geo.detents[next]))
  }

  function finishClose() {
    if (leaving === null || drag) return
    leaving = null
    y.stop()
    fade.stop()
    cfg.onClosed()
  }

  /**
   * Head for a detent (null = off screen) from wherever the sheet is. A
   * released drag hands over `velocity` (px/s, positive = down); a retarget
   * mid-flight keeps the spring's own. Reduced motion: present and dismiss
   * fade where the sheet stands, a snap back is a 150 ms slide. The page is
   * told the destination as the motion starts (`announced`: already told).
   */
  function moveTo(next: number | null, velocity = 0, announced = false) {
    if (!sheet) return
    cancelPending()
    measure()
    const target = next === null ? geo.closed : geo.detents[next]
    const reduced = prefersReducedMotion()
    if (y.get() >= OFF_SCREEN) {
      // The first motion after mounting: from the bottom edge (reduced motion: faded out where it will rest).
      if (reduced) {
        y.set(target)
        fade.set(0)
      } else {
        y.set(geo.closed)
      }
    }
    detent = next
    if (next !== null) restDetent = next
    applyRest(next)
    if (!announced) cfg.onDetentChange?.(next, topAt(target))
    if (reduced) {
      if (next === null) {
        void fade.start({ to: 0, config: GENTLE, onRest: (result) => result.finished && finishClose() })
      } else if (fade.get() < 1) {
        y.set(target)
        void fade.start({ to: 1, config: GENTLE })
      } else {
        void y.start({ to: target, config: GENTLE })
      }
      return
    }
    if (fade.get() < 1) void fade.start({ to: 1, config: GENTLE })
    const spring = next === null ? EXIT : Math.abs(velocity) > BOUNCE_PX_S ? SETTLE : PRESENT
    void y.start({
      to: target,
      // react-spring takes px/ms; it only applies to a spring at rest (a running one keeps its own).
      config: { ...spring, velocity: velocity / 1000, precision: 0.1 },
      // Gone below the screen's edge: unmount now rather than after the spring's last invisible pixels.
      onChange: next === null ? () => y.get() >= geo.visible - 0.5 && finishClose() : undefined,
      onRest: next === null ? (result) => result.finished && finishClose() : undefined,
    })
  }

  /** Where a release at `at` with `velocity` (px/s) goes: a detent index, or null to close. */
  function pick(at: number, velocity: number): number | null {
    const ys = geo.detents
    const lowest = ys[ys.length - 1]
    const projected = at + velocity * PROJECTION_S
    let nearest = 0
    for (let i = 1; i < ys.length; i += 1) {
      if (Math.abs(ys[i] - projected) < Math.abs(ys[nearest] - projected)) nearest = i
    }
    let next: number | null = projected > lowest + DISMISS_SHARE * (geo.closed - lowest) ? null : nearest
    if (velocity > FLICK_PX_S) {
      // Down: at least the next detent under the sheet, or closed.
      const below = ys.findIndex((d) => d > at + 1)
      if (below === -1) next = null
      else if (next !== null && next < below) next = below
    } else if (velocity < -FLICK_PX_S) {
      // Up: at least the next detent above it, and never closed.
      let above = 0
      for (let i = 0; i < ys.length; i += 1) if (ys[i] < at - 1) above = i
      if (next === null || next > above) next = above
    }
    return next
  }

  function swallowNextClick() {
    const stop = (event: Event) => {
      event.stopPropagation()
      event.preventDefault()
    }
    window.addEventListener('click', stop, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 100)
  }

  /** At its top detent a scrolling sheet leaves a gesture to its content, unless that is at its top and pulled down. */
  function contentTakes(dy: number): boolean {
    return !!sheet && cfg.scrollable && detent === 0 && y.get() <= 0.5 && (sheet.scrollTop > 0 || dy < 0)
  }

  /** A motion the touch stopped carries on (the touch was a tap, or not the sheet's gesture). */
  function resumeStopped() {
    const next = stopped
    stopped = undefined
    if (next !== undefined) moveTo(next)
  }

  function onDrag(state: DragState) {
    const { first, last, active, offset, xy, initial, timeStamp, event, cancel } = state
    if (!sheet) return
    if (first) {
      const dx = xy[0] - initial[0]
      const dy = xy[1] - initial[1]
      const onHandle = event.target instanceof Element && !!event.target.closest('[data-sheet-handle]')
      if (leaving === 'page' || Math.abs(dx) > Math.abs(dy) || (!onHandle && contentTakes(dy))) {
        // Sideways (a table's own scroll), or the content scrolls: not the sheet's gesture.
        cancel()
        resumeStopped()
        return
      }
      stopped = undefined
      measure()
      drag = { reduced: prefersReducedMotion(), samples: [] }
      sheet.dataset.dragging = ''
      window.getSelection()?.removeAllRanges()
      if (leaving === 'user') {
        leaving = null
        cfg.onRevive()
      }
    }
    const g = drag
    if (!g) return
    if (active) {
      // Past the top detent it follows less and less (`shown`); reduced motion: it stops there.
      const at = g.reduced ? Math.max(offset[1], 0) : offset[1]
      y.set(at)
      g.samples.push({ t: timeStamp, y: at })
      while (g.samples.length > 2 && timeStamp - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift()
    }
    if (last) {
      drag = null
      delete sheet.dataset.dragging
      swallowNextClick()
      const at = y.get()
      const first = g.samples[0]
      const latest = g.samples[g.samples.length - 1]
      // A cancelled pointer (the browser took the touch) settles by position alone.
      const counts = event.type !== 'pointercancel' && first && latest && latest.t > first.t
      const velocity = counts && timeStamp - latest.t <= REST_MS ? ((latest.y - first.y) / (latest.t - first.t)) * 1000 : 0
      const next = pick(at, velocity)
      if (next !== null && cfg.open) {
        moveTo(next, velocity)
        return
      }
      if (leaving === null) {
        leaving = cfg.open ? 'user' : 'page'
        if (cfg.open) cfg.onDismiss()
      }
      moveTo(null, velocity)
    }
  }

  /** Before use-gesture sees the press: a moving sheet stops under the finger (it starts its drag from there). */
  function pointerDown(event: PointerEvent) {
    if (pointerId !== null || !sheet || leaving === 'page') return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointerId = event.pointerId
    stopped = y.isAnimating || fade.isAnimating || pending ? detent : undefined
    cancelPending()
    y.stop()
    fade.stop()
  }

  function pointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    pointerId = null
    // No drag took hold: whatever the touch stopped carries on.
    if (!drag) resumeStopped()
  }

  function onTouchStart(event: TouchEvent) {
    touchStartX = event.touches[0]?.clientX ?? 0
    touchStartY = event.touches[0]?.clientY ?? 0
    touchSideways = inSideScroller(event.target)
  }

  /** Whether a touch starts inside something that scrolls sideways (a wide table) within the sheet. */
  function inSideScroller(target: EventTarget | null): boolean {
    for (let el = target instanceof Element ? target : null; el && el !== sheet; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true
    }
    return false
  }

  // iOS: with `touch-action: pan-y` a pull down on content already at its top
  // starts the native bounce and cancels the pointer; refusing that first
  // touchmove keeps the pointer stream for the sheet's drag.
  function onTouchMove(event: TouchEvent) {
    if (!event.cancelable || !sheet) return
    if (drag) {
      event.preventDefault()
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    // Any pull down counts, except a mostly sideways one on a wide table (its own scroll).
    const pullsDown = dy > 0 && !(touchSideways && Math.abs(dx) > dy)
    if (detent === 0 && y.get() <= 0.5 && sheet.scrollTop <= 0 && pullsDown) event.preventDefault()
  }

  function onResize() {
    if (!sheet || drag || y.isAnimating || detent === null) return
    measure()
    y.set(geo.detents[detent])
    applyRest(detent)
    cfg.onDetentChange?.(detent, topAt(geo.detents[detent]))
  }

  function detach() {
    if (!sheet) return
    cancelPending()
    sheet.removeEventListener('touchstart', onTouchStart)
    sheet.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('resize', onResize)
    y.stop()
    fade.stop()
    // The next mount renders off screen until it is measured.
    y.set(OFF_SCREEN)
    sheet = null
    drag = null
    pointerId = null
    stopped = undefined
    leaving = null
    detent = null
  }

  return {
    /** translateY of the sheet, for its `style.transform`. */
    transform: y.to((at) => `translate3d(0, ${shown(at)}px, 0)`),
    fade,
    /** The scrim's opacity: locked to the sheet's position (and its fade). */
    scrimOpacity: to([y, fade], (at: number, f: number) => dim(at) * f),
    /** Where use-gesture starts a drag: the sheet's current offset. */
    from: (): [number, number] => [0, y.get()],
    onDrag,
    pointerDown,
    pointerUp,
    configure(next: SheetDragConfig) {
      cfg = next
    },
    /** The scrim element (a ref). */
    setScrim(el: HTMLElement | null) {
      scrim = el
    },
    /** The sheet element (a ref): on mount it rises from the bottom edge to the initial detent. */
    setSheet(el: HTMLElement | null) {
      if (!el) {
        // A re-render hands the same element to a new ref callback (null, then the element, in one
        // commit): detach only if it is really gone.
        detachPending = true
        queueMicrotask(() => {
          if (detachPending) detach()
          detachPending = false
        })
        return
      }
      detachPending = false
      if (el === sheet) return
      detach()
      sheet = el
      leaving = null
      measure()
      const initial = Math.min(Math.max(cfg.initial, 0), geo.detents.length - 1)
      // Rise once the mount's own work (focus, scroll lock, the page's reflow) has had its frames; the
      // first motion also places it (react-spring watches the element only once it has mounted).
      applyRest(initial)
      moveSoon(initial, 2)
      el.addEventListener('touchstart', onTouchStart, { passive: true })
      el.addEventListener('touchmove', onTouchMove, { passive: false })
      window.addEventListener('resize', onResize)
    },
    /** The user closes it (Escape, scrim, close button): `onDismiss` now, `onClosed` once it is off screen. */
    dismiss() {
      if (!sheet || leaving !== null) return
      leaving = 'user'
      cfg.onDismiss()
      moveSoon(null, 1)
    },
    /** The page closed it (`open` went false). */
    close() {
      if (!sheet || leaving !== null) return
      leaving = 'page'
      moveSoon(null, 1)
    },
    /** The page opened it again while it was leaving: back to where it rested, from where it is. */
    reopen() {
      if (!sheet || leaving === null || drag) return
      leaving = null
      moveTo(restDetent)
    },
    /** Down to the lowest detent (a tap on a non-modal sheet's scrim). */
    collapse() {
      if (!sheet || leaving !== null || drag) return
      moveTo(geo.detents.length - 1)
    },
  }
}

export type SheetEngine = ReturnType<typeof createSheetEngine>

/** One sheet engine per component, and the use-gesture binding that drives it. */
export function useSheetDrag() {
  const [engine] = useState(createSheetEngine)
  const bind = useDrag(engine.onDrag, {
    from: engine.from,
    // The sheet takes a drag after 10 px of travel (a shorter wobble stays a tap).
    threshold: SLOP_PX,
    // Arrow keys on the focused sheet are for its content, not for moving it.
    keys: false,
  })
  return { engine, bind }
}
