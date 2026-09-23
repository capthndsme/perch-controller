import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { CheckCircle, EyeSlash, MagicWand, TreeStructure, WarningCircle, WifiHigh, X } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { AddDeviceMenu } from '@/components/infra/add-device-menu'
import {
  InfraCanvas,
  type InfraCanvasApi,
  type InfraNotice,
  type InfraSelection,
} from '@/components/infra/infra-canvas'
import { InfraLegend } from '@/components/infra/infra-legend'
import { InfraTable } from '@/components/infra/infra-table'
import { NodeIcon } from '@/components/infra/kind-icon'
import { InfraInspector } from '@/components/infra/node-inspector'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import {
  infraLayoutQueryKey,
  useInfraLayout,
  useInfraState,
  useInfraWifiClients,
  useSaveInfraPositions,
  useUpdateInfraNode,
} from '@/hooks/use-infra'
import { useIsDark, useMediaQuery } from '@/hooks/use-media-query'
import {
  buildLayoutIndex,
  buildStateIndex,
  computeMapLayout,
  infraErrorMessage,
  nodeKindWord,
  placedDevices,
  type LayoutIndex,
} from '@/lib/infra'
import { buildWifiOverlay, type WifiOverlay } from '@/lib/infra-overlay'
import { cn } from '@/lib/utils'
import type { InfraLayoutResponse, InfraNode, InfraNodeKind } from '@/types/api'

const CANVAS_HEIGHT_WIDE = 'h-[min(72svh,860px)] min-h-[480px]'
const CANVAS_HEIGHT_PHONE = 'h-[62svh] min-h-[340px]'

/** The WiFi clients overlay is remembered per browser (A4.4); storage may be unavailable. */
const WIFI_OVERLAY_KEY = 'perch-infra-wifi-clients'

function readOverlayPreference(): boolean {
  try {
    return localStorage.getItem(WIFI_OVERLAY_KEY) === '1'
  } catch {
    return false
  }
}

function writeOverlayPreference(on: boolean) {
  try {
    localStorage.setItem(WIFI_OVERLAY_KEY, on ? '1' : '0')
  } catch {
    // Per-viewer convenience only: without storage it lasts for this visit.
  }
}

/** `?node=12` (A4.3): the box to select and centre. */
function parseNodeParam(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

type NoticeHandler = (notice: InfraNotice | null) => void

/** "Hidden (n)": devices kept off the map, with a way back. */
function HiddenMenu({ nodes, index, onNotice }: { nodes: InfraNode[]; index: LayoutIndex; onNotice: NoticeHandler }) {
  const update = useUpdateInfraNode()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={nodes.length === 0}>
          <EyeSlash />
          Hidden ({nodes.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <p className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">Kept off the map; nothing else changes.</p>
        {nodes.map((node) => {
          const inside = [...index.nodes.values()].filter((other) => other.parentId === node.id).length
          return (
            <div key={node.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <NodeIcon node={node} className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate">{node.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {nodeKindWord(node, index.kinds)}
                    {inside > 0 ? `, ${inside} inside` : ''}
                  </span>
                </span>
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate(
                    { id: node.id, payload: { hidden: false } },
                    {
                      onSuccess: () => {
                        onNotice({ tone: 'info', text: `${node.name} is back on the map.` })
                        if (nodes.length <= 1) setOpen(false)
                      },
                      onError: (error) =>
                        onNotice({ tone: 'error', text: infraErrorMessage(error, index, 'Could not show it.') }),
                    },
                  )
                }
              >
                Show
              </Button>
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/** Auto-arrange: lay the whole map out with dagre, then `PUT /positions`. The Wi-Fi overlay is not part of it. */
function ArrangeButton({
  layout,
  index,
  onArranged,
  onNotice,
}: {
  layout: InfraLayoutResponse
  index: LayoutIndex
  onArranged: () => void
  onNotice: NoticeHandler
}) {
  const save = useSaveInfraPositions()
  const [open, setOpen] = useState(false)

  async function run() {
    const arranged = computeMapLayout(layout, index, { arrangeAll: true })
    const entries = arranged.placed.map((entry) => ({
      nodeId: entry.node.id,
      x: Math.round(entry.position.x),
      y: Math.round(entry.position.y),
      parentId: entry.parentId,
    }))
    if (entries.length === 0) return
    try {
      for (let i = 0; i < entries.length; i += 200) {
        await save.mutateAsync(entries.slice(i, i + 200))
      }
      setOpen(false)
      onNotice({ tone: 'info', text: `Arranged ${entries.length} ${entries.length === 1 ? 'device' : 'devices'}.` })
      onArranged()
    } catch (error) {
      setOpen(false)
      onNotice({ tone: 'error', text: infraErrorMessage(error, index, 'Could not save the arrangement.') })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <MagicWand />
          Auto-arrange
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2">
        <p className="text-xs">
          Lay every device on the map out as a tree, top to bottom, following the cables. This moves the ones you
          placed by hand too.
        </p>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="xs" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="xs" disabled={save.isPending} onClick={() => void run()}>
            {save.isPending ? 'Arranging…' : 'Arrange'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** One line for the legend's WiFi section: how many clients the overlay shows, and how. */
function overlaySummary(overlay: WifiOverlay): string {
  const total = overlay.clients.size
  if (total === 0) return 'No WiFi client is connected right now.'
  const parts = [`${total} connected`]
  if (overlay.onMap.size > 0) parts.push(`${overlay.onMap.size} with a box of their own`)
  if (overlay.offMapCount > 0) {
    parts.push(`${overlay.offMapCount} on access points the map does not show`)
  }
  return `${parts.join(', ')}.`
}

/**
 * `/infrastructure` (docs/infrastructure-view.md §8, A4): the network map.
 * Everyone sees the agents, their ports and the cables with live link state,
 * and can lay the connected Wi-Fi clients over it; an admin at `md` width and
 * up can switch to Edit and draw the rest, including plugging a device Perch
 * knows into a port in one step.
 */
export function InfrastructurePage() {
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const wide = useMediaQuery('(min-width: 768px)')
  const isDark = useIsDark()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const nodeParam = parseNodeParam(searchParams.get('node'))
  const [editWanted, setEditWanted] = useState(false)
  const canEdit = isAdmin && wide
  const editing = editWanted && canEdit
  const [interacting, setInteracting] = useState(false)
  const [overlayOn, setOverlayOn] = useState(readOverlayPreference)
  const layout = useInfraLayout({ paused: interacting })
  const state = useInfraState({ paused: interacting, enabled: layout.isSuccess })
  const wifiClients = useInfraWifiClients({ enabled: overlayOn && layout.isSuccess, paused: interacting })
  const [selection, setSelection] = useState<InfraSelection | null>(() =>
    nodeParam !== null ? { type: 'node', id: nodeParam } : null,
  )
  const [notice, setNotice] = useState<InfraNotice | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<InfraNodeKind | null>(null)
  const [addPortsNodeId, setAddPortsNodeId] = useState<number | null>(null)
  const [connectPortId, setConnectPortId] = useState<number | null>(null)
  const canvasApi = useRef<InfraCanvasApi | null>(null)
  const healedFor = useRef<string | null>(null)

  // A link within the app names another box (`?node=`): select that one too.
  const [seenNodeParam, setSeenNodeParam] = useState(nodeParam)
  if (nodeParam !== seenNodeParam) {
    setSeenNodeParam(nodeParam)
    if (nodeParam !== null) setSelection({ type: 'node', id: nodeParam })
  }

  // Both bodies carry a fresh `generatedAt` on every poll (A3). Key everything on
  // the parts that describe the map, which TanStack Query keeps referentially
  // equal while they are unchanged, so an identical poll rebuilds nothing.
  const nodesData = layout.data?.nodes
  const linksData = layout.data?.links
  const kindsData = layout.data?.kinds
  const limitsData = layout.data?.limits
  const rootNodeId = layout.data?.rootNodeId ?? null
  const structure = useMemo<InfraLayoutResponse | null>(
    () =>
      nodesData && linksData && kindsData && limitsData
        ? { generatedAt: '', rootNodeId, nodes: nodesData, links: linksData, kinds: kindsData, limits: limitsData }
        : null,
    [nodesData, linksData, kindsData, limitsData, rootNodeId],
  )
  const index = useMemo(() => (structure ? buildLayoutIndex(structure) : null), [structure])
  const mapLayout = useMemo(
    () => (structure && index ? computeMapLayout(structure, index) : null),
    [structure, index],
  )
  const stateNodes = state.data?.nodes
  const statePorts = state.data?.ports
  const stateLinks = state.data?.links
  const stateIndex = useMemo(
    () =>
      buildStateIndex(
        stateNodes && statePorts && stateLinks
          ? { generatedAt: '', nodes: stateNodes, ports: statePorts, links: stateLinks }
          : undefined,
      ),
    [stateNodes, statePorts, stateLinks],
  )
  // A4.4: the overlay joins the Wi-Fi poll to the drawn map; only while it is on.
  const clientRows = overlayOn ? wifiClients.data : undefined
  const overlay = useMemo(
    () => (clientRows && mapLayout && index ? buildWifiOverlay(mapLayout, index, clientRows) : null),
    [clientRows, mapLayout, index],
  )
  const placed = useMemo(() => (index ? placedDevices(index) : new Map<string, InfraNode>()), [index])

  // `?node=` names a box that is not drawn: say why, once the map is loaded.
  const [checkedNodeParam, setCheckedNodeParam] = useState<number | null>(null)
  if (index && mapLayout && nodeParam !== null && checkedNodeParam !== nodeParam) {
    setCheckedNodeParam(nodeParam)
    const target = index.nodes.get(nodeParam)
    if (!target) {
      setNotice({ tone: 'error', text: 'That device is not on the map (any more).' })
    } else if (mapLayout.hiddenNodes.some((hidden) => hidden.id === nodeParam)) {
      setNotice({ tone: 'info', text: `${target.name} is hidden from the map; its details are open on the side.` })
    }
  }

  // Info notices fade on their own; errors stay until dismissed or replaced.
  useEffect(() => {
    if (notice?.tone !== 'info') return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // The state names a port or node the layout lacks (an agent grew a port
  // between layout polls): reload the layout, once for each such set of ids.
  useEffect(() => {
    if (!index || !statePorts || !stateNodes) return
    const unknown = [
      ...statePorts.filter((port) => !index.ports.has(port.id)).map((port) => `p${port.id}`),
      ...stateNodes.filter((node) => !index.nodes.has(node.id)).map((node) => `n${node.id}`),
    ].join(',')
    if (!unknown || healedFor.current === unknown) return
    healedFor.current = unknown
    void queryClient.invalidateQueries({ queryKey: infraLayoutQueryKey })
  }, [index, statePorts, stateNodes, queryClient])

  // A selection whose device or cable went away (deleted, or a refetch dropped it) shows nothing;
  // a Wi-Fi client's only while the overlay is on.
  let activeSelection: InfraSelection | null = null
  if (selection && index) {
    if (selection.type === 'node') activeSelection = index.nodes.has(selection.id) ? selection : null
    else if (selection.type === 'link') activeSelection = index.links.has(selection.id) ? selection : null
    else activeSelection = overlay ? selection : null
  }

  function setMode(next: 'view' | 'edit') {
    setEditWanted(next === 'edit')
    if (next === 'view') {
      // Leaving edit mode closes the edit-only surfaces.
      setAddOpen(false)
      setAddKind(null)
      setAddPortsNodeId(null)
      setConnectPortId(null)
    }
  }

  function toggleOverlay() {
    const next = !overlayOn
    setOverlayOn(next)
    writeOverlayPreference(next)
  }

  const onNotice = useCallback((next: InfraNotice | null) => setNotice(next), [])
  const onAddPorts = useCallback((nodeId: number) => {
    setSelection({ type: 'node', id: nodeId })
    setConnectPortId(null)
    setAddPortsNodeId(nodeId)
  }, [])
  // Anything else picked on the map or in the panel closes an open "Connect a device…".
  const onSelect = useCallback((next: InfraSelection | null) => {
    setSelection(next)
    setConnectPortId(null)
  }, [])
  const onConnectDevice = useCallback((nodeId: number, portId: number) => {
    setSelection({ type: 'node', id: nodeId, portId })
    setConnectPortId(portId)
  }, [])
  const dropPosition = useCallback(() => canvasApi.current?.dropPosition() ?? null, [])
  const outsideFrame = useCallback((nodeId: number) => canvasApi.current?.outsideFrame(nodeId) ?? null, [])
  const spotNear = useCallback(
    (nodeId: number, portId: number | null) => canvasApi.current?.spotNear(nodeId, portId) ?? null,
    [],
  )

  const hosts = useMemo(() => (nodesData ?? []).filter((node) => node.kind === 'host'), [nodesData])
  const hiddenNodes = useMemo(() => (nodesData ?? []).filter((node) => node.hidden), [nodesData])
  const atNodeLimit = structure ? structure.nodes.length >= structure.limits.nodes : false

  function addSwitch() {
    setEditWanted(true)
    setAddKind('switch')
    setAddOpen(true)
  }

  const actions = (
    <>
      {structure && structure.nodes.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant={overlayOn ? 'secondary' : 'outline'}
          aria-pressed={overlayOn}
          title="Show which WiFi devices are connected to which access point"
          onClick={toggleOverlay}
          data-wifi-toggle
        >
          <WifiHigh />
          WiFi clients
        </Button>
      ) : null}
      {editing && structure && index ? (
        <>
          <HiddenMenu nodes={hiddenNodes} index={index} onNotice={onNotice} />
          <ArrangeButton
            layout={structure}
            index={index}
            onNotice={onNotice}
            onArranged={() => window.requestAnimationFrame(() => canvasApi.current?.fitView())}
          />
          <AddDeviceMenu
            kinds={structure.kinds}
            hosts={hosts}
            index={index}
            placed={placed}
            open={addOpen}
            onOpenChange={setAddOpen}
            kind={addKind}
            onKindChange={setAddKind}
            dropPosition={dropPosition}
            onNotice={onNotice}
            disabledReason={atNodeLimit ? `The map holds at most ${structure.limits.nodes} devices.` : null}
            onCreated={(node) => {
              setNotice({ tone: 'info', text: `Added ${node.name}.` })
              onSelect({ type: 'node', id: node.id })
            }}
          />
        </>
      ) : null}
      {canEdit ? (
        <Segmented
          ariaLabel="Map mode"
          value={editing ? 'edit' : 'view'}
          onChange={setMode}
          options={[
            { id: 'view', label: 'View' },
            { id: 'edit', label: 'Edit', title: 'Move devices, draw cables, add what Perch cannot see' },
          ]}
        />
      ) : null}
    </>
  )

  let body: React.ReactNode
  if (layout.isPending) {
    // The map is the page: the spinner holds the canvas's box so nothing jumps when it arrives.
    body = <PageSpinner label="Loading the map" className={cn('py-0', wide ? CANVAS_HEIGHT_WIDE : CANVAS_HEIGHT_PHONE)} />
  } else if (!structure || !index || !mapLayout) {
    body = (
      <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
        <WarningCircle className="size-4 text-destructive" />
        <AlertDescription>
          <p className="font-medium text-foreground">Could not load the map</p>
          <p>{layout.error?.message ?? 'The controller did not answer.'}</p>
        </AlertDescription>
      </Alert>
    )
  } else if (structure.nodes.length === 0) {
    body = (
      <EmptyState
        icon={<TreeStructure className="size-6" />}
        title="Nothing to map yet"
        className="py-12"
        description={
          <>
            Adopt a collector on your router (it becomes the Gateway agent) and join your access points; they show up
            here by themselves.
            {isAdmin ? (
              <span className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                <Link to="/settings/collectors" className="text-brand underline-offset-2 hover:underline">
                  Settings → Collectors
                </Link>
                <Link to="/settings/wifi-sources" className="text-brand underline-offset-2 hover:underline">
                  Settings → Wi-Fi sources
                </Link>
                {wide ? (
                  <button type="button" className="text-brand underline-offset-2 hover:underline" onClick={addSwitch}>
                    or add a switch
                  </button>
                ) : null}
              </span>
            ) : (
              ' Ask an admin to set them up.'
            )}
          </>
        }
      />
    )
  } else if (mapLayout.placed.length === 0) {
    body = (
      <EmptyState
        icon={<EyeSlash className="size-6" />}
        title="Everything on the map is hidden"
        className="py-12"
        description={
          editing
            ? 'Bring devices back from Hidden in the header.'
            : canEdit
              ? 'Switch to Edit and bring them back from Hidden.'
              : 'An admin has hidden every device on the map.'
        }
      />
    )
  } else {
    const inspector =
      activeSelection ? (
        <InfraInspector
          selection={activeSelection}
          layout={structure}
          index={index}
          stateIndex={stateIndex}
          editing={editing}
          isAdmin={isAdmin}
          addPortsNodeId={addPortsNodeId}
          onAddPortsNodeIdChange={setAddPortsNodeId}
          connectPortId={connectPortId}
          onConnectPortIdChange={setConnectPortId}
          overlay={overlay}
          onSelect={onSelect}
          onNotice={onNotice}
          outsideFrame={outsideFrame}
          spotNear={spotNear}
        />
      ) : null
    body = (
      <>
        <div className="flex gap-3">
          <div
            className={cn(
              'relative min-w-0 flex-1 overflow-hidden rounded-lg border border-border',
              wide ? CANVAS_HEIGHT_WIDE : CANVAS_HEIGHT_PHONE,
              editing && 'border-brand/40',
            )}
            data-infra-canvas
          >
            <ReactFlowProvider>
              <InfraCanvas
                layout={structure}
                index={index}
                stateIndex={stateIndex}
                mapLayout={mapLayout}
                overlay={overlay}
                editing={editing}
                isDark={isDark}
                selection={activeSelection}
                onSelect={onSelect}
                onInteractingChange={setInteracting}
                onNotice={onNotice}
                onAddPorts={onAddPorts}
                onConnectDevice={onConnectDevice}
                focusNodeId={nodeParam}
                apiRef={canvasApi}
              />
            </ReactFlowProvider>
          </div>
          {wide && inspector ? (
            <aside
              aria-label="Details"
              className={cn('card-surface w-80 shrink-0 overflow-y-auto lg:w-96', CANVAS_HEIGHT_WIDE)}
            >
              {inspector}
            </aside>
          ) : null}
        </div>
        {!wide && inspector ? (
          <>
            <button
              type="button"
              aria-label="Close details"
              className="fixed inset-0 z-40 bg-black/30"
              onClick={() => onSelect(null)}
            />
            <div
              role="dialog"
              aria-label="Details"
              className="fixed inset-x-0 bottom-0 z-50 max-h-[75svh] overflow-y-auto rounded-t-2xl border-t border-border bg-card shadow-2xl"
            >
              <div className="flex justify-center pt-2" aria-hidden>
                <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
              </div>
              {inspector}
            </div>
          </>
        ) : null}
        <InfraLegend wifi={overlay ? { summary: overlaySummary(overlay) } : null} />
        <InfraTable layout={structure} index={index} stateIndex={stateIndex} onSelect={onSelect} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Infrastructure"
        description="The Gateway agent, your access points and what you draw: their Ethernet ports with live link state, and the cables between them."
        actions={actions}
      />
      {editing ? (
        <p className="text-xs text-muted-foreground" data-edit-hint>
          Drag a device to move it. Drag from one port to another to draw a cable, or pick a free port to connect a
          device Perch knows. Select a cable to drag one of its ends to another port, or press Delete to remove it.
        </p>
      ) : null}
      {layout.error && structure ? (
        <p className="flex items-center gap-1.5 text-xs text-status-warning" data-layout-warning>
          <WarningCircle aria-hidden className="size-3.5 shrink-0" />
          The map could not be refreshed ({layout.error.message}); showing the last one that loaded.
        </p>
      ) : null}
      {state.error && structure ? (
        <p className="flex items-center gap-1.5 text-xs text-status-warning" data-state-warning>
          <WarningCircle aria-hidden className="size-3.5 shrink-0" />
          Live state is unavailable ({state.error.message}); the port lights show the last state that loaded.
        </p>
      ) : null}
      {overlayOn && wifiClients.error && structure ? (
        <p className="flex items-center gap-1.5 text-xs text-status-warning" data-wifi-warning>
          <WarningCircle aria-hidden className="size-3.5 shrink-0" />
          WiFi clients are unavailable ({wifiClients.error.message})
          {overlay ? '; showing the last list that loaded.' : '.'}
        </p>
      ) : null}
      {notice ? (
        <Alert
          className={cn(
            'rounded-lg',
            notice.tone === 'error' ? 'border-destructive/30 bg-destructive/5' : 'border-primary/20 bg-primary/5',
          )}
          data-notice={notice.tone}
        >
          {notice.tone === 'error' ? (
            <WarningCircle className="size-4 text-destructive" />
          ) : (
            <CheckCircle className="size-4 text-primary" />
          )}
          <AlertDescription className={notice.tone === 'error' ? 'text-destructive' : 'text-foreground'}>
            {notice.text}
          </AlertDescription>
          <AlertAction>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <X />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {body}
    </div>
  )
}
