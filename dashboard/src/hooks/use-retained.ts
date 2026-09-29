import { useState } from 'react'

/**
 * `value`, or while it is null the last non-null value it had: what a dialog
 * keyed on a nullable selection shows while it animates out.
 */
export function useRetained<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}
