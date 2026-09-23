import type { ReactNode } from 'react'
import { X } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

/** One titled block of the inspector panel. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="section-label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function FieldError({ message }: { message: string | null }) {
  return message ? <p className="text-[11px] text-destructive">{message}</p> : null
}

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}>
      <X />
    </Button>
  )
}
