import { useState } from 'react'

/** Holds which row a confirmation is open for. */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null)
  return {
    target,
    open: (value: T) => setTarget(value),
    props: {
      open: target !== null,
      onOpenChange: (open: boolean) => {
        if (!open) setTarget(null)
      },
    },
    close: () => setTarget(null),
  }
}
