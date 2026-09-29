import { Controller } from '@react-spring/web'
import type { Viewport } from '@xyflow/react'
import { prefersReducedMotion } from '@/lib/motion'

/**
 * The map's camera (infra-canvas.tsx). Every programmatic move (a `?node=`
 * change, the Wi-Fi chips' refit, Arrange, the fit button, bringing a
 * selection into view) and the glide after a flick run on one set of springs
 * (react-spring) that drive React Flow's viewport frame by frame:
 *
 * - A move is the snappy spring of index.css (`--ease-spring-snappy`:
 *   critically damped, response 0.30 s, no overshoot, settled in about
 *   360 ms). It starts from rest but gets going within a frame or two, so it
 *   answers a tap sooner than an ease-in-out would, and settles like the sheets
 *   it often moves with. Every point of the map travels in a straight line.
 * - A new target during a move (another pick, the sheet rising right after
 *   the pick) retargets the same springs: the camera curves toward it with the
 *   speed it has, never stopping and starting again. A move during a glide takes
 *   the glide's speed along the same way.
 * - A flick-pan on a touch screen glides on after the finger lifts and slows to
 *   a stop like a scroll view (`planGlide`), for at most 900 ms.
 * - Any touch, drag or wheel stops it where it is (the canvas calls `stop`).
 * - With reduced motion the camera jumps and nothing glides: a pan of the
 *   whole map is exactly the motion to spare.
 */

/**
 * ζ 1, response 0.30 s: `--ease-spring-snappy`. `velocity: 0` so a move from
 * rest never inherits an old glide's speed (a move mid-flight keeps its own).
 */
const SNAPPY = { frequency: 0.3, damping: 1, velocity: 0 }
const GLIDE_MAX_MS = 900

export class MapCamera {
  private readonly springs = new Controller<Viewport>({ x: 0, y: 0, zoom: 1 })
  private goal: Viewport | null = null
  private glideTimer: number | null = null
  private readonly apply: (viewport: Viewport) => void
  private readonly read: () => Viewport

  /** `apply` sets React Flow's viewport at once; `read` returns it. */
  constructor(apply: (viewport: Viewport) => void, read: () => Viewport) {
    this.apply = apply
    this.read = read
  }

  /** Once per frame while a spring moves. */
  private readonly frame = () => {
    this.apply(this.springs.get())
  }

  /** Where the running move ends, or null while the camera is still or gliding. */
  target(): Viewport | null {
    return this.goal
  }

  /** Moves the camera to `target`, animated unless `animate` is false or motion is reduced. */
  moveTo(target: Viewport, animate = true): void {
    this.clearGlideTimer()
    if (!animate || prefersReducedMotion()) {
      this.stop()
      this.apply(target)
      return
    }
    // From wherever the map is now (a hand may have moved it since the last move).
    if (this.springs.idle) this.springs.set(this.read())
    const goal = { ...target }
    this.goal = goal
    void this.springs.start({ ...goal, config: SNAPPY, onChange: this.frame }).then(() => {
      if (this.goal === goal) this.goal = null
    })
  }

  /** Glides on from the viewport now at `velocity` (px/ms per axis), decaying with time constant `tau` (ms, per axis). */
  glide(velocity: { x: number; y: number }, tau: { x: number; y: number }): void {
    this.stop()
    const from = this.read()
    this.springs.set(from)
    void this.springs.start({
      x: from.x,
      y: from.y,
      config: (key: string) =>
        key === 'x' || key === 'y' ? { decay: 1 - 1 / tau[key], velocity: velocity[key] } : {},
      onChange: this.frame,
    })
    // What is left after this is below a pixel: stop instead of crawling on.
    this.glideTimer = window.setTimeout(() => {
      this.glideTimer = null
      this.springs.stop()
    }, GLIDE_MAX_MS)
  }

  /** Stops any move or glide where it is. */
  stop(): void {
    this.clearGlideTimer()
    this.goal = null
    this.springs.stop()
  }

  private clearGlideTimer() {
    if (this.glideTimer === null) return
    window.clearTimeout(this.glideTimer)
    this.glideTimer = null
  }
}

/** A box in screen pixels relative to the canvas. */
export type ScreenBox = { left: number; top: number; right: number; bottom: number }

/**
 * How far to move something along one axis so it lies inside [min, max], the
 * least distance. Something bigger than the room shows its start (a frame's
 * name and ports), unless it already fills the room.
 */
function axisShift(start: number, end: number, min: number, max: number): number {
  if (end - start > max - min) return start <= min && end >= max ? 0 : min - start
  if (start < min) return min - start
  if (end > max) return max - end
  return 0
}

/** The camera shift (screen px) that brings `box` inside `area`, or zero when it already is. */
export function revealShift(box: ScreenBox, area: ScreenBox): { dx: number; dy: number } {
  return {
    dx: axisShift(box.left, box.right, area.left, area.right),
    dy: axisShift(box.top, box.bottom, area.top, area.bottom),
  }
}

/** A viewport as the finger left it, at a moment (`performance.now()`). */
export type ViewportSample = Viewport & { t: number }

/**
 * Deceleration of a flicked map per millisecond: UIScrollView's `.fast`
 * (0.99), right for a map; a feed's 0.998 would fling it a thousand pixels.
 * The glide is x(t) = vτ(1 − e^(−t/τ)): it starts at the finger's speed.
 */
const GLIDE_TAU_MS = 1 / (1 - 0.99)
/** Slower than this at release (px/ms) is a placement, not a flick. */
const GLIDE_MIN_SPEED = 0.25
/** The release velocity is measured over the last stretch of the pan. */
const GLIDE_WINDOW_MS = 80
/** A finger that rested this long before lifting meant to stop there. */
const GLIDE_REST_MS = 60

/**
 * How a flick-pan glides on: the release velocity (px/ms) from the viewports
 * the pan went through (latest last), and per axis the decay's time constant.
 * `room` is the translations the camera may reach per axis: an axis whose glide
 * would leave too little of the map on screen decays sooner (more friction), so
 * it still starts at the finger's speed and comes to rest at the edge instead of
 * hitting it; it never pulls the map back. Null for a pinch, a slow or resting
 * release, or no room.
 */
export function planGlide(
  samples: ViewportSample[],
  now: number,
  release: Viewport,
  room: { x: [number, number]; y: [number, number] } | null,
): { velocity: { x: number; y: number }; tau: { x: number; y: number } } | null {
  const last = samples.at(-1)
  if (!last || now - last.t > GLIDE_REST_MS) return null
  let recent = samples.filter((sample) => last.t - sample.t <= GLIDE_WINDOW_MS)
  // A janky frame can leave one sample in the window: measure over the last two then.
  if (recent.length < 2 && samples.length >= 2 && last.t - samples[samples.length - 2].t <= 150) recent = samples.slice(-2)
  const first = recent[0]
  const dt = last.t - first.t
  if (recent.length < 2 || dt < 8) return null
  if (recent.some((sample) => Math.abs(sample.zoom - release.zoom) > 1e-6)) return null
  const vx = (last.x - first.x) / dt
  const vy = (last.y - first.y) / dt
  if (Math.hypot(vx, vy) < GLIDE_MIN_SPEED) return null

  // The share of an axis's glide that stays in the room (0: none, 1: all of it).
  const share = (from: number, v: number, [min, max]: [number, number]) => {
    if (v === 0) return 0
    const reach = v * GLIDE_TAU_MS
    const limit = v > 0 ? max - from : min - from
    if (Math.sign(limit) !== Math.sign(v)) return 0
    return Math.min(1, limit / reach)
  }
  // Under a twentieth of its glide left: that axis stays put.
  const sx = room ? share(release.x, vx, room.x) : 1
  const sy = room ? share(release.y, vy, room.y) : 1
  const velocity = { x: sx >= 0.05 ? vx : 0, y: sy >= 0.05 ? vy : 0 }
  const tau = { x: GLIDE_TAU_MS * Math.max(sx, 0.05), y: GLIDE_TAU_MS * Math.max(sy, 0.05) }
  if (Math.hypot(velocity.x * tau.x, velocity.y * tau.y) < 1) return null
  return { velocity, tau }
}
