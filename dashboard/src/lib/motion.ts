import { useSyncExternalStore } from 'react'

/**
 * Motion for JS-driven animation. The CSS side lives in index.css
 * (`--ease-out`, `--ease-in-out`, `--ease-drawer`, `--ease-spring-*`,
 * `--transition-duration-fast|base|slow`); these mirror it. Springs that a
 * finger hands its velocity to are computed in `lib/spring.ts`.
 */

/** The duration tokens in milliseconds (index.css `--transition-duration-*`). */
export const MOTION_MS = { fast: 150, base: 200, slow: 300 } as const

/** The easing tokens as CSS values, for WAAPI and inline styles. */
export const EASE = {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
  springSnappy: 'var(--ease-spring-snappy)',
  springSheet: 'var(--ease-spring-sheet)',
  springExit: 'var(--ease-spring-exit)',
} as const

/** The pairing durations of the spring curves (index.css comment). */
export const SPRING_MS = { snappy: 360, sheet: 475, exit: 320 } as const

/** Strong ease-out as a function of progress, for JS tweens (React Flow's `ease`). */
export function easeOut(t: number): number {
  // cubic-bezier(0.23, 1, 0.32, 1) is the quintic ease-out.
  return 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 5)
}

/** Strong ease-in-out as a function of progress (on-screen movement). */
export function easeInOut(t: number): number {
  // cubic-bezier(0.77, 0, 0.175, 1) sits closest to the quartic ease-in-out.
  const x = Math.min(Math.max(t, 0), 1)
  return x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2
}

const REDUCED = '(prefers-reduced-motion: reduce)'

/**
 * Whether the viewer asked for less motion. Read it when a motion starts, so a
 * change of the setting applies to the next one.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED).matches
}

function subscribeReduced(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** `prefersReducedMotion()` as React state, following the setting live. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, prefersReducedMotion, () => false)
}
