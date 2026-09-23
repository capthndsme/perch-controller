import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Devices, DotsThree } from '@phosphor-icons/react'
import { useInfraOverlay } from '@/components/infra/infra-context'
import { deviceTypeMeta } from '@/lib/device-labels'
import {
  CLIENT_CHIP_HEIGHT,
  CLIENT_CHIP_WIDTH,
  WIFI_HANDLE_ID,
  WIFI_HANDLE_STYLE,
  type OverlayChip,
} from '@/lib/infra-overlay'
import { cn } from '@/lib/utils'
import { formatWifiBand, wifiSignalQualityDotClass, wifiSignalQualityLabel } from '@/lib/wifi'

export type ClientFlowNode = Node<OverlayChip, 'client'>

/**
 * One connected Wi-Fi client on the overlay (A4.4): type icon, name, band and
 * a signal dot, or an AP's "+N more". Not a map box: never selected, dragged,
 * cabled or saved; a click opens its details through the overlay context.
 */
function ClientNodeComponent({ data }: NodeProps<ClientFlowNode>) {
  const overlay = useInfraOverlay()
  const selected = overlay.selectedChipId === data.id
  const more = data.variant === 'more'
  const type = more ? null : deviceTypeMeta(data.deviceType)
  const Icon = more ? DotsThree : (type?.Icon ?? Devices)
  const band = formatWifiBand(data.band)
  const label = more
    ? `${data.count} more WiFi clients on this access point`
    : `${data.name}: WiFi client${type ? ` (${type.label})` : ''}, ${band}, ${wifiSignalQualityLabel(data.quality).toLowerCase()} signal`

  return (
    <div style={{ width: CLIENT_CHIP_WIDTH, height: CLIENT_CHIP_HEIGHT }} data-wifi-chip={data.id}>
      <Handle
        type="target"
        id={WIFI_HANDLE_ID}
        position={Position.Top}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
        style={WIFI_HANDLE_STYLE}
      />
      <button
        type="button"
        aria-label={label}
        title={more ? label : `${data.name} · ${band}`}
        onClick={(event) => {
          event.stopPropagation()
          if (more) overlay.onMoreClick(data.apNodeId)
          else if (data.mac) overlay.onClientClick(data.mac)
        }}
        className={cn(
          'nodrag flex h-full w-full cursor-pointer items-center gap-1.5 rounded-md border bg-card px-2 text-left text-card-foreground shadow-xs transition-shadow hover:border-foreground/30',
          more ? 'border-dashed border-muted-foreground/60' : 'border-border',
          selected && 'ring-2 ring-brand',
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium leading-4">{data.name}</span>
          {more ? (
            <span className="block truncate text-[10px] leading-[14px] text-muted-foreground">Show the rest</span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] leading-[14px] text-muted-foreground">
              <span
                aria-hidden
                className={cn('inline-block size-1.5 shrink-0 rounded-full', wifiSignalQualityDotClass(data.quality))}
              />
              {band}
            </span>
          )}
        </span>
      </button>
    </div>
  )
}

export const ClientNode = memo(ClientNodeComponent)
