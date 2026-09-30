import type Gateway from '#models/gateway'
import {
  agentFailure,
  blockCode,
  writeBlockMessage,
} from '#services/gateway_config/apply_lifecycle'
import { planeError } from '#services/gateway_config/errors'
import { gatewayRequest } from '#services/gateway_config/gateway_agent'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import { writeAccess } from '#services/gateway_config/gateway_registry'
import { hasFeature } from '#services/gateway_config/types'

/**
 * Runtime requests to the router that are not config (gateway sync
 * protocol.md 6.2: `gateway.upnp.delete`, `gateway.ddns.update`): they need
 * the router's write access like an apply, travel signed on a signed
 * session, and are gated by the feature the agent announces. Refusals map
 * like the package install's: 409 `agent_offline` / the write block, 504
 * `agent_timeout`, 409 with the agent's code.
 */
export async function runtimeRequest<T>(
  gateway: Gateway,
  method: string,
  params: Record<string, unknown>,
  options: { feature: string; timeoutMs?: number }
): Promise<T> {
  if (!hasFeature(gateway.capabilities, options.feature)) {
    throw planeError(
      409,
      'gateway_capability_missing',
      'The gateway agent does not offer this yet (update perch-collector).',
      { capability: options.feature }
    )
  }
  const access = writeAccess(gateway, await getGatewayConfigSettings())
  if (!access.writable) {
    throw planeError(
      409,
      access.reason === 'offline' ? 'agent_offline' : blockCode(access.reason),
      writeBlockMessage(access.reason)
    )
  }
  try {
    return await gatewayRequest<T>(gateway, method, params, {
      timeoutMs: options.timeoutMs ?? 30_000,
      access,
    })
  } catch (error) {
    throw agentFailure(error)
  }
}
