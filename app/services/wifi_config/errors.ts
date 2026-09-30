import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'

/**
 * Refusals of the Wi-Fi plane (docs/design/wifi controller.md section 7):
 * the gateway's `{ error, message, ...data }` with a status, so one REST
 * mapper serves both planes. `wifiError` is `planeError` under the Wi-Fi
 * plane's name; the class is shared on purpose (`instanceof` works for both).
 */
export { GatewayPlaneError as WifiPlaneError }

export function wifiError(
  status: number,
  code: string,
  message: string,
  data: Record<string, unknown> = {}
): GatewayPlaneError {
  return planeError(status, code, message, data)
}

/** 409 `rollout_running` with the active rollout's id. */
export function rolloutRunning(id: number): GatewayPlaneError {
  return wifiError(
    409,
    'rollout_running',
    'Another rollout is still going: wait for it or stop it.',
    {
      id,
    }
  )
}
