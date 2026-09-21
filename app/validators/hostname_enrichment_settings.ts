import {
  HOSTNAME_ENRICHMENT_MODE,
  HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MAX,
  HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MIN,
  HOSTNAME_ENRICHMENT_TIMEOUT_MS_MAX,
  HOSTNAME_ENRICHMENT_TIMEOUT_MS_MIN,
} from '#services/hostname_enrichment_settings'
import vine from '@vinejs/vine'

const TRANSPORTS = ['lxc', 'ssh'] as const

const lxcSchema = vine.object({
  containerName: vine.string().trim().minLength(1).maxLength(120),
})

const sshSchema = vine.object({
  host: vine.string().trim().minLength(1).maxLength(255),
  port: vine.number().min(1).max(65535),
  username: vine.string().trim().minLength(1).maxLength(128),
  privateKeyPath: vine.string().trim().minLength(1).maxLength(512).optional(),
})

/**
 * Admin-managed configuration for hostname lookup via command execution.
 * `transport` chooses the required nested object (`lxc` or `ssh`).
 */
export const updateHostnameEnrichmentSettingsValidator = vine.compile(
  vine
    .object({
      enabled: vine.boolean(),
      mode: vine.literal(HOSTNAME_ENRICHMENT_MODE),
      transport: vine.enum(TRANSPORTS),
      leaseFilePath: vine.string().trim().minLength(1).maxLength(255),
      refreshSeconds: vine
        .number()
        .min(HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MIN)
        .max(HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MAX),
      timeoutMs: vine
        .number()
        .min(HOSTNAME_ENRICHMENT_TIMEOUT_MS_MIN)
        .max(HOSTNAME_ENRICHMENT_TIMEOUT_MS_MAX),
    })
    .merge(
      vine.group([
        vine.group.if((value) => value.transport === 'lxc', {
          lxc: lxcSchema,
        }),
        vine.group.if((value) => value.transport === 'ssh', {
          ssh: sshSchema,
        }),
      ])
    )
)
