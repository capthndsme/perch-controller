import { useId, useState, type ReactNode } from 'react'
import { PencilSimple, ShieldWarning, Warning } from '@phosphor-icons/react'
import { ApplyNowCheckbox, Callout, ErrorNote } from '@/components/firewall/firewall-ui'
import { ToneBadge } from '@/components/gateway-config/bits'
import { RouterOwnedHint, SyncBadges } from '@/components/gateway-native/native-ui'
import { TypedConfirmDialog } from '@/components/gateway-sync/typed-confirm-dialog'
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
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useDialog } from '@/hooks/use-dialog'
import { useFirewallDefaults, useUpdateFirewallDefaults } from '@/hooks/use-gateway-sync'
import { apiErrorCode } from '@/lib/api'
import { isNotBuilt, syncRefusalMessage } from '@/lib/gateway-sync'
import { cn } from '@/lib/utils'
import type { FirewallWriteSummary, FwGateway } from '@/types/firewall'
import type { FirewallDefaultsPatch, FirewallDefaultsView, FirewallPolicy } from '@/types/gateway-sync'

const POLICIES: FirewallPolicy[] = ['ACCEPT', 'REJECT', 'DROP']
const POLICY_TONE = { ACCEPT: 'good', REJECT: 'warning', DROP: 'critical' } as const

const CHAINS = [
  { key: 'input', label: 'Incoming', hint: 'to the router itself' },
  { key: 'output', label: 'Outgoing', hint: 'from the router itself' },
  { key: 'forward', label: 'Forwarded', hint: 'between networks' },
] as const

const FLAGS = [
  { key: 'synfloodProtect', label: 'SYN flood protection', hint: 'Limits bursts of new TCP connections.' },
  { key: 'dropInvalid', label: 'Drop invalid packets', hint: 'Packets that belong to no known connection.' },
  { key: 'flowOffloading', label: 'Software flow offloading', hint: 'Established connections skip the firewall rules.' },
  {
    key: 'flowOffloadingHw',
    label: 'Hardware flow offloading',
    hint: 'The switch chip forwards them: Perch cannot count that traffic.',
  },
] as const

type Draft = Pick<
  FirewallDefaultsView,
  'input' | 'output' | 'forward' | 'synfloodProtect' | 'dropInvalid' | 'flowOffloading' | 'flowOffloadingHw'
>

function asPolicy(value: string): FirewallPolicy {
  const upper = value.toUpperCase()
  return (POLICIES as string[]).includes(upper) ? (upper as FirewallPolicy) : 'ACCEPT'
}

/** Only what changed. */
function patchOf(view: FirewallDefaultsView, draft: Draft): FirewallDefaultsPatch {
  const patch: FirewallDefaultsPatch = {}
  for (const { key } of CHAINS) {
    if (asPolicy(view[key]) !== asPolicy(draft[key])) patch[key] = asPolicy(draft[key])
  }
  for (const { key } of FLAGS) if (view[key] !== draft[key]) patch[key] = draft[key]
  return patch
}

/** Rejecting or dropping what reaches or leaves the router can lock the admin out: the gateway's name is typed. */
function needsName(patch: FirewallDefaultsPatch): boolean {
  return [patch.input, patch.output].some((p) => p === 'REJECT' || p === 'DROP')
}

/**
 * The firewall's global `defaults` section (design gateway-sync rest.md 7,
 * owner decision D7): the three default policies, SYN flood protection,
 * invalid packets and flow offloading. Changes are always a protected job
 * (the longer confirm window); REJECT or DROP for incoming or outgoing
 * traffic asks for the gateway's name. Renders nothing on a controller that
 * does not serve the defaults yet.
 */
export function FirewallDefaultsCard({
  gateway,
  canWrite,
  onWrite,
}: {
  gateway: FwGateway
  canWrite: boolean
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const defaults = useFirewallDefaults(gateway.id)
  const edit = useDialog()

  if (defaults.error && isNotBuilt(defaults.error)) return null
  const view = defaults.data
  const routerOwned = view ? view.sync.owner !== 'perch' : false
  const liveDiffers =
    view?.live &&
    ((view.live.flowOffloading !== null && view.live.flowOffloading !== view.flowOffloading) ||
      (view.live.flowOffloadingHw !== null && view.live.flowOffloadingHw !== view.flowOffloadingHw))

  return (
    <Panel
      title="Firewall defaults"
      description="What the router does with traffic no zone or rule decides."
      actions={
        view ? (
          <>
            <SyncBadges sync={view.sync} />
            {canWrite && !routerOwned ? (
              <Button size="sm" variant="outline" onClick={edit.show} data-testid="fw-defaults-edit">
                <PencilSimple />
                Edit
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {defaults.isPending ? (
        <p className="text-xs text-muted-foreground">Loading the defaults…</p>
      ) : !view ? (
        <p className="text-xs text-destructive">{syncRefusalMessage(defaults.error)}</p>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-3 gap-2">
            {CHAINS.map(({ key, label, hint }) => (
              <div key={key} className="min-w-0 rounded-md border border-border px-2.5 py-2">
                <dt className="text-[11px] text-muted-foreground">{label}</dt>
                <dd className="mt-1">
                  <ToneBadge tone={POLICY_TONE[asPolicy(view[key])]} className="font-mono">
                    {view[key]}
                  </ToneBadge>
                </dd>
                <dd className="mt-1 hidden text-[11px] text-muted-foreground sm:block">{hint}</dd>
              </div>
            ))}
          </dl>
          <dl className="grid gap-x-6 divide-y divide-border/70 text-xs sm:grid-cols-2 sm:divide-y-0">
            {FLAGS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className={cn('font-medium', view[key] ? 'text-foreground' : 'text-muted-foreground')}>
                  {view[key] ? 'On' : 'Off'}
                </dd>
              </div>
            ))}
          </dl>
          {liveDiffers ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
              The router runs with offloading {view.live?.flowOffloading ? 'on' : 'off'}
              {view.live?.flowOffloadingHw ? ' (hardware)' : ''} until the firewall reloads.
            </p>
          ) : null}
          {view.collectorWarning ? (
            <Callout tone="warning" icon={<ShieldWarning className="size-4" />} title="Perch cannot count offloaded traffic">
              {view.collectorWarning}
            </Callout>
          ) : null}
          {routerOwned ? <RouterOwnedHint gatewayId={gateway.id} what="The defaults section" /> : null}
        </div>
      )}
      {view && canWrite && !routerOwned ? (
        <FirewallDefaultsDialog
          key={edit.key}
          gateway={gateway}
          view={view}
          open={edit.open}
          onOpenChange={edit.setOpen}
          onWrite={onWrite}
        />
      ) : null}
    </Panel>
  )
}

function FirewallDefaultsDialog({
  gateway,
  view,
  open,
  onOpenChange,
  onWrite,
}: {
  gateway: FwGateway
  view: FirewallDefaultsView
  open: boolean
  onOpenChange: (open: boolean) => void
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const id = useId()
  const update = useUpdateFirewallDefaults(gateway.id)
  const typed = useDialog()
  const [applyNow, setApplyNow] = useState(true)
  const [draft, setDraft] = useState<Draft>(() => ({
    input: asPolicy(view.input),
    output: asPolicy(view.output),
    forward: asPolicy(view.forward),
    synfloodProtect: view.synfloodProtect,
    dropInvalid: view.dropInvalid,
    flowOffloading: view.flowOffloading,
    flowOffloadingHw: view.flowOffloadingHw,
  }))
  const patch = patchOf(view, draft)
  const changed = Object.keys(patch).length > 0
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value }
      // Hardware offloading rides on the software one.
      if (key === 'flowOffloading' && !value) next.flowOffloadingHw = false
      if (key === 'flowOffloadingHw' && value) next.flowOffloading = true
      return next
    })

  async function save(confirm?: string) {
    try {
      const answer = await update.mutateAsync({ patch: confirm ? { ...patch, confirm } : patch, apply: applyNow })
      onWrite({ what: 'Saved the firewall defaults', issues: answer.issues, apply: answer.apply, applyError: answer.applyError })
      typed.setOpen(false)
      onOpenChange(false)
    } catch (error) {
      if (!confirm && apiErrorCode(error) === 'firewall_defaults_confirm_required') {
        update.reset()
        typed.show()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="fw-defaults-dialog"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Firewall defaults on {gateway.name}</DialogTitle>
          <DialogDescription>
            A change here goes out on its own with the longer confirm window: if Perch cannot reach the router
            afterwards, the router rolls it back by itself.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <fieldset className="space-y-2.5">
            <legend className="mb-1.5 text-xs font-medium">Default policies</legend>
            {CHAINS.map(({ key, label, hint }) => (
              <Row key={key} label={label} hint={hint}>
                <Segmented
                  size="xs"
                  ariaLabel={`${label} policy`}
                  value={draft[key] as FirewallPolicy}
                  onChange={(next) => set(key, next)}
                  options={POLICIES.map((p) => ({ id: p, label: p }))}
                />
              </Row>
            ))}
          </fieldset>
          {needsName(patch) ? (
            <Callout tone="warning" title="This can lock you out">
              Rejecting or dropping traffic to or from the router by default cuts off every network whose zone does not
              accept it. You will type the gateway’s name to confirm.
            </Callout>
          ) : null}
          <fieldset className="space-y-2.5">
            <legend className="mb-1.5 text-xs font-medium">Protection and offloading</legend>
            {FLAGS.map(({ key, label, hint }) => (
              <Row key={key} label={label} hint={hint} htmlFor={`${id}-${key}`}>
                <Switch
                  id={`${id}-${key}`}
                  checked={draft[key]}
                  onCheckedChange={(next) => set(key, next)}
                  aria-label={label}
                />
              </Row>
            ))}
          </fieldset>
          <ErrorNote error={update.error} />
        </DialogBody>
        <DialogFooter className="sm:items-center">
          <div className="max-sm:order-last sm:mr-auto">
            <ApplyNowCheckbox id={`${id}-apply`} checked={applyNow} onChange={setApplyNow} />
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => (needsName(patch) ? typed.show() : save())}
            disabled={!changed || update.isPending}
            data-testid="fw-defaults-save"
          >
            {update.isPending && !typed.open ? <Spinner className="size-3.5 text-current" /> : null}
            Save
          </Button>
        </DialogFooter>
        <TypedConfirmDialog
          key={typed.key}
          open={typed.open}
          onOpenChange={typed.setOpen}
          title="Block traffic to or from the router by default?"
          description="Only networks whose zone accepts it will reach the router afterwards. If Perch’s own path is cut, the router rolls the change back by itself."
          expected={gateway.name}
          confirmLabel="Save the defaults"
          destructive
          pending={update.isPending}
          error={update.error ? syncRefusalMessage(update.error) : null}
          onConfirm={(name) => save(name)}
        />
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, hint, htmlFor, children }: { label: string; hint: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
      <label htmlFor={htmlFor} className="min-w-0 flex-1 basis-40">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </label>
      {children}
    </div>
  )
}
