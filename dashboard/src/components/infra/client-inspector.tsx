import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowSquareOut, Devices, MapPin } from '@phosphor-icons/react'
import { Fact } from '@/components/collectors/fact'
import { DeviceSummary } from '@/components/infra/device-summary'
import { CloseButton, FieldError, Section } from '@/components/infra/inspector-parts'
import type { InspectorProps } from '@/components/infra/node-inspector'
import { Button } from '@/components/ui/button'
import { useCreateInfraNode } from '@/hooks/use-infra'
import { deviceTypeMeta } from '@/lib/device-labels'
import { infraErrorMessage, placedRefusalNodeId, type LayoutIndex } from '@/lib/infra'
import { clientName, type WifiOverlay } from '@/lib/infra-overlay'
import { cn } from '@/lib/utils'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass, wifiSignalQualityLabel } from '@/lib/wifi'
import type { InfraNode, WifiClientSummary } from '@/types/api'

type OverlayInspectorProps = InspectorProps & { overlay: WifiOverlay }

/** "866.7 Mb/s" from the AP's kbit/s, or a dash. */
function formatPhyRate(kbps: number | null): string {
  if (kbps === null || !Number.isFinite(kbps) || kbps <= 0) return '—'
  return `${Number((kbps / 1000).toFixed(1))} Mb/s`
}

/** How long the AP has not heard from it: "active just now", "40 s", "3 min". */
function formatIdle(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const seconds = ms / 1000
  if (seconds < 10) return 'active just now'
  if (seconds < 90) return `${Math.round(seconds)} s`
  return `${Math.round(seconds / 60)} min`
}

function apNodeFor(index: LayoutIndex, apId: number): InfraNode | undefined {
  for (const node of index.nodes.values()) {
    if (node.binding?.type === 'ap' && node.binding.id === apId) return node
  }
  return undefined
}

function Gone({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2 p-4 text-xs text-muted-foreground" data-inspector="client">
      {text}
      <CloseButton onClose={onClose} />
    </div>
  )
}

/** Details for a chip of the Wi-Fi overlay (A4.4): one client, or an AP's "+N more". */
export function ClientInspector(props: InspectorProps) {
  const { selection, overlay, onSelect } = props
  if (!overlay) return null
  if (selection.type === 'clients') return <MoreClients {...props} overlay={overlay} apNodeId={selection.apNodeId} />
  if (selection.type !== 'client') return null
  const client = overlay.clients.get(selection.mac)
  if (!client) return <Gone text="This client is no longer connected." onClose={() => onSelect(null)} />
  return <ClientDetails {...props} overlay={overlay} client={client} />
}

function ClientDetails({ client, overlay, index, editing, spotNear, onSelect, onNotice }: OverlayInspectorProps & { client: WifiClientSummary }) {
  const create = useCreateInfraNode()
  const [refusal, setRefusal] = useState<unknown>(null)
  const mac = client.mac.toLowerCase()
  const name = clientName(client)
  const type = deviceTypeMeta(client.deviceType)
  const Icon = type?.Icon ?? Devices
  const apNode = apNodeFor(index, client.apId)
  const box = overlay.onMap.get(mac) ?? null
  const hiddenBox = overlay.hiddenOnMap.get(mac) ?? null
  const overflowOf = apNode && (overlay.overflow.get(apNode.id) ?? []).some((other) => other.mac.toLowerCase() === mac) ? apNode : null
  const holderId = placedRefusalNodeId(refusal)
  // Named once the layout refetch that follows the refusal has the box.
  const holderName = holderId !== null ? index.nodes.get(holderId)?.name : undefined
  const idle = formatIdle(client.inactiveMs)

  function putOnMap() {
    setRefusal(null)
    // A box bound to this client next to its AP, no cable and no name, so it follows the device (A4.4).
    const at = apNode ? spotNear(apNode.id, null) : null
    create.mutate(
      { kind: 'device', deviceMac: mac, ...(at ? { position: at } : {}) },
      {
        onSuccess: ({ node }) => {
          onNotice({ tone: 'info', text: `Put ${node.name} on the map${apNode ? `, next to ${apNode.name}` : ''}.` })
          onSelect({ type: 'node', id: node.id })
        },
        onError: (cause) => setRefusal(cause),
      },
    )
  }

  return (
    <div className="flex flex-col pb-2" data-inspector="client">
      <header className="flex items-start gap-2 px-4 pt-3 pb-3">
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="truncate text-sm font-semibold" title={name}>
            {name}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', wifiSignalQualityDotClass(client.signalQuality))} />
            <span>Connected · WiFi{client.ssid ? ` · ${client.ssid}` : ''}</span>
          </p>
          <p className="text-xs text-muted-foreground">{type ? `${type.label} · WiFi client` : 'WiFi client'}</p>
        </div>
        <CloseButton onClose={() => onSelect(null)} />
      </header>

      {overflowOf ? (
        <div className="px-4 pb-2">
          <Button type="button" size="xs" variant="ghost" onClick={() => onSelect({ type: 'clients', apNodeId: overflowOf.id })}>
            <ArrowLeft />
            The other clients of {overflowOf.name}
          </Button>
        </div>
      ) : null}

      <DeviceSummary mac={mac} onWifi />

      <Section title="WiFi">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Fact label="SSID">{client.ssid ?? 'Unknown'}</Fact>
          <Fact label="Band">{formatWifiBand(client.band)}</Fact>
          <Fact label="Signal">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn('inline-block size-2 rounded-full', wifiSignalQualityDotClass(client.signalQuality))} />
              {formatSignal(client.signalDbm)} · {wifiSignalQualityLabel(client.signalQuality)}
            </span>
          </Fact>
          {client.snrDb !== null ? <Fact label="SNR">{Math.round(client.snrDb)} dB</Fact> : null}
          <Fact label="PHY rate (tx / rx)">
            {formatPhyRate(client.txRateKbps)} / {formatPhyRate(client.rxRateKbps)}
          </Fact>
          <Fact label="Access point">
            {client.ap}
            {client.ifname ? <span className="text-muted-foreground"> · {client.ifname}</span> : null}
          </Fact>
          <Fact label="MAC" mono>
            {mac}
          </Fact>
          {client.hostname && client.hostname !== name ? <Fact label="Hostname">{client.hostname}</Fact> : null}
          {idle ? <Fact label="Idle">{idle}</Fact> : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
          <Link
            to={`/wifi/clients/${encodeURIComponent(mac)}`}
            className="inline-flex items-center gap-1 text-xs text-brand underline-offset-2 hover:underline"
          >
            WiFi client page
            <ArrowSquareOut aria-hidden className="size-3" />
          </Link>
          <Link
            to={`/wifi/aps/${client.apId}`}
            className="inline-flex items-center gap-1 text-xs text-brand underline-offset-2 hover:underline"
          >
            Access point page
            <ArrowSquareOut aria-hidden className="size-3" />
          </Link>
        </div>
      </Section>

      <Section title="On the map">
        {box ? (
          <div className="space-y-1.5 text-xs">
            <p>
              It has its own box, <span className="font-medium">{box.name}</span>; the dashed line runs from there to
              its access point.
            </p>
            <Button type="button" size="xs" variant="outline" onClick={() => onSelect({ type: 'node', id: box.id })}>
              Show {box.name}
            </Button>
          </div>
        ) : hiddenBox ? (
          <div className="space-y-1.5 text-xs">
            <p>
              It has a box, <span className="font-medium">{hiddenBox.name}</span>, but the box is hidden.
            </p>
            <Button type="button" size="xs" variant="outline" onClick={() => onSelect({ type: 'node', id: hiddenBox.id })}>
              Open {hiddenBox.name}
            </Button>
          </div>
        ) : editing ? (
          <div className="space-y-1.5 text-xs">
            <p className="text-muted-foreground">
              Give it a box of its own, bound to it, next to {apNode?.name ?? 'its access point'}. No cable: it stays on
              WiFi.
            </p>
            <Button type="button" size="xs" disabled={create.isPending} onClick={putOnMap} data-put-on-map>
              <MapPin />
              {create.isPending ? 'Adding…' : 'Put on the map'}
            </Button>
            <FieldError message={refusal === null ? null : infraErrorMessage(refusal, index, 'Could not put it on the map.')} />
            {holderId !== null ? (
              <Button type="button" size="xs" variant="outline" onClick={() => onSelect({ type: 'node', id: holderId })}>
                {holderName ? `Show ${holderName}` : 'Show that box'}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Shown while the WiFi clients overlay is on; it has no box of its own.</p>
        )}
      </Section>
    </div>
  )
}

function MoreClients({ apNodeId, overlay, index, onSelect }: OverlayInspectorProps & { apNodeId: number }) {
  const ap = index.nodes.get(apNodeId)
  const rest = overlay.overflow.get(apNodeId) ?? []
  if (!ap) return <Gone text="This access point is no longer on the map." onClose={() => onSelect(null)} />
  return (
    <div className="flex flex-col pb-2" data-inspector="clients">
      <header className="flex items-start gap-2 px-4 pt-3 pb-3">
        <Devices aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="truncate text-sm font-semibold">
            {rest.length > 0 ? `${rest.length} more on ${ap.name}` : `More on ${ap.name}`}
          </h2>
          <p className="text-xs text-muted-foreground">
            The map shows an access point&rsquo;s eleven strongest clients; these are the rest, strongest first.
          </p>
        </div>
        <CloseButton onClose={() => onSelect(null)} />
      </header>
      <Section title="Clients">
        {rest.length === 0 ? (
          <p className="text-xs text-muted-foreground">Every client of {ap.name} has its own chip now.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rest.map((client) => {
              const type = deviceTypeMeta(client.deviceType)
              const Icon = type?.Icon ?? Devices
              return (
                <li key={client.mac}>
                  <button
                    type="button"
                    data-overflow-client={client.mac.toLowerCase()}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-muted/50"
                    onClick={() => onSelect({ type: 'client', mac: client.mac.toLowerCase() })}
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{clientName(client)}</span>
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <span
                          aria-hidden
                          className={cn('inline-block size-1.5 rounded-full', wifiSignalQualityDotClass(client.signalQuality))}
                        />
                        {formatWifiBand(client.band)} · {formatSignal(client.signalDbm)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
