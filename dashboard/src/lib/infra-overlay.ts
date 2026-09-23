import type { CSSProperties } from 'react'
import { placedDevices, type LayoutIndex, type MapLayout } from '@/lib/infra'
import type { DeviceType, InfraNode, WifiClientSummary, WifiSignalQuality } from '@/types/api'

/**
 * The "WiFi clients" overlay of the network map (docs/infrastructure-view.md
 * A4, dashboard item 4): which connected Wi-Fi clients hang off which access
 * point. Pure functions of the drawn map and `GET /wifi/clients?activeOnly=true`;
 * nothing here is ever written back. Only the lazily loaded Infrastructure page
 * imports this module.
 */

export const CLIENT_CHIP_WIDTH = 148
export const CLIENT_CHIP_HEIGHT = 38
const CHIP_GAP_X = 10
const CHIP_GAP_Y = 10
/** Room between an AP's box and a block of its clients above or below it, for the wireless lines. */
const CHIP_DROP = 52
/** The same for a block beside it. */
const CHIP_SIDE_GAP = 44
/** Free space kept around every box a block of clients must not touch. */
const OBSTACLE_MARGIN = 16
/** How close a wireless line may pass a box it does not end at. */
const LINE_CLEARANCE = 4
/** How far a block may move out from its AP on one side before the next side is tried. */
const NEAR_GAP = 120
const NEAR_STEP = 8
/** A block keeps at least this much of itself facing its AP. */
const FACING = 32
/** No side has room close by: the nearest free spot anywhere around the AP, up to this far out. */
const FAR_GAP = 1200
const FAR_SLIDE = 600
const FAR_STEP = 24
/** Sliding a block along its side of the AP costs less than moving it away. */
const SLIDE_COST = 0.35
/** More clients than this on one AP: the eleven strongest, then a "+N more" chip. */
export const MAX_CLIENT_CHIPS = 12
/**
 * Wireless lines are drawn beneath every box. React Flow lifts an edge to the
 * z-index of a child node it ends at (every chip is its AP's child), and by
 * 1000 more while that AP is selected; an edge's own z-index is added to that,
 * so this keeps every line below every box and chip. Cables keep the default.
 */
export const WIFI_EDGE_Z_INDEX = -2000

/** One small box on the overlay: a client, or the "+N more" of an AP with more than twelve. */
export type OverlayChip = {
  /** `wifi:<mac>` or `wifi-more:<ap node id>`; never a number, so never mistaken for a map node. */
  id: string
  variant: 'client' | 'more'
  apNodeId: number
  /** Top-left relative to the AP's box: the chip is drawn as its child and moves with it. */
  x: number
  y: number
  mac: string | null
  name: string
  deviceType: DeviceType | null
  band: string | null
  quality: WifiSignalQuality | null
  /** "+N more": how many. */
  count: number
}

/** A wireless line from an AP's box to a chip, or to the box of a client that is on the map. */
export type OverlayEdge = {
  id: string
  /** The AP's box. */
  source: string
  /** A chip id, or the id of a box on the map. */
  target: string
  quality: WifiSignalQuality | null
  variant: 'client' | 'more'
}

export type WifiOverlay = {
  chips: OverlayChip[]
  edges: OverlayEdge[]
  /** Every connected client the API listed, by lowercase MAC. */
  clients: Map<string, WifiClientSummary>
  /** AP box id → the clients without a chip of their own (beyond the eleven strongest), strongest first. */
  overflow: Map<number, WifiClientSummary[]>
  /** Lowercase MAC → the drawn box it is bound to: a line, no chip. */
  onMap: Map<string, InfraNode>
  /** Lowercase MAC → a box it is bound to that is hidden: it still gets a chip. */
  hiddenOnMap: Map<string, InfraNode>
  /** Connected clients of access points that are not drawn (hidden, or no box). */
  offMapCount: number
}

export type Rect = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

/** A client's name on the overlay: its label's, else DHCP's, else the MAC (A4.4). */
export function clientName(client: Pick<WifiClientSummary, 'customName' | 'hostname' | 'mac'>): string {
  return client.customName || client.hostname || client.mac
}

/**
 * The stroke of a wireless line: the palette of `wifiSignalQualityDotClass`
 * (lib/wifi.ts), green for excellent and very good, amber for good and fair,
 * rose for weak, muted when unknown.
 */
export function signalStroke(quality: WifiSignalQuality | null | undefined): string {
  if (quality === 'excellent' || quality === 'very_good') return 'var(--color-emerald-500)'
  if (quality === 'good' || quality === 'fair') return 'var(--color-amber-500)'
  if (quality === 'weak' || quality === 'very_weak') return 'var(--color-rose-500)'
  return 'var(--muted-foreground)'
}

/** Strongest first; a client without a reading counts as the weakest; ties by MAC. */
function byStrength(a: WifiClientSummary, b: WifiClientSummary): number {
  const as = a.signalDbm ?? Number.NEGATIVE_INFINITY
  const bs = b.signalDbm ?? Number.NEGATIVE_INFINITY
  if (as !== bs) return bs - as
  return a.mac.localeCompare(b.mac)
}

/** Chips sit in name order, so a poll moves nothing unless the set of clients changes. */
function byName(a: WifiClientSummary, b: WifiClientSummary): number {
  return clientName(a).localeCompare(clientName(b), undefined, { sensitivity: 'base' }) || a.mac.localeCompare(b.mac)
}

/** Where every drawn box is, in flow coordinates (children of host frames included). */
export function absoluteRects(mapLayout: MapLayout): Map<number, Rect> {
  const rects = new Map<number, Rect>()
  // Parents come before their children in `placed`.
  for (const entry of mapLayout.placed) {
    const parent = entry.parentId !== null ? rects.get(entry.parentId) : undefined
    rects.set(entry.node.id, {
      x: entry.position.x + (parent?.x ?? 0),
      y: entry.position.y + (parent?.y ?? 0),
      width: entry.width,
      height: entry.height,
    })
  }
  return rects
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  )
}

type Side = 'below' | 'right' | 'above' | 'left'
type Segment = readonly [Point, Point]
type Grid = { columns: number; rows: number }

function across(side: Side): boolean {
  return side === 'below' || side === 'above'
}

/**
 * Columns of an AP's block of chips: above or below it one row up to four,
 * then three or four across; beside it one column up to three, then two or
 * three, so the block stays close to the AP either way.
 */
function gridFor(count: number, side: Side): Grid {
  const columns = across(side) ? (count <= 4 ? count : count <= 9 ? 3 : 4) : count <= 3 ? 1 : count <= 8 ? 2 : 3
  return { columns, rows: Math.ceil(count / columns) }
}

function sizeOf(grid: Grid): { width: number; height: number } {
  return {
    width: grid.columns * CLIENT_CHIP_WIDTH + (grid.columns - 1) * CHIP_GAP_X,
    height: grid.rows * CLIENT_CHIP_HEIGHT + (grid.rows - 1) * CHIP_GAP_Y,
  }
}

/** The chips of a block, row by row, the last row centred. */
function cellsOf(block: Rect, grid: Grid, count: number): Rect[] {
  const cells: Rect[] = []
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / grid.columns)
    const inRow = row === grid.rows - 1 ? count - row * grid.columns : grid.columns
    const indent = ((grid.columns - inRow) * (CLIENT_CHIP_WIDTH + CHIP_GAP_X)) / 2
    cells.push({
      x: Math.round(block.x + indent + (i % grid.columns) * (CLIENT_CHIP_WIDTH + CHIP_GAP_X)),
      y: Math.round(block.y + row * (CLIENT_CHIP_HEIGHT + CHIP_GAP_Y)),
      width: CLIENT_CHIP_WIDTH,
      height: CLIENT_CHIP_HEIGHT,
    })
  }
  return cells
}

const centreOf = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

/** The wireless line between an AP and a chip, as `WifiEdge` draws it: box edge to box edge. */
function lineOf(from: Rect, to: Rect): Segment {
  return [borderPoint(from, centreOf(to)), borderPoint(to, centreOf(from))]
}

/** Whether a line passes through a box grown by `pad` on every side (Liang-Barsky clipping). */
function crosses([p, q]: Segment, rect: Rect, pad: number): boolean {
  const x0 = rect.x - pad
  const y0 = rect.y - pad
  const x1 = rect.x + rect.width + pad
  const y1 = rect.y + rect.height + pad
  const dx = q.x - p.x
  const dy = q.y - p.y
  let t0 = 0
  let t1 = 1
  for (const [pk, qk] of [
    [-dx, p.x - x0],
    [dx, x1 - p.x],
    [-dy, p.y - y0],
    [dy, y1 - p.y],
  ]) {
    if (pk === 0) {
      if (qk < 0) return false
      continue
    }
    const t = qk / pk
    if (pk < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

/** A block of `size` on one side of the AP: `gap` further out than the natural spacing, `slide` along the side. */
function blockAt(ap: Rect, size: { width: number; height: number }, side: Side, gap: number, slide: number): Rect {
  const x =
    side === 'right'
      ? ap.x + ap.width + CHIP_SIDE_GAP + gap
      : side === 'left'
        ? ap.x - CHIP_SIDE_GAP - size.width - gap
        : ap.x + ap.width / 2 - size.width / 2 + slide
  const y =
    side === 'below'
      ? ap.y + ap.height + CHIP_DROP + gap
      : side === 'above'
        ? ap.y - CHIP_DROP - size.height - gap
        : ap.y + ap.height / 2 - size.height / 2 + slide
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height }
}

type Candidate = { side: Side; grid: Grid; rect: Rect; cost: number; slide: number }

/**
 * Every spot for a block on one side of the AP, nearest first: moving out
 * costs its distance, sliding along the side a third of it, `penalty` ranks
 * the side. The block keeps `FACING` of itself in front of the AP, or
 * `extraSlide` more.
 */
function candidatesOn(ap: Rect, side: Side, count: number, maxGap: number, extraSlide: number, step: number, penalty: number): Candidate[] {
  const grid = gridFor(count, side)
  const size = sizeOf(grid)
  const limit = Math.max(0, across(side) ? (size.width + ap.width) / 2 - FACING : (size.height + ap.height) / 2 - FACING) + extraSlide
  const list: Candidate[] = []
  for (let gap = 0; gap <= maxGap; gap += step) {
    for (let k = -Math.floor(limit / step); k <= Math.floor(limit / step); k += 1) {
      const slide = k * step
      list.push({ side, grid, rect: blockAt(ap, size, side, gap, slide), cost: penalty + gap + SLIDE_COST * Math.abs(slide), slide })
    }
  }
  return list.sort((a, b) => a.cost - b.cost || Math.abs(a.slide) - Math.abs(b.slide) || a.slide - b.slide)
}

/** Free horizontal room beside the AP, in the band a block beside it would take. */
function roomBeside(ap: Rect, side: 'left' | 'right', bandHeight: number, obstacles: Rect[]): number {
  const top = ap.y + ap.height / 2 - bandHeight / 2 - OBSTACLE_MARGIN
  const bottom = top + bandHeight + 2 * OBSTACLE_MARGIN
  let room = Number.POSITIVE_INFINITY
  for (const o of obstacles) {
    if (o.y >= bottom || o.y + o.height <= top) continue
    if (side === 'right' && o.x + o.width > ap.x + ap.width) room = Math.min(room, Math.max(0, o.x - (ap.x + ap.width)))
    if (side === 'left' && o.x < ap.x) room = Math.min(room, Math.max(0, ap.x - (o.x + o.width)))
  }
  return room
}

type Surroundings = {
  /** Every drawn box, this AP included, and every block placed so far. */
  obstacles: Rect[]
  /** What this AP's lines must not pass through: the same without the AP and the frames it sits in. */
  lineObstacles: Rect[]
  /** Every wireless line drawn so far: a block must not cover one. */
  lines: Segment[]
}

/** A block whose chips and lines clear every box, every other block and every other line. */
function isClear(ap: Rect, candidate: Candidate, cells: Rect[], around: Surroundings): boolean {
  const block = candidate.rect
  if (around.obstacles.some((o) => overlaps(block, o, OBSTACLE_MARGIN))) return false
  if (around.lines.some((line) => crosses(line, block, LINE_CLEARANCE))) return false
  return cells.every((cell) => {
    const line = lineOf(ap, cell)
    return !around.lineObstacles.some((o) => crosses(line, o, LINE_CLEARANCE))
  })
}

/**
 * Where an AP's block of `count` chips goes: the nearest clear spot below it,
 * else beside it on the side with more room, else above it, else on the other
 * side, each within `NEAR_GAP` of the AP; failing all four, the nearest clear
 * spot anywhere around it. Returns the chips' boxes.
 */
function placeBlock(ap: Rect, count: number, around: Surroundings, roomObstacles: Rect[]): Rect[] {
  const bandHeight = sizeOf(gridFor(count, 'right')).height
  const roomier = roomBeside(ap, 'right', bandHeight, roomObstacles) >= roomBeside(ap, 'left', bandHeight, roomObstacles) ? 'right' : 'left'
  const order: Side[] = ['below', roomier, 'above', roomier === 'right' ? 'left' : 'right']
  const firstClear = (candidates: Candidate[]): Rect[] | null => {
    for (const candidate of candidates) {
      const cells = cellsOf(candidate.rect, candidate.grid, count)
      if (isClear(ap, candidate, cells, around)) return cells
    }
    return null
  }
  for (const side of order) {
    const cells = firstClear(candidatesOn(ap, side, count, NEAR_GAP, 0, NEAR_STEP, 0))
    if (cells) return cells
  }
  const far = order
    .flatMap((side, rank) => candidatesOn(ap, side, count, FAR_GAP, FAR_SLIDE, FAR_STEP, rank * 40))
    .sort((a, b) => a.cost - b.cost || Math.abs(a.slide) - Math.abs(b.slide) || a.slide - b.slide)
  const cells = firstClear(far)
  if (cells) return cells
  // Nowhere clear at all: right under the AP, overlapping whatever is there.
  const grid = gridFor(count, 'below')
  return cellsOf(blockAt(ap, sizeOf(grid), 'below', 0, 0), grid, count)
}

/** The box around a set of chips. */
function boundsOfCells(cells: Rect[]): Rect {
  const x = Math.min(...cells.map((c) => c.x))
  const y = Math.min(...cells.map((c) => c.y))
  const right = Math.max(...cells.map((c) => c.x + c.width))
  const bottom = Math.max(...cells.map((c) => c.y + c.height))
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Lays the connected clients out around their access points. Deterministic:
 * APs in box-id order, each one's chips kept together as one block in the
 * nearest clear area around it (`placeBlock`: below first, then the roomier
 * side, then above), touching no box and no other AP's block, and with no
 * line of its own through a box. A client already on the map as a box gets a
 * line to that box instead of a chip. An AP with more than twelve chip-worthy
 * clients shows the eleven strongest and a "+N more" chip.
 */
export function buildWifiOverlay(
  mapLayout: MapLayout,
  index: LayoutIndex,
  clients: WifiClientSummary[],
): WifiOverlay {
  const rects = absoluteRects(mapLayout)
  const parentOf = new Map(mapLayout.placed.map((entry) => [entry.node.id, entry.parentId]))
  const apNodes = new Map<number, InfraNode>()
  for (const node of index.nodes.values()) {
    if (node.binding?.type === 'ap' && rects.has(node.id)) apNodes.set(node.binding.id, node)
  }
  const placed = placedDevices(index)

  const byMac = new Map<string, WifiClientSummary>()
  const perAp = new Map<number, WifiClientSummary[]>()
  let offMapCount = 0
  for (const client of clients) {
    const mac = client.mac.toLowerCase()
    if (byMac.has(mac)) continue
    byMac.set(mac, client)
    const ap = apNodes.get(client.apId)
    if (!ap) {
      offMapCount += 1
      continue
    }
    const list = perAp.get(ap.id) ?? []
    list.push(client)
    perAp.set(ap.id, list)
  }

  const chips: OverlayChip[] = []
  const edges: OverlayEdge[] = []
  const overflow = new Map<number, WifiClientSummary[]>()
  const onMap = new Map<string, InfraNode>()
  const hiddenOnMap = new Map<string, InfraNode>()
  const blocks: Rect[] = []
  const lines: Segment[] = []

  // Clients that are boxes on the map first: their lines are fixed, and no block may cover them.
  const wantingByAp = new Map<number, WifiClientSummary[]>()
  const apIds = [...perAp.keys()].sort((a, b) => a - b)
  for (const apNodeId of apIds) {
    const wanting: WifiClientSummary[] = []
    for (const client of perAp.get(apNodeId)!) {
      const mac = client.mac.toLowerCase()
      const box = placed.get(mac)
      if (box && rects.has(box.id)) {
        // Already on the map: a line from the AP to its box, no chip (A4.4).
        onMap.set(mac, box)
        if (box.id !== apNodeId) {
          edges.push({ id: `wifi-line:${mac}`, source: String(apNodeId), target: String(box.id), quality: client.signalQuality, variant: 'client' })
          lines.push(lineOf(rects.get(apNodeId)!, rects.get(box.id)!))
        }
        continue
      }
      if (box) hiddenOnMap.set(mac, box)
      wanting.push(client)
    }
    wantingByAp.set(apNodeId, wanting)
  }

  for (const apNodeId of apIds) {
    const apRect = rects.get(apNodeId)!
    const wanting = wantingByAp.get(apNodeId)!
    if (wanting.length === 0) continue

    let shown = wanting
    let rest: WifiClientSummary[] = []
    if (wanting.length > MAX_CLIENT_CHIPS) {
      const strongest = [...wanting].sort(byStrength)
      shown = strongest.slice(0, MAX_CLIENT_CHIPS - 1)
      rest = strongest.slice(MAX_CLIENT_CHIPS - 1)
      overflow.set(apNodeId, rest)
    }
    shown = [...shown].sort(byName)

    const count = shown.length + (rest.length > 0 ? 1 : 0)
    // The frames this AP sits in hold its lines; everything else is in the way.
    const frames = new Set<number>()
    for (let parent = parentOf.get(apNodeId) ?? null; parent !== null; parent = parentOf.get(parent) ?? null) frames.add(parent)
    const others = [...rects.entries()].filter(([id]) => id !== apNodeId && !frames.has(id)).map(([, rect]) => rect)
    const cells = placeBlock(
      apRect,
      count,
      { obstacles: [...rects.values(), ...blocks], lineObstacles: [...others, ...blocks], lines },
      [...others, ...blocks],
    )
    blocks.push(boundsOfCells(cells))
    for (const cellRect of cells) lines.push(lineOf(apRect, cellRect))
    // Relative to the AP: the chips are its children, so they move with it.
    const cell = (i: number) => ({ x: cells[i].x - apRect.x, y: cells[i].y - apRect.y })
    shown.forEach((client, i) => {
      const mac = client.mac.toLowerCase()
      const id = `wifi:${mac}`
      chips.push({
        id,
        variant: 'client',
        apNodeId,
        ...cell(i),
        mac,
        name: clientName(client),
        deviceType: client.deviceType ?? null,
        band: client.band,
        quality: client.signalQuality,
        count: 0,
      })
      edges.push({ id: `wifi-line:${mac}`, source: String(apNodeId), target: id, quality: client.signalQuality, variant: 'client' })
    })
    if (rest.length > 0) {
      const id = `wifi-more:${apNodeId}`
      chips.push({
        id,
        variant: 'more',
        apNodeId,
        ...cell(shown.length),
        mac: null,
        name: `+${rest.length} more`,
        deviceType: null,
        band: null,
        quality: null,
        count: rest.length,
      })
      edges.push({ id: `wifi-line-more:${apNodeId}`, source: String(apNodeId), target: id, quality: null, variant: 'more' })
    }
  }

  return { chips, edges, clients: byMac, overflow, onMap, hiddenOnMap, offMapCount }
}

/** The id of the invisible handle every box and chip carries for the wireless lines. */
export const WIFI_HANDLE_ID = 'wifi'

/**
 * That handle: never connectable, never hit, and at the top centre of the box,
 * away from the port sockets, so a cable being drawn never snaps to it. The
 * lines themselves run from box edge to box edge (`borderPoint`).
 */
export const WIFI_HANDLE_STYLE: CSSProperties = {
  opacity: 0,
  pointerEvents: 'none',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
}

/** Where the line from the centre of `rect` towards `toward` leaves it. */
export function borderPoint(rect: Rect, toward: Point): Point {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(dy),
  )
  return { x: cx + dx * scale, y: cy + dy * scale }
}
