import type Gateway from '#models/gateway'
import {
  isValidNtpServer,
  NTP_SECTION,
  SYSTEM_DOMAIN_KEY,
  SYSTEM_HOSTNAME,
  systemDomain,
  tzForZone,
  zoneNames,
} from '#services/gateway_config/domains/system'
import {
  flagOf,
  scalarOption,
  withOptions,
  wordsOf,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { gatewayForCollector } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  asSynced,
  contentOf,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { SectionEdit } from '#services/gateway_config/domain'

/**
 * The router's `system` config on the managed gateway (plan 2 sections 4.5
 * and 5; docs/gateway/native-sync.md section 5): host name, time zone and
 * the NTP client/server. The observation's `GET /gateways/:gatewayId/system`
 * fills its `timezone`, `zonename` and `ntp` from here and adds `config`.
 */

export type SystemConfigView = {
  hostname: string | null
  zonename: string | null
  timezone: string | null
  ntp: {
    enabled: boolean
    server: boolean
    servers: string[]
    sync: SyncInfo
  } | null
  sync: SyncInfo | null
  /** The zone names the controller can set (IANA names with their POSIX TZ). */
  zoneNames: string[]
}

function mainSection(states: SectionState[]): SectionState | null {
  return sectionsOf(states, 'system', ['system'])[0] ?? null
}

function ntpSection(states: SectionState[]): SectionState | null {
  return sectionsOf(states, 'system', ['timeserver']).find((s) => s.name === NTP_SECTION) ?? null
}

export function systemConfigView(states: SectionState[]): SystemConfigView {
  const main = mainSection(states)
  const ntp = ntpSection(states)
  const o = main ? contentOf(main)!.options : {}
  const n = ntp ? contentOf(ntp)!.options : null
  return {
    hostname: scalarOption(o, 'hostname'),
    zonename: scalarOption(o, 'zonename'),
    timezone: scalarOption(o, 'timezone'),
    ntp:
      ntp && n
        ? {
            // sysntpd: the client runs unless `enabled '0'`.
            enabled: flagOf(n, 'enabled', true),
            server: flagOf(n, 'enable_server', false),
            servers: wordsOf(n.server),
            sync: syncOf(ntp),
          }
        : null,
    sync: main ? syncOf(main) : null,
    zoneNames: zoneNames(),
  }
}

/** The config part of `GET /gateways/:gatewayId/system` (null when the gateway has no config plane rows). */
export async function systemConfigForCollector(
  collectorId: number
): Promise<SystemConfigView | null> {
  const gateway = await gatewayForCollector(collectorId)
  if (!gateway) return null
  const { states } = await loadSections(gateway.id)
  if (!mainSection(states) && !ntpSection(states)) return null
  return systemConfigView(states)
}

export type SystemPatch = {
  hostname?: string
  /** A zone name (`Asia/Manila`); `timezone` (the POSIX string) is derived from it. */
  timezone?: string
  ntpEnabled?: boolean
  ntpServe?: boolean
  ntpServers?: string[]
  apply?: boolean
}

/** `PATCH /gateways/:id/system`. */
export async function updateSystem(
  gatewayId: number,
  userId: number,
  patch: SystemPatch
): Promise<WriteResult<SystemConfigView>> {
  const gateway: Gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const edits: SectionEdit[] = []
  const touched: string[] = []

  if (patch.hostname !== undefined || patch.timezone !== undefined) {
    const main = mainSection(states)
    if (!main) throw planeError(404, 'system_not_found', 'The router reported no system section.')
    requireSynced(main, 'The system section')
    if (patch.hostname !== undefined && !SYSTEM_HOSTNAME.test(patch.hostname)) {
      throw planeError(
        422,
        'system_hostname_invalid',
        `"${patch.hostname}" is not a host name (letters, digits and dashes, up to 63).`
      )
    }
    let zone: { zonename: string; timezone: string } | undefined
    if (patch.timezone !== undefined) {
      const tz = tzForZone(patch.timezone)
      if (tz === null) {
        throw planeError(422, 'system_timezone_invalid', `"${patch.timezone}" is not a known zone.`)
      }
      zone = { zonename: patch.timezone, timezone: tz }
    }
    const options = withOptions(contentOf(main)!.options, {
      hostname: patch.hostname,
      zonename: zone?.zonename,
      timezone: zone?.timezone,
    })
    const [obj] = systemDomain.parse(asSynced(main))
    edits.push(...systemDomain.render({ ...obj, options }, asSynced(main)))
    touched.push(main.perchId)
  }

  if (
    patch.ntpEnabled !== undefined ||
    patch.ntpServe !== undefined ||
    patch.ntpServers !== undefined
  ) {
    for (const server of patch.ntpServers ?? []) {
      if (!isValidNtpServer(server)) {
        throw planeError(422, 'system_ntp_server_invalid', `"${server}" is not a time server.`)
      }
    }
    const ntp = ntpSection(states)
    if (ntp) requireSynced(ntp, 'The NTP section')
    const set = {
      enabled: patch.ntpEnabled === undefined ? undefined : patch.ntpEnabled ? '1' : '0',
      enable_server: patch.ntpServe === undefined ? undefined : patch.ntpServe ? '1' : '0',
      server: patch.ntpServers === undefined ? undefined : [...new Set(patch.ntpServers)],
    }
    const obj: VerbatimSection = ntp
      ? { ...systemDomain.parse(asSynced(ntp))[0] }
      : { perchId: null, section: NTP_SECTION, type: 'timeserver', options: {}, secretNames: [] }
    obj.options = withOptions(obj.options, set)
    edits.push(...systemDomain.render(obj, ntp ? asSynced(ntp) : []))
    if (ntp) touched.push(ntp.perchId)
  }

  if (edits.length === 0) {
    return {
      gatewayId: gateway.id,
      object: systemConfigView(states),
      issues: [],
      apply: null,
      applyError: null,
    }
  }
  const outcome = await editSections(gateway.id, userId, SYSTEM_DOMAIN_KEY, edits)
  const ids = [...new Set([...touched, ...outcome.perchIds])]
  const { apply, applyError } = await applyNow(gateway, userId, ids, patch.apply !== false)
  const { states: after } = await loadSections(gateway.id)
  return {
    gatewayId: gateway.id,
    object: systemConfigView(after),
    issues: outcome.issues,
    apply,
    applyError,
  }
}
