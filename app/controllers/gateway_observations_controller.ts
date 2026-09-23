import { sessionCapabilities } from '#services/collector_agent'
import { normalizeMac } from '#services/device_labels'
import {
  createGatewayBackup,
  listGatewayBackups,
  readGatewayBackupArchive,
} from '#services/gateway_backups'
import {
  gatewayObservationSettingsView,
  getGatewayObservationSettings,
  updateGatewayObservationSettings,
} from '#services/gateway_observation_settings'
import {
  readDeviceNetwork,
  readInterfaces,
  readLeases,
  readNeighbors,
  readObservationOverview,
  readSystem,
  readUpnp,
  readWanStatus,
  readWireguard,
  resolveObservedGateway,
} from '#services/gateway_observation_read'
import { ObserveRequestError, requestGatewayObservation } from '#services/gateway_observe'
import {
  createBackupValidator,
  observeRequestValidator,
  updateGatewayObservationSettingsValidator,
} from '#validators/gateway_observation_settings'
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'

const networkQuery = vine.compile(
  vine.object({
    network: vine
      .string()
      .trim()
      .maxLength(32)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
  })
)

type Ctx = HttpContext

/**
 * The observation channel's REST API (docs/gateway/observation.md section 7;
 * plan-2-native-sync.md section 5, read-only parts). `:gatewayId` is
 * `gateways.id`, bound to an adopted collector on the router (404
 * `gateway_not_found` otherwise). Reads of runtime state are open to every
 * signed-in user; the system view, WireGuard, backups, on-demand refresh and
 * the retention settings are admin-only (the routes add `requireAdmin`).
 */
export default class GatewayObservationsController {
  private async gateway({ params, response }: Ctx) {
    const collector = await resolveObservedGateway(params.gatewayId)
    if (!collector) {
      response.notFound({
        error: 'gateway_not_found',
        message: `No gateway with id ${params.gatewayId}.`,
      })
      return null
    }
    return collector
  }

  private fail(response: Ctx['response'], error: unknown) {
    if (error instanceof ObserveRequestError) {
      return response.status(error.status).send({
        error: error.code,
        message: error.message,
        ...error.details,
      })
    }
    throw error
  }

  /** GET /gateways/:gatewayId/observation */
  async overview(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    return ctx.serialize(await readObservationOverview(collector, Number(ctx.params.gatewayId)))
  }

  /** GET /gateways/:gatewayId/dhcp/leases?network= */
  async leases(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    const { network } = await networkQuery.validate(ctx.request.qs())
    return ctx.serialize(await readLeases(collector.id, network))
  }

  /** GET /gateways/:gatewayId/neighbors?network= */
  async neighbors(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    const { network } = await networkQuery.validate(ctx.request.qs())
    return ctx.serialize(await readNeighbors(collector.id, network))
  }

  /** GET /gateways/:gatewayId/interfaces */
  async interfaces(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    return ctx.serialize(await readInterfaces(collector.id))
  }

  /** GET /gateways/:gatewayId/upnp */
  async upnp(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    return ctx.serialize(await readUpnp(collector.id))
  }

  /** GET /gateways/:gatewayId/wan-status */
  async wanStatus(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    return ctx.serialize(await readWanStatus(collector))
  }

  /** GET /gateways/:gatewayId/system (admin) */
  async system(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    return ctx.serialize(await readSystem(collector.id))
  }

  /** GET /gateways/:gatewayId/wireguard (admin) */
  async wireguard(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    return ctx.serialize(await readWireguard(collector.id))
  }

  /** POST /gateways/:gatewayId/observe (admin) `{ parts? }` → `{ observedAt, parts }` */
  async observe(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    const { parts } = await ctx.request.validateUsing(observeRequestValidator)
    try {
      const result = await requestGatewayObservation(
        collector.id,
        parts,
        sessionCapabilities(collector.id)
      )
      return ctx.serialize(result)
    } catch (error) {
      return this.fail(ctx.response, error)
    }
  }

  /** GET /gateways/:gatewayId/backups (admin) */
  async backups(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    // A bare array would go out unwrapped: wrap it by hand.
    return { data: await listGatewayBackups(collector.id) }
  }

  /** POST /gateways/:gatewayId/backups (admin) `{ note? }` → 201 summary */
  async createBackup(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    const { note, redact } = await ctx.request.validateUsing(createBackupValidator)
    try {
      const backup = await createGatewayBackup(collector.id, sessionCapabilities(collector.id), {
        userId: ctx.auth.user?.id ?? null,
        note: note ?? null,
        redact,
      })
      ctx.response.status(201)
      return ctx.serialize(backup)
    } catch (error) {
      return this.fail(ctx.response, error)
    }
  }

  /** GET /gateways/:gatewayId/backups/:backupId/download (admin): the archive itself. */
  async downloadBackup(ctx: Ctx) {
    const collector = await this.gateway(ctx)
    if (!collector) return
    const found = await readGatewayBackupArchive(collector.id, Number(ctx.params.backupId))
    if (!found) {
      return ctx.response.notFound({ error: 'backup_not_found', message: 'No such backup.' })
    }
    const stamp = found.summary.createdAt.replace(/[-:]/g, '').replace(/\.\d+/, '')
    const name = `backup-${collector.id}-${stamp}.tar.gz`
    ctx.response.header('Content-Type', 'application/gzip')
    ctx.response.header('Content-Disposition', `attachment; filename="${name}"`)
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.header('X-Content-SHA256', found.summary.sha256)
    return ctx.response.send(found.archive)
  }

  /** GET /devices/:mac/network */
  async deviceNetwork({ params, response, serialize }: Ctx) {
    const mac = normalizeMac(params.mac)
    if (!mac) {
      return response.badRequest({ error: 'invalid_mac', message: 'Not a MAC address.' })
    }
    return serialize(await readDeviceNetwork(mac))
  }

  /** GET /settings/gateway-observations (admin) */
  async settings({ serialize }: Ctx) {
    return serialize(gatewayObservationSettingsView(await getGatewayObservationSettings()))
  }

  /** PATCH /settings/gateway-observations (admin) */
  async updateSettings({ request, serialize }: Ctx) {
    const payload = await request.validateUsing(updateGatewayObservationSettingsValidator)
    return serialize(
      gatewayObservationSettingsView(await updateGatewayObservationSettings(payload))
    )
  }
}
