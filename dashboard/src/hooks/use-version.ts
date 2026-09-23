import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/** `GET /api/v1/version`: this controller and the daemon versions it pairs with. */
export type VersionInfo = {
  version: string
  /** perch-apd version the AP install commands fetch, or "latest". */
  apdVersion: string
  /** perch-collector version the wizard's package line fetches, or "latest". */
  collectorVersion: string
  apdReleaseUrl: string
  /** Base download URL of the collector packages. */
  collectorReleaseUrl: string
}

/** Public, works before and after setup; changes only with a redeploy. */
export function useVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: () => apiFetch<VersionInfo>('/api/v1/version', { auth: false }),
    staleTime: 60 * 60_000,
    retry: 1,
  })
}

/** A small muted "Perch Network Controller 1.0.0" line; nothing until it loads. */
export function controllerVersionLabel(version: string | undefined): string | null {
  return version ? `Perch Network Controller ${version}` : null
}
