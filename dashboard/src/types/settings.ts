export const HOSTNAME_ENRICHMENT_MODE = 'command_execution' as const

export type HostnameEnrichmentTransport = 'lxc' | 'ssh'

type HostnameEnrichmentBase = {
  enabled: boolean
  mode: typeof HOSTNAME_ENRICHMENT_MODE
  transport: HostnameEnrichmentTransport
  leaseFilePath: string
  refreshSeconds: number
  timeoutMs: number
}

export type HostnameEnrichmentSettings =
  | (HostnameEnrichmentBase & {
      transport: 'lxc'
      lxc: {
        containerName: string
      }
    })
  | (HostnameEnrichmentBase & {
      transport: 'ssh'
      ssh: {
        host: string
        port: number
        username: string
        privateKeyPath?: string
      }
    })
