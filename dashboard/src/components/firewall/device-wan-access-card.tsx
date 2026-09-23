import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { Globe, GlobeX, Info, Warning } from '@phosphor-icons/react'
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
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { ApplyNowCheckbox, ErrorNote, FormField, ToneBadge, WriteResult } from '@/components/firewall/firewall-ui'
import { useProfile } from '@/hooks/use-auth'
import { useDeviceWanAccess, usePutWanAccess } from '@/hooks/use-firewall'
import { apiErrorCode } from '@/lib/api'
import { flushReasonText, refusalDetail } from '@/lib/firewall'
import type { WanAccess, WanAccessWrite } from '@/types/firewall'

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return value
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(ts)
}

/**
 * "Internet access" on the device page (firewall.md section 5): the per-device
 * WAN block. Hidden when no gateway is managed. Blocking puts the MAC into the
 * router's `perch_block_wan` set; once the router has it, Perch flushes the
 * device's running connections so the block bites at once.
 */
export function DeviceWanAccessCard({ mac, deviceName }: { mac: string; deviceName: string }) {
  const isAdmin = useProfile().data?.role === 'admin'
  const [gatewayId, setGatewayId] = useState<number | null>(null)
  const query = useDeviceWanAccess(mac, gatewayId)
  const code = apiErrorCode(query.error)

  if (!mac || query.isPending) return null
  if (query.error) {
    if (code === 'gateway_ambiguous') {
      const ids = refusalDetail<number[]>(query.error, 'gatewayIds') ?? []
      return (
        <Panel title="Internet access" description="Several gateways are managed: pick the one this device uses.">
          <div className="flex flex-wrap gap-2">
            {ids.map((id) => (
              <Button key={id} size="xs" variant="outline" onClick={() => setGatewayId(id)}>
                Gateway #{id}
              </Button>
            ))}
          </div>
        </Panel>
      )
    }
    // No managed gateway (404) or not managed (409): the card has nothing to offer.
    return null
  }
  return <WanAccessBody mac={mac} deviceName={deviceName} view={query.data!} isAdmin={isAdmin} />
}

function WanAccessBody({
  mac,
  deviceName,
  view,
  isAdmin,
}: {
  mac: string
  deviceName: string
  view: WanAccess
  isAdmin: boolean
}) {
  const put = usePutWanAccess(mac)
  const [asking, setAsking] = useState<boolean | null>(null)
  const [result, setResult] = useState<WanAccessWrite | null>(null)
  const ruleOff = view.blocked && view.ruleEnabled === false
  const flush = view.lastFlush

  const state = view.blocked
    ? ruleOff
      ? { tone: 'warning' as const, label: 'Blocked (rule disabled on router)' }
      : view.applied
        ? { tone: 'critical' as const, label: 'Blocked' }
        : { tone: 'warning' as const, label: 'Blocking…' }
    : view.applied
      ? { tone: 'good' as const, label: 'Allowed' }
      : { tone: 'warning' as const, label: 'Unblocking…' }

  return (
    <Panel
      title="Internet access"
      description="Block this device from the internet; it keeps reaching your local network."
      actions={<ToneBadge tone={state.tone}>{state.label}</ToneBadge>}
    >
      <div className="space-y-3 text-[12.5px]">
        <div className="flex items-start gap-2">
          {view.blocked ? (
            <GlobeX className="mt-0.5 size-4 shrink-0 text-destructive" />
          ) : (
            <Globe className="mt-0.5 size-4 shrink-0 text-status-good" />
          )}
          <div className="min-w-0 space-y-0.5">
            <p>
              {view.blocked
                ? `No internet${view.since ? ` since ${formatDate(view.since)}` : ''}.`
                : 'Can reach the internet.'}
              {!view.applied ? ' The router does not have this yet; it follows with the apply.' : ''}
            </p>
            {view.blocked && view.since === null ? (
              <p className="text-[11.5px] text-muted-foreground">Blocked on the router (LuCI), not from Perch.</p>
            ) : null}
            {view.note ? <p className="text-[11.5px] text-muted-foreground">Note: {view.note}</p> : null}
          </div>
        </div>

        {ruleOff ? (
          <p className="flex items-start gap-1.5 text-[11.5px] text-status-warning">
            <Warning className="mt-0.5 size-3.5 shrink-0" />
            The block rule is disabled on the router, so the device still reaches the internet. Enable it on the
            router, or under{' '}
            <Link to="/firewall?tab=rules" className="underline underline-offset-2">
              Firewall → Rules
            </Link>
            .
          </p>
        ) : null}

        {view.blocked && flush ? (
          <p className="text-[11.5px] text-muted-foreground">
            {flush.flushed === true
              ? `Running connections cut ${formatDate(flush.at)}${flush.deleted !== undefined ? ` (${flush.deleted} closed)` : ''}.`
              : flush.flushed === false
                ? `Running connections could not be cut (${flushReasonText(flush)}): they continue until they end.`
                : `Running connections were not cut: ${flushReasonText(flush)}. They continue until they end; new ones are blocked.`}
          </p>
        ) : null}

        {view.routerOwned ? (
          <p className="text-[11.5px] text-muted-foreground">
            The router’s block set is excluded from sync, so Perch cannot change it here.
          </p>
        ) : null}

        {result ? (
          <WriteResult
            gatewayId={result.gatewayId}
            issues={result.issues}
            apply={result.apply}
            applyError={result.applyError}
            extra={
              result.object.blocked ? (
                <p className="text-muted-foreground">
                  Running connections are cut as soon as the router has the block; this card shows when.
                </p>
              ) : null
            }
          />
        ) : null}

        {isAdmin && !view.routerOwned ? (
          <div className="flex flex-wrap items-center gap-2">
            {view.blocked ? (
              <Button size="sm" variant="outline" onClick={() => setAsking(false)}>
                <Globe className="size-3.5" />
                Allow internet
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => setAsking(true)}>
                <GlobeX className="size-3.5" />
                Block internet
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {asking !== null ? (
        <WanAccessDialog
          block={asking}
          deviceName={deviceName}
          gatewayId={view.gatewayId}
          note={view.note}
          pending={put.isPending}
          error={put.error}
          onClose={() => {
            setAsking(null)
            put.reset()
          }}
          onConfirm={(note, apply) =>
            put.mutate(
              { gatewayId: view.gatewayId, blocked: asking, note: asking ? note : undefined, apply },
              {
                onSuccess: (data) => {
                  setResult(data)
                  setAsking(null)
                },
              },
            )
          }
        />
      ) : null}
    </Panel>
  )
}

function WanAccessDialog({
  block,
  deviceName,
  note: initialNote,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  block: boolean
  deviceName: string
  gatewayId: number
  note: string | null
  pending: boolean
  error: unknown
  onConfirm: (note: string | null, apply: boolean) => void
  onClose: () => void
}) {
  const id = useId()
  const [note, setNote] = useState(initialNote ?? '')
  const [applyNow, setApplyNow] = useState(true)
  const self = apiErrorCode(error) === 'wan_block_self'
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{block ? `Block ${deviceName} from the internet?` : `Allow ${deviceName} on the internet?`}</DialogTitle>
          <DialogDescription>
            {block
              ? 'It keeps reaching devices on your network, just not the internet.'
              : 'The device can reach the internet again once the router applies the change.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {block ? (
            <>
              <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2.5">
                <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
                <span>
                  Running connections are cut at once: a video call, a download or a game in progress drops as soon as
                  the router has the block, not just new ones.
                </span>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  A household control, not a security boundary: the block follows the device’s MAC address, so a device
                  that randomises or changes it gets through.
                </span>
              </div>
              <FormField label="Note (optional)" htmlFor={`${id}-note`} hint="Shown on this page, e.g. why or until when.">
                <Input id={`${id}-note`} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
              </FormField>
            </>
          ) : null}
          {self ? (
            <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-2.5">
              <p className="font-medium text-destructive">Perch will not block this device</p>
              <p className="text-foreground/80">
                {error instanceof Error ? error.message : ''} Blocking the controller, one of your access points, or the
                computer you are using right now would cut Perch or you off from the network, with no way to undo it
                from here.
              </p>
            </div>
          ) : (
            <ErrorNote error={error} />
          )}
        </DialogBody>
        <DialogFooter>
          <div className="mr-auto">
            <ApplyNowCheckbox id={`${id}-apply`} checked={applyNow} onChange={setApplyNow} />
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant={block ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => onConfirm(note.trim() === '' ? null : note.trim(), applyNow)}
          >
            {pending ? 'Working…' : block ? 'Block internet' : 'Allow internet'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
