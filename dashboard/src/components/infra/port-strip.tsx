import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position } from '@xyflow/react'
import { useInfraView } from '@/components/infra/infra-context'
import { formatDurationSince } from '@/lib/collectors'
import {
  describePort,
  ONE_ROW_MAX_PORTS,
  otherEnd,
  PORT_GAP,
  PORT_HEIGHT,
  PORT_MEDIUM_LABELS,
  PORT_ROLE_LABELS,
  PORT_WIDTH,
  portCellWidth,
  portDisplayName,
  portLed,
  portRectWidth,
  PORT_LED_CLASSES,
  portStateText,
  splitPortGroups,
  type LayoutIndex,
  type PortLed,
  type StateIndex,
} from '@/lib/infra'
import { cn } from '@/lib/utils'
import type { InfraNode, InfraPort } from '@/types/api'

/** The socket's outline says what kind of port it is. */
function socketClass(port: InfraPort, led: PortLed): string {
  if (led === 'missing') return 'border-dashed border-status-critical'
  if (port.medium === 'virtual') return 'border-dotted border-foreground/45'
  if (port.medium === 'wireless') return 'border-dashed border-foreground/45'
  if (port.medium === 'sfp') return 'border-foreground/45 rounded-[2px]'
  return 'border-foreground/30'
}

// The handle covers the whole socket: cables attach at its top or bottom edge,
// and in edit mode the socket itself is what you drag from and drop on.
const HANDLE_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  transform: 'none',
  border: 'none',
  borderRadius: 3,
  background: 'transparent',
}

type PortSocketProps = {
  node: InfraNode
  port: InfraPort
  handlePosition: Position
  connectable: boolean
  cellWidth: number
  showLabel: boolean
}

function PortSocket({ node, port, handlePosition, connectable, cellWidth, showLabel }: PortSocketProps) {
  const view = useInfraView()
  const state = view.state.ports.get(port.id)
  const led = portLed(port, state)
  const focused = view.focusedPortId === port.id
  // A4.1: a free port picked in edit mode offers to plug a device from Perch's list into it.
  const offerConnect = view.editing && focused && port.present && !port.hidden && !view.index.linkByPort.has(port.id)
  return (
    <div className="relative flex flex-col items-center" style={{ width: cellWidth }}>
      <div
        data-port-id={port.id}
        data-led={led}
        aria-label={`${port.label}: ${portStateText(port, state)}`}
        className={cn(
          'relative shrink-0 cursor-pointer rounded-[3px] border bg-muted/80',
          socketClass(port, led),
          focused && 'ring-2 ring-brand ring-offset-1 ring-offset-card',
        )}
        style={{ width: portRectWidth(port), height: PORT_HEIGHT }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return
          view.onPortHover(port.id, event.currentTarget.getBoundingClientRect())
        }}
        onPointerLeave={() => view.onPortHover(null)}
        onClick={() => view.onPortClick(node.id, port.id)}
      >
        <span
          aria-hidden
          className={cn('pointer-events-none absolute inset-x-[2px] top-[2px] h-[3px] rounded-full', PORT_LED_CLASSES[led])}
        />
        <Handle
          type="source"
          id={String(port.id)}
          position={handlePosition}
          isConnectable={connectable}
          isConnectableStart={connectable}
          isConnectableEnd={connectable}
          className="infra-port-handle [&.connectingto]:bg-brand/35 [&.connectionindicator]:cursor-crosshair [&.valid]:bg-status-good/40"
          style={HANDLE_STYLE}
        />
      </div>
      {showLabel ? (
        <span
          className={cn(
            'mt-[3px] max-w-full truncate font-mono text-[9px] leading-[11px]',
            led === 'missing' ? 'text-status-critical' : 'text-muted-foreground',
          )}
        >
          {port.label}
        </span>
      ) : null}
      {offerConnect ? (
        <button
          type="button"
          data-connect-port={port.id}
          aria-label={`Connect a device to ${portDisplayName(port)}…`}
          className={cn(
            'nodrag nopan absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-brand/50 bg-card px-2 text-[10px] font-medium leading-[18px] text-brand shadow-md hover:bg-brand/10',
            // Upper-row sockets of a two-row strip open upwards, clear of the lower row.
            handlePosition === Position.Top ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            view.onConnectDevice(node.id, port.id)
          }}
        >
          + Connect a device…
        </button>
      ) : null}
    </div>
  )
}

type PortGroupProps = {
  node: InfraNode
  ports: InfraPort[]
  twoRows: boolean
  connectable: boolean
  /** Host frames draw their NICs in the header: cables leave downwards. */
  singleRowPosition: Position
}

function PortGroup({ node, ports, twoRows, connectable, singleRowPosition }: PortGroupProps) {
  if (ports.length === 0) return null
  if (!twoRows) {
    return (
      <div className="flex items-start" style={{ gap: PORT_GAP }}>
        {ports.map((port) => (
          <PortSocket
            key={port.id}
            node={node}
            port={port}
            handlePosition={singleRowPosition}
            connectable={connectable}
            cellWidth={portCellWidth(port, false)}
            showLabel
          />
        ))}
      </div>
    )
  }
  // Two rows like a switch's front panel: odd ports on top, even ones below.
  const columns: InfraPort[][] = []
  for (let i = 0; i < ports.length; i += 2) columns.push(ports.slice(i, i + 2))
  return (
    <div className="flex items-start" style={{ gap: PORT_GAP }}>
      {columns.map((column) => (
        <div key={column[0].id} className="flex flex-col" style={{ gap: PORT_GAP, width: PORT_WIDTH }}>
          {column.map((port, row) => (
            <PortSocket
              key={port.id}
              node={node}
              port={port}
              handlePosition={row === 0 ? Position.Top : Position.Bottom}
              connectable={connectable}
              cellWidth={PORT_WIDTH}
              showLabel={false}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

type PortStripProps = {
  node: InfraNode
  /** Visible ports, in display order. */
  ports: InfraPort[]
  connectable: boolean
  singleRowPosition?: Position
}

/** §8.3: WAN ports first behind a caption and a separator, then the rest. */
export function PortStrip({ node, ports, connectable, singleRowPosition = Position.Bottom }: PortStripProps) {
  const twoRows = ports.length > ONE_ROW_MAX_PORTS
  const { wan, rest } = splitPortGroups(ports)
  return (
    <div className="flex items-start">
      {wan.length > 0 ? (
        <>
          <span
            className="w-6 shrink-0 text-[9px] font-semibold uppercase leading-[14px] tracking-wide text-muted-foreground"
            title="WAN ports: the sockets marked WAN on the case"
          >
            WAN
          </span>
          <PortGroup
            node={node}
            ports={wan}
            twoRows={twoRows}
            connectable={connectable}
            singleRowPosition={singleRowPosition}
          />
          {rest.length > 0 ? <span aria-hidden className="mx-[6px] w-px self-stretch bg-border" /> : null}
        </>
      ) : null}
      <PortGroup
        node={node}
        ports={rest}
        twoRows={twoRows}
        connectable={connectable}
        singleRowPosition={singleRowPosition}
      />
    </div>
  )
}

// ── Tooltip ──────────────────────────────────────────────────────────────

type PortTooltipProps = {
  portId: number
  anchor: DOMRect
  index: LayoutIndex
  state: StateIndex
}

/** One floating card for whichever port the pointer is on (one per canvas, not one per port). */
export function PortTooltip({ portId, anchor, index, state }: PortTooltipProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)
  const port = index.ports.get(portId)

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const margin = 8
    let left = anchor.left + anchor.width / 2 - box.width / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin))
    let top = anchor.top - box.height - margin
    if (top < margin) top = anchor.bottom + margin
    setPlacement({ left, top })
  }, [anchor, portId])

  if (!port) return null
  const portState = state.ports.get(port.id)
  const led = portLed(port, portState)
  const link = index.linkByPort.get(port.id)
  const facts = [
    port.role ? PORT_ROLE_LABELS[port.role] : null,
    port.medium ? PORT_MEDIUM_LABELS[port.medium] : null,
    port.origin === 'manual' ? 'added by hand' : null,
  ].filter(Boolean)
  const since = formatDurationSince(portState?.changedAt)
  const stateWord = led === 'fast' || led === 'slow' ? 'up' : led === 'down' ? 'down' : null
  const history = [
    portState?.carrierChanges !== null && portState?.carrierChanges !== undefined
      ? `${portState.carrierChanges} carrier ${portState.carrierChanges === 1 ? 'change' : 'changes'}`
      : null,
    since && stateWord ? (since === 'just now' ? 'changed just now' : `${stateWord} for ${since}`) : null,
  ].filter(Boolean)

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[60] max-w-64 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] leading-4 text-popover-foreground shadow-lg"
      style={{ left: placement?.left ?? -9999, top: placement?.top ?? -9999 }}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <span aria-hidden className={cn('inline-block h-[5px] w-3 shrink-0 rounded-full', PORT_LED_CLASSES[led])} />
        <span className="font-mono">{port.key}</span>
        {port.label !== port.key ? <span className="truncate text-muted-foreground">· {port.label}</span> : null}
      </p>
      <p className={led === 'missing' ? 'text-status-critical' : undefined}>{portStateText(port, portState)}</p>
      <p className="text-muted-foreground">
        {link ? `→ ${describePort(index, otherEnd(link, port.id).portId)}` : 'No cable'}
      </p>
      {facts.length > 0 ? <p className="text-muted-foreground">{facts.join(' · ')}</p> : null}
      {history.length > 0 ? <p className="text-muted-foreground">{history.join(' · ')}</p> : null}
    </div>,
    document.body,
  )
}
