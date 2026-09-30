import Collector from '#models/collector'
import type Gateway from '#models/gateway'
import GatewaySecret from '#models/gateway_secret'
import type { SecretEdit } from '#services/gateway_config/domain'
import { planeError } from '#services/gateway_config/errors'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import { writeAccess } from '#services/gateway_config/gateway_registry'
import { contentOf } from '#services/gateway_config/native_common'
import { controllerSecretSlot, newSecretRef } from '#services/gateway_config/secrets'
import type { SectionState } from '#services/gateway_config/sync_engine'

/**
 * Values the controller sets on the router's secret options (a DDNS
 * password, a WireGuard preshared key; config-plane.md 11.1): stored in
 * `gateway_secrets` under a fresh ref and sent only inside an apply over
 * verified TLS. A signed plain-HTTP session never carries one, so the REST
 * layer refuses them there (409 `insecure_transport`) and the router keeps
 * its own value. The WAN service has the same rule for PPPoE and mobile PINs.
 */

export type SecretState = { set: boolean; owner: 'router' | 'controller' | null }

/** A value to store with the edit that references it. */
export type StagedSecret = { ref: string; value: string; fingerprint: string }

/** Whether a controller-set secret could travel to this gateway now. */
export async function secretsTravelSecurely(gateway: Gateway): Promise<boolean> {
  const access = writeAccess(gateway, await getGatewayConfigSettings())
  if (access.writable) return !access.signed
  return !['insecure_transport', 'not_paired', 'sign_key_unknown'].includes(access.reason)
}

export async function requireSecureForSecrets(gateway: Gateway, what = 'Passwords') {
  if (await secretsTravelSecurely(gateway)) return
  throw planeError(
    409,
    'insecure_transport',
    `${what} go to the router only over verified TLS; set it in LuCI, Perch keeps the router’s value.`
  )
}

async function apiKeyOf(gateway: Gateway): Promise<string> {
  const collector = gateway.collectorId !== null ? await Collector.find(gateway.collectorId) : null
  if (!collector?.apiKey) throw planeError(409, 'agent_offline', 'The gateway has no collector.')
  return collector.apiKey
}

/** A controller-set secret for `<config>.<section>.<option>`: the edit and the value to store. */
export async function stageSecret(
  gateway: Gateway,
  target: { config: string; section: string; option: string },
  value: string,
  what?: string
): Promise<{ edit: SecretEdit; staged: StagedSecret }> {
  await requireSecureForSecrets(gateway, what)
  const ref = newSecretRef()
  const slot = controllerSecretSlot(await apiKeyOf(gateway), target, ref, value)
  return {
    edit: { ref, fingerprint: slot.fingerprint },
    staged: { ref, value, fingerprint: slot.fingerprint },
  }
}

/** Stores staged values; call right before the draft edit that references them. */
export async function storeStagedSecrets(gatewayId: number, staged: StagedSecret[]) {
  for (const secret of staged) {
    const row = new GatewaySecret()
    row.gatewayId = gatewayId
    row.ref = secret.ref
    row.value = secret.value
    row.fingerprint = secret.fingerprint
    await row.save()
  }
}

/** A secret option's state as the API shows it (never a value). */
export function secretStateOf(row: SectionState | null, option: string): SecretState {
  const c = row ? (contentOf(row) ?? row.router) : null
  const slot = c?.secrets?.[option]
  if (!slot) return { set: false, owner: null }
  return { set: true, owner: slot.ref ? 'controller' : 'router' }
}

/** `keep` for every secret of the row, except the named ones. */
export function keptSecrets(
  row: SectionState | null,
  except: string[] = []
): Record<string, SecretEdit> {
  const out: Record<string, SecretEdit> = {}
  const c = row ? (contentOf(row) ?? row.router) : null
  for (const name of Object.keys(c?.secrets ?? {})) {
    if (!except.includes(name)) out[name] = { keep: true }
  }
  return out
}
