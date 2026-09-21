import { snapshot } from '#services/setup_state'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Gate for the normal `/api/v1/*` surface. When setup hasn't completed yet,
 * every protected request short-circuits with a structured 503 telling the
 * frontend which wizard step it should redirect the operator to.
 *
 * Apply only to non-setup routes — the `/api/v1/setup/*` group MUST stay
 * reachable while the wizard is in progress.
 */
export default class RequireSetupCompleteMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const snap = await snapshot()
    if (snap.step === 'complete') {
      return next()
    }
    return ctx.response.serviceUnavailable({
      error: 'setup_required',
      step: snap.step,
      message: 'Initial setup is incomplete. Hit GET /api/v1/setup/status for the next step.',
    })
  }
}
