import {
  createJoinToken,
  listJoinTokens,
  revealJoinToken,
  revokeJoinToken,
} from '#services/ap_join_tokens'
import { apJoinTokenCreateValidator } from '#validators/ap_agents'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Join tokens for ap-controller agents (docs/ap-controller.md section 4.1).
 * Mounted under `/api/v1/settings`: auth + password change + admin.
 * Responses carrying a plaintext token are `Cache-Control: no-store`.
 */
export default class ApJoinTokensController {
  /**
   * GET /api/v1/settings/ap-join-tokens
   */
  async index() {
    // A bare array would go out unwrapped (the serializer only wraps
    // objects and transformer resources), so wrap it by hand.
    return { data: await listJoinTokens() }
  }

  /**
   * POST /api/v1/settings/ap-join-tokens
   */
  async store({ auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(apJoinTokenCreateValidator)
    const actor = auth.getUserOrFail()
    const created = await createJoinToken(payload, actor)
    response.header('Cache-Control', 'no-store')
    response.status(201)
    return serialize(created)
  }

  /**
   * POST /api/v1/settings/ap-join-tokens/:id/reveal
   */
  async reveal({ params, response, serialize }: HttpContext) {
    const result = await revealJoinToken(Number(params.id))
    if (result.status === 'not_found') return notFound(response, params.id)
    if (result.status === 'inactive') {
      return response.gone({
        error: 'join_token_inactive',
        message:
          result.reason === 'unrecoverable'
            ? 'This join token can no longer be shown (APP_KEY changed); create a new one.'
            : `This join token is ${result.reason}.`,
      })
    }
    response.header('Cache-Control', 'no-store')
    return serialize({ token: result.token })
  }

  /**
   * DELETE /api/v1/settings/ap-join-tokens/:id
   */
  async destroy({ params, response }: HttpContext) {
    const found = await revokeJoinToken(Number(params.id))
    if (!found) return notFound(response, params.id)
    return response.noContent()
  }
}

function notFound(response: HttpContext['response'], id: unknown) {
  return response.notFound({
    error: 'join_token_not_found',
    message: `Join token ${id} does not exist.`,
  })
}
