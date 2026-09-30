import { useId, useState, type ReactNode } from 'react'
import { ErrorLine } from '@/components/gateway-config/bits'
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
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

/**
 * A confirmation that asks for a name typed out (the gateway's, a network's):
 * for changes that can take the site offline or keep a change the router
 * could not verify. The button wakes only when the text matches exactly, as
 * the server compares it (`confirm_mismatch` otherwise). Mount it with a
 * fresh `key` per opening (`useDialog`), so the field starts empty.
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  expected,
  what = 'the gateway’s name',
  confirmLabel,
  destructive = false,
  pending = false,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  /** The text that must be typed. */
  expected: string
  /** What to type, for the label ("the gateway’s name"). */
  what?: string
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string | null
  onConfirm: (typed: string) => void
}) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === expected
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (matches && !pending) onConfirm(typed.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody>
            {children}
            <div className="space-y-1.5">
              <Label htmlFor={id} className="text-xs font-medium">
                Type {what} to confirm: <span className="font-mono font-semibold select-all">{expected}</span>
              </Label>
              <Input
                id={id}
                value={typed}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono"
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={typed.length > 0 && !matches ? true : undefined}
              />
            </div>
            <ErrorLine message={error} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!matches || pending}>
              {pending ? <Spinner className="size-3.5 text-current" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
