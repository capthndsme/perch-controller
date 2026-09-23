import { memo } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import { useInfraView } from '@/components/infra/infra-context'
import { PortStrip } from '@/components/infra/port-strip'
import { NodeIcon } from '@/components/infra/kind-icon'
import { HOST_HEADER_HEIGHT, nodeSummary, visiblePorts } from '@/lib/infra'
import { WIFI_HANDLE_ID, WIFI_HANDLE_STYLE } from '@/lib/infra-overlay'
import { cn } from '@/lib/utils'
import type { InfraNode } from '@/types/api'

export type HostNodeData = {
  node: InfraNode
}

export type HostFlowNode = Node<HostNodeData, 'host'>

/**
 * A server or hypervisor drawn as a labelled frame; the nodes inside it (a
 * gateway container, its bridges) are React Flow children with
 * `extent: 'parent'`. Its own NICs sit in the header.
 */
function HostNodeComponent({ data, selected, isConnectable }: NodeProps<HostFlowNode>) {
  const view = useInfraView()
  const { node } = data
  const { dotClass, subtitle } = nodeSummary(node, view.state.nodes.get(node.id), view.index.kinds)
  const ports = visiblePorts(node)

  return (
    <>
      {view.editing ? (
        <NodeResizer
          isVisible={selected}
          minWidth={240}
          minHeight={140}
          lineClassName="!border-brand"
          handleClassName="!size-2.5 !rounded-sm !border-card !bg-brand"
          onResizeStart={() => view.onFrameResizeStart()}
          onResizeEnd={(_event, params) =>
            view.onFrameResizeEnd(node.id, {
              x: params.x,
              y: params.y,
              width: params.width,
              height: params.height,
            })
          }
        />
      ) : null}
      <div
        data-node-id={node.id}
        className={cn(
          'flex h-full w-full flex-col rounded-xl border border-border bg-muted/30',
          node.virtual && 'border-dashed',
          node.detached && 'border-dashed border-muted-foreground/60',
          selected && 'ring-2 ring-brand',
        )}
      >
        {/* A host bound to a device that is also a Wi-Fi client: where the overlay's line attaches. */}
        <Handle
          type="source"
          id={WIFI_HANDLE_ID}
          position={Position.Top}
          isConnectable={false}
          isConnectableStart={false}
          isConnectableEnd={false}
          style={WIFI_HANDLE_STYLE}
        />
        <div
          className="flex shrink-0 items-center gap-3 border-b border-border/70 px-3"
          style={{ height: HOST_HEADER_HEIGHT }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', dotClass)} />
              <NodeIcon node={node} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-[13px] font-medium leading-5" title={node.name}>
                {node.name}
              </span>
            </div>
            <p className="truncate text-[11px] leading-4 text-muted-foreground" title={subtitle}>
              {subtitle}
            </p>
          </div>
          {ports.length > 0 ? (
            <div className="shrink-0">
              <PortStrip
                node={node}
                ports={ports}
                connectable={isConnectable}
                singleRowPosition={Position.Bottom}
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

export const HostNode = memo(HostNodeComponent)
