import { githubReleaseDownloadUrl, perchVersions } from '#services/perch_version'
import type { HttpContext } from '@adonisjs/core/http'

export default class VersionController {
  /**
   * GET /api/v1/version  (public, before and after setup)
   *
   * The controller's version and the daemon releases it pairs with
   * (app/services/perch_version.ts). Public like `setup/status`, which also
   * carries `version`: the dashboard shows it on the sign-in and wizard pages.
   */
  async show({ serialize }: HttpContext) {
    const { version, apdVersion, collectorVersion } = perchVersions()
    return serialize({
      version,
      apdVersion,
      collectorVersion,
      apdReleaseUrl: githubReleaseDownloadUrl('perch-apd', apdVersion),
      collectorReleaseUrl: githubReleaseDownloadUrl('perch-collector', collectorVersion),
    })
  }
}
