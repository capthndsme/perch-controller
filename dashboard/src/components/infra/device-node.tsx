import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useInfraView } from '@/components/infra/infra-context'
import { PortStrip } from '@/components/infra/port-strip'
import { NodeIcon } from '@/components/infra/kind-icon'
import { nodeSummary, oldAgentHint, visiblePorts } from '@/lib/infra'
import { WIFI_HANDLE_ID, WIFI_HANDLE_STYLE } from '@/lib/infra-overlay'
import { cn } from '@/lib/utils'
import type { InfraNode } from '@/types/api'

export type DeviceNodeData = {
  node: InfraNode
  /** Fixed box width, shared with the auto-layout (`deviceNodeWidth`). */
  width: number
}

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>

function DeviceNodeComponent({ data, selected, isConnectable }: NodeProps<DeviceFlowNode>) {
  const view = useInfraView()
  const { node, width } = data
  const state = view.state.nodes.get(node.id)
  const { dotClass, subtitle } = nodeSummary(node, state, view.index.kinds)
  const ports = visiblePorts(node)
  const hint = ports.length === 0 ? oldAgentHint(node, state?.version) : null

  return (
    <div
      data-node-id={node.id}
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm transition-shadow',
        node.kind === 'isp' && 'rounded-[20px]',
        node.detached && 'border-dashed border-muted-foreground/60',
        selected && 'ring-2 ring-brand',
      )}
      style={{ width }}
    >
      {/* Where the Wi-Fi overlay's lines attach (an AP, or a client that is on the map). */}
      <Handle
        type="source"
        id={WIFI_HANDLE_ID}
        position={Position.Top}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
        style={WIFI_HANDLE_STYLE}
      />
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', dotClass)} />
          <NodeIcon node={node} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5" title={node.name}>
            {node.name}
          </span>
          {node.isRoot ? (
            <span className="shrink-0 rounded-sm border border-brand/40 bg-brand/10 px-1 text-[9px] font-semibold uppercase leading-4 tracking-wide text-brand">
              Gateway agent
            </span>
          ) : null}
        </div>
        <p className="truncate text-[11px] leading-4 text-muted-foreground" title={subtitle}>
          {subtitle}
        </p>
      </div>
      {ports.length > 0 ? (
        <div className="border-t border-border px-2.5 py-2">
          <PortStrip node={node} ports={ports} connectable={isConnectable} />
        </div>
      ) : hint ? (
        <div className="border-t border-border px-2.5 py-2 text-[10px] leading-[14px] text-muted-foreground">
          <p>{hint}</p>
          {view.editing ? (
            <button
              type="button"
              className="nodrag mt-1 font-medium text-brand underline-offset-2 hover:underline"
              onClick={(event) => {
                event.stopPropagation()
                view.onAddPorts(node.id)
              }}
            >
              Add ports
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const DeviceNode = memo(DeviceNodeComponent)
