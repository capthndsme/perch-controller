import { useLayoutEffect, useRef, type RefObject } from 'react'
import { easeInOut, useReducedMotion } from '@/lib/motion'

/**
 * Far along an animation's timeline and a whole number of 1 s laps (so the
 * phase stays): an animation playing backwards from here runs for weeks before
 * it reaches its start, where it would stop.
 */
const TIME_ORIGIN_MS = 1e9

/**
 * Sets the speed of an element's running CSS animation (the map's flow dots and
 * activity lights) through WAAPI instead of `animation-duration`. Changing the
 * duration of a running animation keeps its elapsed time, so the animation
 * jumps to another phase, and flipping `animation-direction` mirrors it; a
 * playback rate change keeps the current position. The CSS animation runs one
 * lap per second: `rate` is laps per second, negative to run backwards.
 *
 * With `rampMs` a change of speed or direction eases over that time
 * (`easeInOut`, through a stop when it turns), like something with mass, instead
 * of snapping. The first rate of a new animation applies at once. With reduced
 * motion there is no animation to drive (infra-traffic.css).
 */
export function usePlaybackRate(ref: RefObject<Element | null>, rate: number, rampMs = 0): void {
  // A new animation starts when reduced motion is switched off again: apply the rate to it.
  const reduce = useReducedMotion()
  const driven = useRef<Animation | null>(null)

  useLayoutEffect(() => {
    // The keyframe animation, not a transition running beside it (the dots'
    // fade-in, a stroke-width step), which getAnimations() lists first.
    const animation = ref.current?.getAnimations().find((running) => running instanceof CSSAnimation)
    if (!animation) return
    if (driven.current !== animation) {
      driven.current = animation
      if (rampMs > 0) {
        const now = animation.currentTime
        animation.currentTime = TIME_ORIGIN_MS + (typeof now === 'number' ? now : 0)
      }
      animation.playbackRate = rate
      return
    }
    const from = animation.playbackRate
    if (from === rate) return
    if (rampMs <= 0) {
      animation.updatePlaybackRate(rate)
      return
    }
    // Each step keeps the current position: only the speed changes.
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / rampMs))
      animation.playbackRate = from + (rate - from) * easeInOut(t)
      if (t < 1) frame = window.requestAnimationFrame(step)
    }
    frame = window.requestAnimationFrame(step)
    // A newer rate takes over from wherever this ramp got to.
    return () => window.cancelAnimationFrame(frame)
  }, [ref, rate, rampMs, reduce])
}
