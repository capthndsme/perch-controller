import { useState } from 'react'
import { ArrowsClockwise, CaretDown, ClockCounterClockwise, PaperPlaneTilt, PencilSimple, Plus, Trash, WebhooksLogo } from '@phosphor-icons/react'
import { DeliveryList } from '@/components/alerts/delivery-list'
import { TestResultLine } from '@/components/alerts/test-result'
import { SecretReveal, WebhookDialog } from '@/components/alerts/webhook-dialog'
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
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useDeliveries } from '@/hooks/use-alerts'
import { useConfirm } from '@/hooks/use-confirm'
import { useDialog } from '@/hooks/use-dialog'
import { useRetained } from '@/hooks/use-retained'
import {
  useDeleteWebhook,
  useRotateWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
  useWebhooks,
} from '@/hooks/use-webhooks'
import { ApiError } from '@/lib/api'
import { formatAgo, WEBHOOK_PRESET_LABEL } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { WebhookCreateResponse, WebhookView } from '@/types/alerts'

function stateLine(webhook: WebhookView): { text: string; bad: boolean } {
  if (webhook.state === 'needs_secret')
    return { text: 'Needs its secret again (the controller’s key changed): edit it', bad: true }
  if (webhook.state === 'failing')
    return { text: `Failing${webhook.lastError ? `: ${webhook.lastError}` : ''}`, bad: true }
  if (!webhook.enabled) return { text: 'Off', bad: false }
  if (webhook.lastSuccessAt) return { text: `Last delivery ${formatAgo(webhook.lastSuccessAt)}`, bad: false }
  return { text: 'Nothing sent yet', bad: false }
}

/**
 * Settings → Notifications, admin part: webhook destinations (design README §5). Each row: name, preset,
 * where it points (masked), health; expanded, its test with the result inline, edit, recent deliveries,
 * a new signing secret (JSON webhooks), delete.
 */
export function WebhooksCard() {
  const webhooks = useWebhooks()
  const editor = useDialog()
  const [editing, setEditing] = useState<WebhookView | null>(null)
  const remove = useDeleteWebhook()
  const confirmDelete = useConfirm<WebhookView>()
  const confirmRotate = useConfirm<WebhookView>()
  const rotate = useRotateWebhookSecret()
  const [rotated, setRotated] = useState<WebhookCreateResponse | null>(null)
  const [logFor, setLogFor] = useState<WebhookView | null>(null)

  if (webhooks.error instanceof ApiError && webhooks.error.status === 404) return null

  const openEditor = (webhook: WebhookView | null) => {
    setEditing(webhook)
    editor.show()
  }

  return (
    <Panel
      title="Webhooks"
      description="ntfy, Home Assistant, Gotify, Telegram, Discord, Slack or your own receiver. They work on plain HTTP installs too."
      flush
      actions={
        <Button size="sm" onClick={() => openEditor(null)}>
          <Plus />
          Add webhook
        </Button>
      }
    >
      {webhooks.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading webhooks…</p>
      ) : webhooks.error ? (
        <p className="px-4 pb-4 text-xs text-destructive">{webhooks.error.message}</p>
      ) : webhooks.data.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState
            icon={<WebhooksLogo className="size-6" />}
            title="No webhooks"
            description="Add ntfy for phone notifications that also work while the internet is down (from your own ntfy server), or Home Assistant to reach its phone app."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {webhooks.data.map((webhook) => (
            <WebhookRow
              key={webhook.id}
              webhook={webhook}
              onEdit={() => openEditor(webhook)}
              onDelete={() => confirmDelete.open(webhook)}
              onRotate={() => confirmRotate.open(webhook)}
              onLog={() => setLogFor(webhook)}
            />
          ))}
        </ul>
      )}

      <Dialog open={editor.open} onOpenChange={editor.setOpen}>
        <WebhookDialog key={editor.key} webhook={editing} onDone={() => editor.setOpen(false)} />
      </Dialog>

      <Dialog {...confirmDelete.props}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {confirmDelete.target?.name}?</DialogTitle>
            <DialogDescription>Its delivery history goes with it.</DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody>
              <p className="text-destructive">{remove.error.message}</p>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={confirmDelete.close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => confirmDelete.target && remove.mutate(confirmDelete.target.id, { onSuccess: confirmDelete.close })}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        {...confirmRotate.props}
        onOpenChange={(open) => {
          confirmRotate.props.onOpenChange(open)
          if (!open) setTimeout(() => setRotated(null), 350)
        }}
      >
        {rotated ? (
          <SecretReveal title="New signing secret" secret={rotated.secret} onDone={confirmRotate.close} />
        ) : (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New signing secret for {confirmRotate.target?.name}?</DialogTitle>
              <DialogDescription>
                The old secret stops working at once: update the receiver with the new one right after.
              </DialogDescription>
            </DialogHeader>
            {rotate.error ? (
              <DialogBody>
                <p className="text-destructive">{rotate.error.message}</p>
              </DialogBody>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={confirmRotate.close}>
                Cancel
              </Button>
              <Button
                disabled={rotate.isPending}
                onClick={() => confirmRotate.target && rotate.mutate(confirmRotate.target.id, { onSuccess: setRotated })}
              >
                New secret
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <WebhookLog webhook={logFor} onClose={() => setLogFor(null)} />
    </Panel>
  )
}

function WebhookRow({
  webhook,
  onEdit,
  onDelete,
  onRotate,
  onLog,
}: {
  webhook: WebhookView
  onEdit: () => void
  onDelete: () => void
  onRotate: () => void
  onLog: () => void
}) {
  const [open, setOpen] = useState(false)
  const update = useUpdateWebhook()
  const test = useTestWebhook()
  const line = stateLine(webhook)

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <WebhooksLogo className={cn('size-5 shrink-0', line.bad ? 'text-status-critical' : 'text-muted-foreground')} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{webhook.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{WEBHOOK_PRESET_LABEL[webhook.preset]}</span>
            </span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{webhook.urlDisplay}</span>
            <span className={cn('block truncate text-xs', line.bad ? 'text-destructive' : 'text-muted-foreground')}>{line.text}</span>
          </span>
          <CaretDown
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out', open && 'rotate-180')}
          />
        </button>
        <Switch
          checked={webhook.enabled}
          disabled={update.isPending}
          onCheckedChange={(enabled) => update.mutate({ id: webhook.id, enabled })}
          aria-label={`${webhook.name} enabled`}
        />
      </div>
      {open ? (
        <div className="space-y-3 border-t border-border/50 bg-muted/20 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => test.mutate(webhook.id)} disabled={test.isPending}>
              {test.isPending ? <Spinner /> : <PaperPlaneTilt />}
              Send a test
            </Button>
            <Button size="sm" variant="outline" onClick={onEdit}>
              <PencilSimple />
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={onLog}>
              <ClockCounterClockwise />
              Deliveries
            </Button>
            {webhook.format === 'standard' ? (
              <Button size="sm" variant="outline" onClick={onRotate}>
                <ArrowsClockwise />
                New secret
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
              <Trash />
              Delete
            </Button>
          </div>
          <TestResultLine kind="webhook" data={test.data} error={test.error} />
          {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
        </div>
      ) : null}
    </li>
  )
}

/** Recent deliveries to one webhook; each opens its attempts. */
function WebhookLog({ webhook, onClose }: { webhook: WebhookView | null; onClose: () => void }) {
  const shown = useRetained(webhook)
  const deliveries = useDeliveries({ destination: shown ? `webhook:${shown.id}` : undefined, limit: 30 }, { enabled: webhook !== null })
  return (
    <Drawer open={webhook !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DrawerContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Deliveries to {shown?.name}</DialogTitle>
          <DialogDescription>The latest 30, newest first.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {deliveries.isPending ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Loading…</p>
          ) : deliveries.error ? (
            <p className="px-4 py-4 text-xs text-destructive">{deliveries.error.message}</p>
          ) : deliveries.data.deliveries.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Nothing sent to it yet.</p>
          ) : (
            <DeliveryList deliveries={deliveries.data.deliveries} canOpen showDestination={false} showAlert />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
