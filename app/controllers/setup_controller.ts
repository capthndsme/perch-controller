import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import CollectorTransformer from '#transformers/collector_transformer'
import UserTransformer from '#transformers/user_transformer'
import { isAnnounceEnabled } from '#services/collector_announce'
import { probeCollector } from '#services/collector_probe'
import { adoptCollector } from '#services/collector_registry'
import { deferCollectors, isSetupComplete, snapshot } from '#services/setup_state'
import { announceSourceAddress } from '#services/collector_announce'
import { perchVersions } from '#services/perch_version'
import { recordSetupLoginFailure, setupLoginBudget } from '#services/setup_login_rate_limit'
import { collectorAdoptValidator } from '#validators/collectors'
import { loginValidator } from '#validators/user'
import {
  setupAdminValidator,
  setupCollectorValidator,
  setupInstanceValidator,
} from '#validators/setup'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

/**
 * Suggested defaults the wizard frontend will pre-fill into its form for the
 * collector step. Kept centralised here so a future "managed appliance" build
 * can rewrite them at compile time without forking the controller.
 */
const DEFAULT_COLLECTOR = {
  suggestedUrl: 'http://127.0.0.1:9800',
  defaultPollIntervalSeconds: 5,
  defaultName: 'localhost',
}

export default class SetupController {
  /**
   * GET /api/v1/setup/status
   *
   * Always responds, even after setup completes — the frontend uses it as the
   * single source of truth for "should I show the wizard or the dashboard?".
   */
  async status({ serialize }: HttpContext) {
    const snap = await snapshot()
    return serialize({
      ...snap,
      version: perchVersions().version,
      suggestedCollectorUrl: DEFAULT_COLLECTOR.suggestedUrl,
      defaultPollIntervalSeconds: DEFAULT_COLLECTOR.defaultPollIntervalSeconds,
      defaultCollectorName: DEFAULT_COLLECTOR.defaultName,
    })
  }

  /**
   * POST /api/v1/setup/admin
   *
   * One-shot endpoint: succeeds only while NO admin user exists. After the
   * first admin is created, additional admins go through a future invite
   * flow (planned, not in this session). Returns the new user + bearer token
   * so the frontend can chain straight into step 2.
   */
  async admin({ request, response, serialize }: HttpContext) {
    if (await this.adminExists()) {
      return response.conflict({
        error: 'admin_already_exists',
        message: 'An admin account already exists. Use /api/v1/auth/login instead.',
      })
    }

    const { fullName, email, password } = await request.validateUsing(setupAdminValidator)

    const user = await User.create({ fullName, email, password, role: 'admin' })
    const token = await User.accessTokens.create(user)

    return serialize({
      user: UserTransformer.transform(user),
      token: token.value!.release(),
    })
  }

  /**
   * POST /api/v1/setup/login
   *
   * Resumes an unfinished wizard: the admin from step 1 signs in again after
   * losing the session (tab closed, other browser, cleared storage). The
   * normal `/auth/login` stays behind the setup gate; this one only works
   * while setup is incomplete, only after step 1, and only for an admin, so
   * it is never a way in without the step-1 credentials. Someone else on the
   * LAN gets nothing an ordinary login would not give them: a wrong password
   * is a 401 that says nothing about which half was wrong, and an address
   * with 10 failures in 15 minutes gets 429 (Retry-After).
   */
  async login({ request, response, serialize }: HttpContext) {
    const address = announceSourceAddress(request.ip())
    const budget = setupLoginBudget(address)
    if (!budget.allowed) {
      response.header('Retry-After', String(budget.retryAfterSeconds))
      return response.tooManyRequests({
        error: 'rate_limited',
        message: 'Too many failed sign-in attempts from this address. Try again later.',
        retryAfterSeconds: budget.retryAfterSeconds,
      })
    }

    const snap = await snapshot()
    if (snap.step === 'complete') {
      return response.conflict({
        error: 'setup_complete',
        message: 'Setup is complete. Sign in with /api/v1/auth/login instead.',
      })
    }
    if (snap.step === 'admin') {
      return response.conflict({
        error: 'admin_missing',
        message: 'No admin account exists yet. Create one with /api/v1/setup/admin.',
      })
    }

    let credentials
    try {
      credentials = await request.validateUsing(loginValidator)
    } catch (error) {
      recordSetupLoginFailure(address)
      throw error
    }

    let user: User
    try {
      // Hashes a dummy password for an unknown e-mail, so the timing does not
      // tell which half was wrong either.
      user = await User.verifyCredentials(credentials.email, credentials.password)
    } catch {
      recordSetupLoginFailure(address)
      return invalidCredentials(response)
    }
    if (!user.isAdmin) {
      recordSetupLoginFailure(address)
      return invalidCredentials(response)
    }

    const token = await User.accessTokens.create(user)
    return serialize({
      user: UserTransformer.transform(user),
      token: token.value!.release(),
    })
  }

  /**
   * POST /api/v1/setup/instance
   *
   * Persists site identification + timezone. Idempotent (rerunning replaces
   * the values), so the frontend can let the admin go back and tweak before
   * advancing to step 3.
   */
  async instance({ request, serialize }: HttpContext) {
    const { siteName, timezone } = await request.validateUsing(setupInstanceValidator)
    await SystemSetting.set('site_name', siteName)
    await SystemSetting.set('timezone', timezone)
    return serialize({ siteName, timezone })
  }

  /**
   * POST /api/v1/setup/collector
   *
   * Auto-probes the URL before persisting. The probe result is *always*
   * stored in `last_status` (even on failure) so the admin can save partial
   * progress, debug the collector, and re-probe later via a future Settings
   * endpoint without losing the row.
   */
  async collector({ request, serialize }: HttpContext) {
    const { name, baseUrl, apiKey, pollIntervalSeconds } =
      await request.validateUsing(setupCollectorValidator)

    const status = await probeCollector(baseUrl, { apiKey: apiKey ?? null })

    const collector = await Collector.create({
      name,
      baseUrl,
      transport: 'poll',
      apiKey: apiKey ?? null,
      pollIntervalSeconds,
      enabled: true,
      lastSeenAt: status.ok ? DateTime.fromISO(status.checkedAt) : null,
      lastStatus: status,
    })

    return serialize({
      collector: CollectorTransformer.transform(collector),
      probe: status,
      setupComplete: await isSetupComplete(),
    })
  }

  /**
   * GET /api/v1/setup/collector/candidates
   *
   * Collectors that announced themselves and wait for adoption. The announce
   * endpoint works before setup, so a router with the package and
   * `server_url` pointing here is already listed when the admin reaches this
   * step; nothing has to be typed in. Newest announce first.
   */
  async candidates({ serialize }: HttpContext) {
    const pending = await Collector.query()
      .where('lifecycle', 'pending')
      .orderByRaw('last_announce_at IS NULL, last_announce_at DESC')
      .orderBy('id', 'desc')
    return serialize({
      candidates: CollectorTransformer.transform(pending),
      discoveryEnabled: await isAnnounceEnabled(),
    })
  }

  /**
   * POST /api/v1/setup/collector/:id/adopt
   *
   * The wizard's counterpart of `POST /api/v1/settings/collectors/:id/adopt`
   * (same rules, same `adoptCollector`), available before setup completes.
   * Adopting the first collector completes setup.
   */
  async adopt({ params, request, response, serialize }: HttpContext) {
    const collector = await Collector.find(Number(params.id))
    if (!collector) {
      return response.notFound({
        error: 'collector_not_found',
        message: `No collector with id ${params.id}.`,
      })
    }
    if (collector.lifecycle === 'adopted') {
      return response.unprocessableEntity({
        error: 'collector_not_pending',
        message: `Collector ${collector.id} is already adopted.`,
      })
    }

    const payload = await request.validateUsing(collectorAdoptValidator)
    const result = await adoptCollector(collector, payload)
    if (result.status === 'key_mismatch') {
      return response.unprocessableEntity({
        error: 'collector_api_key_mismatch',
        message:
          'The key you supplied does not match the fingerprint this collector announced. ' +
          'Re-send with "acceptKeyChange": true if that is intentional.',
      })
    }

    return serialize({
      collector: CollectorTransformer.transform(result.collector),
      probe: result.probe,
      setupComplete: await isSetupComplete(),
    })
  }

  /**
   * POST /api/v1/setup/collector/skip
   *
   * "Skip for now": finish setup with no collector. The controller comes
   * first; collectors and access points are added later in any order.
   */
  async skipCollector({ serialize }: HttpContext) {
    await deferCollectors()
    return serialize({ setupComplete: await isSetupComplete() })
  }

  private async adminExists(): Promise<boolean> {
    const row = await User.query().where('role', 'admin').first()
    return row !== null
  }
}

function invalidCredentials(response: HttpContext['response']) {
  return response.unauthorized({
    error: 'invalid_credentials',
    message: 'Wrong e-mail or password for the admin account created in step 1.',
  })
}
