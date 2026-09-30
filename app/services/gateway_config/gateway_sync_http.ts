import { planeRefusal } from '#controllers/gateways_controller'
import GatewayApply from '#models/gateway_apply'
import { applyViewOf } from '#transformers/gateway_transformer'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * HTTP helpers shared by the gateway-sync controllers (docs/design/gateway-sync/rest.md):
 * the write answer's apply view, `?apply=0` and the 501 of work packages
 * not built yet. Refusals map through the config plane's `planeRefusal`.
 */

/** `?apply=0` stages a write in the draft only; anything else applies it. */
export function applyFlag(request: HttpContext['request']): boolean {
  const value = request.input('apply')
  if (value === undefined || value === null) return true
  return !['0', 'false', false, 0].includes(value)
}

/** A write answer with its `GatewayApply` model turned into the API view (with `changes`). */
export async function withApplyView<T extends { apply: unknown }>(result: T) {
  return {
    ...result,
    apply:
      result.apply instanceof GatewayApply
        ? await applyViewOf(result.apply, { changes: true })
        : (result.apply ?? null),
  }
}

type Handler = (ctx: HttpContext, userId: number, gatewayId: number) => Promise<unknown>

/** Runs a handler with the plane's refusals mapped to their statuses. */
export async function runSync(ctx: HttpContext, handler: Handler, status = 200) {
  try {
    const result = await handler(ctx, ctx.auth.getUserOrFail().id, Number(ctx.params.id))
    ctx.response.status(status)
    const shaped =
      result && typeof result === 'object' && 'apply' in result
        ? await withApplyView(result as { apply: unknown })
        : result
    return ctx.serialize(shaped)
  } catch (error) {
    return planeRefusal(ctx.response, error)
  }
}

/** The answer of a route whose work package is not built yet. */
export function notBuilt({ response }: HttpContext, workPackage: string) {
  return response.status(501).send({
    error: 'not_built',
    message: `Not built yet (gateway sync work package ${workPackage}).`,
    workPackage,
  })
}
