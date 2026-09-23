import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * A refusal of the guest portal REST layer (docs/gateway/portal.md section
 * 11): `{error, message, ...extra}` with its status. Services throw it; it
 * renders itself, so controllers need no try/catch.
 */
export class PortalError extends Exception {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {}
  ) {
    super(message, { status: httpStatus, code })
  }

  /** A refusal is an answer, not a server fault: nothing to log. */
  async report() {}

  async handle(error: this, ctx: HttpContext) {
    for (const [name, value] of Object.entries(error.headers)) ctx.response.header(name, value)
    ctx.response
      .status(error.httpStatus)
      .send({ error: error.code, message: error.message, ...error.extra })
  }
}

export const portalNotFound = (id: number | string) =>
  new PortalError(404, 'portal_not_found', `There is no portal ${id}.`, { portalId: Number(id) })

export const gatewayNotFound = (id: number | string) =>
  new PortalError(404, 'gateway_not_found', `There is no gateway ${id}.`, { gatewayId: Number(id) })

export const templateNotFound = (id: number | string) =>
  new PortalError(404, 'template_not_found', `There is no portal template ${id}.`)

export const batchNotFound = (id: number | string) =>
  new PortalError(404, 'batch_not_found', `There is no voucher batch ${id}.`)

export const voucherNotFound = (id?: number | string) =>
  new PortalError(
    404,
    'voucher_not_found',
    id === undefined ? 'No voucher has this code.' : `There is no voucher ${id}.`
  )

export const grantNotFound = (id: number | string) =>
  new PortalError(404, 'grant_not_found', `There is no grant ${id}.`)

export const portalUserNotFound = (id: number | string) =>
  new PortalError(404, 'portal_user_not_found', `There is no portal user ${id}.`)

export const apiClientNotFound = (id: number | string) =>
  new PortalError(404, 'api_client_not_found', `There is no API client ${id}.`)

/** A route parameter that is not a positive integer reads as "no such row". */
export function idParam(value: unknown, notFound: (id: string) => PortalError): number {
  const text = String(value ?? '')
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw notFound(text)
  const id = Number(text)
  if (!Number.isSafeInteger(id)) throw notFound(text)
  return id
}
