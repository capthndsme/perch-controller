import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { inviteUserValidator, updateUserRoleValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Admin-only CRUD for user accounts. Every action in this controller sits
 * behind `auth() + requireAdmin()` at the route level, so we don't re-check
 * the role here — the middleware has already done it.
 */
export default class UsersController {
  /**
   * GET /api/v1/settings/users
   *
   * Returns all user accounts. Passwords are stripped by UserTransformer
   * (the `serializeAs: null` on the schema column already prevents it,
   * but the transformer also omits anything it doesn't explicitly pick).
   */
  async index({ serialize }: HttpContext) {
    const users = await User.query().orderBy('created_at', 'asc')
    return serialize(UserTransformer.transform(users))
  }

  /**
   * POST /api/v1/settings/users
   *
   * Admin creates a new viewer or admin account. The password is set by the
   * admin and the account is flagged with `must_change_password = true` so
   * the user is forced to set their own password on first login.
   */
  async store({ request, response, serialize }: HttpContext) {
    const { fullName, email, password, role } = await request.validateUsing(inviteUserValidator)

    const user = await User.create({
      fullName,
      email,
      password,
      role,
      mustChangePassword: true,
    })

    // `serialize` is async: `response.created(serialize(...))` would send `{}`.
    response.status(201)
    return serialize({
      user: UserTransformer.transform(user),
    })
  }

  /**
   * PATCH /api/v1/settings/users/:id/role
   *
   * Change an existing user's role. Admins cannot demote themselves — they
   * must ask another admin to do it (prevents accidental lock-out).
   */
  async updateRole({ auth, params, request, response, serialize }: HttpContext) {
    const target = await User.find(Number(params.id))
    if (!target) {
      return response.notFound({
        error: 'user_not_found',
        message: `User ${params.id} does not exist.`,
      })
    }

    const currentUser = auth.getUserOrFail()
    if (currentUser.id === target.id) {
      return response.unprocessableEntity({
        error: 'cannot_change_own_role',
        message: 'You cannot change your own role. Ask another admin.',
      })
    }

    const { role } = await request.validateUsing(updateUserRoleValidator)
    target.role = role
    await target.save()

    return serialize({
      user: UserTransformer.transform(target),
    })
  }

  /**
   * DELETE /api/v1/settings/users/:id
   *
   * Remove a user account. Admins cannot delete their own account.
   * All access tokens are invalidated before the row is removed so
   * any in-flight bearer tokens for that user stop working immediately.
   */
  async destroy({ auth, params, response }: HttpContext) {
    const target = await User.find(Number(params.id))
    if (!target) {
      return response.notFound({
        error: 'user_not_found',
        message: `User ${params.id} does not exist.`,
      })
    }

    const currentUser = auth.getUserOrFail()
    if (currentUser.id === target.id) {
      return response.unprocessableEntity({
        error: 'cannot_delete_self',
        message: 'You cannot delete your own account.',
      })
    }

    // Revoke all access tokens before deleting the user so that any
    // sessions currently in-flight are immediately invalidated.
    const tokens = await User.accessTokens.all(target)
    for (const token of tokens) {
      await User.accessTokens.delete(target, token.identifier)
    }

    await target.delete()
    return response.noContent()
  }
}
