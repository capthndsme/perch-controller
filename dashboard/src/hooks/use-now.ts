import { useEffect, useState } from 'react'

/** `Date.now()`, re-read every `intervalMs` while `active` (countdowns). */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs, active])
  return now
}
