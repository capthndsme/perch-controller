import { useId, useState, type ReactNode } from 'react'
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
import { ApplyNowCheckbox, ErrorNote } from '@/components/firewall/firewall-ui'

/** A yes/no question before a firewall write (delete, resolve), with "Apply now". */
export function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel,
  destructive = false,
  pending,
  error,
  nameOf,
  onConfirm,
  onClose,
  showApply = true,
}: {
  title: string
  description?: ReactNode
  children?: ReactNode
  confirmLabel: string
  destructive?: boolean
  pending: boolean
  error: unknown
  nameOf?: (id: string) => string | null
  onConfirm: (applyNow: boolean) => void
  onClose: () => void
  showApply?: boolean
}) {
  const id = useId()
  const [applyNow, setApplyNow] = useState(true)
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>
          {children}
          <ErrorNote error={error} nameOf={nameOf} />
        </DialogBody>
        <DialogFooter>
          {showApply ? (
            <div className="mr-auto">
              <ApplyNowCheckbox id={`${id}-apply`} checked={applyNow} onChange={setApplyNow} />
            </div>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => onConfirm(applyNow)}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
