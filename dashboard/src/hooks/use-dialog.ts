import { useState } from 'react'

/** A dialog's `open` state plus a key that remounts its body (fresh inner state) on every open. */
export function useDialog() {
  const [open, setOpen] = useState(false)
  const [generation, setGeneration] = useState(0)
  return {
    open,
    key: generation,
    show: () => {
      setGeneration((g) => g + 1)
      setOpen(true)
    },
    setOpen,
  }
}
