/**
 * Apple-style springs (damping ratio + response) as WAAPI timing, for motion a
 * finger releases: the release velocity is handed to the spring, so a flick
 * keeps its speed into the settle instead of restarting from rest. Plain
 * springs without a gesture use the `--ease-spring-*` CSS curves instead.
 */

export type Spring = { damping: number; response: number }

export const SPRING = {
  /** Present, tap-dismiss, snap between detents. */
  sheet: { damping: 1, response: 0.35 },
  /** After a flick back toward open: momentum earns a hair of overshoot. */
  settle: { damping: 0.85, response: 0.3 },
  snappy: { damping: 1, response: 0.3 },
} as const

/**
 * Timing of a damped spring from 0 to 1 whose initial velocity is `v`
 * progress-units per second (a release velocity in px/s divided by the
 * distance left to travel). Returns a duration in ms and a CSS `linear()`
 * easing for `element.animate()`. x(0) = 0 and x'(0) = v on both branches.
 */
export function springTiming(
  { damping: z, response }: Spring,
  v = 0,
  rest = 0.002,
): { duration: number; easing: string } {
  const w = (2 * Math.PI) / response
  const at = (t: number) => {
    if (z >= 1) return 1 - (1 + (w - v) * t) * Math.exp(-w * t)
    const wd = w * Math.sqrt(1 - z * z)
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w - v) / wd) * Math.sin(wd * t))
  }
  let end = 0
  for (let t = 0; t < 1.5; t += 1 / 240) if (Math.abs(1 - at(t)) > rest) end = t
  const duration = Math.max(end, 0.1)
  const n = Math.max(8, Math.ceil(duration * 40))
  const pts = Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : +at((i / n) * duration).toFixed(3)))
  return { duration: duration * 1000, easing: `linear(${pts.join(',')})` }
}

/**
 * Rubber-banding past an edge (iOS): the element follows less the further it
 * goes, never stopping at a wall. `overshoot` in px, `dimension` the size of
 * the axis (the sheet's height).
 */
export function rubberBand(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot)
  const x = Math.abs(overshoot)
  return sign * (1 - 1 / ((x * constant) / dimension + 1)) * dimension
}
