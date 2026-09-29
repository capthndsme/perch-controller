import { useState } from 'react'

/**
 * Holds which row a confirmation is open for. The row outlives the close, so
 * the dialog's text stays put while it animates out.
 */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  return {
    target,
    open: (value: T) => {
      setTarget(value)
      setIsOpen(true)
    },
    props: {
      open: isOpen,
      onOpenChange: (open: boolean) => {
        if (!open) setIsOpen(false)
      },
    },
    close: () => setIsOpen(false),
  }
}
