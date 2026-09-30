import type { AlertSummary } from '@/types/alerts'

/** The two alert helpers the shell needs (bell, service-worker bridge): kept apart from `alerts.ts` so the entry chunk stays small. */

/** The bell's badge: active warning + critical, red when any is critical; else a dot for unread news. */
export function bellBadge(summary: AlertSummary | undefined): { count: number; critical: boolean; dot: boolean } {
  if (!summary) return { count: 0, critical: false, dot: false }
  const count = summary.active.warning + summary.active.critical
  return { count, critical: summary.active.critical > 0, dot: count === 0 && summary.unread > 0 }
}

/** The path a notification or link may open: same-origin paths only. */
export function safeAppPath(path: unknown): string | null {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null
}
