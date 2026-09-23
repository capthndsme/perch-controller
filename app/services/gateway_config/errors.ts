/**
 * A refusal of a config plane operation with its HTTP status and the
 * documented error code (docs/gateway/config-plane.md section 10). The REST
 * layer turns it into `{ error, message, ...data }` with `status`.
 */
export class GatewayPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'GatewayPlaneError'
  }
}

export function planeError(
  status: number,
  code: string,
  message: string,
  data: Record<string, unknown> = {}
): GatewayPlaneError {
  return new GatewayPlaneError(status, code, message, data)
}
