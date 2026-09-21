import UserTransformer from '#transformers/user_transformer'
import { changePasswordValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import hash from '@adonisjs/core/services/hash'

export default class ProfileController {
  async show({ auth, serialize }: HttpContext) {
    return serialize(UserTransformer.transform(auth.getUserOrFail()))
  }

  /**
   * PATCH /api/v1/account/password
   *
   * Self-service password change. Verifies the current password first,
   * then updates the password and clears `must_change_password` so invited
   * users can proceed normally after setting their own credentials.
   */
  async changePassword({ auth, request, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const { currentPassword, password } = await request.validateUsing(changePasswordValidator)

    const isValid = await hash.verify(user.password, currentPassword)
    if (!isValid) {
      return response.unprocessableEntity({
        error: 'invalid_current_password',
        message: 'The current password you provided is incorrect.',
      })
    }

    user.password = password
    user.mustChangePassword = false
    await user.save()

    return serialize({
      user: UserTransformer.transform(user),
      message: 'Password changed successfully.',
    })
  }
}
