import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useProfile } from '@/hooks/use-auth'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Paged, WifiRollout } from '@/types/wifi-config'

/**
 * The newest rollout (`GET /wifi/rollouts?limit=1`). Here rather than in
 * hooks/use-wifi-config.ts because this banner sits in the shell's entry
 * chunk and the hooks module does not need to. Key under `['wifi-config']`,
 * so every Wi-Fi write refreshes it. Every 2 s while one runs or is paused,
 * else every 15 s; a controller without the Wi-Fi plane (404) or a 403 stops
 * the polling and the banner stays away.
 */
function useLatestRollout() {
  const signedIn = Boolean(useAuthStore((state) => state.token))
  return useQuery({
    queryKey: ['wifi-config', 'rollouts', 'latest'] as const,
    queryFn: async () => (await apiFetch<Paged<WifiRollout>>('/api/v1/wifi/rollouts?limit=1')).items[0] ?? null,
    enabled: signedIn,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false
      const r = query.state.data
      return r && (r.state === 'running' || r.state === 'paused') ? 2_000 : 15_000
    },
    retry: false,
  })
}

/**
 * The progress UI (and with it the sheet, labels and phases) loads only
 * while there is a rollout to show: this shell part stays small in the entry.
 */
const RolloutProgress = lazy(() => import('@/components/wifi-config/rollout-sheet').then((m) => ({ default: m.RolloutProgress })))

const WATCH_KEY = 'perch-wifi-rollout-watch'

function readWatched(): number[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(WATCH_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

function writeWatched(ids: number[]) {
  try {
    sessionStorage.setItem(WATCH_KEY, JSON.stringify(ids.slice(-10)))
  } catch {
    // per-tab convenience only
  }
}

const isOpen = (r: WifiRollout) => r.state === 'running' || r.state === 'paused' || r.state === 'stopped'

/**
 * The app-wide Wi-Fi rollout progress (dashboard.md 1.6), mounted beside the
 * gateway's apply banner. Shows the newest rollout while it runs, is paused or
 * stopped; one this tab watched finishing stays as good news for 15 s (or
 * until dismissed). The watch list survives reloads in sessionStorage, so a
 * reload in the middle of a change still reports how it ended.
 */
export function WifiRolloutBanner() {
  const latest = useLatestRollout()
  const isAdmin = useProfile().data?.role === 'admin'
  const [watched, setWatched] = useState<number[]>(readWatched)
  const [finishedAt, setFinishedAt] = useState<Record<number, number>>({})
  const rollout = latest.data ?? null

  // Watch an open rollout; note when a watched one ends.
  const [seen, setSeen] = useState<string | null>(null)
  const signature = rollout ? `${rollout.id}:${rollout.state}` : null
  if (signature !== seen) {
    setSeen(signature)
    if (rollout && isOpen(rollout) && !watched.includes(rollout.id)) {
      const next = [...watched, rollout.id]
      setWatched(next)
      writeWatched(next)
    } else if (rollout && !isOpen(rollout) && watched.includes(rollout.id) && finishedAt[rollout.id] === undefined) {
      setFinishedAt((f) => ({ ...f, [rollout.id]: Date.now() }))
    }
  }

  const dismiss = (id: number) => {
    const next = watched.filter((x) => x !== id)
    setWatched(next)
    writeWatched(next)
  }

  // Good news clears itself.
  const done = rollout && rollout.state === 'completed' && watched.includes(rollout.id) ? rollout.id : null
  useEffect(() => {
    if (done === null) return
    const timer = window.setTimeout(() => dismiss(done), 15_000)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  if (!rollout) return null
  const show = isOpen(rollout) || watched.includes(rollout.id)
  if (!show) return null
  return (
    <Suspense fallback={null}>
      <RolloutProgress rollout={rollout} isAdmin={isAdmin} onDismiss={() => dismiss(rollout.id)} />
    </Suspense>
  )
}
