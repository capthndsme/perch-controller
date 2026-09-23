import { useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import type { InfraSelection } from '@/components/infra/infra-canvas'
import { NodeIcon } from '@/components/infra/kind-icon'
import {
  describePort,
  LINK_MEDIUM_LABELS,
  linkStateText,
  nodeKindWord,
  nodeSummary,
  portLed,
  type LayoutIndex,
  type StateIndex,
} from '@/lib/infra'
import { cn } from '@/lib/utils'
import type { InfraLayoutResponse } from '@/types/api'

type InfraTableProps = {
  layout: InfraLayoutResponse
  index: LayoutIndex
  stateIndex: StateIndex
  onSelect: (selection: InfraSelection) => void
}

/**
 * §8.5 accessibility: everything on the map as two plain tables, collapsed by
 * default, so the content is reachable without the canvas.
 */
export function InfraTable({ layout, index, stateIndex, onSelect }: InfraTableProps) {
  const [open, setOpen] = useState(false)
  const nodes = [...layout.nodes].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <section className="card-surface" data-infra-table>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          {open ? <CaretDown aria-hidden className="size-3.5" /> : <CaretRight aria-hidden className="size-3.5" />}
          Devices and cables
        </span>
        <span className="text-xs text-muted-foreground">
          {layout.nodes.length} {layout.nodes.length === 1 ? 'device' : 'devices'} · {layout.links.length}{' '}
          {layout.links.length === 1 ? 'cable' : 'cables'}
        </span>
      </button>
      {open ? (
        <div className="space-y-4 border-t border-border pb-3">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[560px]">
              <caption className="sr-only">Devices on the map</caption>
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Ports with a link</th>
                  <th scope="col">Inside</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => {
                  const summary = nodeSummary(node, stateIndex.nodes.get(node.id), index.kinds)
                  const visible = node.ports.filter((port) => !port.hidden)
                  const up = visible.filter((port) => {
                    const led = portLed(port, stateIndex.ports.get(port.id))
                    return led === 'fast' || led === 'slow'
                  }).length
                  const parent = node.parentId !== null ? index.nodes.get(node.parentId) : undefined
                  return (
                    <tr
                      key={node.id}
                      data-clickable="true"
                      tabIndex={0}
                      onClick={() => onSelect({ type: 'node', id: node.id })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelect({ type: 'node', id: node.id })
                        }
                      }}
                    >
                      <td>
                        <span className="flex items-center gap-1.5">
                          <NodeIcon node={node} className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{node.name}</span>
                          {node.hidden ? <span className="text-[11px] text-muted-foreground">(hidden)</span> : null}
                        </span>
                      </td>
                      <td className="text-muted-foreground">{nodeKindWord(node, index.kinds)}</td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', summary.dotClass)} />
                          <span className="text-muted-foreground">{summary.subtitle}</span>
                        </span>
                      </td>
                      <td className="tabular-nums">{visible.length > 0 ? `${up} of ${visible.length}` : '—'}</td>
                      <td className="text-muted-foreground">{parent?.name ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            {layout.links.length === 0 ? (
              <p className="px-4 text-xs text-muted-foreground">No cables drawn yet.</p>
            ) : (
              <table className="data-table min-w-[560px]">
                <caption className="sr-only">Cables on the map</caption>
                <thead>
                  <tr>
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                    <th scope="col">Medium</th>
                    <th scope="col">State</th>
                    <th scope="col">Label</th>
                  </tr>
                </thead>
                <tbody>
                  {layout.links.map((link) => {
                    const state = stateIndex.links.get(link.id)
                    return (
                      <tr
                        key={link.id}
                        data-clickable="true"
                        tabIndex={0}
                        onClick={() => onSelect({ type: 'link', id: link.id })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onSelect({ type: 'link', id: link.id })
                          }
                        }}
                      >
                        <td>{describePort(index, link.a.portId)}</td>
                        <td>{describePort(index, link.b.portId)}</td>
                        <td className="text-muted-foreground">{LINK_MEDIUM_LABELS[link.medium]}</td>
                        <td className={state?.state === 'mismatch' ? 'font-medium text-status-critical' : undefined}>
                          {linkStateText(state)}
                        </td>
                        <td className="text-muted-foreground">{link.label ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
