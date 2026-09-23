import { useState } from 'react'
import { ShieldWarning } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorNote } from '@/components/networks/network-ui'
import { NetworkWriteResult } from '@/components/networks/network-write-result'
import { useDeleteNetwork } from '@/hooks/use-networks'
import { kindLine, networkTitle } from '@/lib/networks'
import type { GatewayNetwork, NetworkWrite } from '@/types/networks'

/**
 * Delete a network: the interface, the L2 sections only it uses and its pool
 * (the router's own sections stay, with a `section_kept` warning). The
 * management network is refused by the server (409 `management_network`); the
 * dialog explains that up front instead of offering the button.
 */
export function DeleteNetworkDialog({
  gatewayId,
  network,
  onClose,
  onDeleted,
}: {
  gatewayId: number
  network: GatewayNetwork
  onClose: () => void
  onDeleted?: () => void
}) {
  const remove = useDeleteNetwork(gatewayId)
  const [result, setResult] = useState<NetworkWrite | null>(null)
  const title = networkTitle(network)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? `${title} is being removed` : `Delete ${title}?`}</DialogTitle>
          <DialogDescription>
            {result
              ? 'It stays listed as “Removing” until the apply is confirmed.'
              : `${kindLine(network)}${network.ipv4 ? ` · ${network.ipv4}` : ''}`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NetworkWriteResult result={result} gatewayId={gatewayId} />
          ) : network.management ? (
            <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs">
              <ShieldWarning className="mt-0.5 size-4 shrink-0 text-status-warning" />
              <div className="space-y-1">
                <p className="font-medium">This is the management network.</p>
                <p className="text-muted-foreground">
                  The gateway reaches Perch through {network.key}. Deleting it would cut the controller off from the
                  router, so Perch refuses it. To retire it, first move the gateway’s connection to Perch onto another
                  network (another interface or VLAN the controller is reachable on); the management path follows by
                  itself, and this network can go then.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                Removes the interface{network.dhcp ? ', its DHCP pool' : ''} and the bridge VLAN or device only it uses.
                Devices on it lose their addresses when their leases run out, and anything plugged into its untagged ports
                stops reaching the router.
              </p>
              <p>Perch keeps the network’s traffic history. Sections the router owns (not synced) stay on the router.</p>
            </div>
          )}
          <ErrorNote error={remove.error} />
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button
              size="sm"
              onClick={() => {
                onClose()
                onDeleted?.()
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                {network.management ? 'Close' : 'Cancel'}
              </Button>
              {network.management ? null : (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ networkId: network.id }, { onSuccess: (data) => setResult(data) })}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete and apply'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
