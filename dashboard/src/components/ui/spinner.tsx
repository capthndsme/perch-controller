import { CircleNotch } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

/**
 * The app's single spinning-loader glyph. Wraps Phosphor's `CircleNotch`
 * with our spin animation and muted colour so every loading affordance
 * looks identical. Size via `className` (e.g. `size-5`); inherits `size-4`.
 */
function Spinner({ className, ...props }: React.ComponentProps<typeof CircleNotch>) {
  return (
    <CircleNotch
      role="status"
      aria-label="Loading"
      weight="bold"
      className={cn('size-4 animate-spin text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Spinner }
