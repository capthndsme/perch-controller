import { useLayoutEffect, useRef, type RefObject } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/**
 * Keeps the current entry (`aria-current="page"` or `aria-selected="true"`) of
 * a strip that scrolls sideways in view: on a phone a section's tabs are wider
 * than the screen. Runs again whenever `key` changes (the path). The strip is
 * placed before its first paint; a strip that stays on screen across pages
 * (the Gateway one) glides so the entry sits in the middle, with both
 * neighbours showing (instantly with reduced motion). An entry already in
 * view never moves the strip.
 */
export function useActiveIntoView(ref: RefObject<HTMLElement | null>, key: unknown) {
  const shown = useRef(false)
  useLayoutEffect(() => {
    const strip = ref.current
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]')
    if (!strip || !active) return
    const first = !shown.current
    shown.current = true
    const bounds = strip.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    if (item.left >= bounds.left && item.right <= bounds.right) return
    const left = strip.scrollLeft + (item.left - bounds.left) - (bounds.width - item.width) / 2
    strip.scrollTo({ left, behavior: first || prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [ref, key])
}
